# 3D Pro Studio

**English** | [ภาษาไทย](README.th.md)

A Claude Code plugin of agents and skills for **advanced, high-quality** real-time 3D in Three.js (WebGL/WebGPU). Use it for product viewers, hero sections, 3D artifacts, configurators and cinematic scenes that need to look premium, not like a demo.

It is a framework: one core skill (`3d-pro-studio-mode`) routes any 3D task to a playbook, which loads the right specialist skills in order and delegates to five specialist agents. Nothing is called done until a headless render-QA script has screenshotted, measured and critiqued the scene. It ships a pipeline skill, fifty-six specialist skills, ten playbooks, five agents and a tested pro scene template.

![hero](.claude-plugin/icon.png)

## How it fits together

```
/3d-pro-studio:3d-pro-studio-mode   <task>
        |
        |-- routes to a playbook (new scene, upgrade, visual bug, performance,
        |   asset prep, interactive layer, character, surface and bake, world and FX, VFX)
        |-- loads the specialist skills that playbook names, in order
        |-- delegates stages to the specialist agents
        '-- gates the result with render-qa (screenshots + numbers + rubric)
```

The mode skill holds rules and routing only. Techniques live in the specialist skills, and playbooks point to them by name.

## What's inside

### Skills (`/3d-pro-studio:<name>`)

**Core**

| Skill | Use it when |
|---|---|
| `3d-pro-studio-mode` | **Start here for any 3D task.** Routes to a playbook, loads the right skills, delegates to the agents, and gates on render-qa |
| `3d-pro-pipeline` | Building a new scene: the whole pipeline (brief, blockout, look-dev, post, motion, perf, QA) plus the pro scene template |

**Form and mesh**

| Skill | Use it when |
|---|---|
| `mesh-texture-upscale` | Faceted meshes or blurry textures up close: subdivision, displacement, texel density, per-map texture upscaling, detail maps |
| `sculpt-retopology-workflow` | Sculpt to retopo to bake: edge flow, triangle budgets, decimation, hand-off to baking |
| `nurbs-spline-surfaces` | Loft, revolve, sweep and NURBS surfaces turned into smooth meshes |
| `geometry-nodes-procedural` | Blender Geometry Nodes style attributes, surface sampling and instance-on-points in JS |
| `modifier-stack-parametric` | 3ds Max style non-destructive modifier stack: Bend, Twist, Mirror, Array, Boolean, Sweep |
| `mograph-procedural` | Cinema 4D MoGraph style cloners, effectors and fields on `InstancedMesh` |

**Surface and texture**

| Skill | Use it when |
|---|---|
| `pbr-lookdev` | Materials look plastic or CG: MeshPhysical (clearcoat, transmission, sheen, iridescence, anisotropy) plus a library of 20+ material presets |
| `shader-craft` | GLSL/TSL, onBeforeCompile, noise, fresnel, triplanar, dissolve, hologram, procedural geometry |
| `uv-unwrap-packing` | Stretched or bleeding textures: seams, texel density, island packing, second UV set, atlas instead of UDIM |
| `texture-baking-pipeline` | Bake AO, normal, curvature and lightmaps, normal map conventions, ORM packing |
| `npr-toon-outline` | Toon shading, outlines, halftone and ink looks |

**Light and atmosphere**

| Skill | Use it when |
|---|---|
| `lighting-ibl-shadows` | The image is flat, washed out, or objects float: IBL/HDRI, light rigs, tone mapping, shadow tuning, grounding |
| `raytracing-light-transport` | Light looks fake or lacks bounce: light-incidence math, baked vs screen-space vs path-traced lighting, `three-gpu-pathtracer`, tier fallbacks |
| `volumetrics-atmosphere` | Height fog, god rays, volumetric clouds, sky models, cost per tier |

**Image**

| Skill | Use it when |
|---|---|
| `post-processing-stack` | Correct pass order, bloom that doesn't haze, artifact-free GTAO, DOF, LUT grading |
| `antialiasing-resolution` | Jagged edges or shimmer: MSAA, SSAA, SMAA, FXAA, TAA, alpha-to-coverage, adaptive resolution |
| `color-management-grading` | View transforms, working vs display space, tone mapping, LUTs, matching DCC colour in the browser |
| `render-passes-aov` | Depth, normal, ID and emission passes with multiple render targets, debug view modes |

**Rigging and animation**

| Skill | Use it when |
|---|---|
| `rigging-skeleton-ik` | Skeletons, skinning limits, IK and constraints, attaching props, debugging |
| `deformers-blendshapes-morph` | Morph targets, face blendshapes, corrective shapes, shader deformers |
| `animation-curves-graph-editor` | Keyframe tracks, interpolation limits, additive layers, drivers and time warp |
| `character-animation-retarget` | Retargeting clips, state machines, blend trees, mocap cleanup, animation compression |
| `cinematic-camera-rig` | Focal length and film back, depth of field mapping, dolly and crane rigs, shake, camera cuts |

**Motion and interaction**

| Skill | Use it when |
|---|---|
| `motion-choreography` | Frame-rate-independent damping and springs, intro camera moves, scroll-driven scenes, interaction, AnimationMixer, reduced motion |
| `physics-rigidbody` | Realistic physics: Rapier and cannon-es, fixed timestep, colliders, CCD, constraints, stacking stability |
| `hud-ui-labels` | HUDs and in-scene labels: CSS2DRenderer, occlusion, declutter, touch targets, accessibility, Thai text |
| `realtime-engine-features` | Unreal style features on the web: Niagara particles, Sequencer timeline, Nanite and Lumen substitutes, decals |

**Simulation and environment**

| Skill | Use it when |
|---|---|
| `cloth-fluid-simulation` | Verlet cloth, soft bodies, heightfield water, and what the web cannot do |
| `fur-hair-grass-systems` | Instanced grass, shell fur, hair cards, wind, LOD |
| `ocean-terrain-environment` | Ocean waves, foam, heightmap terrain, LOD, splat texturing |

**VFX: particles**

| Skill | Use it when |
|---|---|
| `particle-system-architecture` | The shared particle data shape: emitters, modules, typed buffers, pooling, CPU vs GPU choice |
| `gpu-particles-compute` | Millions of particles: ping-pong textures, WebGPU compute, tier fallbacks |
| `particle-forces-fields` | Gravity, drag, wind, vortex, curl noise, attractors, collisions |
| `particle-rendering-blending` | Billboards, stretched and mesh particles, soft particles, blend modes, overdraw |
| `particle-trails-ribbons` | Trails, ribbons, beams, lightning, width and colour over life |

**VFX: effects**

| Skill | Use it when |
|---|---|
| `vfx-fire-smoke-explosion` | Fire, smoke, explosions, debris, shockwaves |
| `vfx-magic-energy-stylized` | Magic casts, auras, energy beams, shields, portals, hit flashes |
| `vfx-weather-environment` | Rain, snow, splashes, dust, fireflies, leaves |
| `vfx-impact-sparks-decals` | Hit sparks, bullet impacts, projected decals |
| `vfx-flipbook-authoring` | Sprite sheets and flipbooks from Blender or Houdini, noise and ramp textures |

**VFX: 3D simulation**

| Skill | Use it when |
|---|---|
| `fluid-sph-3d` | 3D liquids with SPH or PBF and surface rendering |
| `grid-fluid-smoke` | Grid-based smoke and fire with pressure projection and volume rendering |
| `soft-body-xpbd` | Jelly and soft bodies with XPBD |
| `rigid-destruction-fracture` | Runtime fracture, debris, breakable constraints |
| `granular-sand-snow-sim` | Sand, snow, avalanching heightfields, footprints |

**VFX: pipeline**

| Skill | Use it when |
|---|---|
| `vfx-graph-authoring` | Effects as validated data: presets, live editing, hot reload |
| `vfx-timing-choreography` | Burst curves, hit stop, slow-motion, shake and flash timing |
| `vfx-post-fx-compositing` | Heat distortion, chromatic aberration, speed lines, glitch, pass order |
| `vfx-performance-scaling` | Effect budgets, overdraw, effect LOD, quality presets |
| `sim-cache-baking-vat` | Bake offline simulation and play it back with vertex animation textures |

**Scene and tooling**

| Skill | Use it when |
|---|---|
| `scene-assembly-prefabs` | Prefabs, safe cloning, asset manifests, lazy loading, disposal |
| `scene-editor-viewport-tools` | In-browser editor: gizmos, picking, snapping, undo stack, ortho views |

**Delivery and gate**

| Skill | Use it when |
|---|---|
| `gltf-asset-pipeline` | gltf-transform (Meshopt/Draco/KTX2/WebP), loader setup, model normalisation |
| `blender-to-three-export` | Blender to glTF: exporter settings, PBR mapping, shape keys, animation, headless export |
| `performance-budget` | Device-tier budgets, instancing/batching/LOD, adaptive DPR, memory hygiene |
| `render-qa` | Quality gate: renders multiple angles plus a phone viewport and dark mode, measures exposure/contrast/clipping, checks config, and scores a 10-point rubric |

### Playbooks (`skills/3d-pro-studio-mode/playbooks/`)

| Playbook | Task |
|---|---|
| `new-scene` | A new scene, viewer, hero section or artifact |
| `upgrade-scene` | An existing scene that must look premium |
| `fix-visual-bug` | Slabs, acne, shimmer, black models, floating objects, washed-out frames |
| `performance` | Stutter, heat, memory, slow load |
| `asset-prep` | Preparing, shrinking or sharpening a GLB and its textures |
| `interactive-layer` | Motion, physics, labels, HUD, procedural effects |
| `character-pipeline` | Rigged, animated or retargeted characters, face shapes, character camera |
| `surface-bake` | UV, retopo, baking, colour matching, toon looks, Blender or Maya export |
| `world-and-fx` | Terrain, water, atmosphere, cloth, fur, grass, prefabs, in-browser editor |
| `vfx-pipeline` | Particles, fire, smoke, magic, weather, impacts, liquids, destruction, baked simulation |

### Agents

| Agent | Role |
|---|---|
| `3d-tech-artist` | Lead implementer: builds and upgrades scenes end to end |
| `3d-lookdev-artist` | Tunes materials, lighting, post and grade (doesn't touch geometry) |
| `3d-shader-engineer` | Writes and debugs GLSL/TSL shaders |
| `3d-performance-engineer` | Profiles and optimizes scenes, compresses assets |
| `3d-render-critic` | Read-only QA: scores the scene and returns SHIP / ITERATE |

### Assets & scripts

- `skills/3d-pro-pipeline/assets/pro-scene-template.html`: a tested single-file scene with quality tiers, NeutralToneMapping, a PMREM environment, a key/rim/fill rig, a shadow-catcher ground, a radial backdrop, auto-framing for any aspect ratio, GTAO + bloom + SMAA (including a fix for a GTAO bug found during testing), reduced-motion support and QA hooks.
- `skills/render-qa/scripts/render-check.mjs`: a headless QA script built on Playwright.

## Install

```bash
# Option 1: from GitHub (this repo is also a marketplace)
claude plugin marketplace add EarthStrixDEV/3d-pro-studio
claude plugin install 3d-pro-studio@earth-3d-studio

# or from a local folder
claude plugin marketplace add /path/to/3d-pro-studio

# Option 2: load directly to try it out
claude --plugin-dir /path/to/3d-pro-studio
```

render-qa needs Node 18+ and Playwright (`npm i -D playwright && npx playwright install chromium`).

## Usage

```
/3d-pro-studio:3d-pro-studio-mode build a product viewer for matte black headphones, dark premium mood
/3d-pro-studio:3d-pro-studio-mode the AO shows dark rectangles around the model
/3d-pro-studio:3d-pro-studio-mode rig and animate this GLB character for a phone-friendly page
/3d-pro-studio:render-qa ./index.html
```
Any single skill also works on its own, e.g. `/3d-pro-studio:uv-unwrap-packing`. Or just ask in plain language, e.g. "use 3d-render-critic to review this scene" or "have 3d-performance-engineer cut the draw calls".

```bash
node skills/render-qa/scripts/render-check.mjs scene.html --out qa-out            # hero + 4 orbits + mobile
node skills/render-qa/scripts/render-check.mjs scene.html --out qa-dark --dark    # dark mode
```

## Works with the basic 3D skills

If you also have `3d-idea-brief`, `3d-blockout-modeling`, `3d-camera-director`, `3d-color-light-shadow` and `3d-polygon-upgrade` installed, the pipeline uses them for the brief, modeling and camera stages. This plugin is the advanced layer on top.

## Notes

- The pro scene template is tested with Three.js r170 (pinned in the import map). After upgrading, re-run render-qa, especially for the GTAO patch, which touches internal APIs.
- The code samples in the newer skills were run on Three.js r187 where practical. Items that could not be verified are marked `(verify)` in the skill. Nothing was run on a real GPU or a phone, and Blender and Maya steps were not run inside those tools.
- render-qa FPS under SwiftShader (CPU rendering) is for before/after comparison only. For real numbers, use `--gpu` on a machine with a GPU.

License: MIT
