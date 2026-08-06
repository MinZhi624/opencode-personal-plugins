# OpenCode Matt Workshop

An OpenCode adapter that presents Matt Pocock's engineering workflows through a small workshop of coordinated agents. It keeps workflow knowledge distinct from agent responsibilities and orchestration.

## Product Language

**Workshop**:
The complete set of adapted workflows, roles, and routing rules provided by this project.
_Avoid_: agent pack, agent team

**Workflow Skill**:
A reusable method for carrying out a kind of work, sourced from the Matt Pocock skills collection.
_Avoid_: agent, role, prompt

**Promoted Skill**:
A Workflow Skill that Matt's upstream plugin includes in its supported release set.
_Avoid_: bundled skill, selected skill

**OpenCode Adapter**:
The project-owned layer that connects Workflow Skills to Workshop roles and OpenCode behavior without redefining the skills' methods.
_Avoid_: fork, runtime

**Orchestrator Lite**:
Session-bound coordination that delegates through OpenCode without owning a durable task runtime.
_Avoid_: agent team, workflow engine

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

**Issue**:
A single tracked unit of implementation work in the configured Issue tracker.
_Avoid_: ticket, task card

**Decision ticket**:
A Wayfinder Issue whose result is a decision rather than an implementation deliverable.

**Write Set**:
The exclusive set of paths assigned to a Maker for one Delegable Slice.
_Avoid_: file list, ownership list

**Parallel Wave**:
A group of unblocked Delegable Slices whose Write Sets do not overlap and can therefore be implemented concurrently.
_Avoid_: batch, agent swarm

**Issue Result**:
The implementation changes, verification evidence, and disclosed risks returned for one Issue or equivalent Delegable Slice.
_Avoid_: worker response, completion message

**Acceptance Gate**:
The Foreman's checks that determine whether an Issue Result is fit to commit.
_Avoid_: final review, approval step

## Relationships

- The Workshop contains Primary Agents, Worker Agents, and Workflow Skills.
- A Primary Agent may delegate bounded work to a Worker Agent.
- The Drafter turns unclear intent into Ready Work or another appropriate outcome.
- The Foreman turns Ready Work into accepted Issue Results.
- The Tinker completes Quick Changes without creating an implementation flow.
- An Issue may define one Delegable Slice for a Maker.
- A Maker completes one Delegable Slice at a time.
- A Parallel Wave contains Delegable Slices with mutually exclusive Write Sets.
- An Issue Result must pass the Acceptance Gate before the Foreman accepts it.
