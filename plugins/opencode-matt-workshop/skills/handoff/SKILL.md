---
name: matt-handoff
description: "Use ONLY when the user explicitly requests this workflow in natural language or by name; a suggestion from another skill does not count. Compact the current conversation into a handoff document for another agent to pick up."
slash: false
---

## OpenCode Adapter

Workflow references in this text name Workshop Workflow Skills by their exact ID. Describe what you need in natural language; the skill descriptions decide when a skill fires, and an exact ID is never required to start a flow. Load a skill with the native skill tool by ID — no Workshop slash commands are registered. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
