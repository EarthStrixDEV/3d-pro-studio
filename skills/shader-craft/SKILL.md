---
name: shader-craft
description: Custom shaders and procedural surfaces for Three.js — extending built-in PBR with onBeforeCompile, ShaderMaterial/RawShaderMaterial, TSL node materials for WebGPU, noise, fresnel, triplanar mapping, dissolve, holograms, vertex displacement, procedural geometry and shader debugging. Use when the look needs something built-in materials cannot do, when writing GLSL/TSL, or when a shader fails to compile or looks wrong.
---

# Shader Craft

## 1. Choose the lightest tool that works

| Goal | Tool |
|---|---|
| Tweak a PBR material (wind sway, dissolve, triplanar, colour ramp) and keep lights/shadows/env | `material.onBeforeCompile` patch on `MeshStandard/Physical` |
| Fully custom look (hologram, toon outline, raymarch, water surface) | `ShaderMaterial` (gets three's uniforms/chunks) |
| WebGPU renderer, or want composable nodes | TSL (`three/webgpu` + `three/tsl`) |
| Full-screen effect | `ShaderPass` in the composer (see `post-processing-stack`) |

Rewriting lighting from scratch in a `ShaderMaterial` almost always looks worse than patching PBR. Patch first.

## 2. onBeforeCompile pattern (keeps PBR, shadows, env)

```js
const uniforms = { uTime: { value: 0 }, uProgress: { value: 0 } };
material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWorldPos;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uProgress;\nvarying vec3 vWorldPos;\n' + NOISE_GLSL)
    .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      float n = snoise(vWorldPos * 2.0);
      if (n < uProgress * 2.0 - 1.0) discard;                       // dissolve
      float edge = smoothstep(0.0, 0.05, n - (uProgress * 2.0 - 1.0));
      gl_FragColor.rgb += (1.0 - edge) * vec3(4.0, 1.6, 0.4);       // HDR edge → blooms`);
};
material.customProgramCacheKey = () => 'dissolve-v1';   // distinct cache key per variant
```
- Anchor on chunk names (`#include <...>`), never on line numbers. Print `shader.fragmentShader` once to find anchors.
- Discarding fragments also needs the same logic in the shadow pass: set `mesh.customDepthMaterial` / `customDistanceMaterial` with the same patch, or shadows keep the full shape.
- Update `uniforms.uTime.value += dt` in the loop — uniform objects are shared by reference.

## 3. Snippets

`references/glsl-snippets.md`: simplex noise 3D, fbm, fresnel, triplanar sampling, hash/random, remap, SDF primitives, rotation, palette (iq cosine), hologram scanlines, vertex wind sway. Copy, don't re-derive.

## 4. TSL (WebGPU) equivalents

```js
import * as THREE from 'three/webgpu';
import { positionWorld, normalWorld, cameraPosition, uniform, mix, pow, dot, normalize, color, time, mx_noise_float } from 'three/tsl';
const mat = new THREE.MeshStandardNodeMaterial();
const viewDir = normalize(cameraPosition.sub(positionWorld));
const fresnel = pow(dot(normalWorld, viewDir).oneMinus().clamp(), 3);
mat.colorNode = mix(color('#1b3a6b'), color('#7fd6ff'), fresnel);
mat.emissiveNode = color('#7fd6ff').mul(fresnel.mul(2));
mat.positionNode = positionWorld.add(normalWorld.mul(mx_noise_float(positionWorld.mul(2).add(time)).mul(0.05)));
```
- `WebGPURenderer` falls back to WebGL2 automatically; `await renderer.init()` before first render.
- TSL APIs still move between releases — check the exact revision's examples before relying on a node name.

## 5. Procedural geometry (hero shapes without models)

- `LatheGeometry` (vases, bottles, lamps) with 64–128 radial segments and a smooth profile function.
- `ExtrudeGeometry` with `bevelEnabled: true, bevelSegments: 4–8, bevelSize ≈ 2–5% of size` for logos/panels.
- `TubeGeometry` along a `CatmullRomCurve3` for cables, handles, neon.
- `RoundedBoxGeometry` (addons) instead of `BoxGeometry` — always.
- Vertex displacement: displace in a shader (cheap, animatable) or bake into geometry then `computeVertexNormals()`; use `mergeVertices` first to avoid seams.

## 6. Debugging

- Compile errors print to console with line numbers; `renderer.debug.checkShaderErrors = true` (default) — render-qa surfaces them.
- Visualise intermediates: temporarily `gl_FragColor = vec4(vec3(n), 1.0);`.
- NaNs show as black pixels — guard `normalize()` of zero vectors and `pow()` of negatives.
- Precision: use `highp` for world positions on mobile; banding in noise → add dither.
- Performance: avoid branches on per-pixel data in hot shaders, prefer `step/mix`; keep noise octaves ≤ 4 on mobile.
