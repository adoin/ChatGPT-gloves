# Image History Guard

An opt-in loopback proxy for the default, ChatGPT-authenticated Codex OpenAI provider. Addresses a narrow part of [openai/codex#28316](https://github.com/openai/codex/issues/28316): duplicate inline images in the supplied request input. It retains the last occurrence of each byte-identical image and replaces earlier occurrences with stable references. Different PNG/JPEG encodings are different images; it does not decode pixels or recompress images.

## Use

Install this plugin from the ChatGPT Gloves GitHub marketplace. In its plugin root:

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/guard.cjs enable
node scripts/guard.cjs status
```

Restart Codex after enable. The controller copies its locked runtime to the user's plugin data directory so cache updates do not remove the running proxy. It changes only a marked `openai_base_url` entry at the top of user config, preserves a backup, and refuses an existing provider override. It does not read or retain authentication files; the client's existing headers are forwarded only to the configured official upstream.

Node 22+ and npm are required. `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are respected by upstream connections. System proxy settings are not auto-detected; configure the process environment if required. Review the bundled SessionStart hook through Codex's normal hook-trust flow: it only starts an installation whose managed route was already explicitly enabled. Without a trusted startup hook, run `node scripts/guard.cjs start` after a reboot, before using Codex. No OS autostart service is installed. If the proxy is stopped while routing points at it, Codex cannot connect; this is not a transparent fail-open network layer.

To roll back:

```text
node scripts/guard.cjs disable
```

Restart Codex, then optionally run `node scripts/guard.cjs stop`. Disable preserves other config edits and leaves the proxy alive for already-running clients. If the managed entry was edited, restore only that entry manually from the backup; do not overwrite unrelated newer config changes.

## Boundaries

- HTTP/SSE and WebSocket Responses requests are supported, as is HTTP `/responses/compact`. Model-catalog requests pass through. SSE and model output bytes are not transformed. Authentication errors, status codes and close codes are relayed without application-level retries.
- Only structured `input_image` data URLs inside user message `content` or function/custom-tool `output` arrays are eligible. Text, remote URLs, file IDs, serialized JSON strings, generated-image result items, encrypted content and tool definitions are unchanged.
- Incremental requests deduplicate only among the newly supplied items; `previous_response_id` stays unchanged. Removing old images from server-retained state would require replaying full context, which this version deliberately does not attempt. Distinct old images are not dropped. A single image replayed once in each successive request will still be sent each time. There is no cross-request image memory.
- No history or response rewriting, TLS interception, certificate installation, cross-request image cache, payload logging, or automatic hook trust. Status contains only aggregate byte/count metrics; image fingerprints exist only in the request being processed.
- HTTP compressed request bodies support gzip, deflate, Brotli and, on supporting Node versions, Zstandard. Unknown encodings pass through. Changed compressed requests are forwarded with correct uncompressed length; unchanged requests keep their original bytes. Requests and expanded bodies are bounded at 128 MiB. Larger requests receive 413 instead of exhausting memory. Active large requests still require memory; this is not a streaming JSON parser.

The supported configurable routing key is documented in [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference). This workaround is experimental; passing tests establishes proxy/filter behavior, not compatibility with every Codex Desktop release or a fix for all image-history problems.

## Validation recorded on 2026-10-19

The repository suite passed 21 tests, including filter immutability, HTTP/SSE forwarding, compressed requests, WebSocket metadata/close behavior, config rollback, runtime restart, and startup-hook behavior. Dependency audit reported no vulnerabilities.

A live ephemeral test using the running Windows Desktop CLI, existing ChatGPT authentication, and two identical local PNG attachments completed with the expected model reply. Its incremental `response.create` frame shrank from 3,429,769 to 1,730,252 bytes, removing one of two inline images. A preceding filtered attempt exited without a final response; its reason was not captured, so this remains an experimental workaround rather than a reliability guarantee. No original conversation transcript was edited. This verifies transport acceptance, not detailed visual understanding or removal of images already retained upstream.
