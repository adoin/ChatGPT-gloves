# Free Game Dev Assets

Search a bundled catalog of free game assets and tools, then check the original creator's terms for your intended use. Includes the `free-game-asset-sourcing` skill, four read-only stdio MCP tools and an optional terminal CLI.

## Install

Requires Node.js 22+ on PATH. No npm install, API key, separately managed service or global MCP configuration is needed.

```powershell
codex plugin marketplace add https://github.com/adoin/ChatGPT-gloves
codex plugin add free-game-dev-assets@chatgpt-gloves
```

If the marketplace is already configured, refresh it with `codex plugin marketplace upgrade chatgpt-gloves` before adding the plugin. Review the plugin's local MCP execution in the usual Codex installation flow. Open a new local chat after installation; remote/cloud-only runtimes cannot launch this local stdio server.

Example requests:

- `用 $free-game-asset-sourcing 为 Godot 像素游戏找可商用、免署名的音效。`
- `找一套适合 3D 游戏原型的免费角色、环境和动画，并核对分发限制。`

## Tools and limits

| Tool | Purpose |
| --- | --- |
| `search_assets` | Search by words, category, license, commercial use, credit requirement, engine or format |
| `get_asset` | Get the catalog summary and source link for one entry |
| `check_license` | Screen a recorded entry against commercial use and engine requirements |
| `list_stacks` | List starter-stack names and links |

Queries use only `data/catalog.json`, regardless of the working directory or `FGDA_DATA`. There is no automatic network fetch or update. No asset files are downloaded or installed. Search terms should follow the upstream catalog's vocabulary, usually English. `list_stacks` returns links, not downloaded asset bundles.

The Release snapshot contains 420 entries but predates the stacks export. The missing stack index is supplemented from nine unmodified stack definitions at the pinned code revision, using upstream's parser. MCP and CLI share this loader. These newer stack pages may refer to entries not present in the older release; follow their source links rather than assuming every stack pick is searchable locally.

The snapshot is dated **v2026.11.01**, not a live index. A positive `check_license` result is preliminary screening, not approval for the latest download. In particular, commercial searches may return per-file terms (`commercial: "varies"`), and no-credit results may still require license/copyright notices. Follow `url` to the creator and check the specific free tier, asset version, engine restrictions, attribution and redistribution terms. The canonical skill explains how to handle missing license links and unknown/review-needed entries.

## Optional CLI

From the plugin directory:

```powershell
node scripts/fgda.mjs search "interface sounds" --category audio --license CC0 --commercial --no-attribution --json
node scripts/fgda.mjs get kenney --json
node scripts/fgda.mjs check kenney --engine godot --json
node scripts/fgda.mjs stacks --json
```

This wrapper always selects the bundled snapshot. `check` exits 1 for catalog restrictions or unresolved entries. To query different data or build a newer catalog, use upstream tooling separately.

## Sources and maintenance

- Catalog engine: [TMHSDigital/Free-Game-Dev-Assets](https://github.com/TMHSDigital/Free-Game-Dev-Assets), revision `2161a7fc06191621fd2e00f1bf5004bf8d433b96`.
- Data: upstream Release [`v2026.11.01`](https://github.com/TMHSDigital/Free-Game-Dev-Assets/releases/tag/v2026.11.01), `data.json`, exact SHA-256 recorded in `upstream-lock.json`.
- Skill: the user's canonical `adoin/my-skills/free-game-asset-sourcing` at `7f3cd0760e0bf47b1c63de36ff03f4b92fef6b67`. Its existing standalone installation path is unchanged. The two upstream skill files are bundled byte-for-byte, not independently edited here; plugin-specific launch details stay outside them.

`upstream-lock.json` records all source paths, revisions and checksums. Check a checkout offline:

```powershell
node scripts/sync-upstream.mjs --check
```

`--sync` restores the pinned files after checking every downloaded hash. It is a maintainer command, never an install/startup hook. It checks `gh --version` and `gh auth status --hostname github.com` first. When authenticated, requests use `gh`; failures preserve diagnostics and never trigger anonymous retries. Only public upstream files may use bounded anonymous requests when gh is absent or logged out. The private canonical skill always requires authenticated gh.

To intentionally update pins, review upstream changes, change the revisions/release and expected asset digest, and clear only the reviewed files' old hashes. Then run `--record-hashes`, inspect the diff, run tests and skill validation, and publish a new plugin version. This keeps the canonical skill synchronized without changing the private source repository.

## Licensing

Local integration code is MIT; see `LICENSE`. The bundled upstream engine and catalog metadata are CC0; see `vendor/fgda/LICENSE` and `THIRD_PARTY_NOTICES.md`. These licenses do **not** apply to the assets linked by the catalog. Keep the original asset licenses and credits when incorporating selected files into a game.
