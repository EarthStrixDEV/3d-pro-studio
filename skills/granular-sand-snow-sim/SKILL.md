---
name: granular-sand-snow-sim
description: Granular materials for Three.js, translating Houdini Grains and MPM snow and Blender sand and snow tricks into what runs live on the web. Covers heightfield sand and snow with angle-of-repose avalanching (verified sample), deposition and erosion, footprints and trails, grain particles with simple contact, instanced grain rendering, GPU gather form, per-tier budgets, and an honest list of what is not realistic (full MPM or large 3D sand) with cheap alternatives. Use when sand should pile, slide and hold footprints, when snow needs tracks or a shovel dent, when grains pour from a hopper or an hourglass, when asked for sand simulation, snow simulation, avalanche, angle of repose, dunes, MPM or footprints, or when a pile will not settle, looks flat, shows diamond shapes or costs too much. Thai triggers ทราย, หิมะ, รอยเท้า, กองทราย, ทรายไหล, เนินทราย, หิมะถล่ม, นาฬิกาทราย.
argument-hint: "<sand, snow or grains, what disturbs it, area size, target device tier>"
---

# Granular Sand and Snow

Sand and snow look simple and simulate badly: millions of contacts. The web answer is to simulate **height**, not grains, and keep grains for a few thousand showpiece particles. Budgets in `performance-budget`.

## 1. Pick the approach

| Need | Approach | Cost |
|---|---|---|
| Dunes, piles, footprints, tyre tracks, a shovel dent | **Heightfield with avalanching** (sections 2 to 6) | A grid pass, cheap |
| Pouring from a hopper, an hourglass, a small pile | **Grain particles** (section 7), settle into the heightfield | Hundreds to a few thousand grains |
| Falling clumps on a heightfield pile | Hybrid: heightfield plus dust sprites (`vfx-weather-environment`, `particle-system-architecture`) | Cheap |
| Footprints only, nothing slides | Trail texture added to displacement, no solver (section 5) | Near zero |
| Hero avalanche, sand collapse, same every visit | Bake (`sim-cache-baking-vat`) | Zero solver cost |
| Full MPM snow, DEM sand, large 3D sand | **Not realistic live** (section 9). Houdini Grains and MPM run offline | Bake or fake |

## 2. Heightfield model

One height `h` per cell over a hard `base` (rock, floor, props). Sand sits on `base`, the surface is `h + base`. Each pass, a cell sends sand to a neighbour only when the surface drop exceeds the **angle of repose**: `drop > tan(repose) * distance`. The sample uses 8 neighbours (diagonals at `sqrt 2`), which keeps the pile near a cone. A 4-neighbour version tends to leave square pyramids (not run here, verify).

Repose angles (guess, real values depend on grain shape and moisture, tune against a reference photo):

| Material | Repose | Note |
|---|---|---|
| Dry sand | 30 to 35 degrees | Sample uses 33 |
| Wet or packed sand | 40 to 50 | Holds steep walls, castles |
| Gravel | 35 to 40 | Rough |
| Fresh powder snow | 20 to 35 | Slides easily |
| Packed snow | 40+ | Holds a footprint wall |

## 3. Verified sample

Gather form: each cell reads its 8 neighbours and writes only itself, with flux from `a` to `b` the exact negative of `b` to `a`, so total sand is conserved. The same loop body ports to a fragment shader with two ping-pong textures. Run in Node 22 (section 10). Results on a 96 x 96 grid, cell 0.05 m, repose 33 degrees, a 5 x 5 column 4 m high:

| `rate` | Passes to settle | Result |
|---|---|---|
| 0.03 | 5957 | Max slope 0.6495 against tan 33 = 0.6494, height 0.469 m (cone 0.465), radius 0.705 m (cone 0.716) |
| 0.06 | 3209 | Same pile |
| 0.1 | 2024 | Same pile |
| 0.2 | 767 | Settles, but a flatter pile (height 0.406): overshoot |
| 0.4 | never | Oscillates, max slope 3.57 |

Mass drift stayed at about 1e-5 or better (float32 rounding), all heights finite and non negative. A footprint `stamp` conserved mass to 1e-9 and its rim settled in 75 passes. A pile poured against a 0.6 m rock step spread onto it (28 cells carry sand on the step), settled in 2515 passes with mass drift 7.5e-6 and no negative heights.

```js
/** Heightfield sand: angle-of-repose avalanching in gather form (one cell reads its 8 neighbours, writes itself).
 *  The same loop body ports to a fragment shader with ping-pong textures. Mass is conserved because the flux a to b
 *  is the exact negative of b to a. cell = metres per cell, repose in degrees, rate <= 1/16 keeps it stable. */
export function createSand(nx, ny, { cell = 0.05, repose = 33, rate = 0.06 } = {}) {
  let h = new Float32Array(nx * ny), next = new Float32Array(nx * ny);
  const base = new Float32Array(nx * ny);                           // hard ground under the sand (rock, floor, props)
  const tanR = Math.tan((repose * Math.PI) / 180);
  const N = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, 1, Math.SQRT2]];
  // flux a to b: the part of the drop above the repose slope, capped so a cell never gives more than it has (sand/8 per pair)
  const flux = (sa, ba, sb, bb, dist) => Math.min(rate * Math.max(0, sa + ba - sb - bb - tanR * cell * dist), sa / 8);

  /** One avalanche pass. Returns the largest flux, which is 0 when every slope is at or below repose. */
  function relax() {
    let peak = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i; let net = 0;
      for (const [di, dj, dist] of N) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;   // edges are walls
        const o = b * nx + a, out = flux(h[k], base[k], h[o], base[o], dist), inn = flux(h[o], base[o], h[k], base[k], dist);
        net += inn - out; peak = Math.max(peak, out);
      }
      next[k] = h[k] + net;
    }
    [h, next] = [next, h];
    return peak;
  }

  /** Remove sand in a disc (footstep, wheel, scoop) and push the same volume onto a ring around it. Mass conserving. */
  function stamp(cx, cy, radius, depth, ringWidth = 1.5) {
    let taken = 0; const ring = [], r2 = radius * radius, outer = radius + ringWidth;
    for (let j = Math.max(0, Math.floor(cy - outer)); j <= Math.min(ny - 1, Math.ceil(cy + outer)); j++)
      for (let i = Math.max(0, Math.floor(cx - outer)); i <= Math.min(nx - 1, Math.ceil(cx + outer)); i++) {
        const d2 = (i - cx) ** 2 + (j - cy) ** 2, k = j * nx + i;
        if (d2 <= r2) { const t = Math.min(depth, h[k]); h[k] -= t; taken += t; } else if (d2 <= outer * outer) ring.push(k);
      }
    for (const k of ring) h[k] += taken / ring.length;              // the avalanche pass then settles the rim
    return taken;
  }

  const total = () => { let s = 0; for (let k = 0; k < h.length; k++) s += h[k]; return s; };
  const maxSlope = () => {                                          // steepest drop between neighbours, as tan(angle)
    let m = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (const [di, dj, dist] of N) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      m = Math.max(m, (h[j * nx + i] + base[j * nx + i] - h[b * nx + a] - base[b * nx + a]) / (cell * dist));
    }
    return m;
  };
  return { get height() { return h; }, base, relax, stamp, total, maxSlope, tanRepose: tanR, nx, ny, cell };
}
```

Usage: `const sand = createSand(256, 256, { cell: 0.05, repose: 33 })`, write initial heights into `sand.height`, rock into `sand.base`, call `sand.relax()` a few times per frame, upload `sand.height` to a `DataTexture` (`RedFormat`, `FloatType`, `needsUpdate = true`). Read `sand.height` after `relax()`, the buffers swap each pass.

## 4. Stability, convergence, cost

- **`rate` at 0.06 or lower is the safe range** (derived: 1/16 for 8 neighbours, measured: 0.1 still exact, 0.2 flattens, 0.4 diverges). Do not tune it for speed.
- **A big collapse needs thousands of passes** (3209 for the 4 m column). A disturbance like a footprint needs tens (75). So: pre-settle at load, then run a fixed pass budget per frame only where something changed. Track dirty tiles (a stamp, an emitter) and relax those for as long as the largest flux stays above 1e-4 (guess), then sleep them.
- Cost per pass on the CPU (Node 22, desktop, unoptimised loops): 128 x 128 5.2 ms, 256 x 256 20.7 ms, 512 x 512 87 to 105 ms. Flatten the neighbour loop and move to a GPU pass for 256 and up. A GPU pass is a texture lookup of 8 neighbours (verify the real cost on a device).
- GPU: ping-pong float or half-float textures (`HalfFloatType` loses precision on shallow slopes, verify), one pass per iteration, read-only neighbours so there are no write races. `GPUComputationRenderer` (`three/addons/misc/GPUComputationRenderer.js`) or WebGPU storage buffers (`three/webgpu`, `three/tsl`, verify names per revision). Not verified here, build 64 x 64 first and compare against the sample's slope and mass numbers.

## 5. Deposition, erosion, footprints, trails

| Effect | How |
|---|---|
| Pouring, snowfall | Add height at emitters or everywhere with a mask (`normal.y` for snow). Weather feel: `vfx-weather-environment` |
| Scoop, wheel, footstep | `stamp(cx, cy, radius, depth)`: removes sand in a disc, pushes the same volume onto a ring, the avalanche pass settles the rim. Mass conserving |
| Snow footprint (compaction) | Remove depth with no ring (snow compresses, mass not conserved, looks right, guess). Keep it, snow does not refill |
| Sand footprint that fades | `stamp` then `relax`, the dent softens by itself as sand slides back |
| Tyre or foot trail | Stamp along the path at spacing no more than the radius, or write a trail render target and add it to the displacement in the shader (cheapest, no solver) |
| Wind erosion, dunes | Move height downwind each pass (saltation), deposit behind obstacles (not run here, verify) |
| Water erosion | `ocean-terrain-environment` |
| Contact from a character | Sample `h + base` at the foot position, place the foot, then `stamp` there |

Impact decals and dust puffs at the stamp point: `vfx-impact-sparks-decals`. Stamp in world cells: `cell` metres per cell, convert with `x / cell`.

## 6. Rendering the surface

| Layer | Method |
|---|---|
| Surface | One displaced plane, one vertex per cell. Height in a float texture read in the vertex shader (`maxVertexTextures`, verify), normal from central differences of neighbour texels in the fragment shader (`shader-craft`). Never rebuild geometry |
| Material | `MeshStandardMaterial`, roughness 0.9 to 1, a tiled grain normal map, triplanar sampling so steep slopes do not stretch (`pbr-lookdev`) |
| Sparkle | Threshold a high-frequency noise to a small specular boost, cheap and reads as glints. Snow: add a soft rim and subsurface fake |
| Colour | Darker on steep slopes and where wet, lighter at crests. Blend by slope, `normal.y` |
| Grains (section 7) | `InstancedMesh` of a 12 to 20 triangle icosahedron or tetra, `setMatrixAt` per grain, `instanceColor` for variation, update `instanceMatrix.needsUpdate` |
| Far grains | `Points` with sprites, or skip and show the heightfield |

Keep the heightfield mesh and grains in the same material colours or the handover pops.

## 7. Grain particles

Not in the verified sample. Simple contact, run on a grid like `fluid-sph-3d` section 4 with cell size `2 r`:
1. Integrate gravity.
2. Neighbour query on a uniform grid.
3. For each overlapping pair push the grains apart along the normal (position based, as in `soft-body-xpbd`), remove the relative tangential velocity by a friction factor.
4. Collide with a container or the heightfield (read `h + base` at the grain position).
5. A grain slower than a threshold for a few frames **deposits**: delete it and add its volume to the heightfield at that cell. This is what keeps the particle count small.

| Option | Count live (guess, measure) | Note |
|---|---|---|
| Rapier dynamic balls (`physics-rigidbody`) | 500 to 1.5k mid | Easiest, real contacts, one body per grain |
| Own grid contact on the CPU in a worker | 2k to 10k | More code, no engine overhead |
| WebGPU compute (`gpu-particles-compute`) | 20k to 100k high | Atomics for the grid, verify |

Friction is what makes a pile: low friction gives liquid, high friction gives a stack of beads that never flows. Start at 0.5 (guess).

## 8. Budgets per tier

Rows are guesses except the measured CPU line in section 4. Measure on the device.

| Tier | Heightfield | Passes per frame | Grains | Footprints |
|---|---|---|---|---|
| Low (phones, iGPU) | 128 x 128 or a trail texture only | 2 to 4 on dirty tiles | 0 to 300, or sprites | Trail texture |
| Mid (laptops) | 256 x 256 GPU | 4 to 8 | 500 to 2k | `stamp`, up to a few per frame |
| High (desktop dGPU) | 512 x 512 to 1024 x 1024 GPU | 8 to 16 | 5k to 50k instanced | Many per frame |

Cut cost in this order: trail texture instead of a solver, lower resolution, fewer passes, dirty tiles only, fewer grains, deposit sooner.

## 9. What is not realistic live

| Feature | Why | Do instead |
|---|---|---|
| Full MPM snow or sand, mixed with a rigid body | Particle to grid transfers, millions of particles, atomics, small steps | Heightfield for the pile, rigid body for the object, dust sprites |
| 3D DEM of a large sand volume | Millions of contacts | Bake (`sim-cache-baking-vat`), or a hopper with a few thousand grains then deposit |
| Sand that flows around and under objects in 3D | Heightfield has no overhangs or tunnels | Hide with props, or bake |
| Fully accurate snow compaction and wet snow cohesion | Needs a material model per cell | Compaction stamp plus a repose per layer, art-directed |

Tell the client early. Offer the heightfield result, it reads correctly from most angles.

## 10. Symptoms and verify

| Symptom | Cause | Fix |
|---|---|---|
| Pile never stops moving | `rate` above 0.1 | 0.03 to 0.06 |
| Pile too flat | `rate` too high (overshoot) or repose too low | Lower `rate`, check repose degrees |
| Square or diamond pile | Only 4 neighbours | Use 8 (sample) |
| Mass slowly changes | float32 rounding (about 1e-5 over a long run, measured), or a clamp in your own variant | Keep the capped flux form of the sample, sum totals in a float64 when you check |
| Terraces or stair steps on slopes | Low grid resolution against the height scale | Raise resolution or smooth the render normal |
| Stretched texture on steep slopes | Planar UV | Triplanar |
| Stutter on a big collapse | Too many passes in one frame | Budget passes per frame, dirty tiles |
| Footprint rim spikes | Ring too thin for the depth | Larger `ringWidth` or lower depth |

Verify:
1. Numeric: finite and non negative heights, mass before and after a `stamp` and a relax run, `maxSlope()` at or under `tanRepose` once settled.
2. `render-qa` at three simulated times (`physics-rigidbody` section 12): fresh, mid collapse, settled, from a grazing angle where slope and texture stretching show.
3. Report grid size, passes per frame and step time next to the tier row.

Not verified, check before relying on them: 4-neighbour behaviour, wind erosion, snow compaction, every GPU path, half-float precision, grain contact code, grain deposit, all repose values, all phone numbers.
