---
name: animation-curves-graph-editor
description: Animation curve work in Three.js, translating the Maya Graph Editor, Time Editor, animation layers and set driven key, and the Blender Graph Editor, Dope Sheet, NLA and drivers into keyframe tracks and JS. Covers which interpolation modes Three.js really supports (discrete, linear, smooth, and Bezier in newer releases) versus Maya and Blender Bezier handles and easing types, resampling and baking curves, easing curve evaluation, additive clips and masked layers with AnimationUtils, time warp, looping and seam checks, sub-clips from one long take, scrubbing, and drivers or expressions as JS functions. Use when animation looks wrong after export (wrong easing, popping loops, flipping rotations), when curves must be edited or baked in code, when clips must be layered, split, sped up or scrubbed, or when a Maya expression or Blender driver must be reproduced. Thai triggers กราฟอนิเมชัน, เส้นโค้ง keyframe, easing, ลูปกระตุก, ตัดคลิป, driver, ซ้อนอนิเมชัน.
argument-hint: "<clip or curve problem, DCC it came from, and desired motion>"
---

# Animation Curves and Graph Editor

Three.js plays sampled tracks, not authored curves. Anything the Graph Editor does beyond that (handle types, easing, layers, drivers) must be baked at export or reproduced in JS. Decide per feature below.

Camera moves, damping, springs and `AnimationMixer` basics are in `motion-choreography`. A hand-written timeline with camera cuts and event tracks is in `realtime-engine-features` (section 3). This skill covers the curve data itself.

## 1. Interpolation: what survives

| Maya / Blender curve feature | Three.js | Action |
|---|---|---|
| Step, Constant | `InterpolateDiscrete` | Native. Use for visibility, state flips, texture switches |
| Linear | `InterpolateLinear` (default). Quaternion tracks use slerp, shortest path | Native |
| Auto, Auto Clamped, Spline, Clamped tangents | `InterpolateSmooth`, a cubic spline with tangents derived from neighbouring keys | Close match, not identical. Not available on `QuaternionKeyframeTrack` (checked r187: the factory is `undefined`) |
| Free or aligned Bezier handles, weighted tangents | `InterpolateBezier` with `track.settings.inTangents` and `outTangents`. Present from r183 (checked: absent in r180) | Newer releases only, scalar and vector tracks. Not safe on quaternion tracks (verify). Otherwise bake |
| glTF `CUBICSPLINE` | Loaded by `GLTFLoader` with a custom Hermite interpolant (in and out tangents per key) | Native when the exporter writes it |
| Sine, Quad, Cubic, Quart, Quint, Expo, Circ, Back, Bounce, Elastic (Blender easing) | None | Bake with `easeTrack` (section 3) |
| Euler rotation curves, per-axis | Not stored. glTF holds quaternions | Bake in the DCC, then check for flips (section 8) |
| Curve extrapolation (cycles, linear) | Clamps to the end keys. Looping is the action's job | `LoopRepeat`, or bake extra cycles |
| Pre and post infinity, graph modifiers (noise, cycle) | None | Bake, or a JS driver (section 6) |

Two ways to a safe export:
1. **Bake in the DCC.** Blender's glTF exporter samples animation at the scene frame rate by default (option named Sampling Animations, verify the name in your version). Maya: Bake Simulation or the Game Exporter. Everything then arrives as LINEAR keys at 24, 30 or 60 fps and looks right at any playback rate.
2. **Resample in code or CLI** (sections 2 and 3), then thin keys again with `gltf-transform resample` (`gltf-asset-pipeline`).

Check what you have before editing anything:

```js
for (const t of clip.tracks) console.log(t.name, t.constructor.name, t.getInterpolation(), t.times.length);
// loaded CUBICSPLINE tracks use a custom createInterpolant that getInterpolation() cannot name (GLTFLoader source comment)
```

## 2. Resample any track to linear keys

`createInterpolant()` evaluates the track exactly as the mixer would, so one function bakes Smooth, Bezier and loaded cubic splines alike (tested against the Bezier interpolant).

```js
export function resampleTrack(track, fps = 30) {
  const it = track.createInterpolant();
  const stride = track.getValueSize(), t0 = track.times[0], t1 = track.times[track.times.length - 1];
  const n = Math.max(2, Math.ceil((t1 - t0) * fps) + 1);
  const times = new Float32Array(n), values = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    const t = Math.min(t0 + i / fps, t1);
    times[i] = t;
    values.set(it.evaluate(t), i * stride);            // evaluate returns a shared buffer, copy it
  }
  return new track.constructor(track.name, times, values, THREE.InterpolateLinear);
}
```

- Keep discrete tracks as they are. Sampling a step at 30 fps moves the step by up to one frame.
- 30 fps is enough for most body motion. Use 60 fps for fast cuts and camera shake, and expect bigger files.
- Hand-authored handles from another tool (key-relative offsets), usable in any release:

```js
// keys: [{ t, v, in: [dt, dv], out: [dt, dv] }], handles are offsets from the key. Blender stores absolute handle points, subtract the key first
export function evalBezier(keys, t) {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const x1 = Math.min(a.t + a.out[0], b.t), x2 = Math.max(b.t + b.in[0], a.t);   // keep handle x inside the segment so x(s) stays monotonic
  const y1 = a.v + a.out[1], y2 = b.v + b.in[1];
  const bez = (s, p0, p1, p2, p3) => { const u = 1 - s; return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3; };
  let lo = 0, hi = 1;
  for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (bez(m, a.t, x1, x2, b.t) < t) lo = m; else hi = m; }   // solve x(s) = t
  return bez((lo + hi) / 2, a.v, y1, y2, b.v);
}
```

On releases with `InterpolateBezier`, `track.settings = { inTangents, outTangents }` takes **absolute** `[time, value]` control points per key per component (layout: key-major, then component, then time and value). Matches `evalBezier` to four decimals in a test. Maya weighted and unweighted tangent conversion differs by version, so export baked curves from Maya rather than converting tangents (verify if you must convert).

## 3. Easing curves

Blender's per-key easing types and Maya's easing presets are not tracks. Evaluate the function and bake it into keys:

```js
const inOut = (f) => ({ in: f, out: (t) => 1 - f(1 - t), inOut: (t) => (t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2) });
const bounceOut = (t) => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; };
export const EASE = {
  sine: inOut((t) => 1 - Math.cos((t * Math.PI) / 2)),
  quad: inOut((t) => t ** 2), cubic: inOut((t) => t ** 3), quart: inOut((t) => t ** 4), quint: inOut((t) => t ** 5),
  expo: inOut((t) => (t === 0 ? 0 : 2 ** (10 * t - 10))),
  circ: inOut((t) => 1 - Math.sqrt(1 - t * t)),
  back: inOut((t) => 2.70158 * t ** 3 - 1.70158 * t * t),
  elastic: inOut((t) => (t === 0 || t === 1 ? t : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3)))),
  bounce: inOut((t) => 1 - bounceOut(1 - t)),
};   // EASE.cubic.inOut(0.5) is 0.5, every function maps 0 to 0 and 1 to 1 (tested)

// Apply one easing to every segment of a track, then bake. Works for vector, number and quaternion tracks (quaternions slerp).
export function easeTrack(track, ease, fps = 30) {
  const lin = new track.constructor(track.name, track.times, track.values, THREE.InterpolateLinear).createInterpolant();
  const T = track.times, times = [], values = [];
  for (let s = 0; s < T.length - 1; s++) {
    const steps = Math.max(1, Math.ceil((T[s + 1] - T[s]) * fps));
    for (let i = 0; i < steps; i++) {
      times.push(T[s] + (i / steps) * (T[s + 1] - T[s]));
      values.push(...lin.evaluate(T[s] + ease(i / steps) * (T[s + 1] - T[s])));
    }
  }
  times.push(T[T.length - 1]);
  values.push(...lin.evaluate(T[T.length - 1]));
  return new track.constructor(track.name, times, values, THREE.InterpolateLinear);
}
// clip.tracks = clip.tracks.map((t) => easeTrack(t, EASE.cubic.inOut));
```

- The formulas follow the common Penner set. Blender's `back` and `elastic` have per-key parameters (amplitude, overshoot, period), so match by eye against the Graph Editor and compare a screenshot sequence.
- Pick the easing by role: motion into view uses `out`, motion out of view uses `in`, repositioning uses `inOut`. Duration and ease tables for UI-linked and camera motion are in `motion-choreography`.
- One ease for the whole clip is the exception. Per-key easing is the norm, so bake per segment only where the DCC marked it.
- Overshoot easings (`back`, `elastic`) break rotation limits and camera clipping. Test the extremes.

## 4. Layers, masks and additive clips

Maya animation layers and Blender NLA stacks have no direct runtime equivalent. Rebuild them from three mixer features:

| DCC concept | Three.js |
|---|---|
| Override layer (replaces channels) | A normal action with a weight, blended by `setEffectiveWeight` |
| Additive layer | `AnimationUtils.makeClipAdditive`, mixer then adds it on top of the layers below |
| Layer mask (upper body only) | Filter the clip's tracks by bone name (`maskClip`) |
| Layer weight curve | `action.fadeIn`, `fadeOut`, `setEffectiveWeight` per frame |
| NLA strip, Maya Time Editor clip | A separate `AnimationClip`, scheduled with `action.startAt(time)` |

```js
// Additive: the layer stores difference from a reference frame, so it can ride on any base
const breath = THREE.AnimationUtils.subclip(source, 'breath', 0, 61, 30);
const add = breath.clone();
THREE.AnimationUtils.makeClipAdditive(add, 0, breath, 30);          // frame 0 of 'breath' is the zero pose; fps must match the clip's real fps
const a = mixer.clipAction(add);                                      // makeClipAdditive sets clip.blendMode to additive (tested)
a.play(); a.setEffectiveWeight(0.6);

// Mask: keep only some bones
export function maskClip(clip, keep) {
  return new THREE.AnimationClip(`${clip.name}_masked`, clip.duration, clip.tracks.filter((t) => keep(t.name)).map((t) => t.clone()), clip.blendMode);
}
const wave = maskClip(waveClip, (n) => /Spine|Shoulder|Arm|Hand|Head/.test(n));      // arms wave while legs keep walking
```

- `makeClipAdditive` mutates its first argument. Clone first if the clip is reused.
- `referenceFrame` is a frame index at the `fps` argument, not seconds. A wrong `fps` shifts the reference pose.
- Additive and normal actions are accumulated separately and then combined, so creation order is not a layering order. Control the result with weights only (verify with your revision if a layer seems ignored).
- Keep additive layers to rotations (breathing, lean, head turn) unless tested. Position and scale additive layers drift on bones that other layers also move.
- Two normal-blend actions that animate the same bone are blended by their weights. Use masks so layers never share tracks.
- Weights, crossfades and state machines for characters are in `character-animation-retarget`.

## 5. Time: speed, warp, looping, scrubbing

**Constant speed.** `action.setEffectiveTimeScale(1.5)`, negative plays backward, `action.setDuration(seconds)` stretches a clip to a length, `action.warp(from, to, seconds)` ramps speed (hit-stop, slow-mo into impact), `action.syncWith(other)` locks cycles of two clips (walk into run).

**Non-linear time warp inside a clip** (Maya time warp, Blender Time Offset curve, speed ramps) has no live equivalent. Bake with a warp function `u in [0,1] to [0,1]`:

```js
export function warpClip(clip, warp, newDuration = clip.duration, fps = 30) {
  const n = Math.ceil(newDuration * fps) + 1;
  const tracks = clip.tracks.map((tr) => {
    const it = tr.createInterpolant(), s = tr.getValueSize(), times = new Float32Array(n), values = new Float32Array(n * s);
    for (let i = 0; i < n; i++) {
      times[i] = (i / (n - 1)) * newDuration;
      values.set(it.evaluate(warp(i / (n - 1)) * clip.duration), i * s);
    }
    return new tr.constructor(tr.name, times, values, THREE.InterpolateLinear);
  });
  return new THREE.AnimationClip(clip.name, newDuration, tracks, clip.blendMode);
}
// ease-in speed ramp over 1.5 s: warpClip(clip, (u) => u * u, 1.5)
```

**Looping.** `action.setLoop(THREE.LoopRepeat | THREE.LoopOnce | THREE.LoopPingPong, repetitions)`. `LoopOnce` needs `clampWhenFinished = true` to hold the last pose. A loop pops when the first and last key differ. Find the offenders:

```js
export function loopGaps(clip, eps = 1e-3) {
  return clip.tracks.map((t) => {
    const s = t.getValueSize(), v = t.values, n = t.times.length;
    let d = 0;
    for (let k = 0; k < s; k++) d = Math.max(d, Math.abs(v[(n - 1) * s + k] - v[k]));
    return [t.name, d];
  }).filter(([, d]) => d > eps);
}
```

A hit on a quaternion track can be a sign flip (`q` and `-q` are the same rotation), check by eye. Fix in the DCC by making the last frame equal the first and exporting one frame fewer than the cycle if the exporter duplicates it. Walk and run cycles should also begin on the same foot phase to blend (see `character-animation-retarget`).

**Scrubbing and playhead.**

```js
mixer.setTime(seconds);                                              // zeroes the mixer and every action time, then updates. Ignores paused actions
action.paused = true; action.time = seconds; mixer.update(0);       // scrub one action, tested (set time 1 s of a 2 s clip gives the halfway value)
```

Do not call `setTime` while actions are paused, nothing moves (tested). For a UI timeline show keys as frames with `clip.tracks.map((t) => [t.name, Array.from(t.times, (s) => Math.round(s * fps))])`, the Dope Sheet view.

## 6. Drivers and expressions as JS

Blender drivers, Maya expressions and Maya set driven keys do not export. Run them after the mixer, in dependency order, every frame:

```js
const drivers = [];                                   // each entry reads state and writes state
// per frame: mixer.update(dt); for (const d of drivers) d(t); render
```

| DCC | JS |
|---|---|
| Maya expression `ty = sin(time * 2) * 3` | `obj.position.y = Math.sin(t * 2) * 3` where `t` is elapsed seconds |
| Maya `frame` | `Math.round(t * fps)` |
| Blender driver: single property | Read the property, scale, write |
| Blender driver: transform channel | `bone.rotation.x`, or `bone.quaternion` converted with `Euler.setFromQuaternion` |
| Blender driver: rotational difference | `a.quaternion.angleTo(b.quaternion)` |
| Blender driver: distance | `a.getWorldPosition(v1).distanceTo(b.getWorldPosition(v2))` |
| Set driven key (driver value to driven value) | `setDrivenKey` below |
| Constraint or bone driver on a morph target | Corrective drivers in `deformers-blendshapes-morph` |

Set driven key is a curve over the driver value instead of time, so reuse the track machinery:

```js
export function setDrivenKey(driver, driven, interpolation = THREE.InterpolateSmooth) {   // driver values must increase
  const it = new THREE.NumberKeyframeTrack('.x', driver, driven, interpolation).createInterpolant();
  return (d) => it.evaluate(d)[0];                                                          // clamps outside the key range
}
const kneeToCalf = setDrivenKey([0, 90, 150], [0, 0.4, 1], THREE.InterpolateLinear);
// drivers.push(() => { calf.scale.y = 1 + kneeToCalf(THREE.MathUtils.radToDeg(knee.rotation.x)) * 0.05; });
```

Rules:
- Order matters. Drivers that read a bone must run after `mixer.update`, drivers that feed IK must run before `ik.update()` (`rigging-skeleton-ik`).
- Do not write a property that a clip also animates, the mixer overwrites it every frame.
- Never evaluate drivers from event handlers. One place, one order, once per frame.
- Seed random drivers (noise, wobble) from the time value, so scrubbing and replays are deterministic.

## 7. Sub-clips from one long take

Animators and mocap export one long timeline with markers. Split in code or in the DCC (Blender NLA tracks as separate actions, or the exporter's mode that writes each action separately, verify the option names).

```js
export function splitClip(clip, ranges, fps = 30) {                   // ranges: { idle: [0, 29], walk: [30, 60] }, inclusive frames from the clip start
  return Object.fromEntries(Object.entries(ranges).map(([name, [a, b]]) => [name, THREE.AnimationUtils.subclip(clip, name, a, b + 1, fps)]));
}
```

Behaviour verified in r187:
- `subclip(clip, name, startFrame, endFrame, fps)` treats `endFrame` as **exclusive** (`frame >= endFrame` is dropped), so pass `last + 1`. A range `[0, 29]` produces a clip of 29 frames duration (0.967 s at 30 fps), range `[30, 60]` produces exactly 1 s.
- It keeps whole keys only. It does not add keys on the cut, so keys must sit on the cut frames. Resample first (`resampleTrack`) when the source uses sparse or unaligned keys.
- Times are shifted so the clip begins at 0. The frame numbers are relative to the clip's own time zero, so subtract the DCC start frame if the exported clip is offset (check `clip.tracks[0].times[0]`, verify per exporter).
- A loop needs the closing frame. Include it, then run `loopGaps`.

## 8. Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Motion floaty or too linear after export | Easing and handles lost, only keys exported | Re-export baked, or `easeTrack` |
| Arm or head spins the long way | Euler to quaternion flip across 180 degrees | Euler filter in the DCC before bake (Maya: Euler Filter, Blender: Clean Channels and Discontinuity filter, verify names), then export |
| Loop pops once per cycle | First and last key differ | `loopGaps`, fix in the DCC |
| Clip ends 1 frame early or late | Frame vs second confusion, off-by-one on `endFrame` | Section 7 rules, `t = frame / fps` |
| Animation twice as long or short | DCC fps 24 vs scene fps 30 | Keys are in seconds. Check the exporter's fps and `clip.duration` |
| Additive layer does nothing | Wrong blend mode or reference, or weight 0 | `clip.blendMode`, `fps` argument, weight |
| Additive layer doubles a pose | Base layer already contains it | Make additive from a reference frame of the same take |
| Huge GLB with tiny animation | Baked at 60 fps with every channel | `gltf-transform resample`, and `clip.optimize()` for runtime-built clips |
| Scrub gives wrong frame | Actions paused when calling `setTime` | Scrub the action directly |
| Cut or event fires twice | Timeline replays events on seek | Idempotent events, see `realtime-engine-features` |

## 9. Verify

1. Log every track name, class, interpolation and key count (section 1). Compare against the DCC's channel box.
2. Play the clip and a screenshot sequence from the DCC at the same frame numbers (`render-qa`), compare 5 frames including the hardest ease.
3. `loopGaps(clip)` returns an empty array for each looping clip.
4. `clip.validate()` and `clip.optimize()` run without warnings on the final clips. Optimise removes redundant keys and is lossless in tolerance.
5. Scrub to the first, middle and last frame. All three poses match the DCC.
6. Check file size before and after resampling, per `gltf-asset-pipeline` budgets.
7. Confirm the pinned Three.js revision before relying on `InterpolateBezier` (r183 or later, checked).

Related: `rigging-skeleton-ik` for drivers that feed IK, `deformers-blendshapes-morph` for morph tracks and correctives, `character-animation-retarget` for state machines and blend trees, `motion-choreography` for camera and UI motion, `realtime-engine-features` for timeline, cuts and events, `gltf-asset-pipeline` for compression and `resample`.
