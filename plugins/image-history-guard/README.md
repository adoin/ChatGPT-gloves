# Image History Guard

Experimental local proxy for the default ChatGPT-authenticated Codex provider, addressing repeated structured inline-image replay. Version 0.2.0 replaced the old “keep last occurrence” policy with stable first-image references.

## What changes

- Every first image keeps its position and receives a deterministic SHA-256 ID and local recovery path. Appending a duplicate does not move or rewrite earlier originals.
- Later identical images in incremental requests are referenced only when an observed successful previous_response_id proves the original was supplied in that thread's response chain. A cached local file by itself is not proof. Failed requests never seed lineage.
- Full requests always retain the first original and deterministically reference later duplicates. Consequently a full replay still uploads one original per distinct image. This does not eliminate all of openai/codex#28316.
- Identity comes from client_metadata.thread_id, checked against x-client-request-id and explicit turn metadata. Account scope is derived from account/auth identity, without storing credentials. Forks are isolated even if session-id and prompt_cache_key are shared. Missing/conflicting identity passes through; WebSocket messages require their own thread_id.
- Model responses and original rollouts are unchanged. Summarization input passes through. Confirmed compaction invalidates inherited image assumptions. An unknown ancestor after reconnect/proxy restart retains originals rather than risking dangling references.

## Recovery and local storage

An annotation tells the model to use its existing view_image tool on the exact local image path if the original pixels are no longer available. Such explicit reloads are not stripped out again. No tool schemas are injected. A textual ID is not a server-side image handle, and this does not force a model to call a recovery tool or guarantee server-side cache retention.

Decoded images are ordinary local files under CODEX_HOME/plugins/data/image-history-guard-chatgpt-gloves/images, partitioned by hashed account/thread scope. Limits: 32 MiB per image, 256 MiB and 512 images overall, approximate seven-day retention and eviction. No raw prompts, auth tokens, or transcripts are saved. Local copies are not encrypted and do not isolate tools that already share the user's filesystem privileges. If an image is evicted and no longer exists in the request/context, reattachment may be necessary. Unrecognized formats, remote/file IDs, opaque serialized JSON images, native image-generation result items and encrypted fields are untouched.

Hashing, JSON transformation and image storage run in one worker thread with an 8 MiB bounded hash cache. Request processing is bounded at 128 MiB; worker queues are bounded and overload/worker failure passes requests through. Complete-response observation is bounded too; unobservable completion falls back to unknown lineage. These bounds limit resources but do not make large requests free of memory/copying overhead.

## Install, upgrade and roll back

Install from the ChatGPT Gloves GitHub marketplace, then in the plugin root:

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/guard.cjs enable
node scripts/guard.cjs status
```

For an existing installation after updating the marketplace plugin:

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/guard.cjs upgrade
```

Restart Codex after enable/upgrade. Upgrade starts a fresh runtime on a new port and keeps the previous listener alive for running clients. This avoids interrupting other active chats. The config change is reversible and preserves unrelated edits. Existing custom provider routes are refused.

Review the bundled startup hook using Codex's normal trust flow. It only restarts an explicitly enabled installation. No OS service or certificate is installed. Without the trusted hook, run `node scripts/guard.cjs start` after reboot. HTTP_PROXY/HTTPS_PROXY/NO_PROXY are respected; system proxy configuration is not auto-detected. The proxy must be running while its route is configured.

Rollback:

```text
node scripts/guard.cjs disable
```

Restart Codex. When no old clients need either listener, optionally run `node scripts/guard.cjs stop`. Local cached image files are retained under the data directory; disabling does not erase them.

## Measurement

Status reports removed/restored image counts, payload bytes saved, unknown lineage/identity bypasses and observed input/cached/output tokens. Bytes saved are not equivalent to tokens or subscription quota saved. Stable prefixes are tested locally; actual cache hits depend on the backend. Treat live smoke results and local protocol tests separately and do not infer a general cache/cost guarantee from a successful response.

## Validation on 2026-10-19

The repository suite passed 36 tests, including verified identity/fork/account isolation, stable first-occurrence replay, successful-response lineage, failure/compaction recovery, bounded storage, incremental view_image restoration, compressed HTTP/SSE, WebSocket transport and non-disruptive runtime upgrade. The updated skill passed validation.

A live Windows Desktop backend test used three baseline turns and three filtered turns with the same 564,642-byte red PNG, followed by an explicit view_image reload and proxy restart/full-history replay. All eight turns returned the correct color. The repeat-image incremental frame shrank from 755,308 to 2,904 bytes; the explicit reload retained the image pixels. Filtered follow-up cached/input ratios were 97.10% and 97.95%; the restart/replay turn reported 99.13%. The separate baseline's third turn reported 96.97%.

These were separate ephemeral threads with different startup context sizes, so they establish compatibility and observed cache reuse, not a controlled cost/latency comparison or a subscription-quota savings guarantee. Enabling a new transformation in an existing chat can also cause an initial prefix change. Large distinct image histories, native image-generation result payloads and server-side retention remain outside this workaround's guarantees.

## Native tool routing and worker recovery (0.2.2)

The proxy only examines JSON POST requests to the exact Responses endpoint, and JSON response.create messages on the exact Responses WebSocket endpoint. Compaction input is bypassed. All other upstream-relative endpoints, HTTP methods, request encodings and non-Responses WebSocket messages are forwarded without parsing or rewriting their bodies. This includes images/generations, images/edits, web tools and future native endpoints. Unknown API routes no longer produce a synthetic local 404. The destination remains the original fixed upstream; capability checks, origin rejection and traversal protection remain in place. Passthrough request bodies stream directly, without the filter's buffering/size limit.

Worker startup readiness has its own deadline and does not consume a processing deadline. Cache startup inventories metadata and validates image contents lazily on first use. Worker faults/timeouts are visible in status and trigger up to three fresh-worker recoveries per proxy lifetime. New workers have no trusted response lineage; originals are retained until a new successful chain is observed. During startup/recovery/disabled filtering, requests pass through unchanged. This does not make a stopped proxy network-transparent: the listener still needs to run while its route is configured.

Status now distinguishes starting/ready/recovering/disabled states, restart count and the last worker error code. Bounded diagnostic files in the plugin data diagnostics directory retain lifecycle/error metadata only (two segments, roughly 1 MiB each). They do not contain exception messages, stacks, auth headers, URLs, query strings, image identifiers, file paths or request/response bodies. These diagnostics cannot reconstruct the unlogged cause of an older 0.2.0 worker exit.

The 2026-10-22 regression tests cover unchanged native image/web requests, multipart/gzip, arbitrary methods, larger opaque bodies, non-Responses WebSockets, delayed startup, worker crash recovery, timeout recovery and diagnostic redaction/rotation. A local mocked model service was used for route/body preservation; this is distinct from a successful cloud image generation. After installing 0.2.2, run upgrade and restart Codex so built-in tools stop using the old process's cached proxy route.

An unauthenticated live route probe on 2026-10-22 reproduced the old proxy's empty local 404 at images/generations; the fixed proxy reached the official upstream and relayed its 401 response. No user credentials or image generation charge were involved. The full repository suite passed 43 tests. This probe confirms forwarding, not a successful cloud-generated image; existing clients must restart to stop using an old cached proxy route.

Operation locks now record a PID and ownership nonce. A subsequent command recovers a positively dead owner; live owners and ownerless legacy locks are never removed automatically. Legacy lock recovery requires checking for active management commands and reviewing the specific empty lock directory.
