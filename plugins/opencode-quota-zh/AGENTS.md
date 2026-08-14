# AGENTS.md — opencode-quota-zh

## OVERVIEW

Largest bundle plugin: server + TUI quota, token-usage, and API list-price estimation. Entry `src/index.ts` exports `{id: "@local/opencode-quota-zh", server: QuotaToastPlugin}`; `src/plugin.ts` implements it (slash commands /quota, quota providers, alerts); `src/tui.tsx` + `src/quota-zh-sidebar.tsx` are the TUI pair; `src/bin/opencode-quota.ts` is the `show`/`status` CLI.

## STRUCTURE

- `src/lib/` — auth, config, CLI, quota state, session tokens, pricing, formatting (120 modules)
- `src/providers/` — per-provider quota integrations
- `src/tui.tsx` + `src/quota-zh-sidebar.tsx` — TUI pair, shipped raw (unbuilt TSX)
- `scripts/` — build/gate scripts (build-dev.mjs, build-runtime.mjs, release verifiers)
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
| Reproducibility gates | `scripts/build-runtime.mjs --check` | dist byte-compare |
| Upstream pin | `UPSTREAM-PROVENANCE.md`, `upstream-provenance.json` | sha256 must match table for upstream v4.4.1 |

## CONVENTIONS

- **No automated tests**: this plugin has no test suite and no vitest. Verification is manual — restart OpenCode and check `/quota`, `/quota_status`, TUI sidebar, and config migration by hand. Do not add a test framework or re-add tests.
- **`dist/` is committed runtime output**: regenerate only via `scripts/build-runtime.mjs` (extends `tsconfig.runtime.json`, excludes TUI TSX, copies pricing JSON + raw TUI TSX). `--check` byte-compares to committed output. `dev-dist/` (`tsconfig.json`) is a throwaway dev build.
- **Two tsconfigs**: `tsconfig.json` (dev), `tsconfig.runtime.json` (runtime, extends, excludes TUI TSX). (`tsconfig.upstream.json` is a reference-only upstream mirror.)
- **This plugin owns the bundle's only formatter config**: `.prettierrc.json` (semi, double quotes, trailingComma all, printWidth 100). Format any edited file here.
- **No CONTEXT.md here**: domain terms come from root `CONTEXT.md` and this plugin's `README.zh.md`.
- Driven from root: `npm run build:quota-zh`, `build:quota-zh:runtime`, `typecheck:quota-zh`, `check:quota-zh`.

## ANTI-PATTERNS (plugin-specific)

- Never treat `dev-dist/` as the source of runtime `dist/`; never run the dev build as if it were released output.
- Never hand-edit `dist/`, pricing JSON copies, or golden fixtures; edits are lost and break byte-reproducibility gates.
- Do not display unpriced models as `$0`; show 未定价 while keeping token counts.
- Never edit `UPSTREAM-PROVENANCE.md` or `upstream-provenance.json` to match a build; update the actual upstream and regenerate.
