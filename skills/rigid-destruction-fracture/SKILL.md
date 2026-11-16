---
name: rigid-destruction-fracture
description: Runtime destruction for Three.js, translating Houdini RBD Material Fracture, Blender Cell Fracture and Maya Bullet shatter into what runs on the web. Covers pre-fractured versus runtime fracture, a verified Voronoi fracture of a convex body into pieces with interior cut faces, convex hull piece colliders in Rapier, an intact-until-hit compound with contact force break thresholds, debris lifetime and sleeping, piece-count budgets per device tier, two-material pieces for interior faces, and effect hooks to impact VFX. Use when a wall, vase, crate, glass pane or statue must shatter on impact, when asked for fracture, shatter, destruction, breakable or Voronoi pieces, or when breaking causes a frame spike, floating chunks, pieces tunnelling or too many bodies. Thai triggers แตกกระจาย, ทุบแตก, ทำลายวัตถุ, เศษแตก, กำแพงพัง, แจกันแตก, fracture.
argument-hint: "<what breaks, what hits it, how many pieces, target device tier>"
---

# Rigid Destruction and Fracture

Builds on `physics-rigidbody` (Rapier, registry, fixed loop, sleeping). Voronoi basics, `ConvexObjectBreaker` and the shard effector live in `mograph-procedural` section 9, do not repeat them there. Budgets in `performance-budget`.

## 1. Pre-fractured or runtime

| Approach | Use when | Cost |
|---|---|---|
| **Scripted break**, baked animation | Cutscene, same every time | Zero solver cost (`blender-to-three-export`, `sim-cache-baking-vat`) |
| **Pre-fractured in the DCC**, ship pieces | Hero object, art-directed shards (Blender Cell Fracture, one node per piece, origin at its centroid, `gltf-asset-pipeline`) | Load size, best look |
| **Runtime Voronoi at load** (this skill), held intact until hit | Many different objects, procedural, same look rules everywhere | 20 to 60 ms for 40 to 150 pieces (measured), do it at load or in a worker |
| Runtime fracture at the impact moment | Pieces must differ per hit | Frame spike. Precompute a few variants instead |
| `ConvexObjectBreaker` | Quick convex breaks, see `mograph-procedural` section 9 | Untested there (verify) |
| Fake: swap in a broken mesh, spawn debris sprites | Low tier, background props | Cheapest. `vfx-impact-sparks-decals` |

Break only what the camera sees breaking. Everything else is one rigid body.

## 2. Generating pieces

A Voronoi cell is the body clipped by one bisector plane per other site. Pieces get a flagged **inner** cut face, which is where the interior material goes.

| Site layout | Look |
|---|---|
| Uniform random | Even rubble |
| Clustered at the impact: `p = hit + dir * R * u^2` | Fine fragments at the hit, big slabs far away. Best default |
| Scaled anisotropically (stretch sites on one axis) | Planks, glass shards, stone strata |
| Two levels: coarse pieces, re-fracture one on a second hit | Progressive damage, more code |

The sample fractures **convex** bodies. A concave body must be decomposed into convex parts first (offline, verify the tool), then each part fractured. Sites outside the body are fine, empty cells are dropped.

## 3. Verified sample

Pure JS, plus the Rapier glue. Run in Node 22 with `@dimforge/rapier3d-compat` 0.21.0 and three 0.187.0 (section 9). Results for a 2 x 1 x 0.4 box: 8, 40 and 150 sites gave 8, 40 and 150 pieces whose volumes summed to 0.800000 (the box), matched a brute force clip with no early out to 4e-8, had 0 convexity violations and every site inside its piece, took 4.5, 20 and 58 ms, and made 148, 1128 and 5305 triangles (about 35 per piece). In Rapier a 60 piece wall had 0 null hulls, a 0.15 m steel ball at 18 m/s fired contact force events, the first break came at step 9, 14 pieces became bodies, all 14 went to sleep, none fell through the ground.

```js
const EPS = 1e-6;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A convex polyhedron is an array of faces { pts: [[x,y,z],...] (CCW from outside), inner: bool }. */
export function boxPolyhedron([sx, sy, sz]) {
  const [x, y, z] = [sx / 2, sy / 2, sz / 2], v = (a, b, c) => [a * x, b * y, c * z];
  const quad = (...p) => ({ pts: p, inner: false });
  return [quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)), quad(v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1), v(-1, -1, -1)),
    quad(v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1)), quad(v(-1, -1, 1), v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1)),
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)), quad(v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1))];
}

/** Keep the half space dot(n, x) <= d. The cut face is added with inner = true (use the interior material). */
export function clip(faces, n, d) {
  const out = [], cap = [];
  for (const f of faces) {
    const poly = [];
    for (let i = 0; i < f.pts.length; i++) {
      const a = f.pts[i], b = f.pts[(i + 1) % f.pts.length], da = dot(n, a) - d, db = dot(n, b) - d, ina = da <= EPS, inb = db <= EPS;
      if (ina) poly.push(a);
      if (ina !== inb) { const t = da / (da - db), p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]; poly.push(p); cap.push(p); }
      else if (ina && Math.abs(da) <= EPS) cap.push(a);
    }
    const clean = poly.filter((p, i) => Math.hypot(...sub(p, poly[(i + 1) % poly.length])) > EPS);
    if (clean.length >= 3) out.push({ pts: clean, inner: f.inner });
  }
  const uniq = []; for (const p of cap) if (!uniq.some((q) => Math.hypot(...sub(p, q)) < 1e-5)) uniq.push(p);
  if (uniq.length >= 3) {
    const c = uniq.reduce((s, p) => [s[0] + p[0] / uniq.length, s[1] + p[1] / uniq.length, s[2] + p[2] / uniq.length], [0, 0, 0]);
    const u = norm(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(n, u);       // u x w = n, so ascending angle is CCW seen from +n
    uniq.sort((p, q) => Math.atan2(dot(sub(p, c), w), dot(sub(p, c), u)) - Math.atan2(dot(sub(q, c), w), dot(sub(q, c), u)));
    out.push({ pts: uniq, inner: true });
  }
  return out;
}

/** Voronoi cell of sites[i] inside a convex polyhedron: clip by the bisector plane against every other site, nearest first. */
export function voronoiCell(body, sites, i) {
  const s = sites[i]; let cell = body, radius = Infinity;
  const order = sites.map((p, j) => [j, Math.hypot(...sub(p, s))]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]);
  for (const [j, dist] of order) {
    if (dist / 2 > radius) break;                                  // all remaining bisectors are beyond the cell
    const n = norm(sub(sites[j], s));
    cell = clip(cell, n, dot(n, [(s[0] + sites[j][0]) / 2, (s[1] + sites[j][1]) / 2, (s[2] + sites[j][2]) / 2]));
    if (cell.length < 4) return null;
    radius = Math.max(...cell.flatMap((f) => f.pts.map((p) => Math.hypot(...sub(p, s)))));
  }
  return cell;
}

/** Volume and centroid by the divergence theorem (fan triangulation of each face). */
export function measure(cell) {
  let vol = 0, c = [0, 0, 0];
  for (const f of cell) for (let k = 1; k < f.pts.length - 1; k++) {
    const a = f.pts[0], b = f.pts[k], d = f.pts[k + 1], v = dot(a, cross(b, d)) / 6; vol += v;
    for (let q = 0; q < 3; q++) c[q] += (v * (a[q] + b[q] + d[q])) / 4;
  }
  return { volume: vol, centroid: c.map((x) => x / vol) };
}

/** Fracture a convex body into one piece per site. Each piece is re-centred on its centroid (the body pivot). */
export function fracture(body, sites) {
  const pieces = [];
  sites.forEach((_, i) => {
    const cell = voronoiCell(body, sites, i); if (!cell) return;
    const { volume, centroid } = measure(cell); if (volume < 1e-9) return;
    const faces = cell.map((f) => ({ pts: f.pts.map((p) => sub(p, centroid)), inner: f.inner }));
    const uniq = [...new Set(faces.flatMap((f) => f.pts.map((p) => p.map((v) => v.toFixed(5)).join(","))))];
    const hull = Float32Array.from(uniq.flatMap((k) => k.split(",").map(Number)));      // convex hull input for Rapier
    pieces.push({ site: i, volume, centroid, faces, hull });
  });
  return pieces;
}

/** Flat shaded geometry data with two groups: 0 = outer surface, 1 = inner (cut) faces, ready for a 2 material mesh. */
export function pieceBuffers(piece) {
  const pos = [], nor = [], uv = [], groups = [[], []];
  for (const f of piece.faces) {
    const n = norm(cross(sub(f.pts[1], f.pts[0]), sub(f.pts[2], f.pts[0]))), g = f.inner ? 1 : 0;
    for (let k = 1; k < f.pts.length - 1; k++) {
      groups[g].push(pos.length / 3, pos.length / 3 + 1, pos.length / 3 + 2);
      for (const p of [f.pts[0], f.pts[k], f.pts[k + 1]]) { pos.push(...p); nor.push(...n); uv.push(p[0] + p[2], p[1] + p[2]); }
    }
  }
  const index = [...groups[0], ...groups[1]];
  return { position: new Float32Array(pos), normal: new Float32Array(nor), uv: new Float32Array(uv), index: new Uint32Array(index),
    groups: [{ start: 0, count: groups[0].length, materialIndex: 0 }, { start: groups[0].length, count: groups[1].length, materialIndex: 1 }] };
}
```

```js
/** Intact object = ONE fixed body holding one convex collider per piece (cheap, rock solid). A strong contact turns the
 *  pieces near the hit into dynamic bodies. `pieces` come from fracture(). `at` is the object's world position. */
export function createDestructible(RAPIER, world, pieces, at, { threshold = 2000, density = 2400, radius = 0.45, kick = 0.3 } = {}) {
  const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z));
  const live = new Map(), debris = [];                              // collider handle -> { piece, collider }
  for (const piece of pieces) {
    const desc = RAPIER.ColliderDesc.convexHull(piece.hull);
    if (!desc) continue;                                            // degenerate sliver: drop it
    desc.setTranslation(...piece.centroid).setDensity(density).setFriction(0.7)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(threshold);
    const collider = world.createCollider(desc, wall); live.set(collider.handle, { piece, collider });
  }
  /** Call right after world.step(eventQueue). Returns the pieces that broke this frame (spawn sparks and decals there). */
  function update(eventQueue) {
    const broken = [];
    eventQueue.drainContactForceEvents((ev) => {
      const [a, b] = [ev.collider1(), ev.collider2()], other = live.has(a) ? b : live.has(b) ? a : null;
      const body = other === null ? null : world.getCollider(other).parent();
      if (!body) return;                                            // ground or another intact piece: not an impact
      const hit = body.translation(), v = body.linvel();
      for (const [handle, { piece, collider }] of [...live]) {
        const p = { x: at.x + piece.centroid[0], y: at.y + piece.centroid[1], z: at.z + piece.centroid[2] };
        if (Math.hypot(p.x - hit.x, p.y - hit.y, p.z - hit.z) > radius) continue;
        world.removeCollider(collider, false); live.delete(handle);
        const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v.x * kick, v.y * kick, v.z * kick));
        world.createCollider(RAPIER.ColliderDesc.convexHull(piece.hull).setDensity(density).setFriction(0.7).setRestitution(0.1), rb);
        debris.push(rb); broken.push({ piece, point: p, body: rb, force: ev.totalForceMagnitude() });
      }
    });
    return broken;
  }
  return { update, debris, live, wall };
}
```

Usage:

```js
const body = boxPolyhedron([2, 1, 0.3]);
const pieces = fracture(body, sites);                      // at load
const wall = createDestructible(RAPIER, world, pieces, { x: 0, y: 0.5, z: 0 }, { threshold: 2000, radius: 0.45 });
// fixed loop:  world.step(eventQueue);  for (const hit of wall.update(eventQueue)) spawnFx(hit);
// per frame: copy wall.debris[i].translation() and rotation() into the matching mesh (registry, physics-rigidbody section 2)
```

Create the `EventQueue` with `new RAPIER.EventQueue(true)` and `free()` it on teardown. `update` does not exclude debris, so a debris body hitting a live piece above the threshold breaks pieces too (chain breaks). Raise `threshold` or use collision groups (`physics-rigidbody` section 7) if that is unwanted.

## 4. Meshes and interior faces

- `pieceBuffers(piece)` returns flat shaded buffers and two groups: 0 outer, 1 inner. Build `new THREE.BufferGeometry()`, set `position`, `normal`, `uv`, the index, then `addGroup(start, count, materialIndex)` per group, and render with `[outerMaterial, innerMaterial]`.
- Origin at the piece centroid, so mesh pivot equals body origin (`physics-rigidbody` section 2). `fracture` already re-centres.
- Inner material: rougher, darker, exposed core (concrete grey, wood pale, glass with transmission off, `pbr-lookdev`). Break the match with the outer skin so the cut reads. The sample's `uv` is a placeholder planar projection, use a triplanar sample in the shader for the inner material (`shader-craft`).
- **Draw calls**: 150 separate meshes is 150 calls. Draw the intact object as one merged mesh, swap to per-piece meshes (or `BatchedMesh`, `performance-budget` section 2) only when it breaks. Share the two materials across all pieces.

## 5. Physics wiring (Rapier)

| Item | Rule |
|---|---|
| Collider | `ColliderDesc.convexHull(Float32Array)` per piece, returns `null` for degenerate input, skip those pieces (`createDestructible` does). Hull points are relative to the piece centroid |
| Intact state | One **fixed** body with one collider per piece (compound). Cheap and rock solid, no joints, no jitter |
| Break trigger | `ActiveEvents.CONTACT_FORCE_EVENTS` plus `setContactForceEventThreshold(T)` on the piece colliders. Threshold 2000 broke a wall hit by a 0.15 m steel ball at 18 m/s (max observed 31690). Scale it for your masses and speeds (guess), higher is tougher |
| Break | `world.removeCollider`, create a dynamic body with the same hull at the piece position, inherit a fraction of the hitter's velocity (`kick`, 0.3 in the sample) |
| Break radius | Everything within `radius` of the hitter breaks. Bigger radius means bigger holes and more bodies |
| Breakable joints | `JointData.fixed` between neighbours is possible. The JS joint API read here shows no impulse readout (verify), so break by relative displacement or use the compound approach |
| Support | Pieces left in the fixed body never fall, so a hanging chunk floats. Fix: flood fill from anchored pieces over a neighbour graph and release the rest. The sample does not output adjacency, add the clipping site id to each inner face to get it (not run here) |

CCD (`physics-rigidbody` section 6) on projectiles only, never on shards. Thin shards tunnel: drop or merge pieces with a tiny volume, and keep sites at least a few cm apart at metre scale.

## 6. Debris lifetime and sleeping

- Debris sleeps by default (verified: 14 of 14 asleep). Do not wake it every frame.
- Lifetime policy: when a piece has slept for 2 to 5 seconds (guess), shrink it over 0.5 s, then `world.removeRigidBody`, drop the registry entry and dispose geometry (`performance-budget` section 6).
- Cap live debris per tier (section 7). Over the cap, retire the oldest sleeping piece first, then the smallest.
- Small pieces (a tenth of the mean volume): turn into instanced particles with no collision (`particle-system-architecture`), or collide with the ground only (collision groups).
- Debris against debris is the expensive pair. Disable it for small pieces.

## 7. Piece budgets per tier

Measured: 60 piece wall plus 14 debris, `world.step` plus event handling averaged 0.40 ms per step (Node 22, desktop CPU, 360 steps including the whole fall and settling). Rows are guesses, measure on the device.

| Tier | Pieces per object | Live dynamic debris | Notes |
|---|---|---|---|
| Low (phones, iGPU) | 10 to 20, or the fake swap | 30 | One breakable at a time, no inner texture variety |
| Mid (laptops) | 30 to 60 | 100 | Merge the intact mesh, per-piece after break |
| High (desktop dGPU) | 100 to 150 | 300 | `BatchedMesh` for debris |

Triangles are cheap (about 35 per piece, flat shaded), bodies and draw calls are the budget. Cut in this order: fewer pieces, fake swap, retire debris sooner, small pieces to particles, no debris to debris contact.

## 8. Effect hooks

`update()` returns `{ piece, point, body, force }` per piece that broke. Use it as the hook:
- Sparks, dust puff, decal scar on the remaining wall at `point`: `vfx-impact-sparks-decals`. Scale intensity by `force`.
- Large breaks: smoke and fireball sprites from `vfx-fire-smoke-explosion`. Camera shake: `cinematic-camera-rig`.
- Throttle: at most a few effect spawns per frame, one effect per cluster of pieces, not one per piece.
- Sound and score events read the same list.

## 9. Symptoms and verify

| Symptom | Cause | Fix |
|---|---|---|
| Frame spike on break | Hulls and geometry built at hit time | Build at load, spawn bodies in batches over 2 to 3 frames |
| Pieces explode outward on spawn | Hulls overlap or touch exactly | Shrink hulls about 1% (guess), spawn from the compound pose |
| Pieces tunnel through the floor | Thin shards, fast | Drop slivers, thicker floor, CCD only on big pieces |
| Floating chunk | Fixed compound keeps orphans | Support flood fill (section 5) |
| Nothing breaks | Threshold too high, events not enabled on both sides | Lower `threshold`, set active events on the hitter too (sample ball does) |
| Everything breaks | Threshold too low, debris chain reaction | Raise it, collision groups for debris |
| Inner faces look pasted | Planar UV placeholder | Triplanar inner material |

Verify:
1. Numeric: pieces' volumes sum to the body, no null hulls, force events fire, debris finite and asleep after the fall, nothing below the floor.
2. `render-qa` at three simulated times (`physics-rigidbody` section 12): intact, mid break, settled. Check interior faces from a grazing angle.
3. Report pieces, live bodies, draw calls and step time next to the tier row.

Not verified, check before relying on them: concave decomposition, joint based breaking, the support flood fill, `BatchedMesh` swap, `ConvexObjectBreaker`, all phone numbers, break thresholds for other masses and speeds.
