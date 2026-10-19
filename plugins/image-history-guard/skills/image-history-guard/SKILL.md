---
name: image-history-guard
description: Enable, inspect, or disable a local Codex proxy that deduplicates identical inline images in full Responses requests. Use for repeated historical-image upload problems or explicit Image History Guard requests, not ordinary image generation.
---

# Image History Guard

Use the bundled `../../scripts/guard.cjs`, resolved relative to this skill directory. Install its locked dependencies in the plugin root with `npm ci --ignore-scripts --no-audit --no-fund` if they are missing. Requires Node 22+ and npm.

The filter retains the last occurrence of each byte-identical inline image within the current request's input. Earlier occurrences become stable hash references. It never rewrites rollouts or stores images or credentials. In incremental requests it deduplicates only the newly supplied items and preserves `previous_response_id`: it cannot remove server-retained images, nor does it prune distinct historical images. Do not promise that this fixes all of #28316 or eliminates repeated uploads across requests.

- For inspection, run `node <script> status`.
- When the user explicitly asks to enable or install this workaround, run `node <script> enable`. It backs up user config, starts a loopback proxy, and sets the built-in OpenAI provider's base URL. It refuses existing provider overrides. Do not bypass that refusal or switch authentication/provider. Report that Codex must restart to pick up the route.
- After a machine reboot, the bundled SessionStart hook can restore an already-enabled proxy after the user reviews/trusts it through Codex. It never enables routing or installs dependencies. If the hook is unavailable/untrusted, run `node <script> start` before Codex makes requests. No OS autostart service is installed. Status must show a running proxy before claiming it is active.
- To undo, run `node <script> disable` and restart Codex. This removes only the managed routing entry and preserves intervening config edits. Then `node <script> stop` can stop the remaining listener. Do not stop a listener still needed by another running Codex process.
- `--codex-home <absolute-directory>` selects another home only when the user asks. Default is `CODEX_HOME`, then `~/.codex`.

Report measurements from the local status command, distinguishing request bytes saved from model token usage. A successful local simulation does not establish that a real model has received or interpreted the filtered request. Check an actual request before claiming end-to-end success. Do not dump config, state files, request bodies, auth headers, proxy capability URLs, or image hashes into chat.

If routing breaks, disable the managed override and restart Codex to return to its previous route. Never modify the original transcript, trust new hooks, install a certificate authority, or read auth.json to operate this plugin.
