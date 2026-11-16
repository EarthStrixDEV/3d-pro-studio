---
name: particle-forces-fields
description: Forces, fields and collisions for particle motion in Three.js. Covers gravity, exact exponential drag, wind with gusts, vortex swirl, divergence-free curl noise turbulence, attractors and repellers, force fields with falloff curves, collision against a plane, a depth buffer and a signed distance field, bounce restitution, Coulomb friction and rest thresholds, and stable integration (semi-implicit Euler, fixed step, acceleration clamps, substeps against tunnelling). Includes a tested CPU force and collision module. Use when particles need to feel physical, swirl, get pulled, blown, bounce or slide, when motion explodes or jitters at rest, or when drag behaves differently at different frame rates. Thai triggers แรงโน้มถ่วง, ลม, กระแสวน, แรงดึงดูด, อนุภาคชน, เด้ง, แรงเสียดทาน.
argument-hint: "<motion wanted, e.g. smoke swirl, sparks bouncing, leaves in wind, plus CPU or GPU>"
---

# Particle Forces & Fields

Particles are point masses: sum accelerations, integrate, resolve contacts. Buffers and update order come from `particle-system-architecture`, the GPU port from `gpu-particles-compute`. Rigid bodies with shape, joints and stacking belong to `physics-rigidbody`. Noise functions belong to `shader-craft`.

## 1. Pick the force

| Want | Force | Notes |
|---|---|---|
| Falling, arcs | Gravity, constant acceleration | Scale it down for smoke, dust and sparks (effects look better at 0.2 to 0.6 of 9.8) |
| Air resistance, settling | Drag, `v *= exp(-k dt)` | Section 3. Terminal velocity is `g / k` |
| Blown by air | Wind, pull velocity toward an air velocity | Proportional to the velocity difference, so particles reach wind speed and stop accelerating |
| Gusty, organic drift | Wind with a slow `sin` gust, or curl noise | Never raw random per frame, it reads as vibration |
| Swirl, tornado, drain | Vortex, tangential acceleration around an axis | Add a small inward pull to keep particles from spiralling out |
| Magnet, black hole, explosion push | Point attractor or repeller, signed strength | Needs softening and a clamp (section 5) |
| Smoke and magic that curl without clumping | Curl noise | Divergence free, so no sinks and sources (section 4) |
| Hit the floor, walls, props | Collision (section 6) | Plane is free, SDF is cheap, depth buffer is screen space only |

Forces add. Order of adding does not matter, order of integration and collision does (section 7).

## 2. Verified sample: fields and collisions on CPU

Node tested (three is not required) on structure-of-arrays buffers: free fall matches the analytic fall within `O(dt)`, drag at 30 Hz and 240 Hz agree to 1e-4, the vortex turns the right way, an attractor placed exactly on a particle stays finite, the curl field has numeric divergence under 1e-3, a ball with restitution 0.5 bounces to 0.466 then 0.115 m (ratio about 0.25) and rests with no jitter, friction slows a slider monotonically to a stop, a ball rolls off a sphere SDF without penetration.

```js
// Force fields and collisions over structure-of-arrays particle buffers.
// buf = { pos: Float32Array(3n), vel: Float32Array(3n), life: Float32Array(n) (<= 0 means free), cap: n, radius }
// No allocation per call: scratch values live in module scope.

const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0];

// Curl of a vector potential by central differences. The result is divergence free for any smooth psi,
// so particles swirl without piling up. Swap psiSines for 3D simplex noise (see shader-craft).
export function curl(psi, x, y, z, t, out, h = 1e-3) {
  psi(x + h, y, z, t, _a); psi(x - h, y, z, t, _b);
  const dzdx = _a[2] - _b[2], dydx = _a[1] - _b[1];
  psi(x, y + h, z, t, _a); psi(x, y - h, z, t, _b);
  const dzdy = _a[2] - _b[2], dxdy = _a[0] - _b[0];
  psi(x, y, z + h, t, _a); psi(x, y, z - h, t, _b);
  const dydz = _a[1] - _b[1], dxdz = _a[0] - _b[0];
  const s = 1 / (2 * h);
  out[0] = (dzdy - dydz) * s; out[1] = (dxdz - dzdx) * s; out[2] = (dydx - dxdy) * s;
}
export function psiSines(x, y, z, t, o) {
  o[0] = Math.sin(y + 1.3 * t) * Math.cos(1.1 * z);
  o[1] = Math.sin(z + 0.9 * t) * Math.cos(1.3 * x);
  o[2] = Math.sin(x + 1.1 * t) * Math.cos(0.9 * y);
}

// 0..1 weight by distance d and radius r. soft is the softening length for 'inv2'.
export function falloff(kind, d, r, soft = 0.1) {
  switch (kind) {
    case 'linear': return d >= r ? 0 : 1 - d / r;
    case 'smooth': { if (d >= r) return 0; const s = 1 - d / r; return s * s * (3 - 2 * s); }
    case 'inv2': return d >= r ? 0 : 1 / (d * d + soft * soft);
    default: return 1;
  }
}

// Resolve one contact: push out along n, bounce the normal velocity, apply Coulomb friction.
function contact(buf, i, nx, ny, nz, gap, e, mu, rest) {
  const { pos, vel } = buf, j = i * 3;
  if (gap >= 0) return;
  pos[j] -= nx * gap; pos[j + 1] -= ny * gap; pos[j + 2] -= nz * gap;
  let vn = vel[j] * nx + vel[j + 1] * ny + vel[j + 2] * nz;
  if (vn >= 0) return;
  const eff = -vn < rest ? 0 : e;                       // below the rest speed, no bounce (stops jitter)
  const jn = -(1 + eff) * vn;                           // normal impulse per unit mass
  vel[j] += nx * jn; vel[j + 1] += ny * jn; vel[j + 2] += nz * jn;
  vn = vel[j] * nx + vel[j + 1] * ny + vel[j + 2] * nz;
  const tx = vel[j] - vn * nx, ty = vel[j + 1] - vn * ny, tz = vel[j + 2] - vn * nz;
  const tl = Math.hypot(tx, ty, tz);
  if (tl > 1e-9) {
    const k = Math.max(0, tl - mu * jn) / tl;           // friction removes at most mu * jn, never reverses
    vel[j] += (k - 1) * tx; vel[j + 1] += (k - 1) * ty; vel[j + 2] += (k - 1) * tz;
  }
}

export function step(buf, fields, colliders, t, dt) {
  const { pos, vel, life, cap } = buf, r = buf.radius ?? 0.05;
  let dragK = 0;
  for (const f of fields) if (f.type === 'drag') dragK += f.k;
  const dragFactor = Math.exp(-dragK * dt);             // exact decay, same result at any dt
  const maxA = buf.maxAccel ?? 1e4;

  for (let i = 0; i < cap; i++) {
    if (life[i] <= 0) continue;
    const j = i * 3;
    const px = pos[j], py = pos[j + 1], pz = pos[j + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      switch (f.type) {
        case 'gravity': ax += f.g[0]; ay += f.g[1]; az += f.g[2]; break;
        case 'wind': {                                   // pull the velocity toward the air velocity
          const gust = 1 + (f.gust ?? 0) * Math.sin(t * (f.gustFreq ?? 1.7) + px * 0.5);
          ax += (f.dir[0] * f.speed * gust - vel[j]) * f.coupling;
          ay += (f.dir[1] * f.speed * gust - vel[j + 1]) * f.coupling;
          az += (f.dir[2] * f.speed * gust - vel[j + 2]) * f.coupling;
          break;
        }
        case 'vortex': {                                 // swirl around an axis through center
          const dx = px - f.center[0], dy = py - f.center[1], dz = pz - f.center[2];
          const al = dx * f.axis[0] + dy * f.axis[1] + dz * f.axis[2];
          const rx = dx - al * f.axis[0], ry = dy - al * f.axis[1], rz = dz - al * f.axis[2];
          const d = Math.hypot(rx, ry, rz), w = falloff(f.falloff, d, f.radius) * f.strength / Math.max(d, 1e-4);
          ax += (f.axis[1] * rz - f.axis[2] * ry) * w - rx * (f.pull ?? 0) * w;
          ay += (f.axis[2] * rx - f.axis[0] * rz) * w - ry * (f.pull ?? 0) * w;
          az += (f.axis[0] * ry - f.axis[1] * rx) * w - rz * (f.pull ?? 0) * w;
          break;
        }
        case 'point': {                                  // strength > 0 attracts, < 0 repels
          const dx = f.pos[0] - px, dy = f.pos[1] - py, dz = f.pos[2] - pz;
          const d = Math.hypot(dx, dy, dz), w = f.strength * falloff(f.falloff, d, f.radius, f.soft) / Math.max(d, f.soft ?? 0.1);
          ax += dx * w; ay += dy * w; az += dz * w;
          break;
        }
        case 'curl': {
          curl(f.psi ?? psiSines, px * f.scale, py * f.scale, pz * f.scale, t * f.speed, _c);
          ax += _c[0] * f.strength; ay += _c[1] * f.strength; az += _c[2] * f.strength;
          break;
        }
      }
    }
    const al = Math.hypot(ax, ay, az);
    if (al > maxA) { const s = maxA / al; ax *= s; ay *= s; az *= s; }   // clamp so a close attractor cannot explode
    vel[j] = (vel[j] + ax * dt) * dragFactor;            // semi-implicit Euler: velocity first
    vel[j + 1] = (vel[j + 1] + ay * dt) * dragFactor;
    vel[j + 2] = (vel[j + 2] + az * dt) * dragFactor;
    pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;

    for (const c of colliders) {
      const rest = c.rest ?? 0.5;
      if (c.type === 'plane') {                          // n dot p = d
        const gap = c.n[0] * pos[j] + c.n[1] * pos[j + 1] + c.n[2] * pos[j + 2] - c.d - r;
        contact(buf, i, c.n[0], c.n[1], c.n[2], gap, c.e, c.mu, rest);
      } else if (c.type === 'sdf') {                     // fn(x, y, z) returns signed distance
        const x = pos[j], y = pos[j + 1], z = pos[j + 2], h = 1e-3, d0 = c.fn(x, y, z) - r;
        if (d0 > 0.25) continue;                         // far away, skip the gradient
        let nx = c.fn(x + h, y, z) - c.fn(x - h, y, z), ny = c.fn(x, y + h, z) - c.fn(x, y - h, z), nz = c.fn(x, y, z + h) - c.fn(x, y, z - h);
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        contact(buf, i, nx, ny, nz, d0, c.e, c.mu, rest);
      }
    }
  }
}

export function makeBuf(n, radius = 0.05) {
  return { cap: n, radius, pos: new Float32Array(n * 3), vel: new Float32Array(n * 3), life: new Float32Array(n).fill(1e9) };
}
```

Use it with the buffers from `particle-system-architecture` (rename `life` to `lifeOf`, or pass `{ pos, vel, life: lifeOf, cap }`):

```js
const fields = [
  { type: 'gravity', g: [0, -2, 0] },
  { type: 'drag', k: 0.8 },
  { type: 'wind', dir: [1, 0, 0], speed: 2, coupling: 1.5, gust: 0.4 },
  { type: 'curl', scale: 0.7, speed: 0.3, strength: 1.2 },
  { type: 'point', pos: [0, 1, 0], strength: 6, radius: 3, falloff: 'inv2', soft: 0.3 },
];
const colliders = [{ type: 'plane', n: [0, 1, 0], d: 0, e: 0.4, mu: 0.4 }];
// fixed step loop: step(buf, fields, colliders, t, dt)
```

Fields are plain data, so they edit in a GUI and serialise to JSON (`vfx-graph-authoring`).

## 3. Drag, gravity and wind: the details

- **Exact drag:** `v *= exp(-k * dt)`. The usual `v *= 1 - k * dt` goes negative when `k * dt > 1` and decays at a different rate per frame time. The sample uses the exponential, so 30 Hz and 240 Hz match.
- **Wind as relative drag:** `a = (windVelocity - v) * coupling`. A constant wind force accelerates forever, this one saturates at wind speed. Heavier particles get a lower `coupling`.
- **Per-particle variation:** scale coupling, drag and gravity by the particle's seeded random (`particle-system-architecture` section 6) so a cloud does not move as one body. 10 to 30 percent spread is enough.
- **Buoyancy:** negative gravity scaled by temperature, for fire and smoke. Cool with age by deriving it from `t = age / life`.
- **Quadratic drag** (`a = -k |v| v`) suits fast projectiles. It is not in the sample, and its decay is not exact, so substep it.

## 4. Vortex and curl noise

| Field | Formula | Watch |
|---|---|---|
| Vortex | `a = (axis x r_perp) / |r_perp| * strength * falloff(d)` | `r_perp` is the offset with the axis part removed. Guard `d` near zero |
| Inward pull | Add `-r_perp * pull * w` to the vortex | Without it, the swirl flings particles outward |
| Curl noise | `a = curl(psi(p * scale, t * speed)) * strength` | `psi` is a vector potential, any smooth 3 vector field |

Curl of any smooth potential is divergence free, so a particle cloud never compresses into a point. The sample takes the curl by central differences (6 evaluations of the potential per particle). Its `psiSines` is a cheap stand-in. Replace it with 3D simplex or Perlin noise for a natural look (noise code in `shader-craft`, three components sampled at offset positions). Check numeric divergence in a test, as the sample does.

- Animate by moving through noise space (`t * speed`), not by resampling.
- Add a low-frequency curl for the large motion and a small high-frequency curl for the detail, two evaluations.
- Curl noise is the cost driver. Six potential evaluations per particle per step. On GPU it is cheap, on CPU cap it at a few thousand particles or use an analytic derivative.
- To make a field pass around an obstacle, damp `psi` near the SDF surface so the flow becomes tangential (advanced, not in the sample).

## 5. Attractors, repellers and field falloff

| Falloff | Weight | Use |
|---|---|---|
| `none` | 1 | Global fields (gravity, wind) |
| `linear` | `1 - d/r` | Fast to read, visible edge in the volume |
| `smooth` | smoothstep of `1 - d/r` | Zero slope at the edge, no visible boundary. Default for local volumes |
| `inv2` | `1 / (d² + soft²)` | Physically shaped attractors. Needs `soft` and a radius cutoff |

- **Softening is required** with inverse-square forces. Near zero distance the acceleration goes to infinity. `soft` of 0.1 to 0.3 times the particle spacing keeps it bounded, the sample also normalises the direction with `max(d, soft)`.
- **Clamp the acceleration** (`maxAccel`). One step with a huge acceleration is the usual cause of "particles shoot off to infinity".
- **Cut off at a radius** so far particles cost no force and the volume has a visible limit.
- Negative strength is a repeller. An explosion is a short-lived repeller plus a burst (`vfx-fire-smoke-explosion`).
- Fields can be shaped: box, sphere or cylinder falloff by testing the distance in the shape's local space. Animate the field (strength over time) instead of the particles.

## 6. Collision

| Method | Cost | Works with | Limits |
|---|---|---|---|
| Plane (half space) | Trivial | CPU, GPU | Infinite flat surface only |
| Analytic shapes (sphere, box, capsule SDF) | Cheap | CPU, GPU | A handful of shapes |
| SDF function or 3D texture | Moderate | CPU, GPU | Baked SDF is static, gradient by central differences (6 samples) or a stored gradient |
| Depth buffer (screen space) | One texture fetch | GPU | Sees only what the camera sees. Table below |
| Scene raycast | Expensive | CPU, tens of particles | Use for hero debris only (`physics-rigidbody` for real bodies) |

**Contact resolution** (the `contact` function in the sample):
1. Gap = signed distance minus particle radius. If gap is not negative, no contact.
2. Push the particle out along the normal by `-gap`. This fixes any depth, so a half space cannot be tunnelled.
3. If moving into the surface (`v . n < 0`): bounce `v_n = -e * v_n`, with restitution `e` (0 dead, 0.3 to 0.6 sparks, 0.8 rubber).
4. Below a rest speed (`rest`, about 0.5 m/s at 60 Hz with gravity 9.8, scale with `g * dt`) set `e` to 0. Without it a resting particle bounces forever at tiny amplitude.
5. Friction: remove at most `mu * impulse` from the tangential speed and never reverse its direction. Coulomb friction scales with the impulse, so it only acts during contact.

**Depth-buffer collision (GPU, not run here):** render the opaque scene depth once per frame into a depth texture (not including particles). In the compute shader project the particle to clip space, sample the depth, and compare view-space depths. If the particle is behind the surface by less than a thickness, it collides, with the normal from a normal buffer or the depth derivatives.

| Problem | Cause | Mitigation |
|---|---|---|
| Particles fall through at screen edges | No depth data off screen | Fade to plane collision, or accept it |
| Particles behind a wall collide with its front face | Depth only stores the nearest surface | Thickness limit, accept artefacts |
| Flicker when the camera moves | Depth changes per frame | Use a stable depth pass, damp the normal |
| Wrong normals on thin geometry | Reconstructed from neighbours | Use a normal buffer |

Prefer plane or SDF collision when the level is simple, and the depth buffer for cheap debris against arbitrary static scenery.

## 7. Stable integration

1. **Semi-implicit (symplectic) Euler:** update velocity first, then position with the new velocity. Explicit Euler (position with the old velocity) gains energy on orbits and springs.
2. **Fixed step** (1/60 or 1/120) from an accumulator, clamp frame time at 0.1 s. Fixed steps give frame-rate independent results (`motion-choreography`).
3. **Order:** accelerations, velocity, drag, position, collision. Collide last so the stored position is always valid.
4. **Tunnelling:** a particle moving more than its radius per step can skip a thin collider. Substep by `ceil(vmax * dt / radius)` or clamp speed. Half spaces and thick SDFs are immune because they push by depth.
5. **Clamp** acceleration and speed. Cheap insurance against NaN spreading through a buffer.
6. **Stiffness:** a spring or strong attractor needs `k * dt² < 1` or it oscillates and explodes. Add damping or substep.
7. **NaN guard:** one NaN position stays NaN and may poison a whole buffer on GPU. In development, check `Number.isFinite` on a sample after a reset.
8. On GPU, ping-pong passes read the previous step. Recompute the new velocity in the position shader to stay semi-implicit (`gpu-particles-compute` section 3).

## 8. Verify

1. Free fall test and drag test at two frame rates (as in the sample test list). Results must match.
2. Drop particles on the floor, wait 10 s: they must rest at exactly the contact height with zero velocity.
3. Place an attractor on a particle. Nothing may become NaN.
4. Run at 15 fps (throttle). Nothing may tunnel or explode.
5. Look at the effect in motion (`render-qa` frames at several times): swirl and noise must not look periodic or mechanical.
6. Compare CPU and GPU versions of the same field on a few particles.

## 9. Do not do these

- Do not use `Math.random` per frame for turbulence. Use a smooth field.
- Do not write drag as `v *= 0.98` without noting the frame rate it was tuned for.
- Do not use a strong inverse-square force without softening, clamp and cutoff.
- Do not raycast the scene per particle per frame.
- Do not build joints, stacking or rotation in a particle system. Use `physics-rigidbody`.
- Do not trust a bounce setting without testing rest behaviour.

Related: `particle-system-architecture`, `gpu-particles-compute`, `vfx-fire-smoke-explosion`, `vfx-weather-environment`, `vfx-impact-sparks-decals`, `grid-fluid-smoke`.
