/** A text report as data (a heading line, then sections of lines and key-value rows) and its text. */
function hasBlockContent(block) {
    return block.kind === "lines" ? block.lines.length > 0 : block.rows.length > 0;
}
function renderKvRow(row) {
    const indent = row.indent === 1 ? "  " : "";
    if (row.value !== undefined) {
        return `${indent}- ${row.key}: ${row.value}`;
    }
    return `${indent}- ${row.key}${row.trailingColon ? ":" : ""}`;
}
/**
 * The report as text: the heading, then each section with a title or a block with content,
 * a blank line between sections and between blocks.
 */
export function renderPlainTextReport(document) {
    const lines = [];
    if (document.heading)
        lines.push(document.heading);
    for (const section of document.sections) {
        const blocks = section.blocks.filter(hasBlockContent);
        if (!section.title && blocks.length === 0)
            continue;
        if (lines.length > 0)
            lines.push("");
        if (section.title) {
            lines.push(section.title);
        }
        for (const [index, block] of blocks.entries()) {
            if (index > 0)
                lines.push("");
            lines.push(...(block.kind === "lines" ? block.lines : block.rows.map(renderKvRow)));
        }
    }
    return lines.join("\n");
}
