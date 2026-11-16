---
name: sim-cache-baking-vat
description: Bring offline simulation to the web in Three.js with baked caches. Covers vertex animation textures (VAT) for soft body, cloth, fluid particles and destruction, point caches and Alembic-style data converted to compact binary, Houdini and Blender export routes, texture encoding precision (half float versus 8-bit, normalisation ranges), playback shaders that patch standard materials, streaming long caches in chunks, compression with Meshopt, brotli or KTX2 with zstd, and memory budgets. Includes a verified bake and VAT playback sample. Use when a Houdini or Blender simulation must play in the browser, when a runtime sim is too heavy, when cloth, soft body, shatter or fluid needs to loop deterministically, or when a cache is too big to ship. Thai triggers แปลงซิมูเลชันเป็นเว็บ, เบค vertex animation texture, VAT, point cache, Alembic, เบคเอฟเฟกต์ผ้า, เบคการแตกกระจาย, แคชของเหลว, ขนาดไฟล์แคช.
argument-hint: "<simulation type, vertex or particle count, frame count, and target device tier>"
---

# Sim Cache Baking & VAT

Run the simulation offline, store the result per frame, and let the browser only play it back. Runtime alternatives are in `soft-body-xpbd`, `rigid-destruction-fracture`, `fluid-sph-3d`, `granular-sand-snow-sim` and `grid-fluid-smoke`. Choose a bake when the result is the same every time and nothing in the scene must change it. Export of the rest mesh is in `blender-to-three-export`, compression in `gltf-asset-pipeline`.

## 1. Pick the technique

| Source | Method | Data per frame | Notes |
|---|---|---|---|
| Cloth, soft body, jelly, deforming mesh with fixed topology | **Soft VAT** (verified below) | 1 texel per vertex: position, plus normal | Vertex count and order must never change |
| Destruction, shatter, rigid pieces | **Rigid VAT** (design, not run) | 2 texels per piece: position, quaternion. Vertices carry a piece id and a pivot | Tiny data. Interpolate rotation with slerp, not lerp |
| Fluid or granular particles | **Point cache** | 1 texel per particle, read by `gl_InstanceID` for instanced quads | Same bake, a different vertex stage (`particle-rendering-blending`) |
| Fluid surface mesh with changing topology | Not VAT. Render the particles (`fluid-sph-3d`), or stream a mesh per frame | Topology differs each frame | Padding to a maximum count is possible but wasteful (verify with your DCC) |
| Smoke, fire, volumes | Flipbook or 3D texture sequence, not VAT | Images | `vfx-flipbook-authoring`, `grid-fluid-smoke` |
| Character or rigid motion | Bones, not VAT | | `rigging-skeleton-ik` |

## 2. Export routes (names unverified)

| Route | How |
|---|---|
| Houdini, ready made | SideFX Labs vertex animation texture tool (soft, rigid, fluid and sprite modes) (verify tool and mode names, version dependent) |
| Houdini, own | Cache points per frame (Geometry ROP, bgeo or Alembic), then convert with a script into the float array of section 3 |
| Blender | No built in VAT exporter. Mesh Cache export (MDD, PC2) or Alembic export (verify menu names), or the Python snippet below. Add-ons exist, evaluate each one (verify) |
| Alembic | three.js has no Alembic loader. Read it in Houdini or Blender and write float arrays (verify any Python Alembic library) |

Blender Python, not run here (verify):

```python
import bpy, numpy as np
obj, scn, frames = bpy.context.active_object, bpy.context.scene, []
for f in range(scn.frame_start, scn.frame_end + 1):
    scn.frame_set(f)
    ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = ev.to_mesh()
    a = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', a)                  # object space, apply obj.matrix_world for world space
    frames.append(a); ev.to_mesh_clear()
np.stack(frames).tofile('cache_f32.bin')              # frames x vertices x 3 float32, little endian
```

**Vertex order is the contract.** Playback reads the cache with `gl_VertexID`, the index of the vertex in the mesh three.js draws. glTF exporters split vertices at UV seams and hard edges, so the exported count and order can differ from the simulated mesh. Triangulate before the sim, export the rest mesh once, and bake the cache from that exact mesh (match by position if you must remap). Then confirm: frame 0 of the VAT must equal the rest mesh.

## 3. Bake and playback (verified)

One file: CPU bake into `DataTexture` data, a runtime that creates the textures, and a patch that works on `MeshStandardMaterial`, `MeshPhysicalMaterial` and `MeshDepthMaterial` (shadows).

```js
import * as THREE from 'three';

// ---- Bake (offline, Node or browser). frames: Float32Array[] of xyz per vertex, index: triangle list ----
export function computeNormals(p, index) {
  const n = new Float32Array(p.length);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;   // area weighted face normal
    for (const i of [a, b, c]) { n[i] += x; n[i + 1] += y; n[i + 2] += z; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

// THREE.DataUtils.toHalfFloat truncates (checked in 0.187 source), this picks the nearest half float instead: half the error
const toHalf = (u) => { const h = THREE.DataUtils.toHalfFloat(u); return Math.abs(THREE.DataUtils.fromHalfFloat(h + 1) - u) < Math.abs(u - THREE.DataUtils.fromHalfFloat(h)) ? h + 1 : h; };

export function bakeVat(frames, index, { encoding = 'f16', maxWidth = 2048 } = {}) {
  const nV = frames[0].length / 3, nF = frames.length;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const f of frames) for (let i = 0; i < f.length; i++) { const k = i % 3; if (f[i] < min[k]) min[k] = f[i]; if (f[i] > max[k]) max[k] = f[i]; }
  for (let k = 0; k < 3; k++) if (max[k] - min[k] < 1e-6) max[k] = min[k] + 1e-6;   // flat axis: avoid divide by zero
  const rows = Math.ceil(nV / maxWidth), width = Math.ceil(nV / rows), height = rows * nF;   // smallest width that keeps the row count: padding stays under one row
  const pos = encoding === 'f16' ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  const nrm = new Uint8Array(width * height * 4);
  const one = encoding === 'f16' ? THREE.DataUtils.toHalfFloat(1) : 255;
  frames.forEach((f, fi) => {
    const nn = computeNormals(f, index);
    for (let v = 0; v < nV; v++) {
      const o = ((fi * rows + Math.floor(v / width)) * width + (v % width)) * 4;   // same addressing as the shader
      for (let k = 0; k < 3; k++) {
        const u = (f[v * 3 + k] - min[k]) / (max[k] - min[k]);                     // 0..1 inside the global bounds
        pos[o + k] = encoding === 'f16' ? toHalf(u) : Math.round(u * 255);
        nrm[o + k] = Math.round((nn[v * 3 + k] * 0.5 + 0.5) * 255);
      }
      pos[o + 3] = one; nrm[o + 3] = 255;
    }
  });
  return { pos, nrm, min, max, width, rows, frames: nF, vertices: nV, encoding };
}

// ---- Runtime ----
export function createVat(b) {
  const make = (data, type) => {
    const t = new THREE.DataTexture(data, b.width, b.rows * b.frames, THREE.RGBAFormat, type);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;   // never filter across vertices
    return t;
  };
  return {
    pos: make(b.pos, b.encoding === 'f16' ? THREE.HalfFloatType : THREE.UnsignedByteType),
    nrm: make(b.nrm, THREE.UnsignedByteType),
    uniforms: {
      uVatMin: { value: new THREE.Vector3(...b.min) }, uVatMax: { value: new THREE.Vector3(...b.max) },
      uVatDims: { value: new THREE.Vector3(b.width, b.rows, b.frames) }, uVatFrame: { value: 0 },
    },
  };
}
export const frameAt = (seconds, fps, frames) => (((seconds * fps) % frames) + frames) % frames;   // looping, never negative

const GLSL = /* glsl */ `
uniform highp sampler2D uVatPos, uVatNrm; uniform vec3 uVatMin, uVatMax, uVatDims; uniform float uVatFrame;
ivec2 vatTexel(int f) { int w = int(uVatDims.x); return ivec2(gl_VertexID % w, f * int(uVatDims.y) + gl_VertexID / w); }
int vatFrame(int k) { return (int(floor(uVatFrame)) + k) % int(uVatDims.z); }
vec3 vatPosition() { float t = fract(uVatFrame);
  vec3 a = texelFetch(uVatPos, vatTexel(vatFrame(0)), 0).rgb, b = texelFetch(uVatPos, vatTexel(vatFrame(1)), 0).rgb;
  return mix(uVatMin, uVatMax, mix(a, b, t)); }
vec3 vatNormal() { float t = fract(uVatFrame);
  vec3 a = texelFetch(uVatNrm, vatTexel(vatFrame(0)), 0).rgb, b = texelFetch(uVatNrm, vatTexel(vatFrame(1)), 0).rgb;
  return mix(a, b, t) * 2.0 - 1.0; }`;

// Patch a MeshStandard, Physical or Depth material. Mesh vertex order must equal the bake order (gl_VertexID is the index buffer value).
export function applyVat(material, vat) {
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, vat.uniforms, { uVatPos: { value: vat.pos }, uVatNrm: { value: vat.nrm } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = vatNormal();')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = vatPosition();');
  };
  material.customProgramCacheKey = () => 'vat-v1';
  return material;
}
```

Loading a cache from the Blender snippet:

```js
const buf = await (await fetch('cache_f32.bin')).arrayBuffer();
const all = new Float32Array(buf), step = nVertices * 3;
const frames = Array.from({ length: nFrames }, (_, f) => all.subarray(f * step, (f + 1) * step));
const vat = createVat(bakeVat(frames, geometry.index.array, { encoding: 'f16', maxWidth: renderer.capabilities.maxTextureSize }));
mesh.material = applyVat(new THREE.MeshStandardMaterial(), vat);
mesh.geometry.boundingSphere = new THREE.Sphere(center, radius);   // bounds of the animation, see rules
// each frame: vat.uniforms.uVatFrame.value = frameAt(clocks.world time, bakeFps, vat frames)
```

Verified in headless Chromium (three 0.187) with a 561 vertex sphere, 12 frames, forced 9 rows per frame (width 63) so the wrapping path ran: rendered images matched a CPU reference mesh with the same lighting and shadows at frames 0, 3.4, 7 and 11.5 (the last interpolates the last frame back to the first). Mean absolute difference 0.03 of 255 for half float and 0.13 for 8 bit, the few differing pixels sit on silhouette edges. A control with the wrong frame gave 11.6. No GL errors, the depth material variant compiled and rendered.

Rules:
- **`NearestFilter` always.** Linear filtering blends neighbouring vertices. Interpolate in time by fetching two frames and `mix`, as the shader does.
- **Time to frame:** use `frameAt` so the value is never negative and stays small. Large floats lose the fraction. For a non looping clip, clamp instead of wrapping.
- **Set the bounds yourself.** Culling uses the rest pose bounding sphere, so a cache that travels vanishes at the screen edge. Set `geometry.boundingSphere` from the bake bounds or `frustumCulled = false`.
- **Cloning drops the patch.** `material.clone()` does not copy `onBeforeCompile` and `Mesh.clone` drops `customDepthMaterial` (found in an earlier batch, consistent with the source). Patch after cloning.
- **Many copies of one cache:** share the textures and the material, vary the time per instance through an `InstancedBufferAttribute` offset added to `uVatFrame` in the shader (not run, `InstancedMesh` compatibility unverified (verify)).
- **Shading cost is normal PBR plus 4 texel fetches per vertex.** Vertex bound, so cap vertices per tier.
- **Data textures stay `NoColorSpace`** (the `DataTexture` default). Never tag them sRGB.
- **Loops:** make frame 0 and the last frame match in the DCC, or ping pong the time.

## 4. Encoding precision

Positions are stored normalised inside global per axis bounds over all frames, `p = min + u * (max - min)`. Error is a fraction of the largest range, so bound the range tightly and keep the clip's travel out of the cache when possible (move the object, bake the deformation).

| Encoding | Texel (position + normal) | Max error | Use |
|---|---|---|---|
| 8 bit RGBA | 4 + 4 bytes | range / 510 (7.5 mm on a 4 m range, measured) | Small background cloth, banners, jelly where steps hide in motion |
| **Half float RGBA** | 8 + 4 bytes | about range x 2.4e-4 (0.96 mm on 4 m, measured) | Default |
| Two 8 bit channels per axis (16 bit packed) | 8 + 4 bytes | range / 131000 | Needs a second fetch and decode. Not run here (verify) |
| Float32 | 16 + 4 bytes | Negligible | NEAREST sampling is core WebGL2, but it doubles the position memory. Rarely needed |

Findings and rules:
- **`THREE.DataUtils.toHalfFloat` truncates** (source read, error measured at one ULP, double that of rounding). The bake picks the nearest half float, which halves the error.
- **Resolution is finest near 0 in a float** (half float has about 11 bits near the top of 0..1). Offsetting bounds so the mesh sits low in the range gives better precision. Not measured.
- **Normals** are stored as `n * 0.5 + 0.5` in 8 bit RGB. Octahedral packing into two channels is an option (verify). No normal texture at all: use derivative normals (`flatShading`), cheaper, faceted.
- **Per frame bounds or deltas from the rest pose** improve 8 bit precision for small motion at the cost of an extra table (not tested).
- **Texture limits:** width up to `renderer.capabilities.maxTextureSize`, height is `rows per frame x frames`. 10k vertices at width 4096 is 3 rows per frame, so about 1300 frames fit in 4096 rows. Beyond the limit, split into chunks (section 6).
- **Non power of two sizes are fine** in WebGL2. WebGPU and TSL paths not run (verify).

## 5. Rigid destruction and particle caches (design)

- **Rigid VAT:** per piece and frame store position (normalised like above) and a quaternion (`x, y, z, w` in `[-1, 1]` mapped to `0..1`, half float). Vertex shader: `p = piecePos + rotate(q, vertex - pivot)`. Store `pivot` and piece id as vertex attributes or in a second texture. Data is pieces x frames x 2 texels, often a few hundred KB for a whole wall.
- **Particle cache:** index with `gl_InstanceID`, build billboards from the fetched position, size and age from an extra channel or a second texture. Velocity gives stretch (`particle-rendering-blending`).
- Both use the same `NearestFilter`, bounds and `frameAt` rules. Neither was run here.

## 6. Streaming long caches

A long cache does not have to sit in memory.

1. Split the cache into **chunks** of N frames (32 to 64, 1 to 4 MB each, tune), one texture per chunk, one file per chunk.
2. Keep three resident (previous, current, next). Prefetch the next when playback passes half the current chunk. Memory stays constant whatever the length.
3. **Repeat one frame** at each chunk boundary (the last frame of chunk k is the first of k+1) so the lerp across the seam works. Switch the uniform texture and frame offset at the boundary.
4. Decode off the main thread and upload one chunk per frame or less. A multi MB `DataTexture` upload in one frame hitches. `MeshoptDecoder.decodeGltfBufferAsync` exists in three's decoder (checked in source).
5. `dispose()` the textures of finished chunks. Check `renderer.info.memory.textures`.
6. Serve with HTTP caching and range or per chunk URLs, and a fallback frame while the next chunk is not ready (hold the last frame, never stall the render).

Streaming is design only here, not run. Lower the bake rate for the far LOD (15 fps baked, time lerped) and bake a decimated mesh for distant copies (`vfx-performance-scaling`).

## 7. Compression

GPU memory holds the decoded data, so compression only shrinks the download.

| Route | Result | Notes |
|---|---|---|
| **KTX2 with BasisU (ETC1S, UASTC)** | Do not use for positions | Lossy 4x4 block codec mixes neighbouring vertices and breaks precision (reasoning, not tested) (verify). It is fine for the flipbook sheets of `vfx-flipbook-authoring` |
| KTX2 uncompressed `RGBA16F` plus zstd | Lossless download savings, GPU size unchanged | `KTX2Loader` maps `VK_FORMAT_R16G16B16A16_SFLOAT` to a half float RGBA texture and handles zstd supercompression (source checked, not run). Writer tool flags: verify |
| **Own binary: quantised u16 plus Meshopt vertex codec** | Lossless round trip verified | Vertex major layout (each vertex's frames adjacent) so the codec predicts from the previous frame. Decode with `MeshoptDecoder.decodeVertexBuffer(target, count, size, source)` from `three/addons/libs/meshopt_decoder.module.js`, then reorder into the texture layout |
| Brotli or gzip on the response | Cheap | Often the biggest win on smooth data, stack it on the binary |
| Frames as glTF morph targets | Only for a few frames | One target per frame stores full vertex data in the file, and the mixer blends weights. Fine for 8 to 16 frames, not for 100 |
| `EXT_meshopt_compression` | Compresses glTF buffer views | Applies to the rest mesh and morph accessors, not to a custom VAT file (`gltf-asset-pipeline`) |

Measured on a synthetic 100x100 cloth grid, 60 frames, quantised to u16 (4.8 MB raw): Meshopt 1.25 MB (3.8x), brotli alone 0.22 MB (22x), Meshopt then brotli 0.085 MB. The synthetic motion is far more regular than a real sim, so expect lower ratios and measure your own cache. The Meshopt round trip was byte exact.

## 8. Memory budget

Bytes = vertices x frames x texel bytes. Half float position plus 8 bit normal is 12 bytes per vertex per frame, 8 bit both is 8.

| Cache | Half float | 8 bit |
|---|---|---|
| 5k vertices x 60 frames | 3.6 MB | 2.4 MB |
| 10k x 60 | 7.2 MB | 4.8 MB |
| 20k x 120 | 28.8 MB | 19.2 MB |
| 50k x 120 | 72 MB | 48 MB |

The bake picks the smallest width that keeps the row count, so padding stays under one row (a fixed width of 4096 padded 10,000 vertices to 12,288 texels and cost 23 percent more). The 10k x 60 half float test cache measured 7.2 MB, matching the table. Texture memory tier caps are in `performance-budget` (64, 256, 512 MB). Suggested share for baked sims: about 8, 32, 64 MB (guess).

Cuts, cheapest first:
1. **Share one cache across many instances** with per instance time offsets.
2. Bake at 15 to 24 fps and lerp in time. Halves memory against 30 fps.
3. Bake only the hero beat, loop short cycles.
4. 8 bit positions where the error hides in motion.
5. Drop the normal texture (derivative normals).
6. Fewer vertices: bake a decimated mesh for far LODs.
7. Stream chunks (section 6).

`renderer.info.memory.textures` counts textures, not bytes. Compute the bytes yourself and log them.

## 9. Verify (`render-qa`)

1. Frame 0 of the VAT equals the rest mesh (render both, compare). A mismatch means vertex order drift (section 2).
2. Decode a sample of texels back to positions in Node and compare with the source. Error must stay under the table bound.
3. Test a fractional frame and the loop wrap (last frame to first) against a CPU reference render.
4. Orbit the camera at the animation extremes. The mesh must not vanish (bounds) and shadows must follow (depth material patched).
5. Compute the memory with the formula, compare with the tier share. Check texture dimensions against `maxTextureSize` on the lowest device.
6. For streams: seek anywhere, run through a chunk boundary, throttle the network. No hitch above one frame, no flash of the wrong frame.
7. Compare a download size with and without compression on your real cache.

## 10. Not verified here

- Houdini and Blender tool and menu names, the Blender Python snippet, MDD and PC2 formats, any Alembic reader.
- Rigid VAT, particle caches, `InstancedMesh` with VAT, streaming, octahedral normals, 16 bit packing, KTX2 float plus zstd writing.
- WebGPU and TSL playback, real GPU and phone precision, the numeric memory shares. The playback sample ran on a software rasteriser.

## 11. Do not do these

- Do not filter VAT textures linearly.
- Do not compress positions with a lossy GPU texture codec.
- Do not bake a mesh whose vertex order differs from the mesh you draw.
- Do not keep the whole long cache resident. Stream it.
- Do not use VAT for what a skeleton can drive, or for changing topology.
