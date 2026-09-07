# ChatGPT Gloves repository instructions

This repository packages reusable Codex plugins and skills.

- Keep each plugin under `plugins/<plugin-name>/` with a valid `.codex-plugin/plugin.json`.
- Treat the GitHub-backed Codex marketplace as the only supported distribution channel. The published `chatgpt-gloves` npm package is a frozen legacy snapshot: do not bump, publish, or maintain it, and do not introduce a runtime dependency on it.
- Keep user-facing workflow judgment in a skill and deterministic lifecycle detection in a hook script.
- Hooks must fail open: monitoring failures must not block the user's prompt or tool call.
- Do not parse an entire transcript to determine health. Use file metadata and bounded tail reads because transcripts can be many gigabytes.
- Never silently install or trust hooks on another machine. Distribution must preserve Codex's hook review flow.
- Validate changed skills and plugins, and run focused tests for changed scripts.
