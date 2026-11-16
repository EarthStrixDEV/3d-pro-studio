---
name: mesh-texture-upscale
description: Increase the effective resolution of meshes and textures in Three.js scenes. Covers mesh subdivision (Loop/Catmull-Clark, three-subdivide, TessellateModifier), displacement and normal-map detail, retopo and bake, texel-density targets, texture upscaling (Lanczos, Real-ESRGAN) with per-map rules for colour, normal, roughness, metalness and AO, tileable seams, detail maps, mips and KTX2 sizing. Use when a model looks faceted or low-poly, silhouettes show polygon edges, textures look blurry, pixelated or smeared up close, or when asked to upscale, subdivide, add detail or raise resolution of a mesh or texture. Thai triggers ขยายความละเอียด, เพิ่มความละเอียด, texture แตก, texture เบลอ, โมเดลเหลี่ยม.
argument-hint: "<mesh or texture file, and where it looks soft>"
---

# Mesh & Texture Upscale

Add resolution only where the camera can see it. Every added triangle or texel costs budget in `performance-budget`.

## 1. Diagnose first

Render the closest camera distance the page allows (`render-qa` with a close orbit), then match the symptom.

| Symptom | Cause | Fix |
|---|---|---|
| Polygon edges on the silhouette | Too few triangles on curved hero surfaces | Section 2: subdivide or re-model |
| Faceted shading, silhouette fine | Flat or missing normals | `mergeVertices` then `computeVertexNormals()`, or bake a normal map |
| Flat surface, no fine relief | No micro-detail | Normal map first, displacement only if the silhouette must change |
| Texture blurry up close | Texel density too low | Section 3: upscale or detail map |
| Texture pixelated or blocky | Magnification filter or tiny source | `magFilter = LinearFilter`, then upscale |
| Texture shimmers at distance | Missing mips or anisotropy | `generateMipmaps`, `minFilter = LinearMipmapLinearFilter`, `anisotropy = max` |
| Seams or visible tile repeat | Upscaled a tileable naively | Seam rule in section 3 |

Do not upscale what the camera never gets close to.

## 2. Mesh resolution

| Method | Use when | Cost |
|---|---|---|
| Raise segments on parametric geometry | Spheres, lathe, tubes, planes you build in code | Cheapest. 64x32 sphere is enough at 1080p |
| Subdivision in Blender (Subdivision Surface, apply) | Organic or hard-surface hero model, smooth silhouette needed | Offline. Best quality. Needs support loops or bevels or the shape shrinks |
| `three-subdivide` at runtime | Procedural or loaded mesh with no DCC step, static, not skinned | Triangles x4 per iteration. Cap iterations at 2 |
| `TessellateModifier` plus displacement | Terrain, fabric, relief where vertices must move | Splits only, does not smooth. Needs non-indexed geometry |
| Retopo then bake to normal map | Real-time target must stay light but look detailed | Best quality per triangle. Offline |

```js
import { LoopSubdivision } from 'three-subdivide';
const smooth = LoopSubdivision.modify(mesh.geometry, 2, {
  split: true, uvSmooth: false, preserveEdges: true, flatOnly: false, maxTriangles: 200000,
});
smooth.computeVertexNormals();
mesh.geometry.dispose();
mesh.geometry = smooth;
```

```js
const geo = new THREE.PlaneGeometry(2, 2, 512, 512);
const mat = new THREE.MeshStandardMaterial({ displacementMap: height, displacementScale: 0.08, displacementBias: -0.04 });
```

Rules:
- **Subdivision smooths, it does not invent detail.** A low-poly cube subdivides into a blob. Add edge loops or bevels where corners must stay sharp, or pass `preserveEdges: true`.
- **Never subdivide skinned or morph-target meshes at runtime.** Weights and morph deltas do not follow. Subdivide in Blender before export.
- **Displacement does not recompute normals or shadows.** Keep the `normalMap` for lighting and set `customDepthMaterial` with the same `displacementMap` so shadows follow the shape.
- **Displacement needs dense vertices.** A 64x64 plane cannot show 4k detail. Match vertex spacing to the map's feature size.
- **Normals after any topology change:** `mergeVertices` (from `BufferGeometryUtils`) then `computeVertexNormals()`. Seams from split UVs show as lighting cracks otherwise.
- **Preserve UVs.** Check `uv` still exists and has no stretch before touching textures. Loop subdivision keeps the layout, tessellation does too, retopo does not.
- **Prefer offline.** Runtime subdivision burns load time and memory on every visit. Subdivide, then optimise with `gltf-asset-pipeline` (`weld`, `simplify`, Meshopt) and ship the result.

Budget math: triangles after N iterations = original x 4^N. Check the product against the tier table in `performance-budget` before running.

## 3. Texture resolution

**Texel density first.** Required pixels = texels per metre x surface length in metres. Pick one density per asset class and hold it across a scene. Starting values (guess, tune against a close screenshot): hero 512 to 1024 px/m, props 256 to 512, background 128. Never exceed the tier caps in `performance-budget` (hero 2048, props 1024, background 512 on mobile).

**Per-map rules.** Upscaling a map the wrong way breaks the material, not just the look.

| Map | Method | Never |
|---|---|---|
| Colour (`map`, `emissiveMap`) | AI upscaler or Lanczos. Resize in linear light | Skip the sRGB tag. Set `SRGBColorSpace` |
| Normal | Re-bake from the high-poly or regenerate from an upscaled height map. If neither exists, cubic resize then renormalise every pixel | AI upscale. Bilinear without renormalising (vectors shorten, shading flattens) |
| Roughness, metalness, AO | Cubic or Lanczos resize. Pack as ORM after | AI upscale. It hallucinates contrast and invents scratches that read as physical |
| Height or displacement | 16-bit source if available, cubic resize | 8-bit stepping on smooth slopes. Add a small blur or use 16-bit |
| Alpha cutout | Resize then re-threshold | Leave soft edges that alias |

Commands (verified flags for ImageMagick 7 and `realesrgan-ncnn-vulkan`):

```bash
magick albedo.png -colorspace RGB -filter Lanczos -resize 200% -colorspace sRGB albedo_2k.png      # colour, linear-light resize
magick rough.png -filter Lanczos -resize 200% rough_2k.png                                          # data map, raw values
realesrgan-ncnn-vulkan -i albedo.png -o albedo_x4.png -n realesrgan-x4plus -s 4                     # photo-like colour only
```

Normal map resize with renormalising:

```js
import sharp from 'sharp';
const { data, info } = await sharp('n.png').resize(w * 2, h * 2, { kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += info.channels) {
  const x = data[i] / 127.5 - 1, y = data[i + 1] / 127.5 - 1, z = data[i + 2] / 127.5 - 1;
  const l = Math.hypot(x, y, z) || 1;
  data[i] = Math.round((x / l * 0.5 + 0.5) * 255);
  data[i + 1] = Math.round((y / l * 0.5 + 0.5) * 255);
  data[i + 2] = Math.round((z / l * 0.5 + 0.5) * 255);
}
await sharp(data, { raw: info }).png().toFile('n_2x.png');
```

Rules:
- **Tileable textures:** tile 3x3, upscale, crop the centre tile. Upscaling the single tile bleeds the border and shows a seam on repeat.
- **AI upscalers invent.** Inspect logos, text, wood grain and fabric weave at 100%. If the invented detail contradicts the material, fall back to Lanczos plus a detail map.
- **Procedural source?** Regenerate at the higher size (`pbr-lookdev` canvas textures) instead of upscaling pixels.
- **Keep the original** next to the upscaled file. Never upscale an upscale.

### Detail map instead of a bigger texture

A small tiling mid-grey noise or grain map multiplied at 8 to 16x frequency adds close-up detail for a few KB. Load it with `RepeatWrapping` and `NoColorSpace` so 0.5 is neutral.

```js
material.onBeforeCompile = (s) => {
  s.uniforms.uDetail = { value: detailTex };
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;')
    .replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.rgb *= texture2D(uDetail, vMapUv * 12.0).rgb * 2.0;`);
};
material.customProgramCacheKey = () => 'detail-v1';
```
Patch rules live in `shader-craft`. Use a triplanar variant for models without clean UVs.

## 4. Deliver

- Texture sides stay multiples of 4, ideally powers of two, so KTX2 compression works. Compress with `gltf-asset-pipeline` after upscaling. KTX2 is the only format that cuts GPU memory.
- Mips on, `anisotropy = renderer.capabilities.getMaxAnisotropy()` on tiled colour maps.
- Serve a lower tier on phones: keep the original 1k set and load the 2k set only when `tier` is high.
- Measure `renderer.info.memory.textures` and the triangle count before and after.

## 5. Verify

1. Screenshot the same close camera before and after (`render-qa`, add one orbit shot at minimum distance).
2. Compare crops at 100%. The upscaled version must show real structure, not smeared or invented detail.
3. Confirm the report: triangles and draw calls inside the tier budget, no colour-space warnings, no new console errors.
4. Orbit to grazing angles. Normal and displacement errors show there first.
