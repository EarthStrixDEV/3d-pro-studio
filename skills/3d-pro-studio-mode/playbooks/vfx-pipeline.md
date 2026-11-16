# VFX pipeline

Outcome: a particle or simulation effect that reads clearly in motion, hits its timing beat, and holds the frame rate on every tier.

1. Fix the tier and the effect budget first. Read the tier row in `performance-budget` and plan the fallbacks with `vfx-performance-scaling`. VFX is where frame rate is lost.
2. Build the particle base with `particle-system-architecture`. Add `gpu-particles-compute` only when the count needs it. Shape motion with `particle-forces-fields`, rendering with `particle-rendering-blending`, and streaks with `particle-trails-ribbons`.
3. Pick the recipe for the effect.

| Effect | Skill |
|---|---|
| Fire, smoke, explosions | `vfx-fire-smoke-explosion` |
| Magic, shields, portals, hit flashes | `vfx-magic-energy-stylized` |
| Rain, snow, dust, fireflies | `vfx-weather-environment` |
| Impacts, sparks, decals | `vfx-impact-sparks-decals` |

4. Make the textures with `vfx-flipbook-authoring`. Compress them per `gltf-asset-pipeline`.
5. Use a simulation only when particles cannot fake it, and check the tier table in the skill first.

| Simulation | Skill |
|---|---|
| Liquids | `fluid-sph-3d` |
| Grid smoke and fire | `grid-fluid-smoke` |
| Jelly and soft bodies | `soft-body-xpbd` |
| Breaking objects | `rigid-destruction-fracture` |
| Sand and snow | `granular-sand-snow-sim` |

   When the live cost is too high, bake offline and play back with `sim-cache-baking-vat`.
6. Time the beat with `vfx-timing-choreography`. Add screen-space punch with `vfx-post-fx-compositing`.
7. When the effect must be reused or tuned by others, define it as data with `vfx-graph-authoring`.
8. Run `render-qa` at several timestamps of the effect, not one frame. Read the screenshots, check overdraw and the low-tier fallback, then re-run `vfx-performance-scaling` checks.

Reply: the effect list per tier, timestamped screenshots, the QA table, what is approximated versus simulated, and what is unverified on a real GPU.
