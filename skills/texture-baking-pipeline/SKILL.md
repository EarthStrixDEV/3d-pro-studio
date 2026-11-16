---
name: texture-baking-pipeline
description: Bake detail and lighting into textures for Three.js, translating Blender Cycles Bake and Maya Transfer Maps into a web pipeline. Covers high-to-low poly bakes (tangent-space normal, AO, curvature, thickness, ID masks), cage and ray distance, lightmaps, packing ORM, a Blender bpy bake outline, normal map conventions (OpenGL versus DirectX green channel, MikkTSpace tangent basis mismatch and how to detect it), runtime baking in Three.js when feasible, padding and bleeding, and a before and after close crop check. Use when a low-poly model must look like a high-poly one, normal maps look inverted or seamed, bakes show holes, spikes or black seams, AO or lightmaps must be baked, or when asked to bake, transfer maps, pack textures or make an ORM map. Thai triggers เบคเท็กซ์เจอร์, เบค normal map, เบค AO, ถ่ายโอนดีเทลจากโมเดลหนักไปเบา, แพ็ค ORM, แสงบนเท็กซ์เจอร์.
argument-hint: "<low-poly mesh, high-poly source if any, and which maps are needed>"
---

# Texture Baking Pipeline

Bake once offline, ship small. A baked map moves cost from every frame to one build step. Budgets live in `performance-budget`, material setup in `pbr-lookdev`, delivery in `gltf-asset-pipeline`.

Status of this skill: the node and Three.js samples were run (three r187, `three-mesh-bvh`, `sharp`). The Blender `bpy` outline and every Maya menu name were not run (no DCC installed), so they carry `(verify)`.

## 1. Pick the bake

| Need | Blender Cycles Bake | Maya | Runtime in Three.js | Colour space |
|---|---|---|---|---|
| Detail of a high-poly on a light mesh | `NORMAL`, selected to active | Transfer Maps, normal output (verify menu: Lighting/Shading) | No. Offline | Data (`NoColorSpace`) |
| Crevice darkening | `AO` | Transfer Maps or Arnold render to texture (verify) | Vertex AO with a BVH, section 6 | Data |
| Edge wear, dirt masks | Curvature via Geometry node `Pointiness`, bake `EMIT` (Cycles only, verify) | Arnold curvature shader, bake (verify) | Screen-space only, not a texture | Data |
| Thickness, subsurface, backlit leaves | AO node with `Inside` ticked, bake `EMIT` (verify) | Arnold ambient occlusion inverted (verify) | Back-face depth pass, see `render-passes-aov` | Data |
| Region masks (ID) | Flat unique-colour emission per region, bake `EMIT` | Flat colours, bake | Not needed, use vertex colours or `userData` | Data, no mips |
| Static light and shadow | `DIFFUSE` with only Direct and Indirect ticked, or `COMBINED` for a lightmap | Arnold render to texture (verify) | Path-traced lightmap, see `raytracing-light-transport` | Linear HDR |
| Roughness, metalness packing | Bake `ROUGHNESS`, metalness through emission | Same | `sharp` or canvas, section 5 | Data |

Rules:
- **Bake irradiance, not albedo, into lightmaps.** The material multiplies by albedo, so baked colour applies twice (details in `raytracing-light-transport`).
- **Do not bake what the runtime already computes.** Direct light from a movable key light stays dynamic. Bake ambient, bounce and AO.
- **One UV set per purpose.** Textures on `uv`, lightmap on a second non-overlapping set read through `texture.channel = 1`. Layout rules: `uv-unwrap-packing`.

## 2. Setup that decides the result

1. **Match the mesh you ship.** Apply modifiers, triangulate the low-poly before baking, and export the same triangulation. A bake on quads viewed on a different triangulation shades differently along the diagonals.
2. **Hard edges need UV seams.** A smoothing split without a UV split streaks the normal map along the edge. Split both or neither.
3. **Cage and ray distance** control which surface each texel samples.

| Symptom | Cause | Fix |
|---|---|---|
| Flat or empty patches, missing detail | Ray distance or cage extrusion too small, rays miss the high-poly | Raise `max_ray_distance` or `cage_extrusion` in small steps |
| Spikes, ghost shapes, detail from a neighbouring part | Distance too large, rays hit another part | Lower it, or move parts apart in an exploded bake group |
| Detail skewed on curved or thin parts | Rays fan out because the cage is not smooth | Use a cage object (a slightly inflated copy of the low-poly) |
| Black seam lines at island borders | Margin too small, or sampling outside the island | Section 7 |

4. **Samples.** AO, curvature and thickness need 64 to 256 samples to clean the noise. Normal and ID bakes need 1 to 16 because they are deterministic.
5. **Bake in a neutral state.** Hide the ground plane and anything not part of the asset, or AO picks up the room.
6. **Resolution.** Choose texel density first (`mesh-texture-upscale` section 3), then size the map. Bake at the final size or 2x and downsample with Lanczos. Never upscale a bake.

## 3. Blender bpy outline (not run, verify against your Blender version)

Bake property locations moved between Blender releases. Check each name in the Python console with `bpy.context.scene.render.bake` before relying on it.

```python
import bpy
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64                       # AO and lightmaps. Normal and ID can use 1 to 8

bake = scene.render.bake
bake.use_selected_to_active = True              # high-poly selected, low-poly active
bake.cage_extrusion = 0.02                      # scene units, used when no cage object
bake.max_ray_distance = 0.05
bake.use_cage = False                           # True plus bake.cage_object = <inflated copy>
bake.margin = 16                                # pixels of padding
bake.margin_type = 'EXTEND'
bake.normal_space = 'TANGENT'
bake.normal_r, bake.normal_g, bake.normal_b = 'POS_X', 'POS_Y', 'POS_Z'   # OpenGL. DirectX: normal_g = 'NEG_Y'

low, high = bpy.data.objects['asset_low'], bpy.data.objects['asset_high']
img = bpy.data.images.new('asset_normal', 2048, 2048, alpha=False, float_buffer=False)
img.colorspace_settings.name = 'Non-Color'      # data, never sRGB

mat = low.active_material                       # needs an Image Texture node set active in the low-poly material
node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = img
mat.node_tree.nodes.active = node

for o in bpy.context.selected_objects: o.select_set(False)
high.select_set(True); low.select_set(True)
bpy.context.view_layer.objects.active = low
bpy.ops.object.bake(type='NORMAL')              # also 'AO', 'EMIT', 'DIFFUSE', 'ROUGHNESS'

img.filepath_raw = '//asset_normal.png'; img.file_format = 'PNG'; img.save()
```

Run headless in CI: `blender -b scene.blend -P bake.py`. Bake one map per run, save each, then pack (section 5).

Maya: Transfer Maps takes target meshes (low-poly) and source meshes (high-poly) with a search envelope that plays the cage role (verify names and menu path in your Maya version). Arnold has its own render-to-texture route (verify). Both follow the same distance rules in section 2.

## 4. Normal map conventions

| Convention | Green channel | Used by |
|---|---|---|
| OpenGL (+Y up) | Lit from above means brighter green | Blender, glTF, Three.js, Substance default |
| DirectX (-Y) | Inverted green | Unreal, DirectX tools, some texture libraries |

Three.js reads glTF normal maps as OpenGL. For a DirectX map you cannot re-bake, set `material.normalScale.set(1, -1)` (verify on your revision) or flip green offline. Prefer flipping offline so every consumer agrees.

**Detect the convention when you have the height map.** Correlate the green channel with the height gradient that points up in the image. Verified on a synthetic bump: OpenGL gave +0.999, DirectX gave -0.999, and flipping green restored +0.999.

```js
// rgb: raw 8-bit RGB buffer, h(x, y): height lookup with row 0 at the top of the image
function greenCorrelation(rgb, N, h) {
  let sxy = 0, sxx = 0, syy = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const g = rgb[(y * N + x) * 3 + 1] / 127.5 - 1;
    const up = -(h(x, y - 1) - h(x, y + 1));          // negative slope toward the top means the surface faces up
    sxy += g * up; sxx += g * g; syy += up * up;
  }
  return sxy / Math.sqrt(sxx * syy);                  // above 0 is OpenGL, below 0 is DirectX
}
// flip: for (let i = 1; i < buf.length; i += 3) buf[i] = 255 - buf[i];
```

**Without a height map**, put the map on a plane with a bump, light it from above (key at high +Y) and look: a raised bump must be bright on its top edge. Dark on top means DirectX.

**MikkTSpace mismatch.** A tangent-space map is only valid in the tangent basis it was baked in. Blender bakes with MikkTSpace on the low-poly's UVs and triangulation. Three.js uses the `tangent` attribute when the geometry has one, otherwise it derives a basis per pixel from UV derivatives (verify in your revision), which agrees with MikkTSpace on clean UVs and drifts on mirrored, sheared or hard-shaded islands.

| Symptom | Likely cause |
|---|---|
| Lit side flips on mirrored islands only | Handedness differs between bake and viewer |
| Faint seams or steps along island borders | Basis differs across the seam, or smoothing split without UV split |
| Detail correct from one light angle, inverted from another | Green channel convention, not the basis |
| Whole map looks inverted | Green channel convention |

Detect it by A/B: render the high-poly in Blender (or in Three.js) and the low-poly plus map under the same single light and camera, then compare the same crop island by island, mirrored islands included. Fix by shipping tangents computed by the same tool that baked: export tangents from Blender's glTF exporter (option `export_tangents`, verify) or run `gltf-transform tangents` (`gltf-asset-pipeline` section 2), and keep the triangulation unchanged after that. Do not run `weld` or `simplify` after baking tangents, they change the basis.

## 5. Pack to ORM

R = AO, G = roughness, B = metalness, the glTF layout from `pbr-lookdev`. One texture fetch instead of three. Assign the same texture to `aoMap`, `roughnessMap` and `metalnessMap`. Verified with `sharp`:

```js
import sharp from 'sharp';
async function packORM(aoPath, roughPath, metalPath, outPath) {
  const grey = (p) => sharp(p).greyscale().raw().toBuffer({ resolveWithObject: true });
  const [a, r, m] = await Promise.all([grey(aoPath), grey(roughPath), grey(metalPath)]);
  const { width, height } = a.info;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) { out[i * 3] = a.data[i]; out[i * 3 + 1] = r.data[i]; out[i * 3 + 2] = m.data[i]; }
  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(outPath);
}
```

Rules:
- All three inputs must be the same size. Resize first with the per-map rules in `mesh-texture-upscale`.
- Do not use `joinChannel` with PNG buffers: it decoded a grey PNG as three channels and produced a 7 channel result with wrong data in the test. Read raw grey channels and interleave as above.
- No metalness map? Fill B with 0 for dielectrics and ship the AO and roughness anyway. A packed texture with a constant channel still saves two fetches.
- Colour space is `NoColorSpace`. GLTFLoader sets it correctly when the ORM is referenced as `metallicRoughnessTexture` and `occlusionTexture`.
- Keep ORM 8-bit PNG for sources, compress to KTX2 UAST for the data slots through `gltf-asset-pipeline`.

## 6. Baking at runtime in Three.js

Feasible only for cheap, per-vertex or per-frame-budget work. Everything else belongs offline.

| Bake | Runtime verdict |
|---|---|
| AO per vertex (BVH raycasts) | Feasible for procedural or user-loaded meshes up to roughly 50k vertices. Verified sample below |
| Normal map from a height map | Feasible, a Sobel pass in a fragment shader or one render to a `WebGLRenderTarget` |
| ORM pack | Feasible with a fullscreen quad into a render target. Offline is simpler |
| Lightmap | Heavy. Use `three-gpu-pathtracer` to render progressive samples into UV space (verify it ships a lightmap example), or bake offline |
| High-to-low normal bake | Not worth building. Use Blender |

Vertex AO sample (verified in node with three r187 and `three-mesh-bvh`; a crease vertex scored 0.27, open vertices 0.94 to 0.95):

```js
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

function bakeVertexAO(mesh, { rays = 64, maxDist = 0.5, bias = 1e-3 } = {}) {
  const geo = mesh.geometry; geo.computeBoundsTree();
  const pos = geo.attributes.position, nor = geo.attributes.normal, ao = new Float32Array(pos.count * 3);
  const rc = new THREE.Raycaster(); rc.firstHitOnly = true; rc.far = maxDist;
  const p = new THREE.Vector3(), n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i); n.fromBufferAttribute(nor, i).normalize();
    t.set(Math.abs(n.x) > 0.9 ? 0 : 1, Math.abs(n.x) > 0.9 ? 1 : 0, 0).cross(n).normalize(); b.crossVectors(n, t);
    let hit = 0;
    for (let k = 0; k < rays; k++) {                                   // cosine weighted hemisphere, golden angle spiral
      const u = (k + 0.5) / rays, a = k * 2.399963229728653, r = Math.sqrt(u), z = Math.sqrt(1 - u);
      d.set(0, 0, 0).addScaledVector(t, r * Math.cos(a)).addScaledVector(b, r * Math.sin(a)).addScaledVector(n, z);
      rc.set(p.clone().addScaledVector(n, bias), d);
      if (rc.intersectObject(mesh, false).length) hit++;
    }
    ao[i * 3] = ao[i * 3 + 1] = ao[i * 3 + 2] = 1 - hit / rays;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(ao, 3));
  geo.disposeBoundsTree();
}
// use: new THREE.MeshStandardMaterial({ vertexColors: true }). Vertex colour multiplies albedo, so AO must stay mild (maxDist small).
```

Rules: needs vertex normals and enough vertices where occlusion changes (subdivide first, `mesh-texture-upscale`). Run in a worker or in chunks for big meshes. Vertex colour multiplies base colour, not just ambient light, so keep it subtle or move the AO to `aoMap` for correct ambient-only occlusion.

## 7. Padding and bleeding

Texels outside an island are empty. Mip levels, bilinear filtering and block compression all sample across the border, so empty texels bleed black or the neighbour island's colour into the surface.

| Map size | Margin (starting values, tune on a close crop) |
|---|---|
| 512 | 4 to 8 px |
| 1024 | 8 to 16 px |
| 2048 | 16 to 32 px |
| 4096 | 32 px |

- **Margin type.** `EXTEND` copies the edge outward and suits most bakes. Normal maps with high contrast at borders sometimes prefer `ADJACENT_FACES` (verify). Both are settings of the bake panel.
- **Leave gaps between islands** at least as wide as the margin. Gap rules and packing are in `uv-unwrap-packing`.
- **Island borders must not touch a mirrored neighbour** with different data. Mirrored islands share texels on purpose, which is fine for symmetric detail and wrong for text, dirt or directional wear.
- **ID masks:** no mips and `NearestFilter`, otherwise every border blends two IDs into a third.
- **KTX2 and UASTC blocks are 4x4.** Keep margins at 4 px or more so a block never contains two unrelated islands.
- **Alpha cutouts:** dilate colour under the transparent area, or the fringe shows the wrong colour at distance.

## 8. Verify with a before and after close crop

1. Render the reference: the high-poly (Blender render, or the high-poly GLB in Three.js) from a fixed camera and a fixed single light.
2. Render the low-poly plus baked maps from the same camera and light with `render-qa` (add a close orbit shot, 1280x720).
3. Crop the same region at 100 percent from both images and place them side by side. Judge in this order: silhouette (expected to differ, the bake cannot change it), shading direction on every island, seams at borders, AO placement, noise.
4. Diff numerically if ImageMagick is available (not run here): `magick compare -metric RMSE ref.png low.png diff.png`. A global RMSE is a weak signal, look at the diff image for localised seams.
5. Orbit to grazing angles and to the far distance. Normal and padding errors show there first (shimmer causes are in `antialiasing-resolution`).
6. Run `render-qa` and confirm: no colour-space warning (data maps are not sRGB), texture memory inside the tier, no new console errors.
7. Max 3 fix loops, then report what remains.

## 9. Deliver

- Compress with `gltf-asset-pipeline`: UASTC for normal and ORM slots, ETC1S for colour. KTX2 is the only format that cuts GPU memory.
- Keep the source bakes (PNG or EXR) next to the GLB. Re-baking is expensive, compressed files are lossy.
- Ship a lower tier set on phones (`performance-budget`): 1k bakes instead of 2k.
