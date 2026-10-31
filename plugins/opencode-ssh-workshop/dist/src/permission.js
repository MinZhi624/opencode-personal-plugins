/**
 * SSH 工具必须在支持 `ctx.permission.assert` 的运行时加载。
 *
 * 不能把缺失的权限 API 当作“全部允许”继续运行；那会把远端命令变成
 * 不受原生规则约束的执行通道。2.0.31 已实测提供该能力，2.0.28 不提供。
 */
export function assertPermissionApi(ctx) {
    if (typeof ctx.permission?.assert !== "function") {
        throw new Error("opencode-ssh-workshop requires OpenCode 2.0.31+ with ctx.permission.assert; " +
            "this runtime cannot enforce SSH permissions, so the SSH plugin refuses to load.");
    }
}
/**
 * 把上游 V1 的 `context.ask({ permission, patterns, always })` 迁移到 V2 的
 * `ctx.permission.assert`。
 *
 * - `permission` → `action`
 * - `patterns` → `resources`
 * - `always` → `save`
 *
 * `source` 让提示框挂在当前这次工具调用上，而不是变成一条无归属的等待。
 * 这是 V2 插件指南里资源级授权的官方写法；工具本身不再声明
 * `options.permission`，避免同一动作被检查两次。
 */
export async function assertPermission(ctx, tool, request) {
    await ctx.permission.assert({
        sessionID: tool.sessionID,
        agent: tool.agent,
        source: { type: "tool", messageID: tool.messageID, id: tool.id },
        action: request.action,
        resources: [...request.resources],
        ...(request.save ? { save: [...request.save] } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
    });
}
/**
 * 迁移上游 `authorizeTransfer`：上传先查本地再查远端，下载反过来。
 * 上游依赖 V1 的 `context.directory` / `context.worktree`；V2 工具上下文不再提供
 * 这两项，因此本地一侧统一以插件加载位置为根做「是否越出工作区」判断。
 */
export async function authorizeTransfer(ctx, tool, input) {
    const { isAbsolute, relative, resolve, sep } = await import("node:path");
    const location = ctx.location.directory;
    const localPath = resolve(location, input.localPath);
    const rel = relative(location, localPath);
    const outsideLocation = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    const remoteResource = `${input.host}:${input.remotePath}`;
    const askLocal = async () => {
        if (outsideLocation) {
            await assertPermission(ctx, tool, {
                action: "external_directory",
                resources: [localPath],
                save: [localPath],
                metadata: { path: localPath },
            });
        }
        await assertPermission(ctx, tool, {
            action: input.localAction,
            resources: [localPath],
            save: [localPath],
            metadata: { path: localPath },
        });
    };
    const askRemote = () => assertPermission(ctx, tool, {
        action: input.remoteAction,
        resources: [remoteResource],
        save: [remoteResource],
        metadata: { host: input.host, path: input.remotePath },
    });
    if (input.localAction === "read") {
        await askLocal();
        await askRemote();
    }
    else {
        await askRemote();
        await askLocal();
    }
    return localPath;
}
