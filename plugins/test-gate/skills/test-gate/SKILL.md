---
name: test-gate
description: Keep non-interactive automated tests, benchmarks, E2E suites, and acceptance suites out of Codex turns and hand them to the local Test Gate panel. Use after code changes need automated validation. Do not use this restriction for interactive browser or UI inspection, Computer Use, screenshots, development servers, builds, linting, or type checking.
---

# Test Gate

Defer non-interactive automated tests to the local Test Gate runner so Codex never waits for or polls them.

## Boundary

- Do not run unit, integration, E2E, acceptance, regression, or benchmark suites through shell tools, wrappers, CI commands, subagents, or alternate runners.
- Do not retry, disguise, delegate, or split a command after the Test Gate hook blocks it.
- Do not poll a Test Gate job from the model.
- Continue interactive verification normally. Browser tools, Computer Use, clicking through a page, inspecting rendered UI, screenshots, visual comparisons, and accessibility inspection are explicitly allowed.
- Builds, development servers, linters, formatters, and type checks are outside Test Gate unless a project explicitly classifies one as a test in `.codex/test-gate.json`.

## Workflow

After implementation, perform any useful interactive UI verification directly. If non-interactive tests are relevant, call `open_test_gate` once with the current project root and tell the user which suites are available. The user can start, monitor, cancel, and copy results from that panel without keeping the Codex turn active.

When the user later asks Codex to analyze a completed Test Gate job, call `get_test_job_summary` once for the exact job id. Never call it repeatedly to wait for completion.

If Test Gate has no discovered suites, explain that it discovers common package scripts and project types, and that the project can define explicit suites in `.codex/test-gate.json`. Do not fall back to running the tests yourself.
