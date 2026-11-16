---
name: sculpt-retopology-workflow
description: Sculpt high-poly, retopologise, bake and ship workflow for real-time Three.js assets, translating Blender sculpt tools (Dyntopo, Multires, Voxel Remesh, QuadriFlow, Decimate, Shrinkwrap) and Maya Quad Draw into practical rules. Covers choosing sculpt method, edge flow and deformation loops, pole placement, quads versus triangles, triangle budgets per device tier, decimation (Blender Decimate, QuadriFlow, Instant Meshes, `gltf-transform simplify`, `SimplifyModifier`), LOD chains, the low-poly hand-off to baking and a Blender Python retopo script. Use when a sculpt or scan is too heavy to ship, when a model has dense or messy topology, when a character must deform cleanly, when normal-map baking needs a clean low mesh, or when asked to retopo, decimate, reduce polygons or hit a triangle budget. Thai triggers รีโทโพ, ลดโพลิกอน, ปั้นโมเดล, sculpt, ลดจำนวนสามเหลี่ยม, โมเดลหนักเกิน, โครงตาข่ายสวย, edge flow.
argument-hint: "<high-poly source, what it must do (static, deforming, hero), and the device tier>"
---

# Sculpt & Retopology Workflow

The runtime model is never the sculpt. Sculpt for the eye, retopologise for the GPU and the rig, bake the detail back as textures, ship the light mesh. Budgets are in `performance-budget`. Baking itself is `texture-baking-pipeline`, UVs for the low mesh are `uv-unwrap-packing`.

## 1. Decide the route first

| Source and goal | Route | Why |
|---|---|---|
| Static prop, rock, scan, no deformation, no hand-painted UVs | Decimate (section 5), re-unwrap, bake | Fast. Triangle soup is fine when nothing bends |
| Hero close-up, clean shading, new UVs | Retopo, then bake | Control over silhouette, loops and UV seams |
| Character or anything that bends | Retopo with deformation loops (section 4), then rig | Decimation destroys edge loops, joints crumple |
| Hard-surface model made from booleans | Remodel clean, or bevel and clean-up in Blender | Booleans leave n-gons and tiny faces |
| Already low (under budget) | Skip all of it, just bake missing detail | Do not add work |

Spend triangles on the silhouette and on bend areas. Flat interiors and anything a normal map can fake get none.

## 2. Concept map

| Task | Blender | Maya | Three.js side |
|---|---|---|---|
| Free sculpt, adaptive detail | Dyntopo (`sculpt.dynamic_topology_toggle`) | Sculpting Toolset | Output is an unusable, UV-less triangle soup, only a bake source |
| Layered sculpt on clean base | Multires modifier (`levels`, `sculpt_levels`, `render_levels`) | Smooth mesh preview plus sculpt | Source for baking. Keep the level 0 base clean |
| Uniform dense remesh | Voxel Remesh (`object.voxel_remesh`, `Mesh.remesh_voxel_size`) | Remesh in the Mesh menu (verify) | Starting blob for a sculpt, never a shipped mesh |
| Manual retopo | Poly Build tool plus Snap to Faces, Shrinkwrap modifier | Quad Draw on a Make Live surface | The shipped low mesh |
| Automatic quad retopo | QuadriFlow (`object.quadriflow_remesh`) | `polyRetopo` (Retopologize, command exists, options not checked here) | Good first pass. Fix poles and loops by hand on heroes |
| Automatic external | Instant Meshes (standalone tool, GUI and a command line, run its `--help`) | | Field-aligned quads, no UVs kept |
| Triangle reduction | Decimate modifier (`COLLAPSE`, `ratio`) | `polyReduce` (exists) | `gltf-transform simplify`, `SimplifyModifier` |

## 3. Sculpt stage rules

| Method | Use when | Limits |
|---|---|---|
| Multires | Detail on a clean base mesh with UVs you want to keep | Cannot change base topology after subdividing. Subdivide, sculpt, then bake from the top level. `levels` is viewport, `sculpt_levels` is sculpt, `render_levels` is render |
| Dyntopo | Concept forms and free sculpting without topology planning | Destroys UVs and produces uneven triangles. Retopo is mandatory afterwards |
| Voxel Remesh | Merging parts, repairing a messy blob, starting a sculpt | `remesh_voxel_size` is object-space and uniform. Attributes (UVs, colours) are lost unless `use_remesh_preserve_attributes` is on (verify it keeps what you need) |

- **Scale first.** Apply scale and set real-world size (metres) before sculpting, so brush size, voxel size and later density mean the same thing everywhere.
- **Sculpt symmetric, then break symmetry last.** Retopo and UVs are cheaper on a symmetric base.
- **Keep every sculpt level.** The bake needs the highest. Save a `_high` copy before any destructive step.
- **Do not sculpt detail the bake cannot carry.** Anything at pixel scale below the target texel density is wasted (`uv-unwrap-packing` section 5). Undercuts and thin features bake poorly: model those in geometry on the low mesh.
- **No hidden geometry.** Delete interior faces and faces nobody sees (the underside of a prop on a floor). They cost triangles and break baking rays.

## 4. Retopology rules

**Budgets.** `performance-budget` gives the whole-scene triangle limit per tier. An asset's share, with a shadow-casting light drawing it twice (measured in `mograph-procedural` section 13: shadows about double the triangle count), is `tier budget x share / 2`. Starting values, all guesses to tune against `renderer.info.render.triangles`:

| Asset class | Share of tier budget | Low (300k) | Mid (800k) | High (1.5M) |
|---|---|---|---|---|
| Hero (one or two on screen) | 0.20 | 30,000 | 80,000 | 150,000 |
| Prop (each, a handful visible) | 0.04 | 6,000 | 16,000 | 30,000 |
| Background or far prop | 0.01 | 1,500 | 4,000 | 7,500 |

Check them with this helper (verified in Node on r187: a box plus an instanced box of 10 gives 132 triangles):

```js
export const TIER_TRIS = { low: 300_000, mid: 800_000, high: 1_500_000 };   // performance-budget table
export function triangleCount(root) {
  let t = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, per = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    t += per * (o.isInstancedMesh ? o.count : 1);
  });
  return t;
}
/** Triangles one asset may use: tier budget x share, halved when a shadow pass redraws it. */
export const assetBudget = (tier, share, castsShadow = true) => Math.floor(TIER_TRIS[tier] * share / (castsShadow ? 2 : 1));
```

Ship one LOD chain per hero when the camera range is wide (section 5).

**Quads versus triangles.** The GPU draws triangles only, so quads cost nothing extra at runtime. Quads matter for deformation, subdivision and editing.

- **Retopo in quads.** Quads give clean loops and predictable subdivision.
- **Triangulate once, before baking.** Add a Triangulate modifier (or `mesh.quads_convert_to_tris`) and bake on that mesh, so the bake and the exported triangles share the same diagonals. Triangulating after the bake changes interpolated normals and shows as shading artefacts on a normal map.
- **N-gons only on flat, non-deforming faces,** and triangulate them before export.
- **Triangles are fine** on static props, and at poles, caps and corners of hard-surface parts.

**Edge flow** (what the loops follow):
- Loops follow the form: muscle direction, panel lines, the curvature of a bevel.
- Concentric loops around eyes, mouth, nostrils and any hole or button.
- Bevel hard edges into at least a support loop, or accept a hard edge split, so the silhouette and shading read correctly.
- Even quad size where texture detail is evenly distributed. Densify only where the silhouette curves.
- No long thin triangles. They shade badly and rasterise poorly. Aim for near-equilateral triangles after triangulation.

**Deformation loops** (characters, anything with a skeleton):
- At least 3 loops across a joint (elbow, knee, finger, neck), running perpendicular to the bend. Two loops fold, three can keep volume. Add more at shoulders and hips (guess, check in the bind pose and a 90 degree bend).
- Place loops where skin stretches, not at the joint centre only.
- Keep the topology symmetric across the centre line so weights mirror.
- Face: loops that match the muscle groups for expression (`deformers-blendshapes-morph`). Rig and weights are in `rigging-skeleton-ik`.
- Test the bind pose, the extremes and a twist of each joint before baking. Fix loops now, not after the texture is painted.

**Pole placement.** A pole is a vertex with valence other than 4 (3 or 5 edges, written 3-pole and 5-pole).
- Put poles on flat, low-deformation, low-visibility areas: the back of the head, the top of a shoulder, the middle of a flat panel.
- Never on the silhouette, never on a joint, never in the middle of a high-contrast specular highlight (curved metal, eyes).
- Terminate loops with a pole instead of ending them mid-surface.
- A 5-pole next to a 3-pole is a common pair that redirects loops without changing quad count.

**UVs for the low mesh.** Unwrap after the topology is final (`uv-unwrap-packing`). Put seams on the hard edges and the hidden sides, and keep them on the same edges as the hard shading, so normal-map tangents do not split across a smooth surface.

## 5. Decimation tools

Decimate when the model is static, or as the last step on an already clean retopo (for LODs).

| Tool | Result | Use when | Notes |
|---|---|---|---|
| Blender Decimate modifier, `COLLAPSE` | Triangles, `ratio` of triangles kept, UV seams kept approximately | Static props, scans, a fast first LOD | `use_collapse_triangulate` keeps the triangulation. `use_symmetry` and `vertex_group` bias it. `ratio` is a triangle ratio. Apply the modifier before export |
| Decimate `DISSOLVE` (Planar) | Quads and n-gons survive on flat areas | Hard-surface clean-up, removing coplanar edges | `angle_limit` default about 5 degrees. `use_dissolve_boundaries` to include border edges |
| Decimate `UNSUBDIV` | Reverses a subdivision | Mesh that came from a subdivided base | `iterations` is how many levels |
| QuadriFlow | New clean quad mesh, `target_faces` | Organic sculpts, scans, a first retopo | Keeps nothing of the old UVs. `use_preserve_sharp`, `use_preserve_boundary`, `use_mesh_symmetry` guide it |
| Instant Meshes | Quad or tri mesh, field aligned | Alternative to QuadriFlow, often cleaner loops | External app. Output has no UVs and no materials. Read its README for options |
| `gltf-transform simplify` | Triangles, meshopt based | Last pass on the final GLB, LOD generation | Options below |
| `SimplifyModifier` (three addons) | Triangles, meshopt based in r187 | Runtime LODs, small meshes | Async in r187 (`await modifier.modify(geometry, count)`, where `count` is the number of vertices to remove). Earlier releases were synchronous and used a slower quadric method (verify the pinned revision) |

`gltf-transform simplify` (verified against `@gltf-transform/cli` 4.5.1 `--help`):

```bash
npx @gltf-transform/cli weld in.glb welded.glb
npx @gltf-transform/cli simplify welded.glb lod1.glb --ratio 0.5 --error 0.001 --lock-border true
npx @gltf-transform/cli simplify welded.glb lod2.glb --ratio 0.2 --error 0.005
```

- `--ratio` is the target fraction of vertices to keep (default 0). `--error` is the limit as a fraction of the mesh radius (default 0.0001). The tool stops when the error limit is hit, so a tight `--error` can leave you above the target. State `--error` explicitly.
- Split vertices block the simplifier, so run `weld` first (the tool says so in its help). UV seams are real splits, which is why a heavily cut UV layout simplifies worse. Keep seams to what the texture needs.
- `--lock-border` keeps open borders from shrinking. Use it on meshes that must stay watertight against neighbours or tile.
- Simplify first, then compress. Order is in `gltf-asset-pipeline`.
- Textures do not shrink with the mesh. Check the texture sizes per tier in `performance-budget` at the same time.

**LOD chain** (starting values, tune against silhouette screenshots): LOD0 at 100 percent, LOD1 at about 50, LOD2 at about 20. `THREE.LOD` with `addLevel(object, distance, hysteresis)` (see `performance-budget` section 3). Distance is where the lower level's silhouette error drops under about one pixel. Do not build LOD levels for assets under 2,000 triangles.

## 6. Blender Python: retopo pass

Signatures checked against the current Blender Python API docs: `object.quadriflow_remesh`, `object.voxel_remesh`, `object.multires_subdivide`, `object.modifier_apply`, DecimateModifier (`decimate_type`, `ratio`, `use_collapse_triangulate`), ShrinkwrapModifier (`target`, `wrap_method`, `offset`), `Mesh.remesh_voxel_size`. Not run: Blender is not installed on this machine, and Python syntax was not machine-checked. Test on your Blender version, parameters change between releases.

```python
# blender -b sculpt.blend -P retopo.py -- --faces 8000
import sys, argparse
import bpy

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--faces', type=int, default=8000)        # quad target from the budget table
ap.add_argument('--source', default='Sculpt')             # name of the high-poly object
args = ap.parse_args(argv)

high = bpy.data.objects[args.source]
high.name = high.name + '_high'

# 1. duplicate for the low mesh, keep the high untouched for baking
low = high.copy()
low.data = high.data.copy()
low.name = args.source + '_low'
bpy.context.collection.objects.link(low)

# 2. automatic quad retopo (QuadriFlow works in object mode, on the active object)
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = low
low.select_set(True)
bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=args.faces,
                                 use_mesh_symmetry=True, use_preserve_sharp=True,
                                 use_preserve_boundary=True, smooth_normals=False, seed=0)

# 3. pull the new surface back onto the sculpt
sw = low.modifiers.new('Shrinkwrap', 'SHRINKWRAP')
sw.target = high
sw.wrap_method = 'NEAREST_SURFACEPOINT'
bpy.ops.object.modifier_apply(modifier=sw.name)

# 4. triangulate last, so the bake and the export share one triangulation
tri = low.modifiers.new('Triangulate', 'TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=tri.name)
bpy.ops.wm.save_mainfile()
```

Then fix poles and loops by hand, unwrap (`uv-unwrap-packing`), and bake (`texture-baking-pipeline`). The script is a first pass: for a character, place loops by hand around joints before triangulating.

## 7. Hand-off to texture-baking-pipeline

Give the baker exactly this, or the bake fails in ways that look like texture problems:

| Item | Rule |
|---|---|
| Pair | `<name>_high` and `<name>_low`, same origin, same orientation, same real-world scale, transforms applied |
| Low mesh | Final topology, final UVs, triangulated, hard edges matching seams, no overlapping islands on the bake channel |
| High mesh | Highest sculpt level applied, no interior faces, normals pointing out |
| Distance | Cage or ray distance bigger than the largest gap between low and high, smaller than the gap to neighbouring parts |
| Normal map | Tangent space. Format must match the viewer: Blender and Three.js use the OpenGL (+Y) green channel, so no flip is needed for Three.js (verify with a lit sphere test) |
| Maps | Colour maps `SRGBColorSpace`, data maps (normal, roughness, AO) `NoColorSpace` per `pbr-lookdev` |
| Shading mismatch | If `SimplifyModifier` or a runtime normal recomputation changes shading, the bake no longer matches. Do not recompute normals on a baked low mesh |

Tangent note: Three.js derives a tangent frame in the shader when the mesh has no `tangent` attribute, which can differ from the frame the baker assumed. If a baked normal map shows shading steps across a smooth surface, export tangents or run `gltf-transform tangents` (verify visually, it is listed in `gltf-asset-pipeline`).

## 8. Verify

1. Silhouette: render the high-poly (as a reference GLB) and the low mesh from the hero camera and one orbit shot, flat grey, `render-qa`. The outline must match at the viewing distance the page allows.
2. Wireframe: temporary `material.wireframe = true` screenshot. Look for long thin triangles, dense clusters where nothing is happening, and stray poles on the silhouette.
3. Bend test for deforming meshes: pose the extremes, check loops keep volume and no vertices cross.
4. Budget: `triangleCount(scene)` (section 4) at each tier, or `renderer.info.render.triangles` with the shadow pass on, within the row you chose.
5. Bake check: the low mesh with the baked normal map next to the high-poly under the same light. The shading must agree. Orbit to a grazing angle.
6. Optimise the final file with `gltf-asset-pipeline`, reload it, and re-run steps 1 and 4. Simplify and quantise steps can change shading.
