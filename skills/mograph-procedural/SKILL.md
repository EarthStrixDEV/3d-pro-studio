---
name: mograph-procedural
description: Reproduce Cinema 4D MoGraph style procedural motion graphics in Three.js. Maps Cloner (grid, linear, radial, object surface), Effectors (Random, Plain, Step, Delay, Shader, Time) and Fields (spherical, linear, noise) to InstancedMesh with per-instance functions, plus Fracture and Voronoi, Tracer and spline following, MoText and extruded text, and the hand-off to rigid-body physics. Covers CPU versus GPU updates (instance attributes, onBeforeCompile, TSL, data textures), per-instance colour, seeded hash randomness, staggered easing, matrix update cost, bounding spheres and frame-rate-independent timing. Use when asked for MoGraph, cloner, effector or field behaviour, grids or swarms of animated instances, staggered or wave animation across many objects, or when porting a Cinema 4D motion graphics setup. Thai triggers โมชั่นกราฟิก, โคลนเนอร์, เอฟเฟกเตอร์, อนิเมชันโปรซีเดอรัล, ทำ MoGraph, ก้อนเยอะๆ ขยับเป็นคลื่น.
argument-hint: "<the C4D setup or motion to reproduce, and the instance count>"
---

# MoGraph Procedural

MoGraph is three ideas: **clone** (make N copies), **effect** (change each copy by a rule), **weight** (scale that change by a field). In Three.js a clone is an instance index, an effector is a function of `(i, base, t)`, a field is a function of `(position, t)` returning 0 to 1. Everything else is bookkeeping.

## 1. Concept map

| Cinema 4D | Three.js | Section |
|---|---|---|
| Cloner (Grid, Linear, Radial, Object) | `InstancedMesh` plus a layout function writing base positions | 2 |
| Effector (Random, Plain, Step, Delay, Shader, Time) | Per-instance delta function, blended by a weight | 3 |
| Field (Spherical, Linear, Noise, combined) | Falloff evaluated per instance on the base position | 4 |
| Fracture, Voronoi Fracture | Precomputed shards from the DCC, or `ConvexObjectBreaker`, then effector-driven shard motion | 9 |
| Tracer, Spline Wrap, spline Cloner | `CatmullRomCurve3` sampling, ring-buffer line | 10 |
| MoText, extruded text | `FontLoader` plus `TextGeometry`, one mesh per glyph | 11 |
| Dynamics body tag | Hand-off to `physics-rigidbody` | 12 |

## 2. Cloner modes

Write base positions once into a `Float32Array`. Never recompute a static layout per frame.

| Mode | Base position for index `i` | Notes |
|---|---|---|
| Grid | `(ix - (nx-1)/2) * spacing` per axis, `i = ix*ny*nz + iy*nz + iz` | Centre it, so rotating the group spins about the middle |
| Linear | `start + step * i` | Add `step * i` rotation and scale for a fan or spiral |
| Radial | `a = i / n * 2π`, `(cos a * r, 0, sin a * r)` | Orient with `q.setFromAxisAngle(UP, -a)` |
| Object (surface) | `MeshSurfaceSampler.sample(position, normal)` | Orient with `q.setFromUnitVectors(UP, normal)`; seed it, see below |
| Object (vertices) | Read `geometry.attributes.position` | One clone per vertex, so decimate first |

```js
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
const sampler = new MeshSurfaceSampler(source).setRandomGenerator(() => hash01(k++, seed)).build();
sampler.sample(p, n);   // local space of the source geometry, apply source.matrixWorld yourself
```

`MeshSurfaceSampler` defaults to `Math.random`, so an unseeded surface Cloner reshuffles on every reload. Always call `setRandomGenerator` with the hash from section 5.

## 3. Effectors

Every effector returns a **delta**. Accumulate deltas from all effectors, then compose the matrix once: position adds, scale multiplies, rotation multiplies quaternions, colour lerps. Final value is `base + delta * strength * fieldWeight`.

| Effector | Per-instance function | Notes |
|---|---|---|
| Random | `(hash01(i, salt) * 2 - 1) * range` | One salt per channel (x, y, z, scale, hue), or channels correlate |
| Plain | `constant` | Needs a field to be interesting |
| Step | `lerp(a, b, ease(i / (n - 1)))` | For a grid, use the normalised axis coordinate instead of the flat index |
| Delay | `state[i] = damp(state[i], target, lambda, dt)` | Needs a per-instance state array. Springs for overshoot: `motion-choreography` |
| Shader | `amount * sample(texture or noise, base)` | CPU: read an `ImageData` once and sample it. GPU: vertex-stage texture fetch or noise at the instance origin |
| Time | `ease(clamp((t - i * stagger) / dur, 0, 1))` | Whole timeline length is `(n - 1) * stagger + dur`, loop on that |

Rules:
- **Evaluate fields on the base position**, not the displaced one. Feeding the displaced position back creates jitter and lag.
- **Stagger by a meaningful key**, not just the flat index: axis coordinate, distance from a point, or a noise value. Flat-index stagger on a grid sweeps row by row and looks mechanical.
- **Clamp scale** away from zero (`Math.max(0.05, k)`). Zero or negative scale gives singular normals and inverted faces.

## 4. Fields

All fields return a weight in 0 to 1. `smoothstep(x, min, max)` from `THREE.MathUtils` returns 0 at or below `min`, 1 at or above `max`.

| Field | Weight | Notes |
|---|---|---|
| Spherical | `1 - smoothstep(dist, inner * radius, radius)` | `inner` is the fully-affected core. Move `center` with time for a sweep |
| Linear | `smoothstep(dot(p - origin, axis), 0, length)` | `axis` must be normalised. Swap the bounds to flip direction |
| Noise | `noise(p * freq + offset * t) * 0.5 + 0.5`, then clamp | CPU: `ImprovedNoise` or `SimplexNoise` from `three/addons/math/`. GPU: `snoise` from `shader-craft` snippets |
| Combine | Multiply = intersect, `max` = union, `1 - w` = invert | Remap with `smoothstep(w, lo, hi)` for contrast |

`ImprovedNoise.noise(x, y, z)` returns 0 on integer lattice points, so scale and offset the input or a whole grid of integer coordinates reads flat.

## 5. Randomness, easing, timing

- **Never `Math.random()` in the loop.** Draw once per instance at build time and cache, or hash on the fly.
- **Hash by `(index, salt)`, not by sequence.** `THREE.MathUtils.seededRandom` is a stateful sequence, so adding or removing one instance reshuffles everything after it. A hash keeps instance 17 identical at any count and any frame.
- **Time comes from the timestamp**, never from a per-frame increment. Clamp `dt` to `1/20` so a backgrounded tab does not teleport the field.
- **Use `renderer.setAnimationLoop((ms) => ...)`** for `t` and `dt`. `THREE.Clock` is deprecated since r183 (verified in r187 source). `THREE.Timer` exists as its replacement.
- **Follow motions use `damp`** (`MathUtils.damp(x, y, lambda, dt)`), which is frame-rate independent. A fixed `lerp(x, y, 0.1)` per frame is not.
- **Easing and stagger**: ease the local progress, not the global time. Easing vocabulary and durations are in `motion-choreography`.
- **Colour**: `setColorAt` takes linear values. `new THREE.Color('#ff6a2b')` converts from sRGB for you. `setHSL` defaults to the working (linear) space, so pass `THREE.SRGBColorSpace` as the fourth argument when you picked the HSL by eye. Lerp colours in linear space. The instance colour multiplies `material.color`, so keep `material.color` white unless you want a tint.

```js
function hash01(i, salt = 0) {                       // stable, order independent, in [0, 1)
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
```

## 6. Sample: grid Cloner, Random Effector, spherical Field

Drives position, scale and colour. Field weight is smoothed per instance (Delay behaviour), randoms are cached, temporaries are reused, bounds are refreshed.

Put `hash01` from section 5 in the same module. Verified on three r187: Node harness (determinism, instance count, far instances untouched, near instances changed, bounding sphere contains every instance, 60 fps vs 240 fps state within 0.02) and a headless `render-qa` run with zero blocking issues and zero warnings.

```js
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
const { damp, smoothstep } = THREE.MathUtils;

export function createGridCloner({
  counts = [24, 1, 24], spacing = 0.5, size = 0.34, seed = 1,
  baseColor = '#2b3a55', effectorColor = '#ff6a2b',
} = {}) {
  const [nx, ny, nz] = counts;
  const count = nx * ny * nz;

  // Cloner: grid mode, centred on the origin.
  const base = new Float32Array(count * 3);
  for (let i = 0, ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) for (let iz = 0; iz < nz; iz++, i++) {
    base.set([(ix - (nx - 1) / 2) * spacing, (iy - (ny - 1) / 2) * spacing, (iz - (nz - 1) / 2) * spacing], i * 3);
  }

  // Random Effector: drawn once per index and cached.
  const rnd = new Float32Array(count * 4);   // xyz in [-1, 1] for position, w in [0, 1] for scale
  const eff = new Float32Array(count * 3);   // per-instance effector colour (linear)
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    rnd[i * 4] = hash01(i, seed) * 2 - 1;
    rnd[i * 4 + 1] = hash01(i, seed + 101) * 2 - 1;
    rnd[i * 4 + 2] = hash01(i, seed + 202) * 2 - 1;
    rnd[i * 4 + 3] = hash01(i, seed + 303);
    c.set(effectorColor).offsetHSL((hash01(i, seed + 404) - 0.5) * 0.12, 0, (hash01(i, seed + 505) - 0.5) * 0.2);
    eff.set([c.r, c.g, c.b], i * 3);
  }
  const effector = { position: new THREE.Vector3(0.12, 0.7, 0.12), scale: [-0.5, 1.4] };

  // Spherical Field: weight 1 inside inner * radius, smooth falloff to 0 at radius.
  const field = { center: new THREE.Vector3(), radius: 2.6, inner: 0.25, orbit: 3 };

  const mesh = new THREE.InstancedMesh(
    new RoundedBoxGeometry(size, size, size, 2, size * 0.15),
    new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
    count,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const weight = new Float32Array(count);   // smoothed field weight per instance (Delay state)
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const col = new THREE.Color(), cBase = new THREE.Color(baseColor), cEff = new THREE.Color();

  function update(t, dt) {
    field.center.set(Math.sin(t * 0.7) * field.orbit, 0, Math.cos(t * 0.5) * field.orbit);
    const inner = field.radius * field.inner;
    for (let i = 0; i < count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      const d = Math.hypot(bx - field.center.x, by - field.center.y, bz - field.center.z);
      const target = 1 - smoothstep(d, inner, field.radius);
      const w = (weight[i] = damp(weight[i], target, 6, dt));   // frame-rate independent glide

      p.set(
        bx + rnd[i * 4] * effector.position.x * w,
        by + rnd[i * 4 + 1] * effector.position.y * w,
        bz + rnd[i * 4 + 2] * effector.position.z * w,
      );
      const k = Math.max(0.05, 1 + THREE.MathUtils.lerp(effector.scale[0], effector.scale[1], rnd[i * 4 + 3]) * w);
      s.setScalar(k);
      mesh.setMatrixAt(i, m.compose(p, q, s));

      cEff.setRGB(eff[i * 3], eff[i * 3 + 1], eff[i * 3 + 2]);
      mesh.setColorAt(i, col.copy(cBase).lerp(cEff, w));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();   // O(N); keeps culling and raycast correct after the moves
  }

  function dispose() { mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); }
  return { mesh, field, update, dispose, count };
}
```

Use it:

```js
const cloner = createGridCloner();
scene.add(cloner.mesh);
let last = 0;
renderer.setAnimationLoop((ms) => {
  const t = ms / 1000, dt = Math.min(t - last, 1 / 20); last = t;
  cloner.update(t, dt);
  renderer.render(scene, camera);
});
```

Notes on the result: at full field weight a clone scales to 2.4x and the grid spacing is 0.5 for a 0.34 box, so neighbours intersect inside the field. That reads as intentional MoGraph density. Cap the scale range at `spacing / size - 1` if clones must never touch.

## 7. CPU versus GPU

| Path | Use when | Constraints |
|---|---|---|
| CPU loop, `setMatrixAt` | Up to roughly 10k clones (guess, profile it), or you need physics, picking, readback, or many effectors | O(N) JavaScript per frame plus an upload |
| GPU: instance attribute plus `onBeforeCompile` | Large N, effectors are pure functions of index, base position and time | No readback. CPU bounding sphere goes stale. Shadows need a matching depth material |
| Data texture | Per-instance values computed on the CPU or baked timelines (several floats per clone) | `DataTexture` with `FloatType` and `NearestFilter`, fetch with `texelFetch` at `gl_InstanceID`. Set `needsUpdate` on change (verify, untested here) |
| TSL compute (WebGPU) | WebGPU renderer, simulation state on the GPU | `instanceIndex`, `instancedArray`, `hash` exist in r187 source. Usage untested here, names move between releases (verify) |

GPU variant of the section 6 look, static grid matrices on the CPU, effector and field in the vertex shader (verified: compiles and renders on r187, same field sweep, no console errors):

```js
const uniforms = { uCenter: { value: new THREE.Vector3() }, uRadius: { value: 2.6 } };
geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));   // seeds[i] = hash01(i)
material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uCenter;\nuniform float uRadius;\nattribute float aSeed;\nvarying float vW;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      float w = 1.0 - smoothstep(uRadius * 0.25, uRadius, distance(instanceMatrix[3].xyz, uCenter));
      vW = w;
      transformed *= 1.0 + (aSeed * 1.9 - 0.5) * w;
      transformed.y += aSeed * 0.7 * w;`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vW;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.14, 0.02), vW);');
};
material.customProgramCacheKey = () => 'mograph-gpu-v1';
mesh.frustumCulled = false;       // the CPU bounding sphere does not know the shader moved the clones
// per frame: uniforms.uCenter.value.set(...)  (one uniform write instead of N matrix writes)
```

Rules:
- `instanceMatrix[3].xyz` is the clone origin. Evaluate the field there, so the whole clone shares one weight.
- Patch `begin_vertex`, which runs before the instance matrix, so the offset and scale happen in clone-local space.
- Moved geometry casts the old shadow unless `mesh.customDepthMaterial` carries the same patch (pattern in `shader-craft`).
- Anchor on chunk names, add `customProgramCacheKey`, and keep the shared patch rules in `shader-craft`, not here.
- Per-clone randoms on the GPU still come from the seeded hash: bake `aSeed` on the CPU, or port the hash to GLSL with integer ops.

## 8. Update cost

- Upload per frame is `N * 64` bytes for matrices plus `N * 12` for colours. 10,000 clones is 640 KB plus 120 KB (arithmetic, the JavaScript loop usually costs more than the upload).
- `instanceMatrix.setUsage(THREE.DynamicDrawUsage)` for anything that moves every frame.
- Partial upload when only a slice changes: `attr.clearUpdateRanges(); attr.addUpdateRange(i0 * 16, (i1 - i0) * 16)`. Offsets are in array components, not instances (verified in source, behaviour untested here, verify).
- Sleep still clones: when weight and target are both near zero, skip compose and `setMatrixAt` for that index. The matrix keeps its last value.
- One `setMatrixAt` per clone per frame. Reuse `Matrix4`, `Vector3`, `Quaternion`, `Color` temporaries, never allocate in the loop.
- **`computeBoundingSphere()` after moves**, or frustum culling and raycasts use a stale sphere and clones vanish at screen edges. It is O(N). If effector extents are bounded, compute it once and pad it: `mesh.computeBoundingSphere(); mesh.boundingSphere.radius += maxOffset;`. If the extent is unbounded, set `frustumCulled = false`.
- `InstancedMesh.raycast` tests every instance (verified in source). Above a few thousand clones, derive the index analytically from a ground-plane hit instead.
- Dispose: `mesh.dispose()` frees the instance buffers, then `geometry.dispose()` and `material.dispose()`.

## 9. Fracture and Voronoi

Three.js has no Voronoi fracture. Pick one:

| Method | Use when | Notes |
|---|---|---|
| Precompute in the DCC (Blender Cell Fracture, or C4D Voronoi Fracture exported) | Hero object, art-directed shards | Export one node per shard with the origin at its centroid, so scaling and rotating happens about the shard. Ship via `gltf-asset-pipeline` |
| `ConvexObjectBreaker` (`three/addons/misc/ConvexObjectBreaker.js`) | Runtime breaks of convex meshes | Methods `prepareBreakableObject`, `subdivideByImpact`, `cutByPlane` exist in r187 source. It mutates `userData` and creates new meshes. Untested here (verify) |
| Voronoi look in a shader | Only the look is needed, geometry stays whole | Cell noise in the fragment shader, no geometry cost |

Shard motion is an effector: delta = `normalize(centroid - impact) * strength * fieldWeight * ease(t)`, plus a random tumble from `hash01`. Shards have different geometries, so they cannot be one `InstancedMesh`. Under a few hundred, use separate meshes sharing one material. Beyond that, `BatchedMesh` (`addGeometry`, `addInstance`, exist in r187 source, see `performance-budget`).

## 10. Tracer and spline-following

- **Spline Cloner:** `u = (i / n + t * speed) % 1`, `curve.getPointAt(u, p)` (arc-length parameterised, so spacing is even). `getPoint` uses the raw curve parameter and bunches clones where control points are dense.
- **Orientation:** `curve.getTangentAt(u, tan)` then `q.setFromUnitVectors(UP, tan)` is degenerate when the tangent points opposite `UP`. For a twist-free frame, precompute `curve.computeFrenetFrames(segments, closed)` once (returns `tangents`, `normals`, `binormals`) and build the basis from those.
- Call `curve.updateArcLengths()` after editing control points, or `getPointAt` reads the cached lengths.
- **Tracer:** keep a ring buffer of the last M positions of a moving point in a `BufferAttribute`, update it every frame (`needsUpdate = true`), limit with `geometry.setDrawRange(0, filled)`. A plain `Line` is 1 px wide on most platforms. For width use `Line2` plus `LineGeometry.setPositions` from `three/addons/lines/` (exist in r187 source), or a `TubeGeometry` rebuilt at low rate for fat trails.
- Sample the tracer at fixed time steps (every 1/60 s of simulation time), not per rendered frame, so trail length does not depend on frame rate.

## 11. MoText

- `FontLoader` plus `TextGeometry` from `three/addons/`. Depth parameter is `depth` in r187 (verified). Older releases used `height` (verify the pinned revision). Set `bevelEnabled: true` with a small `bevelSize` as in `shader-craft`.
- **Per-glyph effectors need one mesh per character.** Build a `TextGeometry` per character and advance `x` by `glyph.ha * (size / data.resolution)` from the font JSON (the formula `FontLoader` uses internally, verified in source). It has no kerning, so tune tracking by eye. Reuse one geometry per distinct character and one shared material.
- A word is a few dozen meshes, so no instancing is needed. Drive each glyph with the section 3 effectors keyed on its index.
- Example fonts ship in the three.js GitHub repo under `examples/fonts/`, **not** in the npm package (verified: absent from the r187 tarball). Vendor the font file you use.
- Thai and other shaped scripts: typeface JSON fonts do no OpenType shaping, so stacked vowels and tone marks are unreliable (verify with your font). Extrude Thai text in Blender and import it, or use SDF text for flat lettering.

## 12. Dynamics

For falling, colliding or stacking clones, hand the clones to `physics-rigidbody`. Data flow stays one way per frame: layout gives initial transforms, the physics step runs, the body transforms are written into `setMatrixAt`. To blend effector motion with physics (C4D Dynamics with an Effector), lerp position and slerp rotation between the two poses by the field weight. This needs the CPU path, since the GPU path cannot read bodies.

## 13. Performance

Budget with `performance-budget`. The cost is **clones x triangles per clone x passes**, and a shadow-casting light adds a pass. Measured: 576 clones of a 300-triangle `RoundedBoxGeometry` (segments 2) with one shadow light reported 345.6k triangles, about twice the 172.8k of geometry, in 3 draw calls (clones, floor, clone shadow pass).

| Per-clone geometry | Triangles | Max clones, Low (300k) with shadows | Mid (800k) | High (1.5M) |
|---|---|---|---|---|
| `BoxGeometry` | 12 | 12,500 | 33,000 | 62,000 |
| `RoundedBoxGeometry`, segments 2 | 300 (measured) | 500 | 1,300 | 2,500 |
| `RoundedBoxGeometry`, segments 3 | 588 (measured) | 250 | 680 | 1,270 |

(`budget / (tris x 2 passes)`, rounded down. Without shadows the counts double.)

- **Spend triangles on silhouette.** Hundreds of clones can be low-poly. Use rounded geometry only for a hero cloner.
- **Scale the count by tier.** Read `tier` (the `render-qa` contract) and pass `counts` accordingly. Low tier: fewer clones, `castShadow = false`, GPU path.
- **One `InstancedMesh` is one draw call.** Several effector looks on one geometry still share a draw call if they share the material. Different materials split it.
- Profile the JavaScript loop before reaching for the GPU path. Past roughly 10k clones or a loop above ~4 ms (guess), move effectors to the shader.

## 14. Verify with render-qa

1. Make the scene deterministic for capture: read a `t` query (`--query "t=3"`) and call `update(t, 1/60)` several times instead of using the clock, so screenshots repeat.
2. Run `render-qa` at each tier: `--query "tier=low"` and `--query "tier=high"`. Check calls and triangles against section 13, no console errors, no shader compile errors from GPU patches.
3. Read the hero and an orbit shot. Look for: clones popping out at screen edges (stale bounding sphere), flat or inverted faces (scale near zero), z-fighting where clones touch, banding or crushed colour (colour space), fully saturated tint (colour added instead of lerped).
4. Determinism: two runs at the same `t` must be pixel-identical. A difference means `Math.random` or an unseeded sampler slipped in.
5. Frame-rate independence: step the same simulated time with `dt = 1/60` and `dt = 1/20` and compare a few instance matrices. Differences beyond a few percent mean a per-frame constant leaked in.
6. Max 3 fix loops, then report what remains. Scoring rubric and fix loop are in `render-qa`.
