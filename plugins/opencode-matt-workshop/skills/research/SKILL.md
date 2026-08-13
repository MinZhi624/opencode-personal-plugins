---
name: research
description: "Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent."
---

## OpenCode Adapter

References such as `/tdd` name Workflow Skills. Slash commands are the user-facing entries. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.

Use Archivist for delegated external primary-source research. Tinker cannot delegate: it must ask the user to select Foreman or invoke visible Archivist directly.

When the active role can delegate, start one Archivist Worker Run with the full research brief and target Markdown report path. Otherwise stop and ask the user to invoke visible Archivist or select Foreman.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
