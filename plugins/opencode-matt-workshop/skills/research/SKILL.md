---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to a background agent.
---

## OpenCode Adapter

References such as `/tdd` name Workflow Skills. Agents load those methods through OpenCode's skill tool; slash commands are the user-facing entry points. Use OpenCode's task tool for delegated agents.

The calling Primary Agent delegates this work to Archivist and supplies one exact Markdown report path. Archivist does not delegate again.

Delegate the research to **Archivist** through OpenCode's task tool, so independent work can continue while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it only at the exact Markdown path supplied by the calling Primary Agent. If no path was supplied, return blocked instead of choosing one.
