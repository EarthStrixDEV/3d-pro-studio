---
name: post-processing-stack
description: Build a correct, artifact-free post-processing chain for Three.js — EffectComposer pass order, anti-aliasing (SMAA/FXAA/MSAA), selective bloom, ambient occlusion (GTAO/SSAO/N8AO), depth of field, colour grading (LUT), vignette, film grain, and their known gotchas. Use when adding glow, AO, DOF, cinematic grading or AA, or when post effects cause banding, halos, dark slabs, double tone mapping, washed-out colours or jaggies.
---

# Post-processing Stack

Post should be invisible — the viewer should notice "it looks real", not "there is bloom".

## 1. Canonical order (EffectComposer, `three/addons/postprocessing/*`)

```
RenderPass            scene → HDR buffer (composer uses HalfFloat targets by default)
GTAOPass              ambient occlusion (linear HDR)
BokehPass             depth of field (optional)
UnrealBloomPass       bloom on HDR values
OutputPass            tone mapping + sRGB conversion — exactly once, here
LUTPass               colour grade (display-referred)
SMAAPass / FXAA       anti-aliasing on display-referred values
(vignette / grain)    last, as a ShaderPass
```
- `renderer.antialias` MSAA does not apply to composer targets. Either pass `samples: 4` via a custom `WebGLRenderTarget` to the composer, or use SMAA (template default).
- Call `composer.setPixelRatio()` and `composer.setSize()` on resize, and `bloom.resolution`/`SMAAPass.setSize` follow automatically.
- Do **not** set tone mapping on materials or add another tone-map pass — `OutputPass` reads `renderer.toneMapping`.

## 2. Bloom — the most abused effect

- **Threshold above the brightest lit diffuse surface.** With a key of ~3 and a white-ish albedo, diffuse pixels reach ~2–3 in HDR. Use threshold ≈ 4 and push intended glowers to `emissiveIntensity` 8–20. Low thresholds make the whole frame glow (verified: a 1.6 threshold haloed a white plinth).
- Strength 0.3–0.6, radius 0.4–0.6.
- **Selective bloom** for mixed scenes: use the threshold method above first; only if that fails, use the two-composer layer technique (three example `webgl_postprocessing_unreal_bloom_selective`).
- Dark backgrounds make bloom look ~2× stronger — tune in both themes.

## 3. Ambient occlusion

`GTAOPass` (r160+) is the best built-in. Settings: `updateGtaoMaterial({ radius: 0.25–0.5, distanceFallOff: 1, thickness: 1, scale: 1 })`, `blendIntensity` 0.6–1.

**Verified gotchas (r170):**
1. The G-buffer prepass **still draws a texture `scene.background`** into the normal buffer → dark rectangular slabs around objects wherever background is visible. Fix: null the background during the prepass.
2. Glass/transmissive and transparent meshes are treated as solid occluders.

```js
const skipAO = (o) => o.isMesh && !o.material.isShadowMaterial && (o.material.transparent || o.material.transmission > 0);
const hide = ao.overrideVisibility.bind(ao), show = ao.restoreVisibility.bind(ao);
let savedBg = null;
ao.overrideVisibility = () => { hide(); savedBg = scene.background; scene.background = null; scene.traverse((o) => { if (skipAO(o)) o.visible = false; }); };
ao.restoreVisibility  = () => { show(); scene.background = savedBg; };
```
(`overrideVisibility`/`restoreVisibility` are internal — re-verify after upgrading three.)

Alternatives: `SSAOPass` (older, noisier), `N8AO` / `pmndrs/postprocessing` (bundler projects; very good quality/perf). On low tier skip AO and rely on contact shadows.

## 4. Depth of field

`BokehPass(scene, camera, { focus, aperture: 0.002–0.01, maxblur: 0.005–0.01 })`. Drive `focus` from the distance to the hero (`camera.position.distanceTo(target)`) every frame. Keep it shallow only for macro/product beauty shots; it hides detail elsewhere. Expensive — high tier only.

## 5. Colour grading

- `LUTPass` + `LUTCubeLoader` (`.cube` files) after `OutputPass`; intensity 0.3–0.8.
- Simple grade without LUT: a ShaderPass for lift/gamma/gain, saturation, vignette (`0.15–0.3` darkening at corners), film grain (amplitude ≤ 0.03, animated).
- Grade *towards* the brief's palette, not away from accurate materials.

## 6. Banding & quality

- Gradients band in 8-bit: add 1/255 dither (grain) after OutputPass, or keep `HalfFloatType` targets (default).
- Bloom and AO at half resolution are fine; AA must be at full resolution.

## 7. Tier presets

| Tier | AO | Bloom | DOF | AA | Grade |
|---|---|---|---|---|---|
| low (phones) | off | on (cheap) | off | SMAA or FXAA | vignette only |
| mid | GTAO | on | off | SMAA | LUT |
| high | GTAO | on | optional | SMAA (or MSAA 4×) | LUT + grain |
