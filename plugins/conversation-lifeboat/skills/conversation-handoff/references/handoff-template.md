# Project specification and starter prompt templates

## Durable project specification

```md
---
status: active
kind: project-specification
updated_at: <ISO date>
modules:
  - <module>
supersedes: []
---

# <Stable project or feature title in the user's language>

## <Project purpose>

Explain the durable purpose and intended outcome so a new maintainer can understand the governing direction.

## <Original user requirements>

Preserve copied user wording verbatim and in its original language. Use a quotation or clearly delimited block. Do not translate it.

## <Confirmed contract and acceptance criteria>

Record stable requirements, invariants, and observable acceptance criteria. Clearly distinguish any interpretation from the untouched user wording above.

## <Architecture and decisions>

Record only durable decisions and, when useful, a stable repository-relative source map.

## <Approved project TODOs>

List unfinished outcome-level work that remains part of the approved project scope. Express what the project must achieve, not which file or test the next conversation should open first.

## <Prohibited approaches>

Link relevant files under `.agents/notes/prohibited/` or legacy `.agents/notes/rejected/` and summarize their lasting constraint.
```

Do not include source task IDs, branch dirtiness, recent command output, completion logs, the current interruption point, open execution questions, or an immediate next action. Those belong only in the starter prompt. Approved project-level TODOs remain in the specification.

## Fresh-task starter prompt

Write this prompt in the user's language and keep quoted user text unchanged:

```md
请继续当前项目任务。先阅读 `<AGENTS.md path>`、`<active specification path>` 以及相关的禁止方案文档。

用户本次原始需求：
<verbatim user request>

当前执行状态：
- 已完成：<observed completed work>
- 工作区：<branch and relevant staged, unstaged, and untracked state>
- 已验证：<commands or observations and their results>
- 未完成：<remaining implementation and verification>
- 待确认：<only questions that can materially change implementation>

第一步：<one concrete action the fresh task can begin immediately>

请沿用用户当前使用的语言回复和记录需求；不得把上述原始需求翻译成另一种语言。
```

Keep the prompt compact enough to start work, but include enough observed state to continue safely. Reference large diffs, images, and logs by path instead of reproducing them.
