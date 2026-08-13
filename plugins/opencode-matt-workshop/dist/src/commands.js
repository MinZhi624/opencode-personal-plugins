import { manifest } from "./catalog.js";
const descriptions = {
    "ask-matt": "选择最适合当前情况的工作流技能。",
    "diagnosing-bugs": "诊断顽固、间歇性或回归问题，并建立可靠反馈循环。",
    "grill-with-docs": "通过深入访谈澄清想法，同时维护领域语言与决策记录。",
    triage: "按配置的分诊状态机处理传入的 Issue。",
    "improve-codebase-architecture": "识别并探索可深化的代码库架构机会。",
    "setup-matt-pocock-skills": "配置仓库的 Issue tracker、分诊标签和领域文档布局。",
    tdd: "以测试驱动开发方式实现具体行为。",
    "to-spec": "将当前上下文整理为可实施的规格说明。",
    "to-tickets": "将工作拆分为带明确阻塞关系的 tracer-bullet Ticket。",
    wayfinder: "为庞大而模糊的工作梳理并解决关键决策。",
    implement: "直接实施 Ready Work，或协调 Maker 完成实施。",
    prototype: "创建一次性原型以验证状态模型、逻辑或界面设计。",
    research: "根据高可信一手来源调研问题并产出带引用的报告。",
    "domain-modeling": "梳理领域术语，并在必要时记录架构决策。",
    "codebase-design": "用深模块设计词汇改进模块边界和接口形态。",
    "code-review": "从规范与规格两个维度审查变更。",
    "resolving-merge-conflicts": "按双方意图逐段解决进行中的 Git 合并或变基冲突。",
    wizard: "为只能由人工执行的步骤生成交互式 Bash 向导。",
    "grill-me": "通过深入访谈澄清计划或设计，但不写入工作区。",
    grilling: "运行逐轮、聚焦未决问题的深入访谈。",
    handoff: "生成可供新 OpenCode 会话使用的脱敏交接文档。",
    teach: "在当前工作区运行跨会话、有状态的教学流程。",
    "to-questionnaire": "编写发给外部人员的问卷，以补齐关键信息缺口。",
    "wait-what": "用当前领域词汇重新解释刚才没有讲清楚的内容。",
    "writing-for-agents": "编写供 Agent 消费的技能、指令和引用文档。",
};
function template(name) {
    return `Load the \`${name}\` Workflow Skill with OpenCode's skill tool and follow it exactly. Treat the text below as the user's arguments and context for that workflow.\n\n$ARGUMENTS`;
}
export function buildWorkshopCommands() {
    return Object.fromEntries(manifest.skills.map((skill) => [skill.name === "handoff" ? "matt-handoff" : skill.name, {
            template: template(skill.name === "handoff" ? "matt-handoff" : skill.name),
            description: descriptions[skill.name] ?? `运行 ${skill.name} 工作流技能。`,
        }]));
}
