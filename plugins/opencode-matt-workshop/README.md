# OpenCode Matt Workshop

A local OpenCode adapter for all [Matt Pocock promoted Skills](https://github.com/mattpocock/skills), pinned to upstream `v1.2.2`. It provides three user-facing Primary Agents, four hidden Worker Agents, and process-local controlled Worker orchestration without adding a durable task runtime.

## Roles

| Agent | Mode | Purpose |
| --- | --- | --- |
| Drafter | Primary | Chooses and runs planning workflows while maintaining domain language |
| Foreman | Primary | Implements Ready Work and coordinates Maker slices through an Acceptance Gate |
| Tinker | Primary, default | Makes low-friction Quick Changes with inexpensive verification |
| Maker | Subagent | Implements one end-to-end Delegable Slice |
| Inspector | Subagent | Performs one independent review axis |
| Archivist | Subagent | Researches primary sources and writes one cited report |
| Surveyor | Subagent | Maps local code and conventions without editing |

## Local Project Setup

Install dependencies:

```bash
npm install
npm run check
npm run smoke
```

Reference the local TypeScript entry from a project's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-matt-workshop/src/index.ts",
      {
        "replace_builtin_agents": true,
        "max_parallel_makers": 2,
        "max_parallel_support": 6,
        "max_parallel_inspectors": 4,
        "max_parallel_archivists": 2,
        "max_parallel_surveyors": 2,
        "agents": {
          "drafter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "foreman": { "model": "openai/gpt-5.6-terra", "variant": "medium" },
          "tinker": { "model": "deepseek/deepseek-v4-flash", "variant": "max" },
          "maker": { "model": "deepseek/deepseek-v4-flash", "variant": "max" },
          "inspector": { "model": "deepseek/deepseek-v4-flash", "variant": "max" },
          "archivist": { "model": "openai/gpt-5.6-luna", "variant": "medium" },
          "surveyor": { "model": "deepseek/deepseek-v4-flash", "variant": "high" }
        }
      }
    ]
  ]
}
```

Model overrides are optional. Without them, every role inherits the surrounding OpenCode model. DeepSeek V4 Flash cannot accept image or PDF attachments; temporarily override the relevant role with an attachment-capable OpenAI model for visual work.

Quit and restart OpenCode after changing plugin configuration. OpenCode loads config-time files only at startup.

## Controlled orchestration

Foreman starts Maker only through `workshop_submit_slice`. A structured SliceSpec defines one Delegable Slice, its Write Set, Verification Plan, Test Budget, context references, Integration checkpoint, and hard budgets. Workshop creates a fresh Git worktree, returns a Task Handle, and prevents overlapping active Write Sets.

Maker returns a structured Ticket Result. `completed` means result-ready, not accepted. Foreman runs Gate Commands through `workshop_run_gate_command`, then explicitly accepts the Slice to create and integrate one checkpoint commit.

Inspector, Archivist, and Surveyor use the lighter `workshop_submit_assignment` contract and separate Support Worker concurrency. Direct Worker `task` and direct role `bash` are denied; role commands run through Workshop's controlled command tools.

Controlled commands use time, output, process-group, and systemd/cgroup resource controls. Unknown project commands are allowed; dangerous commands are denied and explicit external side effects ask once per operation. This is a reliability control, not a security sandbox. Controlled code-changing flows require Linux or WSL with a systemd user manager and cgroup v2.

Workshop v3 is the permission fact source. Remove machine-local plugins that overwrite Workshop role permissions after installation; a later config hook can still override OpenCode config after Workshop's own hook has run.

## Commands

The Workshop registers all 25 promoted Skills as same-name commands. Ten guarded commands persistently switch to the responsible Primary Agent: Drafter owns `/triage`, `/to-spec`, `/to-tickets`, and `/wayfinder`; Foreman owns `/implement`, `/tdd`, `/diagnosing-bugs`, `/prototype`, `/resolving-merge-conflicts`, and `/wizard`. The other commands run in the current Primary Agent. Tinker can load every Skill; other Primary Agents retain responsibility-specific permissions.

Run `/setup-matt-pocock-skills` only when a workflow needs Issue tracker, triage, or domain-layout configuration. Quick Changes and ordinary code exploration do not require repository setup.

## Upstream Sync

The complete raw upstream `v1.2.2` snapshot is stored under `vendor/mattpocock-skills/`; OpenCode loads generated adapter output under `skills/`. The snapshot and development records are tracked in Git but excluded from the installed Runtime Distribution.

```bash
npm run sync:matt-skills
npm run check:matt-workshop
```

The sync fails when a compatibility patch no longer matches its expected upstream anchor. Review upstream changes rather than weakening the check.

## Architecture

- [Domain language](./CONTEXT.md)
- [2.0 implementation handoff](./docs/implementation/2.0-foreman-handoff.md)
- [Architecture decisions](./docs/adr/)

This is an unofficial OpenCode adapter. Matt Pocock's vendored skills retain their upstream MIT license and recorded provenance.

## Related

- [Bundle main README](../../README.md) — OpenCode 中文插件整合包（本插件是其中一部分）
