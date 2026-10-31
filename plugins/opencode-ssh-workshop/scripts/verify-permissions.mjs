// SSH is never executed: the real SSH tool writes into a recording stdin.
// Local Bash probes use only inert functions or marker files in a temporary directory.
// Run after build: node plugins/opencode-ssh-workshop/scripts/verify-permissions.mjs
import assert from "node:assert/strict"
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { scanBashCommand, UnscannableCommandError } from "../dist/src/shell-parser.js"
import { createExecuteTool } from "../dist/src/tools/execute.js"
import { buildGrepCommand, GREP_ERROR, GREP_NO_MATCH } from "../dist/src/tools/remote-files.js"
import { assertPermissionApi } from "../dist/src/permission.js"
import { isSameConnection } from "../dist/src/connect-core.js"
import { assertSshSessionAgent, guardToolCall, SSH_AGENT_REQUIRED_MESSAGE, SSH_TOOL_NAMES } from "../dist/src/agent-guard.js"
import { isSshAgent } from "../dist/src/agents.js"
import { createState } from "../dist/src/session/state.js"
import { checkBuffer } from "../dist/src/session/reader.js"
import { createDownloadTool } from "../dist/src/tools/transfer.js"

export const DENIED = [
  "git push origin main", "git 'push' origin main", 'git "push" origin main',
  'git pu"sh" origin main', 'git pu\\sh origin main', "g'it' push origin main",
  "/usr/bin/git push origin main", "FOO=1 git push origin main",
  "git status && git push origin main", "true || git push origin main",
  "git status; git push origin main", "git status\ngit push origin main",
  "git push origin main | cat", "if true; then git push origin main; fi",
  "if false; then echo ok; else git push origin main; fi",
  "(git push origin main)", "{ git push origin main; }", "! git push origin main",
  "for x in a b; do git push origin main; done",
  "while false; do git push origin main; done",
  "until true; do git push origin main; done",
  "eval 'git push origin main'", "eval git 'push origin main'",
  'eval "git" "push origin main"', "bash -c 'git push origin main'",
  "bash -lc 'git push origin main'", "bash -l -c 'git push origin main'",
  "/bin/bash -c 'git push origin main'", "sh -c 'git push origin main'",
  "env git push origin main", 'env "git" push origin main',
  "env -u OLD FOO=bar git push origin main", "env --unset=OLD git push origin main",
  "sudo -u root git push origin main", "sudo --user=root git push origin main",
  "command -- git push origin main", "builtin eval 'git push origin main'",
  "exec -a display git push origin main", "nohup git push origin main",
  "time git push origin main", "nice -n 5 git push origin main",
  "timeout -s TERM 5s git push origin main", "setsid -f git push origin main",
  "env bash -lc 'git push origin main'", "command env bash -c 'git push origin main'",
]

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const traceScript = "PS4='$(printf PS4_PROBE)'; true"
export const TRACE_REFUSED = [
  "PS4=trace; true", "PS4=trace bash -c true", "env PS4=trace bash -c true",
  "env -- PS4=trace bash -c true", "command env PS4=trace bash -c true",
  `eval ${quote("PS4=trace; true")}`, `/bin/bash -c ${quote("PS4=trace; true")}`,
  `bash -xc ${quote(traceScript)}`, `bash -cx ${quote(traceScript)}`,
  `bash -x -c ${quote(traceScript)}`, "bash '-x' -c true",
  "/bin/sh -xc true", "/bin/dash -x -c true", "env bash -xc true",
  "command env /bin/bash -xc true", `eval ${quote("bash -x -c true")}`,
  "echo before; PS4=trace; true", "echo before && bash -x -c true",
  "bash -o xtrace -c true", "SHELLOPTS=xtrace bash -c true",
  "env SHELLOPTS=xtrace bash -c true", `bash -c ${quote("set -x; true")}`,
  "for PS4 in trace; do true; done", "printf -v PS4 trace",
]

export const REFUSED = [
  ...TRACE_REFUSED,
  "", "if true; then git push", "$GIT push", "$(getcmd) foo",
  'git "$SUBCOMMAND" origin main', 'env "$GIT" push origin main',
  'eval "$CMD"', 'bash -lc "$CMD"', "bash", "bash script.sh",
  "bash -O extglob -c 'git push origin main'", "bash <<EOF\ngit push origin main\nEOF",
  'echo "$(git push origin main)"', "echo `git push origin main`",
  "git $(printf push) origin main", "echo <(git push origin main)",
  "xargs -I {} git push origin main", "env -S 'git push origin main'",
  "sudo -i git push origin main", "sudo --unknown root git push origin main",
  "env BASH_ENV=evil bash -c true", "BASH_ENV=evil bash -c true",
  "zsh -c 'git push origin main'", "busybox sh -c 'git push origin main'",
  "f(){ git push origin main; }; f", "alias git=echo; git push",
  "source deploy.sh", "true; export FOO=bar", "echo *.ts", "echo {a,b}",
  "let 'a[$(git push origin main)]=1'", "unset 'a[$(git push origin main)]'",
  "printf -v 'a[$(git push origin main)]' x", "printf '%10n' 'a[$(git push origin main)]'",
  "echo ~", "git $'push'", "for x; do git status; done",
  "[[ x = x ]] && git status", "echo $((1+1))", "echo a\\\nb",
  "echo \x00", "echo ok\n".repeat(10_000), "(".repeat(40) + "true" + ")".repeat(40),
  Array.from({ length: 520 }, (_, i) => `echo ${i}`).join(";"),
  Array(7_500).fill("true").join(";"), "env ".repeat(40) + "git status",
]

export const ALLOWED = [
  ["git status", ["git status"]],
  ["git 'status'", ["git status"]],
  ["git status | cat", ["git status", "cat"]],
  ["echo 'git push'", ["echo git push"]],
  ["echo '$(git push)'", ["echo $(git push)"]],
  ["echo 'a;b|c'", ["echo a;b|c"]],
  ["printf '%s\\n' hi", ["printf %s\\n hi"]],
  ['echo "a\\\"b"', ['echo a"b']],
  ["git status > /tmp/status", ["git status"]],
  ["cd /tmp && pwd", ["cd /tmp", "pwd"]],
  ["env FOO=bar git status", ["env FOO=bar git status", "git status"]],
  ["bash -c 'git status'", ["bash -c git status", "git status"]],
  ["echo '-x'", ["echo -x"]],
  ["echo 'PS4=trace'", ["echo PS4=trace"]],
  ["echo 'PS4=$(printf not-executed)'", ["echo PS4=$(printf not-executed)"]],
  ["bash -c 'echo -x'", ["bash -c echo -x", "echo -x"]],
  ["bash -c true -x", ["bash -c true -x", "true"]],
  ["env -u PS4 bash -c true", ["env -u PS4 bash -c true", "bash -c true", "true"]],
  ["PS40=trace true", ["true"]],
  ["for PS40 in trace; do true; done", ["true"]],
  ["bash -ec 'git status'", ["bash -ec git status", "git status"]],
]

export async function runCommand(command, permissionAssert, options = {}) {
  const writes = []
  const calls = []
  const reached = new Error("recorded SSH write")
  const state = {
    host: "test@invalid", readerDone: false, running: false, commandQueue: [],
    proc: { stdin: { write(payload) { writes.push(payload); throw reached } } },
  }
  const runtime = {
    ctx: { permission: { async assert(request) { calls.push(request); await permissionAssert(request) } } },
    async peekFor() { return { rootID: options.sessionID ?? "ses_test", state } },
    sessions: { remove() {} }, workspaces: { clear() {} },
  }
  const controller = options.controller ?? new AbortController()
  options.onState?.(state, { writes, calls })
  const tool = {
    sessionID: options.sessionID ?? "ses_test", agent: "build",
    messageID: "msg_test", id: "call_test", signal: controller.signal,
  }
  let output, error
  try { output = await createExecuteTool(runtime).execute({ command }, tool) }
  catch (cause) { error = cause }
  return { writes, calls, output, error, reached }
}

export async function verifyLocal() {
  let cases = 0
  for (const command of DENIED) {
    const scan = await scanBashCommand(command)
    assert(scan.resources.includes("git push origin main"), `${command}: missing child resource`)
    // This deliberately does NOT emulate native rules. It checks the ordering seam.
    const rejection = new Error("injected authorization rejection")
    const result = await runCommand(command, async () => { throw rejection })
    assert.equal(result.error, rejection)
    assert.equal(result.writes.length, 0)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].action, "shell")
    assert.deepEqual(result.calls[0].save, [command])
    cases++
  }
  for (const command of REFUSED) {
    await assert.rejects(scanBashCommand(command), UnscannableCommandError)
    const result = await runCommand(command, async () => assert.fail("unsupported command asked for permission"))
    assert.match(result.output?.content ?? "", /SSH 命令分析拒绝/)
    assert.equal(result.calls.length, 0)
    assert.equal(result.writes.length, 0)
    cases++
  }
  for (const [command, expected] of ALLOWED) {
    assert.deepEqual((await scanBashCommand(command)).resources, expected)
    const result = await runCommand(command, async () => {})
    assert.equal(result.error, result.reached)
    assert.equal(result.writes.length, 1)
    assert(result.writes[0].startsWith(`${command} 2>&1\n`), "transport must receive original source")
    cases++
  }
  // Cancellation before authorization completes must not dispatch the payload.
  const controller = new AbortController()
  const cancelled = await runCommand("git status", async () => controller.abort(), { controller })
  assert.equal(cancelled.writes.length, 0)
  assert.equal(cancelled.error?.name, "AbortError")
  cases++

  let queuedState
  const queuedController = new AbortController()
  const queued = runCommand("git status", async () => {}, {
    controller: queuedController,
    onState(state) { state.running = true; queuedState = state },
  })
  for (let tries = 0; tries < 20 && !queuedState.commandQueue.length; tries++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(queuedState.commandQueue.length, 1, "command must be queued for this cancellation check")
  queuedController.abort()
  queuedState.commandQueue.shift()()
  assert.equal((await queued).writes.length, 0, "cancelled queued command must not dispatch")
  cases++

  // Runtime capability guard: a missing permission API must fail closed.
  assert.throws(() => assertPermissionApi({ permission: {} }), /requires OpenCode 2\.0\.31\+/)
  assert.doesNotThrow(() => assertPermissionApi({ permission: { assert: async () => {} } }))
  const { default: sshPlugin } = await import("../dist/src/index.js")
  await assert.rejects(sshPlugin.setup({ permission: {} }), /requires OpenCode 2\.0\.31\+/)
  cases += 3

  // Role isolation: only the seven declared SSH agents may enter SSH tools.
  assert.equal(isSshAgent("ssh-tinker"), true)
  assert.equal(isSshAgent("ssh-other"), false)
  const required = new RegExp(SSH_AGENT_REQUIRED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  for (const tool of SSH_TOOL_NAMES) {
    await assert.rejects(guardToolCall("tinker", tool, {}), required)
  }
  cases += SSH_TOOL_NAMES.size
  await assert.doesNotReject(guardToolCall("ssh-tinker", "ssh", { command: "hostname" }))
  await assert.rejects(guardToolCall("ssh-other", "ssh", { command: "hostname" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "ssh host" }), required)
  await assert.doesNotReject(guardToolCall("tinker", "shell", { command: "echo ssh" }))
  await assert.doesNotReject(guardToolCall("tinker", "shell", { command: "cat ssh.txt" }))
  await assert.doesNotReject(guardToolCall("tinker", "shell", { command: "command -v ssh" }))
  await assert.doesNotReject(guardToolCall("tinker", "shell", { command: "# ssh\n true" }))
  await assert.rejects(guardToolCall("tinker", "shell", { command: "ssh host" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "scp a b" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "sftp host" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "bash -c 'ssh host'" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "xargs ssh" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "sudo -u root ssh host" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "env FOO=bar ssh host" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: "find . -exec ssh {} \\;" }), required)
  await assert.rejects(guardToolCall("tinker", "shell", { command: 'echo "$(ssh host)"' }), required)
  await assert.rejects(guardToolCall("ssh-tinker", "shell", { command: "hostname" }), /本地工具/)
  assert.throws(() => assertSshSessionAgent("tinker"), required)
  assert.doesNotThrow(() => assertSshSessionAgent("ssh-tinker"))
  cases += 21

  // Verify the real setup registers the execute.before hook and delegates to the
  // same guard. This is a source/fixture test, not a live OpenCode tool call.
  let beforeHook
  const registrations = []
  const noopRegistration = { dispose: async () => {} }
  const fakeContext = {
    permission: { assert: async () => {} },
    options: {},
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    tool: {
      transform: async () => noopRegistration,
      hook: async (name, callback) => {
        if (name === "execute.before") beforeHook = callback
        return noopRegistration
      },
    },
    agent: { transform: async () => noopRegistration },
    session: { hook: async () => noopRegistration, get: async () => ({ agent: "tinker" }) },
    rpc: { register: async () => noopRegistration },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
  }
  const cleanup = await sshPlugin.setup(fakeContext)
  try {
    assert.equal(typeof beforeHook, "function")
    await assert.rejects(
      beforeHook({ agent: "tinker", tool: "ssh", input: { command: "hostname" } }),
      required,
    )
    await assert.doesNotReject(
      beforeHook({ agent: "ssh-tinker", tool: "ssh", input: { command: "hostname" } }),
    )
    await assert.rejects(
      beforeHook({ agent: "tinker", tool: "shell", input: { command: "ssh host" } }),
      required,
    )
    cases += 3
  } finally {
    await cleanup?.()
  }

  // Connection identity includes options and normalized remote directory.
  assert.equal(
    isSameConnection(
      { host: "wukong@host", initialDirectory: "/work", options: null },
      { target: "wukong@host", remoteDirectory: "/work" },
    ),
    true,
  )
  assert.equal(
    isSameConnection(
      { host: "wukong@host", initialDirectory: "/work", options: null },
      { target: "wukong@host", options: "-p 2222", remoteDirectory: "/work" },
    ),
    false,
    "different port/options must not reuse the connection",
  )
  assert.equal(
    isSameConnection(
      { host: "wukong@host", initialDirectory: "/work", options: "-p 22" },
      { target: "wukong@host", options: " -p 22 ", remoteDirectory: " /work " },
    ),
    true,
    "trimmed equivalent identity may reuse the connection",
  )
  cases += 3

  // The command marker carries the shell's current PWD; file paths must follow
  // a real `cd` rather than the directory requested at connect time.
  const markerState = createState()
  const markerCwd = "/home/wukong/project"
  markerState.currentMarkerId = "cwdtest"
  markerState.buffer = `before\n<<__OC_SSH_DONE__cwdtest_0_${Buffer.from(`${markerCwd}\n`).toString("base64")}>>`
  let markerResult
  markerState.pendingResolve = (result) => { markerResult = result }
  checkBuffer(markerState)
  assert.equal(markerResult?.exitCode, 0)
  assert.equal(markerState.remoteDirectory, markerCwd)
  cases++

  // A connection lost during authorization must reject the download before any
  // local file is written, instead of decoding the dead-session text as base64.
  await mkdir(join(tmpdir(), "opencode"), { recursive: true })
  const downloadTemp = await mkdtemp(join(tmpdir(), "opencode", "ssh-download-guard-"))
  try {
    let writes = 0
    const downloadState = {
      host: "test@invalid", readerDone: false, running: false, commandQueue: [],
      proc: { stdin: { write() { writes++ } } }, remoteDirectory: "/work",
      initialDirectory: "/work", options: null, deviceID: null,
    }
    const ctx = {
      location: { directory: downloadTemp },
      permission: { async assert() { downloadState.readerDone = true } },
    }
    const runtime = { ctx, async peekFor() { return { state: downloadState } } }
    const tool = {
      sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test",
      signal: new AbortController().signal,
    }
    await assert.rejects(createDownloadTool(runtime).execute(
      { remotePath: "notes.txt", localPath: "downloaded.bin" },
      tool,
    ))
    assert.equal(writes, 0, "dead connection must not reach stdin")
    await assert.rejects(readFile(join(downloadTemp, "downloaded.bin")), { code: "ENOENT" })
    cases++
  } finally {
    await rm(downloadTemp, { recursive: true, force: true })
  }

  // Verify that the same resource also loads in the development source layout.
  const development = await import("../src/shell-parser.ts")
  assert.deepEqual((await development.scanBashCommand("git 'status'")).resources, ["git status"])
  cases++

  // Compare quote removal with real Bash using an inert function, never git/SSH.
  if (process.platform === "linux") {
    for (const word of ["'push'", '"push"', 'pu"sh"', "pu\\sh", "'two words'", '"a\\\"b"', "'a;b|c'", "\\*", '"\\$HOME"']) {
      const bash = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `probe(){ printf '%s\\0' "$@"; }; probe ${word}`], {
        env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
      })
      assert.equal(bash.status, 0, bash.stderr)
      const argv = bash.stdout.split("\0").slice(0, -1)
      assert.deepEqual((await scanBashCommand(`probe ${word}`)).resources, [["probe", ...argv].join(" ")])
      cases++
    }

    // grep must not exit the persistent shell: match, no-match and real error
    // all have to reach the following command.
    await mkdir(join(tmpdir(), "opencode"), { recursive: true })
    const grepTemp = await mkdtemp(join(tmpdir(), "opencode", "ssh-grep-probe-"))
    try {
      const grepFile = join(grepTemp, "sample.txt")
      await writeFile(grepFile, "needle\n")
      for (const [pattern, expected] of [
        ["needle", /needle/],
        ["absent", new RegExp(GREP_NO_MATCH)],
        ["[", new RegExp(GREP_ERROR)],
      ]) {
        const result = spawnSync(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", `${buildGrepCommand(pattern, grepFile)}; printf 'AFTER_EXIT\\n'`],
          { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000 },
        )
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, expected)
        assert.match(result.stdout, /AFTER_EXIT/, "grep must not exit the persistent shell")
        cases++
      }
      console.log("PASS grep lifecycle: match/no-match/error all continue in the same shell")
    } finally {
      await rm(grepTemp, { recursive: true, force: true })
    }

    // The unguarded shell must create the marker; the guarded SSH tool must not
    // ask for permission or dispatch even the preceding otherwise-safe command.
    await mkdir(join(tmpdir(), "opencode"), { recursive: true })
    const temp = await mkdtemp(join(tmpdir(), "opencode", "ssh-ps4-probe-"))
    try {
      const marker = join(temp, "executed")
      const script = `PS4='$(printf TRIGGERED > ${marker})'; true`
      const command = `bash -xc ${quote(script)}`
      const bash = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        env: { PATH: "/usr/bin:/bin", HOME: temp }, encoding: "utf8", timeout: 5_000,
      })
      assert.equal(bash.status, 0, bash.stderr)
      assert.equal(await readFile(marker, "utf8"), "TRIGGERED", "PS4 expansion must actually create the marker")
      await rm(marker)
      for (const input of [command, `echo before; ${command}`]) {
        const result = await runCommand(input, async () => assert.fail("PS4 probe must not reach authorization"))
        assert.match(result.output?.content ?? "", /SSH 命令分析拒绝/)
        assert.equal(result.calls.length, 0)
        assert.equal(result.writes.length, 0)
        await assert.rejects(readFile(marker), { code: "ENOENT" })
        cases++
      }
      console.log("PASS PS4 probe: unguarded Bash created the marker; guarded SSH calls rejected with zero writes")
    } finally { await rm(temp, { recursive: true, force: true }) }
  }

  // Fault injection uses a temporary runtime layout, not a change to vendored files.
  await mkdir(join(tmpdir(), "opencode"), { recursive: true })
  const base = await mkdtemp(join(tmpdir(), "opencode", "ssh-parser-fault-"))
  try {
    const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    await cp(join(plugin, "dist"), join(base, "dist"), { recursive: true })
    await mkdir(join(base, "node_modules"), { recursive: true })
    // Core dependency resolution remains in the repository; only the grammar is faulty.
    const { symlink } = await import("node:fs/promises")
    await rm(join(base, "node_modules"), { recursive: true })
    await symlink(resolve(plugin, "..", "..", "node_modules"), join(base, "node_modules"), "dir")
    const grammar = join(base, "dist", "grammar", "tree-sitter-bash.wasm")
    for (const corrupt of [false, true]) {
      await rm(grammar, { force: true })
      if (corrupt) await copyFile(join(plugin, "package.json"), grammar)
      const module = pathToFileURL(join(base, "dist", "src", "tools", "execute.js")).href
      const script = `
        import assert from 'node:assert/strict';
        const {createExecuteTool}=await import(${JSON.stringify(module)});
        let writes=0,calls=0;
        const state={host:'test',readerDone:false,proc:{stdin:{write(){writes++}}}};
        const runtime={ctx:{permission:{async assert(){calls++}}},async peekFor(){return {state}}};
        const output=await createExecuteTool(runtime).execute({command:'git status'},{});
        assert.match(output.content,/解析器初始化失败/); assert.equal(writes,0); assert.equal(calls,0);
      `
      const process = spawnSync(globalThis.process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 })
      assert.equal(process.status, 0, process.stderr)
      cases++
    }
  } finally { await rm(base, { recursive: true, force: true }) }
  console.log(`PASS local SSH authorization checks: ${cases} cases (injected permission boundary; NOT native rule evaluation)`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyLocal()
