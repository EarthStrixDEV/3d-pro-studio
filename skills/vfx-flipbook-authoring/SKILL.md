---
name: vfx-flipbook-authoring
description: Author the textures that VFX run on in Three.js. Covers rendering sprite sheets and flipbooks from Blender or Houdini smoke and fire sims, atlas layout, gutters and frame counts, motion vector flipbook blending for smooth playback from fewer frames, noise and gradient ramp textures, flow maps with two phase blending, channel packing (emissive, alpha, distortion, noise octaves), colour space rules, mips and filtering, KTX2 compression and texture memory budgets, with a verified atlas packer and motion vector blend shader. Use when a request asks for a sprite sheet, flipbook, SubUV, texture atlas for particles, smoke or fire sim renders, flow map, ramp texture, packed effect texture, or when flipbook playback looks choppy, cells bleed into each other, edges show dark halos, or effect textures eat memory. Thai triggers สไปรต์ชีท, ฟลิปบุ๊ก, แอตลาสพาร์ติเคิล, เรนเดอร์ควันจาก sim, ฟลาวแมพ, แพ็กแชนเนล, ลดขนาดเท็กซ์เจอร์เอฟเฟกต์.
argument-hint: "<effect to author, source (Blender, Houdini, hand painted), on screen size in pixels, and device tier>"
---

# VFX: Flipbook and Effect Texture Authoring

The textures decide how a particle effect looks and how much it costs. Playback in the shader: `particle-rendering-blending`. Particle sample with a flipbook lookup: `realtime-engine-features` section 2. Fire ramps and the explosion layers: `vfx-fire-smoke-explosion`. KTX2 and glTF tooling: `gltf-asset-pipeline`. Sim sources: `grid-fluid-smoke`. Baked sim as mesh data instead of sprites: `sim-cache-baking-vat`.

## 1. Pick the asset type

| Need | Asset | Notes |
|---|---|---|
| Fire, smoke, explosion with art directed shapes | Flipbook sheet from a sim (sections 2 to 4) | Best look per cost. Needs authoring and memory |
| Look from a few shapes, varied by shader | Single noise or ramp textures (section 5) | Tiny memory, endless variation, procedural motion |
| Flowing water, lava, portals, smoke wisps | Flow map (section 5) | One small texture animates a big surface |
| Many effects sharing one look | Packed multi effect atlas (section 6) | Fewer textures, fewer binds, one budget line |
| Smooth slow motion from few frames | Motion vector flipbook (section 4) | Store a quarter of the frames, play smoothly |
| Dense volume lit from any side | Volume or six way lit flipbook | Six way lighting stores light from several directions in the channels (verify tooling support) |

## 2. Rendering sheets from a sim

Capture settings that decide quality:

| Setting | Rule |
|---|---|
| Camera | Orthographic, fixed framing. The sim must stay inside the frame for the whole run, with margin |
| Background | Transparent film. Straight alpha PNG, 16 bit if the grade matters |
| Lighting | Smoke: bake one soft key from the main scene light side, or render unlit with density only and light in the shader (`vfx-fire-smoke-explosion` section 2). Fire: emissive only, no lighting |
| Frame rate | Sim at 24 to 30 fps. Playback speed is a shader choice, not baked |
| Loop | A looping fire needs frames N and 0 to match. Cross fade the last frames into the first in compositing, or sim a cyclic source |
| Resolution | Per frame (cell) pixels from section 3 |
| Motion blur | Off. It smears the sheet and fights motion vector blending |
| Output | Numbered files `f_000.png`. Add a vector pass for motion vectors if the renderer supports it (verify) |

Blender (not run here, check against your version; all names are Blender Python API names):

```python
import bpy
sc = bpy.context.scene
sc.render.film_transparent = True
sc.render.image_settings.file_format = 'PNG'
sc.render.image_settings.color_mode = 'RGBA'
sc.render.resolution_x = sc.render.resolution_y = 256        # one cell
sc.camera.data.type = 'ORTHO'
for f in range(sc.frame_start, sc.frame_end + 1):
    sc.frame_set(f)
    sc.render.filepath = f'//flip/f_{f:03d}.png'
    bpy.ops.render.render(write_still=True)
```

Houdini: the SideFX Labs tools include flipbook and flow map texture exporters (verify exact node names and whether they emit motion vectors in your Labs version). Blender smoke domains and Houdini Pyro both give density plus temperature, render density as alpha and temperature as a ramp lookup if you pack for ramps (section 6).

Rules: keep the sim bounds and camera identical for every frame, or the effect drifts in the sheet. Render a test sheet at 64 px first and play it in the engine before a full render. Crop transparent borders only once, with the same crop for all frames.

## 3. Layout, frame counts and sizes

Frame 0 top left, row major, frames in time order. Power of two atlas sizes compress best, multiples of 4 are required for block compression (section 8).

| Effect | Frames | Grid, atlas | Cell px | Notes |
|---|---|---|---|---|
| Small fire, torch loop | 16 | 4 x 4, 1024 | 256 | 16 frames at 24 fps loop is 0.67 s, speed it up or slow it by shader |
| Smoke puff | 32 to 64 | 8 x 8, 2048 | 256 | With motion vectors 16 to 32 is enough |
| Explosion, hero | 64 | 8 x 8, 2048 or 4096 | 256 to 512 | 4096 costs 64 MiB raw, check the budget (section 8) |
| Sparks, small impact | 8 to 16 | 4 x 4, 512 | 128 | Often a single strip works |
| Ground dust, splash | 16 | 4 x 4, 1024 | 256 | |

Cell size rule: cell pixels at least the particle's largest on screen size in pixels times the pixel ratio, never more. A smoke card that covers 200 px wide needs a 256 cell, not 512. Frames below 128 px read as mush when scaled up, frames above on screen size are wasted memory.

Frame count rule: playback frames per second on screen times lifetime. Smooth playback needs about 12 to 15 distinct frames per second. Fewer frames plus motion vector blending beats more frames at the same memory.

Gutter: add 2 to 4 px of edge extended padding per cell. Without it bilinear filtering and the first mip levels bleed the neighbouring frame in at the cell border (section 7).

## 4. Verified sample: atlas packer and motion vector blend

`packAtlas` builds the sheet with gutters. `FLIPBOOK_GLSL` samples two frames, warps each along the motion vectors and blends them, so a half frame position shows one sharp shape instead of two ghosts. Verified on three 0.187 with a moving gaussian blob (4 frames, 2 x 2 grid): at frame 0.5 a plain crossfade shows two blobs at 0.49 intensity each and 0.25 between them, motion vectors show one blob at 0.99 in the middle and 0.25 at the two old positions. Orientation was checked (frame 0 top left, not flipped), the gutter equals the frame edge pixels, and the flow map function below compiles.

```js
import * as THREE from 'three';

// Pack equal sized RGBA frames (Uint8Array, rows top first) into a grid atlas, frame 0 top left. Every cell gets a
// `pad` px gutter filled by edge extension, so bilinear filtering and the first mips never pull in a neighbour frame.
export function packAtlas(frames, cols, w, h, pad = 2) {
  const rows = Math.ceil(frames.length / cols), cw = w + pad * 2, ch = h + pad * 2;
  const W = cols * cw, H = rows * ch, data = new Uint8Array(W * H * 4);
  frames.forEach((f, i) => {
    const ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - pad)), sy = Math.min(h - 1, Math.max(0, y - pad));   // clamp = edge extension
      const s = (sy * w + sx) * 4, d = ((oy + y) * W + ox + x) * 4;
      data[d] = f[s]; data[d + 1] = f[s + 1]; data[d + 2] = f[s + 2]; data[d + 3] = f[s + 3];
    }
  });
  return { data, width: W, height: H, cols, rows, inset: pad / cw };   // inset: the gutter as a fraction of one cell
}

// Motion vector flipbook sampling. mv sheet: R = +u, G = +v (up), 0.5 = no motion, range = largest motion in uv per frame.
// Sheets hold STRAIGHT alpha with colour bled into transparent texels (no halo). Each sample is premultiplied in linear
// light before the mix, which is the correct blend. Paste into a particle fragment shader.
export const FLIPBOOK_GLSL = /* glsl */ `
  vec2 fbCell(vec2 grid, vec2 inset, float frame, vec2 uv) {
    vec2 cell = vec2(mod(frame, grid.x), grid.y - 1.0 - floor(frame / grid.x));   // frame 0 is the top left cell
    return (cell + mix(inset, 1.0 - inset, clamp(uv, 0.0, 1.0))) / grid;           // clamp = never leave the frame
  }
  vec4 flipbook(sampler2D sheet, sampler2D mvSheet, vec2 grid, vec2 inset, vec2 uv, float frame, float range, float strength, float loopFlag) {
    float n = grid.x * grid.y, f0 = min(floor(frame), n - 1.0), k = frame - f0;
    float f1 = loopFlag > 0.5 ? mod(f0 + 1.0, n) : min(f0 + 1.0, n - 1.0);
    vec2 m0 = (texture2D(mvSheet, fbCell(grid, inset, f0, uv)).rg * 2.0 - 1.0) * range * strength;
    vec2 m1 = (texture2D(mvSheet, fbCell(grid, inset, f1, uv)).rg * 2.0 - 1.0) * range * strength;
    vec4 a = texture2D(sheet, fbCell(grid, inset, f0, uv - m0 * k));               // frame A pushed forward by k
    vec4 b = texture2D(sheet, fbCell(grid, inset, f1, uv + m1 * (1.0 - k)));       // frame B pulled back by 1 - k
    a.rgb *= a.a; b.rgb *= b.a;                                                  // premultiply after the sRGB decode
    return mix(a, b, k);
  }`;

export function createFlipbookMaterial({ sheet, motion, grid, inset, range = 0.25, strength = 1, loop = false }) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, premultipliedAlpha: true,
    uniforms: {
      uSheet: { value: sheet }, uMotion: { value: motion }, uGrid: { value: new THREE.Vector2(...grid) },
      uInset: { value: new THREE.Vector2(inset, inset) }, uRange: { value: range }, uStrength: { value: strength },
      uLoop: { value: loop ? 1 : 0 }, uFrame: { value: 0 },                          // uFrame: 0 to cols*rows, fractional
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uSheet, uMotion; uniform vec2 uGrid, uInset; uniform float uRange, uStrength, uLoop, uFrame;
      varying vec2 vUv;
      ${FLIPBOOK_GLSL}
      void main() {
        gl_FragColor = flipbook(uSheet, uMotion, uGrid, uInset, vUv, uFrame, uRange, uStrength, uLoop);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// Atlas to texture. Colour sheets: sRGB. Motion vectors and any data pack: NoColorSpace, no mips, linear filter.
export function atlasTexture(atlas, { colour = true, mips = true } = {}) {
  const t = new THREE.DataTexture(atlas.data, atlas.width, atlas.height, THREE.RGBAFormat);
  t.flipY = true;                                         // buffer rows are top first, like an image file
  t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = colour && mips;
  t.minFilter = t.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
```

Use inside a particle shader by pasting `FLIPBOOK_GLSL` and calling `flipbook(...)` with the per instance frame `age / life * (frames - 1)` (as in the explosion sample, `vfx-fire-smoke-explosion`).

Rules:
- **Motion vector map.** R = motion in +u, G = motion in +v (up), 0.5 means no motion, `range` is the largest motion per frame in uv units. Linear (`NoColorSpace`), no mips, `LinearFilter`. Test with a sprite that moves right: if it blends backwards flip the sign, if it moves vertically flip G (some tools write y down).
- **Where the vectors come from.** From the sim renderer's velocity pass if it exists, otherwise from optical flow on the frames (OpenCV Farneback or similar, verify parameters). Both work if the motion is smooth. Fast, small features (sparks, thin tendrils) warp badly, use plain frames for those.
- **Strength.** `strength` 1 is the physical blend, 0 is a plain crossfade. Reduce it where warping shows tearing (fast explosions, intersecting layers). Test at `k = 0.25, 0.5, 0.75`.
- **Straight alpha with bled colour.** Store straight alpha and extend colour into fully transparent texels (the packer's edge extension does this at cell borders, do the same inside frames with a dilate). The shader premultiplies after the sRGB decode and then mixes. Storing premultiplied colour in an sRGB texture is wrong: the hardware decodes the premultiplied value and darkens edges (observed in the first test run of this sample).
- **Loop or clamp.** `loopFlag` 1 wraps the last frame into frame 0, 0 holds the last frame (one shot).
- **Frame must be fractional.** If the frame comes from a `floor`ed age the blend is off. Pass it unrounded.
- `texture2D` on a ShaderMaterial in WebGL2 is mapped by three. For WebGPU or TSL use the equivalent nodes (verify).

## 5. Noise, ramps and flow maps

| Texture | Size and format | Settings |
|---|---|---|
| Tiling noise (value, Perlin, Worley, curl) | 128 to 256, one channel or four octaves in RGBA | `RepeatWrapping`, mips on, `NoColorSpace`. Must tile, generate with periodic noise (`shader-craft` has noise code, bake it once) |
| Colour ramp (temperature, life, element) | 256 x 1, or 256 x N rows stacked (one ramp per row, pick with `v`) | `ClampToEdgeWrapping`, no mips, `LinearFilter` (smooth) or `NearestFilter` (toon). `SRGBColorSpace` if authored as colours, `NoColorSpace` if you store linear values (fire sample) |
| HDR ramp | Same layout, half float | Half float is filterable on WebGL2. Otherwise store LDR colour and multiply by an HDR scalar in the shader |
| Gradient mask (radial, soft box, streak) | 64 to 256, one channel | `ClampToEdgeWrapping`, mips on. Tiny, reuse across effects |
| Flow map | 256 to 512, RG | `RepeatWrapping` for tiling water, `NoColorSpace`, no mips or very few, `LinearFilter` |

Ramp rules: 8 bit ramps band in dark gradients. Use 256 px width, dither a little, or go half float for slow fades. Keep one ramp per look and swap it by uniform (`vfx-magic-energy-stylized` section 3).

**Flow maps.** RG stores a direction, 0.5 is zero. Never scroll one sample, it stretches forever. Blend two samples offset half a cycle (Valve's flow map technique), so the reset of one is hidden by the other at weight zero:

```glsl
vec4 flowSample(sampler2D tx, sampler2D fl, vec2 uv, float time, float strength) {
  vec2 f = (texture2D(fl, uv).rg - 0.5) * 2.0;
  float p0 = fract(time), p1 = fract(time + 0.5);
  float w0 = 1.0 - abs(1.0 - 2.0 * p0);                 // 0 when phase 0 resets, 1 half way
  return mix(texture2D(tx, uv - f * p1 * strength), texture2D(tx, uv - f * p0 * strength), w0);
}
```

The function compiles and the weights are continuous (checked above). Visual quality depends on your map. Paint flow in Houdini or Blender (verify tools), keep the flow low frequency, and blend in a second noise at a different scale to hide the cross fade pulse. Water surfaces and shorelines live in `ocean-terrain-environment`.

## 6. Channel packing

Pack data, never colour and data together. Colour sheets are sRGB, packed data is linear (`NoColorSpace`).

| Pack | R | G | B | A | Use |
|---|---|---|---|---|---|
| Lit smoke sheet | colour R | colour G | colour B | alpha | Straight alpha colour sheet, sRGB, hero smoke |
| Fire data | temperature (ramp lookup) | alpha | density or smoke mask | heat distortion | Fire from `vfx-fire-smoke-explosion`: temperature drives the ramp, distortion is read by `vfx-post-fx-compositing` |
| Noise pack | octave 1 | octave 2 | octave 3 | octave 4 | One fetch gives four scales for erosion and flow |
| Motion vector | mv u | mv v | unused or confidence | unused | Section 4, keep separate from the colour sheet |
| Mask pack | soft radial | streak | ring | noise | Magic and impact masks (`vfx-magic-energy-stylized`) |

Rules:
- **One fetch, four masks.** Four masks in one RGBA texture cost one texture bind and a quarter of the memory of four textures.
- **Alpha channel costs extra when compressed.** ETC1S stores alpha as a second slice. If you only need three masks, drop the alpha or reuse it deliberately.
- **Signed values** (distortion, flow) use 0.5 as zero. Decode `x * 2.0 - 1.0`.
- **Mips of packed data blend channels together.** Normal mip filtering is fine for masks, wrong for vectors. Motion vectors and flow maps use few or no mips.

## 7. Mips and filtering

| Texture | Mips | Filter | Why |
|---|---|---|---|
| Colour flipbook sheet | On if particles shrink on screen, off if always at about cell size | Linear, mipmap linear | Gutter of 2 to 4 px handles the first mip levels |
| Packed data and masks | On for masks and noise, off for vectors | Linear | |
| Ramps and flow maps | Off | Linear, clamp | Mips of a 256 x 1 ramp collapse colours |
| Toon flipbooks | Off | Nearest or linear | Keeps hard edges |

Rules:
- **Gutter plus level of detail.** A gutter of `g` px at mip 0 is `g / 2^m` at mip `m`. Past about 2 mips cells bleed (rule of thumb). Use mips only as far as the smallest on screen size needs.
- **Do not use anisotropic filtering** on billboards, it costs and buys nothing.
- **Premultiplied mips.** Straight alpha mips darken edges. Dilate colour into transparent areas before mip generation. `Texture.premultiplyAlpha` applies only to uncompressed uploads, for compressed textures premultiply offline (verify per texture type).
- **Frame blending needs `LinearFilter` magnification.** Nearest sampling makes warped frames shimmer.

## 8. KTX2 and memory budgets

Only KTX2 (Basis Universal) cuts GPU memory. PNG and WebP only shrink the download, the GPU still holds raw RGBA. Pipeline and loader setup (`KTX2Loader`, `detectSupport`) are in `gltf-asset-pipeline` section 3. For standalone effect textures use the KTX-Software tools (`toktx`, `ktx`, verify flags with `--help` for your version):

```bash
toktx --t2 --encode uastc --genmipmap smoke_sheet.ktx2 smoke_sheet.png     # data packs, flow maps, motion vectors
toktx --t2 --encode etc1s --genmipmap fire_sheet.ktx2 fire_sheet.png       # colour sheets, smaller, softer
```

| Choice | Use for | Trade off |
|---|---|---|
| UASTC | Motion vectors, flow maps, packed data, hero sheets | Higher quality, bigger download |
| ETC1S | Colour sheets, noise for visuals | Small download, visible blocking on smooth gradients, bad for vectors |
| Skip compression | Tiny ramps (256 x 1) and gradient masks | Not worth the artefacts |

GPU memory after transcode (RGBA at 8 bits per pixel on common block formats, mips add a third; computed in this skill, not measured):

| Atlas | Raw RGBA8 with mips | KTX2 transcoded (BC7, ASTC 4x4, ETC2) |
|---|---|---|
| 1024 x 1024 | 5.3 MiB | 1.3 MiB |
| 2048 x 2048 | 21.3 MiB | 5.3 MiB |
| 4096 x 4096 | 85.3 MiB | 21.3 MiB |

Budget (starting guesses, tune against `performance-budget` tiers and `vfx-performance-scaling`): all VFX textures resident at once about 8 MiB on low tier, 24 MiB mid, 64 MiB high, after transcoding.

Memory savers, in order: share atlases between effects (tint in the shader), halve the cell size on low tier and load that atlas variant, cut frames with motion vectors, pack masks, drop unused channels, lazy load atlases for effects the level does not use, and dispose atlases when the effect is gone (`texture.dispose()`).

## 9. Verify (`render-qa`)

1. Play the effect at `uFrame = k + 0.25, 0.5, 0.75` for several `k`. Compare crossfade (`strength 0`) and motion vector blending. No ghosting, no tearing.
2. Zoom into cell borders at 400 percent with mips on. No neighbour frame bleeding, no dark halos on edges.
3. Loop seam: frame N to frame 0 must not pop.
4. Check orientation and flipped motion vectors with a test sprite that moves right and up.
5. Read `renderer.info.memory.textures` and compute bytes from the table. Compare with the budget.
6. Check compressed against uncompressed side by side. Vectors and flow maps especially.
