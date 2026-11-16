---
name: particle-system-architecture
description: Shared data shape and lifecycle for every particle effect in Three.js. Covers emitter and module stack, lifetime model (age, life, normalised t), structure-of-arrays typed buffers, spawn rate accumulators and bursts, ring-buffer pooling with no allocation in the loop, deterministic seeded randomness, CPU versus GPU decision by count and device tier, fixed update order, bounds and culling, and teardown, with a tested CPU system over InstancedMesh. Use when starting any particle, sparks, dust, smoke, rain or magic effect, choosing between CPU and GPU particles, fixing particles that vanish when the emitter leaves view, leak memory, stutter from garbage collection or differ between runs. Thai triggers พาร์ติเคิล, ระบบอนุภาค, ละออง, ประกายไฟ, เอฟเฟกต์ปล่อยอนุภาค, pool อนุภาค.
argument-hint: "<effect wanted, expected peak particle count, target device tier>"
---

# Particle System Architecture

One data shape for every particle effect, so forces, rendering, trails and GPU ports all plug into the same thing. Budget the count first in `performance-budget`, then build.

## 1. The shape of a particle system

```
Emitter (where, how fast, how many)  >  Spawn (init modules)  >  Buffers (SoA)  >  Update modules  >  Render
```

| Part | Owns | Rule |
|---|---|---|
| Emitter | Origin or shape, spawn rate, bursts, seed, duration, looping | Plain data object. No per-particle logic |
| Init modules | Write the starting value of each attribute at spawn | Run once per particle. Random values come from the seeded generator |
| Update modules | Forces, drag, colour and size over life, collision | Run every fixed step over every live slot, in a fixed order (section 7) |
| Buffers | Every per-particle attribute | Typed arrays allocated once at construction (section 3) |
| Render module | Mapping buffers to a mesh or points object | Never owns simulation state. See `particle-rendering-blending` |

A module is a function `(buffers, i, dt, ctx)` or a loop over a range. Keep modules data in the emitter, not in closures that allocate.

## 2. Pick CPU or GPU

| Peak live particles | Low tier | Mid tier | High tier | Approach |
|---|---|---|---|---|
| Up to 2k | CPU | CPU | CPU | Section 9 sample. Simplest, full flexibility, easy collisions and events |
| 2k to 10k | Stateless GPU | CPU or stateless | CPU | Motion as a function of time in the vertex shader. See `realtime-engine-features` section 2 |
| 10k to 100k | Stateless, count cut | Stateful GPU | Stateful GPU | Ping-pong textures. See `gpu-particles-compute` |
| 100k and up | Not on this tier | Stateful GPU, fill-rate bound | WebGPU compute | See `gpu-particles-compute` |

These counts are starting guesses. Tune by measuring a frame on the real device (`performance-budget`, `render-qa`).

| Need | Forces CPU | Forces GPU |
|---|---|---|
| Gameplay reads particle positions (hit tests, pickups) | CPU | Readback stalls (section 6 of `gpu-particles-compute`) |
| Per-particle collision against scene physics | CPU | Plane, depth buffer or SDF only |
| Fixed seed replay and scrubbing on the timeline | Either, GPU needs hash-based randomness | Section 6 here |
| Millions of simple points | | GPU |

Fill rate, not count, is the usual limit for large soft sprites. Check overdraw in `particle-rendering-blending` before raising count.

## 3. Buffers: structure of arrays, allocated once

One typed array per attribute, packed by component. Never an array of particle objects.

| Attribute | Layout | Bytes per particle |
|---|---|---|
| position | `Float32Array(cap * 3)` | 12 |
| velocity | `Float32Array(cap * 3)` | 12 |
| age | `Float32Array(cap)` | 4 |
| life (total) | `Float32Array(cap)`, 0 means slot free | 4 |
| seed or random | `Float32Array(cap)` for stable per-particle variation | 4 |
| colour, size, rotation | Only if they cannot be derived from `t = age / life` | 4 to 16 |

Rules:
- **Derive before you store.** Size, colour and alpha as functions of `t` cost nothing in memory and need no update pass. Store only state that integrates (position, velocity, angular velocity).
- **Allocate for peak** `capacity = peakRate * maxLife`, plus 10 percent. Never grow arrays at run time.
- **GPU textures want four floats.** Pad vec3 to vec4 and put `age` or `life` in `w`. Details in `gpu-particles-compute`.
- **Upload only what changed.** Mark `DynamicDrawUsage` on attributes you rewrite each frame. Use `needsUpdate = true`, or `addUpdateRange(start, count)` (`BufferAttribute`, three r159 and later) when only a slice changed.
- **Interleave only for the GPU upload,** keep simulation data separate so each module streams the arrays it touches.

## 4. Lifetime model

Every particle carries `age` and `life`. Everything else keys off `t = age / life` in 0 to 1.

| Mode | Behaviour | Typical use |
|---|---|---|
| Looping | Emitter runs forever, rate-driven | Fire, smoke, ambient dust |
| One-shot burst | Emit N, then stop, effect ends when `alive == 0` | Explosion, impact, pickup |
| Duration plus tail | Emit for D seconds, wait for the last particle to die | Muzzle flash, spell cast |
| Immortal | `life = Infinity`, killed by a module | Snow that lands, debris that settles |

- Kill rule: `t >= 1`, or a module sets `life = 0` (hit the ground and settled, left the volume).
- Give each effect an explicit `finished` state (`!emitting && alive === 0`) so owners can pool or dispose it.
- Randomise life per particle (min to max) or the effect pulses in lockstep.

## 5. Spawn: rate, bursts and the ring buffer

Rate: carry the fraction. `acc += rate * dt; n = floor(acc); acc -= n;` spawns exactly `rate` per second at any frame rate. Rounding per frame drops or doubles particles.

Burst: spawn N in one step at a given time. Keep a sorted list of `{ t, count }` and fire those crossed since the last step. Bursts and rate add.

**Pooling: ring buffer.** A write head walks the arrays and wraps. A slot is free when `life[i] <= 0`. No allocation, no free list, O(1) spawn.

| Strategy | Use when | Cost |
|---|---|---|
| Ring buffer, overwrite oldest | Sparks, trails, rain. Losing the oldest is invisible | Scan all slots per step. Holes mean no `drawRange` shortcut |
| Ring buffer, drop new | Gameplay-critical particles must never vanish | Spawn silently fails when full, count it for tuning |
| Dense array with swap-remove | CPU only, variable life, you want `mesh.count = alive` | Slot order changes, so per-particle IDs and trails break |
| Free list | Rarely needed on top of a ring buffer | Extra array and bookkeeping |

On GPU the ring buffer maps to a texture: spawn writes a contiguous window of texels (wrapping), no CPU readback. See `gpu-particles-compute`.

## 6. Deterministic randomness

Replays, scrubbing, networked effects and `render-qa` screenshots need the same particles every run.

- **Never call `Math.random` inside a simulation.** Use a seeded generator (`mulberry32` in the sample) owned by the emitter.
- **Seed per emitter instance,** not global. Derive it from an id so two identical emitters differ on purpose.
- **Consume the generator in a fixed order** per spawn. Adding one extra `rng()` call shifts every later particle, so treat the order as part of the effect.
- **GPU or stateless:** no generator state exists, so use a hash of the particle index, `fract(sin(i * 12.9898) * 43758.5453)` is the common cheap one (precision varies by GPU, so it is stable per device, not across devices). Prefer an integer hash for cross-device identical results (see `shader-craft`).
- **Scrubbing backward:** a stateful simulation cannot rewind. Either restart from the seed and fast-forward with fixed steps, or use a stateless function of time.

## 7. Update order

Fixed order every step, so results do not depend on module registration order.

1. Advance emitter clock, spawn (rate, bursts) into free slots.
2. Age particles, kill those with `t >= 1`.
3. Apply forces to velocity (`particle-forces-fields`).
4. Integrate position, semi-implicit Euler (velocity first, then position).
5. Collide and resolve (position and velocity corrections).
6. Derive render values from `t` (size, colour, alpha, frame index).
7. Write render buffers, set `needsUpdate`.

Run the step at a **fixed dt** (1/60 is typical) from an accumulator, clamp the frame time (0.1 s) so a stalled tab does not run 300 steps. This makes results frame-rate independent, and deterministic with a seed. Interpolating render positions between the last two steps is optional, skip it unless fixed-step stutter shows. For ribbons and trails see `particle-trails-ribbons` and `motion-choreography`.

## 8. Bounds and culling

- **`frustumCulled = false`** on any `InstancedMesh`, `Points` or instanced `ShaderMaterial` mesh whose bounds are not the real spread. Culling uses the base geometry, so particles pop out when the origin leaves the view.
- **Better: set honest bounds.** `radius = maxSpeed * maxLife + 0.5 * |gravity| * maxLife^2 + particleSize`, then assign `geometry.boundingSphere = new THREE.Sphere(center, radius)`. Culling stays on and the whole effect skips when off screen.
- **Do not call `computeBoundingSphere()` per frame.** It scans every vertex or instance.
- **Skip simulation when off screen and cheap to restart** (ambient dust). Looping effects can fast-forward `life` worth of steps on re-entry, or simply resume.
- **Distance LOD:** scale spawn rate and capacity down with camera distance. Halve `rate` beyond a set distance rather than drawing tiny particles.
- **Cap total live particles across all emitters** with one shared budget, the oldest effects yield first.

## 9. Verified sample: CPU system over InstancedMesh

Tested in Node with three r187: same seed gives identical buffers, spawn rate is exact (100 per second over one second), ring overflow keeps the buffers and wraps `head`, frame sizes 1/16 s and 1/32 s give identical results, a 5 s stall simulates at most 0.1 s, heap is flat over 20000 frames, dispose empties the scene. Drawing on a GPU was not run here, use `render-qa`.

```js
import * as THREE from 'three';

// Seeded PRNG (mulberry32). Never call Math.random inside a simulation.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ParticleSystem {
  constructor(geometry, material, o = {}) {
    const cap = (this.cap = o.capacity ?? 2000);
    this.rate = o.rate ?? 200;                                  // particles per second
    this.life = o.life ?? [0.8, 1.6];                           // min, max seconds
    this.speed = o.speed ?? [2, 4];
    this.spread = o.spread ?? 0.4;                              // cone half angle, radians
    this.size = o.size ?? 0.1;
    this.gravity = o.gravity ?? -9.8;
    this.origin = new THREE.Vector3();
    this.step = 1 / 60;                                         // fixed simulation step
    this.rng = mulberry32(o.seed ?? 1);

    // structure of arrays, allocated once. life[i] <= 0 means the slot is free.
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.lifeOf = new Float32Array(cap);

    this.head = 0;           // next slot to write (ring buffer)
    this.alive = 0;
    this.spawned = 0;
    this.acc = 0;            // fractional spawn carry
    this.clock = 0;          // fixed-step time left over

    this.mesh = new THREE.InstancedMesh(geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;                            // bounds are not the unit geometry
    this.m = this.mesh.instanceMatrix.array;                    // m[i*16 + 0,5,10] = scale, 12..14 = translation
    for (let i = 0; i < cap; i++) this.m.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], i * 16);
  }

  burst(n) { for (let k = 0; k < n; k++) this.spawnOne(); }

  spawnOne() {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.lifeOf[i] <= 0) this.alive++;                      // else: overwrote the oldest live particle
    const r = this.rng;
    const cosT = 1 - r() * (1 - Math.cos(this.spread));         // uniform inside the cone around +Y
    const sinT = Math.sqrt(1 - cosT * cosT), phi = r() * Math.PI * 2;
    const sp = this.speed[0] + r() * (this.speed[1] - this.speed[0]);
    this.pos[i * 3] = this.origin.x; this.pos[i * 3 + 1] = this.origin.y; this.pos[i * 3 + 2] = this.origin.z;
    this.vel[i * 3] = sinT * Math.cos(phi) * sp; this.vel[i * 3 + 1] = cosT * sp; this.vel[i * 3 + 2] = sinT * Math.sin(phi) * sp;
    this.age[i] = 0;
    this.lifeOf[i] = this.life[0] + r() * (this.life[1] - this.life[0]);
    this.spawned++;
  }

  // call once per frame with the real frame time
  advance(frameDt) {
    this.clock += Math.min(frameDt, 0.1);                       // clamp stalls, no spiral of death
    while (this.clock >= this.step) { this.tick(this.step); this.clock -= this.step; }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  tick(dt) {
    // 1 emit
    this.acc += this.rate * dt;
    const n = Math.floor(this.acc);
    this.acc -= n;
    for (let k = 0; k < n; k++) this.spawnOne();
    // 2 integrate, 3 kill, 4 write render data
    const { pos, vel, age, lifeOf, m } = this;
    for (let i = 0; i < this.cap; i++) {
      if (lifeOf[i] <= 0) continue;
      age[i] += dt;
      const t = age[i] / lifeOf[i];
      if (t >= 1) { lifeOf[i] = 0; this.alive--; m[i * 16] = m[i * 16 + 5] = m[i * 16 + 10] = 0; continue; }
      const j = i * 3;
      vel[j + 1] += this.gravity * dt;                          // semi-implicit Euler: velocity first
      pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
      const s = this.size * (1 - t);
      m[i * 16] = m[i * 16 + 5] = m[i * 16 + 10] = s;
      m[i * 16 + 12] = pos[j]; m[i * 16 + 13] = pos[j + 1]; m[i * 16 + 14] = pos[j + 2];
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
```

Use it:

```js
const ps = new ParticleSystem(new THREE.IcosahedronGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0xffc070 }), { capacity: 2000, rate: 300, seed: 42 });
scene.add(ps.mesh);
// per frame: ps.advance(clock.getDelta());   one shot: ps.rate = 0; ps.burst(200);
```

Adapting it:
- **`Points` instead of `InstancedMesh`:** write `pos` straight into the position attribute (`DynamicDrawUsage`), and fade dead slots by moving them far away or with a size attribute in a `ShaderMaterial`. `PointsMaterial` has one size for all points.
- **Per-instance colour:** `mesh.setColorAt(i, color)` once, then update `instanceColor.needsUpdate`. For colour over life derive it in the shader from a stored `t`.
- **Many effects:** share geometry and material across systems, one draw call per system. Merge systems with the same material into one larger capacity instead of many small ones.

## 10. Teardown

- `scene.remove`, then `geometry.dispose()`, `material.dispose()`, every texture `.dispose()`, and `InstancedMesh.dispose()`.
- Drop references to the typed arrays (`ps.pos = null`) so they can be collected.
- Cancel timers and `requestAnimationFrame` handles, remove resize listeners.
- Pool whole effects, not particles inside them. A finished effect resets `head`, `alive`, `acc`, `clock` and zeroes `life` instead of being rebuilt.
- Check `renderer.info.memory.geometries` and `textures` return to baseline after removing an effect (`performance-budget`).

## 11. Verify

1. Seeded run twice, compare a buffer checksum. It must match.
2. Run at 30 and 144 fps (throttle the loop), the effect must look the same.
3. Orbit so the emitter leaves the frame, particles must not pop.
4. Leave it running a minute and watch the heap (devtools Memory). A sawtooth means per-frame allocation, hunt `new`, array literals, spread and `Vector3` clones in the loop.
5. Burst past `capacity` and confirm the overflow policy you chose.

## 12. Do not do these

- Do not allocate vectors, arrays or closures inside the update loop.
- Do not call `Math.random` in a simulation or `Date.now` for time. Use the fixed step.
- Do not use one mesh or `Object3D` per particle. That is draw-call and scene-graph cost per particle.
- Do not size `capacity` from an average rate. Use peak rate times max life.
- Do not read GPU particle state back to the CPU every frame (`gpu-particles-compute`).
- Do not put rigid body gameplay in particles. Use `physics-rigidbody`.

Related: `particle-forces-fields`, `particle-rendering-blending`, `particle-trails-ribbons`, `gpu-particles-compute`, `vfx-timing-choreography`, `vfx-performance-scaling`.
