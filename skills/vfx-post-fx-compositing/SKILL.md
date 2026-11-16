---
name: vfx-post-fx-compositing
description: Screen-space effect compositing for Three.js VFX. Covers heat distortion and refraction with an offset buffer and a depth test against the scene, chromatic aberration, radial blur and speed lines, motion blur options, glitch and scanline looks, damage vignettes and screen flashes, HDR bloom interplay with additive particles, and the correct pass order relative to tone mapping (HDR stage versus display stage). Includes a verified screen FX pipeline with a distortion pass. Use when an effect needs to bend or tint the whole screen, when heat haze or a shockwave must warp the scene without warping what stands in front, when bloom blows out particles, when flashes or vignettes look wrong after tone mapping, or when a post effect needs a place in the pass chain. Thai triggers ภาพบิดเบี้ยวจากความร้อน, คลื่นกระแทก, สีเหลื่อมขอบจอ, เบลอรัศมี, เส้นสปีด, กลิทช์, ขอบจอแดงเวลาโดนตี, แฟลชหน้าจอ, บลูมจ้าเกิน.
argument-hint: "<screen effect wanted, and what must stay sharp or undistorted>"
---

# VFX Post FX & Compositing

Screen effects are cheap per pixel and expensive in passes. Decide which stage each effect lives in, then keep the chain short. Pass order basics, bloom, GTAO, DOF and LUT are in `post-processing-stack`, colour space and grading in `color-management-grading`. Particle draw state is in `particle-rendering-blending`, timing of flashes and shake in `vfx-timing-choreography`.

## 1. Pass order

Two stages, split by tone mapping. Effects that depend on scene brightness go before it, graphic overlays go after it.

| Order | Effect | Stage | Why here |
|---|---|---|---|
| 1 | Scene and particles into a half float target | HDR linear | Values above 1 must survive |
| 2 | Distortion, refraction, shockwave | HDR | Warps the scene, so everything after it warps too |
| 3 | Radial blur, motion blur, DOF (`post-processing-stack`) | HDR | Blurring HDR keeps bright cores bright |
| 4 | Bloom | HDR | Needs values above the threshold. Sees the warped image only if it runs after step 2 |
| 5 | Chromatic aberration, glitch block shift | HDR | Fringes on highlights need HDR values |
| 6 | Grade, LUT, tone map, sRGB encode | Boundary | One tone mapper, once (`color-management-grading`) |
| 7 | Vignette, damage tint, flash, scanlines, speed lines, grain | Display, 0..1 | A flash must reach exactly the colour you set, a tone mapper would dim it |
| 8 | FXAA or SMAA, then UI | Display | Antialiasing after tone mapping (`antialiasing-resolution`). TAA sits before 6 |

Rules:
- **Render targets are `HalfFloatType`**, linear, no tone mapping. Three applies tone mapping and output colour space only when rendering to the screen (`renderTarget === null`), so a final `ShaderMaterial` that includes `<tonemapping_fragment>` and `<colorspace_fragment>` is the boundary. Code after those includes works in sRGB display values.
- **Tone map once.** Never leave `renderer.toneMapping` on and also run an `OutputPass` or grade that tone maps.
- **Merge cheap effects into one fullscreen shader.** CA, radial blur, glitch, vignette, flash and scanlines share one pass (sample below). Each extra pass costs a full screen read and write.
- **Do not put bloom after the composite stage 7.** Overlays would glow.

## 2. Verified screen FX pipeline with distortion

Checked in headless Chromium (SwiftShader, three 0.187): distortion shifted visible pixels (mean difference 27 of 255), pixels where a solid object stood in front of the distortion quad stayed identical with the depth test (0) and changed without it (52.7), pixels outside the quad did not change, an HDR value of 4 reached the tone mapper and came out below 255, all effects on at once gave no GL error and no NaN, and a resize kept the render targets, depth texture and half resolution target consistent.

```js
import * as THREE from 'three';

export function createScreenFx(renderer, scene, camera, distScene, { distScale = 0.5 } = {}) {
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
  const distRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });   // signed uv offsets in rg, no depth buffer
  const shared = { uSceneDepth: { value: sceneRT.depthTexture }, uDistSize: { value: new THREE.Vector2() } };
  const u = {
    tScene: { value: sceneRT.texture }, tDist: { value: distRT.texture }, uRes: { value: new THREE.Vector2() },
    uStrength: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uRadial: { value: 0 }, uCA: { value: 0 },
    uGlitch: { value: 0 }, uTime: { value: 0 },                                    // HDR stage, before tone mapping
    uVignette: { value: 0 }, uVigColor: { value: new THREE.Color(0.8, 0.05, 0.05) }, // display stage, after tone mapping
    uFlash: { value: 0 }, uFlashColor: { value: new THREE.Color(1, 1, 1) }, uScan: { value: 0 }, uSpeed: { value: 0 },
  };
  const post = new THREE.Scene();
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: u, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene, tDist; uniform vec2 uRes, uCenter; uniform vec3 uVigColor, uFlashColor;
      uniform float uStrength, uRadial, uCA, uGlitch, uTime, uVignette, uFlash, uScan, uSpeed;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 uv = vUv + texture2D(tDist, vUv).rg * uStrength;                       // heat, refraction: first, in HDR
        float row = floor(uv.y * 24.0);                                             // glitch: shift whole row blocks
        uv.x += step(0.93, hash(vec2(row, floor(uTime * 12.0)))) * (hash(vec2(row, uTime)) - 0.5) * 0.08 * uGlitch;
        vec2 d = uv - uCenter;
        vec3 c;
        if (uRadial + uCA > 0.0) {                                                  // radial blur with chromatic split per tap
          c = vec3(0.0);
          for (int i = 0; i < 8; i++) {
            float k = 1.0 - uRadial * float(i) / 7.0;
            vec2 p = d * k;
            float ca = uCA * length(p);
            c += vec3(texture2D(tScene, uCenter + p * (1.0 + ca)).r, texture2D(tScene, uCenter + p).g, texture2D(tScene, uCenter + p * (1.0 - ca)).b);
          }
          c /= 8.0;
        } else c = texture2D(tScene, uv).rgb;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // display space from here: values are 0..1 and sRGB encoded
        float r = length(vUv - 0.5) * 1.4142;
        float ang = atan(vUv.y - 0.5, vUv.x - 0.5);
        float streak = smoothstep(0.55, 1.0, hash(vec2(floor(ang * 60.0), floor(uTime * 20.0)))) * smoothstep(0.35, 0.8, r) * uSpeed;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), streak);
        gl_FragColor.rgb *= 1.0 - uScan * (0.5 + 0.5 * sin(vUv.y * uRes.y * 3.14159));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uVigColor, smoothstep(0.35, 1.0, r) * uVignette);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uFlashColor, uFlash);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  post.add(quad);

  const col = new THREE.Color();
  return {
    uniforms: u, shared, sceneRT, distRT,
    setSize() {                                            // call on resize, in drawing buffer pixels
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      sceneRT.setSize(s.x, s.y);
      distRT.setSize(Math.max(1, Math.round(s.x * distScale)), Math.max(1, Math.round(s.y * distScale)));
      u.uRes.value.copy(s); shared.uDistSize.value.set(distRT.width, distRT.height);
    },
    render() {
      renderer.setRenderTarget(sceneRT); renderer.render(scene, camera);
      const a = renderer.getClearAlpha(); renderer.getClearColor(col);
      renderer.setClearColor(0x000000, 0);                 // offset buffer must clear to zero offset
      renderer.setRenderTarget(distRT); renderer.render(distScene, camera);
      renderer.setClearColor(col, a);
      renderer.setRenderTarget(null); renderer.render(post, ortho);
    },
  };
}

// Example distortion source: a screen facing quad pushing pixels outward and swirling. Depth tested by hand against the scene depth.
export function makeHeatMaterial(shared, { amount = 0.02, noiseScale = 9, speed = 5 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    uniforms: { ...shared, uTime: { value: 0 }, uAmount: { value: amount }, uDepthTest: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D uSceneDepth; uniform vec2 uDistSize; uniform float uTime, uAmount, uDepthTest;
      varying vec2 vUv;
      void main() {
        float d = texture2D(uSceneDepth, gl_FragCoord.xy / uDistSize).r;
        if (uDepthTest > 0.5 && gl_FragCoord.z > d) discard;                   // something solid is in front: leave it alone
        float fall = 1.0 - smoothstep(0.0, 1.0, length(vUv - 0.5) * 2.0);
        vec2 n = vec2(sin(vUv.y * ${noiseScale.toFixed(1)} + uTime * ${speed.toFixed(1)}), cos(vUv.x * ${noiseScale.toFixed(1)} + uTime * ${speed.toFixed(1)}));
        gl_FragColor = vec4(n * uAmount * fall, 0.0, 0.0);                      // signed offset in uv units
      }`,
  });
}
```

Usage: call `fx.setSize()` after every renderer resize, add distortion meshes to `distScene` (they never go into the main scene), and `fx.render()` replaces `renderer.render`. Drive `fx.uniforms.uTime` from the ui clock so glitch and speed lines keep moving during a hit stop. Bloom is not in this sample. To bloom the distorted image, run distortion as its own pass and feed that into bloom (`post-processing-stack`), or accept a halo that does not warp for subtle haze.

## 3. Heat distortion and refraction

| Method | Use | Notes |
|---|---|---|
| **Offset buffer** (the sample) | Fire haze, jet exhaust, shockwave rings, magic ripples | Particles write a signed uv offset, composite samples the scene at `uv + offset`. One scene render, one half resolution buffer |
| Scene copy per object | One glass pane or one portal | `MeshPhysicalMaterial.transmission` or a render target per object. Costs a scene render each, use for hero objects only (verify cost on target) |
| Screen space normal sampling | Water, ice, frosted glass | Material samples the scene copy at `uv + normal.xy * k` |

Rules:
- **Store signed offsets in a half float target**, additive blend with `OneFactor` on both sides (`CustomBlending`), so overlapping sources sum. `AdditiveBlending` multiplies colour by alpha and is wrong here.
- **Clear the offset buffer to zero.** The renderer clear colour is used, so the sample sets it to black alpha 0 around that pass and restores it.
- **Depth test by hand against the scene depth** (shared `uSceneDepth`). The offset buffer has no depth buffer of its own because it is half resolution and a shared depth texture needs equal size. Without the test, a character standing in front of a heat haze quad wobbles.
- **Clamp the offset** to about 0.01 to 0.03 in uv (guess). Big values show the buffer edge and smear text.
- **Fade by distance from the source.** The `fall` term in the sample. A hard quad edge shows as a visible line.
- **Animate with a scrolling noise or normal map**, not a sine pair, for fire. Sine is fine for shockwave rings. Shockwave: ring mask `smoothstep` around `radius`, radius grows over life.
- **Half resolution costs edge halos** around thin occluders. Raise `distScale` to 1 if visible.
- **Sorting:** the offset buffer sums, so it needs no particle sorting.

## 4. Chromatic aberration, radial blur, speed lines

All three live in the composite shader above and share the radial tap loop.

| Effect | Uniform | Starting value (guess) | Notes |
|---|---|---|---|
| Chromatic aberration | `uCA` | 0.005 to 0.03 on impacts, 0 otherwise | Per channel scale grows with distance from centre, like a lens. Pulse it, constant CA looks cheap |
| Radial blur (dash, warp, boost) | `uRadial` | 0.05 to 0.2 | 8 taps zooming toward `uCenter`. Move `uCenter` to the character or target on screen (project with `Vector3.project(camera)`) |
| Speed lines | `uSpeed` | 0.3 to 1 | Display stage mask: angular hash streaks that start away from the centre |

Rules:
- **Skip the loop when both are zero** (the `if` on a uniform in the sample). 24 fetches per pixel are not free.
- **Radial blur is not motion blur.** It fits a dash or a boost. For general camera blur see section 5.
- **Reduce taps on mobile** (4 instead of 8) and halve strength to hide banding. Tier rules in `vfx-performance-scaling`.
- **Keep the subject readable:** mask the blur with a centre radius so the character stays sharp, only the edges streak.

## 5. Motion blur

three.js has no built in motion blur pass. Pick by need.

| Need | Method | Cost |
|---|---|---|
| Fast dash or boost | Radial blur (section 4) | Cheap |
| Fast moving particles | Stretch the billboard along its screen space velocity (`particle-rendering-blending`, `particle-trails-ribbons`) | Near free, usually the best answer |
| Trailing ghost feel | `AfterimagePass` (`three/addons/postprocessing`, constructor takes `damp`, default 0.96) | One extra full screen pass, smears the whole frame, no velocity awareness |
| True camera and object blur | Custom velocity buffer pass (own work) | High. Needs previous matrices per object. Not worth it for most web effects |
| Anti judder at low frame rates | Do not fake it | Frame pacing first |

## 6. Glitch and scanlines

| Look | Technique | Notes |
|---|---|---|
| Block shift | Row hash gated by `step` and `floor(time * rate)` (in sample, `uGlitch`) | Stepped time makes it jump, smooth time makes it wobble |
| RGB split | CA with a larger value, or `RGBShiftShader` (`amount`, `angle`) from `three/addons/shaders` | Offset along the glitch direction |
| Digital noise | `GlitchPass` from `three/addons/postprocessing` | Ready made, own pass, less control |
| Scanlines | `1 - uScan * (0.5 + 0.5 * sin(y * resolution.y * PI))` in display space | Resolution aware so lines stay 1 pixel. Aliases when the DPR changes, test at 1x and 2x |
| Film grain | `FilmPass` or a hash in the display stage | Keep it low, it fights AA and compression |

Rules: gate glitch by a short burst envelope (50 to 300 ms), not continuous. Respect photosensitivity: no full screen flicker faster than 3 flashes per second, and provide a reduced motion switch that sets `uGlitch`, `uFlash` and speed lines to zero.

## 7. Damage vignette and flashes

Both are display stage (section 1, step 7).

| Effect | Shape | Timing (guess) |
|---|---|---|
| Damage vignette | `smoothstep(0.35, 1.0, r)` mixed to a red colour, `r` is distance to the screen centre | Spike to 0.6 to 0.8 on hit, decay over 0.4 to 0.8 s. Low health: pulse at 1 to 1.5 Hz at 0.2 to 0.35 strength |
| Hit flash | Mix to white or a tint over the whole frame | Alpha 0.3 to 0.6 for 80 to 150 ms, fire on the impact frame |
| Screen fade, teleport | Mix to black or white | Ease in out, 200 to 500 ms |
| Heal or power up | Soft tint vignette in green or gold | Slower, 0.6 to 1 s |

Rules:
- **Display stage on purpose.** Mixing to white before tone mapping is dimmed and desaturated by the tone mapper, so the flash looks grey and late.
- **Run on the ui clock**, not world time, so it plays during hit stop (`vfx-timing-choreography`).
- **Drive from a decaying value**, not a boolean, and clamp the sum of all sources so simultaneous hits do not saturate the screen.
- **Vignette colour is a design choice that must hold contrast** with HUD text (`hud-ui-labels`).
- **Aspect:** the sample's `r` is in uv space, so the vignette is elliptical on a wide screen. Correct with `(vUv - 0.5) * vec2(aspect, 1.0)` when you want a circle.

## 8. Bloom and additive particles

Additive overdraw sums. Fifty overlapping sparks at 0.5 each reach 25, bloom takes it as a sun.

| Problem | Fix |
|---|---|
| Particle clump blooms into a white blob | Clamp per fragment (`min(color, vec3(uMaxHdr))`, 2 to 4 as a start), lower alpha with density, or use alpha blending for the dense core |
| Everything blooms | Raise the bloom threshold above 1 so only emissive HDR parts glow. `UnrealBloomPass` exposes `strength`, `radius`, `threshold` (checked in 0.187 source) |
| Only some effects should glow | Selective bloom: render the glowing layer into its own target, bloom that, add it back. Costs a pass, use for hero effects |
| Bloom flickers with particle count | Cap the count per cell and size, smooth the intensity over time |
| Dark scene, dim particles | Raise emissive values above 1, do not raise bloom strength |
| Soft particles near geometry glow as a hard line | Fade with scene depth (`vfx-fire-smoke-explosion`), see `particle-rendering-blending` |

Rules: author particle colours in linear HDR (values 0 to 5), compare with and without bloom, and tune the exposure and bloom together (`lighting-ibl-shadows`, `post-processing-stack`). Half resolution particles lower both fill cost and bloom flicker but add edge artefacts (`vfx-performance-scaling`).

## 9. Cost notes (guess, measure on target)

| Effect | Extra cost |
|---|---|
| Offset buffer (half res) | One scene sized pass of the particles plus one fetch in the composite |
| Composite with CA and radial blur | 24 fetches per pixel when active, 1 when idle |
| Selective bloom | One extra target and the blur chain |
| AfterimagePass | One extra full screen pass plus a history target |
| Glitch, vignette, flash, scanlines | Almost nothing inside the shared pass |

Budget against `performance-budget`. Disable chromatic blur and distortion first on low tiers, keep the flash and vignette, they are almost free.

## 10. Verify (`render-qa`)

1. Toggle each effect alone and then all together. No NaN, no black frame, no GL errors.
2. Distortion: put a solid object in front of the source. It must not wobble. Move it behind. It must distort.
3. Strong highlights: confirm CA fringes appear on bright edges and the flash reaches the set colour exactly.
4. Check at DPR 1 and 2 and after a window resize. Targets resize, scanlines stay one pixel.
5. Bloom on and off with 200 overlapping additive particles. No blob, no flicker.
6. Reduced motion on: glitch, flash, speed lines and CA are zero.
7. Frame time with all effects on, on the lowest tier target device.

## 11. Not verified here

- Frame costs and all numeric starting values are guesses.
- The depth test with an MSAA main target (the sample used a non antialiased target). WebGPU and TSL equivalents.
- `MeshPhysicalMaterial.transmission` cost on mobile, selective bloom wiring, XR rendering.

## 12. Do not do these

- Do not tone map twice, and do not tone map overlays.
- Do not distort objects that stand in front of the source.
- Do not run CA, vignette and flash as separate full screen passes.
- Do not leave glitch or flashes on continuously.
- Do not raise bloom strength to fix dim particles. Raise emissive.
