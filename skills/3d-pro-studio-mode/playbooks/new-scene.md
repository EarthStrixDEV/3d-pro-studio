# New scene

Outcome: a scene that passes the quality bar in `3d-pro-pipeline`.

1. Write the brief in five lines: subject, mood and palette, hero shot, interaction, target devices. Choose the tier.
2. Load `3d-pro-pipeline`. Copy `skills/3d-pro-pipeline/assets/pro-scene-template.html` into the project and replace only `buildScene()` and the tuning constants. Keep the `window.__three` and `window.__sceneReady` lines.
3. Dispatch `3d-tech-artist` with the brief, or build in this order yourself: blockout, hero form (`modifier-stack-parametric` for editable shapes, `shader-craft` for procedural geometry), materials (`pbr-lookdev`), lighting (`lighting-ibl-shadows`), post (`post-processing-stack`, `antialiasing-resolution`), motion (`motion-choreography`).
4. Add interaction only after the still frame passes. Use `interactive-layer.md`.
5. Run `performance-budget` against the tier table.
6. Run `render-qa`. Read every screenshot. Fix the top 3 issues, re-run, stop after 3 loops. Dispatch `3d-render-critic` for the final SHIP or ITERATE.

Reply: screenshots, the QA table, the brief you assumed, and what is unverified.
