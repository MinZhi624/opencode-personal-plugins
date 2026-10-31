import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
const MAX_COMMAND_LENGTH = 100_000;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_RESOURCES = 512;
export class UnscannableCommandError extends Error {
    constructor(message) {
        super(`SSH 命令分析拒绝（未执行）：${message}`);
        this.name = "UnscannableCommandError";
    }
}
function refuse(message) {
    throw new UnscannableCommandError(message);
}
let parserPromise;
function getParser() {
    return parserPromise ??= (async () => {
        const require = createRequire(import.meta.url);
        await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
        const language = await Language.load(join(dirname(fileURLToPath(import.meta.url)), "..", "grammar", "tree-sitter-bash.wasm"));
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
    })();
}
/** Quote removal, not shell evaluation. Unknown expansions never become literal words. */
function literal(node) {
    switch (node.type) {
        case "word":
        case "number": {
            let value = "";
            for (let i = 0; i < node.text.length; i++) {
                const char = node.text[i];
                if (char === "\\") {
                    if (++i === node.text.length)
                        refuse("未完成的反斜杠转义");
                    value += node.text[i];
                }
                else {
                    if ("*?[]{}~".includes(char))
                        refuse("不支持运行时 glob、花括号或波浪号展开");
                    value += char;
                }
            }
            return value;
        }
        case "raw_string":
            return node.text.slice(1, -1);
        case "string":
            if (children(node).some((child) => child.type !== "string_content")) {
                refuse("字符串含运行时展开，无法确定外层参数");
            }
            return node.text.slice(1, -1).replace(/\\([$`"\\\n])/g, (_, char) => char === "\n" ? "" : char);
        case "concatenation":
            return children(node).map(literal).join("");
        default:
            return refuse(`不支持作为确定参数的语法：${node.type}`);
    }
}
// These wrappers have explicitly supported argv grammars. Unknown options are errors,
// not a reason to guess the executable from whitespace-delimited suffixes.
const WRAPPERS = {
    command: { flags: ["-p"], values: [] },
    builtin: { flags: [], values: [] },
    exec: { flags: ["-c", "-l"], values: ["-a"] },
    env: { flags: ["-i", "--ignore-environment"], values: ["-u", "--unset"] },
    sudo: { flags: ["-n", "-E", "-H", "--non-interactive", "--preserve-env", "--set-home"], values: ["-u", "-g", "--user", "--group"] },
    nohup: { flags: [], values: [] },
    setsid: { flags: ["-f", "-w", "--fork", "--wait"], values: [] },
    time: { flags: ["-p"], values: [] },
    nice: { flags: [], values: ["-n", "--adjustment"] },
    timeout: { flags: ["--preserve-status", "--foreground", "-v", "--verbose"], values: ["-s", "--signal", "-k", "--kill-after"] },
};
const UNSUPPORTED_DISPATCHERS = new Set([
    "xargs", "chroot", "chrt", "doas", "ionice", "pkexec", "prlimit", "stdbuf",
    "taskset", "unshare", "watch", "su", "busybox",
    "zsh", "ksh", "ksh93", "ash", "rbash", "csh", "tcsh", "fish",
    // These alter or source shell code/state that a per-call AST cannot resolve.
    ".", "source", "alias", "unalias", "enable", "shopt", "set", "trap",
    // Bash may evaluate array subscripts/arithmetic or execute registered shell code
    // from literal strings passed to these builtins. They are not ordinary argv sinks.
    "let", "read", "readarray", "mapfile", "unset", "getopts", "test", "fc",
    "bind", "complete", "compgen", "hash", "declare", "typeset", "local", "export", "readonly",
]);
const SHELLS = new Set(["bash", "sh", "dash"]);
const SSH_EXECUTABLES = new Set(["ssh", "scp", "sftp"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
// PS4 is expanded again during xtrace, so a literal assignment is not inert.
// This guard is shared by AST assignments and decoded env assignment arguments.
const UNSAFE_ASSIGNMENTS = new Set(["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "IFS", "PS4"]);
function assignment(value) {
    const name = ASSIGNMENT.exec(value)?.[1];
    if (!name)
        refuse("无法可靠分析此环境赋值");
    assignmentName(name);
}
function assignmentName(name) {
    if (UNSAFE_ASSIGNMENTS.has(name))
        refuse(`不支持可能触发 shell 求值的环境赋值：${name}`);
}
function wrapperCommand(name, args) {
    const options = WRAPPERS[name];
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === "--") {
            index++;
            break;
        }
        if (!arg.startsWith("-") || arg === "-")
            break;
        const equal = arg.indexOf("=");
        const option = equal > 0 ? arg.slice(0, equal) : arg;
        if (options.flags.includes(arg)) {
            index++;
            continue;
        }
        if (options.values.includes(option)) {
            if (equal > 0 && option.startsWith("--")) {
                index++;
                continue;
            }
            if (arg !== option || index + 1 >= args.length)
                refuse(`${name} 选项参数不完整`);
            index += 2;
            continue;
        }
        refuse(`不支持 ${name} 包装选项：${arg}`);
    }
    if (name === "env") {
        while (index < args.length && ASSIGNMENT.test(args[index]))
            assignment(args[index++]);
    }
    if (name === "timeout") {
        if (!/^\d+(?:\.\d+)?[smhd]?$/.test(args[index] ?? ""))
            refuse("timeout 缺少可识别的时长");
        index++;
    }
    const command = args.slice(index);
    // env without a utility prints its environment; other wrappers require a command.
    if (!command.length && name !== "env")
        refuse(`${name} 缺少实际命令`);
    return command;
}
function resource(analysis, argv) {
    analysis.resources.add(argv.join(" "));
    if (analysis.resources.size > MAX_RESOURCES)
        refuse("权限资源超过分析上限");
}
/** Analyze actual decoded argv, recursively through supported dispatchers. */
function executable(analysis, argv, depth) {
    if (depth > MAX_DEPTH)
        refuse("命令递归超过分析上限");
    const [path, ...args] = argv;
    if (!path || !/^[A-Za-z0-9_./+-]+$/.test(path) || path.startsWith("-")) {
        refuse("实际命令名不明确或包含不支持的字符");
    }
    const name = basename(path);
    resource(analysis, argv);
    // Keep path-specific checks AND the lexical command policy (e.g. git push*).
    if (name !== path)
        resource(analysis, [name, ...args]);
    if (UNSUPPORTED_DISPATCHERS.has(name))
        refuse(`不支持静态分析此 shell／包装入口：${name}`);
    if (name === "printf" && (args.some((arg) => arg.startsWith("-v")) || args.some((arg) => /%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?n/.test(arg.replace(/%%/g, ""))))) {
        refuse("不支持 printf 的变量写入／%n 求值入口");
    }
    if (name === "eval") {
        if (!args.length)
            refuse("eval 缺少字面量脚本");
        // Bash eval joins the already quote-removed argv with spaces, then reparses it.
        scanSource(analysis, args.join(" "), depth + 1);
    }
    else if (SHELLS.has(name)) {
        let index = 0;
        let script;
        while (index < args.length) {
            const option = args[index++];
            // Only options whose effects do not change the accepted syntax are supported.
            // Enabling xtrace can evaluate PS4 from inherited or script-created state.
            // Only inspect options before -c's script: '-x' used as data stays literal.
            if (!/^-[cleuv]+$/.test(option))
                refuse("shell 仅支持明确的 -c 字面量脚本（可组合 l/e/u/v，不支持 -x）");
            if (option.includes("c")) {
                script = args[index];
                break;
            }
        }
        if (script === undefined)
            refuse("shell 没有可静态分析的 -c 脚本；不支持 stdin／脚本文件入口");
        scanSource(analysis, script, depth + 1);
    }
    else if (Object.hasOwn(WRAPPERS, name)) {
        const child = wrapperCommand(name, args);
        if (child.length)
            executable(analysis, child, depth + 1);
    }
}
function children(node) {
    return node.namedChildren.map((child) => child ?? refuse("语法树含缺失节点"));
}
function visit(analysis, node, depth) {
    if (++analysis.nodes > MAX_NODES || depth > MAX_DEPTH)
        refuse("语法树超过分析上限");
    switch (node.type) {
        case "command": {
            // Inspect nested commands first, but never authorize an uncertain outer argv.
            for (const child of children(node))
                substitutions(analysis, child, depth + 1);
            const name = node.childForFieldName("name");
            if (!name || name.type !== "command_name" || name.namedChildCount !== 1)
                refuse("没有确定的命令名");
            const argv = [literal(children(name)[0])];
            for (const child of children(node)) {
                if (child.id === name.id)
                    continue;
                if (child.type === "variable_assignment")
                    visit(analysis, child, depth + 1);
                else
                    argv.push(literal(child));
            }
            executable(analysis, argv, depth + 1);
            return;
        }
        case "variable_assignment": {
            if (node.childForFieldName("name")?.type !== "variable_name")
                refuse("不支持数组赋值");
            const value = node.childForFieldName("value");
            if (value)
                literal(value);
            assignment(node.text);
            return;
        }
        case "file_redirect":
            for (const child of children(node)) {
                if (child.type !== "file_descriptor")
                    literal(child);
            }
            return;
        case "for_statement": {
            const variable = node.childForFieldName("variable");
            if (variable?.type !== "variable_name")
                refuse("for 循环没有确定的赋值目标");
            assignmentName(variable.text);
            const values = node.childrenForFieldName("value");
            if (!values.length)
                refuse("不支持依赖位置参数的 for 循环");
            values.forEach((value) => literal(value ?? refuse("for 循环含缺失节点")));
            const body = node.childForFieldName("body");
            if (!body)
                refuse("for 循环缺少主体");
            visit(analysis, body, depth + 1);
            return;
        }
        case "program":
        case "list":
        case "pipeline":
        case "negated_command":
        case "subshell":
        case "compound_statement":
        case "if_statement":
        case "elif_clause":
        case "else_clause":
        case "while_statement":
        case "do_group":
        case "redirected_statement":
            for (const child of children(node))
                visit(analysis, child, depth + 1);
            return;
        case "comment":
            return;
        default:
            // A successful Bash parse is NOT evidence that we support that syntax.
            return refuse(`不支持此 Bash 语法：${node.type}`);
    }
}
function substitutions(analysis, node, depth) {
    if (++analysis.nodes > MAX_NODES || depth > MAX_DEPTH)
        refuse("语法树超过分析上限");
    if (node.type === "command_substitution" || node.type === "process_substitution") {
        for (const child of children(node))
            visit(analysis, child, depth + 1);
    }
    else {
        for (const child of children(node))
            substitutions(analysis, child, depth + 1);
    }
}
function scanSource(analysis, text, depth) {
    analysis.characters += text.length;
    if (analysis.characters > MAX_COMMAND_LENGTH || depth > MAX_DEPTH)
        refuse("脚本文本超过分析上限");
    // The grammar can split a backslash-newline word into multiple arguments. Refuse
    // rather than let the parsed argv differ from what the remote Bash will execute.
    if (/\\\r?\n|[\x00-\x08\x0b-\x1f\x7f]/.test(text))
        refuse("不支持续行转义或控制字符");
    const tree = analysis.parser.parse(text);
    if (!tree)
        refuse("Bash 解析器没有返回语法树");
    try {
        if (tree.rootNode.hasError)
            refuse("Bash 语法不完整或存在解析错误");
        visit(analysis, tree.rootNode, depth);
    }
    finally {
        tree.delete();
    }
}
/** Static command-structure authorization, NOT an OS sandbox or program interpreter. */
export async function scanBashCommand(command) {
    if (command.length > MAX_COMMAND_LENGTH)
        refuse("命令过长");
    let parser;
    try {
        parser = await getParser();
    }
    catch (error) {
        return refuse(`Bash 解析器初始化失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const analysis = { parser, resources: new Set(), nodes: 0, characters: 0 };
    scanSource(analysis, command, 0);
    if (!analysis.resources.size)
        refuse("没有可识别的可执行命令");
    return { resources: [...analysis.resources] };
}
/**
 * 面向前置 shell 的角色隔离扫描：只判断是否存在可识别的 ssh／scp／sftp
 * 调用，不要求整条命令都受 `scanBashCommand` 支持。
 *
 * 这里刻意不复用 `scanBashCommand` 的拒绝策略：用户的本地 shell 仍然可以使用
 * here-doc、函数等语法；但任何 AST 中可识别的 SSH 执行入口都必须被拦下。
 * 动态命令名、外部脚本和任意程序内部行为仍不在静态保证范围内。
 */
function plainLiteral(node) {
    switch (node.type) {
        case "word":
        case "number": {
            let value = "";
            for (let i = 0; i < node.text.length; i++) {
                const char = node.text[i];
                if (char === "\\") {
                    if (++i === node.text.length)
                        return null;
                    value += node.text[i];
                }
                else {
                    value += char;
                }
            }
            return value;
        }
        case "raw_string":
            return node.text.slice(1, -1);
        case "string": {
            const content = node.namedChildren.filter((child) => child !== null);
            if (content.some((child) => child.type !== "string_content"))
                return null;
            return node.text.slice(1, -1).replace(/\\([$`"\\\n])/g, (_, char) => (char === "\n" ? "" : char));
        }
        case "concatenation": {
            let value = "";
            for (const child of node.namedChildren) {
                if (!child)
                    return null;
                const part = plainLiteral(child);
                if (part === null)
                    return null;
                value += part;
            }
            return value;
        }
        default:
            return null;
    }
}
function namedChildren(node) {
    return node.namedChildren.filter((child) => child !== null);
}
function commandName(node) {
    const name = node.childForFieldName("name");
    if (!name || name.namedChildCount !== 1)
        return null;
    return plainLiteral(namedChildren(name)[0]);
}
function commandArguments(node) {
    const name = node.childForFieldName("name");
    return namedChildren(node)
        .filter((child) => child.id !== name?.id && child.type !== "variable_assignment")
        .map((child) => plainLiteral(child));
}
function isSshExecutable(value) {
    return SSH_EXECUTABLES.has(basename(value));
}
function shellScript(args) {
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (!option || !option.startsWith("-"))
            return null;
        if (option.includes("c"))
            return args[index + 1] ?? null;
    }
    return null;
}
function scanLooseText(scan, text, depth) {
    scan.characters += text.length;
    if (scan.characters > MAX_COMMAND_LENGTH || depth > MAX_DEPTH)
        return true;
    const tree = scan.parser.parse(text);
    if (!tree)
        return true;
    try {
        return walkLoose(scan, tree.rootNode, depth);
    }
    finally {
        tree.delete();
    }
}
function argvHasSsh(scan, argv, depth) {
    const [name, ...args] = argv;
    if (!name)
        return false;
    const base = basename(name);
    if (isSshExecutable(name))
        return true;
    // `command -v ssh` queries a path; it does not execute ssh.
    if (base === "command" && (args[0] === "-v" || args[0] === "-V"))
        return false;
    if (SHELLS.has(base)) {
        const script = shellScript(args);
        return script === null ? false : scanLooseText(scan, script, depth + 1);
    }
    if (base === "eval") {
        if (args.some((arg) => arg === null))
            return false;
        return scanLooseText(scan, args.join(" "), depth + 1);
    }
    if (Object.hasOwn(WRAPPERS, base)) {
        try {
            const child = wrapperCommand(base, args);
            return child.length > 0 && argvHasSsh(scan, child, depth + 1);
        }
        catch {
            // Unknown wrapper options are not decidable; a literal SSH operand is still
            // treated as suspicious rather than silently allowed.
            return args.some((arg) => isSshExecutable(arg));
        }
    }
    if (base === "find") {
        for (let index = 0; index < args.length; index++) {
            if (args[index] !== "-exec" && args[index] !== "-execdir")
                continue;
            const rest = args.slice(index + 1);
            if (rest.length && argvHasSsh(scan, rest, depth + 1))
                return true;
        }
        return false;
    }
    // xargs/watch/su/busybox, etc. execute or dispatch a following command.
    if (UNSUPPORTED_DISPATCHERS.has(base))
        return args.some((arg) => isSshExecutable(arg));
    if (base === "sshpass")
        return args.some((arg) => isSshExecutable(arg));
    return false;
}
function walkLoose(scan, node, depth) {
    if (++scan.nodes > MAX_NODES)
        return true;
    if (node.type === "command") {
        const name = commandName(node);
        if (name) {
            const args = commandArguments(node).filter((arg) => arg !== null);
            if (argvHasSsh(scan, [name, ...args], depth))
                return true;
        }
    }
    for (const child of namedChildren(node)) {
        if (walkLoose(scan, child, depth))
            return true;
    }
    return false;
}
/** Whether a local shell command contains a statically recognizable SSH invocation. */
export async function containsSshCommand(command) {
    if (!command.trim())
        return false;
    let parser;
    try {
        parser = await getParser();
    }
    catch {
        // Do not turn a parser failure into an SSH bypass.
        return true;
    }
    const scan = { parser, nodes: 0, characters: 0 };
    return scanLooseText(scan, command, 0);
}
