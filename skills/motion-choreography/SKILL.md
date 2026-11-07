---
name: motion-choreography
description: Premium motion for real-time 3D in Three.js — frame-rate-independent damping and springs, intro camera moves, camera rails along curves, scroll-driven scenes, hover/press micro-interactions with raycasting, AnimationMixer clips and crossfades, idle motion and reduced-motion support. Use when a scene feels static, jittery, robotic or cheap in motion, or when adding intros, scroll storytelling, interactions or character/object animation.
---

# Motion Choreography

Motion is where real-time 3D beats a render. Cheap motion (linear, frame-dependent, instant) undoes great materials.

## 1. Foundations

```js
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);   // clamp: no teleport after tab switch
  update(dt, clock.elapsedTime);
  composer.render(dt);
});
```
- Never animate by a fixed amount per frame (`x += 0.01`) — it runs 2× faster at 120 Hz.
- **Exponential damping** for "follow" motion: `x = THREE.MathUtils.damp(x, target, lambda, dt)` (λ 4–12). For vectors: `v.lerp(target, 1 - Math.exp(-lambda * dt))`. For quaternions: `q.slerp(target, 1 - Math.exp(-lambda * dt))`.
- **Springs** for physical overshoot (press, pop-in):
```js
function spring(s, target, dt, k = 170, c = 26) { // k stiffness, c damping (critically damped ≈ 2√k)
  const a = -k * (s.x - target) - c * s.v; s.v += a * dt; s.x += s.v * dt; return s.x;
}
```
  Sub-step when `dt` > 1/60 to keep it stable.

## 2. Easing vocabulary

| Motion | Ease | Duration |
|---|---|---|
| Camera intro / reveal | `easeOutCubic` / `easeOutExpo` | 1.6–2.4 s |
| UI-linked 3D (hover lift) | damp λ≈10 or spring | — |
| Object pop-in | spring with slight overshoot | ~0.6 s |
| Looping idle (float/bob) | `sin` with 3–6 s period, amplitude ≤ 2% of object size | ∞ |

`const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);` — use GSAP only if the project already has it.

## 3. Camera choreography

- **Intro dolly:** start ~1.6× further and 10–20° higher, ease into the hero pose; disable `controls` until it lands, then enable with damping.
- **Rails:** `CatmullRomCurve3` for position and a second curve (or fixed target) for look-at; sample with eased `t`; `camera.lookAt` every frame.
- **Never** combine a scripted camera move with active OrbitControls input — gate input or blend.
- Keep `controls.enableDamping = true` and call `controls.update(dt)` each frame.
- Auto-rotate at 0.3–0.6 speed, pause on user input, resume after ~4 s idle.

## 4. Scroll-driven scenes

```js
let scrollT = 0, smoothT = 0;
addEventListener('scroll', () => { scrollT = scrollY / (document.body.scrollHeight - innerHeight); }, { passive: true });
// in update: smoothT = THREE.MathUtils.damp(smoothT, scrollT, 6, dt); drive keyframes from smoothT
```
Map sections to keyframes `[{t:0, pos, target}, {t:0.33, ...}]` and interpolate between neighbours. Damped scroll removes jitter from trackpads.

## 5. Interaction

- Raycast on `pointermove` (throttle to rAF), only against an array of interactive meshes, not `scene.children` recursively.
- Hover: scale 1 → 1.04 with spring, emissive lift, `cursor: pointer`. Press: 0.97 then spring back.
- Touch: no hover — show affordance (pulse) instead; make tap targets generous (invisible larger proxy mesh).
- Expose keyboard equivalents for meaningful interactions (focusable buttons outside the canvas).

## 6. AnimationMixer (glTF clips)

```js
const mixer = new THREE.AnimationMixer(gltf.scene);
const actions = Object.fromEntries(gltf.animations.map((c) => [c.name, mixer.clipAction(c)]));
actions.Idle.play();
function go(name) { const next = actions[name]; next.reset().play(); current.crossFadeTo(next, 0.35, true); current = next; }
// loop: mixer.update(dt)
```
Use `LoopOnce` + `clampWhenFinished = true` for one-shot clips.

## 7. Reduced motion & battery

- `matchMedia('(prefers-reduced-motion: reduce)')` → no auto-rotate, no intro flight (cut to final pose), no camera shake, keep direct-manipulation only.
- Pause rendering when the canvas is off-screen (`IntersectionObserver`) or for static scenes render on demand (`controls.addEventListener('change', render)`).
