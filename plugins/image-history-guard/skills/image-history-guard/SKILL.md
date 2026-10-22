---
name: image-history-guard
description: Enable, upgrade, inspect, or disable a local Codex proxy that keeps first images stable and references duplicates across turns within an isolated conversation. Use for historical-image replay problems or explicit Image History Guard requests, not ordinary image generation.
---

# Image History Guard

The standalone npm package and command are both `image-history-guard`. Requires Node 22+ and npm. Use an installed CLI or `npx --yes image-history-guard@latest <command>`. The plugin bundles the same controller at `../../scripts/guard.cjs`; install its locked dependencies with `npm ci --ignore-scripts --no-audit --no-fund` if using that copy. The legacy `chatgpt-gloves` npm package is unrelated and frozen.

## Behavior and boundaries

The first structured inline image is kept at its original location and labelled with a stable SHA-256 ID and absolute local copy path. Later byte-identical images become references only within the same verified thread and account scope. Full replays deterministically retain the first original; incremental references require an observed successful ancestor response. Missing/conflicting identifiers, unknown lineage, worker failures, failed requests, and compaction do not authorize borrowing images from another context. Never use session-id, prompt_cache_key, turn IDs or sockets as a conversation identity.

The model can reload a labelled image with the existing `view_image` tool using its exact local path. Explicit view_image reload outputs are retained, even when the image was previously seen. When pixels are unavailable, reload before making new visual judgments rather than guessing from an ID. No new tool schemas are injected. This plugin does not guarantee that a model will obey recovery instructions, preserve server KV state, remove distinct historical images, or prevent the first image being uploaded in a full replay.

Original transcripts and model responses are never rewritten. Decoded image copies now persist locally under the plugin data `images` directory: at most 256 MiB/512 images, 32 MiB per image, approximately seven days, with eviction. These are ordinary user files, not encrypted storage or an access-control boundary against other tools running as the same user. Credentials and raw prompts are not stored. Evicted blobs cause fallback to supplied originals; existing references may need the user to reattach an image if the original is no longer available anywhere.

## Operations

- `status` reports CLI, selected runtime and running service versions, manual stop state, pending recovery, worker readiness, counts and observed usage. A running listener with workerFiltering=false is not a functioning image filter. Never dump config/state, capability URLs, auth headers, request contents, image hashes or image paths into chat.
- On an explicit enable request, use `enable`. It backs up config and adds a marked built-in OpenAI provider base URL, refusing existing provider overrides. Restart Codex after first enable. `start` reuses or restores the selected runtime; a newer CLI never silently switches a running version.
- `upgrade` downloads the latest npm CLI and prepares its immutable runtime before asking to interrupt existing requests. `--local` selects this CLI's bundled runtime without another registry lookup. Updating marketplace files alone does not replace the running service.
- `upgrade`, `restart` and `stop` ask for terminal confirmation; cancellation keeps the selected runtime, configuration and running service unchanged. Use `--yes` when the user's existing authorization covers that interruption; do not ask them to confirm again merely because the CLI supports confirmation. Without authorization, let the user run the interactive command. Noninteractive calls without `--yes` refuse to proceed.
- Confirmed replacement stops current and recorded legacy listeners through authenticated endpoints, waits for their processes to exit, and only then starts the selected version at the same address. Never kill processes by saved PID. A shared operation lock and service lifetime lock prevent concurrent managed instances per Codex home. Replacement failure attempts rollback; an interrupted transaction is recovered on the next managed operation. An unresolved stop/recovery refuses to start another service.
- `stop` leaves routing configured and records manual stop so hooks do not undo it; model requests need an explicit `start` before they can use that route again. `restart` restarts the selected runtime, while `upgrade` selects the latest npm runtime. `disable` removes only managed routing; restart Codex to return to its default route, then optionally stop the proxy.
- The reviewed SessionStart hook calls `start --hook` only for an already-enabled installation. It never enables routing, upgrades, installs dependencies, asks questions, or grants trust; it respects manual stop. Legacy listener records require an explicit confirmed upgrade instead of automatic termination.
- `--codex-home <absolute-directory>` selects another home only when requested. Default is CODEX_HOME, then ~/.codex.

Require a running status before claiming activation. Compare input/cached token usage across multiple turns before claiming cost or quota savings; reduced upload bytes alone proves neither. A local mock test is not a live inference test. Never install a certificate authority, read auth.json, modify original transcripts or silently trust hooks to operate this plugin.

## Native tool failures

Only exact Responses image inputs are candidates for rewriting; native image generation/editing, web tools, unknown routes and other HTTP methods stream to the same fixed upstream unchanged. A tool 404 is not evidence that an API key is missing. Check route compatibility and worker status before proposing an API/CLI fallback. Do not claim cloud image generation was verified from a mock routing test.

Worker failures and timeouts have bounded automatic recovery and privacy-filtered lifecycle logs under the data diagnostics directory. During recovery the proxy passes originals through. Read only fixed diagnostic metadata. The 0.3 lifecycle preserves the current endpoint during replacement, but clients caching a historical endpoint from earlier multi-listener upgrades still need a restart. In-flight requests and WebSockets can reconnect during a confirmed service replacement.
