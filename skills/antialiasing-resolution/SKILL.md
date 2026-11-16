---
name: antialiasing-resolution
description: Remove jagged edges and shimmer by raising effective render resolution in Three.js. Covers an aliasing taxonomy (edge stair-steps, specular shimmer, texture and shader moire, alpha-cutout crawl, thin-line and wire breakup) mapped to fixes, and each method with its cost - renderer MSAA, composer render-target samples, SSAA via pixel ratio or SSAARenderPass, SMAA, FXAA, TAA with jitter and history, alpha-to-coverage, normal and roughness filtering, mip bias, anisotropy, bevels. Also adaptive resolution scaling, device-tier presets, and where AA sits relative to EffectComposer and OutputPass. Use when edges look jagged or stair-stepped, edges crawl or highlights sparkle while orbiting, foliage or fences shimmer, thin lines break up, or when asked to anti-alias, supersample, sharpen or raise render resolution. Thai triggers ขอบหยัก, ขอบเป็นขั้นบันได, ภาพระยิบ, ภาพสั่นตอนหมุน, เพิ่มความคมชัด, ลดรอยหยัก.
argument-hint: "<scene or model, and where edges look jagged or shimmer>"
---

# Antialiasing & Render Resolution

Aliasing is under-sampling. Fix the signal first (geometry, textures, shading), then spend samples. Pass order and the short AA note live in `post-processing-stack`; this skill is the deeper choice and tuning guide. Budgets live in `performance-budget`.

## 1. Diagnose first

Two checks before touching code:
1. **Still or moving?** Stair-steps that stay when the camera stops are spatial. Crawl, sparkle or flicker only while orbiting is temporal (shading, texture, cutout or thin geometry).
2. **Isolate.** Null one input at a time: `material.normalMap`, `material.map`, `alphaTest`, or swap to a plain material. Whatever makes it vanish names the category.

| Type | Looks like | Cause | MSAA fixes it? | Fix |
|---|---|---|---|---|
| Geometric edge | Stair-steps on silhouettes, creases, intersections | Coverage sampled once per pixel | Yes | Sections 2, 3, then bevels in 5 |
| Specular shimmer | Sparkling highlights on glossy, bumpy, normal-mapped or dense-tessellated surfaces, crawl while orbiting | Shading sampled once per pixel across sub-pixel normal changes | No (MSAA shades once per pixel) | Normal and roughness filtering (5), TAA (4) or SSAA |
| Shader and texture | Moire on fine patterns, swimming checker, stripe or noise at distance, mush at grazing angles | Pattern frequency above what a pixel can show | No | Mips, anisotropy, bias, `fwidth` (5) |
| Alpha cutout | Foliage, fences, hair cards crawl and thin out with distance | `alphaTest` edge is decided in the fragment shader, not by geometry | No, unless alpha-to-coverage | Alpha-to-coverage (5) |
| Thin line, wire | 1 px lines break into dashes, wireframe flickers, cables vanish | Feature narrower than a pixel | Partly | Fat lines, thicker geometry (5) |

## 2. Methods and cost

| Method | Fixes | Cost | Limit |
|---|---|---|---|
| Renderer MSAA (`antialias: true`) | Edges, when drawing straight to the canvas | Memory for samples x colour and depth | Fixed at context creation. Does not apply to composer targets |
| Composer target `samples` | Edges, and enables alpha-to-coverage | Nominal memory = w x h x bytes x samples. 1080p at pixel ratio 1, RGBA16F, 4 samples is about 66 MB per target before depth | Clamp to `renderer.capabilities.maxSamples`. Chosen at load, not per frame |
| SSAA via pixel ratio (`setPixelRatio(2)` on a 1x screen) | Edges, shimmer, moire (everything that is under-sampled) | Pixels x ratio squared. Draw calls unchanged | Browser does the downsample. Integer ratios stay crisp, fractional can look soft (verify per browser) |
| `SSAARenderPass` (`sampleLevel` 0 to 5) | Same, with a controlled filter | Scene rendered 2^sampleLevel times, so draw calls and triangles multiply | Still frames and product shots only |
| SMAA (`SMAAPass`) | Edges, some thin lines | Three fullscreen sub-passes plus lookup textures | Misses shading, texture, cutout and temporal shimmer |
| FXAA (`FXAAShader` in a `ShaderPass`) | Edges | One cheap fullscreen pass | Softens fine texture and small text. Low tier only |
| TAA (section 4) | Edges and shimmer of every type | Jitter, history target, one resolve pass, plus a velocity buffer for moving content | Ghosting, softness, history resets |
| Alpha-to-coverage | Alpha cutout | Free on an MSAA target | Does nothing without MSAA |
| Normal and roughness filtering | Specular shimmer | One-time offline, or a few shader ops | Material by material |
| Mip bias, anisotropy | Texture moire, grazing blur | Bias is free. Anisotropy costs texture bandwidth | Texture only |
| Bevels, thicker geometry | Edge, specular and wire aliasing | Triangles | Needs a model change |

Default stack: composer `samples` (high tier) or SMAA (all others) for edges, material filtering for shimmer, anisotropy on tiled maps. Add TAA or idle refinement only if shimmer remains after the material fixes. Never stack FXAA on top of MSAA or SMAA: it blurs and adds nothing.

## 3. Composer and OutputPass order

```js
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

const renderer = new THREE.WebGLRenderer({ antialias: false });   // composer renders the scene, the canvas needs no MSAA
const samples = Math.min(4, renderer.capabilities.maxSamples);
const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
const composer = new EffectComposer(renderer, target);
composer.setPixelRatio(pr);        // a custom target makes the composer start at pixel ratio 1 (verify against your three version)
composer.setSize(w, h);            // CSS size, not drawing-buffer size

composer.addPass(new RenderPass(scene, camera));   // MSAA scene
// AO, bloom, DOF here (see post-processing-stack)
composer.addPass(new OutputPass());                // tone mapping once
composer.addPass(new SMAAPass());                  // constructor arguments differ between three versions (verify)
```

FXAA variant, with the resolution uniform that goes stale on every resize or pixel-ratio change:

```js
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
const fxaa = new ShaderPass(FXAAShader);
fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
```

Rules:
- **Resolve AA after `OutputPass`.** MSAA averages linear HDR values before tone mapping: a bright edge pixel (10 beside 0) resolves to 5, tone-maps to near white and still looks stepped. SMAA and FXAA read display-referred values, so they clean that up. Check lamps and emissives against dark backgrounds in the crops.
- **Pixel ratio is read once.** The composer takes `renderer.getPixelRatio()` at construction. After any `renderer.setPixelRatio()`, also call `composer.setPixelRatio()`.
- **Both ping-pong targets inherit `samples`** (`clone()`), so MSAA memory doubles (verify). Check it against the texture-memory tier in `performance-budget`.
- **Bloom and AO at half resolution are fine.** The scene pass and the AA pass stay full resolution.
- **Without a composer**, keep `antialias: true` and skip the rest of this section.

## 4. TAA, jitter and history

**Static refinement (cheap, robust).** `TAARenderPass` accumulates jittered frames while nothing moves. Use plain `RenderPass` plus SMAA while the camera moves, switch to `TAARenderPass` with `accumulate` once it stops, render about 16 to 32 frames, then stop rendering (on-demand rendering in `performance-budget`). Follow the `webgl_postprocessing_taa` example for the pass toggling (verify). `sampleLevel` sets the sample count as 2^n.

**Real temporal AA (moving content).** Three core does not ship a velocity buffer for the WebGL composer (verify). Without one, history is only valid for a still camera and still objects. The WebGPU/TSL path has a `TRAANode` (verify availability in your version). Rolling your own:

```js
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
function jitter(camera, w, h, frame) {                 // w, h in drawing-buffer pixels
  const i = (frame % 16) + 1;
  camera.setViewOffset(w, h, halton(i, 2) - 0.5, halton(i, 3) - 0.5, w, h);
}
// render the scene, then camera.clearViewOffset() so UI and picking stay unshifted
```

Rules:
- **Resolve:** `out = mix(clamp(history, neighbourMin, neighbourMax), current, 0.1)`, with the 3x3 neighbourhood of the current frame as the clamp box. The clamp is what kills ghosting. Weight by `1 / (1 + luma)` so HDR highlights do not fire-fly (Karis, "High Quality Temporal Supersampling").
- **Place it** right after the scene pass and AO, before bloom and `OutputPass`. It needs jittered, unfiltered input. Do not also run SMAA.
- **Reset history** on resize, pixel-ratio step, tier change and camera cuts.
- **Bias textures sharper** by about -0.5 mip levels to recover softness (section 5, start value, tune by eye).
- **Skip `setViewOffset`** if the camera already uses a view offset (multi-view, tiled capture).

## 5. Fixes MSAA cannot reach

**Specular shimmer**
- Three's physical shader widens roughness from vertex-normal derivatives, not from the normal map (verify in `lights_physical_fragment` of your version). A noisy normal map on a glossy surface still sparkles.
- Offline: generate normal-map mips that renormalise, and fold normal variance into the roughness mips. GPU `generateMipmaps` just averages, which shortens vectors and flattens shading. Ship through `gltf-asset-pipeline` (KTX2 keeps the mips).
- Runtime Toksvig-style patch: in `onBeforeCompile`, read the unnormalised normal-map sample length and raise `roughnessFactor` as the length drops below 1. Heuristic, tune the strength by eye; verify chunk names. Patch rules live in `shader-craft`.
- Cheaper levers: lower `normalScale` on glossy surfaces, raise the roughness floor on shimmering materials (`pbr-lookdev`), remove micro-bumps smaller than a pixel at the hero distance.

**Texture and shader aliasing**
- Texture basics (mips on, `minFilter = LinearMipmapLinearFilter`, `anisotropy = renderer.capabilities.getMaxAnisotropy()`) are in `mesh-texture-upscale`. Anisotropy on tiled floors and walls removes grazing blur.
- Mip bias is set per sample in a fragment patch: `texture2D(map, uv, bias)`. Positive bias (+0.5) trades sharpness for stability, negative (-0.5) is sharper but shimmers unless TAA is on. WebGL has no per-texture bias state (verify).
- Procedural patterns need filtering inside the shader (`shader-craft`):

```glsl
float w = fwidth(f);                                  // one pixel's footprint in pattern space
float s = smoothstep(0.5 - w, 0.5 + w, fract(f));     // filtered edge
s = mix(s, 0.5, smoothstep(0.3, 0.6, w));             // fade to the average once sub-pixel
```

**Alpha cutout**

```js
mat.alphaTest = 0.5;
mat.alphaToCoverage = true;      // needs an MSAA target (composer samples > 0)
mat.transparent = false;         // keep depth writes and skip sorting
```
- Three applies an `fwidth` smoothstep to the alpha when `alphaToCoverage` is on (verify in `alphatest_fragment`).
- Alpha mips lose coverage, so leaves thin out at distance. Scale alpha per mip offline so coverage at the threshold stays constant (verify tool support).
- `material.alphaHash = true` is the dithered alternative. It relies on TAA or blur to resolve the noise (verify).
- Low and mid tiers have no MSAA, so A2C does nothing there: keep hard `alphaTest` plus coverage-preserving mips.

**Thin lines and wires**
- `Line`, `LineSegments` and `wireframe: true` are 1 device pixel and `linewidth` is ignored on most platforms. Use `Line2`, `LineMaterial`, `LineGeometry` from `three/addons/lines/`.
- Set `material.resolution` to the canvas CSS size on every resize. Keep `linewidth` at 1.5 px or more at pixel ratio 1.
- `LineMaterial` has an `alphaToCoverage` option for smoother fat-line edges (verify).
- Cables, rails and antennas thinner than a pixel at the hero distance: thicken them, or swap to a fat line at LOD distance (`performance-budget`).

**Geometry**
- Bevel radius should project to about 1 px or more at hero distance. A sub-pixel bevel adds shimmer instead of a highlight. Subdivision and bevel workflow: `mesh-texture-upscale`.
- Avoid sliver triangles and sub-pixel detail on silhouettes. Both crawl under any AA.
- Contrast-heavy hard edges alias most. A soft rim or small bevel hides what samples cannot.

## 6. Adaptive scaling and tier presets

Frame-time thresholds and the base adaptive-DPR loop are in `performance-budget` section 5. Additions that matter here:

```js
const STEPS = [1, 1.25, 1.5, 1.75, 2].filter((s) => s <= Math.min(devicePixelRatio, tierCap));  // quantised, never continuous
function applyScale(i) {
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  renderer.setPixelRatio(STEPS[step]);
  composer.setPixelRatio(STEPS[step]);
  // also: update the FXAA resolution uniform, drop TAA history
}
```

- **Quantise and rate-limit.** Each step reallocates the canvas and targets and hitches once. Change at most every ~2 s (start value).
- **Spend on stillness.** Drop to a lower step while the user drags, restore about 300 ms after input stops (start value), then run the refinement from section 4. Users judge sharpness at rest.
- **Degrade in this order** (starting order, adjust with `render-qa` crops): AO and DOF off, TAA and refinement off, pixel ratio down to 1, then scene `samples` 4 to 0 with SMAA (rebuild the composer, so decide at load not per frame), then render scale below 1 with a floor around 0.75.
- **High-dpi screens need less.** At pixel ratio 2 or more, aliasing is already half as visible. Skip MSAA and SSAA there, keep SMAA and the material fixes. Aliasing hurts most on 1x desktop monitors.
- **Above 2 is wasted.** `render-qa` warns for pixel ratio > 2.

| Tier | Pixel ratio cap | Scene `samples` | Resolve AA | Idle refinement | Cutouts |
|---|---|---|---|---|---|
| low (phones, iGPU) | 1.5 | 0 | FXAA or SMAA | off | `alphaTest` plus alpha mips |
| mid (laptops) | 1.75 | 0 | SMAA | off | `alphaTest` plus alpha mips |
| high (desktop dGPU) | 2 | 4 | SMAA | TAA accumulate | `alphaToCoverage` |

Pixel ratio caps match `performance-budget`; AA choices match the tier table in `post-processing-stack`. Mid with `samples: 2` is an option when cutouts matter more than texture memory.

## 7. Verify

Run `render-qa` first, then look closer than its rubric does (criterion 7 lists aliasing shimmer).

1. **Per tier.** Run once per tier and compare reports (draw calls, triangles, warnings stay inside budget):
```bash
node <skill-dir>/scripts/render-check.mjs scene.html --out qa-aa-low --query tier=low --angles 6
node <skill-dir>/scripts/render-check.mjs scene.html --out qa-aa-high --query tier=high --angles 6
```
2. **Crops at 100%.** Never judge from a downscaled screenshot. Crop the riskiest regions (silhouette against a bright background, glossy curves, foliage or fences, thin lines, fine texture) and magnify with pixel replication:
```bash
magick qa-aa-high/01-hero.png -crop 200x200+600+300 +repage -scale 400% crop-edge.png
```
3. **Shimmer while orbiting.** Still shots hide temporal aliasing. Step the camera by 0.25 degrees and capture frames at pixel ratio 1, the worst case (script not run against a real scene yet, verify on first use):
```js
// shimmer-capture.mjs   node shimmer-capture.mjs <url> <outdir>
import { chromium } from 'playwright';
const [url, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
await page.goto(url);
await page.waitForFunction(() => window.__sceneReady === true);
await page.evaluate(() => { window.requestAnimationFrame = () => 0; });   // stop the page loop, drive frames by hand
for (let i = 0; i < 8; i++) {
  await page.evaluate((deg) => {
    const { THREE, renderer, scene, camera, controls, composer } = window.__three;
    const t = controls.target, v = camera.position.clone().sub(t);
    v.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    camera.position.copy(t).add(v); camera.lookAt(t);
    if (composer) composer.render(); else renderer.render(scene, camera);
  }, i === 0 ? 0 : 0.25);
  await page.screenshot({ path: `${out}/f${i}.png` });
}
await browser.close();
```
```bash
for i in 0 1 2 3 4 5 6 7; do magick qa-shimmer/f$i.png -crop 160x160+600+300 +repage -scale 300% qa-shimmer/c$i.png; done
magick montage qa-shimmer/c*.png -tile 4x2 -geometry +4+4 qa-shimmer/sheet.png
```
4. **Pass criteria**, read on the contact sheet and the 100% crops:
   - No stair-steps on silhouettes at pixel ratio 1.
   - The same highlight evolves smoothly across neighbouring frames. Sparkles popping on and off fail.
   - Cutouts and thin lines stay continuous and do not thin out.
   - Fine texture and small text are not softer than before the change (FXAA and TAA blur).
   - Report is inside the tier budget, no new console errors.
5. Fix the top issue, re-run, compare with the previous run. Max 3 loops (the `render-qa` rule), then report what remains.
