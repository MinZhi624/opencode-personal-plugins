/**
 * Workshop 模型预设的共享词汇。
 *
 * 这里只放类型、角色目录和纯函数，不读取文件、不导入服务端模块：
 * Server 插件、TUI 卡片与网页编辑端共用同一份角色定义，避免三处各写一套名字。
 */
export const WORKSHOP_ROLE_IDS = [
    "drafter",
    "tinker",
    "foreman",
    "maker",
    "inspector",
    "archivist",
    "surveyor",
];
export const WORKSHOP_ROLES = [
    {
        id: "drafter",
        name: "规划者",
        label: "Drafter",
        mode: "primary",
        description: "只做澄清与规划，产出 Implementation Plan；不实施生产代码。",
        color: "#8B5CF6",
    },
    {
        id: "tinker",
        name: "通用助手",
        label: "Tinker",
        mode: "primary",
        description: "默认角色：解释、调研、设计、实现与调试，按需委派 Worker。",
        color: "#10B981",
    },
    {
        id: "foreman",
        name: "协作实现",
        label: "Foreman",
        mode: "primary",
        description: "主线自持，识别可并行的独立工作并协调 Worker 整合结果。",
        color: "#F59E0B",
    },
    {
        id: "maker",
        name: "实施者",
        label: "Maker",
        mode: "subagent",
        description: "在 Assigned Scope 内完成一个有界的端到端实现单元。",
        color: "#F97316",
    },
    {
        id: "inspector",
        name: "独立审查",
        label: "Inspector",
        mode: "subagent",
        description: "只读审查一个 Standards、Spec 或设计维度，不修改文件。",
        color: "#EF4444",
    },
    {
        id: "archivist",
        name: "资料调研",
        label: "Archivist",
        mode: "subagent",
        description: "调研一手来源，把带引用的结论写入指定 Markdown 报告。",
        color: "#3B82F6",
    },
    {
        id: "surveyor",
        name: "代码测绘",
        label: "Surveyor",
        mode: "subagent",
        description: "只读映射代码结构、约定和关系，为委派提供上下文。",
        color: "#06B6D4",
    },
];
export const WORKSHOP_ROLE_BY_ID = new Map(WORKSHOP_ROLES.map((role) => [role.id, role]));
export function isWorkshopRoleID(value) {
    return WORKSHOP_ROLE_IDS.includes(value);
}
/** 从旧 `model` 字段与新 `models` 字段统一取出候选链。 */
export function presetModelChain(value) {
    if (!value)
        return [];
    if (Array.isArray(value.models))
        return value.models.filter((item) => typeof item === "string" && item.length > 0);
    if (typeof value.model === "string" && value.model.length > 0)
        return [value.model];
    return [];
}
