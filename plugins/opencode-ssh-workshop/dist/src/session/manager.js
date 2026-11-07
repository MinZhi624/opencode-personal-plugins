import { killSSH } from "./connection.js";
import { createState } from "./state.js";
/**
 * 按「主会话 id」键控的连接集合。
 *
 * 与上游 v0.3.0 的差异只在调用方传入的键：上游用工具收到的
 * `context.sessionID`（每个子代理各自一条连接），本扩展先把它解析成主会话
 * id，因此同一主会话里的 SSH 主角色与 SSH Worker 共用同一条连接与远端工作区，
 * 而不同主会话仍互不影响。内部实现逐行沿用上游。
 */
export function createSessionManager() {
    const sessions = new Map();
    function remove(sessionID) {
        const state = sessions.get(sessionID);
        if (!state)
            return "No active SSH session.";
        sessions.delete(sessionID);
        return killSSH(state);
    }
    return {
        get(sessionID) {
            let state = sessions.get(sessionID);
            if (!state) {
                state = createState();
                sessions.set(sessionID, state);
            }
            return state;
        },
        peek(sessionID) {
            return sessions.get(sessionID);
        },
        remove,
        replace(sessionID) {
            remove(sessionID);
            const state = createState();
            sessions.set(sessionID, state);
            return state;
        },
        dispose() {
            for (const id of [...sessions.keys()])
                remove(id);
        },
    };
}
