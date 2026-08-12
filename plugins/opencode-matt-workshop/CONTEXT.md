# OpenCode Matt Workshop

An OpenCode adapter that presents Matt Pocock's engineering workflows through a small workshop of coordinated agents. It keeps workflow knowledge distinct from agent responsibilities and orchestration.

## Product Language

**Workshop**:
The complete set of adapted workflows, roles, and routing rules provided by this project.
_Avoid_: agent pack, agent team

**Workflow Skill**:
A reusable method for carrying out a kind of work, sourced from the Matt Pocock skills collection.
_Avoid_: agent, role, prompt

**Workflow Command**:
A user-facing slash entry that explicitly invokes one Workflow Skill. Every Promoted Skill has a Workflow Command even when it may also be invoked implicitly by an agent.
_Avoid_: skill, implicit invocation

**Guarded Workflow Command**:
A Workflow Command whose effects can cross a code, Git, secret, or external-tracker boundary and therefore switches the session to the responsible Primary Agent before execution.
_Avoid_: high-risk command, privileged skill

**Promoted Skill**:
A Workflow Skill that Matt's upstream plugin includes in its supported release set.
_Avoid_: bundled skill, selected skill

**OpenCode Adapter**:
The project-owned layer that connects Workflow Skills to Workshop roles and OpenCode behavior without redefining the skills' methods.
_Avoid_: fork, runtime

**Upstream Source Snapshot**:
A reproducible, downstream-unmodified copy of one pinned upstream skills release used to generate and verify the Workshop's adapted skills. It is development input, not part of the Runtime Distribution.
_Avoid_: vendored product, bundled skills

**Development Knowledge Asset**:
A repository-tracked record used by maintainers and AI agents to preserve domain language, design rationale, development guidance, or lessons learned. It is not part of the Runtime Distribution.
_Avoid_: scaffolding, product documentation

**Runtime Distribution**:
The deliberately bounded set of files installed for users to run the Workshop. Development Knowledge Assets and Upstream Source Snapshots are excluded.
_Avoid_: repository, source tree

**Orchestrator Lite**:
Session-bound coordination that delegates through OpenCode without owning a durable task runtime.
_Avoid_: agent team, workflow engine

**Task Handle**:
The process-local control and observation interface for one controlled Worker run. It separates Task Run Status, result outcome, and acceptance.

**Task Run Status**:
The execution lifecycle of a controlled Worker run, independent of whether its work result is complete or accepted.

**Verification Plan**:
The Foreman's declared checks and evidence strategy for one Delegable Slice.

**Test Budget**:
The declared focused commands, permitted test paths, and bounded test additions for one Delegable Slice.

**Integration Branch**:
The temporary Git branch where the Foreman combines accepted Slice checkpoints before user-approved final integration.

## Role Language

**Primary Agent**:
A user-facing Workshop role that owns the conversation and decisions about how work proceeds.
_Avoid_: entry agent, main agent

**Worker Agent**:
A Workshop role that completes a bounded assignment from a Primary Agent without taking ownership of the wider flow.
_Avoid_: specialist agent, child agent

**Drafter**:
The Primary Agent that sharpens intent, maintains domain language, and helps the user choose a Workflow Skill path.

**Foreman**:
The Primary Agent that owns reliable implementation, coordinates Worker Agents, and accepts or rejects their results.

**Tinker**:
The default Primary Agent for low-friction, directly inspectable changes.

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

**Delegable Slice**:
A bounded, end-to-end portion of Ready Work that one Maker can implement and verify in a fresh context.
_Avoid_: task, technical slice

**Ticket**:
A tracker-independent unit of work. A Ticket may be represented by a local file or by a platform-specific Issue.
_Avoid_: task card, issue when no platform record is meant

**Issue**:
A platform record that represents a Ticket in an issue tracker using Issue terminology.
_Avoid_: generic work item, ticket synonym

**Decision Ticket**:
A Wayfinder Ticket whose result is a decision rather than an implementation deliverable.

**Write Set**:
The exclusive set of paths assigned to a Maker for one Delegable Slice.
_Avoid_: file list, ownership list

**Parallel Wave**:
A group of unblocked Delegable Slices whose Write Sets do not overlap and can therefore be implemented concurrently.
_Avoid_: batch, agent swarm

**Ticket Result**:
The implementation changes, verification evidence, and disclosed risks returned for one Ticket or equivalent Delegable Slice.
_Avoid_: worker response, completion message

**Acceptance Gate**:
The Foreman's checks that determine whether a Ticket Result is fit to commit.
_Avoid_: final review, approval step

## Relationships

- The Workshop contains Primary Agents, Worker Agents, and Workflow Skills.
- A Workflow Command invokes one Workflow Skill; a Guarded Workflow Command first switches to its responsible Primary Agent.
- A Primary Agent may delegate bounded work to a Worker Agent.
- The Drafter turns unclear intent into Ready Work or another appropriate outcome.
- The Foreman turns Ready Work into accepted Ticket Results.
- The Tinker completes Quick Changes without creating an implementation flow.
- A Ticket may define one Delegable Slice for a Maker.
- A Maker completes one Delegable Slice at a time.
- A Parallel Wave contains Delegable Slices with mutually exclusive Write Sets.
- A Ticket Result must pass the Acceptance Gate before the Foreman accepts it.
- A Task Handle becoming result-ready does not make its Ticket Result accepted.
- The Foreman defines the Verification Plan and Test Budget before submitting a Delegable Slice.
- Accepted Delegable Slices become checkpoint commits on the Integration Branch.
