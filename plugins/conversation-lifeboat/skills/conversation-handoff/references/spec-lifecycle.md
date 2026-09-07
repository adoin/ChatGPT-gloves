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

## Suggested `AGENTS.md` contract

Add this only when the repository has no equivalent contract:

```md
## Specification lifecycle

- Before implementation, read the relevant files in `.agents/notes/active/` and `.agents/notes/prohibited/`.
- Treat `.agents/notes/proposed/` as unapproved proposals, not implementation requirements.
- Never repeat an approach recorded in `.agents/notes/prohibited/` or the legacy `.agents/notes/rejected/` unless the user explicitly reopens that decision.
- Move completed specifications to `.agents/notes/implemented/` only after their required verification passes.
- Put replaced-but-still-relevant specifications in `.agents/notes/superseded/`; use Git history for ordinary archival.
```
