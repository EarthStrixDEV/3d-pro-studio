# Character pipeline

Outcome: a skinned character that deforms cleanly, animates from retargeted clips, and fits the tier budget.

1. Check the mesh before rigging. Deformation loops at joints and a sane triangle count come from `sculpt-retopology-workflow`. Textures need `uv-unwrap-packing`.
2. Export from the DCC tool with `blender-to-three-export` (shape keys, actions, axes, units). Load the result with the loader setup in `gltf-asset-pipeline`.
3. Rig and skin with `rigging-skeleton-ik`. Check influences per vertex, bone count against the tier, bind pose, and attach points before any animation.
4. Add facial or corrective shapes with `deformers-blendshapes-morph`. Check morph count and memory cost against the tier.
5. Bring in animation. Edit and layer clips with `animation-curves-graph-editor`. Move clips between skeletons, build state machines and blend trees with `character-animation-retarget`. Mixer basics and crossfades live in `motion-choreography`.
6. Frame the shot with `cinematic-camera-rig` when the character is the hero.
7. Compress animation and assets with `gltf-asset-pipeline`. Run `performance-budget` against the tier table.
8. Run `render-qa` at the rest pose, at extreme poses, and at grazing angles. Read the screenshots. Check the console for skeleton or morph errors.

Dispatch `3d-tech-artist` for the build and `3d-performance-engineer` for step 7 on large rigs.

Reply: poses checked, bone and morph counts against the tier, the QA table, and what is unverified on real hardware.
