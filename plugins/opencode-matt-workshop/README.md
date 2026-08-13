# OpenCode Matt Workshop

独立的 OpenCode Server 插件：把 Matt Pocock Skills `v1.2.2` 的全部 25 个 Promoted Skills 接入七个边界明确的 Workshop Agent。插件只使用 OpenCode 原生 agent、permission、task、steps 和 config hook，不包含自定义任务运行时、Hook、调度器或 worktree 管理。

## Roles

| Agent | Mode | Visibility | Purpose |
| --- | --- | --- | --- |
| Drafter | Primary | visible | 澄清决策、维护领域语言并产出 Implementation Plan；不实施 |
| Tinker | Primary, default | visible | 单 Agent 实施 Ready Work，使用 Existing, Targeted, and Bounded Verification |
| Foreman | Primary | visible | 自己实施主线，仅在并行或 specialist leverage 明确时委派 |
| Maker | Subagent | hidden | 在 Assigned Scope 内实施一个有界端到端单元 |
| Inspector | Subagent | hidden | 只读审查一个 Standards、Spec 或设计维度 |
| Archivist | Subagent | visible | 调研一手来源并写入指定 Markdown 报告 |
| Surveyor | Subagent | visible | 只读映射代码、约定与关系 |

Worker 默认 steps 为 Maker 40、Inspector 24、Archivist 20、Surveyor 32。连续三轮没有新事实、有效 diff、失败范围收窄或验证进展时，Worker 会停止并汇报阻塞。Workshop 不增加并发上限，实际并行由 OpenCode 管理。

用户通过 OpenCode 原生 UI 手动切换 Primary Agent。插件不会自动路由、自动切换角色或自动选择 TDD。

## Configuration

最简配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js"
  ]
}
```

可选的角色覆盖只支持 `model`、`variant`、`temperature`、`steps`：

```jsonc
{
  "plugin": [
    [
      "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js",
      {
        "agents": {
          "drafter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "foreman": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "tinker": { "model": "opencode-go/deepseek-v4-flash", "variant": "high" },
          "maker": { "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
          "inspector": { "model": "opencode-go/deepseek-v4-flash", "variant": "high" },
          "archivist": { "model": "openai/gpt-5.6-luna", "variant": "medium" },
          "surveyor": { "model": "opencode-go/deepseek-v4-flash", "variant": "low" }
        }
      }
    ]
  ]
}
```

这些模型只是推荐，不是运行时默认值。未配置时，每个角色继承 OpenCode 当前模型。DeepSeek V4 Flash 不能接收图片或 PDF；附件任务应临时覆盖为支持附件的模型。

## Workflow behavior

- 全部 25 个 Promoted Skills 都注册为同名 Workflow Command；Matt 的 handoff 使用 `/matt-handoff`，避免与 OpenCode 内置 `/handoff` 冲突。
- `/implement` 在 Tinker 中单 Agent 执行并自行完成 Standards/Spec review；在 Foreman 中由 Foreman实施主线，并可并行委派两个 Inspector review axis。
- `/tdd` 仅在用户明确选择 seams/behaviors 后运行；直接调用 `/tdd` 也必须先确认范围。
- Tinker 遇到必须委派的 Skill 会停止，并提示用户选择 Foreman 或直接调用可见的 Archivist/Surveyor。
- 所有 Worker 使用共享 working tree；Foreman 在委派前声明 Delegation Leverage、Assigned Scope 和预期结果。

## Reproducible adaptation

上游快照固定在 `vendor/mattpocock-skills/`，版本 `v1.2.2`、commit `8b36d4fb2635b3c21998dcd8144439c9e5ba7302`。`skills/`、`skill-manifest.json` 和 `dist/` 都是生成物，不要手改。

```bash
npm run sync:matt-skills
npm run check:matt-workshop
```

Workshop 不保留自动化测试套件。`check:matt-workshop` 只运行 Skill 同步一致性、TypeScript no-emit、clean-build 字节比较、plain-Node 结构合同和 Runtime Distribution 隔离检查。

安装或修改配置后必须完全退出并重新启动 OpenCode；配置不会热重载。

## Architecture

- [Domain language](./CONTEXT.md)
- [Architecture decisions](./docs/adr/)
- [Bundle merge guide](../../docs/MERGE_EXISTING_CONFIG.md)

这是非官方 OpenCode adapter。Matt Pocock 的 vendored Skills 保留上游 MIT 许可证和 provenance。
