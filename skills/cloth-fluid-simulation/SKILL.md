---
name: cloth-fluid-simulation
description: Cloth, soft body and fluid simulation for Three.js, translating Maya nCloth and Bifrost and Blender Cloth and Fluid (Mantaflow) into what runs on the web. Covers bake versus runtime choice, Verlet or position-based cloth with structural, shear and bend constraints, pins, wind, primitive collision, self-collision limits, GPU cloth with ping-pong textures (GPUComputationRenderer) or WebGPU compute, soft bodies, heightfield water and ripples, 2D SPH basics, vertex animation textures for baked results, per-tier budgets and what is not realistic in a browser. Use when a flag, curtain, cape, banner, sail or tablecloth should move, when water needs ripples or splashes, when asked for nCloth, Bifrost, cloth modifier or fluid sim in the browser, or when a cloth stretches, jitters, tunnels through a collider or costs too much. Thai triggers ผ้า, ธง, ผ้าม่าน, ผ้าคลุม, จำลองผ้า, น้ำกระเพื่อม, คลื่นน้ำ, ของเหลว, soft body.
argument-hint: "<what moves (cloth, water, soft body), what it collides with, and the target device tier>"
---

# Cloth & Fluid Simulation

Maya nCloth, Bifrost and Blender Cloth and Fluid solve offline at hundreds of thousands of elements. The browser gets a few milliseconds a frame. Decide first what must be live, then spend the budget in `performance-budget` on that only.

## 1. Bake or simulate

| Situation | Approach | Why |
|---|---|---|
| Camera never interacts, motion is scripted (hero flag loop, cape in a cutscene) | **Bake** in Blender or Maya, ship as glTF animation, morph targets or a vertex animation texture (section 8) | Full DCC quality, zero solver cost. See `blender-to-three-export` and `gltf-asset-pipeline` |
| Cloth reacts to user, wind slider or moving collider | **CPU Verlet** (sections 2 to 5) | Simple, deterministic, 32x32 fits a mid tier |
| Dense cloth (64x64 and up) or several sheets | **GPU** (section 6) | Constraint solve is parallel per vertex |
| Pressure-held shape (balloon, cushion, jelly) | Soft body (section 7) | Volume or shape constraint, not just edges |
| Calm water surface with ripples, rain, footsteps | **Heightfield** (section 9) | Cheap, stable, looks right from above |
| Splashing, pouring, 2D liquid toy | **2D SPH** (section 10) | Real particle fluid, small counts only |
| 3D pouring, smoke plumes, large-scale FLIP | **Bake or fake** (section 11) | Not realistic live on the web |

Rule: if the result can be baked, bake it. Live solvers are for interaction.

## 2. Cloth model

A cloth is a grid of particles joined by distance constraints. Each frame: integrate (Verlet), solve constraints a few times, resolve collisions, upload positions.

| Constraint | Links | Stops | Typical stiffness (0 to 1, guess) |
|---|---|---|---|
| Structural | Grid neighbours | Stretching | 1.0 |
| Shear | Diagonals | Parallelogram collapse | 0.5 to 0.9 |
| Bend | Skip one neighbour (`c+2`, `r+2`) | Sharp folds, gives paper or canvas stiffness | 0.05 to 0.4 low is silk, high is cardboard |

Maya and Blender names map approximately (check the labels in your DCC version, they move between releases):

| DCC setting | In the sample below |
|---|---|
| Blender Cloth: Quality Steps. Maya nCloth: Nucleus substeps | `substeps` |
| Blender: Stiffness Tension, Shear, Bending. Maya: Stretch, Shear, Bend Resistance | `stiffness.structural`, `shear`, `bend` |
| Blender: Damping. Maya: Damp | `damping` (velocity kept per substep) |
| Blender: Shape Pin Group. Maya: Transform Constraint, Point to Surface | `pin(col, row)`, `movePin` |
| Blender: Collision Distance. Maya: Collision Thickness | `thickness` |
| Blender and Maya: Wind field | `wind`, `drag` |
| Blender: Mass. Maya: Mass | One particle mass of 1. Scale `gravity` and `drag` instead |

Rules:
- **Substeps beat iterations for stiffness.** More substeps with few iterations gives stiffer, calmer cloth than the reverse. Start 4 substeps, 4 iterations.
- **Fixed `dt` (1/60).** A variable step changes stiffness per frame rate. Use the loop in `physics-rigidbody` section 3, clamp the frame time the same way.
- **Metres.** Gravity -9.81 only makes sense if the sheet is metre scale (`physics-rigidbody` section 2).
- A hanging sheet pinned at two corners stretches under its own weight. Pin more points, raise iterations, or accept it (measured in section 12).
- Do not give structural stiffness below 1 to hide stretch. Use more iterations. Low structural stiffness is a stretchy rubber sheet.

## 3. CPU cloth sample (verified)

Pure JS, one `BufferGeometry`, no allocations per step. Run headless with three 0.187.0 on Node 22: pins never moved, finite output, deterministic over two runs, a flat sheet dropped on a sphere and ground stayed outside the sphere (numbers in section 12).

```js
import * as THREE from 'three';

/** Verlet cloth: structural, shear and bend constraints, pins, wind, sphere and ground collision. */
export function createCloth({
  cols = 32, rows = 32, width = 2, height = 2,
  origin = [0, 3, 0], axisU = [1, 0, 0], axisV = [0, -1, 0],     // hanging sheet; use [0,0,1] for a flat one
  pin = (c, r) => r === 0 && (c === 0 || c === cols - 1),
  stiffness = { structural: 1, shear: 0.8, bend: 0.25 },
} = {}) {
  const n = cols * rows;
  const pos = new Float32Array(n * 3), prev = new Float32Array(n * 3), acc = new Float32Array(n * 3);
  const invMass = new Float32Array(n).fill(1);
  const id = (c, r) => r * cols + c;

  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = id(c, r), u = (c / (cols - 1)) * width - width / 2, v = (r / (rows - 1)) * height;
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = prev[i * 3 + k] = origin[k] + axisU[k] * u + axisV[k] * v;
    if (pin(c, r)) invMass[i] = 0;
  }

  const ca = [], cb = [], rest = [], stiff = [], isStructural = [];
  const link = (c0, r0, c1, r1, s, structural = false) => {
    if (c1 >= cols || r1 >= rows) return;
    const a = id(c0, r0), b = id(c1, r1);
    ca.push(a); cb.push(b); stiff.push(s); isStructural.push(structural);
    rest.push(Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]));
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    link(c, r, c + 1, r, stiffness.structural, true); link(c, r, c, r + 1, stiffness.structural, true);
    link(c, r, c + 1, r + 1, stiffness.shear);
    if (c > 0) link(c, r, c - 1, r + 1, stiffness.shear);
    link(c, r, c + 2, r, stiffness.bend); link(c, r, c, r + 2, stiffness.bend);
  }
  const m = ca.length;
  const A = Int32Array.from(ca), B = Int32Array.from(cb), REST = Float32Array.from(rest), K = Float32Array.from(stiff);

  const index = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = id(c, r), b = id(c + 1, r), d = id(c, r + 1), e = id(c + 1, r + 1);
    index.push(a, d, b, b, d, e);
  }
  const tri = Uint32Array.from(index);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(tri, 1));
  geometry.computeBoundingSphere();

  function applyWind(h, wind, drag) {
    for (let t = 0; t < tri.length; t += 3) {
      const i0 = tri[t] * 3, i1 = tri[t + 1] * 3, i2 = tri[t + 2] * 3;
      const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
      const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz); if (len < 1e-12) continue;
      const area = len * 0.5; nx /= len; ny /= len; nz /= len;
      const vel = (k) => ((pos[i0 + k] - prev[i0 + k]) + (pos[i1 + k] - prev[i1 + k]) + (pos[i2 + k] - prev[i2 + k])) / (3 * h);
      const rx = wind[0] - vel(0), ry = wind[1] - vel(1), rz = wind[2] - vel(2);
      const f = drag * area * (nx * rx + ny * ry + nz * rz) / 3;      // push along the normal only, either face
      acc[i0] += nx * f; acc[i0 + 1] += ny * f; acc[i0 + 2] += nz * f;
      acc[i1] += nx * f; acc[i1 + 1] += ny * f; acc[i1 + 2] += nz * f;
      acc[i2] += nx * f; acc[i2 + 1] += ny * f; acc[i2 + 2] += nz * f;
    }
  }

  function collide(colliders, thickness, friction) {
    for (let i = 0; i < n; i++) {
      if (invMass[i] === 0) continue;
      const p = i * 3;
      for (const c of colliders) {
        let nx, ny, nz, depth;
        if (c.type === 'sphere') {
          const dx = pos[p] - c.center[0], dy = pos[p + 1] - c.center[1], dz = pos[p + 2] - c.center[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz), min = c.radius + thickness;
          if (d >= min || d < 1e-9) continue;
          nx = dx / d; ny = dy / d; nz = dz / d; depth = min - d;
        } else {                                                        // 'plane' at height c.y, normal +Y
          depth = c.y + thickness - pos[p + 1];
          if (depth <= 0) continue;
          nx = 0; ny = 1; nz = 0;
        }
        pos[p] += nx * depth; pos[p + 1] += ny * depth; pos[p + 2] += nz * depth;
        let vx = pos[p] - prev[p], vy = pos[p + 1] - prev[p + 1], vz = pos[p + 2] - prev[p + 2];
        const vn = vx * nx + vy * ny + vz * nz;                         // keep outward motion, drop inward, damp tangent
        const tx = (vx - nx * vn) * (1 - friction), ty = (vy - ny * vn) * (1 - friction), tz = (vz - nz * vn) * (1 - friction);
        const on = Math.max(vn, 0);
        prev[p] = pos[p] - (tx + nx * on); prev[p + 1] = pos[p + 1] - (ty + ny * on); prev[p + 2] = pos[p + 2] - (tz + nz * on);
      }
    }
  }

  /** Call with a fixed dt (1/60). Substeps keep stiffness independent of frame rate. */
  function step(dt, { gravity = -9.81, wind = [0, 0, 0], drag = 0.4, damping = 0.995,
                      substeps = 4, iterations = 4, colliders = [], thickness = 0.02, friction = 0.4 } = {}) {
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) {
      acc.fill(0);
      applyWind(h, wind, drag);
      for (let i = 0; i < n; i++) {
        if (invMass[i] === 0) continue;
        const p = i * 3;
        for (let k = 0; k < 3; k++) {
          const x = pos[p + k], a = acc[p + k] + (k === 1 ? gravity : 0);
          pos[p + k] = x + (x - prev[p + k]) * damping + a * h * h;
          prev[p + k] = x;
        }
      }
      for (let it = 0; it < iterations; it++) {
        for (let j = 0; j < m; j++) {
          const a = A[j] * 3, b = B[j] * 3;
          const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz), w = invMass[A[j]] + invMass[B[j]];
          if (d < 1e-9 || w === 0) continue;
          const k = K[j] * (d - REST[j]) / (d * w);
          pos[a] += dx * k * invMass[A[j]]; pos[a + 1] += dy * k * invMass[A[j]]; pos[a + 2] += dz * k * invMass[A[j]];
          pos[b] -= dx * k * invMass[B[j]]; pos[b + 1] -= dy * k * invMass[B[j]]; pos[b + 2] -= dz * k * invMass[B[j]];
        }
        collide(colliders, thickness, friction);                         // inside the loop so constraints cannot push it back in
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();                                    // cloth moves far from its rest bounds
  }

  /** Move a pinned particle (character hand, curtain rod). Writes prev too so no velocity spike. */
  function movePin(i, x, y, z) { pos.set([x, y, z], i * 3); prev.set([x, y, z], i * 3); }

  /** Largest structural length over rest length. 1.0 is no stretch. For tests and tuning. */
  function stretch() {
    let w = 0;
    for (let j = 0; j < m; j++) {
      if (!isStructural[j]) continue;
      const a = A[j] * 3, b = B[j] * 3;
      w = Math.max(w, Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]) / REST[j]);
    }
    return w;
  }

  return { geometry, pos, prev, invMass, step, movePin, stretch, id, cols, rows, constraintCount: m };
}
```

Usage:

```js
const cloth = createCloth({ cols: 32, rows: 32, width: 2, height: 2 });
const mesh = new THREE.Mesh(cloth.geometry, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9 }));
scene.add(mesh);
mesh.frustumCulled = false;                       // or keep the bounding sphere update in step()
// inside the fixed-step loop of physics-rigidbody section 3:
cloth.step(1 / 60, { wind: [Math.sin(t) * 2 + 2, 0, 1], colliders: [{ type: 'sphere', center: [0, 1, 0], radius: 0.5 }] });
```

Notes on the sample:
- Cloth needs `side: DoubleSide` and a UV set if textured. Add `uv` from `col / (cols - 1)` and `row / (rows - 1)` once, they never change.
- Pins use `invMass = 0`. To animate one, call `movePin`, never write `pos` alone (velocity spike).
- **Stiffness is applied per iteration**, so the same number feels different at 4 and 8 iterations. Retune after changing either.
- Dispose with `geometry.dispose()` like any mesh (`performance-budget` section 6).

## 4. Pins, wind, collision

**Pins.**
- Choose by function: `r === 0` for a curtain or flag on a pole, corners for a hammock or banner, a vertex group painted in the DCC (read it as a weight attribute) for a cape on shoulders.
- A pin moved by animation must go through `movePin` each fixed step. Pins that jump far in one step snap the cloth, so interpolate or substep the pin motion.

**Wind** (Blender Wind field, Maya Air and Wind).
- Force along the triangle normal, proportional to area and to the relative velocity, as in `applyWind`. That is why a sheet facing the wind billows and an edge-on sheet barely moves.
- Make the wind vary: `base + noise(position * 0.5 + t)` per triangle or a slow gust curve. A constant wind makes cloth lean and freeze.
- Wind needs the cloth's own velocity (relative wind). Without it the cloth never reaches terminal speed and flaps with unbounded energy.
- Add 3 to 8% low frequency turbulence. Higher frequencies look like jitter at 60 fps.

**Collision.**
- Use analytic primitives (sphere, capsule, plane, box). Approximate a character body with 6 to 12 capsules and spheres on the skeleton, driven from the bones. A triangle mesh collider on cloth costs more than the cloth.
- Moving colliders push particles by their displacement per step. A collider faster than `thickness` per substep tunnels. Raise `substeps` or `thickness` (0.02 to 0.05 at metre scale).
- Collider transforms come from your physics registry (`physics-rigidbody` section 2): read poses, treat them as kinematic. Cloth does not push rigid bodies back. If the cloth must carry a rigid body (a tablecloth with plates), that two-way coupling is not realistic here, bake or fake it.
- Keep collider offset by `thickness` so the visible cloth never sinks into the surface. If cloth looks flat on a sphere, raise `thickness` before raising iterations.

## 5. Self-collision limits

Cloth that folds over itself and passes through is the biggest realism tell, and the most expensive fix.

| Option | Cost | Use when |
|---|---|---|
| None, hide it | 0 | Pinned flags, curtains, banners that rarely fold over |
| Particle spacing (spatial hash, push particles apart when closer than `thickness`) | Hash build per substep plus neighbour checks | Hero cloth, up to about 32x32. Skip pairs within two grid steps of each other (they are neighbours, not collisions) |
| Layered offset (inner layer collides with outer as a collider) | Low | Skirt over a petticoat, hood over shoulders |
| Triangle to triangle continuous collision | High | Not realistic live in a browser. Bake in the DCC |

- Particle spacing only prevents particle pass-through. Triangles can still cross between particles when the grid is coarse, so spacing must be near the edge length.
- Run it every second substep, not every iteration (guess, tune).
- Do not enable on every cloth in a scene. One hero cloth with self-collision, the rest without.

## 6. GPU cloth

Move the solver to the GPU when the grid exceeds about 48x48 or several sheets share a frame. The solve must be **Jacobi**: every vertex reads the previous frame's neighbours and writes only itself, because a shader cannot update a neighbour in place.

| Path | API | Notes |
|---|---|---|
| WebGL2, ping-pong textures | `GPUComputationRenderer` from `three/addons/misc/GPUComputationRenderer.js`: `addVariable`, `setVariableDependencies`, `init`, `compute`, `getCurrentRenderTarget(variable).texture` (all present in r187) | Position and previous-position textures, one texel per particle. Float render targets required: check `renderer.extensions.has('EXT_color_buffer_float')` (verify) or use `setDataType(THREE.HalfFloatType)` and accept precision loss (verify) |
| WebGPU compute | `three/webgpu` and `three/tsl`: `instancedArray`, `Fn`, `instanceIndex`, `.compute(count)`, `await renderer.computeAsync(node)` (present in r187) | Storage buffers in place of textures. Use two buffers per quantity for Jacobi. TSL node names move between releases, check the exact revision (verify) |

Plan for the WebGL path:
1. Positions and previous positions in two ping-pong variables (`posTex`, `prevTex`). Integrate Verlet in the position shader, solve springs in a second pass reading the 12 neighbours (4 structural, 4 shear, 4 bend) by texel offset.
2. Run several constraint passes per frame. One pass per iteration, so 4 iterations by 4 substeps is 16 compute calls. Cost grows fast, budget it.
3. Draw with a `ShaderMaterial` or `onBeforeCompile` patch (`shader-craft` section 2) that samples `posTex` in the vertex shader by `uv`. Recompute the normal from neighbour texels in the shader. Check `renderer.capabilities.maxVertexTextures` (verify).
4. **Never read positions back to the CPU** each frame (`readRenderTargetPixels` stalls the pipeline). Do collision on the GPU against uniform primitives, in the same pass.
5. Pins: a mask texture (or a w channel) where 1 means free and 0 means pinned, and a uniform for the pin target.
6. Not verified end to end in this skill. Build a 16x16 version first and compare against the CPU sample's stretch numbers before scaling up.

GPU Jacobi converges slower than CPU Gauss-Seidel per iteration, so expect more stretch at equal iteration count (guess, measure).

## 7. Soft bodies

Maya soft body and Blender Soft Body are volumes that deform and recover. Rapier has no soft bodies (see engine table in `physics-rigidbody` section 1). Options:

| Method | How | Use for |
|---|---|---|
| Mass-spring tetra or lattice | Distance constraints between particles in a coarse lattice or tet mesh, skin the visible mesh to it | Jelly, blobs, 100 to 500 particles |
| Pressure cloth | Cloth plus a volume constraint: push each particle along its normal by `(targetVolume - volume) * k` | Balloons, inflatable cushions, sails |
| Shape matching | Each frame fit the best rigid transform of the particles to the rest shape, pull particles toward it | Stable, cheap, good for squishy props |
| Ammo soft bodies | Bullet's soft body API from `ammo.js` (verify) | You already ship Ammo, small counts |
| Fake with deformers | Squash and stretch via `deformers-blendshapes-morph` or a vertex shader driven by velocity | Cartoon bounce, no real volume needed |

- Soft bodies collide with the world by the same primitives as cloth. Keep particle counts under about 500 live on a mid tier (guess).
- Rig the visible mesh to the particle lattice with weights computed once at load (nearest particles, inverse distance). Do not skin with the particles per frame on the CPU for dense meshes. Use `deformers-blendshapes-morph` for the skinning side.

## 8. Baked simulation playback

When the sim is baked in Blender or Maya the web only plays it back.

| Format | Fits | Limit |
|---|---|---|
| glTF morph target animation | Few frames, few vertices | Each frame is one morph target. Cost grows linearly, practical for about 30 to 60 frames (guess) |
| glTF skinned animation with bones driving a cloth proxy | Capes, loose clothing | Not exact, but light |
| **Vertex animation texture (VAT)** | Cloth, fluid surfaces, destruction | One texture, row per frame, texel per vertex. Needs a bake script and a vertex shader that samples by `vertexId` and `time`. Float or half float texture, vertex count limited by texture width (verify the exact path for your exporter) |
| Alembic or point cache converted offline | Heavy sims | Convert in `gltf-asset-pipeline`, never load in the browser |

- Loop baked cloth by baking a periodic cycle (the DCC cache should end where it starts) or crossfade the last 10 frames.
- Compress the VAT as KTX2 only if lossless is not needed, quantised positions show as stepping (verify per scene).

## 9. Heightfield water and ripples

A grid of heights, one value per cell, solved by the discrete wave equation. It is stable, cheap, and reads as water from above. It cannot splash, overturn or break.

Verified with Node 22: stable for `c2 <= 0.5`, blows up to NaN at 0.6, so the limit is real. 256x256 costs 0.2 to 0.3 ms per step on a desktop CPU.

```js
/** 2D heightfield water: damped wave equation on a grid. c2 = (speed*dt/dx)^2 must stay <= 0.5. */
export function createRipples(n, { c2 = 0.4, damping = 0.995 } = {}) {
  let h = new Float32Array(n * n), p = new Float32Array(n * n);   // current and previous height
  return {
    get height() { return h; },
    drop(x, y, radius, strength) {                                // x, y in cells
      for (let j = Math.max(1, Math.floor(y - radius)); j <= Math.min(n - 2, Math.ceil(y + radius)); j++)
        for (let i = Math.max(1, Math.floor(x - radius)); i <= Math.min(n - 2, Math.ceil(x + radius)); i++) {
          const d = Math.hypot(i - x, j - y) / radius;
          if (d < 1) h[j * n + i] -= strength * 0.5 * (1 + Math.cos(Math.PI * d));
        }
    },
    step() {
      const next = p;                                             // reuse the oldest buffer
      for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
        const k = j * n + i;
        const lap = h[k - 1] + h[k + 1] + h[k - n] + h[k + n] - 4 * h[k];
        next[k] = (2 * h[k] - p[k] + c2 * lap) * damping;
      }
      p = h; h = next;                                            // edges stay 0: reflecting wall
    },
  };
}
```

How to display it:
- Upload `height` to a `DataTexture` (`RedFormat`, `FloatType`, `needsUpdate = true`) and use it as a normal source in the water shader: normal from central differences of neighbouring texels. Do not displace a mesh unless the grid is dense. See `ocean-terrain-environment` for the surface shader that consumes it.
- For 256x256 and up, move the step to a `GPUComputationRenderer` pass (same stencil in a fragment shader, two ping-pong textures). That is the usual GPU water-ripple pattern in the three.js examples (verify the example name for your revision).
- Input: `drop` at the raycast hit of the pointer, a footstep, a rain particle. Rain is many small drops with low strength, not one big one.
- `damping` 0.99 to 0.999 (guess). Below 0.98 the surface looks like oil.
- Boundary: edges stay at 0 and reflect. For open water, fade `damping` toward the edge (sponge layer) so waves fade rather than bounce.

## 10. 2D SPH basics

Smoothed particle hydrodynamics treats fluid as particles with density and pressure. Good for a 2D liquid toy, a cross-section tank, a splashing logo. 3D live SPH is only a small demo.

Per step, per particle:
1. **Grid**: bin particles into cells of size `h` (the smoothing radius). Neighbours come from the 9 surrounding cells, not from all particles.
2. **Density**: `rho_i = sum_j m * W(|r_i - r_j|, h)`. A standard 2D kernel for density is poly6 (verify the normalisation constant for 2D).
3. **Pressure**: `p_i = k * (rho_i - rho0)`, stiff `k` makes it near incompressible, but too stiff explodes without a smaller step.
4. **Forces**: pressure gradient (spiky kernel gradient), viscosity (Laplacian), gravity, boundary.
5. **Integrate** with a small fixed step (about 1/120 to 1/240, guess), then clamp speed.

Rules:
- Counts that fit (guess, measure in your scene): about 1 to 3k particles on a CPU main thread, 5 to 20k in a worker with a grid, tens of thousands on WebGPU compute.
- Keep `h` about 2 to 3 particle spacings. Smaller and particles lose neighbours and clump, larger and cost explodes.
- **Instability** (particles shoot out): reduce `dt`, reduce `k`, add viscosity, cap velocity.
- Render as instanced circles for a toy. For a liquid look use screen-space blur of particle depth and thickness, or metaballs in 2D with a threshold on a blurred canvas. Marching cubes (`MarchingCubes` addon, `three/addons/objects/MarchingCubes.js`) is for small 3D metaball blobs, not a full pool (verify field resolution you need).
- PBF or position-based fluids are the stable alternative to SPH pressure when you need larger steps (verify against your scene).

## 11. What is not realistic live on the web

| Feature | Why | What to do |
|---|---|---|
| 3D FLIP, Bifrost or Mantaflow liquid | Millions of particles, pressure solve on a 3D grid | Bake to VAT or sprite sheets, or a stylised 2D version |
| Smoke and fire simulation (Bifrost Aero, Blender Gas) | 3D grid advection | Pre-rendered flipbook or `volumetrics-atmosphere` fake volume |
| Cloth with full self-collision and thick layering | Triangle to triangle tests | Bake, or layer offset |
| Tearing cloth | Topology change, rebuild of constraints and index | Possible on small sheets by removing constraints and triangles (guess), not general |
| Two-way cloth and rigid coupling | Needs one solver for both | Bake, or one-way (rigid drives cloth) |
| Whole-ocean fluid surface simulation | See `ocean-terrain-environment` | Spectrum or Gerstner waves, not a fluid solve |

Say this limit to the client early. Offer the baked or stylised version rather than a stuttering live one.

## 12. Budgets, symptoms, verify

**Cost (measured, Node 22 on a desktop CPU, 4 substeps and 4 iterations, includes `computeVertexNormals`; phones are slower, assume roughly 3x as a guess).**

| Grid | Constraints | ms per step | Tier guidance |
|---|---|---|---|
| 32x32 | 5826 | 2 to 3.3 | Mid and high: one live sheet. Low: 16x16 to 24x24, 2 substeps, or bake |
| 64x64 | 23938 | 8 to 14.5 | High only, in a worker, or GPU. Not on the main thread |

Cut cost in this order: bake, lower the grid, fewer substeps, fewer iterations, solve only when visible and moving (`IntersectionObserver` or camera distance), sleep when velocity is under a threshold. Tie the sheet count to the tier table in `performance-budget`. Do not run the cloth when it is off screen.

**Stretch in the sample (measured over 600 steps with wind, max structural length over rest length):**

| Setup | Max stretch |
|---|---|
| Two corner pins, 4 iterations | 1.279 |
| Two corner pins, 8 iterations | 1.148 |
| Top row pinned, 4 iterations | 1.031 |

**Drop test:** a flat 2x2 sheet fell on a 0.5 radius sphere above a ground plane and stayed at 0.02 (the thickness) from the surface or more, with all values finite.

| Symptom | Cause | Fix |
|---|---|---|
| Cloth stretches like rubber | Few iterations, few pins, low structural stiffness | More iterations or substeps, more pins, structural 1.0 |
| Cloth jitters at rest | Variable `dt`, damping too high a velocity kept, collision flipping each substep | Fixed step, `damping` 0.98 to 0.995, raise `thickness`, add friction |
| Cloth falls through a collider | Collider faster than `thickness` per substep, thin collider | More substeps, bigger `thickness`, thicker colliders |
| Cloth explodes | NaN input, huge pin jump, overlapping start inside a collider | `Number.isFinite` guard, interpolate pins, spawn outside colliders |
| Cloth looks like a sheet of plastic | Bend stiffness too high, no wind noise | Lower `bend`, add gusts |
| Cloth stiff as paper but should be silk | Same as above, plus too few particles | Lower bend and shear, more particles |
| Lighting looks faceted | Normals not updated | `computeVertexNormals()` each step (done in sample) |
| Cloth disappears at some angles | Stale bounding sphere | `computeBoundingSphere()` after each step (done in sample), or `frustumCulled = false` |
| Water ripples blow up | `c2` above 0.5 | Keep `c2 <= 0.5` |
| SPH particles shoot out | Too stiff, step too large | Lower `k`, smaller `dt`, cap speed |

Verify:
1. Run the numeric checks from the sample: pins fixed, all values finite, max stretch under your target, collider clearance at least `thickness`, two runs with the same inputs produce identical arrays.
2. `render-qa` the scene at three simulated times, as in `physics-rigidbody` section 12 (a `?simt=` query that steps the sim before the ready flag), and compare cloth shape against the reference at a grazing angle.
3. Report the step time and particle count next to the `performance-budget` numbers. Must fit the tier.

Not verified here, check before relying on them: the GPU cloth path end to end (both WebGL and WebGPU), half float precision on phones, VAT bake tooling, 2D SPH kernel constants, three.js water example names, Ammo soft body API.
