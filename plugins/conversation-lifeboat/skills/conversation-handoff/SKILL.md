---
name: conversation-handoff
description: Update durable project specifications and continue transient execution context in a fresh Codex task after the user confirms migration from a long, slow, repeatedly compacted, oversized, or unstable conversation. Preserve the user's original wording and language. Also use for an explicitly requested context-preserving task handoff. Use spec-update for in-place specification refreshes without task creation.
---

# Conversation Handoff

Keep durable project intent and approved project-level TODOs in repository-owned specifications, and carry conversation-specific continuation state in the fresh task's starter prompt. Never turn `.agents` into a transcript, task log, or queue of immediate handoff steps.

For a specification update that must remain in the current task, use `$spec-update` instead.

## Authorization boundary

- Treat an explicit user request to migrate, hand off, or continue in a new task as authorization.
- A health warning by itself is not authorization. Ask once and wait for the user's confirmation.
- Do not delete, truncate, rewrite, or relocate the old transcript.
- Do not archive the old task until the new task exists. Archive it only when the user requested that action.

## Artifact boundary

- Project specifications are durable contracts for any future maintainer or AI: project purpose, user-approved requirements, invariants, acceptance criteria, stable architecture decisions, approved but unfinished project goals or TODOs, and links to prohibited approaches.
- The fresh-task starter prompt owns transient continuation state: the current request, working-tree state, work completed in this conversation, the exact interruption point, validation results, open execution questions, and the next concrete action.
- Never write task IDs, transient branch dirtiness, raw diffs, recent command logs, or the immediate next implementation step into a project specification merely to support a handoff.
- Distinguish a durable project TODO from a handoff step by asking whether it would still matter if another maintainer started from a clean checkout later. Durable outcome-level work belongs in `active/`; conversation-specific sequencing belongs in the starter prompt.
- A durable source-path map may remain in a project specification when it explains the architecture rather than the current task's progress.

## Language fidelity

- Detect the language of the user's current request and use it for the project-specification update, the starter prompt, and user-facing handoff messages.
- Preserve user-authored requirement text verbatim whenever it is copied. Do not translate, anglicize, normalize terminology, or replace the original wording with an English paraphrase.
- If a concise structured restatement is useful, keep the untouched original text first and clearly label the restatement as interpretation in the same language.
- Preserve intentionally mixed technical identifiers such as component names, APIs, file paths, and code exactly as written.

## Handoff workflow

1. Identify the repository root, current working directory, active branch, worktree state, and the applicable `AGENTS.md` files.
2. Read [the specification lifecycle](references/spec-lifecycle.md). Create missing lifecycle directories without removing existing project conventions.
3. Inspect every applicable `AGENTS.md` and only the conversation material, repository files, diffs, and validation results needed to separate durable project contracts from transient continuation state. Prefer recent user decisions and observed repository state over stale plans.
4. Reconcile every applicable `AGENTS.md` using the extraction rules in the lifecycle reference. Classify its substantive content, move specification-owned material to the smallest appropriate lifecycle document, and replace migrated detail with concise specification entry links. Do not remove a statement until its destination exists and preserves the statement's force and scope.
5. Read relevant documents under `.agents/notes/prohibited/`. If a repository still uses `.agents/notes/rejected/`, treat it as a legacy alias for prohibited approaches.
6. Create or update the smallest applicable active project specification under `.agents/notes/active/` using [the project-specification and starter-prompt templates](references/handoff-template.md). Use `kind: project-specification`, a stable descriptive filename, and the user's language. Do not create a `conversation-handoff` document.
7. Leave each applicable `AGENTS.md` as a compact instruction and navigation layer: retain durable cross-task rules and material that no specification covers, plus links telling future agents where to read active and prohibited specifications. Do not duplicate specification detail there. Create a nested `AGENTS.md` only for durable rules that apply to that directory across future tasks.
8. Verify the project specifications as durable documentation: a new maintainer must be able to understand the project's purpose, constraints, and approved unfinished outcomes without inheriting stale conversation state. Confirm that extracted `AGENTS.md` instructions remain discoverable with unchanged scope.
9. If the current host exposes a task-creation tool, create a new task in the same project after the specification is saved. Preserve the existing checkout when uncommitted changes must remain visible; otherwise follow the host's normal worktree behavior.
10. Build the fresh task's starter prompt in the user's language. Include the user's current requirement in its original wording, the relevant specification paths, current working-tree state, completed and remaining work, validation status, material open questions, and one concrete first action. Do not paste the full project specification.
11. Seed the new task with that starter prompt. If task creation is unavailable, return the exact specification paths and the ready-to-paste prompt unchanged.

## Quality requirements

- Keep confirmed requirements, durable decisions, and project-level unfinished goals in specifications; keep the current conversation's execution state, interruption point, and immediate next action in the starter prompt.
- Verify that quoted user requirements and the starter prompt retain the user's original language.
- Record rejected implementation attempts only when evidence shows why they failed. State the safe alternative.
- Link to large images, generated assets, and logs by path; summarize their relevance instead of embedding or duplicating them.
- Never claim a check passed unless its command or observed result is recorded.
- Prefer `superseded/` over a generic archive for specifications that were once valid but have been replaced. Rely on version control for ordinary history.
