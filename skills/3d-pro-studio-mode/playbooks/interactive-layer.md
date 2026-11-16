# Interactive layer

Outcome: motion, physics, labels or procedural effects that hold up at the tier budget and respect reduced motion.

1. Confirm the still frame already passes `render-qa`. Interaction on a weak image hides nothing.
2. Pick the skill by what moves.

| Need | Skill |
|---|---|
| Intro camera, scroll story, damping, hover, clips | `motion-choreography` |
| Collisions, stacking, character, constraints | `physics-rigidbody` |
| Labels, annotations, hotspots, HUD | `hud-ui-labels` |
| Cloned or staggered instances, fields | `mograph-procedural` |
| Particles, timeline, decals, engine-style effects | `realtime-engine-features` |
| Editable parametric shape with deformers | `modifier-stack-parametric` |

3. Build one interaction at a time. After each, run `render-qa`, then check the console for errors.
4. Verify reduced motion, a 390 px phone viewport, keyboard access for every meaningful control, and frame-rate independence.
5. Run `performance-budget` again. Interaction adds draw calls and per-frame cost.

Reply: what was added, the QA table, the reduced-motion and keyboard result, and what could not be checked without a real device.
