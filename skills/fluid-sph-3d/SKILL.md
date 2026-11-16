---
name: fluid-sph-3d
description: 3D particle fluids for Three.js, translating Houdini FLIP and Blender Mantaflow particle liquids into what a browser can run. Covers SPH versus PBF (position based fluids) versus FLIP hybrids, kernels and units, spatial hash neighbour grids, a verified CPU PBF step with ghost-particle walls, WebGL2 texture and WebGPU compute GPU plans, stability (time step, viscosity, boundary, tension), particle counts per device tier, and surface rendering (screen-space fluid, metaballs, marching cubes) with a cost table. Use when liquid must pour, splash or slosh in 3D, when asked for SPH, PBF, FLIP, a water tank, a liquid in a glass or a splashing logo, or when particles clump, explode, pile on the floor or run too slow. Thai triggers ของเหลว 3 มิติ, น้ำกระฉอก, เทน้ำ, น้ำกระเด็น, อนุภาคน้ำ, จำลองน้ำ, SPH.
argument-hint: "<what the liquid does, tank size, target device tier>"
---

# 3D Particle Fluids (SPH, PBF, FLIP)

Goes deeper than section 10 of `cloth-fluid-simulation` (2D SPH basics) and its honesty list in section 11. A live 3D liquid is a small tank, not an ocean. Say so early, then pick the cheapest method that reads as water. Budgets live in `performance-budget`.

## 1. Decide first

| Need | Use | Why |
|---|---|---|
| Calm surface, ripples, rain | Heightfield (`cloth-fluid-simulation` section 9, `ocean-terrain-environment`) | Cheap, stable, no particles |
| Pour, slosh or splash in a bounded tank, user interacts | **This skill: PBF**, then section 8 for the surface | Real 3D particles at a few thousand |
| Smoke or fire | `grid-fluid-smoke` | Grid solver, not particles |
| Hero splash, scripted, same every visit | Bake offline, play back (`sim-cache-baking-vat`) | Full quality, zero solver cost |
| Droplets, spray, foam on top of another surface | Sprite particles (`particle-system-architecture`, `gpu-particles-compute`) | No pressure solve needed |
| Sand, snow, mud | `granular-sand-snow-sim` | Different contact model |

## 2. Pick the method

| Method | Incompressibility from | Time step | Cost per step | Web verdict |
|---|---|---|---|---|
| WCSPH (equation of state `p = k((rho/rho0)^7 - 1)`) | Stiff pressure | Tiny, limited by sound speed (CFL) | One pass over neighbours, cheap | Only with many substeps, which erases the saving. Skip |
| **PBF** (Macklin and Mueller 2013) | Density constraint solved by iteration | 1/60 works with 2 to 8 iterations (measured below) | Two neighbour passes per iteration | **Default.** Stable, simple, parallel (Jacobi) |
| PIC or FLIP hybrid | Pressure solve on a grid, particles carry velocity | 1/60 | Particle to grid and back, plus a 3D pressure solve (`grid-fluid-smoke`) | Best volume and splash quality. Needs GPU scatter with atomics (WebGPU only, verify). Not realistic on phones |
| DFSPH, IISPH | Implicit pressure solve | Large | Heavier per step | Offline grade, no web advantage over PBF |

PBF trades physical accuracy for stability: viscosity and surface tension are artefacts of the solver, not set from material values. Match the look by eye against a reference clip.

## 3. Units and kernels

Metres, kilograms, seconds (`physics-rigidbody` section 2). `spacing` is the rest distance between particles, `h = 2 * spacing` is the smoothing radius, `rho0 = 1000` for water.

| Item | Formula |
|---|---|
| Mass | Calibrate: `m = rho0 / sum(W)` over a rest lattice, so rest density reads exactly `rho0`. `rho0 * spacing^3` is only close |
| Density | `rho_i = m * sum_j W_poly6(r, h)`, `W = 315 / (64 pi h^9) * (h^2 - r^2)^3` |
| Pressure gradient | Spiky kernel gradient `-45 / (pi h^6) * (h - r)^2 * r_hat` |
| Constraint | `C_i = rho_i / rho0 - 1`, `lambda_i = -C_i / (sum_k |grad_k C_i|^2 + eps)` |
| Correction | `dp_i = (m / rho0) * sum_j (lambda_i + lambda_j + s_corr) * gradW(p_i - p_j)` |
| Velocity | `v = (x_new - x_old) / dt`, optional XSPH smoothing for viscosity (verify constant against your scene) |

## 4. Neighbour search

Cell size `h`, so every neighbour sits in the 27 cells around a particle. Build every step, the grid is not persistent.

| Platform | Build | Notes |
|---|---|---|
| CPU | Counting sort: count per cell, prefix sum, scatter (in the sample) | Verified, see section 5 |
| WebGPU compute | Atomic counts per cell, prefix scan, scatter, or sort by cell key | Needs `atomicAdd` on `array<atomic<u32>>` and a scan kernel (verify) |
| WebGL2 | No scatter or atomics. Build the grid on the CPU and upload, or sort with a bitonic network in fragment passes | Costly. If you are here, prefer the WebGPU path or bake |

Rebuild from the predicted positions once per step. The sample does not rebuild inside the iteration loop, which is fine while a particle moves less than `h` per step.

## 5. CPU sample (verified)

Pure JS, no three.js needed. Run in Node 22 (section 10): the grid matched a brute-force search on 3000 random points (88240 neighbour pairs, 0 mismatches, corners included), a 1000 particle dam break stayed finite and settled to a 0.52 m deep pool (a 1 m^3 block in a 2 x 1 m tank is 0.5 m deep), and two runs gave identical arrays. Written for clarity: the closure per neighbour visit is slow, flatten the loops before shipping.

```js
/** Uniform hash grid by counting sort. cell = h, so every neighbour of a point is in its 27 cells. */
export function createGrid(maxN, h, size, origin = [0, 0, 0]) {
  const dims = size.map((s) => Math.ceil(s / h)), [nx, ny, nz] = dims;
  const cellStart = new Int32Array(nx * ny * nz + 1), cellOf = new Int32Array(maxN), sorted = new Int32Array(maxN);
  const cx = (v, k) => Math.min(dims[k] - 1, Math.max(0, Math.floor((v - origin[k]) / h)));
  return {
    build(pos, n) {
      cellStart.fill(0);
      for (let i = 0; i < n; i++) {
        const c = (cx(pos[i * 3 + 2], 2) * ny + cx(pos[i * 3 + 1], 1)) * nx + cx(pos[i * 3], 0);
        cellOf[i] = c; cellStart[c + 1]++;
      }
      for (let c = 0; c < cellStart.length - 1; c++) cellStart[c + 1] += cellStart[c];
      const fill = cellStart.slice(0, -1);                          // running write offsets
      for (let i = 0; i < n; i++) sorted[fill[cellOf[i]]++] = i;
    },
    /** Calls fn(j) for every j in the 27 cells around (x, y, z), including the point itself. Caller tests distance. */
    forEach(x, y, z, fn) {
      const px = cx(x, 0), py = cx(y, 1), pz = cx(z, 2);
      for (let k = Math.max(0, pz - 1); k <= Math.min(nz - 1, pz + 1); k++)
        for (let j = Math.max(0, py - 1); j <= Math.min(ny - 1, py + 1); j++)
          for (let i = Math.max(0, px - 1); i <= Math.min(nx - 1, px + 1); i++) {
            const c = (k * ny + j) * nx + i;
            for (let s = cellStart[c]; s < cellStart[c + 1]; s++) fn(sorted[s]);
          }
    },
  };
}

/** Position based fluids (Macklin and Mueller 2013), CPU, SI units. Ghost particles form the floor and walls. */
export function createPBF({ n, spacing = 0.1, box = [2, 1.5, 1], rho0 = 1000, iterations = 4, hScale = 2.0, relax = 1e-2, tension = 1e-4 }) {
  const h = spacing * hScale, h2 = h * h;
  const poly6 = 315 / (64 * Math.PI * h ** 9), spiky = -45 / (Math.PI * h ** 6);
  const W = (r2) => (r2 < h2 ? poly6 * (h2 - r2) ** 3 : 0);
  const Wdq = W((0.1 * h) ** 2);                                    // tensile correction reference, exponent 4
  let rest = 0;                                                     // calibrate mass: a rest lattice reads exactly rho0
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) for (let k = -3; k <= 3; k++) rest += W((i * i + j * j + k * k) * spacing ** 2);
  const mass = rho0 / rest, mr = mass / rho0;

  const ghost = [];                                                 // two lattice layers outside floor and walls, top open
  for (let k = -2; k < Math.ceil(box[2] / spacing) + 2; k++) for (let j = -2; j < Math.ceil(box[1] / spacing); j++)
    for (let i = -2; i < Math.ceil(box[0] / spacing) + 2; i++) {
      const p = [(i + 0.5) * spacing, (j + 0.5) * spacing, (k + 0.5) * spacing];
      if (!p.every((v, a) => v > 0 && v < box[a])) ghost.push(...p);
    }
  const total = n + ghost.length / 3;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), pred = new Float32Array(total * 3);
  pred.set(ghost, n * 3);
  const lambda = new Float32Array(total), dp = new Float32Array(n * 3);
  const grid = createGrid(total, h, box.map((b) => b + 2 * h), [-h, -h, -h]);

  function step(dt, gravity = -9.81) {
    for (let i = 0; i < n * 3; i += 3) {
      vel[i + 1] += gravity * dt;
      for (let k = 0; k < 3; k++) pred[i + k] = pos[i + k] + vel[i + k] * dt;
    }
    grid.build(pred, total);
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) {                                 // pass 1: density constraint, lambda
        const xi = pred[i * 3], yi = pred[i * 3 + 1], zi = pred[i * 3 + 2];
        let rho = 0, gx = 0, gy = 0, gz = 0, sumG2 = 0;
        grid.forEach(xi, yi, zi, (j) => {
          const dx = xi - pred[j * 3], dy = yi - pred[j * 3 + 1], dz = zi - pred[j * 3 + 2], r2 = dx * dx + dy * dy + dz * dz;
          rho += mass * W(r2);
          if (j === i || r2 >= h2 || r2 < 1e-12) return;
          const r = Math.sqrt(r2), g = (mr * spiky * (h - r) ** 2) / r;   // grad_i W = g * d, scaled by m / rho0
          gx += g * dx; gy += g * dy; gz += g * dz; sumG2 += (g * r) ** 2;
        });
        lambda[i] = -Math.max(rho / rho0 - 1, 0) / (sumG2 + gx * gx + gy * gy + gz * gz + relax);   // C clamped: no surface suction
      }
      for (let i = 0; i < n; i++) {                                 // pass 2: position correction
        const xi = pred[i * 3], yi = pred[i * 3 + 1], zi = pred[i * 3 + 2];
        let ax = 0, ay = 0, az = 0;
        grid.forEach(xi, yi, zi, (j) => {
          const dx = xi - pred[j * 3], dy = yi - pred[j * 3 + 1], dz = zi - pred[j * 3 + 2], r2 = dx * dx + dy * dy + dz * dz;
          if (j === i || r2 >= h2 || r2 < 1e-12) return;
          const r = Math.sqrt(r2), s = lambda[i] + lambda[j] - tension * (W(r2) / Wdq) ** 4;   // ghosts have lambda 0
          const g = s * mr * spiky * (h - r) ** 2 / r;
          ax += g * dx; ay += g * dy; az += g * dz;
        });
        dp[i * 3] = ax; dp[i * 3 + 1] = ay; dp[i * 3 + 2] = az;
      }
      for (let i = 0; i < n * 3; i++) pred[i] = Math.min(box[i % 3] - 1e-3, Math.max(1e-3, pred[i] + dp[i]));   // safety walls
    }
    for (let i = 0; i < n * 3; i++) { vel[i] = (pred[i] - pos[i]) / dt; pos[i] = pred[i]; }
  }

  /** rho / rho0 per fluid particle, for tuning and tests. */
  function densityRatios(out = new Float32Array(n)) {
    pred.set(pos); grid.build(pred, total);
    for (let i = 0; i < n; i++) {
      let rho = 0;
      grid.forEach(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], (j) => {
        const dx = pos[i * 3] - pred[j * 3], dy = pos[i * 3 + 1] - pred[j * 3 + 1], dz = pos[i * 3 + 2] - pred[j * 3 + 2];
        rho += mass * W(dx * dx + dy * dy + dz * dz);
      });
      out[i] = rho / rho0;
    }
    return out;
  }
  return { pos, vel, step, densityRatios, h, mass, ghostCount: total - n };
}
```

Usage: `const f = createPBF({ n, spacing: 0.1, box: [2, 1.5, 1] })`, fill `f.pos` with a lattice at `spacing`, call `f.step(1 / 60)` from the fixed loop of `physics-rigidbody` section 3, upload `f.pos` to an `InstancedMesh` or `Points`. The box is fixed at creation, ghosts are built once.

## 6. Boundaries

| Method | Result (measured, 1000 particles, 240 steps) | Use |
|---|---|---|
| Clamp positions to the box only | 38% of particles ended in the lowest 5 cm, mean height 0.13 m. The solver cannot push back, particles stack at the wall | Never |
| **Ghost particles**: 2 lattice layers outside floor and walls, density only, `lambda = 0` | Mean height 0.23 m (expected 0.25), density 0.63 to 1.06, no pile-up. Costs extra particles: 2712 ghosts for a 2 x 1.5 x 1 m box | Default for boxes and small tanks |
| Signed distance field of the container, push out along the gradient | Not run here (verify). Cheap for big containers or curved glass, needs a density correction near the wall | Large or curved containers |
| Moving collider (hand, ball, paddle) | Not run here (verify). Add it as moving ghosts or as an SDF with velocity | Interaction |

Keep the clamp as a safety net after the solver, never as the boundary.

## 7. Stability and tuning

| Symptom | Cause | Fix |
|---|---|---|
| Explodes in the first steps | Tension term `s_corr` in the wrong units. The paper's `k = 0.1` assumes its own scale. In SI units lambda is about 1e-3, so `k = 0.1` dominated: density reached 6x within 4 steps (measured with the clamp-only boundary) | `tension` about `1e-4` (in lambda units), raise to `1e-3` for more cohesion, `0` to disable |
| Particles clump at the free surface | Negative `C` pulls particles together (tensile instability) | Clamp `C >= 0` (in the sample), plus the tension term |
| Compresses like gas | Too few iterations | 4 is the sample default. 2 and 8 also held (mean height 0.22 and 0.24, max density 1.13 and 1.02). Raise for tall stacks |
| Jitters or foams at rest | Variable `dt`, `relax` too small | Fixed 1/60, `relax` 1e-2 or larger |
| Particles shoot out of a wall | Fast particle crosses the ghost layers | Cap speed to `h / dt`, add a substep |
| Looks like oil or jelly | Over-damped, too much XSPH | Lower viscosity, check the frame rate is not collapsing the step |
| Mass looks wrong or density off | Mass not calibrated, `h` not 2 to 2.5 spacings | Calibrate mass (section 3), keep `hScale` between 2 and 2.5 |

Costs rise with the neighbour count (about 33 within `h` at `hScale` 2).

## 8. Rendering the surface

Particles as spheres read as beads. A liquid needs a surface. Costs are guesses relative to one full-screen post pass, measure with `render-qa`.

| Method | Cost | Look | Limits |
|---|---|---|---|
| Instanced spheres or point sprites | Low | Beads, spray | No surface |
| **Screen-space fluid** | 4 to 6 half-res passes | Smooth surface, thickness tint, refraction | Camera-space only, hides thin sheets, no back faces |
| `MarchingCubes` addon (`three/addons/objects/MarchingCubes.js`) | CPU, grows with resolution cubed | Blobs | Small blob counts, not a pool (verify the resolution you need) |
| GPU density grid then marching cubes or SDF raymarch | High, needs particle to grid splat (atomics, verify) | True mesh | WebGPU only in practice |
| Baked mesh sequence or VAT | Low | Art-directed | Not interactive (`sim-cache-baking-vat`) |

Screen-space fluid pipeline:
1. Draw particles as sprites that write sphere depth (a `ShaderMaterial` with point size and depth output, `shader-craft`). Half resolution.
2. Blur the depth. Use a bilateral or narrow-range filter so edges survive, radius in world units not pixels, 2 to 4 iterations. Curvature flow smoothing is the alternative (verify).
3. Rebuild view-space normals from the blurred depth.
4. Draw thickness additively into a second half-res target, convert with Beer-Lambert (`exp(-k * thickness)`) for tint and refraction offset.
5. Composite: Fresnel reflection of the environment (`lighting-ibl-shadows`), refraction of the scene behind from a scene copy, depth-aware edge against geometry (`volumetrics-atmosphere` section 7 rules). Foam and splashes from velocity are a `vfx-impact-sparks-decals` and `particle-rendering-blending` job.

Tune the blur until sheets stay connected but droplets stay round. Too strong and the liquid melts into a slab.

## 9. GPU plan, counts and tiers

**Not verified in this skill.** Build a 2k particle version, compare mean height and density range with the CPU sample, then scale.

| Path | How |
|---|---|
| WebGPU compute (`three/webgpu`, `three/tsl`) | Storage buffers via `instancedArray`, kernels with `Fn(...)().compute(count)`, `await renderer.computeAsync(node)`, two buffers per quantity for Jacobi (names move between releases, verify the revision). Passes per step: predict, build grid, then per iteration lambda and correction, then velocity |
| WebGL2 (`GPUComputationRenderer`) | Positions in float textures, grid from CPU. Possible for about 4k, awkward. Check `EXT_color_buffer_float` (verify) |

Particle counts (CPU rows measured, Node 22, 4 iterations, includes 1352 ghosts, desktop CPU; everything else is a guess):

| Tier | Method | Particles |
|---|---|---|
| Measured CPU, this sample | main thread | 125 in 5 ms, 216 in 10 ms, 512 in 24 ms, 1000 in 40 to 50 ms per step |
| Low (phones, iGPU) | Bake, or flattened CPU in a worker | 500 to 1.5k, or none |
| Mid (laptops) | WebGPU compute, or CPU worker | 5k to 20k |
| High (desktop dGPU) | WebGPU compute | 20k to 100k |

Detect WebGPU, fall back to the baked clip, never to a stuttering sim. Cut cost in this order: bake, fewer particles, fewer iterations (2 held), half-res surface, sleep when the tank is calm.

## 10. Verify

1. Numeric: finite output, density min and max (`densityRatios()`), mean height against volume divided by floor area, two runs identical, grid against brute force.
2. `render-qa` at three simulated times (`physics-rigidbody` section 12) from a front and a grazing angle. Reject pile-up at walls, floating droplets that never rejoin, flickering surface.
3. Report step time and particle count next to the tier row.

Not verified, check before relying on them: every GPU path, the SDF and moving-collider boundaries, XSPH constant, curvature flow smoothing, `MarchingCubes` resolution limits, FLIP and DFSPH claims (stated from the literature, not run), all phone numbers.
