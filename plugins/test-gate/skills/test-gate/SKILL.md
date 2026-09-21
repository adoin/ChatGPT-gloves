---
name: test-gate
description: Keep non-interactive automated tests, benchmarks, E2E suites, and acceptance suites out of Codex turns, require them to pass or be explicitly skipped before a new task begins, and hand execution to the local Test Gate panel. Use after code changes need automated validation. Do not use this restriction for interactive browser or UI inspection, Computer Use, screenshots, development servers, builds, linting, or type checking.
---

# Test Gate

Defer non-interactive automated tests to the local Test Gate runner so Codex never waits for or polls them.

When the shell hook blocks a test, Test Gate creates a completion gate for the current Codex task. Until the required suite passes or the user explicitly skips it, `UserPromptSubmit` rejects ordinary follow-up prompts before they reach the model. Do not attempt to work around that gate.

## Boundary

- Do not run unit, integration, E2E, acceptance, regression, or benchmark suites through shell tools, wrappers, CI commands, subagents, or alternate runners.
- Do not retry, disguise, delegate, or split a command after the Test Gate hook blocks it.
- Do not poll a Test Gate job from the model.
- Do not begin a separate feature or task domain while the current completion gate is pending, running, or failed.
- Continue interactive verification normally. Browser tools, Computer Use, clicking through a page, inspecting rendered UI, screenshots, visual comparisons, and accessibility inspection are explicitly allowed.
- Builds, development servers, linters, formatters, and type checks are outside Test Gate unless a project explicitly classifies one as a test in `.codex/test-gate.json`.

## Workflow

After implementation, perform any useful interactive UI verification directly. If non-interactive tests are relevant, call `open_test_gate` once with the current project root and `createCompletionGate: true`, then tell the user which suites are required. The tool-call hook records the task completion gate even though no shell test command was attempted. The user can start, monitor, cancel, and copy results from that panel without keeping the Codex turn active.

Use `createCompletionGate: false` when the user only wants to inspect the panel or when opening a gate that is already pending. Do not create a gate merely because the user is browsing Test Gate.

If the user sends a new request while a gate is unresolved, the prompt hook handles it before model invocation. The user-facing local control phrases are:

- `运行待处理测试` or `/test-gate run`: start the required suites locally without a model call;
- `测试状态` or `/test-gate status`: read the gate state without a model call;
- `跳过待处理测试` or `/test-gate skip`: explicitly resolve the gate as skipped without a model call;
- `打开 Test Gate` or `/test-gate open`: allow a narrowly scoped model turn that only opens the panel.

Do not reinterpret a skip: only the explicit control phrase or the dashboard's confirmed skip action resolves a gate without passing tests.

When the user later asks Codex to analyze a completed Test Gate job, call `get_test_job_summary` once for the exact job id. Never call it repeatedly to wait for completion.

If Test Gate has no discovered suites, explain that it discovers common package scripts and project types, and that the project can define explicit suites in `.codex/test-gate.json`. Do not fall back to running the tests yourself.
