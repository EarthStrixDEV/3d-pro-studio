---
name: vfx-performance-scaling
description: Effect-specific performance for Three.js VFX. Covers particle and overdraw budgets per device tier, measuring overdraw as numbers (layers per pixel) with a debug view, GPU timing queries on WebGL2 and WebGPU, frustum culling and screen size LOD of effects with hysteresis, pooling and per-scene effect budgets, reducing fill cost (tight quads, cropped flipbook cells, half-resolution particles with upsampling), quality presets with adaptive stepping, and mobile fallbacks. Includes a verified overdraw probe, GPU timer and LOD picker. Use when effects drop frame rate, when smoke or fire is fill-rate bound, when deciding particle counts per device, when a scene has too many simultaneous effects, or when a phone needs a cheaper version of a desktop effect. Thai triggers เอฟเฟกต์กระตุก, overdraw สูง, จำนวนพาร์ติเคิลต่อเครื่อง, ลดภาระเอฟเฟกต์, ปรับคุณภาพอัตโนมัติ, มือถือรับไม่ไหว, วัดเวลา GPU.
argument-hint: "<effect that is slow or must scale, plus target device tier and current frame time>"
---

# VFX Performance Scaling

Effects are almost always fill rate bound: large transparent quads stacked on the same pixels. Measure layers per pixel first, then cut area, then count. General tier tables, draw call and texture budgets live in `performance-budget`. Overdraw debug views and AOVs are in `render-passes-aov`.

## 1. Where effects cost

| Cost | Typical cause | First lever |
|---|---|---|
| **Fill (overdraw x pixels)** | Big soft smoke, glow quads, full screen overlays | Fewer and smaller quads, tight quads, half resolution |
| Fragment ALU | Noise in the fragment shader, many texture fetches, lights per particle | Bake to a flipbook, drop octaves on low tier |
| Vertex and instance count | 100k instanced quads | Cap alive particles per tier |
| CPU update | Per particle JS, spawn bookkeeping | Move to GPU (`gpu-particles-compute`), stateless shaders |
| Passes | Distortion buffer, selective bloom, per effect render targets | Share targets, merge passes (`vfx-post-fx-compositing`) |
| Memory | Many flipbook sheets, per effect targets | Atlas, KTX2 (`gltf-asset-pipeline`) |
| First use hitch | Shader compile on first spawn | `renderer.compileAsync` at load, pool materials |

## 2. Budgets per tier

Starting guesses, tune on real devices. Tier definitions (low phone, mid laptop, high desktop) follow `performance-budget` section 1. "Layers" means fragments per covered pixel from effects only.

| Budget | Low | Mid | High |
|---|---|---|---|
| Alive particles, all effects | 5k | 20k | 50k |
| Average layers per screen pixel (`layersPerScreenPixel` below) | 1 | 2.5 | 5 |
| Max layers on one pixel (`maxLayers`) | 8 | 16 | 32 |
| Simultaneous effects | 4 | 8 | 16 |
| Particles per effect | 300 | 1500 | 5000 |
| Flipbook sheet | 512, 4x4 | 1024, 4x4 | 2048, 8x8 |
| Distortion buffer scale | off | 0.5 | 0.5 to 1 |
| Soft particles | off | on | on |

Rules:
- **Budget by pixels, not by particle count.** 200 large smoke puffs cost more than 20000 sparks.
- **Cost is not additive with the rest of the frame.** Check the effect at its worst: camera inside the effect, all effects at peak spawn, full screen resolution at the pixel ratio cap.
- **Pixel ratio is the biggest lever** on fill bound effects. Halving the pixel count halves the fill cost (adaptive DPR in `performance-budget`).

## 3. Measuring overdraw

Debug view (visual): additive flat colour on every object, brighter means more layers (`render-passes-aov` debug overrides). Numbers (this section): count layers into an 8 bit target where each fragment adds exactly 1, then read the target back.

Effect shaders opt in by ending with:

```glsl
#ifdef OVERDRAW
gl_FragColor = vec4(vec3(1.0 / 255.0), 0.0);
#endif
```

Put it last, and **do not discard transparent texels before it**. The GPU still shades them, so quad coverage is the real fill cost.

Verified in headless Chromium (three 0.187): 5 stacked quads plus 2 more over half of them returned coverage 0.25, mean 6, p95 7, max 7, layers per screen pixel 1.5 (all exact), material state was restored, the normal render stayed unchanged, no GL errors. The GPU timer below returned 29 samples in 30 frames on SwiftShader (a CPU rasteriser, so the values mean nothing, only the mechanism was checked). The LOD picker was unit tested in Node.

```js
import * as THREE from 'three';

// Effect shaders opt in with:  #ifdef OVERDRAW  gl_FragColor = vec4(vec3(1.0 / 255.0), 0.0);  #endif  as their LAST line, with NO discard before it.
// Transparent texels still cost fill, so the count is quad coverage, which is what the GPU pays for.
// fxScene holds the effects only: occluders are ignored, so the result is an upper bound.
export function measureOverdraw(renderer, fxScene, camera, size = 256) {
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false });   // 8 bit, each layer adds exactly 1
  const mats = new Map();
  fxScene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) mats.set(m, { b: m.blending, s: m.blendSrc, d: m.blendDst, e: m.blendEquation, t: m.transparent, dt: m.depthTest }); });
  for (const m of mats.keys()) {
    Object.assign(m, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true, depthTest: false });
    m.defines = { ...m.defines, OVERDRAW: '' }; m.needsUpdate = true;
  }
  const col = new THREE.Color(), alpha = renderer.getClearAlpha(); renderer.getClearColor(col);
  const bg = fxScene.background; fxScene.background = null; renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(rt); renderer.render(fxScene, camera); renderer.setRenderTarget(null);
  renderer.setClearColor(col, alpha); fxScene.background = bg;
  for (const [m, s] of mats) {
    Object.assign(m, { blending: s.b, blendSrc: s.s, blendDst: s.d, blendEquation: s.e, transparent: s.t, depthTest: s.dt });
    delete m.defines.OVERDRAW; m.needsUpdate = true;
  }
  const px = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(rt, 0, 0, size, size, px); rt.dispose();
  let sum = 0, max = 0, covered = 0; const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) { const n = px[i]; if (n) { covered++; sum += n; if (n > max) max = n; } hist[n]++; }
  let acc = 0, p95 = 0; for (let n = 1; n < 256 && acc < covered * 0.95; n++) { acc += hist[n]; p95 = n; }
  return { coverage: covered / (size * size), meanLayers: covered ? sum / covered : 0, p95Layers: p95, maxLayers: max, layersPerScreenPixel: sum / (size * size) };
}

// WebGL2 GPU timer. One query in flight at a time, results arrive 1 to 3 frames later. Returns null when the extension is missing.
export class GpuTimer {
  constructor(gl) { this.gl = gl; this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); this.open = null; this.queue = []; this.ms = null; }
  get supported() { return this.ext !== null; }
  begin() { if (!this.ext || this.open) return; this.open = this.gl.createQuery(); this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.open); }
  end() { if (!this.open) return; this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.queue.push(this.open); this.open = null; }
  poll() {
    if (!this.ext) return null;
    const gl = this.gl, disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);     // true when the GPU was reset or throttled: discard samples
    while (this.queue.length && gl.getQueryParameter(this.queue[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.queue.shift();
      if (!disjoint) this.ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;     // nanoseconds to milliseconds
      gl.deleteQuery(q);
    }
    return this.ms;
  }
}

// on screen radius in pixels of a sphere of radius R at distance d (perspective camera, fovY in degrees)
export const screenPx = (R, d, fovY, viewportH) => (R / (d * Math.tan((fovY * Math.PI) / 360))) * (viewportH / 2);
// LOD with hysteresis: thresholds in px, `level` is the current level (0 = full)
export function pickLod(px, level, cuts = [160, 60, 16], hyst = 0.15) {
  let l = level;
  while (l < cuts.length && px < cuts[l] * (1 - hyst)) l++;     // move down only when clearly below the cut
  while (l > 0 && px > cuts[l - 1] * (1 + hyst)) l--;           // move up only when clearly above
  return l;
}
```

Reading the numbers:

| Stat | Meaning | Act when |
|---|---|---|
| `coverage` | Share of the screen touched by effects | High with low layers means one big sheet, fine |
| `meanLayers` | Average depth where covered | Above the tier row |
| `p95Layers`, `maxLayers` | Hotspots | Spikes at the emitter origin: spawn spread, fade early, smaller quads |
| `layersPerScreenPixel` | The budget number (coverage x mean) | Above the tier row |

Limits: effects only, no occluders (an upper bound), WebGL only, 255 layers saturate. Measure at the worst camera, not the default one.

## 4. GPU timing

CPU timers (`performance.now` around `render`) measure submission, not the GPU. Use GPU timers, and compare A against B instead of trusting one absolute number.

| Route | How | Notes |
|---|---|---|
| WebGL2 | `GpuTimer` above (`EXT_disjoint_timer_query_webgl2`): `begin()`, render, `end()`, `poll()` each frame | One query open at a time. Results arrive 1 to 3 frames later. Discard samples when `GPU_DISJOINT_EXT` is set. Availability and timer precision differ by browser and may be reduced for security (verify per target) |
| WebGPU | `new WebGPURenderer({ trackTimestamp: true })`, then `await renderer.resolveTimestampsAsync('render')` | Needs the `timestamp-query` feature. Returns milliseconds, also readable as `renderer.info.render.timestamp` (verify). Source checked in 0.187, not run |
| No timer available | DevTools Performance with the GPU track, Spector.js for draw calls (`performance-budget` section 7) | Manual |

Rules:
- **A/B by toggling** the effect and averaging 120 frames each. Report the difference in ms.
- **Wrap only the effect pass** when you need the effect's cost. A query around the whole frame hides it.
- **Do not ship the timer on by default.** Sample it a few frames per second if it feeds adaptive quality (section 8).
- **Do not read a query in the frame it was issued.** It stalls.
- SwiftShader or software GPUs give meaningless numbers. Use a real device.

## 5. Culling and distance LOD

| Problem | Solution |
|---|---|
| Stateless instanced particles set `frustumCulled = false` (`realtime-engine-features`) | Cull at effect level: keep a bounding sphere per effect (emitter radius plus max travel), test it against the camera frustum and toggle `visible`, or stop updating |
| Effects far away | Reduce `geometry.instanceCount`, drop soft particles, distortion and lights, then swap to one billboard, then nothing |
| Effects behind walls | Rarely worth occlusion queries. Distance plus frustum is enough |
| Stateful sims out of range | Pause the update, do not simulate what nobody sees. Let looping effects restart when they return |
| Effects with a long tail (smoke) | Cull the spawn, let living particles finish |

Choose the LOD from the **screen radius in pixels**, not metres (`screenPx` above), so a large explosion far away and a small spark close up both get the right level. Use `pickLod` with hysteresis (15 percent) or the level flickers at a boundary.

| Level | Screen radius (starting cuts) | Content |
|---|---|---|
| 0 | above 160 px | Full: all layers, distortion, lights, soft particles |
| 1 | 60 to 160 px | 50 percent particles, no distortion, no light |
| 2 | 16 to 60 px | 20 percent particles, hard edges, one sheet |
| 3 | below 16 px | Single billboard or skip |

Rules: change particle count by an alive-count cap, not by respawning. Fade the dropped particles instead of cutting them (alpha over 0.2 s). The LOD data belongs in the effect file (`vfx-graph-authoring`, `lod` block per level).

## 6. Pooling and effect budgets

- **Preallocate pools** of effect instances (mesh, material, buffers) at load. Spawning an effect is then `pool.acquire()`, `timeline.reset()` (`vfx-timing-choreography`), never `new` in the hot path. Release on the last cue.
- **Share materials and geometry** between instances of the same effect, per instance data goes in attributes or uniforms (`scene-assembly-prefabs`). One material means one shader compile.
- **Warm up:** run `await renderer.compileAsync(scene, camera)` with every pooled effect visible once, or the first hit hitches (`performance-budget` section 5).
- **Dispose** geometry, textures and targets when an effect type is retired. Check `renderer.info.memory` after a soak.

A scene wide budget manager keeps the worst case bounded:

| Rule | Behaviour |
|---|---|
| Cost points per effect (particles x average layers, from section 3) | Sum of active effects stays under the tier cap |
| Priority: player owned, then story, then ambient | Over budget, drop the lowest priority and farthest first |
| Per type cap (for example 6 explosions) | Over the cap, skip or recycle the oldest |
| Spawn rate limit | Max N new effects per frame, queue the rest for one or two frames |
| Never kill an effect at its impact frame | Drop at spawn time, not mid flight, or fade out over 0.2 s |
| Decals and debris | Ring buffer of fixed size (`vfx-impact-sparks-decals`) |

## 7. Reducing fill cost

| Technique | Saves | Cost or risk |
|---|---|---|
| **Tight quads:** replace the unit quad with a cut-out polygon (6 to 8 vertices) that hugs the sprite alpha | 20 to 50 percent of fill on round or wispy sprites (guess) | Slightly more vertices. Authoring in `vfx-flipbook-authoring` |
| Smaller, fewer particles with stronger texture detail | Fill scales with area | Needs better flipbooks |
| Crop flipbook cells to their alpha bounds and scale the quad to match | Fill and texture bandwidth | Extra data per frame, `vfx-flipbook-authoring` |
| **Half resolution particles**: render effects into a 0.5 scale target, composite over the scene | About 75 percent less fill | Blurry edges, halos at depth edges. Use a depth aware or nearest depth upsample, render with premultiplied alpha and composite `src + dst * (1 - a)`. Not verified end to end here (verify) |
| Lower precision: `material.precision = 'mediump'` (property exists on `Material`) | ALU on mobile GPUs | Banding or jitter in large worlds, test on device (verify gain) |
| Cheaper blending: additive needs no sorting, alpha needs sorting or OIT | Sorting cost and artefacts | Look differs |
| Fade out by size or alpha early | Wasted fill at the end of life | Slightly shorter look |
| Smaller pixel ratio for the effect target | Linear | Soft look |

Rules:
- **Large soft smoke is the usual culprit.** Fewer, bigger, slower puffs with a rich flipbook beat many small ones (`vfx-fire-smoke-explosion`).
- **Fade before the quad edge** so the sprite never needs the full quad.
- **`discard` and alpha-to-coverage can disable early depth tests on some mobile GPUs.** Do not assume discard saves fill, measure (verify).
- **Texture bandwidth:** compress flipbook sheets (KTX2), keep mips on, avoid 4k sheets for effects.

## 8. Quality presets

Keep every scalable knob in one object, read by the effect code, so a preset is one assignment.

```js
export const FX_PRESETS = {
  low:  { aliveCap: 5000,  countMul: 0.3, distScale: 0,   softParticles: false, trailSegments: 8,  lights: false, ca: false },
  mid:  { aliveCap: 20000, countMul: 0.7, distScale: 0.5, softParticles: true,  trailSegments: 16, lights: false, ca: true },
  high: { aliveCap: 50000, countMul: 1,   distScale: 0.5, softParticles: true,  trailSegments: 32, lights: true,  ca: true },
};
```

Selection:
1. Start from device tier (hardware concurrency, `renderer.capabilities`, a short benchmark, see `performance-budget`). Do not trust the user agent alone.
2. Adapt on measured frame time (CPU frame time, or the GPU timer from section 4): smooth with an average over 1 to 2 s, **step down one preset** after about 1 s above 1.2x the frame budget, step up only after about 10 s below 0.7x, never the same step twice within 5 s. Hysteresis stops oscillation.
3. Cheapest lever first: pixel ratio, then effect resolution and distortion, then particle counts, then lights, then post.
4. Let the user override and remember the choice.
5. Respect `prefers-reduced-motion` separately from quality (`vfx-timing-choreography`).

Rules: a preset change must not restart effects that are playing, apply it to new spawns and to caps. Effect files may carry per preset overrides, validated like any other field (`vfx-graph-authoring`).

## 9. Mobile fallbacks

| Feature | Fallback |
|---|---|
| Soft particles (scene depth) | Hard particles, fade alpha by view angle and distance |
| Distortion and refraction | Off, or a tint plus camera shake |
| Half float render targets | Check `renderer.extensions.has('EXT_color_buffer_float')` (verify the exact extension for your three revision), else 8 bit with a clamped range |
| Compute particles (WebGPU) | Stateless vertex shader particles (`gpu-particles-compute` fallback) |
| Sorted alpha smoke | Additive or premultiplied, no sorting |
| Lights spawned by effects | Emissive sprite only |
| Long trails | Fewer segments, shorter life (`particle-trails-ribbons`) |
| Bloom at full resolution | Half resolution (`post-processing-stack`) |
| 8x8 flipbooks | 4x4 with fewer frames |

Test with sustained load, not a 10 second run. Phones throttle after a minute or two. Check battery saver and low power mode, and the tab in the background (pause effects when hidden).

## 10. Verify

1. Run `measureOverdraw` on every effect at the worst camera. Record `layersPerScreenPixel` and `maxLayers`, compare with the tier row.
2. A/B each effect with the GPU timer on a real device per tier. Report ms.
3. Spawn the maximum number of simultaneous effects at once. The budget manager holds the frame time.
4. Move the camera through the LOD distances. No pop, no flicker at the boundaries.
5. Soak 5 minutes of spawn and release. `renderer.info.memory` flat, no growing heap.
6. Switch presets live. No restart of running effects, no console errors.
7. Throttled test: 4x CPU slowdown in DevTools plus a mid tier phone if available.

## 11. Not verified here

- The tier budget numbers are guesses, not measurements. No device was used.
- WebGPU timestamps (source read, not run), half resolution particle upsampling end to end, `mediump` gains, discard behaviour on mobile GPUs, timer precision per browser.
- The overdraw probe ignores occluders by design.

## 12. Do not do these

- Do not budget by particle count alone.
- Do not trust `performance.now` as a GPU cost.
- Do not allocate effects, materials or targets during play.
- Do not change quality every frame. Use hysteresis.
- Do not kill the player's own effects first when over budget.
