---
name: image-history-guard
description: Enable, upgrade, inspect, or disable a local Codex proxy that keeps first images stable and references duplicates across turns within an isolated conversation. Use for historical-image replay problems or explicit Image History Guard requests, not ordinary image generation.
---

# Image History Guard

Use `../../scripts/guard.cjs`, resolved relative to this skill directory. Install locked dependencies in the plugin root with `npm ci --ignore-scripts --no-audit --no-fund` if missing. Requires Node 22+ and npm.

## Behavior and boundaries

The first structured inline image is kept at its original location and labelled with a stable SHA-256 ID and absolute local copy path. Later byte-identical images become references only within the same verified thread and account scope. Full replays deterministically retain the first original; incremental references require an observed successful ancestor response. Missing/conflicting identifiers, unknown lineage, worker failures, failed requests, and compaction do not authorize borrowing images from another context. Never use session-id, prompt_cache_key, turn IDs or sockets as a conversation identity.

The model can reload a labelled image with the existing `view_image` tool using its exact local path. Explicit view_image reload outputs are retained, even when the image was previously seen. When pixels are unavailable, reload before making new visual judgments rather than guessing from an ID. No new tool schemas are injected. This plugin does not guarantee that a model will obey recovery instructions, preserve server KV state, remove distinct historical images, or prevent the first image being uploaded in a full replay.

Original transcripts and model responses are never rewritten. Decoded image copies now persist locally under the plugin data `images` directory: at most 256 MiB/512 images, 32 MiB per image, approximately seven days, with eviction. These are ordinary user files, not encrypted storage or an access-control boundary against other tools running as the same user. Credentials and raw prompts are not stored. Evicted blobs cause fallback to supplied originals; existing references may need the user to reattach an image if the original is no longer available anywhere.

## Operations

- `node <script> status` reports running/enabled version, counts, bytes and token/cache usage observed from successful responses. Do not dump config, state, request bodies, auth headers, capability URLs, image hashes or image paths into chat.
- On an explicit enable/install request, run `node <script> enable`. It backs up config, starts a loopback proxy and adds a marked built-in OpenAI provider base URL. It refuses existing provider overrides; do not bypass that refusal or switch authentication.
- On an explicit update request, install the marketplace release, install its locked dependencies, then run `node <script> upgrade`. The new runtime starts on a new port and config is switched transactionally. The prior listener remains for already-running clients. Restart Codex to use the new route; do not terminate old clients or their listener automatically.
- The reviewed SessionStart hook restores only an already-enabled installation. It never enables routing, installs dependencies or grants trust. Without a trusted hook, run `node <script> start` before Codex after a reboot.
- To undo: `node <script> disable`, restart Codex, then optionally `node <script> stop`. Stop also shuts down retained prior listeners, so confirm that old Codex processes no longer need them. Disable removes only the managed entry and preserves intervening config edits.
- `--codex-home <absolute-directory>` selects another home only when requested. Default is CODEX_HOME, then ~/.codex.

Require a running status before claiming activation. Compare input/cached token usage across multiple turns before claiming cost or quota savings; reduced upload bytes alone proves neither. A local mock test is not a live inference test. Never install a certificate authority, read auth.json, modify original transcripts or silently trust hooks to operate this plugin.
