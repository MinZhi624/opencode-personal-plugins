import { markerRegex } from "./marker.js";
export function checkBuffer(state) {
    if (!state.currentMarkerId || !state.pendingResolve)
        return;
    const pattern = markerRegex(state.currentMarkerId);
    const match = state.buffer.match(pattern);
    if (match) {
        const markerIndex = state.buffer.indexOf(match[0]);
        const end = markerIndex + match[0].length;
        // Wait for a complete protocol line even when the marker/newline arrive in
        // separate chunks. Removing a newline only if already present races the reader.
        const newline = state.buffer.slice(end).match(/^\r?\n/);
        if (!newline)
            return;
        // 不再 trim：标记由 `echo` 单独输出，缓冲区里标记之前就是命令的原始 stdout。
        // 先前的 trim 会吃掉文件首行缩进与末尾换行，让远端文件读取无法忠实返回内容。
        const output = state.buffer.substring(0, markerIndex);
        state.buffer = state.buffer.substring(end + newline[0].length);
        const exitCode = parseInt(match[1], 10);
        if (match[2]) {
            // pwd 输出带一个行尾换行；它属于命令输出，不属于目录名。
            const cwd = Buffer.from(match[2], "base64").toString("utf8").replace(/\r?\n$/, "");
            if (cwd.startsWith("/"))
                state.remoteDirectory = cwd;
        }
        state.pendingResolve({ output, exitCode });
    }
}
/**
 * 收集 stderr 供连接失败时给出原因。
 *
 * 与上游 v0.3.0 的差异：上游接收 Bun 的 web `ReadableStream` 并用
 * `getReader()` 逐块读取；此处改为 Node `Readable` 的 `for await` 异步迭代，
 * 消费语义与解码行为保持一致。
 */
export async function startErrorReader(state, stream) {
    const decoder = new TextDecoder();
    try {
        for await (const chunk of stream) {
            state.stderr = (state.stderr + decoder.decode(chunk, { stream: true })).slice(-65_536);
        }
    }
    catch {
        // 流关闭或出错
    }
}
/**
 * 逐块累积 stdout，遇到结束标记即完成当前命令。
 *
 * 与上游 v0.3.0 的差异：`ReadableStream` → Node `Readable`，`getReader()` →
 * `for await`；`finally` 中的 readerDone / pendingReject 逻辑逐行保留。
 */
export async function startReader(state, stream) {
    const decoder = new TextDecoder();
    try {
        for await (const chunk of stream) {
            state.buffer += decoder.decode(chunk, { stream: true });
            checkBuffer(state);
        }
    }
    catch {
        // 流关闭或出错
    }
    finally {
        state.readerDone = true;
        state.pendingReject?.(new Error("SSH connection dropped while waiting for command output."));
    }
}
