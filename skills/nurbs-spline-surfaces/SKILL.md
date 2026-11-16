---
name: nurbs-spline-surfaces
description: Curves and parametric surfaces for Three.js, mapping Maya NURBS curves and surfaces (Loft, Revolve, Extrude, Birail, Rebuild, Trim) and Blender curve objects (Bezier, Poly, NURBS, bevel, taper) to practical code. Covers choosing Bezier versus Catmull-Rom versus NURBS, the `NURBSCurve` and `NURBSSurface` addons, clamped knot vectors, weights and exact circles, tested loft through section curves, revolve, sweep along a path with `ExtrudeGeometry`, `TubeGeometry` and `LoftGeometry`, tessellation density by chord tolerance, smooth normals with pole and seam fixes, trimming limits, converting to mesh for glTF and CAD import caveats. Use when a shape must be smooth and parametric (car body, bottle, pipe, hull, ribbon, rail, camera path), when a CAD or Maya NURBS model must reach the web, when a mesh shows facets on a curved surface, or when asked to loft, revolve, sweep, extrude along a path, build a spline or tessellate. Thai triggers เส้นโค้ง, พื้นผิวโค้ง, NURBS, ลอฟต์, หมุนโปรไฟล์, ลากตามเส้น, spline, เส้นทางกล้อง, พื้นผิวเรียบ.
argument-hint: "<the curve or surface to build, source tool (Maya, Blender, CAD), and how close the camera gets>"
---

# NURBS & Spline Surfaces

Three.js renders triangles. Curves and NURBS are authoring and generation tools: define a smooth shape with few control points, then tessellate it to a mesh sized for the camera. glTF stores the mesh, never the NURBS. Budgets are in `performance-budget`. For non-destructive operator stacks over meshes see `modifier-stack-parametric`.

## 1. Pick the representation

| Need | Use | Why |
|---|---|---|
| Camera path, motion path, rail | `CatmullRomCurve3` | Passes through the points you click. `curveType: 'centripetal'` (default) avoids loops and cusps |
| Hand-shaped profile with tangent handles | `CubicBezierCurve3` or `QuadraticBezierCurve3`, joined in a `CurvePath` | Handles give direct control. Joints are only continuous in position unless handles are collinear |
| Exact circle, ellipse, cone section, rounded rectangle | `NURBSCurve` with weights | Only rational splines make exact conics |
| Smooth freeform surface (car body, hull, bottle) | `NURBSSurface` tessellated through `ParametricGeometry` | Few control points, smooth to any density |
| Surface of revolution | `LatheGeometry`, or NURBS revolve (section 4) | Lathe for polyline or spline profiles, NURBS revolve when the profile is a rational arc and poles must be exact |
| Constant section along a path | `TubeGeometry` (round), `ExtrudeGeometry` with `extrudePath` (any `Shape`) | Built in |
| Mesh through a set of section polylines | `LoftGeometry` (addon, section 4) | Exact sections, linear between them |
| Model from CAD, already trimmed | Tessellate in the CAD tool, ship a mesh | Three.js has no trimmed surfaces (section 7) |

Properties that decide it: Catmull-Rom is C1, local, interpolating, no weights. Bezier chains are C0 by default. A degree p NURBS is C(p-1) inside a span when knots are not repeated, has local support, and weights bend it toward a point.

## 2. Concept map

| Maya | Blender | Three.js |
|---|---|---|
| CV curve (degree 3 default), EP curve | NURBS spline in a Curve object | `NURBSCurve(degree, knots, controlPoints)` |
| Rebuild Curve (`rebuildCurve`), Rebuild Surface (`rebuildSurface`) | | Rebuild sections to equal span count before lofting: same control point count and knots |
| Loft (`loft`) | No loft tool for curves. Bridge Edge Loops on mesh sections (`mesh.bridge_edge_loops`) | `loftSurface` below (through the sections), or `LoftGeometry` |
| Revolve (`revolve`) | Screw modifier, Spin tool | `revolveSurface` below, or `LatheGeometry` |
| Extrude along path (`extrude`), Birail (tool) | Curve `bevel_object`, `taper_object`, `bevel_depth`, `extrude` | `ExtrudeGeometry` with `extrudePath`, `TubeGeometry` |
| Planar (`planarSrf`) | Curve `fill_mode` | `ShapeGeometry` from a `Shape` |
| Trim (`trim`), Attach (`attachSurface`) | | Not available, section 7 |
| NURBS to Polygons (`nurbsToPoly`, prefs `nurbsToPolygonsPref`) | Object, Convert, Mesh (`object.convert(target='MESH')`) | `tessellate` below |
| Hull, Isoparms | Control points, resolution (`resolution_u`) | Control net, `slices` and `stacks` |

Maya command names were checked against the Autodesk 2024 command reference (all exist except a birail command name, which I could not confirm). Blender property names were checked against the current API docs: `Curve.bevel_depth`, `bevel_resolution`, `extrude`, `bevel_object`, `taper_object`, `fill_mode`, `use_fill_caps`, `twist_mode`, `Spline.type` (`POLY`, `BEZIER`, `NURBS`), `order_u`, `use_endpoint_u`, `use_cyclic_u`, `resolution_u`.

Blender's NURBS "Order" is degree + 1 (order 4 is cubic). "Endpoint" is the clamped knot vector (curve touches its first and last point). Without it the curve stops short of the end points.

## 3. NURBS in Three.js: the rules that bite

Verified against r187 source and run in Node.

- `NURBSCurve(degree, knots, controlPoints, startKnot, endKnot)` and `NURBSSurface(degree1, degree2, knots1, knots2, controlPoints)`. Control points are `Vector4(x, y, z, w)` with **x, y, z not pre-multiplied by the weight**; the library multiplies and divides internally. A `Vector3` input becomes weight 1.
- **Knot count = control points + degree + 1.** For a surface, `knots1.length - degree1 - 1` control rows, `knots2.length - degree2 - 1` control columns. `controlPoints[i][j]`: `i` along knots1 (u), `j` along knots2 (v).
- **Clamped knots** (curve touches both ends): `degree + 1` zeros, evenly spaced inner knots, `degree + 1` ones. Helper below.
- **Parameter range:** `getPoint(t)` and `getPoint(t1, t2, target)` take 0 to 1 and map linearly to the knot span. `NURBSSurface.getPoint` writes into a required `target`.
- **Exact circle:** degree 2, 9 control points, weights 1 and `sqrt(2)/2` alternating, knots `[0,0,0,.25,.25,.5,.5,.75,.75,1,1,1]`. Radius error measured 4e-16.
- **Arc length is not parameter.** Equal steps in `t` give uneven spacing where knots or weights vary. Resample by arc length (`NURBSCurve` inherits `getPointAt`) before placing things along it.
- `NURBSCurve.getTangent` maps over `knots[0]` to `knots[last]` while `getPoint` uses `startKnot` and `endKnot`. They agree for clamped curves, which is the case to use.
- Weights must be positive. Weight 0 or negative sends points to infinity.

## 4. Build surfaces

Tested helpers (Node, three r187): circle radius error 4e-16, unit sphere by revolve radius error 3e-16, a loft through four sections hits every section within 5e-16, closed-seam normals differ by 6e-5.

```js
import * as THREE from 'three';
import { NURBSSurface } from 'three/addons/curves/NURBSSurface.js';
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { findSpan, calcBasisFunctions } from 'three/addons/curves/NURBSUtils.js';

const V4 = (x, y, z, w = 1) => new THREE.Vector4(x, y, z, w);   // x, y, z are NOT pre-multiplied by w

/** Clamped knot vector for `n` control points: n + degree + 1 values, the curve touches both end points. */
export function clampedKnots(n, degree) {
  if (n < degree + 1) throw new Error(`need at least ${degree + 1} control points for degree ${degree}`);
  const k = Array(degree + 1).fill(0), inner = n - degree - 1;
  for (let i = 1; i <= inner; i++) k.push(i / (inner + 1));
  return k.concat(Array(degree + 1).fill(1));
}

/** Exact circle in the XZ plane: degree 2, 9 control points, weights 1 and sqrt(2)/2. */
export const CIRCLE_KNOTS = [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1];
export function circleControlPoints(r = 1) {
  const w = Math.SQRT1_2, c = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];
  return c.map(([x, z], i) => V4(x * r, 0, z * r, i % 2 ? w : 1));
}

/** Revolve a profile (control points with x = radius, y = height) about the Y axis. u runs round, v along the profile. */
export function revolveSurface(profile, profileDegree, profileKnots) {
  const circle = circleControlPoints(1);
  const net = circle.map((c) => profile.map((p) => V4(p.x * c.x, p.y, p.x * c.z, p.w * c.w)));
  return new NURBSSurface(2, profileDegree, CIRCLE_KNOTS, profileKnots, net);
}
```

```js
function gauss(A, b) {
  const n = b.length; b = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Global curve interpolation (NURBS Book A9.1): control points and knots of a curve through `pts` at parameters `ts`. */
function interpolate(pts, ts, degree) {
  const n = pts.length, knots = Array(degree + 1).fill(0);
  for (let j = 1; j <= n - degree - 1; j++) {   // averaged knots
    let s = 0;
    for (let i = j; i < j + degree; i++) s += ts[i];
    knots.push(s / degree);
  }
  knots.push(...Array(degree + 1).fill(1));
  const A = ts.map((t) => {
    const span = findSpan(degree, t, knots), N = calcBasisFunctions(span, t, degree, knots), row = Array(n).fill(0);
    N.forEach((v, k) => { row[span - degree + k] = v; });
    return row;
  });
  const sol = [0, 1, 2].map((d) => gauss(A.map((r) => r.slice()), pts.map((p) => p.getComponent(d))));
  return { knots, ctrl: pts.map((_, i) => new THREE.Vector3(sol[0][i], sol[1][i], sol[2][i])) };
}

/**
 * Loft: a surface that passes through every section curve. Sections share degree, knots and control point
 * count (rebuild them first, like Maya's Rebuild Curve). u follows each section, v runs across the sections.
 * Weights come from section 0. Returns the surface and the v parameter at which each section sits.
 */
export function loftSurface(sections, degreeU, knotsU, degreeV = 3) {
  const m = sections.length, q = Math.min(degreeV, m - 1), count = sections[0].length;
  const chord = Array(m).fill(0);   // chord length parameters averaged over every control point column
  for (let k = 0; k < count; k++) {
    const d = [0];
    for (let i = 1; i < m; i++) d.push(d[i - 1] + Math.hypot(sections[i][k].x - sections[i - 1][k].x, sections[i][k].y - sections[i - 1][k].y, sections[i][k].z - sections[i - 1][k].z));
    if (d[m - 1] > 0) for (let i = 1; i < m; i++) chord[i] += d[i] / d[m - 1] / count;
  }
  chord[m - 1] = 1;
  const cols = [];
  let knotsV;
  for (let k = 0; k < count; k++) {
    const r = interpolate(sections.map((s) => new THREE.Vector3(s[k].x, s[k].y, s[k].z)), chord, q);
    knotsV = r.knots; cols.push(r.ctrl);
  }
  const net = cols.map((col, k) => col.map((p) => V4(p.x, p.y, p.z, sections[0][k].w)));
  return { surface: new NURBSSurface(degreeU, q, knotsU, knotsV, net), params: chord };
}
```

Use:

```js
const sections = [0, 1, 2, 3].map((i) => circleControlPoints(1 + 0.4 * Math.sin(i)).map((p) => V4(p.x, i * 0.8, p.z, p.w)));
const { surface } = loftSurface(sections, 2, CIRCLE_KNOTS, 3);        // vase body
const profile = [V4(0, -1, 0), V4(1, -1, 0, Math.SQRT1_2), V4(1, 0, 0), V4(1, 1, 0, Math.SQRT1_2), V4(0, 1, 0)];
const sphere = revolveSurface(profile, 2, [0, 0, 0, 0.5, 0.5, 1, 1, 1]);   // unit sphere, two exact poles
```

Rules:
- **Loft needs matching sections:** same degree, knots and control point count. A mismatch is the most common Maya loft failure too. Rebuild first.
- **The loft interpolates the sections**, so the curve through them can overshoot with uneven spacing. Evenly spaced sections give the calmest surface. Weights come from section 0 only (verified limitation), so keep weights equal across sections or interpolate them as well.
- **Needs at least 2 sections.** Degree falls to `sections - 1` when there are few.
- **Revolve about another axis:** build on Y, then rotate the mesh.
- **Sweep and extrude** use built-ins. `new ExtrudeGeometry(shape, { extrudePath: curve, steps, bevelEnabled: false })` and `new TubeGeometry(curve, tubularSegments, radius, radialSegments, closed)`. `computeFrenetFrames` propagates the previous normal by the tangent rotation (parallel transport, source verified), so it does not flip at inflection points, but the starting roll is arbitrary and the section can twist along a long path. Check an orbit shot and rotate the shape if the start looks wrong.
- **`LoftGeometry`** (`three/addons/geometries/LoftGeometry.js`, present in r187, absent from older releases, verify the pinned revision): `new LoftGeometry(sections, { closed, capStart, capEnd })`, each section an array of `Vector3` with equal point counts. It connects sections with straight faces, computes normals, welds the seam, and builds arc-length UVs. Smoothness between sections depends on how many sections you give it, so densify with a `CatmullRomCurve3` across them.

## 5. Tessellation density

`ParametricGeometry(func, slices, stacks)` samples evenly in parameter space (verified in source), so the number of faces is `2 x slices x stacks` and density follows the knots, not the shape. Pick counts from the allowed deviation.

Chord error for an arc of radius R split into n segments of total angle A: `sag = R x (1 - cos(A / (2n)))`. Solve for n:

```js
/** Segments for an arc so that the chord stays within `tol` of the true curve (same units as radius). */
export const segmentsForArc = (radius, angle, tol) =>
  Math.max(1, Math.ceil(angle / (2 * Math.acos(Math.max(-1, 1 - tol / radius)))));
```

Measured: a full circle at tolerance 0.001 needs 71 segments at radius 1 and 223 at radius 10. Tolerance is in world units, so choose it from what the camera can see: about one pixel at the closest distance (`tol = pixelWorldSize`).

| Surface | Starting counts (guess, tune against a silhouette screenshot) |
|---|---|
| Hero, close camera | Round direction 96 to 128, length direction 32 to 64 per span |
| Prop | 32 to 48 round, 16 to 24 along |
| Background | 12 to 16 round, 6 to 8 along |

- **Spend on curvature.** A long flat panel needs 1 to 2 segments across. Split a large surface at its span boundaries (knot lines) and give each patch its own counts.
- **Lowest tier:** halve both counts, which quarters triangles. The total goes into the tier table of `performance-budget`.
- **Retessellate on demand** only when the surface changes (edit mode). Keep the geometry static in play.
- **Disposal:** `geometry.dispose()` on the old mesh before swapping (`performance-budget` section 6).

## 6. Normals, poles, seams and winding

Raw `ParametricGeometry` normals come from finite differences of the surface function. Four defects follow, found and fixed in the tested helper:

```js
/** Tessellate with smooth normals and outward winding (pass flip = true if the result is inside out). */
export function tessellate(surface, slices, stacks, flip = false) {
  const g = new ParametricGeometry((u, v, t) => surface.getPoint(flip ? 1 - u : u, v, t), slices, stacks);
  const nrm = g.getAttribute('normal'), cols = slices + 1, t = new THREE.Vector3();
  const degenerate = (row) => { for (let j = 0; j < cols; j++) if (t.fromBufferAttribute(nrm, row * cols + j).lengthSq() < 0.25) return true; return false; };
  for (const [row, next] of [[0, 1], [stacks, stacks - 1]]) {   // a collapsed edge (pole) has zero-length tangents
    if (!degenerate(row)) continue;
    const avg = new THREE.Vector3();
    for (let j = 0; j < cols; j++) avg.add(t.fromBufferAttribute(nrm, next * cols + j));
    avg.normalize();
    for (let j = 0; j < cols; j++) nrm.setXYZ(row * cols + j, avg.x, avg.y, avg.z);
  }
  nrm.needsUpdate = true;
  return g;
}
```

| Defect | Cause | Fix |
|---|---|---|
| Black or zero normals at a pole | Both tangents collapse, `normalize()` of a zero vector stays zero. Measured 68 bad normals on a 48 by 24 sphere | Replace the pole row with the average of the next row (done above) |
| Whole surface inside out | Orientation follows the (u, v) handedness. The revolve in section 4 came out inside out in both winding and normals | `tessellate(..., true)`. Or reverse the profile order, or set `side: THREE.DoubleSide` only as a last resort (costs fill rate, breaks shadow bias) |
| Visible crease along a closed seam | First and last column are separate vertices | Finite-difference normals match there (seam difference measured 6e-5). Do not call `computeVertexNormals()`, it would split the seam. Keep the duplicate column, since UVs differ |
| Cracks between neighbouring patches | Each patch tessellated with different counts | Same counts along shared edges, or `mergeVertices` plus a skirt. Stitch in the CAD tool when you can |
| Texture stretched or mirrored | UVs equal the parameter space (u, v in 0 to 1) | Rescale UVs by the real surface length per direction (`uv-unwrap-packing` density rule). Parametric UVs are fine for tiling along a loft |
| Facets still visible | Counts too low, or flat shading | Raise counts per section 5 before touching normals |

Tangents for a normal map must be generated after the final UVs and winding (`gltf-asset-pipeline`: `tangents`).

## 7. Trimming and limits

Three.js has **no trimmed NURBS surfaces**: no trim loops, no face-on-surface boolean. Options:

| Need | Option | Cost |
|---|---|---|
| A surface cut by a curve (a hole, a notch) | Trim in Maya (`trim`) or the CAD tool and export the tessellated result | Best. The trim becomes mesh edges |
| Same, but only the look | Mask in the fragment shader (`discard` where a mask texture over (u, v) is 0), with `alphaTest` or `customDepthMaterial` so shadows follow | Silhouette stays untrimmed in physics and raycasts, and edges alias. See `shader-craft` |
| Hole punched by a solid | `three-bvh-csg` on the tessellated meshes (`modifier-stack-parametric` section 5) | The result is a plain mesh, not a surface. Experimental library |
| Composite surface from patches | Tessellate each patch with equal counts on the shared edge | Watch cracks (section 6) |

Also limited:
- **Degree above 3** works in the evaluator but helps little for rendering. Use 3.
- **Evaluation cost** of `getPoint` is per sample. Evaluate once on build, never per frame.
- **Animated control points** (morphing hull) retessellate every frame: keep the net below roughly 20 by 20 and counts low, or hand the evaluator to a shader (verify, no stock Three.js example for NURBS in a vertex shader).
- **Knot insertion, degree elevation, projection, intersection** are not in the addons. Do them in the DCC tool.

## 8. From Maya, Blender and CAD to the web

Ship a mesh. Keep the editable curves out of the shipped file or in `extras` (JSON-only data).

| Source | Step |
|---|---|
| Maya NURBS | Convert with `nurbsToPoly` (Modify, Convert, NURBS to Polygons), triangle or quad output, tessellation count per surface. Then export. Exporter notes in `blender-to-three-export` |
| Blender curve object | `bpy.ops.object.convert(target='MESH')` (the operator exists) before export, so the result is certain. Use `resolution_u` for the spline resolution and `bevel_resolution` for the bevel round. Check the curve's 2D versus 3D `dimensions` and `twist_mode` for sweep twist |
| STEP, IGES, SolidWorks, Fusion, Rhino | The tool exports a tessellated mesh (OBJ, STL or glTF), with a tolerance setting. Three.js core has no STEP or IGES loader. A WASM OpenCascade importer exists (`occt-import-js`, verify before relying on it) |

CAD caveats:
- **Units:** CAD is usually millimetres. A 2 m part arrives as 2000 units. Scale to metres at import (`gltf-asset-pipeline` normalisation).
- **Axes:** many CAD systems are Z-up. Rotate to Y-up.
- **Overtessellation:** CAD exports thousands of tiny triangles on flat parts. Run `weld` then `simplify` (`sculpt-retopology-workflow` section 5), and delete hidden internal bodies (bolts, internal cavities, hundreds of assembly parts).
- **Flipped faces:** trimmed faces can arrive with mixed orientation. Check an orbit shot, fix in the exporter or recompute normals after `mergeVertices`.
- **Cracks along patch boundaries:** weld by distance in the DCC tool (`mergeVertices(g, tol)` in `BufferGeometryUtils`).
- **One material per CAD body** produces dozens of draw calls. Merge by material (`performance-budget` section 2).

## 9. Verify

1. Run a unit test on each helper like the ones above: circle radius, sections hit by the loft, no zero normals, outward winding (centre-relative dot product positive on every triangle).
2. Screenshot with `render-qa` from the closest allowed camera and one grazing orbit shot, with `wireframe` once. Look for facets on the silhouette, black poles, seam creases, cracks between patches.
3. Count: `renderer.info.render.triangles` against the tier table in `performance-budget`.
4. Round trip: export the mesh with `GLTFExporter`, reload through `gltf-asset-pipeline`, compare the `Box3` size to the live mesh.
5. Dispose test: rebuild the surface 50 times, then `renderer.info.memory.geometries` must return to baseline.
