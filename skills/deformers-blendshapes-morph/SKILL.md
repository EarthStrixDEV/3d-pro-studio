---
name: deformers-blendshapes-morph
description: Mesh deformation in Three.js, translating Maya blendShape and deformers (lattice, bend, twist, wrap, cluster) and Blender shape keys, lattice and simple deform modifiers into morph targets and vertex-shader deformers. Covers morphTargetInfluences and morphTargetDictionary, relative vs absolute morphs, morph normals, memory and active-target limits, ARKit 52 and FACS-style face sets, corrective shapes driven by bones, animating morphs with AnimationMixer, a lattice and a twist deformer in onBeforeCompile, shadow-pass parity and glTF sparse accessors. Use when a face needs expressions or lip sync, a mesh must squash, bulge or bend, a joint needs a corrective shape, a morph set is too heavy, or a Blender shape key or Maya blendShape must reach the web. Thai triggers มอร์ฟ, shape key, blendshape, สีหน้า, ขยับปาก, ดัดโมเดล, deformer.
argument-hint: "<mesh or face rig, and which shapes or deformations are needed>"
---

# Deformers, Blend Shapes and Morph Targets

Pick the cheapest deformer that gives the shape. Morph targets store every vertex of every shape. A shader deformer stores a handful of numbers.

## 1. Choose the tool

| Need | Use | Cost |
|---|---|---|
| Authored expressions, lip sync, muscle bulges | Morph targets (Blender shape keys, Maya blendShape) | Memory grows with vertices x shapes (section 3) |
| Limb bending, body motion | Skeleton skinning, see `rigging-skeleton-ik` | Per-bone matrices only |
| Skin collapse at elbow, shoulder, hip | Corrective morph driven by a bone (section 5) | One extra shape per problem joint |
| Squash, stretch, bulge, twist, bend, wave, noise | Vertex-shader deformer (section 6) | A few uniforms, no extra memory |
| Soft global shape change, cage-style (Maya lattice, Blender Lattice) | Lattice in vertex shader (section 6) | 27 uniform vec3 |
| Procedural, parametric shape variation | `modifier-stack-parametric` or `geometry-nodes-procedural` | Rebuilds geometry, not per frame |
| Per-vertex physics, cloth, soft body | `cloth-fluid-simulation` | CPU or GPU simulation |

## 2. Morph target basics

```js
const face = gltf.scene.getObjectByName('Face');            // a Mesh or SkinnedMesh with morph targets
const dict = face.morphTargetDictionary;                      // { jawOpen: 0, mouthSmileLeft: 1, ... }
face.morphTargetInfluences[dict.jawOpen] = 0.6;               // 0 = base shape, 1 = full target
```

- The dictionary is built by `Mesh.updateMorphTargets()` from the `name` of each `geometry.morphAttributes.position[i]`. glTF target names come from `extras.targetNames`. If the dictionary is `undefined`, the names are missing: address by index or fix the export.
- **Relative vs absolute.** `geometry.morphTargetsRelative = true` (what `GLTFLoader` sets) means each target stores a delta and the base always has weight 1, so influences add and may exceed 1 together. With `false`, targets hold absolute positions and the base weight becomes `1 - sum(influences)` (checked in the r187 morph shader chunk). For hand-built shapes use `true`, it behaves like Blender relative shape keys.
- A glTF mesh with several primitives becomes a `Group` of meshes, each with its own influences. Drive all of them (one helper that loops `traverse` and applies by name) or merge the primitives in Blender.
- Build a shape in code (useful for a bulge or a generated expression):

```js
const base = geo.attributes.position;
const bulge = new THREE.BufferAttribute(new Float32Array(base.count * 3), 3);   // zero deltas
bulge.name = 'bulge';
for (let i = 0; i < base.count; i++) {
  const w = Math.max(0, 1 - Math.hypot(base.getX(i), base.getY(i)) * 2);           // falloff from the axis
  bulge.setXYZ(i, 0, 0, w * 0.2);                                                  // push along +Z
}
geo.morphAttributes.position = [bulge];
geo.morphTargetsRelative = true;
mesh.updateMorphTargets();                                                         // fills the dictionary and influences
```

## 3. Limits and cost (verified against r187 source)

| Question | Answer |
|---|---|
| How many targets can be active? | Current releases have no "8 active targets" cap. All targets are packed into one float `DataArrayTexture` (one layer per target) and the vertex shader loops over all of them, skipping any with influence 0 (`morphtarget_vertex`). Older releases sorted and capped the active set at a small number (verify which release your project pins before relying on more than 8) |
| What bounds the target count? | The array-texture layer count (WebGL2 guarantees at least 256) and the vertex uniform budget for `morphTargetInfluences[count]`. 52 is safe. Beyond a few hundred, test on the lowest device tier (verify the limit on target hardware) |
| Memory | Float32 RGBA texel per vertex per data kind per target: **vertices x kinds x 16 bytes x targets**. kinds = 1 (positions), 2 (+ normals), 3 (+ colours). Example: 20,000 vertices, 52 targets, positions + normals = 33.3 MB of GPU memory. Positions only = 16.6 MB |
| Vertex cost | The shader loop runs for every vertex every frame, so cost scales with the number of targets present even when most are zero. Cut targets, not just influences |
| Morph normals | Present only if `morphAttributes.normal` exists. They double the memory. Keep them for large shape changes where shading must follow (smile, cheek puff). Drop them for small deltas and recompute nothing, the lighting error is below visibility |
| Instances | `InstancedMesh` has its own `morphTexture` and `setMorphAt(index, mesh)` for per-instance influences. Use for crowds with a shared face set |

Weight budget for a face: split the head into its own mesh with only head vertices, delete targets the experience never uses, and keep the body without morph data. This is usually a 5 to 10x memory cut with no visible change. Check against `performance-budget`.

## 4. Face sets: ARKit 52 and FACS

ARKit blend shapes (Apple's `ARFaceAnchor.BlendShapeLocation` names) are the de facto web standard because Ready Player Me, Apple face tracking, MediaPipe face landmarker and most lip-sync tools output them. They approximate FACS action units.

```js
export const ARKIT = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];                                                                                  // 52 entries

export function missingShapes(mesh) {
  return ARKIT.filter((n) => !(n in (mesh.morphTargetDictionary ?? {})));           // audit a model on load
}
export function applyWeights(meshes, weights) {                                      // weights: { jawOpen: 0.4, ... }
  for (const m of meshes) for (const [name, v] of Object.entries(weights)) {
    const i = m.morphTargetDictionary?.[name];
    if (i !== undefined) m.morphTargetInfluences[i] = v;
  }
}
```

Rules:
- Left and right in ARKit names are the subject's own left and right, which look mirrored from the camera. Check one asymmetric shape (`eyeBlinkLeft`) against the render before wiring tracking (verify per asset).
- Audit with `missingShapes` before any animation work. A partial set (Ready Player Me ships extra visemes, some assets omit tongue and eye look) must degrade gracefully, which `applyWeights` does by skipping absent names.
- FACS names map loosely: AU1 and AU2 to `browInnerUp` and `browOuterUp*`, AU4 to `browDown*`, AU12 to `mouthSmile*`, AU26 and AU27 to `jawOpen`, AU45 to `eyeBlink*`. Tracking output is smoothed already, but scripted animation should be damped (see `motion-choreography`).
- Lip sync: map visemes or audio amplitude to `jawOpen`, `mouthFunnel`, `mouthPucker`, `mouthClose`, `mouthSmile*`. Smooth with `MathUtils.damp` at lambda 15 to 25. An amplitude-only fallback driving `jawOpen` alone reads as acceptable at distance.
- Blink: random interval 2 to 6 s, close in 0.07 s, open in 0.12 s, never together with a hard look-down so the lid does not clip. Layer blink on top of whatever else drives the eyes.
- Mirror one-sided authoring: if only `Left` shapes exist, build `Right` by mirroring in the DCC. Do not mirror at runtime.

## 5. Corrective shapes

Maya pose space deformation and Blender shape keys driven by a bone angle: the mesh collapses at a joint, a corrective shape fixes it at one pose, a driver fades it in. In JS the driver is a function:

```js
export function makeCorrective(bone, mesh, shapeName, { fromDeg = 20, toDeg = 110 } = {}) {
  const rest = bone.quaternion.clone();                            // capture at rest, before any clip plays
  const idx = mesh.morphTargetDictionary[shapeName];
  return () => {                                                    // call every frame after mixer.update(dt)
    const deg = THREE.MathUtils.radToDeg(rest.angleTo(bone.quaternion));
    mesh.morphTargetInfluences[idx] = THREE.MathUtils.smoothstep(deg, fromDeg, toDeg);
  };
}
```

- Sculpt the corrective at the pose where the artefact is worst, in Blender by moving the armature to that pose and adding a shape key. Export it as a relative target.
- **Combination shapes** (for example `jawOpen` with `mouthSmile` clipping lips): set the corrective influence to the product of the two source influences. Maya calls this a combination target.
- **In-between targets** (Maya) are not a glTF concept. Split into two shapes and cross-fade, or chain: influence A = clamp(w * 2, 0, 1), influence B = clamp(w * 2 - 1, 0, 1).
- Correctives live in the morph set, so they inherit the memory cost in section 3. Prefer extra twist bones for forearm and hip candy-wrapper, they cost nothing in the morph texture.

## 6. Shader deformers (Maya deformers, Blender Simple Deform and Lattice)

Patch rules and the `customProgramCacheKey` habit live in `shader-craft`. Deformers go into `begin_vertex`, which runs before morph targets and skinning, so they deform the rest shape and everything downstream follows.

### Twist (Maya twist deformer, Blender Simple Deform Twist)

```js
export function addTwist(material, uniforms) {                 // uniforms = { uTwist: { value: 0 } }
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTwist;
        vec2 twistXZ(vec2 v, float y) { float a = uTwist * y; float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal.xz = twistXZ(objectNormal.xz, position.y);`)           // normal follows, exact for small twist
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.xz = twistXZ(transformed.xz, position.y);`);
  };
  material.customProgramCacheKey = () => 'twist-v1';
}
```

The same pattern gives bend (rotate around Z by an angle proportional to `position.x`), squash and stretch (scale one axis by a volume-preserving amount, scale the others by its inverse square root), wave (offset along a normal by `sin(position * freq + time)`), flare and taper (scale XZ by a function of Y).

### Lattice (Maya lattice, Blender Lattice modifier)

Free-form deformation on a 3x3x3 grid of offsets. Trilinear blend between the 8 corners of the cell that holds the vertex.

```js
export function addLattice(material, bounds) {                      // bounds: THREE.Box3 around the mesh in object space
  const lattice = Array.from({ length: 27 }, () => new THREE.Vector3());   // offsets: index = x + 3y + 9z
  material.onBeforeCompile = (s) => {
    s.uniforms.uLatMin = { value: bounds.min };
    s.uniforms.uLatSize = { value: bounds.getSize(new THREE.Vector3()) };
    s.uniforms.uLat = { value: lattice };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uLatMin; uniform vec3 uLatSize; uniform vec3 uLat[27];
        vec3 latticeOffset(vec3 p) {
          vec3 u = clamp((p - uLatMin) / uLatSize, 0.0, 1.0) * 2.0;
          ivec3 i0 = min(ivec3(u), ivec3(1));
          vec3 f = u - vec3(i0);
          vec3 r = vec3(0.0);
          for (int k = 0; k < 2; k++) for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
            float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) * (k == 0 ? 1.0 - f.z : f.z);
            r += uLat[(i0.x + i) + 3 * (i0.y + j) + 9 * (i0.z + k)] * w;
          }
          return r;
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += latticeOffset(position);`);
  };
  material.customProgramCacheKey = () => 'lattice-v1';
  return lattice;                                                    // mutate lattice[i].set(x, y, z) each frame, no re-upload code needed
}
```

Rules for both:
- **Shadows.** The depth pass uses another material. Give the mesh a `customDepthMaterial` (`MeshDepthMaterial` with `depthPacking: THREE.RGBADepthPacking`) patched with the same code and shared uniform objects, and a `customDistanceMaterial` for point lights, or the shadow stays undeformed.
- **Normals** are exact for twist (small angles) and unchanged for the lattice. For a strong lattice deformation, bake lighting cues into a normal map or accept flat shading error.
- Deformers act on one material. Several meshes sharing a material deform together, clone the material for independent control.
- Cull bounds are not updated by shader deformation. Set `mesh.frustumCulled = false` or enlarge `geometry.boundingSphere` if the deformation can push vertices past the original bounds.
- Do not mix a shader deformer with CPU readbacks (`getVertexPosition`, raycast). Raycasts hit the undeformed shape.

## 7. Animate morphs with AnimationMixer

Tracks address morph targets by dictionary name, which keeps clips readable and survives target re-ordering:

```js
const clip = new THREE.AnimationClip('talk', 1, [
  new THREE.NumberKeyframeTrack('Face.morphTargetInfluences[jawOpen]', [0, 0.25, 0.5, 1], [0, 0.8, 0.2, 0]),
]);
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(clip).play();                                         // verified: influence reaches 1.0 at t = 0.5 in a 3-key test
```

- The node name before `.morphTargetInfluences` must exist in the root's subtree. Sanitise unusual names with `THREE.PropertyBinding.sanitizeNodeName`.
- Face clips and body clips can play together because they touch different properties. Weight each action separately, see `character-animation-retarget` for state machines and blend weights and `animation-curves-graph-editor` for additive layers and curve editing.
- The mixer writes only tracked targets. Anything you set by hand (blink, lip sync) on a tracked name is overwritten each frame. Drive different targets, or apply your values after `mixer.update(dt)` as an offset.
- Large clips with 52 tracks sampled at 30 fps are big. Resample and compress, see section 8.

## 8. glTF delivery

| Step | Command or rule | Effect |
|---|---|---|
| Sparse accessors | `npx @gltf-transform/cli sparse in.glb out.glb` (verified in 4.5.1: stores accessors with at least a third zeros sparsely, aimed at morph targets) | Smaller file and download |
| Reload cost | `GLTFLoader` expands sparse accessors into dense arrays on load (r187 source) | No GPU memory saving. The morph texture is dense regardless |
| Animation size | `npx @gltf-transform/cli resample in.glb out.glb` (see `gltf-asset-pipeline`) | Removes redundant keys, important for 52 face tracks |
| Compression | `meshopt` compresses morph data and animation. Draco does not cover morph targets in glTF (verify with your decoder version) | Prefer Meshopt for faced characters |
| Blender export | Shape Keys on, optionally Shape Key Normals for large shapes, and "Use Sparse Accessor if better" (option name in recent exporters, verify) | Controls what reaches the file |
| Maya export | glTF from Maya needs a plugin or an FBX to Blender step (verify your pipeline). FBX blend shape channels become targets named after the channel | Check names after import |

Clean the shape set in Blender before export: drop empty or duplicate shapes and keep one UV set. See `blender-to-three-export`.

## 9. Verify

1. `missingShapes(face)` returns an empty array, or only shapes the product does not need.
2. Drive each shape to 1.0 one at a time in a debug slider panel, screenshot front and three-quarter (`render-qa`). Look for inverted left and right, clipping and normals that look flat.
3. Drive the worst combinations at once (`jawOpen` with `mouthSmile*`, `eyeBlink*` with `browDown*`). Corrective needed if lips or lids intersect.
4. Rotate every corrective joint through its range, no popping of the correctives.
5. Check GPU memory: `renderer.info.memory.textures` before and after loading the character, and compute vertices x kinds x 16 x targets by hand. Compare with the tier table in `performance-budget`.
6. Shadows: shader deformers must show in the shadow, orbit and look.
7. Console clean, no shader compile errors from the patched materials.

Related: `rigging-skeleton-ik` for bones and skin weights, `character-animation-retarget` for moving clips, `animation-curves-graph-editor` for curve work, `shader-craft` for patch rules, `performance-budget` for tiers.
