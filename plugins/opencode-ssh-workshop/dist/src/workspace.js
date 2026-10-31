export function createWorkspaceRegistry(ctx) {
    /** 子会话 → 主会话的解析缓存；会话被删除时由事件流清掉。 */
    const rootCache = new Map();
    const workspaces = new Map();
    return {
        async resolveRoot(sessionID) {
            const cached = rootCache.get(sessionID);
            if (cached)
                return cached;
            let current = sessionID;
            // 子代理通常只有一层；32 层是防止意外自引用的护栏，不是业务需求。
            for (let depth = 0; depth < 32; depth += 1) {
                let parentID;
                try {
                    parentID = (await ctx.session.get({ sessionID: current }))?.parentID;
                }
                catch {
                    break;
                }
                if (!parentID)
                    break;
                current = parentID;
            }
            rootCache.set(sessionID, current);
            return current;
        },
        get(rootSessionID) {
            return workspaces.get(rootSessionID);
        },
        set(rootSessionID, workspace) {
            workspaces.set(rootSessionID, workspace);
        },
        clear(rootSessionID) {
            workspaces.delete(rootSessionID);
            for (const [child, root] of rootCache)
                if (root === rootSessionID)
                    rootCache.delete(child);
        },
        forgetSession(sessionID) {
            rootCache.delete(sessionID);
        },
    };
}
export function createRuntime(ctx, sessions, workspaces, devices, rememberDevices) {
    return {
        ctx,
        sessions,
        workspaces,
        devices,
        rememberDevices,
        async stateFor(tool) {
            const rootID = await workspaces.resolveRoot(tool.sessionID);
            return { rootID, state: sessions.get(rootID) };
        },
        async peekFor(tool) {
            const rootID = await workspaces.resolveRoot(tool.sessionID);
            const state = sessions.peek(rootID);
            return state ? { rootID, state } : undefined;
        },
    };
}
