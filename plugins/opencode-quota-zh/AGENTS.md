# AGENTS.md — opencode-quota-zh

## OVERVIEW

Largest bundle plugin (569 tracked files): server + TUI quota, token-usage, and API list-price estimation. Entry `src/index.ts` exports `{id: "@local/opencode-quota-zh", server: QuotaToastPlugin}`; `src/plugin.ts` implements it (slash commands /quota, quota providers, alerts); `src/tui.tsx` + `src/quota-zh-sidebar.tsx` are the TUI pair; `src/bin/opencode-quota.ts` is the `show`/`status` CLI.

## STRUCTURE

- `src/lib/` — auth, config, CLI, quota state, session tokens, pricing, formatting (120 modules)
- `src/providers/` — per-provider quota integrations
- `src/tui.tsx` + `src/quota-zh-sidebar.tsx` — TUI pair, shipped raw (unbuilt TSX)
- `tests/` — 179 offline test files + fixtures + contributing/provider-template
- `scripts/` — build/gate scripts (build-dev.mjs, build-runtime.mjs, capture-runtime-golden.mjs, release verifiers)
- `dist/` — committed runtime output, regenerated only by `build-runtime.mjs --check`
- `dev-dist/` — gitignored dev build via `tsconfig.json`; never touches dist

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Plugin wiring, slash commands | `src/index.ts`, `src/plugin.ts` | module id, command registration, toast/alerts |
| Auth / config / CLI / state | `src/lib/` | `opencode-*.ts`, `quota-*.ts`, `session-tokens.ts`, `token-cost.ts`, `config.ts`, `cli-show.ts`/`cli-status.ts` |
| Provider quota logic | `src/providers/` | one subdir per provider; mirrors `src/lib/*-auth.ts` / `*config.ts` |
| TUI behavior | `src/tui.tsx`, `src/quota-zh-sidebar.tsx` + `src/lib/tui-*.ts` | raw TSX; lib modules hold logic so TUI stays buildable |
| Pricing / snapshot | `src/lib/modelsdev-pricing.ts`, `src/lib/quota-snapshot.ts` | price refresh, snapshot health, 未定价 handling |
| Tests by area | `tests/lib.*.test.ts`, `tests/providers.*.test.ts`, `tests/tui-*.test.ts`, `tests/plugin.*.test.ts` | offline only |
| Reproducibility gates | `scripts/build-runtime.mjs --check`, `scripts/capture-runtime-golden.mjs` | dist byte-compare, golden fixture capture |
| Upstream pin | `UPSTREAM-PROVENANCE.md`, `upstream-provenance.json` | sha256 must match table for upstream v4.4.1 |

## CONVENTIONS

- **Offline test discipline**: `tests/setup.ts` force-blocks `fetch` + `node:http/https/net/tls/dns`. Tests restore network per-test via `vi.stubGlobal`; `afterEach` resets pricing snapshot, timers, envs, globals, and mocks.
- **`dist/` is committed runtime output**: regenerate only via `scripts/build-runtime.mjs` (extends `tsconfig.runtime.json`, excludes TUI TSX, copies pricing JSON + raw TUI TSX). `--check` byte-compares to committed output. `dev-dist/` (`tsconfig.json`) is a throwaway dev build.
- **Three tsconfigs**: `tsconfig.json` (dev), `tsconfig.runtime.json` (runtime, extends, excludes TUI TSX), `tsconfig.upstream.json` (declaration/sourceMap mirror for upstream sync).
- **Golden tests are pinned**: `runtime-golden.test.ts` locks Chinese v1.0.1 behavior to dist-captured fixtures (pinned clock + TZ Asia/Shanghai); `baseline-boundary.test.ts` pins upstream v4.4.1 to commit 73dfcf1a… and asserts dev-dist never mutates runtime dist.
- **Upstream test files**: `upstream-plugin-*.test.ts` (10) are retained byte-for-byte but excluded from the local baseline (`vitest.config.ts`); `vitest.config.upstream.ts` is reference-only, never executed. `contributing/provider-template/` is a template, not part of the baseline.
- **This plugin owns the bundle's only formatter config**: `.prettierrc.json` (semi, double quotes, trailingComma all, printWidth 100). Format any edited file here.
- **No CONTEXT.md here**: domain terms come from root `CONTEXT.md` and this plugin's `README.zh.md`.
- Driven from root: `npm run build:quota-zh`, `build:quota-zh:runtime`, `typecheck:quota-zh`, `test:quota-zh`, `check:quota-zh`.

## ANTI-PATTERNS (plugin-specific)

- Never treat `dev-dist/` as the source of runtime `dist/`; never run the dev build as if it were released output.
- Never run tests that hit the network; the offline boundary is enforced by `tests/setup.ts` and `baseline-boundary.test.ts`.
- Never hand-edit `dist/`, pricing JSON copies, or golden fixtures; edits are lost and break byte-reproducibility gates.
- Do not display unpriced models as `$0`; show 未定价 while keeping token counts.
- Never edit `UPSTREAM-PROVENANCE.md` or `upstream-provenance.json` to match a build; update the actual upstream and regenerate.
