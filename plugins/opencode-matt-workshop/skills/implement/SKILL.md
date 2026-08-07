---
name: implement
description: "Use ONLY when the user explicitly invokes /implement. Implement a piece of work based on a spec or set of tickets."
---

## OpenCode Adapter

References such as `/tdd` name Workflow Skills. Agents load those methods through OpenCode's skill tool; slash commands are the user-facing entries. Use OpenCode's task tool for delegated agents.

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
