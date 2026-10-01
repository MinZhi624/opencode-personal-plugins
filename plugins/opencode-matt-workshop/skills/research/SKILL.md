---
name: research
description: "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent."
slash: false
---

## OpenCode Adapter

Workflow references in this text name Workshop Workflow Skills by their exact ID. Describe what you need in natural language; the skill descriptions decide when a skill fires, and an exact ID is never required to start a flow. Load a skill with the native skill tool by ID — no Workshop slash commands are registered. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.

Start one Archivist Worker Run with the full research brief and the target Markdown report path, and keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
