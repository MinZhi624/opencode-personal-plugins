# OpenCode Matt Workshop

An OpenCode adapter that presents Matt Pocock's engineering workflows through a small workshop of coordinated agents. It keeps workflow knowledge distinct from agent responsibilities and orchestration.

## Product Language

**Workshop**:
The standalone OpenCode plugin containing the adapted workflows, roles, and routing rules provided by this project.
_Avoid_: agent pack, agent team

**Workflow Skill**:
A reusable method for carrying out a kind of work, sourced from the Matt Pocock skills collection.
_Avoid_: agent, role, prompt

**Workflow Command**:
A user-facing slash entry that explicitly invokes one Workflow Skill. Every Promoted Skill has a Workflow Command even when it may also be invoked implicitly by an agent.
_Avoid_: skill, implicit invocation

**Guarded Workflow Command**:
A Workflow Command whose method would change a Primary Agent's defining strategy and therefore checks compatibility before execution. The Workshop keeps this category deliberately small.
_Avoid_: automatic agent switch, general command gate, privileged skill

**Promoted Skill**:
A Workflow Skill that Matt's upstream plugin includes in its supported release set.
_Avoid_: bundled skill, selected skill

**OpenCode Adapter**:
The project-owned layer that connects an unchanged Upstream Source Snapshot to Workshop roles and native OpenCode behavior through reproducible, explicit adaptations.
_Avoid_: OMO adapter, fork, runtime

**Upstream Source Snapshot**:
A reproducible, downstream-unmodified copy of one pinned upstream skills release used to generate and verify the Workshop's adapted skills. It is development input, not part of the Runtime Distribution.
_Avoid_: vendored product, bundled skills

**Development Knowledge Asset**:
A repository-tracked record used by maintainers and AI agents to preserve domain language, design rationale, development guidance, or lessons learned. It is not part of the Runtime Distribution.
_Avoid_: scaffolding, product documentation

**Runtime Distribution**:
The deliberately bounded set of files installed for users to run the Workshop. Development Knowledge Assets and Upstream Source Snapshots are excluded.
_Avoid_: repository, source tree

## Role Language

**Primary Agent**:
A user-facing Workshop role that owns the conversation and decisions about how work proceeds.
_Avoid_: entry agent, main agent

**Worker Agent**:
A Workshop role that completes a bounded assignment from a Primary Agent without taking ownership of the wider flow.
_Avoid_: specialist agent, child agent

**Worker Run**:
One bounded attempt by a Worker Agent that ends with either a result or a blockage report rather than continuing indefinitely.
_Avoid_: background job, durable task

**Drafter**:
The Primary Agent that sharpens intent, maintains domain language, and turns settled decisions into an implementation plan without executing it or choosing the user's next path.
_Avoid_: Planner, implementation agent

**Tinker**:
The default Primary Agent that implements Ready Work alone with Existing, Targeted, and Bounded Verification.
_Avoid_: Builder, quick agent

**Foreman**:
The Primary Agent that implements the main line of Ready Work and may delegate when parallelism or specialist capability provides clear leverage.
_Avoid_: Orchestrator, manager agent

**Maker**:
The Worker Agent that implements one bounded, end-to-end unit of work.

**Inspector**:
The Worker Agent that independently evaluates one review axis or develops one constrained design alternative.

**Archivist**:
The Worker Agent that investigates external primary sources and preserves cited findings.

**Surveyor**:
The Worker Agent that maps relevant code, conventions, and relationships in the current codebase.

## Work Language

**Quick Change**:
A clear, local, easily reversible change whose effect the user can inspect immediately.
_Avoid_: small task, trivial task

**Ready Work**:
Work whose objective, acceptance conditions, scope, and verification method are settled enough to implement without a new product or architecture decision.
_Avoid_: clear task, implementation-ready request

**Implementation Plan**:
The Drafter's decision-complete description of how Ready Work can be implemented, including scope, sequence, seams, risks, and bounded verification without executing the work or creating Tickets by default.
_Avoid_: specification, Ticket set, implementation

**Manual Transition**:
The user's explicit choice of the next Primary Agent or Workflow Skill after the Drafter signals readiness. The Workshop does not automatically change roles or start implementation.
_Avoid_: automatic routing, complexity-based switching

**Existing, Targeted, and Bounded Verification**:
Verification that reuses available project checks, focuses on the changed behavior, and stops before verification becomes a separate development effort.
_Avoid_: no verification, exhaustive verification

**TDD Agreement**:
The user's explicit choice, made while working with the Drafter, to use the TDD Workflow Skill together with the human-selected seams and behaviors it will cover.
_Avoid_: automatic TDD, agent-selected test design

**Role Boundary**:
A capability restriction that prevents a Primary Agent from violating its defining responsibility while leaving unrelated Workflow Skills available.
_Avoid_: complete skill allowlist, prompt-only convention

**Delegable Slice**:
A bounded, end-to-end portion of Ready Work that one Maker can implement and verify in a fresh context.
_Avoid_: task, technical slice

**Assigned Scope**:
The paths and behavior explicitly entrusted to one Maker in the shared working tree. Work outside it remains owned by the Foreman or another active Worker Agent.
_Avoid_: worktree, implicit ownership

**Delegation Leverage**:
The concrete benefit that justifies a Worker Run: independent work can proceed in parallel, or a Worker Agent is materially better suited to the assignment.
_Avoid_: role-based delegation, delegation by default

**Ticket**:
A tracker-independent unit of work. A Ticket may be represented by a local file or by a platform-specific Issue.
_Avoid_: task card, issue when no platform record is meant

**Issue**:
A platform record that represents a Ticket in an issue tracker using Issue terminology.
_Avoid_: generic work item, ticket synonym

**Decision Ticket**:
A Wayfinder Ticket whose result is a decision rather than an implementation deliverable.

## Relationships

- The Workshop contains Primary Agents, Worker Agents, and Workflow Skills.
- The Workshop registers Drafter, Tinker, and Foreman as its Primary Agents alongside OpenCode's built-in agents.
- The Workshop makes Tinker the default Primary Agent.
- A Workflow Command invokes one Workflow Skill; a Guarded Workflow Command requires the user to select a compatible Primary Agent.
- A Role Boundary blocks implementation from Drafter and delegation from Tinker; Foreman may delegate for parallelism or specialist capability.
- A Primary Agent may delegate bounded work to a Worker Agent.
- Every Worker Run has a finite iteration ceiling and stops early when repeated attempts produce no progress.
- The Drafter turns unclear intent into Ready Work or another appropriate outcome, then waits for a Manual Transition.
- The Drafter produces an Implementation Plan in the current session unless the user explicitly chooses a persistent spec-and-Ticket path.
- The Tinker implements Ready Work without delegating to Worker Agents.
- The Foreman implements Ready Work and delegates only for parallelism or specialist capability.
- The Foreman states the Delegation Leverage and Assigned Scope before starting a Worker Run.
- A Ticket may define one Delegable Slice for a Maker.
- A Maker completes one Delegable Slice at a time.
- A Maker changes only its Assigned Scope and reports overlap or conflict to the Foreman.
- Maker and Inspector are hidden Worker Agents available only through delegation.
- Archivist and Surveyor may also be selected directly by the user for bounded fact-finding.
- The implement Workflow Skill uses TDD only after a TDD Agreement and retains its explicit code-review step.
- The implement Workflow Skill runs without delegation in Tinker and permits leverage-based delegation in Foreman.
- Tinker performs the Standards and Spec review axes itself in /code-review; the implement Workflow Skill runs in Tinker without the review workflow. Foreman may run those axes through separate Inspector Worker Runs.
- A Workflow Skill that requires delegation or heavyweight review stops in Tinker and asks the user to select Foreman.
- Drafter may delegate read-only investigation or evaluation to Inspector, Archivist, and Surveyor, but never implementation to Maker.
