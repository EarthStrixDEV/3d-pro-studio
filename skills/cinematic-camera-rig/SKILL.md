---
name: cinematic-camera-rig
description: Film-style cameras in Three.js, translating Maya camera attributes (focal length, film back, film fit, film offset, resolution gate, safe action and title) and Blender camera data (lens, sensor size, sensor fit, shift, depth of field, f-stop) into PerspectiveCamera setup. Covers focal length in mm and film gauge to field of view with setFocalLength and filmGauge, resize behaviour, f-stop and focus distance to depth-of-field maths and BokehPass settings, rack focus, dolly, crane and rail rigs, dolly zoom, handheld shake from noise and trauma, damped look-at and Track To, resolution gate letterboxing and safe frames, lens shift, lens distortion, and multi-camera cuts. Use when a scene needs a cinematic or product-film camera, a camera must match a Blender or Maya shot, a lens or aspect change distorts the framing, focus must be pulled, or shots must cut between cameras. Thai triggers กล้องหนัง, ความยาวโฟกัส, เลนส์, ชัดตื้น, โฟกัสเลื่อน, กล้องสั่นมือ, ดอลลี่, เครน, ตัดภาพ.
argument-hint: "<shot description, reference lens and sensor, aspect ratio, target device tier>"
---

# Cinematic Camera Rig

Set the lens like a cinematographer, then move it like a rig. Easing, damping and the intro, rail and scroll patterns are already in `motion-choreography`. This skill adds the optics, the rigs and the frame. Timeline, cuts and event tracks are in `realtime-engine-features` (section 3).

## 1. Attribute map

| Maya | Blender | Three.js |
|---|---|---|
| Focal Length (mm) | Focal Length (mm) | `camera.setFocalLength(mm)` |
| Camera Aperture / Film Back (inches) | Sensor Size (mm) | `camera.filmGauge` (mm, the longer side of the frame) |
| Film Fit (Fill, Horizontal, Vertical, Overscan) | Sensor Fit (Auto, Horizontal, Vertical) | Fixed: the gauge applies to the longer side of the frame (section 2). Other fits: set `camera.fov` yourself |
| Film Offset | Shift X, Shift Y | `camera.filmOffset` (horizontal, mm) or `setViewOffset` (section 8) |
| Near and Far Clip | Clip Start and End | `camera.near`, `camera.far` |
| F-Stop, Focus Distance (Arnold, V-Ray) | Depth of Field: F-Stop, Focus Distance or Object | Post pass, section 3 |
| Shutter Angle | Motion blur Shutter | Motion blur pass, see `post-processing-stack` |
| Resolution Gate, Film Gate, Safe Action, Safe Title | Passepartout, Safe Areas | Gate fitting and overlays, section 6 |
| Aim constraint, Track To | Track To (-Z, Up Y) | `camera.lookAt(target)`, section 5 |
| Camera sequencer, markers bound to cameras | Timeline markers bound to cameras | Cuts, section 9 |
| Image plane, camera mapping | Background image | Not a camera feature, use a mesh or `scene.background` |

Blender's camera data comes through glTF as `yfov` only, the sensor and lens in mm are not exported. A loaded camera has the right field of view and an unknown lens. Store the focal length and sensor in `extras` or your own JSON if the shot logic needs them.

## 2. Lens, film gauge and field of view

```js
camera.filmGauge = 36;                 // full frame width in mm. Three.js default is 35
camera.aspect = w / h;
camera.setFocalLength(50);             // sets fov from the film height at the CURRENT aspect, then updates the projection
```

Verified (r187, gauge 36, 50 mm):

| Aspect | Vertical FOV | Horizontal FOV |
|---|---|---|
| 16:9 | 22.90 | 39.60 |
| 1:1 | 39.60 | 39.60 |
| 9:16 (portrait) | 39.60 | 22.90 |

- `filmGauge` is the **longer** side of the frame, so the lens is defined on the long axis in both orientations. `getFilmWidth()` is `gauge * min(aspect, 1)` and `getFilmHeight()` is `gauge / max(aspect, 1)`.
- **Resize rule.** Changing `camera.aspect` alone leaves `fov` (vertical) untouched, so the horizontal view shifts. Re-apply the focal length in the resize handler: `camera.aspect = w / h; camera.setFocalLength(state.focalMm);`. Keep the focal length in your own state, never read it back from `fov` after a resize. `getFocalLength()` and `getEffectiveFOV()` (includes `zoom`) are available for readouts.
- Match Blender: Sensor Fit Auto with a 36 mm sensor equals `filmGauge = 36` with the same lens. For Sensor Fit Vertical or Maya Film Fit Vertical compute `camera.fov = 2 * atan(sensorHeight / (2 * focal))` in degrees yourself and call `updateProjectionMatrix()`.
- Maya film back is in inches: 1.417 x 0.945 in is full frame 36 x 24 mm (25.4 mm per inch, check your value).

Feel by focal length (35 mm full frame equivalents, starting values):

| Lens | Horizontal FOV | Use |
|---|---|---|
| 14 to 24 mm | 104 to 74 degrees | Interiors, drama, exaggerated depth. Edge stretch, keep subjects away from the frame edge |
| 35 mm | 54 degrees | Neutral cinematic default |
| 50 mm | 39.6 degrees | Natural perspective, product hero |
| 85 to 135 mm | 24 to 15 degrees | Portrait, product macro, compressed background |

Product and hero shots usually read best at 50 to 85 mm placed further back. Wide lenses close to an object distort it. `3d-pro-pipeline` sets the 30 to 45 degree vertical FOV default for objects, this skill is the film-lens refinement of that step.

**Exposure triangle.** Aperture, shutter and ISO have no direct renderer input. Apply a relative scale to `renderer.toneMappingExposure` from a reference setup, and keep tone mapping itself in `color-management-grading`:

```js
export const exposureScale = (cur, ref) => (ref.N / cur.N) ** 2 * (cur.t / ref.t) * (cur.iso / ref.iso);   // N f-number, t shutter seconds
// one stop wider (N 2.8 to 2) roughly doubles exposure
```

## 3. F-stop and depth of field

Thin lens formulas, all lengths in the same unit (mm below). `f` focal length, `N` f-number, `s` focus distance, `d` subject distance, `c` the circle of confusion limit (0.03 mm is the full frame convention).

```js
// blur disc diameter on the sensor, mm. Zero at d = s
export const cocMm = (f, N, s, d) => ((f / N) * f) / (s - f) * Math.abs(d - s) / d;
// convert to pixels at the render height
export const cocPx = (f, N, s, d, sensorHeightMm, viewportHeightPx) => (cocMm(f, N, s, d) / sensorHeightMm) * viewportHeightPx;
// acceptable-sharpness range
export function dofRange(f, N, s, c = 0.03) {
  const H = (f * f) / (N * c) + f;                                          // hyperfocal distance
  return { near: (s * (H - f)) / (H + s - 2 * f), far: s >= H ? Infinity : (s * (H - f)) / (H - s) };
}
```

Verified numbers: 50 mm at f/2.8 focused at 3 m has sharpness from 2.73 m to 3.33 m. 50 mm at f/1.8 focused at 2 m, subject at 4 m, gives a 0.356 mm blur disc, 16 px on a 1080 px tall frame with a 24 mm tall sensor.

Rules of thumb that change decisions:
- Longer lens and wider aperture and closer focus mean a thinner slice in focus. A 24 mm lens at f/8 has everything in focus past about 1.5 m, so DOF adds nothing there.
- Match world scale: the formulas assume metres. If the scene uses other units, convert distances first.
- Cost: DOF is a full-screen post pass with depth. High tier only (`performance-budget`). Medium and low tiers fake it with a static background blur baked into the plate, or skip it.

**Mapping to `BokehPass`** (`three/addons/postprocessing/BokehPass.js`, setup and tiers in `post-processing-stack`). Its parameters are `focus` (distance along the look direction in world units), `aperture` and `maxblur`. In the shader the blur is linear in `(focus - depth)`, `aperture` is the slope, and `maxblur` caps it, so the pass is not physically based and does not take an f-number. Near the focus plane the thin-lens blur is approximately linear too, which gives a starting slope:

```js
// UV blur per metre of depth error near the focus plane, a STARTING value. Calibrate with a screenshot (render-qa)
export const bokehAperture = (f, N, sMetres, sensorWidthMm) => (((f / N) * f) / (sMetres * 1000 - f)) / sMetres / sensorWidthMm;
// bokeh.uniforms.aperture.value = bokehAperture(50, 1.8, 2, 36);   // about 0.0099 here
// bokeh.uniforms.focus.value = focusDistance;                      // every frame
```

Compare against `post-processing-stack` which recommends 0.002 to 0.01 for subtle depth. If the result looks too strong, scale the slope down, and if you need a hard cap use `maxblur`. The WebGPU `DepthOfFieldNode` (`three/addons/tsl/display/DepthOfFieldNode.js`) takes `focusDistanceNode`, `focalLengthNode` (a range in world units, not millimetres) and `bokehScaleNode` (unitless), so convert the lens to those inputs by eye (parameters read from source, not run).

**Rack focus** (pull focus between subjects). Ease the focus distance, never snap, and avoid focus breathing unless you want it:

```js
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
export class FocusPuller {
  constructor(camera, lambda = 5) { this.camera = camera; this.focus = 5; this.target = null; this.lambda = lambda; }
  to(object, snap = false) {                                              // snap = true on a cut
    this.target = object;
    if (snap) this.focus = this.distance();
  }
  distance() { return this.camera.getWorldPosition(_a).distanceTo(this.target.getWorldPosition(_b)); }
  update(dt) {
    if (this.target) this.focus = THREE.MathUtils.damp(this.focus, this.distance(), this.lambda, dt);
    return this.focus;                                                     // feed bokeh.uniforms.focus.value
  }
}
```

Damp lambda 3 to 6 gives a 0.5 to 1 s pull (guess). Pull focus only when the story changes subject. Never rack during a cut, snap on the cut (section 9). Measure `distance()` along the look direction when the subject is off-axis, since the pass uses depth, not radial distance.

## 4. Rigs: dolly, crane, rail

Build rigs as `Object3D` hierarchies and move the pivots, not the camera. Each rig exposes a few numbers, so animation, scroll and UI can drive it.

```js
// Crane: yaw pivot -> boom pivot (raises the arm) -> tip (arm length) -> camera
export class CraneRig extends THREE.Group {
  constructor(camera, { arm = 4, yaw = 0, boomDeg = 20 } = {}) {
    super();
    this.camera = camera;
    this.yawPivot = new THREE.Group(); this.boomPivot = new THREE.Group(); this.tip = new THREE.Group();
    this.add(this.yawPivot); this.yawPivot.add(this.boomPivot); this.boomPivot.add(this.tip); this.tip.add(camera);
    this.set({ arm, yaw, boomDeg });
  }
  set({ arm = this.arm, yaw = this.yaw, boomDeg = this.boomDeg }) {
    Object.assign(this, { arm, yaw, boomDeg });
    this.yawPivot.rotation.y = yaw;
    this.boomPivot.rotation.x = -THREE.MathUtils.degToRad(boomDeg);   // negative raises the tip
    this.tip.position.set(0, 0, arm);
  }
}
// aim every frame: rig.camera.lookAt(subjectWorldPosition)
```

Check: yaw 0, boom 30 degrees, arm 4 puts the camera 2 m up and 3.46 m back. The camera keeps its own `lookAt` target, so the crane move never changes what is framed.

| Move | Motion | Implementation |
|---|---|---|
| Dolly in or out | Camera translates along the look axis. Perspective changes | Move the rig base, keep the lens |
| Zoom | Lens changes, no perspective change | `setFocalLength`, animate over time |
| Truck, pedestal | Sideways or vertical slide | Move the rig base |
| Pan, tilt | Rotation in place | `lookAt` a moving target, or rotate a head pivot |
| Crane, jib | Arc plus lift | `CraneRig` |
| Arc, orbit | Circle around the subject | Yaw pivot with the camera offset on `tip` |
| Rail, track | Camera on a path | Curve below |
| Steadicam follow | Smoothed trailing | Damped position and damped look-at (section 5) |

**Rail on a curve.** `CatmullRomCurve3.getPointAt(u)` samples by arc length (even speed), while `getPoint(t)` follows the control point spacing and speeds up and slows down. Use `getPointAt` and apply easing to `u` yourself (`EASE` in `animation-curves-graph-editor`):

```js
const rail = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 1, 5), new THREE.Vector3(3, 1.5, 2), new THREE.Vector3(5, 1, -1)]);
const u = EASE.cubic.inOut(THREE.MathUtils.clamp(t / duration, 0, 1));
camera.position.copy(rail.getPointAt(u));
camera.lookAt(subject);
```

**Dolly zoom** (vertigo effect). The subject keeps the same frame size while the background stretches. Distance follows the lens:

```js
export function dollyZoom(camera, subjectPos, axis, frameHeight, focalMm) {   // axis: unit vector from subject to camera
  camera.setFocalLength(focalMm);
  const d = frameHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  camera.position.copy(subjectPos).addScaledVector(axis, d);
  camera.lookAt(subjectPos);
}
// animate focalMm 24 to 85 over 3 s with ease inOut, call once per frame
```

Check: `frameHeight` 4 m at a 40 degree vertical FOV needs 5.50 m, at 20 degrees 11.34 m. Keep `far` beyond the farthest distance and re-check shadows and fog at the extremes.

## 5. Look-at, aim constraints and handheld shake

`camera.lookAt(target)` is Blender's Track To with -Z track and Y up, and Maya's aim constraint with aim (0, 0, -1) and up (0, 1, 0). Call it **after** the rig moved and before shake.

Damped aim for a follow camera (Steadicam feel). Use the world transform when the camera sits inside a rotated rig, this version is for a camera with no rotated parent:

```js
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
export function lookAtDamped(camera, target, lambda, dt) {
  _m.lookAt(camera.position, target, camera.up);                           // rotation that looks from the camera to the target
  _q.setFromRotationMatrix(_m);
  camera.quaternion.slerp(_q, 1 - Math.exp(-lambda * dt));                 // frame-rate independent
}
```

**Handheld shake.** Use smooth deterministic noise (sums of sines, no `Math.random`) so scrubbing and replays match, and a trauma value for impacts:

```js
const wob = (t, seed) => (Math.sin(t * 6.283 * 0.9 + seed) + 0.5 * Math.sin(t * 6.283 * 2.1 + seed * 1.7) + 0.25 * Math.sin(t * 6.283 * 4.3 + seed * 3.1)) / 1.75;   // -1 to 1
const _e = new THREE.Euler(), _s = new THREE.Quaternion();

export class CameraShake {
  constructor({ baseDeg = 0.15, impactDeg = 3, decay = 1.5 } = {}) { Object.assign(this, { baseDeg, impactDeg, decay }); this.trauma = 0; }
  hit(amount = 0.6) { this.trauma = Math.min(1, this.trauma + amount); }
  apply(camera, t, dt) {                                                   // call AFTER lookAt, every frame
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const deg = this.baseDeg + this.impactDeg * this.trauma * this.trauma;  // squared so small hits stay subtle
    const k = THREE.MathUtils.degToRad(deg);
    camera.quaternion.multiply(_s.setFromEuler(_e.set(wob(t, 1.3) * k, wob(t, 4.7) * k, wob(t, 8.1) * k * 0.5)));   // pitch, yaw, roll at half
  }
}
```

- `lookAt` rebuilds the orientation each frame, so the shake never accumulates. If you do not call `lookAt` every frame, apply the shake to a copy of the base quaternion instead of the camera itself.
- Base amplitude 0.1 to 0.3 degrees at 0.5 to 3 Hz reads as handheld, 1 to 4 degrees is an impact or an explosion (guess, tune per shot). More than that reads as an earthquake.
- Position shake adds parallax but is easy to overdo. Keep it under a few centimetres or skip it.
- **Reduced motion.** Respect `prefers-reduced-motion`: base shake and impact shake off (`motion-choreography` section 7).
- Shake and depth of field fight, a moving camera blurs both. Keep DOF focus on the subject and let the shake be subtle.
- Motion blur from shake needs the pass, not more amplitude, see `post-processing-stack`.

## 6. Resolution gate and safe frames

Maya's Resolution Gate and Blender's passepartout show the output frame. In a web page the output frame is the canvas, so fit the canvas to the gate, then draw bars as CSS.

```js
export function fitGate(aspect, availW, availH) {                          // aspect: 2.39 scope, 16 / 9, 1.85, 4 / 3
  const w = Math.min(availW, availH * aspect), h = w / aspect;
  return { width: Math.round(w), height: Math.round(h), left: Math.round((availW - w) / 2), top: Math.round((availH - h) / 2) };
}
// on resize: const g = fitGate(2.39, innerWidth, innerHeight);
// renderer.setSize(g.width, g.height); composer.setSize(g.width, g.height);
// camera.aspect = g.width / g.height; camera.setFocalLength(state.focalMm);
// canvas.style.cssText = `position:absolute;left:${g.left}px;top:${g.top}px`;   // page background supplies the bars
```

- Pick **one** output aspect per shot or scene and keep the lens defined on its longer side (section 2). Letterbox bars are CSS or page background, not geometry.
- Mobile portrait: a 2.39 gate leaves a tiny strip. Switch to a 4:5 or 9:16 gate on narrow screens and reframe, do not just letterbox.
- **Safe frames** are a review overlay, not a shipping feature. Common defaults are action safe 90 percent and title safe 80 percent of the frame (verify against your delivery spec). As an overlay: `inset: 5%` and `inset: 10%` on absolutely positioned bordered divs inside the canvas wrapper. Keep UI and key action inside title safe, see `hud-ui-labels`.
- Overscan: render a little larger than the gate (`renderer.setSize(g.width * 1.05, ...)` with the canvas clipped by CSS) when post effects (distortion, shake) would reveal edges.

## 7. Lens distortion and optics post

Real lens distortion (barrel on wide, pincushion on telephoto) is a post effect, because a perspective projection is distortion free. Wide field of view alone gives edge stretching, not barrel.

```js
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const LensDistortionShader = {
  uniforms: { tDiffuse: { value: null }, uK1: { value: 0.08 }, uK2: { value: 0.0 }, uAspect: { value: 16 / 9 }, uZoom: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uK1; uniform float uK2; uniform float uAspect; uniform float uZoom;
    varying vec2 vUv;
    void main() {
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);                 // aspect-correct so the effect is round
      float r2 = dot(c, c);
      vec2 d = c * (1.0 + uK1 * r2 + uK2 * r2 * r2) / uZoom;
      vec2 uv = d / vec2(uAspect, 1.0) + 0.5;
      vec4 col = texture2D(tDiffuse, uv);
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = col;
    }`,
};
// zoom that hides black corners for barrel (k > 0): uZoom = 1 + uK1 * r2max + uK2 * r2max * r2max, r2max = (aspect * aspect + 1) / 4
```

- `uK1 > 0` is barrel, `uK1 < 0` is pincushion. Values of 0.03 to 0.12 are visible but tasteful (guess). Wide lenses go barrel, tele lenses stay near 0.
- Place it after DOF and bloom and before `OutputPass`, in the order in `post-processing-stack`. It resamples the frame once, so keep it off on low tier.
- Add vignette and chromatic aberration in the same pass if wanted, at low strength, and tie them to the lens (wide open aperture gives more vignette). Subtle beats obvious, see `post-processing-stack` rules.
- Distortion shifts picking and any screen-space UI that must align with 3D, apply the same warp to pointer coordinates or skip distortion on interactive scenes.

## 8. Lens shift

Maya Film Offset and Blender Shift move the frame without rotating the camera, used for architecture (keep verticals parallel) and for placing a product low in frame.

```js
// Blender convention: shift is a fraction of the longer frame side. +X moves the frame right, +Y moves it up
export function lensShift(camera, w, h, shiftX, shiftY) {
  const side = Math.max(w, h);
  camera.setViewOffset(w, h, shiftX * side, -shiftY * side, w, h);
}
```

- Tested sign: `setViewOffset(w, h, 0, -0.1 * h, w, h)` moves content down by 10 percent of the frame height (NDC from 0 to -0.2), which is what a positive Blender Shift Y does. Field of view is unchanged because the view size equals the full size.
- `camera.filmOffset` is a horizontal-only shift in the unit of `filmGauge`, applied in the projection as `near * filmOffset / filmWidth` (r187 source). Use it for a sideways shift, and `setViewOffset` for vertical shift.
- **Conflict.** TAA jitter in `antialiasing-resolution` uses `setViewOffset` as well. Add the shift to the jitter offsets in one call instead of calling both. `clearViewOffset()` removes the shift.
- Keep verticals parallel in architecture shots with a level camera (no tilt) and a vertical shift, instead of a tilted camera.

## 9. Multi-camera cuts

One camera per shot, each with its own rig, lens and focus subject. A cut swaps which camera renders:

```js
export function cutTo(cam, { passes, focus, subject }) {
  for (const p of passes) if ('camera' in p) p.camera = cam;               // RenderPass, BokehPass and TAARenderPass hold a plain camera property
  focus.camera = cam;
  focus.to(subject, true);                                                  // snap focus, never rack across a cut
  // reset temporal history here (TAA, motion blur), see antialiasing-resolution
}
```

- Update aspect and focal length on **all** cameras in the resize handler, not only the active one, or the first frame after a cut is wrong.
- `BokehPass` re-reads near and far from `this.camera` on every render and takes its aspect from `setSize`, so swapping `pass.camera` is enough (checked in source).
- Compile shaders for each cut camera before the cut (`await renderer.compileAsync(scene, cam)`) to avoid a hitch, as in `realtime-engine-features`.
- Reset temporal accumulation on every cut (TAA ghosting, motion blur trails). See `antialiasing-resolution`.
- Cuts hide teleports. Move scene objects, change environments and swap props on the cut, not in view.
- Cut on action or on a camera move, keep a consistent screen direction between shots, and avoid cutting between nearly identical angles (jump cut).
- The cut schedule, events and playhead belong to the timeline in `realtime-engine-features`, which exposes `activeCamera`.

## 10. Verify

1. Print `camera.getFocalLength()`, `camera.fov`, `camera.filmGauge`, `camera.aspect` after a resize to portrait and back. The long-side field of view must be unchanged.
2. A reference shot from Blender or Maya at the same lens, sensor, position and target overlays within a few pixels (`render-qa`, compare an edge).
3. Run `dofRange` and `cocPx` for the key shot. The sharp zone and the blur size in pixels agree with the screenshot.
4. Pull focus between two subjects and cut between cameras. Focus snaps on the cut and eases within a shot.
5. Handheld shake frame at 0, 1 and 2 s is identical on every replay. With reduced motion on, no shake or fly-through.
6. Gate: bars centred, aspect equals the target, safe frame overlays hidden in production.
7. Distortion on: corners are not black (`uZoom`), UI and picking still align.
8. Performance on the lowest tier: DOF and distortion disabled or cheaper (`performance-budget`).

Related: `motion-choreography` for easing, intros and reduced motion, `post-processing-stack` for DOF, motion blur, vignette and pass order, `realtime-engine-features` for the timeline and cuts, `antialiasing-resolution` for TAA and history, `color-management-grading` for exposure and tone mapping, `hud-ui-labels` for overlays, `render-qa` for screenshots, `performance-budget` for tiers, `3d-pro-pipeline` for shot planning.
