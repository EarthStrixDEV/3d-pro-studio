---
name: raytracing-light-transport
description: Ray tracing and how light falls on surfaces in Three.js. Covers the light-incidence math that matters (Lambert cosine law, Fresnel and Schlick, GGX, energy conservation, inverse-square falloff, physical light units), when to approximate (IBL, baked lightmaps, light probes, SSR, SSGI, hybrid) versus really trace, and how to path trace in the browser (three-gpu-pathtracer with three-mesh-bvh, sample counts, denoising, progressive accumulation, WebGPU compute), with a decision table, a code sample per route, a fallback ladder per device tier and a render-qa check. Use when light looks fake, indirect light or colour bleeding is missing, reflections or glass need to be correct, surfaces are too dark at grazing angles or too hot, a physically based or "ray traced" look is requested, or when choosing between baked, screen-space and path-traced lighting. Thai triggers เรย์เทรซซิ่ง, ไพธ์เทรซ, แสงตกกระทบ, แสงสะท้อน, แสงเด้ง, แสงสมจริง, global illumination.
argument-hint: "<scene or surface that looks lit wrong, and target device tier>"
---

# Ray Tracing & Light Transport

Pick the cheapest method that gets the light right where the camera looks. Path tracing is the reference, not the default. Budgets live in `performance-budget`.

## 1. Pick the route

| Need | Route | Dynamic | Cost | Section |
|---|---|---|---|---|
| Believable ambient and reflections, any device | IBL (`lighting-ibl-shadows`) | lights yes, geometry yes | Lowest | 4 |
| Static scene, soft indirect light and colour bleeding | Baked lightmap or baked AO | no | Offline plus 1 texture | 4 |
| Moving objects in a baked room | Light probes on top of lightmap | partly | Low | 4 |
| Contact darkening between objects | GTAO or N8AO (`post-processing-stack`) | yes | Low to mid | 4 |
| Reflections of on-screen objects on glossy floors | SSR | yes | Mid. Off-screen content missing | 4 |
| Dynamic indirect light, on-screen only | SSGI | yes | Mid to high. Noisy, view dependent | 4 |
| Correct glass, caustic-free GI, product hero still, reference image | Path tracing, `three-gpu-pathtracer` | static scene, progressive | High. Converges over time | 5 |
| Real-time tracing of custom effects | WebGPU compute with own BVH | yes | Very high build effort | 6 |
| Best quality, no runtime cost | Path trace offline, ship the bake or a poster image | no | Offline | 4, 7 |

Rules:
- **There is no hardware ray tracing in the browser.** Every "ray traced" route is software traversal of a BVH on the GPU, so it is slow by design. WebGPU has no ray tracing API (verify, check current spec status).
- **Static camera or idle moments are where path tracing fits.** Product viewers, configurators, architectural stills. Not an orbiting game camera.
- **Use the path tracer as ground truth for the cheap routes.** Tune IBL and light intensities until the raster frame matches it (section 8).

## 2. Light-incidence math that matters

| Law | Formula | Three.js knob | What it changes in practice |
|---|---|---|---|
| Lambert cosine | `E = I * cos(theta)`, diffuse out `= albedo / pi * E` | Any light on `MeshStandardMaterial` | Light at grazing angles is weak. A key at 90 degrees to the camera gives dark faces, so add fill or env. Albedo 0 or 1 is not physical: keep 0.03 to 0.9 |
| Inverse square | `E = I / d^2` | `PointLight` and `SpotLight` `decay = 2` | Twice the distance is a quarter of the light. Leave `distance = 0` for physical falloff. Do not fake it with `decay = 1` |
| Fresnel (Schlick) | `F = F0 + (1 - F0) * (1 - cos(theta))^5` | `ior`, `specularIntensity`, `specularColor` on `MeshPhysicalMaterial`; metals use base colour as F0 | Every surface turns mirror-like at grazing angles. Dielectric F0 is 0.04 at `ior` 1.5. Rim reflections on a plastic edge are correct, not a bug, so the environment needs content near the horizon |
| GGX microfacet | `alpha = roughness^2`, distribution `D = alpha^2 / (pi * ((n.h)^2 * (alpha^2 - 1) + 1)^2)` | `roughness` | Roughness sets highlight size and sharpness. Low roughness plus a small bright light gives a pinprick, so use `RectAreaLight` or env for softboxes |
| Energy conservation | `kD = (1 - F) * (1 - metalness)`, outgoing is at most incoming | `metalness`, `envMapIntensity`, `environmentIntensity` | Keep metalness at 0 or 1 except at transitions. Env intensity above 1 or emissive used as fake light breaks it. Rough dielectrics and metals should not look brighter than their light |
| Bounce convergence | Indirect light after n bounces `~ 1 - albedo^n` of the total | `bounces` in the path tracer | Albedo 0.5 reaches 87% at 3 bounces and 97% at 5. Albedo 0.8 needs ~10 for 89%. Bright interiors need more bounces than dark products |

Helpers for unit-checking a setup:

```js
const lumensToCandela = (lm) => lm / (4 * Math.PI);                    // isotropic point light
const illuminance = (cd, d, cosTheta = 1) => (cd * cosTheta) / (d * d); // lux at the surface
const radianceOut = (albedo, lux) => (albedo / Math.PI) * lux;         // Lambert, scene units
const f0FromIor = (ior) => ((ior - 1) / (ior + 1)) ** 2;               // 0.04 at 1.5
const schlick = (f0, cosTheta) => f0 + (1 - f0) * (1 - cosTheta) ** 5;
```

## 3. Physical light units in three.js

| Light | Intensity unit | Note |
|---|---|---|
| `DirectionalLight` | lux | Intensity `Math.PI` lights an albedo-1 surface facing it to output 1.0 before tone mapping (verify at your revision). The key at 3.0 to 3.5 in `lighting-ibl-shadows` is this scale |
| `PointLight`, `SpotLight` | candela | `PointLight.power` is lumens and sets intensity. Use `lumensToCandela` for a spot (verify the spot conversion) |
| `RectAreaLight` | nits (verify) | Size affects highlight shape, not total energy |
| Env map | `scene.environmentIntensity` (r163+) | Not photometric. Calibrate against the key |

```js
// 800 lm bulb, 2 m above a table: ~64 cd, ~16 lux, albedo 0.5 outputs ~2.5
const bulb = new THREE.PointLight(0xfff1e0, lumensToCandela(800), 0, 2);
renderer.toneMappingExposure = 1; // three has no photometric camera, exposure is manual
```

Rules:
- **Scene scale is metres.** A 1 cd light in a scene modelled in centimetres is 10000x too dark. Fix the scale, not the intensity.
- **Set exposure last.** Choose light ratios (key to fill about 4:1) in physical terms, then move `toneMappingExposure` once.
- **One unit system across routes.** The same intensities must work in raster and in the path tracer, otherwise the fallback ladder in section 7 flips brightness when it switches.

## 4. Approximate

| Technique | Gives | Misses | Rule |
|---|---|---|---|
| IBL (`PMREMGenerator`, HDRI) | Distant light and reflections | Self-shadowing, near-field bounce | First step always. See `lighting-ibl-shadows` |
| Baked lightmap | Soft GI, colour bleeding, area shadows | Dynamic lights and objects | Static architecture. Bake in Blender Cycles, or with the path tracer (its lightmap or AO example, verify it exists) |
| Baked AO (`aoMap`) | Crevice darkening | Colour bleeding | Cheap on every tier |
| Light probes (`LightProbe`) | Ambient on moving objects inside a baked space | Occlusion | Supplement a lightmap, not replace it |
| GTAO or N8AO | Contact darkness | Direction and colour | `post-processing-stack` owns settings |
| SSR | Reflections of visible geometry | Anything off-screen, behind or occluded | Floors and glossy panels only, fade at screen edges, keep IBL as the fallback |
| SSGI | Dynamic one-bounce indirect | Off-screen light, thin objects, stability | Not in core `three` WebGL. Available as an addon node in newer WebGPU revisions or a third-party library (verify). Expect noise and temporal ghosting |

Baked lightmap material setup:

```js
lightTex.channel = 1;                       // read the second UV set (r151+); geometry needs a non-overlapping `uv1`
mat.lightMap = lightTex;
mat.lightMapIntensity = 1;
```
- **A lightmap stores irradiance. Do not bake albedo into it.** The material multiplies by albedo, so baked colour applies twice and looks muddy. If the bake looks about 3x too dark, test `lightMapIntensity = Math.PI` (verify, follows from the Lambert `1/pi`).
- Use an HDR source (EXR or RGBE) for lightmaps with bright areas, and a linear colour space. LDR 8-bit lightmaps band in dark gradients.

SSR (screen-space reflections), minimal:

```js
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
const ssr = new SSRPass({ renderer, scene, camera, width: innerWidth, height: innerHeight, groundReflector: null, selects: null });
composer.addPass(ssr);   // before OutputPass, see post-processing-stack for order. Option names: verify at your revision
```

Hybrid rule: **raster everything, upgrade one thing.** A baked lightmap for the room, IBL for reflections, SSR on the floor, and a path-traced still for the hero shot is a normal stack. Do not mix two sources of the same light (lightmap plus a real light at the same position doubles it).

## 5. Path trace in the browser

`three-gpu-pathtracer` renders in WebGL2 fragment shaders and uses `three-mesh-bvh` for the acceleration structure. `three-mesh-bvh` is a peer dependency. Pin matching versions of `three`, `three-mesh-bvh` and `three-gpu-pathtracer`, because they break between releases.

```bash
npm i three three-mesh-bvh three-gpu-pathtracer
```

```js
import { WebGLPathTracer } from 'three-gpu-pathtracer';

const pt = new WebGLPathTracer(renderer);
pt.bounces = 5;               // section 2 table: 3 to 5 products, 8+ bright interiors
pt.filterGlossyFactor = 0.5;  // blurs glossy bounces to cut fireflies (verify range)
pt.renderScale = 0.5;         // fraction of canvas resolution per sample (verify)
pt.tiles.set(2, 2);           // split each sample so the tab never stalls
pt.setScene(scene, camera);   // builds the BVH. Async variant setSceneAsync (verify)

const TARGET = 256;           // samples per pixel
let interacting = false, idleTimer;
controls.addEventListener('start', () => { interacting = true; clearTimeout(idleTimer); });
controls.addEventListener('end', () => { idleTimer = setTimeout(() => { interacting = false; pt.updateCamera(); }, 250); });

renderer.setAnimationLoop(() => {
  if (interacting) renderer.render(scene, camera);          // raster while moving
  else if (pt.samples < TARGET) pt.renderSample();          // accumulate when still
  else window.__sceneReady = true;                           // render-qa contract, set only when converged
});
```

Update calls (the scene is analysed once, not every frame):

| Changed | Call |
|---|---|
| Camera | `pt.updateCamera()` |
| Material values | `pt.updateMaterials()` |
| Lights | `pt.updateLights()` |
| Environment | `pt.updateEnvironment()` |
| Geometry or object transforms | `pt.setScene(scene, camera)` again, slow. Cheaper per-object update (verify) |

Supports `MeshStandardMaterial` and `MeshPhysicalMaterial` (transmission, clearcoat, sheen, iridescence), `scene.environment`, directional, point, spot and rect area lights. Shadow map settings and `castShadow` are irrelevant because shadows are traced. `ShaderMaterial`, custom `onBeforeCompile` patches, post effects and screen-space passes are not traced.

### Samples, noise, denoise

Noise falls with `1 / sqrt(N)`: four times the samples halves the noise. Starting values, tune against a close crop:

| Scene | Samples | Note |
|---|---|---|
| Product on env light | 64 rough, 256 final | Converges fast |
| Studio with softboxes | 256 to 512 | |
| Interior, small lights, glass | 1000+ | Slow. Consider baking |
| Caustics, tiny bright sources through glass | never fully | Remove the source or accept the noise |

| Noise type | Cause | Fix |
|---|---|---|
| Fine grain everywhere | Low sample count | More samples, or denoise |
| Isolated bright pixels (fireflies) | Glossy bounce into a small bright source | Raise `filterGlossyFactor`, raise min roughness, enlarge the light, lower env peak |
| Dark patches that never fill in | Too few `bounces` for the albedo | Section 2 convergence row |

Denoise options, cheapest first:
1. **Spend samples.** Free, always correct. Stop at `TARGET` and stop rendering to save battery.
2. **`DenoiseMaterial` from the path tracer package (verify exists and its inputs).** Edge-aware filter on the accumulated frame.
3. **OIDN in WASM or WebGPU (Intel Open Image Denoise ports such as `oidn-web`, verify)** on the final frame only. Needs albedo and normal buffers for best results. The path tracer does not expose these by default (verify).
4. Never denoise while the camera moves. Raster frames are already clean.

Rules:
- **Accumulation resets on any visible change.** Do not animate materials, lights or the camera while path tracing, or it never converges.
- **Static progressive, then stop.** Cap at `TARGET`, do not keep burning the GPU on a finished frame.
- **Memory.** The BVH and all textures live on the GPU, and the path tracer packs textures into a fixed-size array (`textureSize`, verify). Check 4k textures and KTX2 inputs (`gltf-asset-pipeline`) actually appear correctly (verify KTX2 handling).
- **Build the BVH off the main thread for big scenes.** Prefer `setSceneAsync` or a `three-mesh-bvh` worker generator (verify names).
- **Tone mapping and colour space stay as configured on the renderer.** Set them as in `lighting-ibl-shadows`, do not add a second tone map.

`three-mesh-bvh` alone is also the fast way to answer CPU ray questions (picking, occlusion tests, AO bake) without path tracing:

```js
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
mesh.geometry.computeBoundsTree();   // call disposeBoundsTree() on teardown
```

## 6. WebGPU compute route

Use only when the path tracer cannot do the job (custom BRDF, dynamic geometry, effect-specific rays such as ray-marched shadows or AO against a mesh). There is no maintained drop-in path tracer for `WebGPURenderer` (verify). You write the BVH upload, the traversal and the accumulation, and `three-mesh-bvh` can supply the BVH build.

Building blocks, in WGSL:

```wgsl
fn hitTri(ro: vec3f, rd: vec3f, a: vec3f, b: vec3f, c: vec3f) -> f32 {   // Moller-Trumbore, returns t or -1
  let e1 = b - a; let e2 = c - a;
  let p = cross(rd, e2); let det = dot(e1, p);
  if (abs(det) < 1e-8) { return -1.0; }
  let inv = 1.0 / det; let s = ro - a;
  let u = dot(s, p) * inv; if (u < 0.0 || u > 1.0) { return -1.0; }
  let q = cross(s, e1); let v = dot(rd, q) * inv;
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  return dot(e2, q) * inv;
}
// progressive accumulation, frame is 0-based and resets to 0 when the camera moves
accum[i] = mix(accum[i], radiance, 1.0 / f32(frame + 1u));
```

Rules:
- **Traversal needs a BVH.** A flat triangle loop is only viable for under a few hundred triangles.
- **Hash a per-pixel, per-frame random seed** (PCG or similar) or every frame samples the same rays and nothing converges.
- **Validate against the WebGL path tracer** on the same scene (section 8) before trusting your own.
- **Feature-detect.** `navigator.gpu` and `await navigator.gpu.requestAdapter()` must both succeed, otherwise use section 5 or the ladder.

## 7. Fallback ladder per device tier

Tier names follow `performance-budget`. Path tracing is an upgrade on top of the raster scene, never the only way to see it.

| Tier | Route | Settings | Gate |
|---|---|---|---|
| High (desktop dGPU) | Raster live, path tracer on idle | `renderScale` 1 to 0.75, `bounces` 5, `TARGET` 256 to 512 | `tier === 'high'` and float render target support |
| Mid (laptop, iGPU) | Raster live, short path trace on idle | `renderScale` 0.5, `tiles` 2x2, `bounces` 3, `TARGET` 64 to 128 | Runtime frame-time probe below passes |
| Low (phone) | No runtime tracing. Baked lightmap or baked AO plus IBL, optional pre-rendered path-traced poster | 1 shadow light at 1024 (`performance-budget`) | Default |
| Any, unsupported | Same as Low | | Probe fails or extension missing |

```js
const canPathTrace = (renderer, tier) =>
  tier !== 'low' && renderer.extensions.has('EXT_color_buffer_float');  // float render targets (verify name)

// frame-time probe: 10 path-traced frames, fall back if the median interval is over 250 ms
async function probe(pt, n = 10) {
  const dts = []; let last = performance.now();
  for (let i = 0; i < n; i++) {
    pt.renderSample();
    await new Promise(requestAnimationFrame);
    const t = performance.now(); dts.push(t - last); last = t;
  }
  return dts.sort((a, b) => a - b)[n >> 1] < 250;
}
```

Rules:
- **Gate before building the BVH.** BVH build and the texture array are the load-time cost, do not pay it on a device that will fall back.
- **Fall back silently and permanently for the session.** Do not flip back and forth.
- **Same look on every rung.** Calibrate the raster tier against the path tracer (section 8) so the ladder does not change brightness or colour.
- **Respect battery.** Stop at `TARGET`, pause when hidden (`performance-budget` section 5).

## 8. Verify

1. **Run `render-qa` with `--gpu`.** Default SwiftShader renders on CPU, so path tracing never reaches a usable sample count there. Run it twice, once with `--query "pt=1"` and once with `--query "pt=0"` (your page reads the flag), to capture both routes, and set `--wait` long enough for `TARGET` samples. `window.__sceneReady` must only turn true after convergence, as in the section 5 sample.
2. **Expect two false warnings with `pt=1`:** "shadows off" and "no shadow casters", because the tracer does not use shadow maps. Judge shadows visually on the screenshots.
3. **White furnace test.** Uniform white `scene.environment` and `scene.background`, a white `MeshStandardMaterial` sphere (`roughness` 1, `metalness` 0), tone mapping off. The sphere must almost vanish into the background in both routes. A visible sphere means energy is gained or lost (env intensity, double lighting, wrong colour space).
4. **Raster versus path-traced diff.** Same camera, same scene, mean luminance within about 10 percent and no hue shift. Tune `environmentIntensity` and the key until they agree.
5. **Fireflies and convergence.** At `TARGET`, crop at 100 percent. No isolated bright pixels and no blotchy patches. Fix with section 5 noise table, not by blur.
6. **Unit sanity.** A `lumensToCandela` and `illuminance` check for one light in the scene must match what the render shows, within the gap that tone mapping explains.
7. **Budget.** Low tier must still run inside the `performance-budget` limits with the path tracer absent. Confirm the ladder falls back by forcing `?tier=low`.
