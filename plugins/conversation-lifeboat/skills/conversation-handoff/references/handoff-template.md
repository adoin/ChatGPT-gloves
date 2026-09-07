# Handoff specification template

```md
---
status: active
kind: conversation-handoff
source_task: <task id or title when available>
created_at: <ISO date>
modules:
  - <module>
supersedes: []
---

# <Outcome-oriented title>

## Goal

Describe the user-visible or system outcome.

## Confirmed requirements

List only requirements the user approved.

## Current implementation state

Describe what exists now, with repository-relative file paths.

## Decisions and rationale

Record decisions that constrain future implementation and why they were made.

## Working tree state

Record the branch and relevant staged, unstaged, and untracked changes. Do not paste large diffs.

## Verification

List commands or observations and their results. Separate passed, failed, and not run checks.

## Prohibited approaches

Link relevant files under `.agents/notes/prohibited/` or legacy `.agents/notes/rejected/`, and summarize the applicable constraint.

## Remaining work

Use an ordered list only when sequence matters.

## Open questions

Include only questions that can materially change the implementation.

## Next action

State one concrete action the new task can begin immediately.
```

Keep the document self-contained but compact. Reference source files and artifacts instead of reproducing them.
