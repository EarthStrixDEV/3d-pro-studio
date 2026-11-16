---
name: grid-fluid-smoke
description: Eulerian grid smoke and fire for Three.js (Jos Stam stable fluids), translating Blender Quick Smoke and Mantaflow Gas and Maya Fluid Effects into what runs on the web. Covers semi-Lagrangian advection, pressure projection, buoyancy and temperature, vorticity confinement, obstacles and boundaries, a verified 2D MAC grid solver, 2D GPU ping-pong and 3D volume texture plans, rendering the density volume (links the raymarch in volumetrics-atmosphere), and resolution versus cost per device tier. Use when smoke, steam, fire or ink should swirl and react to wind or obstacles instead of looping a flipbook, when asked for stable fluids, Navier-Stokes, a smoke simulation or a fluid grid, or when smoke looks mushy, dies out, ignores obstacles or costs too much. Thai triggers ควัน, ไฟ, จำลองควัน, ไอน้ำ, กลุ่มควัน, ควันหมุน, fluid grid.
argument-hint: "<smoke or fire, 2D or 3D, obstacles, target device tier>"
---

# Grid Fluid Smoke and Fire (Stable Fluids)

A grid solver stores velocity, density and temperature on a regular grid and moves them with the flow. It is the right tool for smoke that swirls and reacts. Its cost is cells, so resolution is the decision. Budgets in `performance-budget`.

## 1. Decide first

| Need | Use | Why |
|---|---|---|
| Looping chimney, torch, steam that never reacts | Flipbook or sprite particles (`vfx-flipbook-authoring`, `vfx-fire-smoke-explosion`) | Near zero cost |
| Smoke that reacts to wind, a moving object or a click | **2D grid** on a plane, or a thin 3D slab | Real swirl at 128 to 512 squared |
| Full 3D plume the camera orbits | 3D grid at 64 cubed or less, or bake | Cost is cubic |
| Hero explosion, same every visit | Bake offline (`sim-cache-baking-vat`) | Full quality |
| Static fog, clouds | `volumetrics-atmosphere` | No simulation |
| Liquid | `fluid-sph-3d` or heightfield in `cloth-fluid-simulation` | Different model |

## 2. The loop

One frame, in this order (the field handed on is divergence free):

| Stage | What it does | Failure if wrong |
|---|---|---|
| 1. Sources | Write density, temperature and optionally velocity at emitters | Plume never starts |
| 2. Forces | Buoyancy (hot rises, dense falls), wind, vorticity confinement | No motion, or flat smoke |
| 3. Advect | Semi-Lagrangian: trace each sample back along the velocity one step and read the old field there. Unconditionally stable | Blows up if you advect forward |
| 4. Project | Solve for pressure so `div u = 0`, subtract its gradient. Solid cells take no flow | Smoke compresses, ignores obstacles, looks like gas |
| 5. Decay | Cool temperature, dissipate density | Smoke never leaves |

Advection smears: the density blurs a little every step because bilinear sampling averages. That is why the sample stays bounded (density never exceeds the source) and also why detail fades. Fixes in section 7.

## 3. Grid layout

| Layout | Notes |
|---|---|
| **MAC (staggered)**: velocity components on cell faces, density and temperature at centres | Exact divergence, no checkerboard. Used in the sample. Needs offset sampling |
| Collocated (everything at centres, textures) | Simplest on GPU, one texture per field. Central-difference projection leaves a checkerboard mode, so divergence is only reduced (verify on your scene) |

Units: `dx = 1` cell in the sample, so `dt` is in cells per velocity unit. Scale to metres by `dx_m` when you couple to scene wind (`physics-rigidbody` section 2).

## 4. Verified 2D solver

Pure JS, no dependencies. Run in Node 22 (section 10). Results: random velocity noise on 64 x 64 dropped from max divergence 1.74 to 0.62 / 0.05 / 1.5e-4 / 6e-8 after 20 / 60 / 200 / 600 Gauss-Seidel iterations; a 300 step plume with an obstacle stayed finite, density stayed in 0 to 0.998 (source 1), flow through solid faces was exactly 0, and two runs were identical.

```js
/** Stam style stable fluids on a MAC grid (u on vertical faces, v on horizontal faces), 2D, dx = 1.
 *  Smoke density d and temperature T live at cell centres. solid[c] = 1 marks obstacles and the border. */
export function createSmoke(nx, ny) {
  const U = nx + 1, V = ny, cells = nx * ny;
  const u = new Float32Array((nx + 1) * ny), v = new Float32Array(nx * (ny + 1));
  const d = new Float32Array(cells), T = new Float32Array(cells), solid = new Uint8Array(cells);
  const u2 = new Float32Array(u.length), v2 = new Float32Array(v.length), d2 = new Float32Array(cells), T2 = new Float32Array(cells);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) solid[j * nx + i] = 1;
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  /** Bilinear sample of a field stored with offset (ox, oy) in cell units and row width w. */
  function sample(f, w, h, x, y, ox, oy) {
    const fx = clamp(x - ox, 0, w - 1.001), fy = clamp(y - oy, 0, h - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), s = fx - i, t = fy - j, k = j * w + i;
    return (1 - s) * ((1 - t) * f[k] + t * f[k + w]) + s * ((1 - t) * f[k + 1] + t * f[k + w + 1]);
  }
  const velAt = (x, y) => [sample(u, nx + 1, ny, x, y, 0, 0.5), sample(v, nx, ny + 1, x, y, 0.5, 0)];

  /** Semi-Lagrangian: trace each sample point back along the velocity one step, read the old field there. */
  function advect(dt) {
    for (let j = 0; j < ny; j++) for (let i = 0; i <= nx; i++) {                    // u faces at (i, j + 0.5)
      const [a, b] = velAt(i, j + 0.5); u2[j * U + i] = sample(u, U, ny, i - dt * a, j + 0.5 - dt * b, 0, 0.5);
    }
    for (let j = 0; j <= ny; j++) for (let i = 0; i < nx; i++) {                    // v faces at (i + 0.5, j)
      const [a, b] = velAt(i + 0.5, j); v2[j * nx + i] = sample(v, nx, ny + 1, i + 0.5 - dt * a, j - dt * b, 0.5, 0);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {                     // cell centres at (i + 0.5, j + 0.5)
      const [a, b] = velAt(i + 0.5, j + 0.5), x = i + 0.5 - dt * a, y = j + 0.5 - dt * b;
      d2[j * nx + i] = sample(d, nx, ny, x, y, 0.5, 0.5); T2[j * nx + i] = sample(T, nx, ny, x, y, 0.5, 0.5);
    }
    u.set(u2); v.set(v2); d.set(d2); T.set(T2);
  }

  /** Buoyancy (hot rises, dense falls) and vorticity confinement, added to v and u. */
  function forces(dt, { buoyancy = 1.0, weight = 0.05, vorticity = 0.0, ambient = 0 }) {
    for (let j = 1; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = (j - 1) * nx + i, b = j * nx + i;
      if (solid[a] || solid[b]) continue;
      v[j * nx + i] += dt * (buoyancy * ((T[a] + T[b]) / 2 - ambient) - weight * (d[a] + d[b]) / 2);
    }
    if (vorticity <= 0) return;
    const w = new Float32Array(cells), cu = (i, j) => (u[j * U + i] + u[j * U + i + 1]) / 2, cv = (i, j) => (v[j * nx + i] + v[(j + 1) * nx + i]) / 2;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) w[j * nx + i] = (cv(i + 1, j) - cv(i - 1, j) - cu(i, j + 1) + cu(i, j - 1)) / 2;
    for (let j = 2; j < ny - 2; j++) for (let i = 2; i < nx - 2; i++) {
      if (solid[j * nx + i]) continue;
      const gx = (Math.abs(w[j * nx + i + 1]) - Math.abs(w[j * nx + i - 1])) / 2, gy = (Math.abs(w[(j + 1) * nx + i]) - Math.abs(w[(j - 1) * nx + i])) / 2;
      const len = Math.hypot(gx, gy) + 1e-6, fx = (gy / len) * w[j * nx + i] * vorticity, fy = (-gx / len) * w[j * nx + i] * vorticity;  // N cross omega
      u[j * U + i] += 0.5 * dt * fx; u[j * U + i + 1] += 0.5 * dt * fx; v[j * nx + i] += 0.5 * dt * fy; v[(j + 1) * nx + i] += 0.5 * dt * fy;
    }
  }

  /** Make the field divergence free. Gauss-Seidel over cells, solid neighbours take no flow (their faces are zeroed). */
  function project(iterations = 60, overRelax = 1.9) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (solid[j * nx + i]) {   // no flow through solids
      u[j * U + i] = 0; u[j * U + i + 1] = 0; v[j * nx + i] = 0; v[(j + 1) * nx + i] = 0;
    }
    for (let it = 0; it < iterations; it++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (solid[j * nx + i]) continue;
      const sl = 1 - solid[j * nx + i - 1], sr = 1 - solid[j * nx + i + 1], sb = 1 - solid[(j - 1) * nx + i], st = 1 - solid[(j + 1) * nx + i], s = sl + sr + sb + st;
      if (s === 0) continue;
      const div = u[j * U + i + 1] - u[j * U + i] + v[(j + 1) * nx + i] - v[j * nx + i], p = (-div / s) * overRelax;
      u[j * U + i] -= sl * p; u[j * U + i + 1] += sr * p; v[j * nx + i] -= sb * p; v[(j + 1) * nx + i] += st * p;
    }
  }

  function divergence() {                                               // max |div| over fluid cells
    let m = 0;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) if (!solid[j * nx + i])
      m = Math.max(m, Math.abs(u[j * U + i + 1] - u[j * U + i] + v[(j + 1) * nx + i] - v[j * nx + i]));
    return m;
  }

  /** Order: forces, advect, project, so the field handed to the next frame is divergence free. */
  function step(dt, opts = {}) {
    forces(dt, opts); advect(dt); project(opts.iterations ?? 60);
    for (let k = 0; k < cells; k++) { T[k] *= 1 - (opts.cooling ?? 0.0) * dt; d[k] *= 1 - (opts.dissipation ?? 0.0) * dt; }
  }
  return { nx, ny, u, v, d, T, solid, step, project, divergence, advect, forces };
}
```

Usage: `const s = createSmoke(128, 128)`; each frame write emitters (`s.d[k] = 1; s.T[k] = 1` for cells at the base), call `s.step(0.2, { buoyancy: 0.6, weight: 0, vorticity: 0.5, cooling: 0.02, dissipation: 0.01 })`, upload `s.d` to a `DataTexture` (`RedFormat`, `FloatType`) and shade it on a plane. Mark obstacles with `s.solid[k] = 1` before stepping. For a moving obstacle write its velocity into the faces next to it after `project` zeroed them (verify the feel).

## 5. Buoyancy, fire and vorticity

- **Buoyancy** `v += dt * (alpha * (T - ambient) - beta * d)`. `alpha` sets how fast hot gas rises, `beta` makes dense smoke sink. Fire is smoke with high `alpha` and fast `cooling`.
- **Fire** = temperature field plus colour ramp: map `T` to a black-body style gradient and emit light with it (`post-processing-stack` bloom). Fuel and burn-rate models add a third field (guess, not run here). Cool fast so flames lick instead of filling the grid.
- **Vorticity confinement** re-injects the swirl that advection smears out: `f = eps * (N x omega)`, `N = grad|omega| / |grad|omega||`. Measured enstrophy after 300 steps: 341 at `eps` 0, 657 at 0.5, 4156 at 1.5. High values look like boiling, so start at 0.2 to 0.8 (guess).
- **Wind**: add a constant or noise velocity to faces each frame, or place a `v` source. A scripted gust curve beats constant wind (`motion-choreography`).
- **Open top and sides**: the sample walls every border. For open air, leave border cells as fluid and let the solver relax their pressure toward zero (Dirichlet), or fade density at the edge (verify).

## 6. Pressure solver choices

Projection dominates cost. The sample uses over-relaxed Gauss-Seidel (factor 1.9).

| Solver | Per frame | Notes |
|---|---|---|
| Gauss-Seidel, in place | 20 to 60 sweeps | CPU only, it needs in-place updates |
| Jacobi, ping-pong | 20 to 40 passes | The GPU choice, converges slower per pass (guess) |
| Red-black Gauss-Seidel | Half the passes of Jacobi (guess) | Two sub-passes per sweep on GPU |
| Multigrid | A few V-cycles | Best at 3D 64 cubed and up, more code (verify) |

Warm start from last frame's pressure. 60 iterations left max divergence 1e-2 in the plume test: acceptable for smoke, visible leaks for tight obstacles. Raise iterations before raising resolution.

## 7. GPU path (not verified end to end)

| Target | How |
|---|---|
| 2D, WebGL2 | `GPUComputationRenderer` (`three/addons/misc/GPUComputationRenderer.js`) or hand-made ping-pong `WebGLRenderTarget`s with `FloatType` or `HalfFloatType` (verify `EXT_color_buffer_float`). One target per field, passes: advect, forces, divergence, Jacobi x N, subtract gradient. `cloth-fluid-simulation` section 6 covers the same pattern for cloth |
| 3D, WebGL2 | `Data3DTexture` for sampling, `WebGL3DRenderTarget` to write (both exist in r187). Render each Z slice with a full-screen quad, selecting the layer through the second argument of `renderer.setRenderTarget(target, layer)` (verify). Slice-by-slice passes are the cost |
| 3D, WebGPU | Storage buffers or storage textures, `Fn(...).compute(...)`, 3D dispatch. TSL has `texture3D` (verify names per revision). Cleaner and faster than slice rendering |

Quality upgrades, in order of value: MacCormack or BFECC advection for less smearing (verify, can overshoot, clamp to neighbours), a density grid at 2x the velocity resolution (guess), noise injection at the emitter, a vorticity pass. Never read fields back to the CPU each frame.

## 8. Rendering the density volume

| Case | Method | Cost |
|---|---|---|
| 2D grid | Plane or billboard, density through a colour ramp, alpha blend. Normal from density gradient for light | Low |
| Thin 3D slab | A few stacked planes | Low |
| 3D volume | Raymarch a box in the fragment shader sampling the `Data3DTexture`. Use the march loop, jitter, depth blending and half-res upsample from `volumetrics-atmosphere` section 6 and 7 instead of rewriting them | Mid to high |

- Light: march 4 to 8 samples toward the light for self shadow, or fake with a vertical density gradient. Fire emits, so skip shadow for hot cells.
- Fixed step count (24 to 48 for smoke, guess). Early out when accumulated alpha passes 0.95.
- Blend smoke over the scene with premultiplied alpha, fire additively. Soft particles near geometry need the scene depth (`volumetrics-atmosphere` section 7).
- Hand the result to `vfx-post-fx-compositing` for bloom and heat distortion.

## 9. Resolution versus cost per tier

CPU numbers measured (Node 22, desktop CPU, 60 Gauss-Seidel iterations, vorticity on): 64 x 64 about 4 to 7 ms per step, 128 x 128 about 17 to 22 ms, 256 x 256 about 67 to 97 ms (two runs). GPU rows are guesses, measure on the real device.

| Tier | 2D grid | 3D grid | Pressure passes |
|---|---|---|---|
| Low (phones, iGPU) | 128 x 128 GPU, or flipbook | None, bake | 15 to 20 |
| Mid (laptops) | 256 x 256 | 48 to 64 cubed | 20 to 30 |
| High (desktop dGPU) | 512 x 512 | 96 to 128 cubed | 30+ or multigrid |

3D memory: `cells * channels * bytes`. 128 cubed is 2.1M cells, one half-float RGBA volume is about 17 MB, and a solver needs several plus ping-pong copies. Count it against the texture budget in `performance-budget` section 1.

Cut cost in this order: bake or flipbook, 2D instead of 3D, lower resolution, fewer pressure passes, half-rate simulation (step every second frame, render every frame), pause when off screen.

## 10. Verify

1. Numeric: finite fields, density bounded by the source, flow through solid faces 0, max divergence after `project` (`s.divergence()`), identical result on a second run.
2. `render-qa` at three simulated times (`physics-rigidbody` section 12, a `?simt=` query that steps the sim first). Reject: smoke passing through obstacles, a plume that dies in 2 seconds, checkerboard noise, blocky grid edges in the render.
3. Report step time and grid size next to the tier row.

Not verified, check before relying on them: every GPU path, 3D render-target slice selection, MacCormack and BFECC, open boundaries, moving obstacles, fuel and burn models, all phone numbers.
