# World and FX

Outcome: an environment or simulation effect that holds its frame rate on the target tier and degrades gracefully below it.

1. Read the tier row in `performance-budget` first. These effects are the most expensive in the framework. Decide the fallback for each tier before building.
2. Pick the skill by what the scene needs.

| Need | Skill |
|---|---|
| Ground, water, ocean | `ocean-terrain-environment` |
| Fog, god rays, clouds, sky | `volumetrics-atmosphere` |
| Cloth, soft bodies, simple fluids | `cloth-fluid-simulation` |
| Grass, fur, hair | `fur-hair-grass-systems` |
| Collisions with the world | `physics-rigidbody` |

3. Assemble with `scene-assembly-prefabs`. Use prefabs and safe cloning for repeated content, and plan disposal.
4. When the user needs to author the scene in the browser, add `scene-editor-viewport-tools`. Keep the editor out of the shipped bundle.
5. Build one effect at a time. Run `render-qa` after each and read the screenshots.
6. Re-run `performance-budget`. Verify the low-tier fallback renders, not just the high tier.

Reply: the effect list per tier, the QA table, which items are approximations of DCC behaviour, and what is unverified on real GPUs.
