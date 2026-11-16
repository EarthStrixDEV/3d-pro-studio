---
name: rigging-skeleton-ik
description: Rigging in Three.js, translating Maya joints, IK handles, constraints and Blender armatures, bone constraints into Skeleton, Bone, SkinnedMesh, bind pose, skin weights (4 influences per vertex), bone-count limits, CCDIKSolver, a FABRIK chain solver, look-at and aim constraints on bones, props attached to bones, root-motion stripping and SkeletonHelper debugging. Use when a character or creature must be rigged, posed or aimed at runtime, when skinning looks twisted, stretched or collapsed, when a head, eye, arm or foot must follow a target, when a prop must stick to a hand, or when a rig imported from Maya or Blender misbehaves. Thai triggers กระดูก, สเกเลตัน, ผูกกระดูก, rig ตัวละคร, IK, หันหน้าตามเป้าหมาย, skin weight เพี้ยน.
argument-hint: "<rig or model file, and what the bones should do>"
---

# Rigging, Skeleton and IK

A rig in Three.js is only a bone hierarchy plus per-vertex weights. Everything else from Maya or Blender (IK handles, constraints, drivers, control curves) does not survive export and must be baked or re-solved in JS. Decide that first.

## 1. What survives export

| Maya / Blender feature | In Three.js | Action |
|---|---|---|
| Joint / armature bone | `Bone` (an `Object3D`) inside a `Skeleton` | Keep. Names must be unique |
| Joint orient / bone roll | Baked into the bone's rest quaternion | Check with `SkeletonHelper` (section 8) |
| Skin cluster / Armature modifier | `SkinnedMesh` with `skinIndex` and `skinWeight` | Keep, limit to 4 influences (section 3) |
| IK handle, Blender IK constraint | Not exported | Bake to keyframes offline, or re-solve with section 5 |
| Pole vector, Damped Track, Aim constraint | Not exported | Section 6 |
| Copy Rotation, Child Of, Parent constraint | Not exported | Bake, or parent an `Object3D` manually |
| Limit Rotation | Not exported | `rotationMin` and `rotationMax` on a CCD link |
| Control curves and custom shapes | Not exported | Delete. Never ship rig controls |
| Set Driven Key, Blender drivers | Not exported | JS function, see `animation-curves-graph-editor` |
| Dual quaternion skinning, Preserve Volume | No core support (verify) | Add twist or corrective bones and weights in the DCC |

Bake rule: if the shipped clip must look identical to the DCC, bake IK and constraints to plain bone keys in Blender or Maya (`blender-to-three-export`), then play with `AnimationMixer`. Runtime IK is for things the DCC cannot know: a foot meeting uneven ground, a head following the cursor, a hand reaching a clicked object.

## 2. Build and bind

```js
const bones = [hip, spine, head];                       // parent before child
const skeleton = new THREE.Skeleton(bones);
const mesh = new THREE.SkinnedMesh(geometry, material);
mesh.add(bones[0]);                                     // root bone under the mesh (or a sibling)
mesh.bind(skeleton);                                    // bind pose = pose at this moment
```

- `bind(skeleton)` without a matrix calls `calculateInverses()` and uses `mesh.matrixWorld` as the bind matrix. Pose the bones in the rest pose first, bind second. Binding in a dance pose bakes that pose in.
- `skeleton.pose()` returns every bone to the bind pose. Call it before retargeting or when IK leaves bones dirty.
- `bindMode`: `AttachedBindMode` (default, `'attached'`) follows the mesh transform. `DetachedBindMode` (`'detached'`) keeps the bind matrix fixed, so one skeleton can drive meshes that move independently.
- Weights not summing to 1 stretch the mesh. After building weights in code call `mesh.normalizeSkinWeights()`.
- Clone a rigged character with `SkeletonUtils.clone(gltf.scene)` (`three/addons/utils/SkeletonUtils.js`). `Object3D.clone()` makes meshes that still point at the original skeleton and they move together.
- Each `SkinnedMesh` uploads its bone matrices every frame. Ten identical crowd members on ten skeletons cost ten uploads. See `performance-budget` before scaling a crowd.

## 3. Limits that decide the rig

| Limit | Value | Consequence |
|---|---|---|
| Influences per vertex | 4. Shader reads one `vec4` `skinIndex` and one `vec4` `skinWeight` | A fifth influence is ignored, never blended. The glTF loader maps only `JOINTS_0` and `WEIGHTS_0`, so a second set (`JOINTS_1`) is dropped silently (checked in r187). Limit to 4 and normalise in Blender (Weights, Limit Total, Normalize All) or Maya (max influences 4) before export |
| Bone count | Bones live in a float `DataTexture`, 4 texels per bone, so there is no uniform cap in current releases (checked in r187: `Skeleton.computeBoneTexture`) | Cap is the max texture size, thousands of bones. The real cost is per-frame upload and CPU matrix work. Budget 60 to 150 bones for a hero, 20 to 40 for crowd members (guess, profile) |
| Older releases | Bone matrices were uniforms with a hard cap and a mobile fallback (verify the release if you must support it) | Pin the Three.js version in the plugin and test on the lowest device tier |
| Vertex texture fetch | Required for the bone texture. WebGL2 always has it | No action on current browsers |

Skin-weight sanity check, run once after load:

```js
function checkSkin(mesh) {
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const nb = mesh.skeleton.bones.length, r = { verts: si.count, unnormalized: 0, zero: 0, badIndex: 0 };
  for (let i = 0; i < si.count; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      sum += w;
      if (w > 0 && si.getComponent(i, k) >= nb) r.badIndex++;
    }
    if (sum < 1e-3) r.zero++;                       // unweighted vertex stays at the origin
    else if (Math.abs(sum - 1) > 0.01) r.unnormalized++;
  }
  return r;                                         // all three counters must be 0
}
```

| Symptom | Cause | Fix |
|---|---|---|
| Vertices stuck at the origin or stretched to a point | `zero > 0`: no weights | Weight them in the DCC |
| Mesh swells or shrinks when posed | `unnormalized > 0` | `normalizeSkinWeights()` or re-normalise in the DCC |
| Candy-wrapper twist at forearm or hip | Linear blend skinning limit | Add twist bones, or a corrective morph (`deformers-blendshapes-morph`) |
| Mesh vanishes at screen edge while animating | Bounds computed at bind pose and cached | `mesh.frustumCulled = false` for the hero, or `mesh.computeBoundingSphere()` on a representative pose (verify it covers the full range of motion) |
| Rig is lying down or rotated 90 degrees | Z-up DCC export, bone roll or unapplied transforms | Apply transforms before export, see `blender-to-three-export` |

## 4. Bones are Object3Ds

```js
const hand = skeleton.getBoneByName('mixamorigRightHand');   // undefined if missing, check
```

- Pose by setting `bone.quaternion` (local space). Bones accept `lookAt`, `add`, `attach` like any `Object3D`.
- Order per frame: `mixer.update(dt)`, then your IK or aim code, then render. The mixer overwrites every animated bone each frame, so anything you set before it is lost.
- Only touch bones that no active clip animates, or blend after the mixer with a weight.

## 5. IK

Pick by the question, not by habit:

| Need | Solver | Why |
|---|---|---|
| Limb with joint limits (knee, elbow) | `CCDIKSolver` | Built in, supports per-link rotation limits and a blend factor |
| Long chain with no limits (tail, tentacle, spine, rope) | FABRIK below | Converges in few iterations, no limits needed |
| Foot on ground, hand on prop, head to target | `CCDIKSolver` with 2 to 3 links | Cheap enough per frame |
| Must match a Maya or Blender IK exactly | Bake offline | Runtime solvers differ from DCC solvers |

### CCDIKSolver (three/addons/animation/CCDIKSolver.js)

```js
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';

const iks = [{
  target: 22,                       // index into skeleton.bones: a bone you move yourself
  effector: 5,                      // index of the tip bone (hand, foot)
  links: [                          // from the effector's parent up toward the root
    { index: 4, rotationMin: new THREE.Vector3(-2.2, 0, 0), rotationMax: new THREE.Vector3(0, 0, 0) }, // elbow hinge
    { index: 3 },                   // shoulder, free
  ],
  iteration: 8,                     // default 1. Raise for precision, costs CPU
  // blendFactor: 0..1 per chain, optional
}];
const ik = new CCDIKSolver(skinnedMesh, iks);
scene.add(ik.createHelper());       // debug lines and spheres, remove for production

// per frame, after mixer.update(dt):
targetBone.position.copy(desiredPositionInTargetParentSpace);
ik.update();                        // or ik.update(0.5) for a global blend factor
```

Verified behaviour (r187, 3-bone chain reached a world target 2 units away within 10 iterations):
- `target` and `effector` are indices into `skeleton.bones`, not bone objects. The target bone must exist in the skeleton, so add an empty bone to the rig in the DCC and export it.
- `links` order matters: the effector's parent first, root-most last.
- `rotationMin` and `rotationMax` are `Vector3` limits per axis in the link's local space. A hinge joint sets one axis range and zeroes the others.
- Per-link `enabled: false` stops the chain at that link. `ik.blendFactor` fades IK in and out, for example while a foot is airborne.
- CCD can twist an unlimited chain. Always limit knees and elbows.

### FABRIK chain (not in Three.js core, tested)

Works in world space on a chain of bones, then writes local rotations. No joint limits, so use it for tails, spines, tentacles.

```js
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _w = new THREE.Quaternion(), _pw = new THREE.Quaternion();

export function fabrik(bones, target, iterations = 10, tolerance = 1e-3) {
  const n = bones.length - 1;
  const p = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
  const len = Array.from({ length: n }, (_, i) => p[i + 1].distanceTo(p[i]));
  const root = p[0].clone();

  if (root.distanceTo(target) >= len.reduce((s, l) => s + l, 0)) {          // out of reach: stretch straight
    const dir = target.clone().sub(root).normalize();
    for (let i = 0; i < n; i++) p[i + 1].copy(p[i]).addScaledVector(dir, len[i]);
  } else {
    for (let it = 0; it < iterations && p[n].distanceTo(target) > tolerance; it++) {
      p[n].copy(target);                                                       // backward pass
      for (let i = n - 1; i >= 0; i--) { _a.subVectors(p[i], p[i + 1]).normalize(); p[i].copy(p[i + 1]).addScaledVector(_a, len[i]); }
      p[0].copy(root);                                                         // forward pass
      for (let i = 0; i < n; i++) { _a.subVectors(p[i + 1], p[i]).normalize(); p[i + 1].copy(p[i]).addScaledVector(_a, len[i]); }
    }
  }
  for (let i = 0; i < n; i++) {                                                // write rotations root to tip
    const bone = bones[i];
    bone.updateWorldMatrix(true, true);
    const cur = _a.setFromMatrixPosition(bones[i + 1].matrixWorld).sub(_b.setFromMatrixPosition(bone.matrixWorld)).normalize();
    const want = _b.subVectors(p[i + 1], p[i]).normalize();
    _q.setFromUnitVectors(cur, want);
    bone.getWorldQuaternion(_w).premultiply(_q);
    bone.quaternion.copy(bone.parent.getWorldQuaternion(_pw).invert().multiply(_w));
  }
  bones[0].updateWorldMatrix(true, true);
}
```

Pass the chain root to tip. The tip bone keeps its own rotation, so aim it separately if it must face the target. Limit `iterations` to 4 to 10 per frame.

## 6. Look-at and aim constraints on a bone

`Object3D.lookAt` points the +Z axis of a non-camera object at a world target. Bones usually point along +Y toward their child, and `lookAt` ignores the parent's rotation, so it flips heads and eyes. Use an aim axis and clamp the angle:

```js
const AIM = new THREE.Vector3(0, 1, 0);                  // the bone's forward axis in its own space (check with SkeletonHelper)
const _want = new THREE.Quaternion(), _lim = new THREE.Quaternion();

export function aimBone(bone, targetWorld, restQ, { maxAngle = Math.PI / 3, lambda = 10, dt = 1 / 60 } = {}) {
  bone.parent.updateWorldMatrix(true, false);
  const local = bone.parent.worldToLocal(targetWorld.clone()).sub(bone.position).normalize();
  _want.setFromUnitVectors(AIM.clone().applyQuaternion(restQ), local).multiply(restQ);
  const ang = restQ.angleTo(_want);
  if (ang > maxAngle) _want.copy(_lim.copy(restQ).slerp(_want, maxAngle / ang));   // clamp, then damp
  bone.quaternion.slerp(_want, 1 - Math.exp(-lambda * dt));
}
// restQ = bone.quaternion.clone() captured at rest, before any animation plays
```

- Clamp head to about 60 degrees and eyes to about 25 degrees. Beyond that the neck snaps. Spread one look across neck, head, eyes with decreasing weight for natural motion.
- Run after `mixer.update(dt)`. If a clip animates the head, apply the aim as an additive offset on top, or fade the weight in only while a target exists.
- Damping and spring helpers live in `motion-choreography`.

## 7. Attach props to bones

```js
const socket = new THREE.Object3D();                      // a stable offset, tweak once, never the prop itself
socket.position.set(0, 0.04, 0.02);
socket.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
hand.add(socket);
socket.add(sword);
```

- Add to the bone, not to the mesh. The bone moves every frame and drags the child with it.
- Bone world scale is often not 1 after export (centimetre rigs). If the prop looks 100x too big or small, set the socket scale to the inverse of `hand.getWorldScale(new THREE.Vector3())`.
- Swap props by changing `socket` children. Dispose geometry and material of removed props.
- Props on a cloned character (`SkeletonUtils.clone`) must be attached after the clone, to the clone's bone.
- Shadows and picking: the prop is a normal mesh, so `castShadow` and raycast work as usual.

## 8. Debug

```js
const helper = new THREE.SkeletonHelper(gltf.scene);       // pass the object that contains the bones
helper.material.depthTest = false;                          // draw through the mesh
scene.add(helper);
```

Check in order:
1. Bone chains look continuous and joints sit inside the body. A bone floating outside the mesh means a wrong bind pose.
2. Bone local axes: add an `AxesHelper` as a child of the bone that misbehaves (`bone.add(new THREE.AxesHelper(0.1))`). The visible axis that points at the child is your `AIM`.
3. With animation off (`skeleton.pose()`), the mesh must match the DCC bind pose. If it does not, the export or `bind` order is wrong.
4. Run `checkSkin`. Fix zero, unnormalised and out-of-range counts before anything else.
5. Rotate each limb bone by 45 degrees in the console and watch for twisting weights.

## 9. Root motion

A clip with a moving root drags the character in place of the game logic. Decide: root-motion clips for cinematics, in-place clips for gameplay. Mechanics:

```js
export function stripRootMotion(clip, rootPositionTrack, lockAxes = [1, 0, 1]) {   // [x, y, z]: 1 locks that axis to the first key
  const t = clip.tracks.find((tr) => tr.name === rootPositionTrack);               // e.g. 'mixamorigHips.position'
  if (!t) throw new Error(`No track ${rootPositionTrack}`);
  const v = t.values, n = t.times.length;
  const delta = new THREE.Vector3(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) if (lockAxes[k]) v[i * 3 + k] = v[k];
  return delta;                                                                     // travel per loop, speed = delta.length() / clip.duration
}
```

Use the returned speed to match locomotion to world speed (stride sync, foot slide) in `character-animation-retarget`. Clone the clip first if the original is reused. Keep Y unlocked for the hip bob.

## 10. Verify

1. `SkeletonHelper` on, `skeleton.pose()`: mesh matches the DCC bind pose.
2. `checkSkin` returns zeros.
3. Play every clip, orbit around the character, look for twisting at shoulders, hips and wrists.
4. IK: drag the target through its full range and past it. The chain must not flip, NaN or pop.
5. Aim: move the target behind the head. The head must stop at the clamp, not spin.
6. Capture with `render-qa`, including one pose at the screen edge to catch frustum culling.
7. Confirm bone count and `renderer.info` against the tier in `performance-budget`.

Related: `deformers-blendshapes-morph` for corrective shapes and faces, `animation-curves-graph-editor` for clip editing, `character-animation-retarget` for moving clips between rigs, `physics-rigidbody` for ragdolls and secondary motion, `blender-to-three-export` for exporting rigs.
