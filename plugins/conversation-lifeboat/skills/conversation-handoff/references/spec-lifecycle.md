# Specification lifecycle

Use the repository's existing convention when it is equally explicit. Otherwise use:

```text
.agents/notes/
|-- proposed/
|-- active/
|-- implemented/
|-- prohibited/
`-- superseded/
```

## Meanings

- `proposed/`: Unapproved ideas. They may be evaluated but must not be implemented as accepted requirements.
- `active/`: User-approved specifications currently guiding implementation. A conversation handoff belongs here.
- `implemented/`: Specifications whose required work and relevant verification are complete.
- `prohibited/`: Failed, unsafe, wasteful, or explicitly forbidden approaches that must not be repeated without the user reopening the decision.
- `superseded/`: Specifications that were once valid but were replaced by a newer specification. This is optional.

Do not create a generic `archived/` directory. Version control already preserves ordinary history. Use `superseded/` only when an obsolete specification must remain easy to discover because its replacement relationship matters.

## Legacy `rejected/`

When `.agents/notes/rejected/` already exists, treat its contents as prohibited unless the repository explicitly defines a different meaning. Do not silently rename or move those files during a handoff. Recommend migrating the name separately so the change remains reviewable.

## Reconcile `AGENTS.md` into specifications

During both a specification update and a conversation handoff, inspect every applicable `AGENTS.md` from the repository root to the working directory. Treat it as an instruction and navigation layer, not as the authoritative home for module specifications.

Classify each substantive statement before editing it:

- Keep repository-wide working agreements, safety boundaries, build or verification commands, coding conventions, and other durable instructions that apply across multiple specifications or future tasks.
- Keep a requirement or constraint that no durable specification currently covers. Do not discard it merely to make `AGENTS.md` shorter.
- Move approved but unfinished module behavior, acceptance criteria, implementation decisions, observed state, remaining work, and next actions to the smallest relevant document under `active/`.
- Move verified completed requirements to `implemented/`, but only with the completion evidence required by this lifecycle.
- Move deliberately replaced requirements or decisions to `superseded/` and create the required replacement links.
- Move evidenced failed, unsafe, wasteful, foolish, or explicitly forbidden approaches to focused notes under `prohibited/`. Preserve their mandatory force; do not soften them into background context.
- Move unapproved ideas to `proposed/`; never promote them to active requirements during extraction.

When one statement contains both a durable repository rule and specification-owned detail, split it without weakening either part. When classification is uncertain, retain the statement in `AGENTS.md` and report the ambiguity instead of guessing.

Migration must be lossless and ordered:

1. Create or update the destination specification first.
2. Preserve the original scope, strength, rationale, and evidence. Do not turn a requirement into commentary or a prohibition into an optional recommendation.
3. Add a repository-relative link from the nearest applicable `AGENTS.md` entry section to the destination or lifecycle directory.
4. Only then remove the duplicated detail from `AGENTS.md`.
5. Verify that following `AGENTS.md` from a fresh task leads to every governing active and prohibited document.

After reconciliation, an applicable `AGENTS.md` should contain only:

- durable instructions that are intentionally not owned by a specification;
- constraints not yet covered by any specification;
- a concise specification entry section that points to the lifecycle directories and tells agents which governing documents must be read.

Do not keep summaries of migrated module specifications in `AGENTS.md`; the links and reading contract are the entry point. Do not create an empty specification solely to remove useful instructions from `AGENTS.md`.

## Suggested `AGENTS.md` entry contract

Add or adapt this only when the repository has no equivalent contract:

```md
## Project specifications

- Before implementation, read the relevant files in `.agents/notes/active/` and `.agents/notes/prohibited/`.
- Treat `.agents/notes/proposed/` as unapproved proposals, not implementation requirements.
- Never repeat an approach recorded in `.agents/notes/prohibited/` or the legacy `.agents/notes/rejected/` unless the user explicitly reopens that decision.
- Move completed specifications to `.agents/notes/implemented/` only after their required verification passes.
- Put replaced-but-still-relevant specifications in `.agents/notes/superseded/`; use Git history for ordinary archival.
- Keep module requirements and implementation state in those specifications; keep this `AGENTS.md` for cross-task instructions, uncovered constraints, and specification entry links.
```
