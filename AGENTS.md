# AGENTS.md

Verified against HEAD `5458333` (2026-09-15) + working tree. Re-verify entry points and config wiring before relying on them after any refactor commit.

## OVERVIEW

Chinese-localized OpenCode plugin bundle (`opencode-zh-bundle` v2.0.0), 4 independent plugins under `plugins/`, installed to `~/.config/opencode/opencode-zh-bundle/` by `install.sh` / `install.ps1`. Node >= 22.6, `type: module`, one shared root `node_modules`. **OpenCode is pinned to exactly 2.0.11** — the installer refuses any other version.

## WIRING (get this wrong and nothing loads)

- Server plugins are loaded from `~/.config/opencode/opencode.json(c)` key `plugins`; TUI plugins from `~/.config/opencode/cli.json` key `plugins` (schema `https://opencode.ai/v2/cli.json`). **`tui.json(c)` is dead — never re-add it.**
- Config points at the plugin **directory**, never at an entry file (2.0.11 rejects entry-file paths). The package's `exports["./tui"]` picks the TUI entry.
- Templates: `config/opencode.jsonc`, `config/cli.json`. v2 keys are plural (`plugins`/`agents`/`permissions`); permission actions are `shell`/`subagent`, not v1 `bash`/`task`.

| Plugin | Server entry | TUI entry | Build |
|---|---|---|---|
| `opencode-quota-zh` | `index.ts` → `dist/index.js` | `tui.ts` → `dist/tui-v2.tsx` (raw TSX, copied byte-for-byte) | compiled |
| `opencode-enhanced-sidebar-zh` | — | `tui.ts` → `src/tui-v2.tsx` (raw source) | none |
| `opencode-matt-workshop` | `index.ts` → `dist/src/index.js` | — | compiled |
| `gpt-reset-credits` | `index.ts` (raw TS) + `reset_credits.py` subprocess | — | none |

- **Build order gotcha:** `opencode-enhanced-sidebar-zh/src/tui-v2.tsx` imports `QuotaPanel` from `../../opencode-quota-zh/dist/tui-v2.tsx` — a cross-plugin import into a build artifact. Run `npm run build:quota-zh:runtime` before running/staging the sidebar.

## COMMANDS

```bash
npm run build:quota-zh:runtime   # real runtime build: tsc → dist/, copy pricing JSON, copy tui-v2.tsx raw
npm run build:quota-zh           # dev baseline ONLY → dev-dist/ (upstream diff; never ships)
npm run build:matt-workshop      # tsc → plugins/opencode-matt-workshop/dist
npm run typecheck:quota-zh       # tsc --noEmit
npm run stage:runtime            # THE verification gate: allowlist + required-file check, throws on violations
npm run sync:matt-skills         # regenerate skills/ + skill-manifest.json; --vendor first copies root skills-1.2.2/ into vendor/
```

- There are **no tests, lint, or CI by design** (deliberately removed). Verification = `typecheck:quota-zh` + `stage:runtime` + the manual checklist in `docs/V2_MANUAL_ACCEPTANCE.md`. Run `stage:runtime` after any change that affects plugin outputs.
- `npm install` at the root only. Never `npm install` inside a plugin dir; never `npm audit fix --force` (downgrades `@opencode/plugin` to an incompatible version).
- Generated, never hand-edited: `dist/`, `skills/`, `skill-manifest.json`, `runtime-stage/`, `dev-dist/`.

## CONFIG RELOAD

v2 reloads watched config and plugins. **Restart the OpenCode service only when unwatched local dependencies or build artifacts changed** — do not claim a restart is always required.

## QUOTA-ZH ARCHITECTURE

- `src/` tracks a **pinned upstream core** (`providers/`, auth, structured accounting, projection, cache, state codec). The Chinese layer is only display/cards, startup hint, historical session Token usage, API list-price estimation, and bundle install boundaries (ADR 0003). Don't fork upstream core behavior locally; sync by upstream commit.
- `enableToast` and `resetNotifications.enabled` default to `false`.
- ADR 0001's quota-alert system (`/quota_alerts`, `alerts.*`, Quota Alert Episode, danger thresholds, state files) was **deleted** by ADR 0003 — do not reintroduce it.
- Upstream `opencode-quota` and this zh version share a config namespace and **must not both be enabled**. No npm self-update, pnpm, tests, or CI (ADR 0003).
- Style: `plugins/opencode-quota-zh/.prettierrc.json` (semi, double quotes, trailingComma all, printWidth 100). The other plugins use **no-semicolon** style — match the file you edit; there is no root formatter config.

## DOMAIN INVARIANTS (use CONTEXT.md terms verbatim)

- Unknown price renders **未定价**, never `$0`.
- Cost source of truth is `api.client.session.messages()`. Never `api.state.session.messages()` (the TUI's ~100-message window) and never `message.cost` / `session.cost`.
- Truncated or failed aggregation must be flagged incomplete and must not silently overwrite a complete result or be shown as a total.
- Token buckets keep all five: input, output, reasoning, cache read, cache write. Each assistant message is priced by its own `provider/model`; no provider whitelist; history is recomputed against the current price snapshot.
- Estimates are API list prices, never actual billing (subscription/OAuth included).

## MATT-WORKSHOP

- 7 agents (primary: `drafter`, `tinker`, `foreman`; subagents: `maker`, `inspector`, `archivist`, `surveyor`) + 25 skills registered as commands. The plugin calls `editor.default("tinker")`.
- `opencode.jsonc` must keep placeholder definitions for all 7 agents; the plugin fills them via `agent.transform`. `options` is strict zod (`agents.<id>.{model,variant,temperature,steps}`) — unknown keys throw `WorkshopOptionsError`.
- `src/agents.ts` still uses v1 permission names; `src/index.ts` maps them (`bash`→`shell`, `task`→`subagent`, `todowrite`/`list`/`lsp` dropped). A new permission key is silently dropped unless added to that map.
- Guarded skills: `drafter` guards triage/to-spec/to-tickets/wayfinder; `foreman` guards implement/tdd/diagnosing-bugs/prototype/resolving-merge-conflicts/wizard.

## GPT-RESET-CREDITS

- Spawns `python3` (`py -3` on Windows); override with `OPENCODE_PYTHON` — the value must be the executable path only, no arguments. Requires Python >= 3.10.
- Redeem re-queries and compares `snapshot_key` + every card field; any mismatch returns `aborted_changed` and **never retries** (double-redemption guard).
- Never display `selection_key` / `snapshot_key`. Keep the query permission `allow` and the redeem permission `ask`. The access token reaches Python only via `OPENCODE_V2_ACCESS_TOKEN` for that single child process.

## ANTI-PATTERNS

- Committing or sharing `auth.json`, the session DB, API keys, or unchecked `opencode debug config` output.
- Adding a second `plugin` key to a JSON object instead of appending to the existing array.
- Editing generated artifacts (`dist/`, `skills/`, `skill-manifest.json`, `runtime-stage/`) — regenerated on the next build.
- Running the installer from a subdirectory of the target bundle dir (it aborts).

## WHERE TO LOOK

| Task | Location |
|---|---|
| Merge into an existing OpenCode config | `docs/MERGE_EXISTING_CONFIG.md` |
| Symptom → fix | `docs/TROUBLESHOOTING.md` |
| Decisions (toasts, namespace, upstream core) | `docs/adr/0001-0003*.md` |
| Manual acceptance checklist | `docs/V2_MANUAL_ACCEPTANCE.md` |
| Authoritative terminology | `CONTEXT.md`, `plugins/opencode-matt-workshop/CONTEXT.md` |
| Per-plugin docs | `plugins/*/README*.md` |

Dev-only, never read for context: `node_modules/`, `runtime-stage/`, `plugins/opencode-quota-zh/dev-dist/`, `teach/`, `docs/research/`, `.scratch/`, `.omo/`, `.codegraph`, vendor trees.
