# Third-party sources

`vendor/fgda/` contains unmodified CLI/MCP and query modules from TMHSDigital/Free-Game-Dev-Assets at the revision recorded in `upstream-lock.json`. Its CC0-1.0 dedication is reproduced in `vendor/fgda/LICENSE`.

`data/catalog.json` is the upstream v2026.11.01 Release catalog. Upstream documents its catalog metadata as CC0. No linked asset packages, preview images, fonts or audio are included in this plugin.

The missing starter-stack index is read from `vendor/fgda/stacks/` at the pinned code revision using the unmodified upstream stack parser. This supplements the index without modifying the Release's entry data or checksum.

`skills/free-game-asset-sourcing/SKILL.md` and `references/catalog.md` are synchronized from the user's canonical standalone skill in adoin/my-skills. They remain byte-identical to the pinned source. Other private repository content is not bundled.

Directory entries and recorded license checks are preliminary data, not substitutes for the original creators' applicable terms. Individual assets and tools retain their own licenses.
