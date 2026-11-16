---
name: vfx-timing-choreography
description: Timing a VFX beat in Three.js. Covers the beat structure (anticipation, impact, release, settle), burst and spawn-over-time curves, hit stop and slow motion with a global time scale that keeps UI and camera on their own clocks, camera shake and flash punctuation, syncing effects to animation events and audio, frame-rate independence (damping, spawn integration, dt clamp) and a reusable effect timeline with cues. Includes a verified clock, curve spawner and cue timeline. Use when an effect feels weak, floaty or late, when hits need weight, when effects must land on an animation frame or an audio beat, when slow motion breaks the UI or camera, or when particles behave differently at 30 and 144 fps. Thai triggers จังหวะเอฟเฟกต์, ฮิตสต็อป, สโลว์โมชัน, ซิงก์เอฟเฟกต์กับเสียง, ความหน่วงของเอฟเฟกต์, เฟรมเรตไม่เท่ากัน, ภาพวาบหน้าจอ.
argument-hint: "<effect or hit to time, and what it must sync to: animation frame, audio or user input>"
---

# VFX Timing & Choreography

An effect reads as strong or weak mostly because of timing, not particle count. Decide the beat first, then spend particles on it. For the editor style multi-track Sequencer see `realtime-engine-features` section 3. This skill covers the short one-shot beat that Sequencer does not: hit stop, clocks, cues and spawn curves. Curve authoring is in `animation-curves-graph-editor`, shake internals in `cinematic-camera-rig`.

## 1. Anatomy of a beat

Starting values are guesses to tune by eye at 60 fps, one frame is 16.7 ms.

| Phase | Starting length | What happens | Common mistake |
|---|---|---|---|
| Anticipation | 100 to 400 ms | Pull-in, glint, charge glow, sparse particles moving inward | Skipped, so the impact has no contrast |
| Impact | 1 to 3 frames | Flash, hit stop, shake spike, brightest particles | Too long, reads as lag |
| Release | 200 to 600 ms | Burst, debris, shockwave, fastest motion | Everything at the same speed |
| Settle | 0.5 to 3 s | Smoke, embers, decals fade, light decay | Cut instead of faded, or too long and clutters the next beat |

Rules:
- **Contrast makes the hit.** Slow or still before, fast and bright at the impact, slow again after.
- **Fewer, bigger, earlier.** Strong first frame, then thin out. A burst that peaks on frame 3 feels late.
- **Light the impact.** A short point light or emissive pulse (`vfx-fire-smoke-explosion`, `vfx-impact-sparks-decals`) sells it more than extra sparks.
- **Do not time on one monitor.** Check at 30 and 144 fps (section 7).

## 2. Clocks

One real clock, several scaled clocks. Use `THREE.Timer` for the real delta (`THREE.Clock` is deprecated since r183, `timer.update()` then `timer.getDelta()`, `timer.connect(document)` pauses on tab hide).

| System | Clock | Why |
|---|---|---|
| Particles, sims, physics step, effect cues, actor animation (`mixer.update`) | **world** | Freezes in hit stop, slows in slow motion |
| Shake decay, FOV punch, camera moves | **camera** | Follows the world only partly, so slow motion does not look like lag |
| Flash, vignette pulse, damage numbers, HUD | **ui (real)** | The flash must play during the freeze, that is its job |
| Audio | `AudioContext.currentTime` | Section 6 |
| Input, cooldown display | real | A frozen world must still accept input |

## 3. Verified clocks, spawn curve and cue timeline

One file, run in Node 22 with deterministic steps. Checks passed: spawn totals identical at 20, 30, 60 and 144 fps and with irregular steps (240 particles from a 240 area curve), cues fire once in order with `late` under one frame, world time is frozen while UI time runs during a hit stop, strongest slow request wins, camera follows 25 percent, dt is clamped, recovery ends exactly at 1.

```js
// Separate clocks: real (UI), world (effects, sims, animation), camera (shake, follows the world only partly).
export class Clocks {
  constructor({ maxDt = 1 / 15, cameraFollow = 0.25 } = {}) { this.maxDt = maxDt; this.cameraFollow = cameraFollow; this.reqs = []; }
  // Scale applies for `hold` REAL seconds, then smoothsteps back to 1 over `recover` real seconds. scale 0 is a hit stop.
  slow(scale, hold, recover = 0.15) { this.reqs.push({ scale, hold, recover, age: 0 }); }
  hitStop(seconds) { this.slow(0, seconds, 0.04); }
  step(realDt) {
    const real = Math.min(realDt, this.maxDt);          // tab switch or breakpoint must not explode the sim
    let s = 1;
    this.reqs = this.reqs.filter((r) => (r.age += real) < r.hold + r.recover);
    for (const r of this.reqs) {
      const k = r.age <= r.hold ? 0 : (r.age - r.hold) / r.recover;
      s = Math.min(s, r.scale + (1 - r.scale) * k * k * (3 - 2 * k));   // strongest request wins, they never multiply
    }
    return { real, ui: real, world: real * s, camera: real * (1 + (s - 1) * this.cameraFollow), scale: s };
  }
}

// Exact area under a piecewise linear rate curve [[t, perSecond], ...] from keys[0].t to t. Rate is 0 outside the keys.
const area = (keys, t) => {
  let a = 0;
  for (let i = 0; i + 1 < keys.length; i++) {
    const [t0, r0] = keys[i], [t1, r1] = keys[i + 1];
    if (t <= t0) break;
    const te = Math.min(t, t1), re = r0 + (r1 - r0) * (te - t0) / (t1 - t0);
    a += (r0 + re) * 0.5 * (te - t0);
  }
  return a;
};
// Frame rate independent spawning: integrate the curve over each step, carry the fraction.
export class CurveSpawner {
  constructor(keys) { this.keys = keys; this.reset(); }
  reset() { this.t = 0; this.acc = 0; }
  step(dt) {
    const a0 = area(this.keys, this.t);
    this.t += dt;
    this.acc += area(this.keys, this.t) - a0;
    const n = Math.floor(this.acc);
    this.acc -= n;
    return n;
  }
}

// Cues fire once, in order, on world time. `late` is how far past the cue the step went, use it to age what you spawn.
export class FxTimeline {
  constructor(cues) { this.cues = [...cues].sort((a, b) => a.t - b.t); this.t = 0; this.next = 0; }
  reset() { this.t = 0; this.next = 0; }
  update(worldDt) {
    this.t += worldDt;
    while (this.next < this.cues.length && this.cues[this.next].t <= this.t) {
      const c = this.cues[this.next++];
      c.fn(this.t - c.t);
    }
  }
}
```

Wiring (inside your loop):

```js
timer.update();
const c = clocks.step(timer.getDelta());
fx.update(c.world);              // timeline cues, spawners, particle uniforms
mixer.update(c.world);           // or mixer.timeScale = c.scale and pass real dt
shake.update(c.camera);          // trauma decay
flash.update(c.ui);              // overlay alpha
renderer.render(scene, camera);
```

## 4. Spawn over time

Spawn is a rate curve integrated over each step. `rate * dt` per frame (or `count / 60`) changes with frame rate, the integral does not (verified above).

| Shape | Rate keys | Use |
|---|---|---|
| Instant burst | `[[0,0],[0.02,4000],[0.12,0]]` | Explosion core, impact sparks. Area equals particle count |
| Ramp up | `[[0,0],[0.4,300],[0.41,0]]` | Charge, anticipation |
| Pulse train | Repeat the burst keys at an interval | Machine gun, heartbeat |
| Sustained | `[[0,60],[2,60],[2.3,0]]` | Smoke, trail, thruster with a tail off |

Rules:
- **Carry the fraction** (done in `acc`) or a 40 per second emitter spawns nothing at 144 fps.
- **Age new particles by `late`.** A particle spawned mid step should start already moved by `late * velocity`, or a 20 fps frame shows a visible clump.
- **Cap spawn per step** (for example `Math.min(n, capacity - alive)`) so a long frame cannot overflow the pool. Pool rules are in `vfx-performance-scaling`.
- **Stateless GPU particles** take the burst start time as a uniform and compute age in the shader (`realtime-engine-features` section 2), the cue only writes `uStart`.

## 5. Hit stop, slow motion and punctuation

**Hit stop.** `clocks.hitStop(0.06)` freezes the world clock for 60 ms of real time (start 40 to 120 ms, tune). It freezes the attacker, the target and the effects together. Never freeze the camera or UI.

**Slow motion.** `clocks.slow(0.25, 0.4, 0.3)` holds 25 percent for 0.4 s then eases back over 0.3 s. Ease back, never snap. Multiple requests do not multiply (strongest wins), or stacked hits crawl.

Rules:
- **Reserve hit stop for heavy hits and kills.** On every hit it becomes stutter.
- **Run the flash and shake during the freeze.** That is why they are on the ui and camera clocks.
- **Physics:** feed the fixed step accumulator with world dt (`physics-rigidbody`). Zero dt means zero steps, no special case.
- **Post effects with their own time** (grain, scanlines, `vfx-post-fx-compositing`) stay on real time so the screen does not freeze with the world.
- **Respect `prefers-reduced-motion`:** drop shake, FOV punch and flash strength, keep hit stop short.

| Punctuation | Starting values (guess) | Clock |
|---|---|---|
| Shake | Trauma 0.4 to 1 added on hit, offset scales with trauma squared, decay about 1.5 per second | camera |
| Flash | White or tinted overlay, alpha 0.3 to 0.6, gone in 80 to 150 ms. Keep it under flash safety limits (no more than 3 flashes per second, avoid full white) | ui |
| FOV punch | +2 to 4 degrees, exponential return in 150 to 250 ms | camera |
| Chromatic or radial pulse | Strength spike on the impact frame (`vfx-post-fx-compositing`) | ui |
| Gamepad rumble | `gamepad.vibrationActuator.playEffect('dual-rumble', { duration, strongMagnitude, weakMagnitude })`, Chromium only (verify) | real |

## 6. Syncing to animation and audio

**Animation events.** three.js has no per frame animation events. Options, in order of preference:

| Method | Use when |
|---|---|
| Mixer events: `mixer.addEventListener('finished' \| 'loop', e => e.action)` | Effect at the end or loop point of a clip. Verified in source |
| Cue table keyed by clip time: store `{ clip, time, fx }`, compare `action.time` before and after `mixer.update`, handle the loop wrap and negative `timeScale` | Footstep dust, weapon swing trail, muzzle flash at a known frame |
| Marker empties or named bones (`fx_hit`) in the rig | Spawn position follows the actor. Read its world matrix at the cue |
| Clip extras written by the DCC exporter | Not a three.js feature. Whether `GLTFLoader` exposes clip extras is unconfirmed (verify) |

Rules: derive the cue from clip time, not wall time, so slow motion and hit stop move it with the animation. Spawn at the marker's world position on the cue frame, not at the actor origin. Character clip workflow is in `character-animation-retarget`, blends in `animation-curves-graph-editor`.

**Audio.** The audio clock is `AudioContext.currentTime`, it does not stop for hit stop and it is not frame locked.
- **Schedule ahead:** `source.start(when)` with `when = ctx.currentTime + lookahead`. A `setTimeout` trigger drifts.
- **Latency:** `ctx.outputLatency` reports output delay where supported (verify browser support). Delay the visual by it, or fire audio that much earlier, so flash and sound land together.
- **Beat sync:** drive the music track timeline from `ctx.currentTime - startTime` instead of adding dt, otherwise it drifts. Cues then fire on that time through the same `FxTimeline.update` by passing the delta between audio times.
- **Slow motion audio:** `source.playbackRate.value = scale` lowers pitch, which sells the slowdown. Skip it for dialogue and music.
- Sound is loud before it is long: a short transient on the impact frame matters more than the tail.

## 7. Frame-rate independence

| Mistake | Fix |
|---|---|
| `v *= 0.98` per frame | `v *= Math.exp(-k * dt)` |
| `x = lerp(x, target, 0.1)` per frame | `THREE.MathUtils.damp(x, target, lambda, dt)` |
| `spawn += 5` per frame | Integrate the rate curve (section 4) |
| `age += 1/60` | `age += world dt` |
| Raw delta after a tab switch | Clamp (`maxDt` in `Clocks`), then step sims in fixed sub steps |
| Euler integration of gravity | `p += v * dt + 0.5 * g * dt * dt` or fixed step |
| Random per frame decisions at a fixed chance | Chance per second converted with `1 - exp(-rate * dt)` |

Fixed step for anything chaotic (collisions, constraints): accumulate world dt, step at 1/60 or 1/120, cap steps per frame at 4 to 5 to avoid the spiral of death, interpolate the render.

## 8. Reusable effect timeline

`FxTimeline` above is the whole pattern: sorted cues, one pass, `late` passed to each cue, `reset()` to retrigger a pooled effect.

```js
const hit = new FxTimeline([
  { t: 0.00, fn: (late) => { spawner.reset(); shake.add(0.5); flash.fire(0.5); clocks.hitStop(0.06); } },
  { t: 0.00, fn: (late) => ring.start(late) },
  { t: 0.15, fn: (late) => smoke.start(late) },
  { t: 0.90, fn: () => pool.release(effect) },
]);
```

Rules:
- Cues are idempotent and tiny. They set state or start emitters, they do not loop.
- Retrigger by `reset()`, never by building a new timeline per hit. Pool effects (`vfx-performance-scaling`).
- Cues on one world clock freeze and slow together, which is the point. Put anything that must not freeze on another timeline driven by `c.ui`.
- Scrub or replay for tuning: step the timeline with a fixed dt from zero, never from the live loop, so a tuned beat is reproducible (`render-qa`).
- Data driven version: cue lists live in effect JSON (`vfx-graph-authoring`), the function is looked up by name from a table.
- Choreographing several effects of one scene (staggered explosions, chained reactions): offset cues by a seeded random in a range, not by hand, and cap simultaneous bursts to the effect budget in `vfx-performance-scaling`.

## 9. Verify

1. Step the beat at 30, 60 and 144 fps with fixed dt and compare particle counts and peak frame. Totals must match within one particle.
2. Capture frames around the impact: flash at the impact frame or one after, never before the contact pose.
3. Trigger hit stop. World frozen, UI and flash alive, shake plays, no particles move.
4. Trigger slow motion, then a second one mid recovery. No stutter, no stacking crawl, returns to scale 1.
5. Switch tabs for 10 s and return. No burst of catch up, no explosion of particles.
6. Audio and visual: record a screen capture with sound and compare the frame of the flash with the waveform peak. Offset beyond about 40 ms reads as out of sync (guess, tune).
7. Reduced motion preference on: no shake, no strong flash, effect still readable.

## 10. Not verified here

- Rumble API behaviour across browsers, `outputLatency` support, glTF clip extras exposure.
- The numbers in sections 1 and 5 are starting guesses from common practice, not measured.
- Real browser timing (the sample was checked with deterministic steps in Node, not in a live render loop).

## 11. Do not do these

- Do not scale UI or camera by the world time scale.
- Do not use per frame constants for decay, lerp or spawn.
- Do not hit stop every hit.
- Do not trigger audio from `setTimeout`.
- Do not snap time scale back to 1. Ease it.
