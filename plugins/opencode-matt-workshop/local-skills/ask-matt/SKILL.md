---
name: ask-matt
description: Recommend a suitable Workshop method when the user asks how to approach a task or which skill to use.
---

# Choose a method

Recommend the smallest useful next step for the user's situation. A skill is a method, not a required pipeline; ordinary work can proceed directly in Tinker.

- Investigating a failure: diagnosing-bugs.
- Consulting primary sources: research.
- Discussing unsettled design decisions: grilling, optionally in Drafter.
- Implementing an agreed request or saved plan: implement, in Tinker or Foreman.
- Explicitly choosing test-first development: tdd.
- Requesting independent review: code-review.
- Requesting saved specifications or a task breakdown: to-spec or to-tickets, respectively; neither requires the other.
- Requesting continuity across sessions: handoff, only with the needed context.

Natural-language intent is sufficient; the user need not memorize skill IDs. Load a method when its trigger is satisfied. For optional heavy workflows—TDD, full independent review, parallel design alternatives, specs, or tickets—recommend rather than execute unless the user has requested that work. Do not repeatedly reconfirm an explicit choice.

Tinker is the general-purpose entry point and can delegate. Drafter focuses on planning without implementation. Foreman focuses on organizing collaboration while still implementing. Recommend a role when useful, but leave switching to the user. Role choice is not a quality or testing tier.
