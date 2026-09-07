---
name: conversation-handoff
description: Create a durable project specification, extract specification-specific content from AGENTS.md, and continue work in a fresh Codex task after the user confirms migration from a long, slow, repeatedly compacted, oversized, or unstable conversation. Also use when the user explicitly requests a context-preserving task handoff. Use spec-update instead for an in-place specification refresh without task creation.
---

# Conversation Handoff

Move useful project state into repository-owned documentation, then start a clean task from that documentation. Never copy the entire transcript into the new task.

For a specification update that must remain in the current task, use `$spec-update` instead.

## Authorization boundary

- Treat an explicit user request to migrate, hand off, or continue in a new task as authorization.
- A health warning by itself is not authorization. Ask once and wait for the user's confirmation.
- Do not delete, truncate, rewrite, or relocate the old transcript.
- Do not archive the old task until the new task exists. Archive it only when the user requested that action.

## Handoff workflow

1. Identify the repository root, current working directory, active branch, worktree state, and the applicable `AGENTS.md` files.
2. Read [the specification lifecycle](references/spec-lifecycle.md). Create missing lifecycle directories without removing existing project conventions.
3. Inspect every applicable `AGENTS.md` and only the conversation material, repository files, diffs, and validation results needed to reconstruct the current implementation state. Prefer recent decisions and observed repository state over stale plans.
4. Reconcile every applicable `AGENTS.md` using the extraction rules in the lifecycle reference. Classify its substantive content, move specification-owned material to the smallest appropriate lifecycle document, and replace migrated detail with concise specification entry links. Do not remove a statement until its destination exists and preserves the statement's force and scope.
5. Read relevant documents under `.agents/notes/prohibited/`. If a repository still uses `.agents/notes/rejected/`, treat it as a legacy alias for prohibited approaches.
6. Write one active handoff specification under `.agents/notes/active/` using [the handoff template](references/handoff-template.md). Use a stable descriptive filename; add a date only when it prevents ambiguity.
7. Leave each applicable `AGENTS.md` as a compact instruction and navigation layer: retain durable cross-task rules and material that no specification covers, plus links telling future agents where to read active and prohibited specifications. Do not duplicate specification detail there. Create a nested `AGENTS.md` only for durable rules that apply to that directory across future tasks.
8. Verify the handoff against the working tree. It must identify uncommitted changes, completed work, remaining work, validation status, relevant prohibited approaches, one concrete next action, and evidence that extracted `AGENTS.md` instructions remain discoverable with unchanged scope.
9. If the current host exposes a task-creation tool, create a new task in the same project after the specification is saved. Preserve the existing checkout when uncommitted changes must remain visible; otherwise follow the host's normal worktree behavior.
10. Seed the new task with a short prompt that tells it to read the applicable `AGENTS.md`, the exact handoff specification, relevant prohibited notes, and then execute the stated next action. Do not paste the full specification into the prompt.
11. If task creation is unavailable, return the exact specification path and a ready-to-paste starter prompt instead.

## Quality requirements

- Separate confirmed requirements, observed state, inferences, and open questions.
- Record rejected implementation attempts only when evidence shows why they failed. State the safe alternative.
- Link to large images, generated assets, and logs by path; summarize their relevance instead of embedding or duplicating them.
- Never claim a check passed unless its command or observed result is recorded.
- Prefer `superseded/` over a generic archive for specifications that were once valid but have been replaced. Rely on version control for ordinary history.
