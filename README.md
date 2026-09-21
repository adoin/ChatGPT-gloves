# ChatGPT Gloves

Reusable Codex plugins and skills.

## Test Gate

Test Gate prevents Codex from running or polling non-interactive automated tests, benchmarks, E2E suites, and acceptance suites. It hands those commands to a detached local runner and blocks unrelated follow-up prompts before model invocation until the required suites pass or the user explicitly skips them. Interactive browser work, screenshots, visual inspection, development servers, builds, linting, and type checking remain available. See the [plugin guide](plugins/test-gate/README.md) for controls, suite discovery, and project configuration.

## Local SSH Deploy

Local SSH Deploy opens a native form and securely persists named deployment profiles in Windows DPAPI, macOS Keychain, or Linux Secret Service, independently of conversations and projects. It publishes the current local project using the machine's own `ssh`, `scp`, and `tar`, requires confirmation of a hashed dry run, stores only an absolute private-key path, and never reads or stores private key contents. See the [plugin guide](plugins/local-ssh-deploy/README.md) for prerequisites and usage.

## Conversation Lifeboat

Conversation Lifeboat watches transcript size, effective context pressure, and repeated compaction. At serious thresholds it asks the user whether to update durable project specifications and continue transient execution state in a fresh-task prompt.

The plugin contains:

- `conversation-handoff`: a confirmation-gated Skill that updates durable specifications, preserves the user's original wording and language, and carries working-tree state, remaining work, validation, and the next action only in the fresh-task starter prompt.
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

Open `/plugins`, select the `chatgpt-gloves` marketplace, and install `conversation-lifeboat`, `local-ssh-deploy`, or `test-gate`. Review and trust bundled hook definitions when Codex prompts you; installing a plugin does not silently trust executable hooks.

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

The GitHub-backed Codex marketplace is the only supported installation and update channel. The previously published `chatgpt-gloves` npm package is a frozen legacy snapshot and will not receive plugin updates.

## Configuration

Defaults can be overridden through environment variables before Codex starts:

| Variable | Default | Meaning |
|---|---:|---|
| `CONVERSATION_LIFEBOAT_WARN_MIB` | `512` | Show a low-frequency size warning |
| `CONVERSATION_LIFEBOAT_RECOMMEND_MIB` | `2048` | Recommend a fresh-task handoff |
| `CONVERSATION_LIFEBOAT_CRITICAL_MIB` | `5120` | Treat the transcript as critical |
| `CONVERSATION_LIFEBOAT_WARN_CONTEXT_RATIO` | `0.8` | Non-blocking context warning ratio |
| `CONVERSATION_LIFEBOAT_RECOMMEND_CONTEXT_RATIO` | `0.85` | Context migration ratio |
| `CONVERSATION_LIFEBOAT_CRITICAL_CONTEXT_RATIO` | `0.92` | Critical context ratio |
| `CONVERSATION_LIFEBOAT_RECOMMEND_COMPACTIONS` | `4` | Compactions within the monitoring window before recommending migration |
| `CONVERSATION_LIFEBOAT_COMPACTION_WINDOW_HOURS` | `24` | Compaction monitoring window |
| `CONVERSATION_LIFEBOAT_TAIL_MIB` | `8` | Maximum transcript tail read per check |

Plugin state contains metrics only and is written under the plugin data directory supplied by Codex. Conversation text is not copied into that state.
