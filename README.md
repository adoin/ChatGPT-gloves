# ChatGPT Gloves

Reusable Codex plugins and skills.

## Image History Guard

[Image History Guard](plugins/image-history-guard/README.md) keeps the first image in place and uses stable references for repeats within a verified conversation/account. Cross-turn references require confirmed response lineage; full replays keep a recoverable original. It stores bounded local image copies, supports view_image recovery and worker-thread hashing, and preserves original transcripts. HTTP/SSE and WebSocket transports are supported. Enable/upgrade and rollback are explicit; cache/token savings must be measured rather than inferred from upload size.

## Test Gate

## Local SSH Deploy

Local SSH Deploy opens a native form and securely persists named deployment profiles in Windows DPAPI, macOS Keychain, or Linux Secret Service, independently of conversations and projects. It publishes the current local project using the machine's own `ssh`, `scp`, and `tar`, requires confirmation of a hashed dry run, stores only an absolute private-key path, and never reads or stores private key contents. See the [plugin guide](plugins/local-ssh-deploy/README.md) for prerequisites and usage.

## Conversation Lifeboat

Conversation Lifeboat detects abnormal inline-image retention and recent connection/compaction failures. Token count, context-window percentage, transcript total size, stale/missing usage, and normal successful automatic compaction never independently trigger a warning or migration offer. The old token/ratio/total-size threshold variables are retired and ignored in 0.3.0.

The monitor scans at most 16 MiB of the transcript tail (configurable, capped at 64 MiB), processes only actual response items rather than mirrored UI events, hashes image data in memory, and records metrics only. It detects inline data URLs, including serialized tool-output image URLs, and explicit generated-image result payloads. Observed image-byte counters accumulate across append-only checks without rescanning old history and reset at observed compaction boundaries. Gaps, large partial records, and content outside the sample mean these are lower-bound history estimates, not actual request-body measurements or proof that every image was resent.

Defaults: 8 MiB observed retained image data, 4 MiB sampled duplicate data, or 8 MiB new image data within 10 minutes prompts a nonblocking review. At 24 MiB retained image data, at least 4 MiB of duplicates making up half the sampled image bytes, image risk plus a recent failure, or persistent failures, the assistant may briefly offer migration while continuing work. At 48 MiB retained image data severity becomes critical. These are configurable operational heuristics, not protocol limits. A single connection failure forces diagnosis, not a handoff offer. Successful token-usage events clear older failure signals; normal repeated compaction alone does not trigger migration.

A current user report of reconnection, disconnected streams, or timeout bypasses notification cooldown for reassessment. Only current reports and explicit recent transcript error events are considered; historical assistant messages and command-output examples are not failure evidence. There is no live reconnect hook, so a stalled network request cannot be intercepted by this monitor. User-declined offers remain suppressed at the same or lower severity, including after cooldown. Explicit migration confirmation is still required. Pending token-based offers from 0.2.2 are cleared on upgrade.

The plugin contains:

- `conversation-handoff`: a confirmation-gated Skill that updates durable specifications, preserves the user's original wording and language, and carries working-tree state, remaining work, validation, and the next action only in the fresh-task starter prompt.
- Handoff continuations use the saved project checkout by default so path-bound setup and startup scripts keep running in the original workspace. A managed worktree is used only when the user explicitly requests isolation.
- `spec-update`: an in-place Skill that extracts specification-owned detail from applicable `AGENTS.md` files and updates the current specification without creating a new task. A single update reconciles active requirements, newly evidenced prohibited approaches, verified implemented specifications, and deliberately superseded specifications.
- Lifecycle hooks for `SessionStart`, `PostCompact`, and `UserPromptSubmit`.
- A dependency-free Node.js monitor that reads only a bounded transcript tail, even when the JSONL is many gigabytes.

## Install from this repository

In ChatGPT Desktop, open the plugin manager and add a marketplace using these values:

```text
Source:      https://github.com/adoin/ChatGPT-gloves
Git ref:     main (or leave blank)
Sparse path: leave blank
```

The sparse path must be blank because `.agents/plugins/marketplace.json` is at the repository root. Then install `conversation-lifeboat` and start a new task.

The equivalent Codex command is:

```text
codex plugin marketplace add https://github.com/adoin/ChatGPT-gloves
```

Open `/plugins`, select the `chatgpt-gloves` marketplace, and install `conversation-lifeboat` or `local-ssh-deploy`. Review and trust bundled hook definitions when Codex prompts you; installing a plugin does not silently trust executable hooks.

Node.js must be available on `PATH` for the hook process. No npm dependencies are required.

## Invoke specification workflows directly

You do not need to wait for a conversation-health warning.

```text
$spec-update Refresh the current specification without creating a new task.
$conversation-handoff Update durable specifications and continue task-specific state in a fresh prompt without translating the user's requirements.
```

In ChatGPT, type `@` and select **Specification Update** or **Conversation Handoff**. `spec-update` never creates, forks, archives, or switches tasks. During one update it may:

- move module requirements, approved project-level TODOs, durable decisions, and evidenced prohibitions out of `AGENTS.md` into their authoritative lifecycle documents while leaving transient continuation state, cross-task rules, and specification entry links in their proper places;
- keep approved unfinished requirements under `.agents/notes/active/`;
- record evidenced failed or forbidden approaches under `.agents/notes/prohibited/`;
- move completed and verified specifications to `.agents/notes/implemented/`;
- move deliberately replaced specifications to `.agents/notes/superseded/` and cross-link the replacement.

## Distribution policy

Codex plugins are distributed through the GitHub-backed marketplace. Image History Guard additionally provides the standalone `image-history-guard` npm CLI for service management from PowerShell or another terminal; see its [guide](plugins/image-history-guard/README.md). The previously published `chatgpt-gloves` npm package is a frozen legacy snapshot and will not receive plugin updates.

## Configuration

Defaults can be overridden through environment variables before Codex starts:

| Variable | Default | Meaning |
|---|---:|---|
| `CONVERSATION_LIFEBOAT_WARN_IMAGE_MIB` | `8` | Review retained inline-image risk |
| `CONVERSATION_LIFEBOAT_RECOMMEND_IMAGE_MIB` | `24` | Evidence supporting a nonblocking migration offer |
| `CONVERSATION_LIFEBOAT_CRITICAL_IMAGE_MIB` | `48` | Escalate retained-image severity |
| `CONVERSATION_LIFEBOAT_DUPLICATE_IMAGE_MIB` | `4` | Review duplicate payload risk; offer when duplicates are at least half of sampled image bytes |
| `CONVERSATION_LIFEBOAT_IMAGE_GROWTH_MIB` | `8` | Review newly observed image-byte growth |
| `CONVERSATION_LIFEBOAT_GROWTH_WINDOW_MINUTES` | `10` | Maximum interval for image-growth checks |
| `CONVERSATION_LIFEBOAT_FAILURE_WINDOW_MINUTES` | `30` | Retain recent connection/compaction failure signals |
| `CONVERSATION_LIFEBOAT_RECOMMEND_COMPACTIONS` | `4` | Supporting evidence only when failures also exist |
| `CONVERSATION_LIFEBOAT_COMPACTION_WINDOW_HOURS` | `24` | Compaction monitoring window |
| `CONVERSATION_LIFEBOAT_TAIL_MIB` | `16` | Bounded tail read, hard-capped at 64 MiB |

Plugin state contains metrics only and is written under the plugin data directory supplied by Codex. Conversation text is not copied into that state.
