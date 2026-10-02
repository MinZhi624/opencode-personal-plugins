---
name: implement
description: "Use ONLY when the user explicitly requests this workflow in natural language or by name; a suggestion from another skill does not count. Implement an agreed request, plan, or tickets when the user asks to proceed with implementation; no formal planning artifacts are required."
slash: true
metadata:
  opencode/autoinvoke: false
---

## OpenCode Adapter

Workflow references in this text name Workshop Workflow Skills by their exact ID. Describe what you need in natural language; the skill descriptions decide when a skill fires, and an exact ID is never required to start a flow. User-only skills are exposed through the native skill menu; other skills can be discovered as needed. Load skills by exact ID with the native skill tool. Workshop does not register a custom command executor. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.

# Implement

Read the requested scope and any supplied plan or tickets. Inspect relevant code and project instructions. Resolve factual uncertainties yourself; ask only about consequential unsettled owner decisions.

In Drafter, present the implementation handoff and ask the user to select Tinker or Foreman. Otherwise own the implementation and use native subagents when they provide clear benefit, with non-overlapping assigned write scopes. Work from the conversation when no persisted plan exists.

Implement the requested behavior in coherent increments. Preserve unrelated changes and avoid speculative refactors. Validate against the requirement using existing targeted checks and realistic integration evidence. Add focused tests only when useful without expanding test infrastructure; report environment blockers and seek agreement before verification becomes a separate project.

TDD, full independent review, parallel design alternatives, and generating specs or tickets are separate choices. Use them when the user explicitly requests the corresponding method, including in natural language; do not start them merely because implementation is underway. An explicit choice needs clarification only if its scope is unclear.

Finish with the delivered behavior, verification actually performed, and remaining risks or manual acceptance steps. Do not claim runtime acceptance from static checks alone. Save a handoff only when requested. Git mutations require the user's explicit request for the specific action.
