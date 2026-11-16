---
name: character-animation-retarget
description: Character animation reuse and control in Three.js. Retarget Mixamo, mocap or any humanoid clip onto a custom skeleton (SkeletonUtils.retargetClip and retarget), bone name maps for Mixamo, VRM and Rigify, rest-pose and scale mismatch, root motion versus in-place and speed matching, state machines and blend trees with AnimationMixer weights and crossfades, foot IK basics, mocap cleanup and smoothing, and animation compression with gltf-transform resample. Use when a downloaded animation does not fit the character (twisted limbs, floating, sinking, wrong size, sliding feet), when building idle, walk, run and jump control, when blending clips, when cleaning noisy mocap, or when animation data makes a GLB too big. Thai triggers รีทาร์เก็ต, ย้ายอนิเมชันข้ามตัวละคร, Mixamo, เดินวิ่ง blend, เท้าลื่น, ล็อกเท้า, mocap สั่น, ลดขนาดอนิเมชัน.
argument-hint: "<source clips, target character file, and the control states needed>"
---

# Character Animation Retargeting and Control

Match the method to the mismatch. Most failures come from using a baked retarget where a rename was enough, or the reverse.

## 1. Choose the method

| Situation | Method | Cost |
|---|---|---|
| Clip and character share bone names, rest pose and proportions (Mixamo clip on a Mixamo-named rig, Ready Player Me with Mixamo clips) | Play directly. Clone the character with `SkeletonUtils.clone` | Free |
| Different names, same rest pose, same local bone axes and similar proportions | `renameTracks` (section 3) | Free, no bake |
| Different names, proportions or rest pose (A-pose vs T-pose) | `SkeletonUtils.retargetClip` baked offline (section 4), then `resample` (section 9) | Offline bake, larger clip before compression |
| User mocap or physics blended into a pose every frame | Live `SkeletonUtils.retarget` per frame | Runtime CPU per frame |
| Non-humanoid, extra limbs, different topology | Retarget in the DCC (Blender retarget addons, Maya HumanIK) and bake | Offline, per character |

`three/addons/utils/SkeletonUtils.js` exports exactly three functions in r187: `clone`, `retarget`, `retargetClip` (checked). There is no public bone-lookup helper, use `skeleton.getBoneByName`.

## 2. Bone name maps

`names` is `{ targetBoneName: sourceBoneName }` for `retargetClip` (r187 typedef: "mapping target to source bone names"). Alternatively pass `getBoneName: (bone) => string`.

Name facts:
- FBX Mixamo bones are `mixamorig:Hips`. `PropertyBinding.sanitizeNodeName` strips `[ ] . : /`, so after a glTF import the name is `mixamorigHips` (verify after your own conversion, FBXLoader may differ). Always print `skeleton.bones.map((b) => b.name)` before writing a map.
- Ready Player Me names match Mixamo without the prefix (verify per avatar).
- VRM humanoid names are lower-camel (`leftUpperArm`), Rigify deform bones start with `DEF-` and use `.L` and `.R` (verify for your Rigify version).

```js
// core humanoid rows: [Mixamo / Ready Player Me, VRM, Rigify deform (verify)]
const HUMANOID = [
  ['Hips', 'hips', 'DEF-spine'], ['Spine', 'spine', 'DEF-spine.001'], ['Spine1', 'chest', 'DEF-spine.002'],
  ['Spine2', 'upperChest', 'DEF-spine.003'], ['Neck', 'neck', 'DEF-spine.004'], ['Head', 'head', 'DEF-spine.006'],
  ['LeftShoulder', 'leftShoulder', 'DEF-shoulder.L'], ['LeftArm', 'leftUpperArm', 'DEF-upper_arm.L'],
  ['LeftForeArm', 'leftLowerArm', 'DEF-forearm.L'], ['LeftHand', 'leftHand', 'DEF-hand.L'],
  ['RightShoulder', 'rightShoulder', 'DEF-shoulder.R'], ['RightArm', 'rightUpperArm', 'DEF-upper_arm.R'],
  ['RightForeArm', 'rightLowerArm', 'DEF-forearm.R'], ['RightHand', 'rightHand', 'DEF-hand.R'],
  ['LeftUpLeg', 'leftUpperLeg', 'DEF-thigh.L'], ['LeftLeg', 'leftLowerLeg', 'DEF-shin.L'],
  ['LeftFoot', 'leftFoot', 'DEF-foot.L'], ['LeftToeBase', 'leftToes', 'DEF-toe.L'],
  ['RightUpLeg', 'rightUpperLeg', 'DEF-thigh.R'], ['RightLeg', 'rightLowerLeg', 'DEF-shin.R'],
  ['RightFoot', 'rightFoot', 'DEF-foot.R'], ['RightToeBase', 'rightToes', 'DEF-toe.R'],
];
const FAMILY = { mixamo: 0, vrm: 1, rigify: 2 };

export function buildNames(targetFamily, sourceFamily, { targetPrefix = '', sourcePrefix = '' } = {}) {
  const t = FAMILY[targetFamily], s = FAMILY[sourceFamily];
  return Object.fromEntries(HUMANOID.map((row) => [targetPrefix + row[t], sourcePrefix + row[s]]));
}

export function unmapped(names, targetSkeleton, sourceSkeleton) {                // run before retargeting
  const has = (sk, n) => sk.bones.some((b) => b.name === n);
  return Object.entries(names).filter(([t, s]) => !has(targetSkeleton, t) || !has(sourceSkeleton, s));
}
```

Rules:
- Map the 22 core bones first and check `unmapped` is empty. Fingers, twist bones and face bones are optional, leave them out of the map and they stay at rest.
- Skip bones that do not exist in both. A missing bone never throws, it silently stays in rest pose, so the check is the only warning you get.
- Extra target bones (cloth, hair, jiggle) stay unanimated, drive them with `physics-rigidbody` or a spring.

## 3. Rename, no bake

When bones match in rest pose and axes, renaming tracks is exact and keeps the original keys:

```js
export function renameTracks(clip, names, { hip, scale = 1 } = {}) {           // names: target -> source, same as retargetClip
  const toTarget = Object.fromEntries(Object.entries(names).map(([t, s]) => [s, t]));
  const tracks = [];
  for (const t of clip.tracks) {
    const dot = t.name.indexOf('.'), bone = t.name.slice(0, dot), prop = t.name.slice(dot);
    const to = toTarget[bone];
    if (!to) continue;                                                           // unmapped bones are dropped
    const c = t.clone();
    c.name = to + prop;
    if (prop === '.position' && bone === hip) for (let i = 0; i < c.values.length; i++) c.values[i] *= scale;   // only the hip translates
    tracks.push(c);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}
```

Mixer root is the character scene (`new THREE.AnimationMixer(gltf.scene)`). Tracks resolve by node name.

## 4. Retarget with SkeletonUtils

```js
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const hipY = (sk, name) => sk.getBoneByName(name).getWorldPosition(new THREE.Vector3()).y;
const scale = hipY(targetMesh.skeleton, 'Hips') / hipY(sourceMesh.skeleton, 'mixamorigHips');   // hip height ratio, both in rest pose

const baked = SkeletonUtils.retargetClip(targetMesh, sourceMesh, sourceClip, {
  names,                                  // target -> source bone names
  hip: 'mixamorigHips',                   // the SOURCE hip bone name, default is 'hip'
  scale,                                  // scales hip translation
  fps: 30,                                // bake rate. Default derives from the clip's densest track
  // trim: [startSeconds, endSeconds], useFirstFramePosition: true, hipInfluence: new THREE.Vector3(1, 0, 1)
});
const mixer = new THREE.AnimationMixer(targetMesh);   // root must be the SkinnedMesh itself, see below
mixer.clipAction(baked).play();
```

Verified in r187 with a 3-bone test rig:
- Output tracks are named `.bones[Name].position` and `.bones[Name].quaternion` and sampled **every frame** (30 keys for a 1 s clip at 30 fps).
- **The mixer root must be the `SkinnedMesh`** (or any object with a `skeleton`). A `Group` root logs `Can not bind to bones as node does not have a skeleton` and nothing animates. To use the clip with a character scene root, or to export it, rename the tracks:

```js
export function toNodeTracks(clip) {                                    // '.bones[Hips].quaternion' becomes 'Hips.quaternion'
  const out = clip.clone();
  for (const t of out.tracks) t.name = t.name.replace(/^\.bones\[(.+?)\]\./, '$1.');
  return out;
}
```

- `scale` multiplies the hip translation only, rotations are unaffected. `hipInfluence` is a per-axis multiplier on that translation. Set it to `(1, 0, 1)` to flatten height, `(0, 1, 0)` to keep only vertical bob.
- `getBoneName` replaces `names` when the mapping is a rule instead of a table.
- `useFirstFramePosition: true` subtracts the first frame's hip position, which starts the clip at the target's origin.
- `localOffsets` (per-bone `Matrix4`, keyed by target bone name) and `hipPosition` are read by `retarget`. `retargetClip` calls `retarget` once per frame with the same options object (r187 source), so both apply to baked clips too. Their effect is untested here, compare screenshots.

Rest-pose mismatch (source in T-pose, target in A-pose, arms land inside the torso or stick out):
1. Best: re-export the character in the same rest pose as the clip source (Mixamo uses a T-like pose). One fix, every clip works.
2. Otherwise correct the offset at the shoulders and upper arms with `localOffsets` (passed to `retarget` or `retargetClip`), for example `{ LeftArm: new THREE.Matrix4().makeRotationZ(angle) }` with the angle found by eye, then compare screenshots (`render-qa`).
3. Check facing: the source forward axis can differ (+Z vs -Z). A character walking backwards means a 180 degree root rotation on the container, not a clip change.

Live retarget per frame, for blending a mocap rig into the character:

```js
// after sourceMixer.update(dt): copies the source pose onto the target skeleton
SkeletonUtils.retarget(targetMesh, sourceMesh, { names, hip: 'mixamorigHips', scale });
```

## 5. Root motion versus in-place

| Style | Use for | Cost |
|---|---|---|
| In-place clips, game code moves the character | Gameplay, player and NPC locomotion, any input driven movement | Feet can slide if speed and cycle do not match |
| Root-motion clips, the clip moves the character | Cinematics, one-shot actions (vault, door, takedown), exact choreography | Cannot be steered or blended freely |

- Strip root motion from a clip with `stripRootMotion` in `rigging-skeleton-ik` (section 9). It returns the travel per loop.
- Measure the source speed once: `clipSpeed = delta.length() / clip.duration` in metres per second after `scale`.
- **Speed matching.** Move the character at the gameplay speed `v` and set `action.timeScale = v / clipSpeed`, clamped to about 0.8 to 1.25 (guess, tune against a foot-slide screenshot). Outside that range blend to the next clip in the tree instead of stretching.
- **One-shot root motion.** Play the clip, read the hip's world displacement each frame (`hip.getWorldPosition`), move the container by the delta, and zero the hip's X and Z so it does not move twice.
- Keep the vertical hip bob. Locking Y makes the walk look mechanical.

## 6. State machines and blend trees

Two layers, kept separate: **states** (discrete, crossfade on entry) and **blend trees** (continuous, weights from a parameter).

```js
export class AnimStates {
  constructor(mixer, clips, initial) {                                    // clips: { idle, jump, ... }
    this.mixer = mixer;
    this.actions = Object.fromEntries(Object.entries(clips).map(([k, c]) => [k, mixer.clipAction(c)]));
    this.current = null;
    this.returnTo = initial;                                              // one-shots fall back here
    mixer.addEventListener('finished', (e) => { if (e.action === this.current) this.go(this.returnTo); });
    this.go(initial, { fade: 0 });
  }
  go(name, { fade = 0.25, once = false } = {}) {
    const next = this.actions[name];
    if (!next || next === this.current) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.play();
    if (this.current && fade > 0) this.current.crossFadeTo(next, fade, true);   // warp = true aligns the two cycle speeds
    else if (this.current) this.current.stop();
    this.current = next;
  }
}
// states.go('jump', { once: true, fade: 0.1 });  returns to 'idle' on 'finished' (tested)
```

```js
// 1D blend tree: idle, walk, run chosen by speed. All actions play, only weights change, so cycles stay in phase
export class Locomotion {
  constructor(mixer, entries) {                                           // [{ speed: 0, clip: idle, sync: false }, { speed: 1.4, clip: walk }, { speed: 4, clip: run }]
    this.entries = entries.map((e) => ({ speed: e.speed, sync: e.sync ?? true, action: mixer.clipAction(e.clip) }));
    for (const e of this.entries) { e.action.play(); e.action.setEffectiveWeight(0); }
  }
  update(speed) {
    const E = this.entries;
    let i = 0;
    while (i < E.length - 2 && speed > E[i + 1].speed) i++;
    const a = E[i], b = E[i + 1];
    const w = THREE.MathUtils.clamp((speed - a.speed) / (b.speed - a.speed), 0, 1);
    for (const e of E) e.action.setEffectiveWeight(0);
    a.action.setEffectiveWeight(1 - w);
    b.action.setEffectiveWeight(w);
    if (a.sync && b.sync) {                                               // gait clips share one normalised phase
      const da = a.action.getClip().duration, db = b.action.getClip().duration, dur = da * (1 - w) + db * w;
      a.action.setEffectiveTimeScale(da / dur);
      b.action.setEffectiveTimeScale(db / dur);
    }
  }
}
// per frame: loco.update(smoothedSpeed); mixer.update(dt)
```

Verified (r187): speed 0.7 gives idle 0.5 and walk 0.5; speed 2.7 gives walk 0.5 and run 0.5 with time scales 1.222 and 0.778; speed above the last threshold clamps to run 1.0.

Rules:
- Blend only clips of the same kind. Walk and run blend if both start on the same foot, idle does not (`sync: false`). Author or pick cycles that start at the same foot-down frame.
- Crossfade lengths: idle to walk 0.2 to 0.3 s, walk to run 0.15 to 0.25 s, anything to a one-shot 0.1 s, back from a one-shot 0.2 to 0.3 s (guess, tune by eye).
- Smooth the input speed (`MathUtils.damp`, see `motion-choreography`) or the legs snap between weights.
- Layer upper and lower body with masked clips and additive clips from `animation-curves-graph-editor` (aim, wave, breathing over locomotion).
- Interrupting a fade: calling `go` again leaves the previous fade-out running, so three actions can briefly carry weight. Normal, but do not chain more than a few transitions per second.
- Actions at weight 0 are skipped by the mixer (`weight > 0` check in `AnimationAction`), so keeping every blend-tree clip playing at weight 0 costs almost nothing.
- Drive the parameters from game state and keep the machine itself dumb. Parameters like `speed`, `grounded`, `attack` in, state names out.

## 7. Foot IK basics

Goal: feet land on uneven ground without sinking or floating. Uses `CCDIKSolver` from `rigging-skeleton-ik`. Run it after `mixer.update(dt)`.

```js
const _ray = new THREE.Raycaster(), _o = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);
export function groundAt(point, ground, up = 0.6, reach = 1.2) {          // ground: array of meshes
  _ray.set(_o.copy(point).setY(point.y + up), DOWN);
  _ray.far = up + reach;
  const hit = _ray.intersectObjects(ground, true)[0];
  return hit ? { y: hit.point.y, normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld) } : null;
}
```

Per frame:
1. For each foot, read the animated ankle world position, call `groundAt`. Offset = `hit.y + ankleHeight - ankle.y`, where `ankleHeight` is the ankle's height above the sole at rest (measure once in the rest pose).
2. **Pelvis.** Move the hip down by the more negative of the two offsets (never up by more than a few cm). This lets the lower foot reach the ground without overextending the leg. Damp the hip height (`MathUtils.damp`, lambda 8 to 12) or it jitters on stairs.
3. **Targets.** Move each foot IK target bone to the animated ankle plus its offset. Give each leg a `CCDIKSolver` chain, effector at the ankle, two links (knee then hip) with hinge limits on the knee.
4. **Blend.** Fade `blendFactor` with the foot's height above ground in the clip (0 when swinging high, 1 when planted), so IK does not fight the swing. Contact frames come from the clip: mark them from the lowest ankle Y per cycle, or keep a table per clip.
5. **Foot rotation.** Tilt the foot toward the ground normal, clamped to about 30 degrees (guess).
6. Handle misses: when `groundAt` returns `null`, skip IK and keep the animated pose.

Basics only: this plants feet and levels the pelvis. It does not do foot-lock against slide, stair stepping prediction or procedural gait. For sliding, fix the speed match first (section 5).

## 8. Mocap cleanup and filtering

Raw mocap (webcam or suit) jitters, drifts and flips quaternion signs. Order of operations:

1. **Resample to a uniform rate** (`resampleTrack` in `animation-curves-graph-editor`). Filters below assume equal spacing.
2. **Hemisphere continuity.** Flip signs so consecutive quaternions have a positive dot. Included in `smoothTrack`.
3. **Low-pass, zero phase.** A forward and a backward exponential pass keeps peaks in place instead of lagging:

```js
export function smoothTrack(track, alpha = 0.5) {                        // lower alpha = smoother. Try 0.3 to 0.6 (guess)
  const s = track.getValueSize(), n = track.times.length, v = Float32Array.from(track.values);
  const q = s === 4, a = new THREE.Quaternion(), b = new THREE.Quaternion();
  if (q) for (let i = 1; i < n; i++) {                                    // hemisphere continuity
    let d = 0;
    for (let k = 0; k < 4; k++) d += v[i * 4 + k] * v[(i - 1) * 4 + k];
    if (d < 0) for (let k = 0; k < 4; k++) v[i * 4 + k] *= -1;
  }
  const blend = (from, to) => {
    if (q) { a.fromArray(v, from * 4); b.fromArray(v, to * 4); b.slerp(a, 1 - alpha).toArray(v, to * 4); }
    else for (let k = 0; k < s; k++) v[to * s + k] = v[from * s + k] + alpha * (v[to * s + k] - v[from * s + k]);
  };
  for (let i = 1; i < n; i++) blend(i - 1, i);
  for (let i = n - 2; i >= 0; i--) blend(i + 1, i);
  return new track.constructor(track.name, track.times, v, THREE.InterpolateLinear);
}
```

Tested: roughness of a noisy vector track dropped from 3.31 to 2.84 at alpha 0.4, and a sign-flipped quaternion sequence came out continuous.

4. **Preserve impacts.** Smoothing rounds sharp hits (landing, punch). Smooth only the spine, neck and finger tracks heavily, hands and feet lightly, or keep the raw frames around contact.
5. **Root drift.** Subtract the slow drift of the hip X and Z or lock them (`stripRootMotion`).
6. **Foot contact.** Skate cleanup needs IK (section 7). A filter does not remove slide.
7. **Reduce keys** with `resample` (section 9).

Do not smooth the clip twice and do not smooth baked additive layers, smooth the source first.

## 9. Compression

Animation bloat comes from baked every-frame tracks. Bytes per second about `bones x fps x (16 for a quaternion + 4 for time)`, plus 12 more per position track.

```bash
npx @gltf-transform/cli resample in.glb out.glb --tolerance 0.0001
npx @gltf-transform/cli meshopt out.glb final.glb
```

- `resample` drops redundant keys losslessly within `--tolerance` (default 0.0001, checked in 4.5.1). It applies to STEP and LINEAR interpolation only. Raise to about 0.001 for smaller files and compare visually (guess).
- `meshopt` (`--compress meshopt` in `optimize`) also compresses animation data, which makes it the right choice for characters. See `gltf-asset-pipeline`.
- Exporting a retargeted clip: `new GLTFExporter().parse(scene, onDone, onError, { binary: true, animations: [toNodeTracks(baked)] })` from `three/addons/exporters/GLTFExporter.js`. The exporter resolves tracks by node name, so rename `.bones[...]` tracks first (exporter run not tested).
- Drop tracks that never matter: finger bones for a distant crowd, scale tracks that are constant, all tracks for bones that are not in the map.
- Budget animation as its own line. A 20 clip character with 60 bones at 30 fps is megabytes before compression. Load clips lazily, only the ones the current state needs.

## 10. Verify

1. `unmapped(names, ...)` returns an empty array (core bones).
2. Play the T-pose frame of the source clip, then the same frame retargeted: arms, hands and feet match the source, no twisted wrists or knees bending backward.
3. Walk the character through idle, walk, run and back at three speeds. No foot slide at the clip's native speed, no pops on transitions (`render-qa` frame sequence).
4. Check the hip height at rest and during a walk: no sinking, no floating.
5. One-shots return to idle, root motion does not apply twice, loops do not pop (`loopGaps` in `animation-curves-graph-editor`).
6. File size and keyframe counts before and after `resample` (`gltf-asset-pipeline`), then confirm no visible change at 100 percent crops.
7. Console clean: no `Can not bind to bones` and no missing track warnings.

Related: `rigging-skeleton-ik` for skeletons, IK and root motion stripping, `animation-curves-graph-editor` for curve baking, layers and loops, `deformers-blendshapes-morph` for facial animation, `physics-rigidbody` for ragdolls and secondary motion, `motion-choreography` for damping, `gltf-asset-pipeline` for compression, `render-qa` for frame checks.
