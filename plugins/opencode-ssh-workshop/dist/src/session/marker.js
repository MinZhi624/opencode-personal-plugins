export const MARKER_PREFIX = "<<__OC_SSH_DONE__";
export const MARKER_SUFFIX = ">>";
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function markerRegex(id) {
    return new RegExp(`${escapeRegex(MARKER_PREFIX) + escapeRegex(id)}_(\\d+)_([A-Za-z0-9+/=]*)${escapeRegex(MARKER_SUFFIX)}`);
}
