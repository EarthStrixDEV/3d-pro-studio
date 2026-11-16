---
name: soft-body-xpbd
description: Soft bodies for Three.js with XPBD (extended position based dynamics), translating Maya soft body and Blender Soft Body and Houdini Vellum into what runs on the web. Covers compliance and why stiffness stays independent of time step, tetrahedral jelly, volume preservation, pressure balloons, shape matching as the cheap alternative, attachments and collisions, skinning a render mesh to the soft body, squash and jelly looks, and per-tier budgets. Includes a verified XPBD sample with distance, tetrahedron volume and pressure constraints. Use when a jelly, blob, cushion, balloon, rubber toy, belly or squishy prop should deform and recover, when asked for soft body, XPBD, PBD, jelly physics, or when a soft body is too stiff or too floppy, inverts, jitters, or changes stiffness with frame rate. Thai triggers วัตถุนิ่ม, เยลลี่, ลูกโป่ง, ของเด้งดึ๋ง, ยางหยุ่น, soft body, บีบอัด.
argument-hint: "<what deforms, how soft, what it touches, target device tier>"
---

# Soft Bodies with XPBD

Goes deeper than section 7 of `cloth-fluid-simulation` (mass-spring, pressure cloth, shape matching in four rows). Rapier rigid bodies live in `physics-rigidbody`. Budgets in `performance-budget`.

## 1. Pick the method

| Need | Method | Cost |
|---|---|---|
| Cartoon bounce, no real volume | Fake: squash and stretch in a shader or morph (`deformers-blendshapes-morph`) | Near zero |
| Squishy prop, hundreds of them, shape must come back | **Shape matching** (section 6) | O(N), very cheap |
| Jelly, blob, belly, rubber that folds and keeps volume | **XPBD tetrahedra** (sections 2 to 5) | Mid, 100 to 500 vertices |
| Balloon, cushion, inflated toy | XPBD distance plus **pressure** (section 5) | Cheap, surface only |
| Scripted soft motion, same every visit | Bake (`sim-cache-baking-vat`) | Zero solver cost |
| Cloth, flags | `cloth-fluid-simulation` | Not this |
| Engine-side soft bodies | Rapier JS 0.21.0 typings in the verify harness expose `SoftBodyDesc`, `world.createSoftBody`, cell models Volume, Corotational and NeoHookean, solvers Constraints and Fem. One falling sphere was smoke tested (162 particles, landed and squashed). Everything else unrun (verify). Check the version you ship, `physics-rigidbody` section 1 says Rapier has none | Engine cost |

## 2. Why XPBD

Plain PBD stiffness `k` in 0..1 changes with iteration count and time step. XPBD (Macklin, Mueller, Chentanez 2016) uses **compliance** `alpha = 1 / stiffness` (units m/N for a distance constraint), scales it `alpha_tilde = alpha / h^2` for substep `h`, and corrects with `d_lambda = (-C - alpha_tilde * lambda) / (sum(w_i |grad C_i|^2) + alpha_tilde)`. `alpha = 0` is rigid. Run **many substeps with one iteration each** (the "small steps" result from Macklin et al. 2019, verify the citation) instead of few steps with many iterations.

Measured on a 10 mass hanging chain (1 kg each, links of 0.1 m, `alpha = 1e-4`). Analytic stretch of the top link is `10 * m * g * alpha / L = 0.0981`:

| Solver | Substeps (dt 1/60) | Top-link stretch |
|---|---|---|
| XPBD, 1 iteration | 2, 4, 8, 16 | 0.159, 0.113, 0.102, 0.099 |
| XPBD, 4 iterations | 8 | 0.0981 |
| XPBD, same substep size, other dt | 1/30 with 8 (equals 1/60 with 4), 1/120 with 8 (equals 1/60 with 16) | 0.113, 0.099 |
| PBD, `k = 0.5` | 2, 4, 8, 16, 32 | 0.129, 0.032, 0.008, 0.002, 0.0005 |

XPBD converges to the physical answer and depends only on the substep size. The same PBD constant gives a 250 fold different material. Use fixed `dt` 1/60 with the loop in `physics-rigidbody` section 3.

Choosing compliance: start from a wobble frequency `f`. For one spring with vertex mass `m`, `k = m (2 pi f)^2`, `alpha = 1 / k`. A lattice behaves stiffer than one spring, so treat the result as a starting point (guess) and tune by eye. Compliance values depend on mass and tet size, so re-tune after refining the mesh.

## 3. Verified sample

Pure JS plus a cube generator. Run in Node 22 (section 9). Results: the 64 vertex jelly (162 tets) dropped from 1.5 m stayed finite, rested on the ground with volume ratio 1.000 and every tet at 0.999 of rest volume or more; a closed surface inflated to a 1.5 volume target reached 1.500; 100 render points bound by barycentric weights reproduced themselves exactly and followed a translation to 2e-7.

```js
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (p, a, b) => [p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Signed volume of tetrahedron (a, b, c, d) in position array p. */
export const tetVolume = (p, a, b, c, d) => dot(sub(p, b, a), cross(sub(p, c, a), sub(p, d, a))) / 6;

/** XPBD soft body: distance constraints, tetra volume constraints, optional closed-surface pressure, ground plane.
 *  compliance alpha = 1 / stiffness (0 is rigid). Per substep we solve each constraint `iterations` times (1 is fine). */
export function createXPBD({ pos, invMass, edges, tets, edgeCompliance = 1e-5, volumeCompliance = 0, groundY = 0, friction = 0.5 }) {
  const n = pos.length / 3, prev = new Float32Array(pos.length), vel = new Float32Array(pos.length);
  const ne = edges.length / 2, nt = tets.length / 4;
  const rest = new Float32Array(ne), V0 = new Float32Array(nt), lamE = new Float32Array(ne), lamT = new Float32Array(nt);
  for (let e = 0; e < ne; e++) rest[e] = Math.hypot(...sub(pos, edges[e * 2], edges[e * 2 + 1]));
  for (let t = 0; t < nt; t++) V0[t] = tetVolume(pos, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]);
  let pressure = null, lamP = 0;

  const closedVolume = (tris) => {                                // divergence theorem, needs outward winding
    let v = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      v += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) + pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    return v;
  };
  /** Closed surface with outward wound triangles. Target volume = ratio * current volume (1.5 inflates, 1 holds). */
  function addPressure(tris, ratio, compliance = 0) { pressure = { tris, target: ratio * closedVolume(tris), compliance }; }

  /** One XPBD correction for a constraint with value C, gradients grads[k] on particles ids[k]. Returns nothing, edits pos and lambda. */
  function apply(C, ids, grads, alphaT, lam, idx, store) {
    let wsum = 0;
    for (let k = 0; k < ids.length; k++) wsum += invMass[ids[k]] * (grads[k][0] ** 2 + grads[k][1] ** 2 + grads[k][2] ** 2);
    if (wsum + alphaT < 1e-12) return;
    const dl = (-C - alphaT * lam[idx]) / (wsum + alphaT);       // XPBD: delta lambda
    lam[idx] += dl;
    for (let k = 0; k < ids.length; k++) for (let a = 0; a < 3; a++) pos[ids[k] * 3 + a] += invMass[ids[k]] * dl * grads[k][a];
  }

  function step(dt, { substeps = 10, iterations = 1, gravity = -9.81, damping = 1.0 } = {}) {
    const h = dt / substeps, aE = edgeCompliance / (h * h), aV = volumeCompliance / (h * h);
    for (let s = 0; s < substeps; s++) {
      prev.set(pos); lamE.fill(0); lamT.fill(0); lamP = 0;
      for (let i = 0; i < n; i++) if (invMass[i] > 0) {
        vel[i * 3 + 1] += gravity * h;
        for (let a = 0; a < 3; a++) pos[i * 3 + a] += vel[i * 3 + a] * h;
      }
      for (let it = 0; it < iterations; it++) {
        for (let e = 0; e < ne; e++) {
          const a = edges[e * 2], b = edges[e * 2 + 1], d = sub(pos, a, b), len = Math.hypot(...d);
          if (len < 1e-9) continue;
          const g = d.map((x) => x / len);
          apply(len - rest[e], [a, b], [g, g.map((x) => -x)], aE, lamE, e);
        }
        for (let t = 0; t < nt; t++) {
          const i0 = tets[t * 4], i1 = tets[t * 4 + 1], i2 = tets[t * 4 + 2], i3 = tets[t * 4 + 3];
          const g1 = cross(sub(pos, i2, i0), sub(pos, i3, i0)).map((x) => x / 6), g2 = cross(sub(pos, i3, i0), sub(pos, i1, i0)).map((x) => x / 6);
          const g3 = cross(sub(pos, i1, i0), sub(pos, i2, i0)).map((x) => x / 6), g0 = g1.map((x, k) => -(x + g2[k] + g3[k]));
          apply(tetVolume(pos, i0, i1, i2, i3) - V0[t], [i0, i1, i2, i3], [g0, g1, g2, g3], aV, lamT, t);
        }
        if (pressure) {                                           // one constraint over the whole surface
          const ids = [...new Set(pressure.tris)], grads = new Map(ids.map((i) => [i, [0, 0, 0]])), T = pressure.tris;
          for (let t = 0; t < T.length; t += 3) {
            const [a, b, c] = [T[t], T[t + 1], T[t + 2]], pa = [0, 1, 2].map((k) => pos[a * 3 + k]), pb = [0, 1, 2].map((k) => pos[b * 3 + k]), pc = [0, 1, 2].map((k) => pos[c * 3 + k]);
            const ga = cross(pb, pc), gb = cross(pc, pa), gc = cross(pa, pb);
            for (let k = 0; k < 3; k++) { grads.get(a)[k] += ga[k] / 6; grads.get(b)[k] += gb[k] / 6; grads.get(c)[k] += gc[k] / 6; }
          }
          const lam = [lamP];
          apply(closedVolume(T) - pressure.target, ids, ids.map((i) => grads.get(i)), pressure.compliance / (h * h), lam, 0);
          lamP = lam[0];
        }
        for (let i = 0; i < n; i++) if (invMass[i] > 0 && pos[i * 3 + 1] < groundY) {   // ground: project and drag along the surface
          pos[i * 3 + 1] = groundY;
          for (const a of [0, 2]) pos[i * 3 + a] -= (pos[i * 3 + a] - prev[i * 3 + a]) * friction;
        }
      }
      const k = Math.max(0, 1 - damping * h);
      for (let i = 0; i < pos.length; i++) vel[i] = ((pos[i] - prev[i]) / h) * k;
    }
  }

  /** Bind render vertices to tets once: barycentric weights in the best fitting tet (also works just outside). */
  function bind(points) {
    const out = [];
    for (let p = 0; p < points.length / 3; p++) {
      let best = null, bestScore = -Infinity; const q = new Float32Array(points.subarray(p * 3, p * 3 + 3));
      for (let t = 0; t < nt; t++) {
        const [a, b, c, d] = [0, 1, 2, 3].map((k) => tets[t * 4 + k]), all = new Float32Array(pos.length + 3); all.set(pos); all.set(q, pos.length);
        const qi = pos.length / 3, V = tetVolume(pos, a, b, c, d);
        const w = [tetVolume(all, qi, b, c, d) / V, tetVolume(all, a, qi, c, d) / V, tetVolume(all, a, b, qi, d) / V, tetVolume(all, a, b, c, qi) / V];
        const score = Math.min(...w);
        if (score > bestScore) { bestScore = score; best = { ids: [a, b, c, d], w }; }
      }
      out.push(best);
    }
    return out;
  }
  function skin(binding, out) {                                  // call per frame, writes render positions
    binding.forEach((bd, p) => { for (let a = 0; a < 3; a++) out[p * 3 + a] = bd.ids.reduce((s, id, k) => s + bd.w[k] * pos[id * 3 + a], 0); });
  }
  const volume = () => { let v = 0; for (let t = 0; t < nt; t++) v += tetVolume(pos, tets[t * 4], tets[t * 4 + 1], tets[t * 4 + 2], tets[t * 4 + 3]); return v; };
  return { pos, vel, step, addPressure, bind, skin, volume, V0, edgeCount: ne, tetCount: nt, closedVolume };
}

/** Cube of n x n x n cells, size metres, split into 6 tetrahedra per cell (Kuhn). Returns positions, edges, tets, surface tris. */
export function jellyCube(n, size, origin = [0, 0, 0]) {
  const m = n + 1, id = (x, y, z) => (z * m + y) * m + x, pos = new Float32Array(m ** 3 * 3), tets = [], edgeSet = new Set();
  for (let z = 0; z < m; z++) for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) pos.set([origin[0] + x * size / n, origin[1] + y * size / n, origin[2] + z * size / n], id(x, y, z) * 3);
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (const p of perms) {
    const c = [x, y, z], v = [id(x, y, z)]; for (const ax of p) { c[ax]++; v.push(id(...c)); }
    if (tetVolume(pos, ...v) < 0) [v[1], v[2]] = [v[2], v[1]];     // keep every tet positively oriented
    tets.push(...v);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) edgeSet.add(Math.min(v[i], v[j]) * 1e6 + Math.max(v[i], v[j]));
  }
  const edges = []; for (const k of edgeSet) edges.push(Math.floor(k / 1e6), k % 1e6);
  return { pos, edges: Int32Array.from(edges), tets: Int32Array.from(tets), id, m };
}
```

Usage:

```js
const J = jellyCube(4, 1, [0, 1.5, 0]);                          // 4 cells per side, 1 m, 125 vertices
const count = J.pos.length / 3, w = new Float32Array(count).fill(count / 1000);   // 1000 kg shared, invMass = count / 1000
const soft = createXPBD({ pos: J.pos, invMass: w, edges: J.edges, tets: J.tets, edgeCompliance: 1e-5, volumeCompliance: 0 });
// fixed loop: soft.step(1 / 60, { substeps: 10, iterations: 1, damping: 1 });
const binding = soft.bind(renderMesh.geometry.attributes.position.array);     // once, at load
// per frame: soft.skin(binding, renderMesh.geometry.attributes.position.array); needsUpdate; computeVertexNormals()
```

`bind` is O(vertices x tets), run it at load. The samples allocate per constraint, so flatten arrays before shipping.

## 4. Tetrahedral jelly

| Source | How |
|---|---|
| Box or lattice shape | `jellyCube` (6 Kuhn tets per cell, fixed orientation). Deform the lattice points to fit a shape, cheapest path |
| Arbitrary mesh | Offline tetrahedralisation (TetGen or fTetWild style tools, verify the tool), export vertices and tet indices as JSON or a glTF extra (`gltf-asset-pipeline`). Do not tetrahedralise in the browser |
| Coarse proxy | Soft body of 50 to 300 vertices, render mesh bound to it (section 7). Never simulate the render mesh |

Rules:
- Every tet must start positively oriented (the sample swaps two vertices when not). Inverted tets never recover.
- Edge constraints control shear and stretch, the volume constraint resists compression. Edge compliance alone gave volume ratio 0.992 on the drop test, with the volume constraint at 0 it held 1.000. Volume compliance 1e-3 and 0.1 both gave 0.992, so at this tet size the volume term was already negligible: tune it per tet size. Start at 0.
- Softer edges squash more: edge compliance 1e-3 landed at height 0.92 against 0.996 at 1e-5 (n = 3 jelly, same drop).
- Add `damping` 0.5 to 3 per second so wobble ends. The sample uses 1.

## 5. Pressure balloons

A balloon is a closed surface with one volume constraint, no interior. `V = sum(a . (b x c)) / 6` over outward wound triangles, `C = V - V_target`, gradient at a corner is the cross product of the other two corners divided by 6, summed over triangles. Same `d_lambda` as above, one constraint for the whole surface (`addPressure(tris, ratio, compliance)` in the sample).

- `ratio` above 1 inflates (1.5 reached 1.500), below 1 deflates. Drive it from game state for a breathing or squeezed look.
- Edges need some compliance (1e-3 in the test) or the surface cannot stretch to the new volume. The cube lattice surface only became round-ish (radii 0.68 to 0.90), use a sphere mesh for a round balloon.
- Winding must be outward. Inward gives a negative volume and the balloon collapses.
- A punctured or open mesh has no volume. Keep it closed.

## 6. Shape matching, the cheap option

Not in the verified sample. Algorithm (Mueller et al. 2005, verify constants): keep a rest shape, each frame (1) compute the centre of mass `c`, (2) build `A = sum m (x_i - c)(x0_i - c0)^T`, (3) extract the rotation `R` of `A` (polar decomposition, or the iterative quaternion method of Mueller et al. 2016, verify), (4) goal `g_i = R (x0_i - c0) + c`, (5) `x_i += stiffness * (g_i - x_i)`, velocity from the change.

| Pros | Cons |
|---|---|
| O(N), no constraint graph, unconditionally stable | One global shape: no folding, no local deformation, no volume term |
| Hundreds of props at once | Needs clusters (several overlapping groups) for bendy shapes |

Use it for squishy props and toys. Use XPBD when parts must fold or bulge.

## 7. Attachments, collisions, skinning

- **Pins and attachments**: `invMass = 0` pins a vertex. Move a pinned vertex by writing `pos` and the previous position together (as `movePin` in `cloth-fluid-simulation`), or the velocity spikes. For a body worn on a skeleton, drive pins from bone world matrices (`rigging-skeleton-ik`).
- **Collision**: ground plane in the sample. Add spheres and capsules as in `cloth-fluid-simulation` section 4, project particles out, drop inward velocity. Read colliders from the Rapier registry (`physics-rigidbody` section 2) as kinematic. The soft body does not push rigid bodies back. Two-way coupling is not realistic here: bake or fake it.
- **Self collision**: none in the sample. Fold-over interpenetrates, hide it with volume and low deformation.
- **Skinning the render mesh**: `bind` once, barycentric weights in the nearest tet, `skin` per frame. Dense meshes: move it to a vertex shader reading a texture of tet vertex positions (verify). Rebuild normals after skinning.
- **Jelly look**: a soft sheen with `MeshPhysicalMaterial` (`pbr-lookdev`), transmission only if the budget allows (see `performance-budget`), slight overshoot from low damping, a squash in scale on impact as a cheap second layer.

## 8. Budgets per tier

CPU samples measured (Node 22, desktop CPU, 10 substeps, 1 iteration, unoptimised, allocation heavy): 64 vertices 1.2 to 1.5 ms per step, 125 vertices 2.6 ms, 343 vertices 9.1 ms. Phones assume roughly 3x slower (guess). Tier rows are guesses.

| Tier | Live approach | Vertices stepping per frame |
|---|---|---|
| Low (phones, iGPU) | Shape matching, fake deformers, or one 64 vertex jelly | About 100 |
| Mid (laptops) | XPBD, one or two bodies of 100 to 300 vertices, in a worker | 300 to 600 |
| High (desktop dGPU) | Several bodies, or one of 1k, flattened arrays in a worker | 1k to 3k |

Larger counts need GPU XPBD with constraint graph colouring (verify). Cut cost in this order: bake, shape matching, fewer vertices, fewer substeps (8 stayed within 4% of analytic), sleep when speed is under a threshold, skip off screen bodies.

| Symptom | Cause | Fix |
|---|---|---|
| Inverted tets, jelly turns inside out | Too soft, big impact, bad start orientation | Fewer compliance, more substeps, volume compliance 0, check min `V / V0` (above 0.5 is a safe floor, guess) |
| Feels different at other frame rates | Variable `dt` | Fixed `dt`, constant `substeps` |
| Jitters at rest | Damping 0, ground flip-flop | `damping` 0.5 to 3, friction on the ground |
| Explodes | NaN, spawn inside a collider, stiffness above what substeps hold | `Number.isFinite` guard, spawn outside, raise substeps |
| Too floppy | Compliance too large | Lower `edgeCompliance` by 10x steps, check `volumeCompliance` |
| Pressure balloon collapses | Inward winding, open mesh | Fix winding, close the mesh |

## 9. Verify

1. Numeric: finite positions, `volume() / V0` near 1 for jelly, minimum `V / V0` per tet staying positive, ground clearance, balloon volume near the target, the chain analytic stretch for any new constraint type.
2. `render-qa` at three simulated times (`physics-rigidbody` section 12), with a grazing and a close camera. Reject popped tets, a render mesh that detaches from the body, jitter.
3. Report step time and vertex count next to the tier row.

Not verified, check before relying on them: shape matching code, Rapier soft body API beyond one sphere, tetrahedralisation tools, GPU XPBD, all phone numbers, determinism across machines, the "small steps" citation.
