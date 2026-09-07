# Specification update formats

Use the repository's existing frontmatter when it expresses the same lifecycle. Otherwise use these compact fields and keep the body specific to the project.

## Active specification

```md
---
status: active
kind: project-specification
updated_at: <ISO date>
modules:
  - <module>
supersedes: []
---
```

Keep confirmed requirements, observed implementation state, decisions, verification, prohibited constraints, remaining work, and the next action current. Do not duplicate logs or large diffs.

## Implemented specification

Before moving the existing document from `active/` to `implemented/`:

- set `status: implemented`;
- add `completed_at: <ISO date>`;
- record the verification supporting completion;
- remove or resolve remaining work and material open questions.

Do not create a second copy. Move the updated document so there is one authoritative lifecycle state.

## Superseded specification

Before moving the old document from `active/` to `superseded/`:

- set `status: superseded`;
- add `superseded_at: <ISO date>`;
- add `superseded_by: <repository-relative path>`.

In the replacement specification, list the old repository-relative path under `supersedes`. Preserve the old document because its rationale may still constrain future work.

## Prohibited approach

Create one focused note per independently reusable warning:

```md
---
status: prohibited
kind: prohibited-approach
recorded_at: <ISO date>
scope:
  - <module or path>
reopen_only_if: <evidence or explicit decision required>
---

# <Approach that must not be repeated>

## Attempted approach

Describe the implementation precisely enough to recognize it later.

## Evidence

Link the failing test, log, diff, issue, or explicit user decision. Separate observed facts from inference.

## Why it is prohibited

State the concrete failure, risk, or waste.

## Required alternative

State the safe direction, or the evidence required before reconsideration.
```

Link the note from affected active specifications. Do not use `prohibited/` as a general decision log.
