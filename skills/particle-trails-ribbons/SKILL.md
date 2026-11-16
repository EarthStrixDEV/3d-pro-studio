---
name: particle-trails-ribbons
description: Trails, ribbons, beams, lightning and tubes in Three.js. Covers position history ring buffers sampled on a fixed time step, camera-facing ribbon geometry with no per-frame allocation, width and colour over life, UV scrolling along a trail (arc length, head-relative or world-stuck), beams and midpoint-displacement lightning with seeded jitter, tubes for lit solid beams, segment and vertex budgets, many trails in one draw call, and dropped-frame stability (frame-rate independence, teleports, stalled tabs). Includes a tested Trail class and lightning function. Use when something needs a streak behind it, a sword swoosh, a laser, a lightning bolt, a rope of energy, comet tails, motion trails, or when trails stretch, flicker or break at low frame rates. Thai triggers เส้นหาง, trail, ริบบิ้น, ฟ้าผ่า, ลำแสง, เส้นแสงตามหลัง, หางดาวหาง.
argument-hint: "<what leaves the trail or beam, desired length in seconds, number of trails, target tier>"
---

# Particle Trails & Ribbons

A trail is geometry built from where something has been. Spawn, lifetime and buffer rules are in `particle-system-architecture`, forces that move the head in `particle-forces-fields`, blending and bloom in `particle-rendering-blending`.

## 1. Pick the form

| Want | Form | Notes |
|---|---|---|
| Streak behind a moving object (comet, bullet, magic orb) | History ribbon, camera-facing (section 2 to 4) | Sample on a fixed time step |
| Per-particle tails on thousands of sparks | Stretched billboard (`particle-rendering-blending` section 3) | Cheaper than a history per particle. Use ribbons only for hero particles |
| Sword slash, vehicle skid, ground mark | Ribbon with a locked normal (up axis) | Replace the camera vector in the side computation with a fixed normal |
| Fixed laser or energy link between two points | Beam, a short ribbon with 2 to 32 points | Scroll the UV, jitter in the shader or on the CPU |
| Lightning | Midpoint-displaced polyline as a ribbon | Section 6 |
| Solid lit rope, cable, thick energy column | Tube | Section 7 |
| Glow only, no shape detail | Single quad stretched between two points | One quad, cheapest |

## 2. History buffer

- **Sample by time, not by frame.** Push a point every `interval` seconds (1/60 is typical), interpolating the position inside the frame. Sampling per frame makes trails longer at low frame rate and shorter at high.
- **Ring buffer with per-point `age` and `dist`.** Drop points with `age >= life` from the oldest end. Capacity is `ceil(life / interval) + 1`.
- **A live head** vertex at the current position closes the gap between the newest sample and the object. It is not stored.
- **Record travelled distance** at each sample. It drives UV mapping (section 5), independent of speed.
- **World space.** Positions go in world space and the mesh sits at the scene root with an identity transform. For a child object use `getWorldPosition`.
- **Teleport or respawn:** call `reset(p)`. Otherwise a straight streak connects the two places.

## 3. Verified sample: ribbon trail and lightning

Node tested with three r187: with 60 Hz frames and with irregular 4 to 40 ms frames every stored point lies on the same absolute time grid, sample counts equal `floor(T / interval)`, old points are dropped, ribbon width is perpendicular to the view vector at every vertex (including when the object is stationary at the head), width tapers to the tail, `uv.y` is monotonic, a reset breaks the trail, a 5 s stall adds at most 0.1 s of points, lightning is deterministic with fixed endpoints and bounded spread, heap is flat over 20000 frames. A headless WebGL2 render drew the ribbon along its path and nothing elsewhere. That render found a real bug (a degenerate head side vector), now fixed. Real GPU timing was not measured.

```js
import * as THREE from 'three';

// Camera-facing ribbon trail. History is sampled on a fixed time interval (not per frame), so the shape
// does not depend on frame rate. All buffers are allocated once.
export class Trail {
  constructor({ points = 48, interval = 1 / 60, life = 0.8, width = 0.2, widthCurve = (t) => 1 - t, material } = {}) {
    this.N = points; this.interval = interval; this.life = life; this.width = width; this.widthCurve = widthCurve;
    this.hist = new Float32Array(points * 3);      // ring buffer of sampled positions
    this.age = new Float32Array(points);
    this.dist = new Float32Array(points);          // distance travelled by the emitter when each point was sampled
    this.head = 0; this.count = 0; this.acc = 0; this.travel = 0; this.pushed = 0;
    this.prev = new THREE.Vector3(); this.last = new THREE.Vector3(); this.hasPrev = false;
    this.headDist = 0;                             // travelled distance at the live head, for head relative UV scroll

    const V = (points + 1) * 2;                    // +1 for the live head vertex pair
    this.P = new Float64Array((points + 1) * 4);   // scratch: x, y, z, t per point
    const g = this.geometry = new THREE.BufferGeometry();
    this.pos = new Float32Array(V * 3); this.uv = new Float32Array(V * 2); this.tAttr = new Float32Array(V);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aT', new THREE.BufferAttribute(this.tAttr, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(points * 6);       // fixed strip topology, draw range does the rest
    for (let s = 0; s < points; s++) idx.set([2 * s, 2 * s + 1, 2 * s + 2, 2 * s + 1, 2 * s + 3, 2 * s + 2], s * 6);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, material ?? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
  }

  // call on teleport or respawn so no streak is drawn between the two places
  reset(p) { this.count = 0; this.acc = 0; this.prev.copy(p); this.last.copy(p); this.hasPrev = true; }

  _push(x, y, z, age) {
    const i = this.head, d = this.last;
    this.travel += Math.hypot(x - d.x, y - d.y, z - d.z); d.set(x, y, z);
    this.hist[i * 3] = x; this.hist[i * 3 + 1] = y; this.hist[i * 3 + 2] = z;
    this.age[i] = age; this.dist[i] = this.travel;
    this.head = (i + 1) % this.N; if (this.count < this.N) this.count++; this.pushed++;
  }

  update(p, dt, camPos) {
    dt = Math.min(dt, 0.1);                        // a stalled tab must not stretch the trail
    if (!this.hasPrev) this.reset(p);
    const { N, hist, age } = this;
    for (let k = 0; k < this.count; k++) age[(this.head - 1 - k + N) % N] += dt;
    while (this.count > 0 && age[(this.head - this.count + N) % N] >= this.life) this.count--;   // drop expired, oldest first
    const acc0 = this.acc, prev = this.prev;
    let k = 1;
    while (dt > 0 && k * this.interval - acc0 <= dt + 1e-9) {
      const tk = k * this.interval - acc0, f = tk / dt;             // sample time inside this frame
      this._push(prev.x + (p.x - prev.x) * f, prev.y + (p.y - prev.y) * f, prev.z + (p.z - prev.z) * f, Math.max(0, dt - tk));
      k++;
    }
    this.acc = acc0 + dt - (k - 1) * this.interval;
    prev.copy(p);
    this.headDist = this.travel + Math.hypot(p.x - this.last.x, p.y - this.last.y, p.z - this.last.z);
    this._build(camPos);
  }

  _build(cam) {
    const { N, hist, age, dist, P } = this, n = this.count + 1;
    P[0] = this.prev.x; P[1] = this.prev.y; P[2] = this.prev.z; P[3] = 0;                 // live head
    for (let s = 1; s < n; s++) {
      const i = (this.head - s + N) % N;
      P[s * 4] = hist[i * 3]; P[s * 4 + 1] = hist[i * 3 + 1]; P[s * 4 + 2] = hist[i * 3 + 2]; P[s * 4 + 3] = age[i] / this.life;
    }
    let sx = 1, sy = 0, sz = 0;                    // last good side vector
    for (let s = n - 1; s >= 0; s--) {              // tail to head, so a degenerate point inherits the older side
      const a = Math.max(s - 1, 0) * 4, b = Math.min(s + 1, n - 1) * 4, c = s * 4;
      const tx = P[a] - P[b], ty = P[a + 1] - P[b + 1], tz = P[a + 2] - P[b + 2];          // tangent, newest to oldest sign is irrelevant
      const vx = cam.x - P[c], vy = cam.y - P[c + 1], vz = cam.z - P[c + 2];
      let cx = ty * vz - tz * vy, cy = tz * vx - tx * vz, cz = tx * vy - ty * vx;
      const cl = Math.hypot(cx, cy, cz);
      if (cl > 1e-9) { sx = cx / cl; sy = cy / cl; sz = cz / cl; }                          // else keep the previous side, no flip
      const t = P[c + 3], w = this.width * 0.5 * this.widthCurve(t);
      const d = s === 0 ? this.headDist : dist[(this.head - s + N) % N];
      const o = s * 6;
      this.pos[o] = P[c] + sx * w; this.pos[o + 1] = P[c + 1] + sy * w; this.pos[o + 2] = P[c + 2] + sz * w;
      this.pos[o + 3] = P[c] - sx * w; this.pos[o + 4] = P[c + 1] - sy * w; this.pos[o + 5] = P[c + 2] - sz * w;
      this.uv[s * 4] = 0; this.uv[s * 4 + 1] = d; this.uv[s * 4 + 2] = 1; this.uv[s * 4 + 3] = d;   // v is world distance, scale in the shader
      this.tAttr[s * 2] = this.tAttr[s * 2 + 1] = t;
    }
    this.geometry.setDrawRange(0, n >= 2 ? (n - 1) * 6 : 0);
    for (const k of ['position', 'uv', 'aT']) this.geometry.attributes[k].needsUpdate = true;
  }

  dispose() { this.mesh.removeFromParent(); this.geometry.dispose(); this.mesh.material.dispose(); }
}

// Lightning or beam by midpoint displacement. out holds (2^gen + 1) points. rng() returns 0..1, use a seeded one.
// Re-roll at 15 to 30 Hz, not every frame, or it reads as noise instead of a bolt.
export function lightning(a, b, gen, offset, rng, out) {
  const n = (1 << gen) + 1;
  out.set(a, 0); out.set(b, (n - 1) * 3);
  let amp = offset;
  for (let g = 0; g < gen; g++) {
    const step = (n - 1) >> g, half = step >> 1;
    for (let i = 0; i < n - 1; i += step) {
      const p0 = i * 3, p1 = (i + step) * 3, m = (i + half) * 3;
      const dx = out[p1] - out[p0], dy = out[p1 + 1] - out[p0 + 1], dz = out[p1 + 2] - out[p0 + 2];
      const rx = rng() * 2 - 1, ry = rng() * 2 - 1, rz = rng() * 2 - 1;
      const k = (rx * dx + ry * dy + rz * dz) / (dx * dx + dy * dy + dz * dz || 1);     // remove the part along the segment
      out[m] = (out[p0] + out[p1]) / 2 + (rx - dx * k) * amp;
      out[m + 1] = (out[p0 + 1] + out[p1 + 1]) / 2 + (ry - dy * k) * amp;
      out[m + 2] = (out[p0 + 2] + out[p1 + 2]) / 2 + (rz - dz * k) * amp;
    }
    amp *= 0.5;                                    // roughness: each level wiggles half as much
  }
  return out;
}
```

Use it:

```js
const trail = new Trail({ points: 48, interval: 1 / 60, life: 0.8, width: 0.25, widthCurve: (t) => (1 - t) ** 1.5, material: trailMaterial });
scene.add(trail.mesh);
// per frame: trail.update(orb.getWorldPosition(v), clock.getDelta(), camera.position);   // camera.position, a Vector3
// on respawn: trail.reset(newPos);    on removal: trail.dispose();
```

## 4. Ribbon geometry rules

- **Camera-facing:** side vector = `normalize(cross(tangent, toCamera))`, vertices at `p ± side * width / 2`. The ribbon plane then faces the camera.
- **Degenerate points** (two samples at the same place, a stationary object) give a zero cross product. Keep the previous valid side instead of normalising a zero vector, or the quad twists or turns to NaN. The sample computes sides from tail to head for that reason.
- **Tangent** from the neighbours (previous minus next), so joints are smooth.
- **`DoubleSide`.** A camera-facing ribbon's winding flips when the camera crosses its plane.
- **Fixed index buffer, `setDrawRange`.** Build the strip topology once for the maximum points and change only the draw range. `Uint32` indices once vertices pass 65535.
- **`frustumCulled = false`** or set a bounding sphere by hand. Computing it every frame costs.
- **Allocation:** write into preallocated typed arrays and mark `needsUpdate`. No `Vector3` per point.
- **Sharp corners** (fast turns) pinch a ribbon to a thin sliver or overlap. Smooth the path (average with the neighbours) or add more points at the corner. Long ribbons seen edge-on thin out, which is the expected result of camera-facing.
- **Shared origin:** if the trail starts at a mesh, start the ribbon inside the mesh so the join is hidden.

## 5. Width, colour and UV along the trail

Everything is a function of `t = age / life` (0 at the head, 1 at the tail), stored per vertex (`aT`).

| Property | Typical curve | Notes |
|---|---|---|
| Width | `(1 - t)^p`, `p` 1 to 2 | Tapering tail. Add a short fade-in at the head for energy trails |
| Alpha | `1 - t` or `smoothstep(1, 0.5, t)` | Pair with additive or premultiplied alpha (`particle-rendering-blending`) |
| Colour | Hot at the head to cool at the tail, HDR above 1 at the head | Bloom picks up the head only (`particle-rendering-blending` section 10) |
| Across profile | `1 - abs(2u - 1)^2` | Soft edges without a texture |

**UV along the length** uses travelled distance, not point index, so the texture density stays constant when the object speeds up or slows down. The sample stores `uv.x` across (0 to 1) and `uv.y` as world distance. Scale it in the shader (`uv.y / tileLength`). Set `wrapT = RepeatWrapping` on the texture.

| Scroll mode | `v` | Looks like |
|---|---|---|
| World-stuck | `vUv.y / tile` | The pattern stays in the world as the trail passes. Smoke streaks, skid marks |
| Head-relative | `(uHeadDist - vUv.y) / tile`, `uHeadDist = trail.headDist` | The pattern travels with the head. Energy ribbons |
| Flowing | Either, minus `uTime * uSpeed` | Energy pulsing along a beam. Use the clock, not the frame count |

```glsl
// fragment, not run here
float across = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 2.0);
vec4 tex = texture2D(uMap, vec2(vUv.x, vUv.y / uTile - uTime * uSpeed));
float a = across * (1.0 - vT) * tex.a;
gl_FragColor = vec4(mix(uHot, uCool, vT) * uIntensity * a, a);   // premultiplied, for premultipliedAlpha: true
```

## 6. Beams and lightning

- **Beam:** a ribbon of 2 points is a flat quad. Use 8 to 32 points when you jitter or curve it. Scroll the UV for travelling energy. Attach both ends to moving objects every frame, no history needed.
- **Lightning** is the `lightning(a, b, gen, offset, rng, out)` function in the sample: midpoint displacement, `2^gen + 1` points, each generation halves the offset (roughness). 5 to 7 generations suit most bolts.
- **Seed it.** The same `rng` seed gives the same bolt (`particle-system-architecture` section 6), so scrubbing and replays match.
- **Re-roll at 15 to 30 Hz**, with a new seed per roll, not every frame. Per-frame re-rolls read as noise. Hold a few frames and flash the intensity.
- **Branches:** run `lightning` again from a random point on the main bolt toward a random direction with a smaller offset and width. Cap branches per bolt.
- **Layers for the look:** a thin white HDR core plus a wide soft glow ribbon of the same points (two draws or one wide ribbon and a second narrow one). Bloom does the rest (`post-processing-stack`).
- **Hit light:** pulse a point light or the scene exposure at the strike (`lighting-ibl-shadows`, keep the light count small).
- Timing of a strike (anticipation, flash, afterglow): `vfx-timing-choreography`, style recipes in `vfx-magic-energy-stylized`.

## 7. Tubes

Use a tube when the beam must be lit, show a silhouette or intersect geometry.

| Option | Use when | Cost |
|---|---|---|
| `TubeGeometry(curve, tubularSegments, radius, radialSegments)` | Static cable, rope, a path that does not change | Rebuild is costly, never per frame |
| Dynamic tube: a ring of vertices around each history point using parallel-transport frames | Animated tube following an object | `radialSegments * 2` triangles per segment. 6 to 8 sides is enough |
| Ribbon with a lit-looking texture | Glowing energy that needs no real lighting | Cheapest, preferred for glow |

Radial segments 4 to 6 for distant or small tubes. Cap `tubularSegments * radialSegments` per tube per tier.

## 8. Budgets and many trails

Vertices per trail = `2 * (points + 1)`. Triangles = `2 * points`.

| Tier (starting guess) | Points per trail | Trails | Notes |
|---|---|---|---|
| Low | 16 to 24 | up to 20 | Interval 1/30, simpler shader |
| Mid | 32 to 48 | up to 100 | |
| High | 48 to 96 | several hundred | Fill rate of overlapping additive ribbons becomes the limit before vertex cost |

- **One draw call per trail** is fine to about 20 trails. Beyond that, merge them (not run here): one `BufferGeometry` with a fixed block of `(points + 1) * 2` vertices per trail, all trails updated in one loop, unused strips collapsed to a single point so they draw nothing. One mesh, one draw call.
- **Pool trails** with their owner. A trail that finished fading is `reset` and reused, not rebuilt (`particle-system-architecture` section 10).
- **GPU particles with trails:** keep the history in textures or a storage buffer, one row per particle, and shift or ring-write each interval (`gpu-particles-compute`). Not covered by the sample. For many sparks prefer stretched billboards.
- **Cost reduction:** fewer points on short or distant trails, longer `interval` on low tier, cull trails whose head is off screen and whose tail has faded.
- Overdraw matters more than vertex count. A wide additive ribbon near the camera can cover the screen (`particle-rendering-blending` section 7).

## 9. Dropped-frame stability

| Problem | Cause | Fix |
|---|---|---|
| Trail shorter at 144 Hz and longer at 30 Hz | Pushing one point per frame | Sample by time (sample) |
| Trail stretches into a long line after a stall | Large `dt` | Clamp `dt` (0.1 s in the sample), or `reset` after a very long gap |
| Straight streak after respawn or teleport | No break | `reset(p)` at the teleport |
| Trail jitters when the object moves at fixed step but renders at variable rate | Head and history in different time bases | Interpolate the object position to render time before `update` (`motion-choreography`) |
| Trail keeps growing in a hidden tab | `requestAnimationFrame` paused, then a huge `dt` | Clamp, and `reset` on `visibilitychange` |
| Scroll speed changes with frame rate | `uTime` advanced per frame | Use `clock.elapsedTime` |
| Slow motion or pause | Wall-clock `dt` fed to the trail | Feed the trail the same scaled `dt` as the simulation, so it records simulation time |

Frame-rate independence rule: every quantity (interval, life, scroll speed) is in seconds of simulation time, and the number of samples per frame comes from time, never from frame count. Easing for the width and alpha curves follows `motion-choreography`.

## 10. Verify

1. Run at 30, 60 and 144 fps (throttle the loop). Trail length in the world must match.
2. Throw a 2 s stall in. No giant streak.
3. Teleport the emitter. No line between the two places.
4. Orbit around the trail and look edge-on. Check twisting, pinching and gaps at fast turns.
5. Stand still. No flicker, no NaN, no sliver at the head.
6. Check draw calls and triangle counts against `performance-budget`, screenshots through `render-qa`.
7. Lightning: same seed twice must be identical, different seeds different.

## 11. Do not do these

- Do not push one history point per frame.
- Do not allocate vectors or arrays per point per frame.
- Do not normalise a zero-length side vector.
- Do not re-roll lightning every frame.
- Do not rebuild `TubeGeometry` per frame.
- Do not use a mesh per trail for hundreds of trails.
- Do not store trail positions in local space of a moving parent.

Related: `particle-system-architecture`, `particle-forces-fields`, `particle-rendering-blending`, `gpu-particles-compute`, `vfx-fire-smoke-explosion`, `vfx-impact-sparks-decals`.
