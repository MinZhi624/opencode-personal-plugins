# PLUGIN KNOWLEDGE BASE — opencode-enhanced-sidebar-zh

**Generated:** 2026-08-12

## OVERVIEW

TUI-only plugin (14 tracked files) rendering the sidebar context / TPS / subagent-cost panels. Loaded directly as raw TSX — no build step exists.

## STRUCTURE

```
opencode-enhanced-sidebar-zh/
├── src/tui.tsx                    # entry — default export TuiPluginModule { id: "opencode-enhanced-sidebar-zh", tui }, registers sidebar_content slot (order 60)
├── src/metrics/                   # all cost/TPS logic
│   ├── pricing.ts                 # 931 lines — model price lookup + bundled snapshot fallback
│   ├── session-metrics.ts         # 515 lines — session cost truth (client session messages)
│   ├── step-tps.ts                # per-step tokens-per-second
│   ├── token-buckets.ts           # the five token bucket inputs
│   └── token-cost.ts              # bucket → cost conversion
├── src/subagent-magazine.tsx      # subagent tracking panel
├── src/subagent-guards.ts         # guards for the panel
├── src/data/modelsdev-pricing.min.json  # bundled pricing snapshot fallback
├── README.zh.md                   # behavior spec: TPS rules, cost scoping (本会话/子代理/任务树合计), panels
├── package.json                   # NO main field
└── LICENSES/                      # 3 vendored upstream licenses
```

Loaded by `config/tui.jsonc`. No dist/, no tsconfig, no tests, no vitest config.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| TPS / cost / session metrics | `src/metrics/session-metrics.ts`, `src/metrics/step-tps.ts` | cost truth lives here |
| Token bucket → cost math | `src/metrics/token-buckets.ts`, `src/metrics/token-cost.ts` | five buckets only |
| Model price lookup | `src/metrics/pricing.ts` | + `src/data/modelsdev-pricing.min.json` snapshot fallback |
| Subagent panel | `src/subagent-magazine.tsx` + `src/subagent-guards.ts` | — |
| Panel layout / TPS rules / cost scoping | `README.zh.md` | 本会话 / 子代理 / 任务树合计; no CONTEXT.md — domain terms from root CONTEXT.md |

## CONVENTIONS

- **Edit source, restart OpenCode** — raw TSX loads directly; there is no compile step, no artifacts to regenerate.
- **Cost truth** is `api.client.session.messages()`; prices are API list-price estimates per actual message provider/model, repriced on snapshot update.
- **Unpriced models show 未定价**, never `$0`; task-tree totals show 本会话 / 子代理 / 任务树合计 separately.
- `modelsdev-pricing.min.json` is a fallback only — live pricing wins when available.

## ANTI-PATTERNS

- **NEVER use `api.state.session.messages()`** (the TUI ~100-message window) as the cost total — the truth is `api.client.session.messages()`. (`session-metrics.ts`)
- **NEVER read `message.cost` / `session.cost`** — the only valid inputs are the five token buckets: input / output / reasoning / cache-read / cache-write. (`token-buckets.ts`)
