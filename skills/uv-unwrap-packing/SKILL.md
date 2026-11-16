---
name: uv-unwrap-packing
description: UV unwrapping, texel density and island packing for Three.js assets, mapping Blender UV Editor and Maya UV Toolkit workflows to practical rules. Covers seam placement, angle-based versus conformal unwrap, stretch and distortion checks with a checker texture and a numeric density report, uniform texel density, island packing, margin and padding against mip bleeding and KTX2 blocks, a second UV set (`uv1`, `texture.channel`) for lightmaps and `aoMap`, UDIM not existing in glTF (atlas or multi-material instead), UV generation in code (box, planar, triplanar fallback) and a headless Blender Python unwrap and pack script. Use when textures look stretched, smeared or inconsistent in sharpness between parts, when seams or colour bleed show at distance, when baking AO or lightmaps, when a mesh has no UVs, or when asked to unwrap, pack, fix UVs or set texel density. Thai triggers แกะ UV, ยูวี, texture ยืด, ความคมไม่เท่ากัน, แพ็ค UV, รอยต่อ texture, texel density, lightmap UV.
argument-hint: "<mesh or asset, the symptom, and the texture size>"
---

# UV Unwrap & Packing

Textures only look right when UVs spend pixels evenly. Decide the density first, then cut seams, unwrap, pack, and check. Texture sizes and tier caps are in `performance-budget`. Resizing existing textures is `mesh-texture-upscale`.

## 1. Diagnose

Put a checker on the mesh (section 4) before reading any texture.

| Symptom | Cause | Fix |
|---|---|---|
| Checker squares stretched to rectangles | Unwrap distortion, or a projection facing away from the surface | Section 3 (more seams, relax, or re-project) |
| Squares differ in size between parts | Islands at different scale | Section 4: equalise density, then repack |
| Text or arrows mirrored on some faces | Flipped islands (negative UV area) | Flip those islands, or use the box helper in section 7, which never mirrors |
| Colour halos or dark lines on seams at distance | Padding smaller than the mip footprint | Section 5 |
| Lines on seams even up close | Seam sits on a visible surface, or normal map tangents differ across the cut | Move the seam to a hidden edge, bake normals after the final cut |
| Baked AO or lightmap bleeds across parts | Overlapping islands in the baked channel | Section 6: non-overlapping second set |
| Model arrives with no `uv` attribute | Export dropped it, or CAD mesh | Section 7 |

## 2. Concept map

| Blender | Maya | Three.js side |
|---|---|---|
| Mark Seam (`mesh.mark_seam`), Clear Seam | Cut UV Edges, Sew (`polyMapCut`, `polyMapSew`) | Seams become split vertices. Each seam adds vertices, so cut only where needed |
| Unwrap: Angle Based, Conformal, Minimum Stretch | Unfold, Optimize (Unfold3D based, command names `u3dUnfold` and `u3dLayout`, verify in your build) | Nothing to do at runtime. Unwrap offline |
| Smart UV Project | Automatic Mapping (`polyAutoProjection`) | Fast, many small islands, poor for painting. Fine for lightmaps and AO |
| Cube, Cylinder, Sphere, Project from View | Planar, Cylindrical, Spherical projection (`polyPlanarProjection`) | Section 7 for box and planar in code |
| Average Islands Scale, Pack Islands | UV Toolkit Layout (`polyLayoutUV` is the legacy layout command) | Section 5 |
| UV Editor stretch overlay | UV Toolkit distortion shading | Section 4 report |
| UDIM tiles | UDIM tiles | Does not exist in glTF. Section 8 |
| Multiple UV Maps | UV Sets | `uv`, `uv1`, `uv2`... glTF `TEXCOORD_0`, `TEXCOORD_1`. Section 6 |

Maya command names were checked against the Autodesk 2024 command reference except `u3dUnfold` and `u3dLayout`, which that reference did not list (verify).

## 3. Seams and unwrap method

Seam rules:
- **Cut where the eye does not look:** under edges, inside creases, along hard-surface sharp edges, behind the object, along the join of two materials.
- **Cut hard-edge boundaries.** A 90 degree corner needs a seam anyway for flat shading, so cut it, and the island stays undistorted.
- **A cylinder needs one lengthwise seam.** A sphere needs one pole-to-pole seam, or accept pole pinching with a cube-style layout.
- **Fewer, larger islands pack better and bleed less.** Many tiny islands waste padding and show seams. Do not cut every edge.
- **Match the seam to the texture work.** Tiling or trim textures want straight, axis-aligned islands. Hand-painted or baked textures tolerate any shape.

| Method | Use when | Note |
|---|---|---|
| Angle Based (`ANGLE_BASED`) | Organic and general meshes, default choice | Slower, less distortion |
| Conformal (`CONFORMAL`) | Hard-surface, fast preview | Preserves angles, can distort area on curved parts |
| Minimum Stretch (`MINIMUM_STRETCH`) | Relaxing an island that still stretches | Needs iterations. Present in current Blender only (verify your version) |
| Follow Active Quads (`uv.follow_active_quads`) | Straps, planks, tubes, trim | Straightens quad strips, constant width |
| Box or planar projection | Rocks, terrain, blockout, props that get a tiling texture | No seams to hide, but stretch on slanted faces. Section 7 |
| Smart UV Project (`uv.smart_project`) | Lightmap or AO set, throwaway assets | Island count explodes. Not for authored textures |

Distortion goal: the `stretch` value from section 4 stays below about 1.2 on visible surfaces (guess, tune against the checker screenshot). 1.0 is perfect.

## 4. Check: checker texture and density report

A checker catches stretch, mirroring and unequal scale in one screenshot. The report below puts numbers on it. Verified in Node on three r187: a 2 m plane at 1024 px gives 512 px per metre and stretch 1, a 4 by 1 plane gives stretch 4, a box projection gives density 1024 and stretch 1 on all 12 triangles with one UV winding sign.

```js
import * as THREE from 'three';

/** Per triangle: density (texels per world unit) and stretch (largest over smallest scale, 1 = none). */
export function uvReport(geo, texSize, attr = 'uv') {
  const pos = geo.getAttribute('position'), uv = geo.getAttribute(attr), ix = geo.index;
  const n = (ix ? ix.count : pos.count) / 3;
  const q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const t = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  const ss = new THREE.Vector3(), st = new THREE.Vector3();
  const dens = [], stretch = [];
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 3; k++) {
      const i = ix ? ix.getX(f * 3 + k) : f * 3 + k;
      q[k].fromBufferAttribute(pos, i); t[k].fromBufferAttribute(uv, i);
    }
    const A = ((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[2].x - t[0].x) * (t[1].y - t[0].y)) / 2;
    if (Math.abs(A) < 1e-12) { dens.push(Infinity); stretch.push(Infinity); continue; }   // collapsed UV triangle
    // dP/ds and dP/dt, world units per UV unit (Sander et al. 2001)
    ss.set(0, 0, 0).addScaledVector(q[0], t[1].y - t[2].y).addScaledVector(q[1], t[2].y - t[0].y).addScaledVector(q[2], t[0].y - t[1].y).divideScalar(2 * A);
    st.set(0, 0, 0).addScaledVector(q[0], t[2].x - t[1].x).addScaledVector(q[1], t[0].x - t[2].x).addScaledVector(q[2], t[1].x - t[0].x).divideScalar(2 * A);
    const a = ss.dot(ss), b = ss.dot(st), c = st.dot(st), r = Math.sqrt((a - c) ** 2 + 4 * b * b);
    const big = Math.sqrt(0.5 * (a + c + r)), small = Math.sqrt(Math.max(0, 0.5 * (a + c - r)));
    dens.push(small > 0 ? texSize / Math.sqrt(big * small) : Infinity);
    stretch.push(small > 0 ? big / small : Infinity);
  }
  const sorted = (xs) => xs.filter(Number.isFinite).sort((x, y) => x - y);
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const d = sorted(dens), s = sorted(stretch);
  return { triangles: n, degenerate: n - d.length,
    density: { p5: pct(d, 0.05), median: pct(d, 0.5), p95: pct(d, 0.95) },
    stretch: { median: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1] } };
}

/** Checker as a DataTexture: no DOM needed. */
export function checkerTexture(size = 512, cells = 16) {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = ((Math.floor(x * cells / size) + Math.floor(y * cells / size)) & 1) === 0, v = on ? 235 : 55, i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(d, size, size);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.needsUpdate = true;
  return tex;
}
```

Read the report like this:

| Value | Meaning | Act when |
|---|---|---|
| `density.median` | Texels per world unit at this texture size | Compare against the target in section 5 |
| `density.p95 / density.p5` | Spread across the mesh | Above about 2 means parts differ visibly in sharpness. Rescale islands |
| `stretch.p95`, `stretch.max` | Distortion | Above about 1.2 on visible parts, add a seam or relax |
| `degenerate` | Triangles with zero UV area | Greater than 0 means collapsed or unmapped faces. Fix before baking |

Do not compare density between meshes of different texture size, divide by `texSize` first if you do. Mirrored islands are not flagged here: they keep area and stretch. Spot them on the checker with an asymmetric mark, or compare the sign of `A` per triangle.

Apply it: `material.map = checkerTexture(); mesh.material.needsUpdate = true;`, then screenshot with `render-qa` from two angles.

## 5. Texel density and packing

**Set one density per asset class** and hold it: pixels per metre = texture side / the world length one full tile covers. Starting values and the tier caps (hero 2048, props 1024, background 512 on mobile) are in `mesh-texture-upscale` section 3 and `performance-budget`. Hand-tune only where the camera gets close.

Pack in this order: unwrap, equalise scale (Blender `uv.average_islands_scale`), then pack. Packing before equalising wastes the sheet on over-scaled islands.

**Padding against mip bleeding.** At mip level k one texel covers 2^k source texels, so neighbours blend once the gap is under 2^k texels. Padding in pixels = 2^(mips that matter), with 4 as the floor because KTX2 (UASTC, ETC1S) compresses in 4 by 4 blocks.

| Texture side | Smallest mip you care about | Padding |
|---|---|---|
| 512 | Mip 2 | 4 px |
| 1024 | Mip 3 | 8 px |
| 2048 | Mip 4 | 16 px |

Blender takes the margin as a UV fraction: `margin = padding_px / texture_side` (8 px on 1024 is 0.0078125). Use `margin_method='FRACTION'` so the number is the final gap, not a multiplier (section 9). Then dilate the baked or painted colour outward past the island edge by the same padding (bake margin in Blender, or "Edge padding" in the painting tool), or the empty space samples as black.

Packing rules:
- **Rotate with `rotate_method='CARDINAL'`** (90 degrees only) when the texture has directional detail (wood grain, brushed metal, text). Free rotation (`ANY`) packs tighter but breaks grain.
- **Straighten islands** that carry grain or trim (`uv.align_rotation` exists in the current operator list, options not checked), so they pack in clean rows.
- **Merge overlap on purpose.** Mirrored halves can share UV space (symmetric painting) but not in any baked channel. See section 6.
- **Utilisation target** about 80 to 90 percent. Below 70 percent the texture size is wasted: shrink the sheet, or move small props to a shared atlas.
- **Tiling textures break the rule:** islands stay inside 0 to 1 only when baked. Tiling trim sheets and terrain use UVs beyond 1 on purpose, with `RepeatWrapping`.

## 6. Second UV set for lightmaps and `aoMap`

A baked channel (AO, lightmap) must have unique, non-overlapping texels for every surface. The authored colour layout often reuses space (mirrored halves, tiling, trim sheets), so use a second set.

Three.js side (verified in r187 source): every map has `texture.channel`, an integer. `0` reads attribute `uv`, `1` reads `uv1`, `2` reads `uv2`. Per-material maps such as `aoMap` and `lightMap` use `aoMap.channel` and `lightMap.channel`. Older releases named the attribute `uv2` (verify the pinned revision).

```js
geometry.setAttribute('uv1', bakedLayout);        // second UV set, 0..1, no overlap
aoTex.channel = 1;                                // aoMap reads uv1
material.aoMap = aoTex;                           // R channel, linear, NoColorSpace
lightTex.channel = 1;                             // lightMap, also uv1, colour data: SRGBColorSpace for baked colour
material.lightMap = lightTex; material.lightMapIntensity = 1;
```

| Question | Answer |
|---|---|
| Does `pbr-lookdev` say no second set is needed for `aoMap`? | Only when AO shares the colour layout. Baked AO with overlapping islands needs `channel = 1` |
| Which channel for an ORM texture? | ORM with R occlusion, G roughness, B metalness is one image. glTF lets `occlusionTexture.texCoord` differ from the others |
| Do two maps share one `Texture` with different channels? | No. `channel` is per `Texture` object. `GLTFLoader` clones the texture when `texCoord > 0` (verified in source). Do the same: `tex.clone()` shares the image |
| Does glTF carry a lightmap? | No core or loader extension for lightmaps (none in the r187 loader extension list). Assign `lightMap` and `channel` in code after load |
| `aoMap` in glTF? | Yes: `occlusionTexture` with `texCoord: 1`. `GLTFLoader` maps it to `aoMap` and sets `channel` from `texCoord` |
| Split UV attributes survive the optimiser? | Run `gltf-asset-pipeline` then inspect the output: `TEXCOORD_1` must still be listed (verify with `inspect`) |

Generating the second set: unwrap again with Smart UV Project or Lightmap Pack for a quick result, or reuse the main set when it is already non-overlapping. Baking itself is `texture-baking-pipeline`. For a prototype without a bake, copy `uv` into `uv1`:

```js
geometry.setAttribute('uv1', geometry.getAttribute('uv').clone());
```

Do not apply a `lightMap` to a mesh with overlapping `uv1`: light from one part appears on another.

## 7. Generate UVs in code

Use when a mesh has no `uv`, for CAD imports, procedural geometry, and blockout. Verified in Node on r187 (see section 4 results, density 1024, stretch 1, one winding sign).

```js
const BOX_AXES = {   // [U axis, V axis] per dominant normal, signs chosen so U x V = N, so nothing is mirrored
  '+x': [[0, 0, -1], [0, 1, 0]], '-x': [[0, 0, 1], [0, 1, 0]],
  '+y': [[1, 0, 0], [0, 0, -1]], '-y': [[1, 0, 0], [0, 0, 1]],
  '+z': [[1, 0, 0], [0, 1, 0]], '-z': [[-1, 0, 0], [0, 1, 0]],
};
/** One UV per face from its dominant axis. metresPerTile sets the density. Returns non-indexed geometry. */
export function boxProjectUV(geo, metresPerTile = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const p = g.getAttribute('position'), uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const key = ax >= ay && ax >= az ? (n.x < 0 ? '-x' : '+x') : ay >= az ? (n.y < 0 ? '-y' : '+y') : (n.z < 0 ? '-z' : '+z');
    const [U, V] = BOX_AXES[key];
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(p, i + k);
      uv[(i + k) * 2] = (v.x * U[0] + v.y * U[1] + v.z * U[2]) / metresPerTile;
      uv[(i + k) * 2 + 1] = (v.x * V[0] + v.y * V[1] + v.z * V[2]) / metresPerTile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
```

| Method | Use when | Limit |
|---|---|---|
| Planar (`u = x / s`, `v = z / s`, drop the third axis) | Terrain, floors, decals, a single dominant facing | Stretches on slopes. Fine for a heightfield seen from above |
| Box (above) | Props, rocks, buildings, blockout | Seams show where the dominant axis flips. Hide with a noisy or tiling texture. The result is non-indexed, `mergeVertices` is not safe across the seams, so leave it |
| Cylindrical or spherical (`u = atan2(z, x) / (2 PI) + 0.5`) | Pipes, bottles, planets | A seam column where `u` wraps needs duplicated vertices, or you get a smear across one triangle strip |
| Triplanar in the shader | No UVs, or box seams unacceptable, organic rocks and terrain | Three texture fetches per map. Snippet in `shader-craft` `references/glsl-snippets.md`. Normal maps need a blend that swizzles per axis, not a plain sum |

Generated UVs fit tiling textures. For baked or painted textures, unwrap offline. Regenerate `uv` before adding tangents or a normal map, because tangents depend on the final UVs.

## 8. UDIM does not exist in glTF

glTF has one 0 to 1 UV space per texture, with no tile numbering. The Blender exporter manual says that for a UDIM material it splits the image into one image per tile and updates the material nodes, and that all UDIM textures must share one UV map. Do not lean on it: decide the layout yourself, then check the result (verify what your version does to the mesh). Choose:

| Option | Use when | Cost |
|---|---|---|
| Atlas into one 0 to 1 sheet | Prop or character that fits one 2k to 4k sheet at target density | Lower density per part. Best for draw calls |
| Split the mesh by tile into separate materials | A hero that needs 4k per part | One draw call per material. Merge parts that share a tile |
| Several texture sets, one per material slot | Large vehicles, buildings | Same as above. Keep set count under the draw call budget in `performance-budget` |
| Virtual texturing | Not practical in Three.js | Skip |

From a UDIM source, bake each tile to its own image at the target density (`texture-baking-pipeline`), then repack or keep them as separate materials.

## 9. Blender Python: unwrap and pack

Signatures checked against the current Blender Python API docs (`uv.unwrap`, `uv.smart_project`, `uv.average_islands_scale`, `uv.pack_islands`, `mesh.mark_seam`, `mesh.select_all`, `object.mode_set`, `ToolSettings.use_uv_select_sync`). Parameters differ between Blender versions, so run it against your own build first. Not run here, Blender is not installed on this machine, and Python syntax was not machine-checked.

```python
# blender -b model.blend -P unwrap_pack.py -- --size 2048 --pad 16
import sys, math, argparse
import bpy

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--size', type=int, default=2048)       # target texture side in px
ap.add_argument('--pad', type=int, default=8)           # padding in px, see section 5
ap.add_argument('--method', default='ANGLE_BASED')      # ANGLE_BASED | CONFORMAL
ap.add_argument('--smart', action='store_true')         # Smart UV Project instead of seams
ap.add_argument('--angle', type=float, default=66.0)    # smart project angle limit in degrees
args = ap.parse_args(argv)
margin = args.pad / args.size                           # FRACTION margin = final gap as a UV fraction

bpy.context.tool_settings.use_uv_select_sync = True     # mesh selection drives UV selection

for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    if args.smart:
        bpy.ops.uv.smart_project(angle_limit=math.radians(args.angle), margin_method='FRACTION',
                                 island_margin=margin, area_weight=0.0, correct_aspect=True,
                                 scale_to_bounds=False)
    else:
        # uses the seams already marked on the mesh (mesh.mark_seam)
        bpy.ops.uv.unwrap(method=args.method, fill_holes=True, correct_aspect=True,
                          margin_method='FRACTION', margin=margin)
    bpy.ops.uv.average_islands_scale()                  # uniform texel density across islands
    bpy.ops.uv.pack_islands(rotate=True, rotate_method='CARDINAL', margin_method='FRACTION',
                            margin=margin, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.wm.save_mainfile()
```

Second UV set for AO and lightmaps, added before the loop body above leaves edit mode:

```python
me = obj.data
lm = me.uv_layers.new(name='UVMap_lightmap')            # becomes the second layer, so TEXCOORD_1 on export
me.uv_layers.active = lm
bpy.ops.uv.lightmap_pack(PREF_CONTEXT='ALL_FACES', PREF_PACK_IN_ONE=True, PREF_NEW_UVLAYER=False,
                         PREF_BOX_DIV=12, PREF_MARGIN_DIV=0.1)
me.uv_layers.active = me.uv_layers[0]                   # restore the colour layout as active
```

Notes:
- `margin_method='SCALED'` (the default) multiplies the margin by existing UV scale. Use `FRACTION` for a pixel-exact gap.
- `use_original_bounds`, `scale` and `merge_overlap` options exist on `uv.pack_islands` and `uv.unwrap`. Leave them at defaults unless you need them.
- Blender has no built-in texel density readout in the versions this was checked against (verify, add-ons for it are common). Use `uvReport` from section 4 after export.
- A material reaches `TEXCOORD_1` only if one of its image textures reads that UV map through a UV Map node. Confirm with `npx @gltf-transform/cli inspect model.glb` (verify the attribute column shows `TEXCOORD_1`). Export settings are in `blender-to-three-export`.

## 10. Verify

1. Render the checker (section 4) with `render-qa` from two angles. No stretched cells, no mirrored marks, equal cell size across parts.
2. `uvReport` on the loaded geometry: `density.p95 / density.p5` below 2, `stretch.p95` below about 1.2, `degenerate` equal to 0.
3. Orbit to the maximum distance with mips on: no halo or dark line along seams. If present, raise padding per section 5 and dilate the baked colour.
4. For a baked set: the same mesh with `aoMap` only, `aoMapIntensity = 1`, shows no shadow from one part on another.
5. After optimisation with `gltf-asset-pipeline`, reload and run steps 1 and 2 again. Weld and quantise steps can change UVs.
