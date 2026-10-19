import { ordered } from "../../view/select.js";
export function surfaceTree(snapshot, rows) {
    return ordered(snapshot.providers, (item) => item.providerId, rows.providerOrder).map((provider) => ({
        provider,
        rowIds: ordered([...new Set(provider.rows.map((row) => row.id))], (id) => id, rows.rowOrder[provider.providerId] ?? []),
    }));
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
/**
 * Where a dragged block goes, given the line under the pointer (0 = the first block's first
 * line). It moves only when the pointer would land inside it after the move, so blocks of
 * different heights never flip back and forth.
 */
export function dropIndex(from, heights, pointer) {
    const starts = [];
    let total = 0;
    for (const height of heights) {
        starts.push(total);
        total += height;
    }
    const line = clamp(pointer, 0, total - 1);
    const over = starts.filter((start) => start <= line).length - 1;
    const fromHeight = heights[from] ?? 1;
    const overStart = starts[over] ?? 0;
    if (over > from)
        return line >= overStart + (heights[over] ?? 1) - fromHeight ? over : from;
    if (over < from)
        return line < overStart + fromHeight ? over : from;
    return from;
}
function moveTo(order, id, index) {
    const next = order.filter((item) => item !== id);
    next.splice(index, 0, id);
    return next;
}
/**
 * The surface with `id` (a provider, or a row within its provider) moved to the index `to`
 * picks in its list; the same object when it stays.
 */
function placed(tree, rows, id, to) {
    const providerIds = tree.map(({ provider }) => provider.providerId);
    const from = providerIds.indexOf(id);
    if (from >= 0) {
        const index = to(providerIds, from);
        return index === from ? rows : { ...rows, providerOrder: moveTo(providerIds, id, index) };
    }
    const owner = tree.find((item) => item.rowIds.includes(id));
    if (!owner)
        return rows;
    const rowFrom = owner.rowIds.indexOf(id);
    const index = to(owner.rowIds, rowFrom, owner);
    if (index === rowFrom)
        return rows;
    const rowOrder = {
        ...rows.rowOrder,
        [owner.provider.providerId]: moveTo(owner.rowIds, id, index),
    };
    return { ...rows, rowOrder };
}
/** shift+↑↓: `id` moves `delta` places. */
export function movedBy(tree, rows, id, delta) {
    return placed(tree, rows, id, (order, from) => clamp(from + delta, 0, order.length - 1));
}
/**
 * A drag: `id` goes where the pointer is, `pointer` lines below the list's first line. A row
 * never leaves its provider: a pointer outside counts as its provider's first or last row.
 */
export function draggedTo(tree, rows, id, pointer, withRows) {
    const height = (item) => 1 + (withRows ? item.rowIds.length : 0);
    return placed(tree, rows, id, (order, from, owner) => {
        if (!owner)
            return dropIndex(from, tree.map(height), pointer);
        const above = tree.slice(0, tree.indexOf(owner));
        const firstRowLine = 1 + above.reduce((sum, item) => sum + height(item), 0);
        return dropIndex(from, order.map(() => 1), pointer - firstRowLine);
    });
}
