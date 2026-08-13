---
status: accepted
---

# Use a standalone native OpenCode Workshop

The Workshop registers its own Primary and Worker Agents through OpenCode's config hook and uses only native permissions, task delegation, visibility, and step ceilings. It does not depend on another agent bundle and does not implement a scheduler, worktree manager, command runner, Hook layer, or durable task runtime.

This supersedes the earlier command-only POC and the retained controlled-orchestration design. ADR 0001 remains accepted: the pinned upstream snapshot, explicit adapter patches, committed generated Skills, and bounded Runtime Distribution are still the reproducibility boundary.
