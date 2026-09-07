# ChatGPT Gloves

Reusable Codex plugins and skills.

## Conversation Lifeboat

Conversation Lifeboat watches transcript size, effective context pressure, and repeated compaction. At serious thresholds it asks the user whether to preserve the current implementation state in a project specification and continue in a fresh task.

The plugin contains:

- `conversation-handoff`: a confirmation-gated Skill that writes a durable active specification and starts or prepares a fresh task.
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

Open `/plugins`, select the `chatgpt-gloves` marketplace, and install `conversation-lifeboat`. Review and trust its hook definition when Codex prompts you; installing a plugin does not silently trust executable hooks.

Node.js must be available on `PATH` for the hook process. No npm dependencies are required.

## Install through npm

The npm package carries the same marketplace and can either print the hosted setup values or extract an offline/local copy:

```text
npx chatgpt-gloves
npx chatgpt-gloves extract ./chatgpt-gloves-marketplace
```

After extraction, add the resulting directory as a local marketplace in ChatGPT Desktop. The GitHub marketplace is preferred because ChatGPT can sync later releases automatically.

## Configuration

Defaults can be overridden through environment variables before Codex starts:

| Variable | Default | Meaning |
|---|---:|---|
| `CONVERSATION_LIFEBOAT_WARN_MIB` | `512` | Show a low-frequency size warning |
| `CONVERSATION_LIFEBOAT_RECOMMEND_MIB` | `2048` | Recommend a fresh-task handoff |
| `CONVERSATION_LIFEBOAT_CRITICAL_MIB` | `5120` | Treat the transcript as critical |
| `CONVERSATION_LIFEBOAT_WARN_CONTEXT_RATIO` | `0.6` | Context warning ratio |
| `CONVERSATION_LIFEBOAT_RECOMMEND_CONTEXT_RATIO` | `0.8` | Context migration ratio |
| `CONVERSATION_LIFEBOAT_CRITICAL_CONTEXT_RATIO` | `0.9` | Critical context ratio |
| `CONVERSATION_LIFEBOAT_RECOMMEND_COMPACTIONS` | `4` | Compactions within the monitoring window before recommending migration |
| `CONVERSATION_LIFEBOAT_COMPACTION_WINDOW_HOURS` | `24` | Compaction monitoring window |
| `CONVERSATION_LIFEBOAT_TAIL_MIB` | `8` | Maximum transcript tail read per check |

Plugin state contains metrics only and is written under the plugin data directory supplied by Codex. Conversation text is not copied into that state.
