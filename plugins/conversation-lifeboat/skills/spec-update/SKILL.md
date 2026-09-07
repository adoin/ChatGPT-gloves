---
name: spec-update
description: Update repository-owned project specifications at any time without creating a new task. Use when the user asks to refresh or snapshot the current specification, extract specification-specific content from AGENTS.md, record evidenced failed implementations as prohibited, or reconcile active specifications into implemented or superseded states. Use conversation-handoff instead when the user requests migration to a fresh task.
---

# Specification Update

Reconcile durable project specifications with the observed implementation state while remaining in the current task. Never create, fork, archive, navigate to, or switch tasks as part of this skill.

## Authorization boundary

- An explicit request to update, refresh, checkpoint, or reconcile specifications authorizes documentation edits and lifecycle-preserving file moves under the repository's specification directories.
- It does not authorize product-code changes, deletion of historical notes, or task creation.
- Record an approach as prohibited only when the conversation, repository, tests, logs, or user instruction provides concrete evidence that it failed, is unsafe or wasteful, or is explicitly forbidden.
- Do not classify an unchosen idea, ordinary tradeoff, or unsupported suspicion as prohibited.

## Update workflow

1. Identify the repository root, current branch, working-tree state, applicable `AGENTS.md` files, and the specification convention already in use.
2. Read [the shared specification lifecycle](../conversation-handoff/references/spec-lifecycle.md) and [the update formats](references/spec-update-formats.md). Preserve an equally explicit repository convention when one already exists.
3. Inspect every applicable `AGENTS.md`, the current specifications, relevant code and diffs, recent decisions, and recorded verification. Prefer observed repository state over stale narrative.
4. Reconcile every applicable `AGENTS.md` using the extraction rules in the shared lifecycle reference. Classify its substantive content, move specification-owned material to the smallest appropriate lifecycle document, and replace migrated detail with concise specification entry links. Do not remove a statement until its destination exists and preserves the statement's force and scope.
5. Reconcile the lifecycle as one specification update:
   - Create or update the smallest useful specification under `active/` for requirements that remain approved and incomplete.
   - Add a focused note under `prohibited/` for each newly evidenced failed, unsafe, wasteful, or forbidden implementation. Link it from every active specification it constrains.
   - Move an active specification to `implemented/` only when all of its required work is complete and its relevant verification has passed. Update its status metadata before moving it.
   - Move an active specification to `superseded/` when a newer specification deliberately replaces it. Cross-link both documents with `supersedes` and `superseded_by` metadata.
6. Treat an existing `rejected/` directory as a legacy prohibited source. Read and enforce it, but do not silently rename or move its contents.
7. Leave each applicable `AGENTS.md` as a compact instruction and navigation layer: retain durable cross-task rules and material that no specification covers, plus links telling future agents where to read active and prohibited specifications. Do not duplicate specification detail there.
8. Verify the result against the working tree. Confirm that migrated instructions remain discoverable with unchanged scope, current requirements remain discoverable, completion claims have evidence, replacement links resolve, and prohibited approaches include a safe alternative or reopening condition.
9. Report which files were created, updated, or moved and why, including what was extracted from each `AGENTS.md`. State verification that was not run. Remain in the current task.

## Classification rules

- `active` means approved and still governing unfinished work.
- `implemented` means finished and verified, not merely coded or believed complete.
- `superseded` means intentionally replaced, not abandoned, failed, or partially implemented.
- `prohibited` means must not be repeated without explicit reconsideration and supporting evidence.

When a specification contains both completed and incomplete requirements, keep it active and mark the completed portions in place unless splitting it would materially improve traceability.
