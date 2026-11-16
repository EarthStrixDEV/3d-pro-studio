---
name: geometry-nodes-procedural
description: Blender Geometry Nodes concepts translated to a small typed, deterministic, cached pipeline in JavaScript that scatters and displaces point clouds into an InstancedMesh. Covers attributes, fields, Distribute Points on Faces (area-weighted, random and Poisson thinning), Instance on Points, Realize Instances, Set Position, noise displacement, Store Named Attribute, stable per-point identity so edits do not reshuffle, seeds, prefix caching, triangle budgets, a GPU option for animated displacement, and exporting Geometry Nodes results from Blender. Use when asked to scatter grass, rocks, trees or debris on a surface, to port a Geometry Nodes setup, to build a node-graph style procedural system, to make scattering repeatable, or when instance placement must stay identical across reloads and edits. Thai triggers โปรซีเดอรัล, Geometry Nodes, โปรยวัตถุบนพื้นผิว, กระจายต้นไม้, กระจายหิน, scatter, instance บนจุด, สุ่มแบบคงที่.
argument-hint: "<surface to scatter on, the instance geometry, count or density, and whether it animates>"
---

# Geometry Nodes Procedural

Geometry Nodes is data flow over geometry: points carry attributes, fields compute a value per element, nodes turn geometry into new geometry. Three.js has no such graph, so build a small one: plain-data steps, pure functions, a cache. Do not repeat what `modifier-stack-parametric` (ordered, re-evaluable modifiers over a mesh) and `mograph-procedural` (Cloner, Effector and Field over a fixed instance count, CPU and GPU update costs) already cover, link to them.

## 1. Concept map

| Geometry Nodes | Here | Note |
|---|---|---|
| Attribute (on point, face, corner) | `Points.attrs[name]`, one `Float32Array` per attribute | Position and normal are built in |
| Field | `ScalarField = (i, points) => number`, read when a node consumes it | Evaluated per point, lazily, no storage until `store` |
| Distribute Points on Faces, Random | `distribute` | Density in points per square unit, area weighted |
| Distribute Points on Faces, Poisson Disk | `poissonPrune` over a denser random set | Minimum distance, deterministic |
| Set Position | `noiseOffset` (along normal or free vector) | Returns new points |
| Noise Texture, White Noise, Random Value | `noiseField` (Simplex), `hash3` | Seeded, stable |
| Store Named Attribute, Capture Attribute | `store(points, name, field)` | Then read with `attribute(name)` |
| Instance on Points | `instanceMatrices` then `toInstancedMesh` | Align to normal, scale, rotate from hashes |
| Realize Instances | `realize` | One merged mesh, expensive, capped |
| Join Geometry | `mergeGeometries` from `BufferGeometryUtils` | |
| Mesh to Points, Points to Vertices | Read `position` attribute | |
| Geometry Proximity, Raycast, Sample Nearest Surface | Not provided. `three-mesh-bvh` offers closestPointToPoint and raycasts (verify the API of your version) | Slope or height masks are simple fields on `normal` and `position` |
| Group input (exposed parameters) | The step objects | Edit one value, only later steps re-run |

Blender node and socket names above are from memory of the editor, not machine-checked here.

## 2. Design rules

- **Steps are JSON.** `kind` discriminates, the compiler flags every `switch` that misses a new kind (`never` check). The JSON of the steps before a step is its cache key.
- **Pure functions.** Every node returns new `Points` and never mutates its input. Cached results stay valid and cache hits can be shared.
- **Stable identity.** Each point carries `face` and `slot` (the nth point inside its source face). All randomness is `hash3(face, slot, seed)`, never a sequence. Adding a face, changing the count elsewhere or pruning a neighbour does not move or recolour the points that remain. This is the single property that makes procedural scatter editable, the same idea as `hash01` in `mograph-procedural`.
- **Per-face counts, not a global draw.** A face of area `a` gets `floor(a x density)` points plus one more when a per-face hash is below the fractional part. Expected count equals `a x density` for any face size, including faces smaller than one point.
- **Seeds are data.** A seed is a field in the step, so two seeds are two cache entries.

## 3. Pipeline

Verified: `tsc --strict` clean on three r187, and a Node test run (below). Needs `three`, `three/addons/math/SimplexNoise.js` and `three/addons/utils/BufferGeometryUtils.js`.

```ts
import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Stateless hash of three integers to [0, 1). Same inputs, same value, on any machine, at any count. */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A point cloud with named attributes. `face` and `slot` are the stable identity of a point. */
export interface Points {
  count: number;
  position: Float32Array;   // xyz
  normal: Float32Array;     // xyz, unit
  face: Uint32Array;        // source face index
  slot: Uint32Array;        // nth point inside that face
  attrs: Record<string, Float32Array>;   // named scalar attributes, one value per point
}

/** A field is evaluated per point when a node reads it, like Blender's fields. */
export type ScalarField = (i: number, p: Points) => number;
export const attribute = (name: string): ScalarField => (i, p) => p.attrs[name][i];
export const noiseField = (scale: number, seed: number): ScalarField => {
  const n = new SimplexNoise(seededRandom(seed));   // SimplexNoise takes any object with random()
  return (i, p) => n.noise3d(p.position[i * 3] * scale, p.position[i * 3 + 1] * scale, p.position[i * 3 + 2] * scale);
};
function seededRandom(seed: number): { random: () => number } {
  let k = 0;
  return { random: () => hash3(k++, 0x51ed, seed) };
}

// Step data is plain JSON, so it can be diffed, saved and used as a cache key.
export interface DistributeStep { kind: 'distribute'; density: number; seed: number; maxPoints?: number }
export interface PoissonStep { kind: 'poisson'; minDistance: number }
export interface NoiseOffsetStep { kind: 'noiseOffset'; scale: number; amount: number; seed: number; alongNormal: boolean }
export interface StoreNoiseStep { kind: 'storeNoise'; name: string; scale: number; seed: number }
export type PointStep = DistributeStep | PoissonStep | NoiseOffsetStep | StoreNoiseStep;
export interface InstanceStep { scale: [number, number]; scaleNoise?: string; align: 'normal' | 'up'; yaw: boolean; seed: number }
```

```ts
/** Distribute Points on Faces, random mode. Count per face = density x area, with the fractional part decided by a per-face hash. */
export function distribute(geo: THREE.BufferGeometry, s: DistributeStep): Points {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), ix = geo.index;
  const faces = (ix ? ix.count : pos.count) / 3, cap = s.maxPoints ?? 1_000_000;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3();
  const P: number[] = [], N: number[] = [], F: number[] = [], S: number[] = [];
  const vi = (f: number, k: number) => (ix ? ix.getX(f * 3 + k) : f * 3 + k);
  for (let f = 0; f < faces; f++) {
    a.fromBufferAttribute(pos, vi(f, 0)); b.fromBufferAttribute(pos, vi(f, 1)); c.fromBufferAttribute(pos, vi(f, 2));
    const cross = n.subVectors(b, a).cross(t.subVectors(c, a)), area = cross.length() / 2;
    if (area < 1e-12) continue;
    cross.normalize();
    const expected = area * s.density, whole = Math.floor(expected);
    const count = whole + (hash3(f, 0xfffff, s.seed) < expected - whole ? 1 : 0);
    if (F.length + count > cap) throw new Error(`distribute would exceed maxPoints ${cap}, lower the density`);
    for (let j = 0; j < count; j++) {
      const r = Math.sqrt(hash3(f, j * 2 + 1, s.seed)), u = 1 - r, v = r * (1 - hash3(f, j * 2 + 2, s.seed)), w = 1 - u - v;   // uniform on a triangle
      P.push(a.x * u + b.x * v + c.x * w, a.y * u + b.y * v + c.y * w, a.z * u + b.z * v + c.z * w);
      if (nor) {   // smooth: interpolate the vertex normals
        const na = new THREE.Vector3().fromBufferAttribute(nor, vi(f, 0)), nb = new THREE.Vector3().fromBufferAttribute(nor, vi(f, 1)), nc = new THREE.Vector3().fromBufferAttribute(nor, vi(f, 2));
        na.multiplyScalar(u).addScaledVector(nb, v).addScaledVector(nc, w).normalize();
        N.push(na.x, na.y, na.z);
      } else N.push(cross.x, cross.y, cross.z);
      F.push(f); S.push(j);
    }
  }
  return { count: F.length, position: new Float32Array(P), normal: new Float32Array(N), face: new Uint32Array(F), slot: new Uint32Array(S), attrs: {} };
}

/** Poisson-disk style thinning: lowest face and slot wins, no two points closer than minDistance. Order is stable, so the result is deterministic. */
export function poissonPrune(p: Points, minDistance: number): Points {
  const cell = minDistance, grid = new Map<string, number[]>(), keep: number[] = [];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < p.count; i++) {
    const x = p.position[i * 3], y = p.position[i * 3 + 1], z = p.position[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let ok = true;
    for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dz = -1; dz <= 1 && ok; dz++) {
      for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
        if (Math.hypot(x - p.position[j * 3], y - p.position[j * 3 + 1], z - p.position[j * 3 + 2]) < minDistance) { ok = false; break; }
      }
    }
    if (!ok) continue;
    keep.push(i);
    const k = key(cx, cy, cz);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  return take(p, keep);
}

function take(p: Points, idx: number[]): Points {
  const pick = <T extends Float32Array | Uint32Array>(src: T, size: number): T => {
    const out = new (src.constructor as new (n: number) => T)(idx.length * size);
    idx.forEach((from, to) => { for (let k = 0; k < size; k++) out[to * size + k] = src[from * size + k]; });
    return out;
  };
  const attrs: Record<string, Float32Array> = {};
  for (const [name, arr] of Object.entries(p.attrs)) attrs[name] = pick(arr, 1);
  return { count: idx.length, position: pick(p.position, 3), normal: pick(p.normal, 3), face: pick(p.face, 1), slot: pick(p.slot, 1), attrs };
}

/** Set Position with a noise vector. Returns new points, never mutates the input. */
export function noiseOffset(p: Points, s: NoiseOffsetStep): Points {
  const nx = new SimplexNoise(seededRandom(s.seed)), ny = new SimplexNoise(seededRandom(s.seed + 1)), nz = new SimplexNoise(seededRandom(s.seed + 2));
  const position = new Float32Array(p.position);
  for (let i = 0; i < p.count; i++) {
    const x = p.position[i * 3] * s.scale, y = p.position[i * 3 + 1] * s.scale, z = p.position[i * 3 + 2] * s.scale;
    if (s.alongNormal) {
      const d = nx.noise3d(x, y, z) * s.amount;
      for (let k = 0; k < 3; k++) position[i * 3 + k] += p.normal[i * 3 + k] * d;
    } else {
      position[i * 3] += nx.noise3d(x, y, z) * s.amount;
      position[i * 3 + 1] += ny.noise3d(x, y, z) * s.amount;
      position[i * 3 + 2] += nz.noise3d(x, y, z) * s.amount;
    }
  }
  return { ...p, position };
}

/** Store Named Attribute from a scalar field. */
export function store(p: Points, name: string, field: ScalarField): Points {
  const a = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) a[i] = field(i, p);
  return { ...p, attrs: { ...p.attrs, [name]: a } };
}
```

```ts
function runStep(source: THREE.BufferGeometry, prev: Points | null, s: PointStep): Points {
  switch (s.kind) {
    case 'distribute': return distribute(source, s);
    case 'poisson': return poissonPrune(prev!, s.minDistance);
    case 'noiseOffset': return noiseOffset(prev!, s);
    case 'storeNoise': return store(prev!, s.name, noiseField(s.scale, s.seed));
    default: { const never: never = s; return never; }
  }
}

/** Caches every step by the JSON of all steps before it plus the source identity. Editing step k reruns k and later only. */
export class PointGraph {
  private cache = new Map<string, Points>();
  runs = 0;   // counts executed steps, for tests and profiling
  evaluate(source: THREE.BufferGeometry, steps: PointStep[]): Points {
    const position = source.getAttribute('position');
    const version = position instanceof THREE.InterleavedBufferAttribute ? position.data.version : position.version;   // bumps on needsUpdate
    let key = `${source.uuid}:${version}:${position.count}`, prev: Points | null = null;
    const live = new Set<string>();
    for (const s of steps) {
      key += '|' + JSON.stringify(s);
      live.add(key);
      let hit = this.cache.get(key);
      if (!hit) { hit = runStep(source, prev, s); this.cache.set(key, hit); this.runs++; }
      prev = hit;
    }
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);   // drop stale branches
    if (!prev) throw new Error('graph needs at least a distribute step');
    return prev;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Instance on Points: one matrix per point. Rotation and scale come from stable per-point hashes. */
export function instanceMatrices(p: Points, s: InstanceStep): Float32Array {
  const out = new Float32Array(p.count * 16), m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
  const pos = new THREE.Vector3(), sc = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const h = (salt: number) => hash3(p.face[i], p.slot[i] * 16 + salt, s.seed);
    const t = s.scaleNoise ? THREE.MathUtils.clamp(p.attrs[s.scaleNoise][i] * 0.5 + 0.5, 0, 1) : h(1);
    const k = Math.max(0.01, THREE.MathUtils.lerp(s.scale[0], s.scale[1], t));   // keep scale away from zero
    pos.fromArray(p.position, i * 3);
    if (s.align === 'normal') q.setFromUnitVectors(UP, nrm.fromArray(p.normal, i * 3)); else q.identity();
    if (s.yaw) q.multiply(qy.setFromAxisAngle(UP, h(2) * Math.PI * 2));
    m.compose(pos, q, sc.setScalar(k));
    m.toArray(out, i * 16);
  }
  return out;
}

/** Instances to a drawable. One InstancedMesh is one draw call. */
export function toInstancedMesh(matrices: Float32Array, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
  const count = matrices.length / 16, mesh = new THREE.InstancedMesh(geometry, material, count);
  (mesh.instanceMatrix.array as Float32Array).set(matrices);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();   // culling and raycast use it
  return mesh;
}

/** Realize Instances: one merged geometry. Refuses past maxTriangles, since this multiplies memory. */
export function realize(matrices: Float32Array, geometry: THREE.BufferGeometry, maxTriangles = 500_000): THREE.BufferGeometry {
  const per = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3, count = matrices.length / 16;
  if (per * count > maxTriangles) throw new Error(`realize would make ${per * count} triangles, over the cap ${maxTriangles}`);
  const m = new THREE.Matrix4(), parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) parts.push(geometry.clone().applyMatrix4(m.fromArray(matrices, i * 16)));
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  return merged;
}
```

Use (grass tufts on a terrain mesh whose geometry already has `normal`):

```ts
const graph = new PointGraph();
const steps: PointStep[] = [
  { kind: 'distribute', density: 30, seed: 7 },                                          // 30 points per square unit
  { kind: 'poisson', minDistance: 0.08 },                                                 // thin clumps
  { kind: 'noiseOffset', scale: 1.5, amount: 0.05, seed: 4, alongNormal: true },          // lift with noise
  { kind: 'storeNoise', name: 'patch', scale: 0.6, seed: 9 },                             // large-scale mask
];
const points = graph.evaluate(terrain.geometry, steps);
const mats = instanceMatrices(points, { scale: [0.6, 1.4], scaleNoise: 'patch', align: 'up', yaw: true, seed: 5 });
const grass = toInstancedMesh(mats, tuftGeometry, tuftMaterial);
terrain.add(grass);   // points are in the terrain's local space
```

Tested in Node (r187): on two triangles of area 1 and 3 at density 4000, face counts are 4000 and 12000 (ratio 3.000), the centroid of the sampled points matches the triangle centroid within 0.002, repeated runs are byte-identical, adding a third face leaves the first 16,000 positions unchanged, Poisson thinning keeps minimum distance at or above 0.05, editing step 2 of 4 re-ran only 2 steps (the other cached), the source geometry is not mutated, an instance's up axis matches the point normal within 1e-5, `realize` refuses past its triangle cap. Not run: a browser render of the result.

## 4. Rules for each node

- **Normals:** `distribute` uses the vertex `normal` attribute when present (smooth) and the face normal otherwise. Run `computeVertexNormals()` before sampling a mesh that has none, or instances on a curved terrain will all stand straight up.
- **Local space:** points are in the source mesh's local space. Add the instanced mesh as a child of the source, or apply `source.matrixWorld`. Non-uniform scale on the parent skews normals.
- **Orientation:** `align: 'normal'` uses `setFromUnitVectors(UP, normal)`, which is arbitrary around the normal. Keep `yaw: true` to randomise that, or the roll differs per slope.
- **Weights:** to mask density by a vertex attribute (Blender Density Factor) multiply `expected` by the interpolated attribute inside `distribute`, or use `MeshSurfaceSampler.setWeightAttribute(name)` for a one-off and pass its `setRandomGenerator` a hash (see `mograph-procedural` section 2). Its weights are per face from the vertex sum times area. This pipeline does the same thing with stable identity.
- **Poisson cost:** the grid is O(points) but the prune is order dependent: a lower face index wins. Over-sample by about 2 to 3 times the target, then prune (guess, tune to the density you see).
- **Large counts:** `distribute` throws past `maxPoints`. A density that is right for a 1 m patch can mean millions on a 1 km terrain: scatter per chunk (tile the source mesh) and build one `InstancedMesh` per chunk so culling still helps (`performance-budget`).
- **Instance variants (Pick Instance):** `InstancedMesh` holds one geometry. Group points by `Math.floor(hash3(face, slot, seed) * variants)` and make one `InstancedMesh` per variant, or use `BatchedMesh` (`performance-budget`).
- **Realize only when instancing cannot work:** a physics collider, a boolean, or an exporter without instancing. It copies the geometry per instance.

## 5. Caching and determinism checklist

- Key = source uuid + position attribute `version` + vertex count + the JSON of all steps up to that step. A deformed or edited source changes `version` when you set `needsUpdate = true`. Instance matrices are cheap to rebuild (they are not cached), so changing `scale`, `yaw` or the material does not re-run the points.
- The cache drops entries that are not part of the current step chain, so memory stays at one chain. If you A/B two configurations, give each its own `PointGraph`.
- Dispose: `mesh.dispose()` for the instance buffers, then `geometry.dispose()` for a realized mesh. The point arrays are plain typed arrays and collect.
- Same seed, same output on any machine: `hash3` uses `Math.imul` and 32-bit integers only. `Math.random` and `Date.now` appear nowhere. Floating point `Math.sqrt` and `Math.sin` rounding could differ between engines in the last digit, so snapshot tests compare with a tolerance.
- Frame-rate independence: the graph is static. Animation lives in the GPU option below or in a per-frame offset applied to the instance matrices (`mograph-procedural` section 3).

## 6. Budgets

An instanced scatter costs `instances x triangles per instance`, doubled by a shadow pass (measured in `mograph-procedural` section 13). Check against the tier table in `performance-budget`:

| Instance mesh | Triangles | Max instances Low (300k), shadows on | Mid (800k) | High (1.5M) |
|---|---|---|---|---|
| Grass tuft, 2 crossed quads | 4 | 37,500 | 100,000 | 187,500 |
| Cone of 6 sides (measured in the test, 12 per instance) | 12 | 12,500 | 33,000 | 62,500 |
| Rock, low poly | 60 | 2,500 | 6,600 | 12,500 |

Formula: `tier triangles / (triangles per instance x 2)`, rounded down. Without shadows the counts double. Scale the density with the device tier and cull by distance with chunks.

Realized geometry of the cone test: 198 instances gave 2,376 triangles, which is exactly 198 times 12.

## 7. GPU option

Distribution is a one-time cost and stays on the CPU: it feeds the matrices. What benefits from the GPU is per-frame work on thousands of instances, such as wind sway or an animated Set Position.

| Work | Where | Why |
|---|---|---|
| `distribute`, `poissonPrune`, `store`, matrices | CPU, once, cached | Needs the mesh, reads and branches |
| Animated noise displacement, sway, pulse | Vertex shader, a uniform for time | No per-frame matrix upload, no JS loop |
| Mask from a texture or height field | Vertex shader texture fetch at the instance origin | Resolution independent |
| Distribution itself on the GPU | TSL compute on WebGPU (`instanceIndex`, `instancedArray`, `hash` exist in r187 source, usage not tested here) (verify) | Only worth it past hundreds of thousands of points |

Sway at the instance origin, using `snoise(vec3)` from `shader-craft` (`references/glsl-snippets.md`). The pattern (`onBeforeCompile`, `begin_vertex`, `instanceMatrix[3].xyz`, `customProgramCacheKey`) is the one verified in `mograph-procedural` section 7, this variant was not run:

```js
const uTime = { value: 0 };
material.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uTime;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;\n' + SNOISE_GLSL)   // snoise(vec3) from shader-craft
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 origin = instanceMatrix[3].xyz;
      transformed.x += snoise(vec3(origin.xz * 0.8, uTime * 0.5)) * 0.06 * max(position.y, 0.0);`);
};
material.customProgramCacheKey = () => 'gn-sway-v1';
mesh.frustumCulled = false;   // CPU bounds do not know the shader moved the vertices, or pad boundingSphere.radius
// per frame: uTime.value = timestamp / 1000
```

Rules: the sway weight `position.y` keeps the base planted, so the instance geometry must start at y = 0. Moved geometry casts the old shadow unless `customDepthMaterial` carries the same patch (`shader-craft`). Normals are unchanged by this small displacement, accept it or recompute.

## 8. Blender Geometry Nodes to the web

Two routes. Choose per asset:

| Route | When | How |
|---|---|---|
| Recreate in code (this skill) | The scatter must regenerate on load, depend on a seed, density or tier, or exceed what a file should carry | Port node by node with the table in section 1. Blender's noise and random values differ from these, so the scatter looks alike but is not identical |
| Bake in Blender, export | Fixed art-directed result, hero set | Apply the modifier, export the mesh. Instances should be realized, or exported as GPU instances |

Exporter facts (read from the `io_scene_gltf2` source, main branch): `export_apply` (Apply Modifiers) is off by default and its description warns it prevents exporting shape keys. `export_gn_mesh` (Geometry Nodes Instances, marked experimental) exports instances from Geometry Nodes. `export_gpu_instances` exports `EXT_mesh_gpu_instancing`, limited to children of an Empty, and "multiple materials might be omitted". Neither was run here (Blender is not installed on this machine), so test your asset. Full export settings are in `blender-to-three-export`, compression in `gltf-asset-pipeline`.

Attributes: custom mesh attributes export only when the name starts with an underscore (`export_attributes`), and arrive in `geometry.attributes` lowercased (the loader applies `toLowerCase()` to unknown attribute names, so `_NAME` becomes `_name`). They are the way to carry a Geometry Nodes mask into a shader.

## 9. Verify

1. Determinism: build twice, compare `mats` byte for byte. Change one unrelated step parameter and confirm the earlier points did not move (`graph.runs` increments only for the changed step and later).
2. Stability under edit: add a face to the source, or raise `density` slightly, and confirm existing instances stay put (identity rule). A reshuffle means a sequential random call slipped in.
3. Visual: `render-qa` at each tier with `?tier=` scaling the density. Look for instances floating (normals not computed), all upright on slopes (`align: 'up'` or missing normals), clumps and gaps (Poisson distance too large for the density), z-fighting at base.
4. Counts: `renderer.info.render.triangles` and `calls` against section 6 and `performance-budget`.
5. Bounds: orbit to the edges. Instances popping out of view mean a stale `boundingSphere` (`computeBoundingSphere()` after changing matrices) or the GPU option without `frustumCulled = false`.
