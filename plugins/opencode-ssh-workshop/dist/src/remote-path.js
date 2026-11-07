/**
 * 远端路径解析：相对路径一律相对当前远端工作目录，绝对路径与 `~` 原样保留。
 * 用 posix 语义，因为路径位于远端 Linux 主机，与本机平台无关。
 */
export function resolveRemotePath(state, path) {
    const raw = path.trim();
    if (!raw)
        return state.remoteDirectory ?? ".";
    if (raw.startsWith("/") || raw.startsWith("~"))
        return raw;
    if (!state.remoteDirectory)
        return raw;
    return `${state.remoteDirectory.replace(/\/+$/, "")}/${raw}`;
}
/** 远端资源的权限标识，例如 `axiang@192.168.1.20:/etc/hosts`。 */
export function remoteResource(host, path) {
    return `${host}:${path}`;
}
