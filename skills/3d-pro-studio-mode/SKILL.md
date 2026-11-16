---
name: 3d-pro-studio-mode
description: Core entry point of the 3d-pro-studio framework. Routes any real-time 3D task (build a scene, upgrade quality, fix a visual bug, hit a frame budget, prepare assets, add interaction or HUD) to the matching playbook, loads the specialist skills in the right order, delegates to the specialist agents, and refuses to call work done without a rendered screenshot and a render-qa pass. Use at the start of any Three.js, WebGL or WebGPU 3D task, or when the user says 3d-pro-studio, 3D mode, ทำ 3D ระดับโปร, งาน 3D ทั้งระบบ, ไม่รู้ว่าต้องใช้ skill ไหน.
argument-hint: "<the 3D task, scene file, or symptom>"
---

# 3D Pro Studio mode

This skill is the router and the rule set. It holds no technique. Techniques live in the specialist skills, and each playbook below tells you which ones to load and in what order. Load a specialist skill with the Skill tool, prefix `3d-pro-studio:`.

## Non-negotiables

- **First message.** State the goal, the subject and mood, the target device tier, and the smallest change you expect to meet it. Do not wait for confirmation. If the evidence shows the asked change is wrong, show the evidence and stop.
- **Look before you claim.** Never call a visual result done, fixed or better without a rendered screenshot you have read. Run the `render-qa` skill.
- **Name the data shape first.** For any code, define the scene config (tier, palette, camera, quality flags) as one typed object before writing logic. Scattered constants are how tier handling breaks.
- **Budget before beauty.** Read the tier row in `performance-budget` before adding a pass, a light, a texture or a mesh.
- **Environment before lights, geometry before look-dev, one variable at a time.** Tuning materials on geometry that will still change wastes the pass.
- **Never overwrite the only copy.** Work on a copy of the user's scene file before an upgrade.
- **No restating.** Link a specialist skill by name. Do not paste its rules into a brief or a reply.

## Route the task

| The user wants | Playbook |
|---|---|
| A new scene, viewer, hero section or artifact | `playbooks/new-scene.md` |
| An existing scene to look premium | `playbooks/upgrade-scene.md` |
| A visual defect (slabs, acne, shimmer, black model, floating, washed out) | `playbooks/fix-visual-bug.md` |
| Stutter, heat, memory, slow load | `playbooks/performance.md` |
| A GLB or texture set prepared, shrunk or sharpened | `playbooks/asset-prep.md` |
| Motion, physics, labels, HUD, procedural effects | `playbooks/interactive-layer.md` |

Two playbooks can apply. Run the one that owns the user's stated outcome first. Never skip the QA step in any playbook.

## Skill index

| Domain | Skills |
|---|---|
| Orchestration | `3d-pro-pipeline` (stages and the pro scene template) |
| Form | `mesh-texture-upscale`, `modifier-stack-parametric`, `mograph-procedural`, `sculpt-retopology-workflow`, `nurbs-spline-surfaces`, `geometry-nodes-procedural` |
| Surface and texture | `pbr-lookdev`, `shader-craft`, `uv-unwrap-packing`, `texture-baking-pipeline`, `npr-toon-outline` |
| Light and atmosphere | `lighting-ibl-shadows`, `raytracing-light-transport`, `volumetrics-atmosphere` |
| Image | `post-processing-stack`, `antialiasing-resolution`, `color-management-grading`, `render-passes-aov` |
| Rigging and animation | `rigging-skeleton-ik`, `deformers-blendshapes-morph`, `animation-curves-graph-editor`, `character-animation-retarget` |
| Camera | `cinematic-camera-rig` |
| Motion and interaction | `motion-choreography`, `physics-rigidbody`, `hud-ui-labels`, `realtime-engine-features` |
| Simulation and environment | `cloth-fluid-simulation`, `fur-hair-grass-systems`, `ocean-terrain-environment` |
| Scene and tooling | `scene-assembly-prefabs`, `scene-editor-viewport-tools` |
| Delivery | `gltf-asset-pipeline`, `blender-to-three-export`, `performance-budget` |
| Gate | `render-qa` |

## Agents

| Agent | Give it |
|---|---|
| `3d-tech-artist` | Multi-stage build or upgrade, end to end |
| `3d-lookdev-artist` | Materials, light, post and grade on final geometry |
| `3d-shader-engineer` | A shader that must compile and look right |
| `3d-performance-engineer` | Profiling, budgets, asset compression |
| `3d-render-critic` | Read-only review that returns SHIP or ITERATE |

Brief each agent with the user's goal, the file path, the brief, the tier, and the stage's acceptance criteria. Run independent stages in parallel (shader work and asset compression). Run look-dev and post only after geometry is final. The critic never edits, and it is never the agent that built the work.

## Autonomy

Reversible work in the project folder proceeds without asking. Pause before deleting source assets, force-pushing, publishing or deploying, and downloading large HDRIs or models from a source the user did not name.

## Reply

Open with the goal. Then give the before and after screenshots, the QA table (draw calls, triangles, warnings), what changed per stage, and a separate list of what you could not verify (real-GPU frame rate, phone hardware, GLSL compiled on a target device). Mark every claim you measured, inferred or guessed. Name the specialist skills that changed a decision and the choice each one changed.
