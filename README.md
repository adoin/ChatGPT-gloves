# ChatGPT Gloves

Reusable Codex plugins and skills.

## Image History Guard

[Image History Guard](plugins/image-history-guard/README.md) keeps the first image in place and uses stable references for repeats within a verified conversation/account. Cross-turn references require confirmed response lineage; full replays keep a recoverable original. It stores bounded local image copies, supports view_image recovery and worker-thread hashing, and preserves original transcripts. HTTP/SSE and WebSocket transports are supported. Enable/upgrade and rollback are explicit; cache/token savings must be measured rather than inferred from upload size.

## Test Gate

## Local SSH Deploy

Local SSH Deploy opens a native form and securely persists named deployment profiles in Windows DPAPI, macOS Keychain, or Linux Secret Service, independently of conversations and projects. It publishes the current local project using the machine's own `ssh`, `scp`, and `tar`, requires confirmation of a hashed dry run, stores only an absolute private-key path, and never reads or stores private key contents. See the [plugin guide](plugins/local-ssh-deploy/README.md) for prerequisites and usage.

## Conversation Lifeboat

Conversation Lifeboat 0.4 is manual-only. Invoke `$conversation-handoff` when you want to continue work in a fresh task, or `$spec-update` to refresh durable specifications in place. It no longer monitors conversation health, scans history, detects reconnections, or sends unsolicited migration reminders. The former detector remains recoverable in Git history; legacy health state does not trigger any workflow.

The plugin contains:

- `conversation-handoff`: a confirmation-gated Skill that updates durable specifications, preserves the user's original wording and language, and carries working-tree state, remaining work, validation, and the next action only in the fresh-task starter prompt.
- Handoff continuations use the saved project checkout by default so path-bound setup and startup scripts keep running in the original workspace. A managed worktree is used only when the user explicitly requests isolation.
- `spec-update`: an in-place Skill that extracts specification-owned detail from applicable `AGENTS.md` files and updates the current specification without creating a new task. A single update reconciles active requirements, newly evidenced prohibited approaches, verified implemented specifications, and deliberately superseded specifications.
- No registered automatic hooks. The old health script is a silent compatibility entrypoint for stale hook definitions.

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

Open `/plugins`, select the `chatgpt-gloves` marketplace, and install `conversation-lifeboat` or `local-ssh-deploy`. Conversation Lifeboat has no executable hooks to trust. Other plugins retain their own normal hook review flow.

Conversation Lifeboat consists of manual skills and requires no background service or npm dependencies.

## Invoke specification workflows directly

These workflows run only when you request them; there are no automatic health warnings.

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
