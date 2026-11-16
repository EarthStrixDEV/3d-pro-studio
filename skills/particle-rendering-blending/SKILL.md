---
name: particle-rendering-blending
description: How to draw particles correctly in Three.js. Covers point sprites versus instanced billboards, velocity-stretched and mesh particles, soft particles using the opaque depth buffer (tested sample), sorting versus order-independent approaches, blend modes (normal, additive, premultiplied alpha, multiply) and when each is correct with the exact three.js blend functions, overdraw cost and how to cut it, flipbook and atlas sampling with frame blending, lit particles with normal maps, and HDR values feeding bloom. Use when particles look flat, show hard edges where they meet geometry, flicker or sort wrong, wash out to white, have dark halos, cost too much fill rate, or must glow. Thai triggers เรนเดอร์พาร์ติเคิล, soft particle, blend mode, ขอบแข็งตรงที่ชนฉาก, อนุภาคเรืองแสง, overdraw, sprite sheet.
argument-hint: "<particle look wanted (fire, smoke, sparks, dust, magic), blend and lighting needs, target tier>"
---

# Particle Rendering & Blending

Simulation gives positions (`particle-system-architecture`, `gpu-particles-compute`). This skill decides how each one becomes pixels. For one working instanced billboard flipbook sample see `realtime-engine-features` section 2, it is not repeated here.

## 1. Pick the particle form

| Form | Use when | Limits |
|---|---|---|
| `Points` (point sprite) | Dust, stars, rain specks, millions of tiny particles | `gl_PointSize` is clamped by the GPU (check `gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)`), no rotation, culled when the centre leaves the screen, size attenuation is manual |
| Instanced quad billboard | Default for smoke, fire, magic. Rotation, flipbook, soft edges | One quad per particle, fill rate grows with size |
| Velocity-stretched quad | Sparks, rain streaks, speed lines | Needs velocity in the shader (section 3) |
| Axis-aligned billboard | Grass tufts, far trees, vertical beams | Locks one axis, looks wrong from above |
| Mesh particle (`InstancedMesh`) | Debris, leaves, shards, anything with a silhouette | Triangles times count, lit by real lights, can use `MeshStandardMaterial` |
| Ribbon or tube | Trails, beams, lightning | `particle-trails-ribbons` |

Rules: one draw call per effect, `frustumCulled` handled per `particle-system-architecture` section 8, no per-particle `Mesh`.

## 2. Billboards

- **Camera-facing (spherical):** offset the corner in view space after the model-view transform (`mv.xy += position.xy * size`). Cheap and matches the sample in `realtime-engine-features`. Add rotation by rotating `position.xy` by the particle angle before the offset.
- **Axis-locked:** build the right vector from the cross of the axis and the view direction.
- **Size in pixels** (UI-like): divide by `-mv.z` and the projection scale. Distance attenuated size is the normal case for world effects.
- **Near fade:** a quad that passes the camera fills the screen. Fade alpha with `smoothstep(near, near + 0.5, -mv.z)` and clip if closer.
- **Pivot:** place the pivot where the effect rotates (smoke puff centre, flame base), not always the quad centre.

## 3. Velocity-stretched particles

Stretch the quad along the screen-space velocity. Not run here, test it on your scene.

```glsl
// vertex: aVel is world velocity, uStretch scales length per unit speed
vec4 mv = modelViewMatrix * vec4(center, 1.0);
vec2 dir = (viewMatrix * vec4(aVel, 0.0)).xy;
float speed = length(dir);
vec2 axis = speed > 1e-4 ? dir / speed : vec2(1.0, 0.0);
vec2 side = vec2(-axis.y, axis.x);
float len = size * (1.0 + speed * uStretch);
mv.xy += axis * position.x * len + side * position.y * size;
```

Clamp `len` so a fast particle cannot become a screen-wide bar. Fade alpha with the stretch so thin streaks do not look solid. Sparks: stretch plus HDR colour (section 9) plus short life.

## 4. Soft particles

Without them, a billboard meets a wall with a hard line. Soft particles fade alpha by how far the particle is in front of the opaque surface behind it.

Tested in headless Chromium (WebGL2, software rasteriser), three r187: three billboards 0.05, 0.5 and 3 units in front of a wall with a 1 unit fade read back alpha 13, 128 and 255 of 255, exactly the expected values.

```js
import * as THREE from 'three';

// Soft particles: fade a billboard where it meets opaque geometry, using the opaque scene depth.
export function createSoftParticle(depthTexture, size, camera, fadeDistance = 1) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,        // depth is sampled, not tested
    uniforms: {
      uDepth: { value: depthTexture },
      uRes: { value: new THREE.Vector2(size.x, size.y) },           // drawing buffer size in pixels
      uNear: { value: camera.near }, uFar: { value: camera.far },
      uFade: { value: fadeDistance },                               // world units over which it fades in
    },
    vertexShader: /* glsl */ `
      varying float vViewZ; varying vec2 vUv;
      void main() {
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);       // particle centre in view space
        mv.xy += position.xy;                                       // camera facing billboard
        vViewZ = mv.z;                                              // negative in front of the camera
        vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D uDepth; uniform vec2 uRes; uniform float uNear, uFar, uFade;
      varying float vViewZ; varying vec2 vUv;
      void main() {
        float d = texture2D(uDepth, gl_FragCoord.xy / uRes).x;
        float sceneZ = perspectiveDepthToViewZ(d, uNear, uFar);     // view space z of the opaque surface
        float soft = clamp((vViewZ - sceneZ) / uFade, 0.0, 1.0);    // 0 at the surface or behind it, 1 when far in front
        float shape = 1.0 - smoothstep(0.3, 0.5, length(vUv - 0.5));
        gl_FragColor = vec4(vec3(1.0), shape * soft);
      }`,
  });
}

// Per frame, with an opaque target that owns a depth texture:
//   renderer.setRenderTarget(opaqueRT); renderer.render(opaqueScene, camera);
//   renderer.setRenderTarget(null);     draw opaqueRT.texture to the screen (fullscreen quad), then
//   renderer.autoClear = false;         renderer.render(particleScene, camera);
export function createOpaqueTarget(w, h) {
  return new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h) });
}
```

Rules:
- **Depth cannot be read while it is written.** Render the opaque scene into a target that owns a `DepthTexture`, draw that colour to the screen, then render particles to the screen sampling the texture. Never attach the same depth texture to the target you are drawing particles into (feedback loop).
- **Particles stay out of the depth texture.** Render them in a separate pass, with `depthTest: false` as in the sample, because soft fade also hides particles behind walls.
- Keep `near` and `far` tight. `perspectiveDepthToViewZ` loses precision at long ranges, so soft edges stair-step far away.
- **Logarithmic depth buffer or reversed depth:** this conversion assumes the standard perspective depth (verify before combining).
- **MSAA:** a multisampled target needs a resolved depth (verify per renderer version). Check `render-qa` shots.
- Fade distance by effect: small sparks 0.1, smoke 0.5 to 2 (world units, match particle radius).
- With a post stack (`post-processing-stack`) reuse its scene depth if it exposes one instead of a second opaque render. Rendering the opaque scene twice costs a whole extra scene pass.

## 5. Sorting versus order-independent

Three sorts transparent objects by object position, not by instance. Inside one instanced draw the order is the buffer order.

| Look | Blend | Sorting needed |
|---|---|---|
| Fire, sparks, glow, energy | Additive | None. Addition is commutative |
| Dust, light smoke, magic dust | Premultiplied alpha, low alpha | Often not noticeable. Test it |
| Dense smoke, steam, clouds | Alpha blended | Back to front per instance |
| Soot, dirt, darkening | Multiply | None, if layered once |

When sorting is required:

| Method | Cost | Notes |
|---|---|---|
| Split into layers and set `renderOrder` per layer | Free | Smoke behind, fire in front. Good enough for most effects |
| CPU sort of instance indices by view depth each frame | `O(n log n)`, fine under a few thousand | Write instance data in sorted order. Possible only for CPU particles or readback |
| GPU sort (`BitonicSort`, `CountingSort`, WebGPU only) | Compute passes | `gpu-particles-compute` section 7 |
| Chunked draws sorted by chunk centre | Free | WebGL2 GPU particles. Order inside a chunk is arbitrary |
| Weighted blended OIT (accumulate colour times weight and revealage, composite) | Two extra targets, one composite | Approximate. No built-in in three (verify addons). Writes needed in your own shader |
| Stochastic transparency (noise discard, or `alphaToCoverage: true` with MSAA) | Cheap | Looks noisy without TAA or many samples. `alphaToCoverage` is a `Material` property |

Do not use `depthWrite: true` on soft alpha sprites, their edges would clip those behind.

## 6. Blend modes

Exact blend functions three uses (from `WebGLState`, r187). Alpha is the shader output alpha.

| Mode | `premultipliedAlpha: false` (default) | `premultipliedAlpha: true` |
|---|---|---|
| `NormalBlending` | `src.a * src + (1 - src.a) * dst` | `src + (1 - src.a) * dst` |
| `AdditiveBlending` | `src.a * src + dst` | `src + dst` |
| `MultiplyBlending` | Error, requires `premultipliedAlpha: true` | `src * dst + (1 - src.a) * dst` |
| `SubtractiveBlending` | Error, requires `premultipliedAlpha: true` | `dst * (1 - src)` |
| `CustomBlending` | Set `blendSrc`, `blendDst`, `blendEquation` yourself | Same |

When each is correct:
- **Additive:** emissive things (fire core, sparks, lasers, magic). Never smoke, it can only brighten. Overlap saturates to white, so lower alpha or HDR scale when dense.
- **Normal, alpha:** opaque-ish stuff that must occlude (dense smoke, leaves). Needs sorting.
- **Premultiplied alpha:** the best default for textured sprites. The same texture can be additive and occluding at once: colour above 0 with alpha 0 adds light, alpha above 0 blocks it. This is how one sprite carries a fire front that fades into smoke. It also removes dark halos from bilinear filtering of transparent texels.
  - With `ShaderMaterial` you must output premultiplied colour yourself: `gl_FragColor = vec4(rgb * a, a)`.
  - The texture must be authored or converted premultiplied. Set `texture.premultiplyAlpha = true` only for textures loaded as images that are not premultiplied (verify the flag for your loader).
- **Multiply:** darkening decals, shadow blobs, dirt. With the premultiplied form, alpha lerps from no change to full multiply.
- **Dark halos around soft sprites** mean straight alpha filtered against black texels. Fix by premultiplying, or by bleeding the edge colour into transparent texels at export (`vfx-flipbook-authoring`).

## 7. Overdraw

Particle cost is pixels shaded, not particle count. One 200 px quad overdrawn 30 times costs 1.2 million fragments.

| Lever | Effect |
|---|---|
| Fewer, smaller quads | Linear saving. Biggest win |
| Trim the quad to the sprite's opaque area | Cuts empty corners. Use a cropped polygon (8 to 12 vertices) rather than a quad for big smoke sprites |
| Near fade and distance fade | Removes the few full-screen quads that dominate cost |
| Lower alpha threshold discard | Saves blend on near-empty pixels (`if (a < 0.01) discard;`), but it breaks early-z, test it |
| Half-resolution offscreen pass for smoke, composited up | Quarter the cost. Edges need depth-aware upsample, soft particles need a downsampled depth |
| Cheaper fragment shader (no lighting, no multiple fetches) | Linear |
| Texture mip bias, smaller atlas | Fewer texture misses on big sprites |

Measure with a debug view: render with additive blending at alpha 0.05 and white, read the brightness as an overdraw heat map. Cap particle count per screen area per tier in `performance-budget` and `vfx-performance-scaling`.

## 8. Flipbook and atlas sampling

The cell lookup for a grid atlas is in `realtime-engine-features` section 2 (`frame = floor(t * cells)`). Additions:

- **Frame blending:** sample two neighbouring cells and mix by `fract(t * cells)` to get smooth animation from few frames. Doubles texture fetches. Not run here.
  ```glsl
  float f = t * (cols * rows - 1.0), f0 = floor(f), f1 = min(f0 + 1.0, cols * rows - 1.0);
  vec4 c = mix(sampleCell(f0), sampleCell(f1), fract(f));   // sampleCell does the grid math
  ```
- **Bleed at cell edges:** bilinear and mipmaps read neighbouring cells. Leave a 2 to 4 px gutter per cell, or turn mipmaps off for small sprites. Sprites with strong alpha at the cell edge show seams.
- **Per-particle phase:** offset the frame by the particle seed so a cloud does not animate in lockstep. Pick a random start cell and optionally mirror `uv.x` per particle.
- **Colour space:** colour sheets are `SRGBColorSpace`, data sheets (normals, flow) `NoColorSpace`.
- **Row order:** image rows run top to bottom, UV `v` runs bottom to top. The sample's `rows - 1 - row` handles it.
- **Motion-vector flipbooks** (smooth flow between frames) and authoring of the sheets: `vfx-flipbook-authoring`.

## 9. Lit particles

| Level | Method | Cost |
|---|---|---|
| Unlit | Colour from texture and over-life ramp | Cheapest. Right for fire, sparks, magic |
| Fake lit | Darken by a fixed ambient, tint from `scene.environment` colour once per effect | Nearly free. Good for dust and light smoke |
| Normal-mapped sprite | Sprite sheet normals (view-space or billboard tangent space), `dot(n, L)` for one directional light in the shader | One more texture fetch. Rotate the normal with the particle angle (verify the sign convention in your authoring tool) |
| Six-way lighting | Two sheets baked from lit renders, blended by the light direction | Best smoke, needs authoring (`vfx-flipbook-authoring`) |
| Mesh particles with `MeshStandardMaterial` | Real lights, shadows, environment | Triangles and instancing only. Debris and leaves |

Rules:
- Light direction in the shader must be in the same space as the normals (view space for view-aligned billboards). Convert light direction with `viewMatrix` on the CPU once per frame.
- Alpha smoke does not need shadows. Receiving and casting shadows costs heavily for little gain, use a darker bottom gradient.
- Emissive parts (flame cores) ignore the lighting, add them after.

## 10. HDR values and bloom

Bloom keys off values above the threshold. Particles that should glow must output colour above 1 and the buffer must be a half-float target (the default of a proper post stack, `post-processing-stack`).

- Multiply the colour by an intensity: `rgb * uIntensity` with 2 to 10 for sparks and cores, 1 or below for smoke. Alpha stays 0 to 1.
- Additive overlaps add intensity, so ten overlapping 0.5 particles reach 5 and bloom hard. Tune the dense core down rather than raising the bloom threshold.
- Do not include `<tonemapping_fragment>` or `<colorspace_fragment>` in a particle shader that renders into a post stack target. The output pass does the tone mapping once. Rendering straight to the screen needs both (as in `realtime-engine-features`).
- In a `ShaderMaterial`, tone mapping and colour space conversion only happen where you include those chunks, so you control them directly.
- Selective glow: only emissive effects above the threshold bloom, do not boost whole scenes (`post-processing-stack`).
- Clamp the maximum intensity. A single 1000 value in a float buffer spreads a bloom flare across the screen.

## 11. Verify

1. Look at the effect against a dark and a bright background. Halos appear on one of them.
2. Orbit through the effect. Order flipping (popping) means sorting is needed.
3. Put it against a wall and a floor. Hard intersection lines mean soft particles are missing.
4. Overdraw heat map (section 7) at the closest expected camera. Heavy spots must stay local.
5. Run `render-qa` on a real GPU and read frame time with the effect on and off. Budget with `performance-budget`.
6. Toggle bloom. The effect must still read without it.

## 12. Do not do these

- Do not use additive blending for smoke.
- Do not enable `depthWrite` on soft alpha sprites.
- Do not sort per frame on CPU past a few thousand particles.
- Do not make large full-opacity quads near the camera without a near fade.
- Do not read and write the same depth texture in one pass.
- Do not guess `premultipliedAlpha`, check halos on a dark and a bright background.

Related: `particle-system-architecture`, `gpu-particles-compute`, `particle-trails-ribbons`, `vfx-flipbook-authoring`, `vfx-post-fx-compositing`, `vfx-performance-scaling`, `volumetrics-atmosphere`.
