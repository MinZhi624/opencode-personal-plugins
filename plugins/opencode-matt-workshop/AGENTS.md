# AGENTS.md — opencode-matt-workshop

## OVERVIEW

`opencode-matt-workshop` v2.0.0 是独立 OpenCode Server 插件。入口 `dist/src/index.js` 通过 config hook 注册七个 agents、25 个 Workflow Commands、generated Skills path，并设置 `default_agent` 为 `tinker`。

## LIVE CONTRACT

- Primary: `drafter`, `tinker`, `foreman`; Tinker default。
- Subagent: hidden `maker`/`inspector`; visible `archivist`/`surveyor`。
- Worker steps: 40/24/20/32。
- Tinker `task: deny`; Foreman 只能委派四个 Workshop Workers；Worker 禁止嵌套委派。
- 无 custom tools、Hooks、scheduler、worktree、branch、command runner 或 durable task runtime。
- Plugin options 只允许 `agents.<role>.{model,variant,temperature,steps}`，不固定模型默认值。

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Plugin/options/config merge | `src/index.ts`, `src/options.ts`, `src/config.ts` |
| Agent definitions/permissions/prompts | `src/agents.ts`, `src/prompts.ts` |
| Commands/catalog | `src/commands.ts`, `src/catalog.ts` |
| Generated adapters | `skills/`, `skill-manifest.json` |
| Adapter source of truth | `scripts/sync-matt-skills.mjs` |
| Structural gate | `scripts/verify-matt-workshop.mjs` |
| Upstream pin | `upstream-provenance.json`, `vendor/mattpocock-skills/` |
| Terminology | `CONTEXT.md` |

## CONVENTIONS

- `vendor/` 不修改；adapter 变化必须是 sync 脚本中的精确 anchor patch。
- `skills/`、`skill-manifest.json`、`dist/` 是生成物，不手改。
- `/matt-handoff` 必须保留，避免与 OpenCode 内置 `/handoff` 冲突。
- `npm run check:matt-workshop` 不运行测试：sync check、tsc no-emit、clean-build compare、plain-Node contract、runtime staging。
- 权限按 OpenCode last-match-wins 编写：宽规则在前，窄 allow/ask/deny 在后。
- 使用 `CONTEXT.md` 的正式领域词；不要重新引入旧 runtime 术语。

## ANTI-PATTERNS

- 添加 Workshop Vitest/tests 或把测试重新接入 `check:matt-workshop`。
- 添加并发选项、replacement 选项、reasoningEffort 或模型默认值。
- 让 Tinker 委派、让 Drafter 调用 Maker、让 Worker 嵌套委派。
- 自动切换 Primary Agent、自动选择 TDD、创建工作树/分支/提交。
- 放宽上游 anchor/provenance/byte-reproducibility 失败条件。
