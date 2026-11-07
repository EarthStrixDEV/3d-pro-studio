---
name: 3d-pro-pipeline
description: End-to-end production pipeline for advanced, high-quality real-time 3D (Three.js/WebGL/WebGPU) — brief → blockout → look-dev → post → motion → performance → render QA loop, with a tested pro scene template and specialist agents. Use when building or upgrading a 3D scene, product viewer, hero section, 3D artifact or configurator to "pro / premium / high quality / photoreal / AAA" level, or when the user says ทำ 3D ให้สวย, 3D คุณภาพสูง, งาน 3D ระดับโปร, อัปเกรด 3D.
argument-hint: "<what to build or the scene file to upgrade>"
---

# 3D Pro Pipeline

The orchestrator for the `3d-pro-studio` plugin. It decides **what stage the work is at**, loads the right specialist skill, dispatches the right agent, and refuses to call anything "done" until it has passed render QA.

## Quality bar — what "high quality" means here

A scene ships only when all of these hold (render-qa checks most of them automatically):

1. **Silhouette** reads in 1 second; no faceting on curved hero surfaces; every hard edge bevelled.
2. **Materials** are PBR (`MeshStandardMaterial` / `MeshPhysicalMaterial`) with plausible values, roughness variation, correct texture colour spaces.
3. **Lighting** has a clear key, an environment (IBL) for reflections, a rim/separation light, and grounded contact shadows. Nothing floats.
4. **Tone & colour**: tone mapping on, sRGB output, no blown highlights or crushed blacks, a deliberate palette.
5. **Post** is subtle and purposeful (AA always; bloom only on HDR emissives; AO without artifacts).
6. **Camera** is composed (30–45° FOV for objects), auto-framed for any aspect ratio, orbit limits stop ugly angles.
7. **Motion** is frame-rate independent, damped, and honours `prefers-reduced-motion`.
8. **Performance** fits the device-tier budget; DPR capped; resources disposed.
9. **Zero console errors**, works on a 390 px wide phone, light and dark.

## Stages

| # | Stage | Skill to load | Agent to dispatch |
|---|---|---|---|
| 0 | Brief: goal, mood, reference, hero object, platform, budget | `3d-idea-brief` (if installed) or write 5-line brief yourself | — |
| 1 | Scaffold from template | this skill (`assets/pro-scene-template.html`) | `3d-tech-artist` |
| 2 | Blockout & hero modeling | `3d-blockout-modeling`, `3d-polygon-upgrade` (if installed) + `procedural` notes in `shader-craft` | `3d-tech-artist` |
| 3 | Look-dev: materials | `pbr-lookdev` | `3d-lookdev-artist` |
| 4 | Look-dev: lighting & shadows | `lighting-ibl-shadows` | `3d-lookdev-artist` |
| 5 | Custom surfaces / FX | `shader-craft` | `3d-shader-engineer` |
| 6 | Post-processing & grade | `post-processing-stack` | `3d-lookdev-artist` |
| 7 | Motion & camera choreography | `motion-choreography`, `3d-camera-director` (if installed) | `3d-tech-artist` |
| 8 | Assets (glTF, textures) | `gltf-asset-pipeline` | `3d-performance-engineer` |
| 9 | Performance | `performance-budget` | `3d-performance-engineer` |
| 10 | Render QA (gate, repeat ≤ 3×) | `render-qa` | `3d-render-critic` |

Skip stages that don't apply, but never skip 10.

## How to run it

1. **Brief first.** If the user gave only a vague idea, write a 5-line brief (subject, mood/palette, hero shot, interaction, target devices) and confirm it in one message before building. If they gave a file, read it and state which stages it is weakest at.
2. **Start from the template** for new scenes: copy `assets/pro-scene-template.html` (next to this file) into the project and replace `buildScene()`. It already has: quality tiers, NeutralToneMapping, PMREM room environment, key/rim/hemi rig, shadow-catcher ground, radial backdrop, auto-framing for any aspect, damped orbit with limits, GTAO+bloom+SMAA in the right order (with the verified GTAO fixes), reduced-motion handling and the `window.__three` QA hook. Keep the `window.__three` / `window.__sceneReady` lines.
3. **Delegate by stage.** Independent stages (e.g. shader work and asset compression) can run in parallel agents; look-dev and post must run after the geometry is final. Give each agent the file path, the brief, and the stage's acceptance criteria.
4. **Gate with QA.** Run `render-qa` (or dispatch `3d-render-critic`). Fix the top 3 issues, re-run. Stop after 3 loops and report what is left honestly.
5. **Report**: before/after screenshots, the QA table (draw calls, triangles, warnings), and anything you could not verify (e.g. real-GPU frame rate when QA ran on SwiftShader).

## Integration notes

- If the user has the basic skills (`3d-idea-brief`, `3d-blockout-modeling`, `3d-camera-director`, `3d-color-light-shadow`, `3d-polygon-upgrade`), use them for stages 0, 2 and 7; this plugin's skills are the advanced layer on top and take precedence where they overlap.
- Inside a Claude.ai artifact (single HTML file, CDN imports only): keep everything in one file, pin the Three.js version in the import map, and use only `three/addons/*` — no npm-only libraries.
- In a bundler project (Vite/Next): the same rules apply; prefer `pmndrs/postprocessing` + `n8ao` for post and `@react-three/drei` helpers if it is an R3F codebase.

## Anti-patterns to refuse (say so, then propose the fix)

- `MeshBasicMaterial`/`MeshNormalMaterial` on hero objects, or "just add more lights" instead of an environment map.
- Bloom with a low threshold that makes the whole frame glow.
- Uncapped `devicePixelRatio`, shadows on every light, 4K textures on a phone.
- Declaring it done without looking at a rendered screenshot.
