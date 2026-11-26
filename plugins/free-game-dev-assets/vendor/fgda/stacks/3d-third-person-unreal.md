---
id: 3d-third-person-unreal
title: Make a 3D third-person game in Unreal Engine 5
task: A third-person action-adventure with dialogue, quests and save games, built in Unreal Engine 5, to sell.
walked: 2026-10-13
---

# Make a 3D third-person game in Unreal Engine 5

For a solo developer building a small third-person game in Unreal Engine 5. The Tools picks are Unreal plugins; read [docs/unreal.md](../docs/unreal.md) first, because Epic content cannot go in a public repository.

## Art

- **Locomotion and animations:** [Game Animation Sample](../catalog/animation/game-animation-sample.md). Over 500 motion-captured animations on the UE5 Mannequin skeleton, wired up with Motion Matching for walk, run, jump and simple traversal.
- **Materials:** [ambientCG](../catalog/3d/ambientcg.md). 1500+ seamless PBR materials for environment texturing.
- **Sky lighting:** [Poly Haven](../catalog/environment/poly-haven.md). HDRIs up to 8K for image-based lighting.
- **Controller prompts:** [Kenney Input Prompts](../catalog/2d/kenney-input-prompts.md). 1500+ button glyphs for Xbox, PlayStation, Switch, Steam Deck, keyboard and mouse.

## Audio

- **Impact sounds:** [Kenney Impact Sounds](../catalog/audio/kenney-impact-sounds.md). 130 punches, thuds and physical impacts.
- **Menu sounds:** [Kenney UI Audio](../catalog/audio/kenney-ui-audio.md). 50 clicks and switches for menus, toggles, confirm and cancel.

## Fonts

- **Menus and subtitles:** [Atkinson Hyperlegible](../catalog/fonts/atkinson-hyperlegible.md). A sans designed for low vision, with distinct B and 8, O and 0, and I, l and 1.

## Tools

- **Dialogue:** [DlgSystem](../catalog/tools/dlgsystem.md). A dialogue graph editor with conditions, events and per-participant variables, usable from Blueprint and C++.
- **Quests:** [SUQS](../catalog/tools/suqs.md). Quests, objectives and tasks defined in data tables, with a small runtime API for progress.
- **Save games:** [SPUD](../catalog/tools/spud.md). Saves and restores actors that opt in, and keeps streamed levels' state as they unload and reload.
- **Hair and cloth jiggle:** [Kawaii Physics](../catalog/tools/kawaii-physics.md). Secondary motion for hair, skirts and tails as an AnimGraph node, without a Physics Asset.

## Gaps

- Characters beyond the UE5 Mannequin. [MetaHuman](../catalog/characters/metahuman.md) is listed but stays needs-review while Epic's terms disagree.
- Music for a third-person adventure.
- Environment kits that are not locked to Unreal; the free Epic environments are UE-only or still under review.
