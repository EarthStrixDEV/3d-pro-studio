---
name: modifier-stack-parametric
description: Reproduce 3ds Max style non-destructive parametric modeling in Three.js. A typed, ordered, re-evaluable modifier stack over a parametric base shape (dirty-index cache, geometry disposal, normal and UV regeneration), with Bend, Twist, Taper, Noise, FFD lattice, Shell, Push, Symmetry and Mirror, Array, Lathe, Extrude and Sweep with bevel, Edit Poly style operations, Boolean via three-bvh-csg, TurboSmooth, UV generation, pivot and axis handling, Instances versus References, Scatter and Path Deform, CPU versus vertex-shader deformers, and glTF export of the baked result. Use when a shape must stay editable after modifiers are applied, when asked to bend, twist, taper, mirror, array, boolean or sweep geometry, when porting a 3ds Max or Blender modifier workflow, or when deformers must animate. Thai triggers โมดิฟายเออร์, โมเดลพารามิเตอร์, บิดโมเดล, ดัดโค้ง, แก้ไขภายหลังได้, ทำซ้ำ, เจาะ boolean.
argument-hint: "<shape to model, and which modifiers or 3ds Max workflow to reproduce>"
---

# Modifier Stack & Parametric Modeling

Keep a base shape and an ordered list of operators as data. The geometry on screen is a cache of that list. Every pass costs vertices, so budget the result in `performance-budget`.

## 1. Concept map

3ds Max is Z-up, Three.js is Y-up. Conversion and pivots are in section 5.

**Deformers** (vertex remap, topology and UVs unchanged)

| 3ds Max | Three.js | Rule |
|---|---|---|
| Bend | `applyBend` in section 2 | Lower limit stays fixed. Outside the limits the mesh continues straight |
| Twist | `applyTwist` in section 2 | Rotation ramps from 0 at the lower limit to `angle` at the upper limit |
| Taper | Same axis frame: scale the two perpendicular coordinates by `1 + amount * t`, t = 0 to 1 along the limits (own design, add a curve term as `t ** p`) | Clamp `1 + amount * t` above 0 or the mesh inverts |
| Noise | Displace along a welded normal or a fixed axis by `SimplexNoise.noise3d(x * f, y * f, z * f + seed)` from `three/addons/math/SimplexNoise.js` | Needs one normal per position, see Push |
| FFD 2x2x2, 3x3x3, 4x4x4 | Lattice of control points over the bounding box, trivariate Bernstein blend of `P[i][j][k]` (2x2x2 reduces to trilinear) | CPU in the same `deform` loop, or 8 to 64 `vec3` uniforms in a vertex shader |
| Push | `position += normal * amount` | Use `toCreasedNormals(g, Math.PI)`: one averaged normal per position, so hard-edge splits move together and no cracks open |
| Shell | Copy offset along `-normal * thickness`, flip the copy's winding, join with `mergeGeometries`, bridge open boundary edges | No built-in. Closed meshes need no bridge. Own operator |

**Generators and topology operators**

| 3ds Max | Three.js | Rule |
|---|---|---|
| Parametric base (Box, Cylinder, Sphere) | `BoxGeometry`, `CylinderGeometry`, `SphereGeometry`, `RoundedBoxGeometry` (addons) | Store `{ kind, params }`, rebuild on edit. Enough height segments or Bend and Twist show facets |
| Lathe | `LatheGeometry(points, segments, phiStart, phiLength)`, points are `Vector2` (x radius, y height) | Edit the profile as a `SplineCurve`, sample with `getPoints(n)` |
| Extrude with bevel | `ExtrudeGeometry(shape, { depth, bevelEnabled, bevelThickness, bevelSize, bevelOffset, bevelSegments, steps })` | Holes go in `shape.holes`. Bevel 2 to 5% of size, 4 to 8 segments |
| Sweep along a spline | `ExtrudeGeometry` with `extrudePath: curve` and `steps`, or `TubeGeometry` for round sections | Frenet frames can roll on tight curves (check orbit shots) |
| Symmetry, Mirror | `mirrorGeometry` below, then `mergeGeometries` and `mergeVertices(g, tolerance)` to weld the seam | Live preview: `mesh.scale.x = -1` (renderer flips front face for a negative determinant). Bake before export |
| Array | Live: `InstancedMesh` with `setMatrixAt`. Baked: `mergeGeometries` of transformed clones | Linear and radial are just matrix generators |
| Edit Poly: Inset, Bevel, Chamfer, Extrude face | **No built-in.** `BufferGeometryUtils` only gives `mergeVertices` (weld, to get shared topology), `toCreasedNormals` (chamfer look from normals, no new geometry) and `mergeGeometries` | Real inset or bevel needs your own operator over a welded indexed mesh, or an offline Blender step. For primitives use `RoundedBoxGeometry` or Extrude bevel |
| Boolean | `three-bvh-csg`: `Brush`, `Evaluator`, `ADDITION`, `SUBTRACTION`, `REVERSE_SUBTRACTION`, `INTERSECTION`, `DIFFERENCE` | Section 5. Peer dependency of 0.0.18 is `three >= 0.179`, `three-mesh-bvh >= 0.9.7` |
| TurboSmooth | Subdivision as in `mesh-texture-upscale` section 2 (`three-subdivide`, cap at 2 iterations) | Last in the stack. Run only at `final` quality, never while dragging |
| Unwrap UVW | Per-operator UV rules below | No automatic unwrap in three. Atlas packing is offline or an xatlas WASM port (verify package) |

UV rules per operator:

| Operator class | UVs |
|---|---|
| Deformers | Keep. Stretch is the author's call |
| Mirror, Array, Boolean | Keep source UVs. Offset the copy by `+1` in u if texels must stay unique |
| Shell | Copy the UVs to the inner shell |
| Generated projection (planar, cylindrical, spherical) | Compute from position in the operator |
| Box projection | `toNonIndexed()` first, pick the axis from each face normal |
| `ExtrudeGeometry` | `UVGenerator` option replaces the default |
| No UVs needed | Triplanar in the shader (`shader-craft`) |

**Scene-level concepts**

| 3ds Max | Three.js | Rule |
|---|---|---|
| Instance | One evaluated `BufferGeometry` shared by N meshes, or `InstancedMesh` | One edit reaches all consumers. Reassign `mesh.geometry` on each consumer after `evaluate()` |
| Reference | A second `ModifierStack` whose base is the parent's cached output at index `i` plus its own entries | Rebuild the child when the parent's dirty index is `<= i`. Evaluate both in the same tick |
| Copy | `geometry.clone()` plus a cloned entries array | Fully independent |
| Scatter | `MeshSurfaceSampler(mesh).setWeightAttribute(name or null).build()`, `sample(position, normal)` into an `InstancedMesh` | Call `build()` again after the surface changes |
| Path Deform | Live and animatable: `Flow` from `three/addons/modifiers/CurveModifier.js`. Baked: remap x along `curve.getPointAt(t)` with `computeFrenetFrames` | `Flow` reads world x as the path axis. Lay the mesh along +X at the origin |
| Pivot, Affect Pivot Only | Bake the offset into the geometry, move the mesh by the inverse | Do it before the stack, limits are in base-local units |

## 2. Typed stack and the Bend, Twist sample

Model: entries are plain JSON data (`kind` discriminates, `id` is stable, `enabled` bypasses). Operators are pure functions `(BufferGeometry, params) => BufferGeometry`: they clone, never mutate the input. Add a modifier by adding one union member, one function and one `case`. The compiler flags every `switch` that misses it.

Verified: `tsc --strict` clean on three r170 and r187, behaviour tests run on both (bend arc geometry, twist radius and handedness, base untouched, unit normals, UVs and index kept, cache reuse, disposal, pass-through, zero-length range, angle 0).

```ts
import * as THREE from 'three';

export type Axis = 'x' | 'y' | 'z';
export interface Limits { lo?: number; hi?: number } // along `axis`, in the input's local units

export interface BendParams { kind: 'bend'; angle: number; direction: number; axis: Axis; limits?: Limits }
export interface TwistParams { kind: 'twist'; angle: number; axis: Axis; limits?: Limits }
export type ModifierParams = BendParams | TwistParams; // add one member per modifier kind
export type ModifierEntry = ModifierParams & { id: string; enabled: boolean };

// (a, b, c) = (along axis, first perpendicular, second perpendicular), cyclic so rotations keep handedness
const AXES: Record<Axis, [number, number, number]> = { x: [0, 1, 2], y: [1, 2, 0], z: [2, 0, 1] };
interface Frame { a: number; b: number; c: number }

/** Pure: clones `input`, remaps every vertex in axis frame, regenerates normals. UVs and index are kept. */
function deform(
  input: THREE.BufferGeometry, axis: Axis, limits: Limits | undefined,
  f: (v: Frame, lo: number, hi: number) => void,
): THREE.BufferGeometry {
  const out = input.clone();
  const pos = out.getAttribute('position');
  const [ia, ib, ic] = AXES[axis];
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getComponent(i, ia);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const lo = limits?.lo ?? min, hi = limits?.hi ?? max;
  if (hi - lo > 1e-9) {
    const v: Frame = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < pos.count; i++) {
      v.a = pos.getComponent(i, ia); v.b = pos.getComponent(i, ib); v.c = pos.getComponent(i, ic);
      f(v, lo, hi);
      pos.setComponent(i, ia, v.a); pos.setComponent(i, ib, v.b); pos.setComponent(i, ic, v.c);
    }
    pos.needsUpdate = true;
  }
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The lower limit stays fixed. direction 0 bends toward the next axis in x→y→z→x order (axis y bends toward +z). */
export function applyBend(input: THREE.BufferGeometry, p: BendParams): THREE.BufferGeometry {
  return deform(input, p.axis, p.limits, (v, lo, hi) => {
    const len = hi - lo, k = p.angle / len; // curvature = 1 / radius
    if (Math.abs(k) < 1e-9) return;
    const cd = Math.cos(p.direction), sd = Math.sin(p.direction);
    const u = v.b * cd + v.c * sd, w = -v.b * sd + v.c * cd; // u: toward the bend direction, w: across it
    const s = v.a - lo, sc = clamp(s, 0, len), rest = s - sc; // rest != 0: outside the limits, stays straight
    const phi = k * sc, sin = Math.sin(phi), cos = Math.cos(phi), r = 1 - k * u;
    const u2 = (1 - r * cos) / k + rest * sin;
    v.a = lo + (r * sin) / k + rest * cos;
    v.b = u2 * cd - w * sd;
    v.c = u2 * sd + w * cd;
  });
}

/** Rotation about `axis` grows linearly from 0 at the lower limit to `angle` at the upper limit. */
export function applyTwist(input: THREE.BufferGeometry, p: TwistParams): THREE.BufferGeometry {
  return deform(input, p.axis, p.limits, (v, lo, hi) => {
    const phi = p.angle * (clamp(v.a - lo, 0, hi - lo) / (hi - lo));
    const sin = Math.sin(phi), cos = Math.cos(phi), b = v.b * cos - v.c * sin;
    v.c = v.b * sin + v.c * cos;
    v.b = b;
  });
}

function run(e: ModifierEntry, g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!e.enabled) return g; // returns its input: the same reference sits in two cache slots
  switch (e.kind) {
    case 'bend': return applyBend(g, e);
    case 'twist': return applyTwist(g, e);
    default: { const unreachable: never = e; return unreachable; }
  }
}

export class ModifierStack {
  private cache: THREE.BufferGeometry[] = []; // cache[i] = output of entries[i]
  private dirtyFrom = 0;

  constructor(readonly base: THREE.BufferGeometry, readonly entries: ModifierEntry[]) {}

  edit(id: string, mutate: (e: ModifierEntry) => void): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) throw new Error(`no modifier ${id}`);
    mutate(this.entries[i]);
    this.dirtyFrom = Math.min(this.dirtyFrom, i);
  }
  insert(index: number, entry: ModifierEntry): void {
    this.entries.splice(index, 0, entry);
    this.dirtyFrom = Math.min(this.dirtyFrom, index);
  }
  remove(id: string): void {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i >= 0) { this.entries.splice(i, 1); this.dirtyFrom = Math.min(this.dirtyFrom, i); }
  }

  /** Recomputes from the first changed entry only. Assign the result to the mesh in the same tick. */
  evaluate(): THREE.BufferGeometry {
    const from = Math.min(this.dirtyFrom, this.cache.length);
    const stale = this.cache.splice(from);
    let g = from === 0 ? this.base : this.cache[from - 1];
    for (let i = from; i < this.entries.length; i++) this.cache.push((g = run(this.entries[i], g)));
    this.dirtyFrom = this.entries.length;
    const live = new Set([this.base, ...this.cache]);
    for (const s of new Set(stale)) if (!live.has(s)) s.dispose(); // never the base, never a still-cached pass-through
    return g;
  }

  dispose(): void {
    for (const g of new Set(this.cache)) if (g !== this.base) g.dispose();
    this.cache = [];
    this.dirtyFrom = 0;
  }
}
```

Use:

```ts
const stack = new ModifierStack(new THREE.CylinderGeometry(0.5, 0.5, 4, 32, 32), [
  { id: 'bend', kind: 'bend', enabled: true, angle: Math.PI / 2, direction: 0, axis: 'y' },
  { id: 'twist', kind: 'twist', enabled: true, angle: Math.PI, axis: 'y' },
]);
mesh.geometry = stack.evaluate();                                        // builds both passes
stack.edit('twist', (e) => { if (e.kind === 'twist') e.angle = a; });
mesh.geometry = stack.evaluate();                                        // reuses the bend, recomputes the twist
```

Order changes the result: Bend then Twist is not Twist then Bend. Moving an entry dirties from the lower of its old and new index.

## 3. Evaluation rules

- **Dirty index:** an edit at index `i` recomputes `i..end` and reuses `cache[0..i-1]`. Base edits rebuild the base, dispose the old stack, construct a new `ModifierStack(newBase, oldEntries)`.
- **Two-operand entries** (Boolean, Reference): dirty from the lowest index of either operand's chain. Keep the operand's own stack and invalidate the consumer when it changes.
- **Dispose superseded output** only after the new one exists and the mesh points at it. Never dispose `base` (the caller owns it) and never a pass-through duplicate: a disabled entry returns its input, so the same object sits in two slots. The sample dedupes with a `Set`. Teardown: `stack.dispose()` then `base.dispose()`.
- **Normals after every pass:** `computeVertexNormals()` in each operator, because Push, Noise and Shell read them. Hard-edged primitives are already split per face and stay faceted. Smooth shapes with UV seams show a lighting crack at the seam: apply `toCreasedNormals(g, angle)` once on the committed result. It returns non-indexed geometry, roughly triple the vertices, so not on every drag step.
- **Stale attributes:** `deleteAttribute('tangent')` before a deformer if a precomputed tangent exists. Positions moved, the tangent did not.
- **Bounds:** recompute `boundingBox` and `boundingSphere` after every pass or frustum culling clips the result.
- **Unsupported bases:** skinned or morph-target meshes. Weights and deltas do not follow the remap. Apply the stack before skinning in the DCC tool.
- **Two quality levels:** `preview` skips TurboSmooth, `final` runs everything. Switching level dirties from the first level-dependent entry.

## 4. CPU stack vs vertex-shader deformer

| | CPU stack (section 2) | Vertex shader |
|---|---|---|
| Animate every frame | Only for small meshes, it is O(vertices) per dirty pass | Free: change a uniform |
| Result is real geometry | Yes: boolean, raycast, bounds, export, collision | No: raycast, bounds, CSG and glTF see the undeformed mesh |
| Normals | `computeVertexNormals()` | Transform them in the shader or take derivatives |
| Shadows | Correct | Patch `customDepthMaterial` with the same code (`shader-craft`) |

Workflow: author and bake on the CPU stack, animate with a port of the same formula through `onBeforeCompile` (`shader-craft`), and set `frustumCulled = false` or enlarge `boundingSphere` because the CPU bounds are wrong. For Path Deform the animatable option is `Flow`.

Animate a baked result with morph targets when the target must travel in glTF. Interpolating two baked bends is a linear blend, not a rotation, so the arc shortens mid-way. Bake extra keys or keep the shader.

## 5. Operator notes

**Mirror and symmetry**

```js
function mirrorGeometry(g, axis /* 'x' | 'y' | 'z' */) {
  const s = new THREE.Vector3(1, 1, 1); s[axis] = -1;
  const m = g.clone().applyMatrix4(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
  const ix = m.index;                                   // indexed input required
  for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, t); }
  ix.needsUpdate = true;                                // a reflection reverses winding, swap two indices per triangle
  return m;
}
const both = mergeGeometries([half, mirrorGeometry(half, 'x')]);
both.deleteAttribute('normal');                         // mergeVertices needs identical attributes
const welded = mergeVertices(both, 1e-4);               // seam tolerance
welded.computeVertexNormals();
```

**Boolean** (verified on three r187 with three-bvh-csg 0.0.18)

```js
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
const a = new Brush(solidGeo), b = new Brush(cutterGeo);
a.updateMatrixWorld(); b.position.set(1, 0, 0); b.updateMatrixWorld();
const evaluator = new Evaluator();
evaluator.useGroups = false;                            // single material, single draw call
const result = evaluator.evaluate(a, b, SUBTRACTION);   // a Brush, which is a Mesh
result.geometry.computeVertexNormals();
a.disposeCacheData(); b.disposeCacheData();
```

- Regular operations expect closed two-manifold solids. Only `HOLLOW_SUBTRACTION` and `HOLLOW_INTERSECTION` accept a non-manifold A (README).
- Do not edit a brush's geometry after creation, build a new `Brush`. Remove groups from the geometry first if you only have one material.
- The library calls itself experimental. Check the result for holes at grazing orbit shots.
- Pinned scenes on three r170 (`gltf-asset-pipeline`) need an older three-bvh-csg release (verify which).

**Edit Poly style work:** weld with `mergeVertices`, build your own edge and face adjacency, then write the operator as another pure function. Offline Blender bevel and inset is cheaper than a half-edge structure unless the parameters must stay live.

**Pivot and axes**

```js
geometry.rotateX(-Math.PI / 2);                         // 3ds Max Z-up to Y-up: (x, y, z) -> (x, z, -y)
const p = new THREE.Vector3(px, py, pz);                // new pivot in base-local space
geometry.translate(-p.x, -p.y, -p.z); mesh.position.add(p);   // Affect Pivot Only
geometry.center();                                      // pivot at the bounding-box centre
```

The stack's `axis` and `limits` are in base-local units. Bake pivot and orientation into the base first, or a Bend pivots about the wrong point.

**Scatter and Path Deform**

```js
const sampler = new MeshSurfaceSampler(surface).setWeightAttribute(null).build();
const p = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Quaternion(), m = new THREE.Matrix4();
const up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
for (let i = 0; i < inst.count; i++) {
  sampler.sample(p, n);
  q.setFromUnitVectors(up, n);
  inst.setMatrixAt(i, m.compose(p, q, one));
}
inst.instanceMatrix.needsUpdate = true;
inst.computeBoundingSphere();                           // per performance-budget, or culling breaks

const flow = new Flow(longMesh);                        // clones the mesh and its materials
flow.updateCurve(0, curve);
scene.add(flow.object3D);                               // add this, not longMesh
flow.moveAlongCurve(dt * speed);                        // in the loop
```

Surface sampling is in the mesh's local space. Put `inst` under the same parent, or apply `surface.matrixWorld`.

## 6. Export the baked result

- Export the evaluated geometry. The stack itself does not survive, so keep it: `mesh.userData.modifierStack = { entries }` (JSON only) is written to the node's `extras` by `GLTFExporter`. Re-import rebuilds the stack from `extras` plus the base parameters.
- Shader deformers never export. Bake to geometry, or to morph targets:

```js
const rest = stack.evaluate();                          // t = 0
const posed = applyBend(rest, { kind: 'bend', angle: Math.PI / 2, direction: 0, axis: 'y' });
rest.morphAttributes.position = [new THREE.BufferAttribute(posed.getAttribute('position').array, 3)];
rest.morphAttributes.normal = [new THREE.BufferAttribute(posed.getAttribute('normal').array, 3)];   // or shading stays at rest
mesh.updateMorphTargets(); mesh.morphTargetInfluences[0] = 1;
```

  `GLTFExporter` converts absolute targets to relative itself (`morphTargetsRelative` false is handled).
- `InstancedMesh` (Array, Scatter) exports as `EXT_mesh_gpu_instancing`. Consumers without the extension see one object. Merge with `mergeGeometries` if they must.
- Bake Mirror into geometry before export, do not rely on a negative node scale.

```js
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
const glb = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true });   // ArrayBuffer
```

- `toCreasedNormals` and `toNonIndexed` output is non-indexed. Run `weld`, `optimize` and compression from `gltf-asset-pipeline` on the file, then `validate` (errors must be zero).

Verified on r187 in Node with a FileReader shim (JSON mode): morph `POSITION` and `NORMAL` targets, `userData` in `extras`, `EXT_mesh_gpu_instancing`. Binary mode and browser runtime not run.

## 7. Verify

1. Run `render-qa` on the page with the stack applied. Add one orbit shot at a grazing angle: normal cracks, flipped winding (black faces after Mirror) and CSG holes show there first.
2. Report: triangles after Array, TurboSmooth and Boolean must sit inside the tier table in `performance-budget`.
3. Leak test: drive 50 `stack.edit` plus `evaluate` cycles, then compare `renderer.info.memory.geometries` to the start. It must return to baseline after `stack.dispose()` and `base.dispose()`.
4. Round trip: export, re-import with the loader setup in `gltf-asset-pipeline`, compare `Box3` size to the live mesh within 1e-4, and run its `validate`.
5. Purity check on any new operator: the base geometry's position array is byte-identical before and after.
