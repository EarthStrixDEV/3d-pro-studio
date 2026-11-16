---
name: volumetrics-atmosphere
description: Atmosphere and volumetric effects for Three.js, translating Blender Volume Scatter, World Volume, Mist and Sky Texture and Maya Arnold atmosphere into web techniques. Covers exponential fog and analytic height fog, god rays, raymarched volumetric clouds, the Sky addon (Preetham) and sun position, depth-aware blending against opaque geometry, colour handling of fog, and cost per device tier. Use when a scene needs fog, haze, mist, light shafts, clouds, a sky or time of day, when depth layers look flat or the horizon shows a seam, when fog tints colours wrongly, or when asked for volumetrics, atmosphere, god rays, volumetric lighting or a procedural sky. Thai triggers หมอก, หมอกตามความสูง, ลำแสง god rays, เมฆ, ท้องฟ้า, บรรยากาศ, ควัน, ฟ้าหลัว, volumetric.
argument-hint: "<scene, the atmosphere wanted (fog, shafts, clouds, sky) and target device tier>"
---

# Volumetrics & Atmosphere

Atmosphere sells scale and separates depth layers, and it is the easiest place to blow the frame budget. Start with the cheapest technique that reads right, and add cost only where the camera looks. Light rigs, environment and exposure are in `lighting-ibl-shadows`, budgets in `performance-budget`.

Status: height fog maths (against a numeric integral), fog colour handling, the cloud raymarch with a depth clamp, and the Sky addon were run in a headless browser on three r187. Blender and Maya node names, third-party libraries and tier costs are not measured here (marked verify or "starting guess").

## 1. Pick the technique

| Look | Blender or Maya counterpart | Three.js technique | Cost |
|---|---|---|---|
| Distance haze, depth separation | World Mist pass, Arnold fog (verify) | `scene.fog` with `Fog` or `FogExp2` | Near zero |
| Haze that pools near the ground | Height-dependent volume density | Analytic height fog patch (section 3) | Near zero |
| Sun, sky colour, time of day | Sky Texture node (Nishita, verify), Arnold physical sky (verify) | `Sky` addon (section 5) | Low, one fullscreen-ish mesh |
| Light shafts | Volume Scatter in the world or a spot, Arnold atmosphere volume (verify) | Fake cone, or screen-space radial blur (section 4) | Low to mid |
| Clouds, smoke, local fog banks | Principled Volume, Volume Scatter | Raymarched box volume (section 6) | Mid to high, fill-rate bound |
| True volumetric lighting with shadows in fog | Volume Scatter with a light | Library or WebGPU froxel compute, not built here (section 4) | High |

Rules:
- **Fog first.** One cheap exponential fog tinted to the sky horizon does most of the depth work.
- **Real volumetrics are a hero-shot upgrade**, not a default. Gate them by tier (section 8).
- **Everything is fill rate.** Cost scales with covered pixels times march steps, not triangles.

## 2. Built-in fog

```js
scene.fog = new THREE.FogExp2(0xaab8c8, 0.035);   // or new THREE.Fog(color, near, far) for a linear ramp
scene.background = scene.fog.color.clone();       // match the horizon, or a seam shows
```

- `FogExp2` factor is `1 - exp(-(density * distance)^2)` (read from `fog_fragment`, r187). Density 0.035 reaches 63 percent at about 29 units, and half fog at about 24 (`0.69^0.5 / 0.035`). Pick the density from the distance where the far hero object should fade.
- **Fog is applied after tone mapping and sRGB encoding.** Three converts `scene.fog.color` into the output colour space for you. Custom shaders must do the same (section 3).
- Built-in materials fog automatically (`material.fog = true`). A `ShaderMaterial` needs `fog: true` and the fog chunks included. Sprites and points have their own flags (verify).
- Match fog colour to the background colour at the horizon, or to the sky colour there when a `Sky` is used. Lit ground against an unfogged backdrop is the classic horizon seam (`lighting-ibl-shadows` diagnosis table).
- Fog hides popping, so it also helps LOD and streaming (`performance-budget`).

## 3. Analytic height fog

Density falls with height, `density(y) = a * exp(-b * y)`. The optical depth from the camera to a surface point has a closed form, so no marching is needed. With camera height `c`, ray length `L` and vertical difference `dy = p.y - cam.y`:

```
depth = a * exp(-b * c) * L * (1 - exp(-b * dy)) / (b * dy)        (use 1 when |b * dy| is tiny)
fog   = 1 - exp(-depth)
```

Verified against a numeric integral (0.666913 both). Verified in the browser: a flat test with large density returned exactly the sRGB bytes of the fog colour `#aab8c8` (170, 184, 200).

```js
function applyHeightFog(material, { color, density = 0.08, falloff = 0.5 }, renderer) {
  const u = {
    uFogColor: { value: new THREE.Color(color).getRGB(new THREE.Color(), renderer.outputColorSpace) },   // display-referred, see section 2
    uFogDensity: { value: density }, uFogFalloff: { value: falloff },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWPos; uniform vec3 uFogColor; uniform float uFogDensity, uFogFalloff;
      float heightFog(vec3 cam, vec3 p) {
        vec3 d = p - cam; float k = uFogFalloff * d.y;
        float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
        return uFogDensity * exp(-uFogFalloff * cam.y) * length(d) * f;
      }`).replace('#include <fog_fragment>', `#include <fog_fragment>
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, 1.0 - exp(-heightFog(cameraPosition, vWPos)));`);
  };
  material.customProgramCacheKey = () => 'height-fog-v1';
  return u;                                       // update u.uFogDensity.value to animate
}
```

Rules:
- Apply to every opaque material in the scene, or objects without it stand out as clear. A shared helper over `scene.traverse` is fine. Patch rules and cache keys: `shader-craft` section 2.
- `uFogColor` is not converted again by three. Always go through `getRGB(..., renderer.outputColorSpace)`.
- Sky meshes and the background should be fog-free, or the horizon gets mushy.
- Gradients band in 8 bit, add grain after `OutputPass` (`post-processing-stack` section 6).
- Use `falloff` 0.3 to 1.0 and `density` 0.02 to 0.15 as starting guesses, tune by a screenshot at ground level.

## 4. God rays

| Option | Look | Cost | Notes |
|---|---|---|---|
| Cone mesh | Soft visible beam from a spotlight or window | One transparent mesh | Additive, fresnel-faded edges, `depthWrite: false`. Fakes the beam, ignores real occluders. Cheapest and mobile safe |
| Screen-space radial blur | Shafts radiating from the sun on screen | Mask pass plus a blur pass | Needs the sun on screen and an occlusion mask. Fails when the sun leaves the frame |
| Shadow-map raymarch | Shafts shaped by real shadows | Mid to high, steps times pixels | `three-good-godrays` (verify) and the `GodRaysEffect` in `pmndrs/postprocessing` (verify) implement variants. Check they match your three version |
| Froxel or WebGPU compute fog | Full volumetric light | High build effort | Not worth it for most web pages |

Rules: fake shafts for hero moments with a baked cone, then spend runtime budget elsewhere. Any raymarched shaft pass runs at half resolution on mid tier and is off on low tier (section 8).

## 5. Sky and time of day

`Sky` (WebGLRenderer only, `SkyMesh` for `WebGPURenderer`) implements the Preetham analytic daylight model (stated in the addon header, r187).

```js
import { Sky } from 'three/addons/objects/Sky.js';
const sky = new Sky(); sky.scale.setScalar(450000); scene.add(sky);
const u = sky.material.uniforms;
u.turbidity.value = 4; u.rayleigh.value = 1.5; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;

const sun = new THREE.Vector3();
function setSun(elevationDeg, azimuthDeg) {
  sun.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevationDeg), THREE.MathUtils.degToRad(azimuthDeg));
  u.sunPosition.value.copy(sun);
  keyLight.position.copy(sun).multiplyScalar(50);               // key light follows the sun
}
```

In r187 the uniforms are `turbidity, rayleigh, mieCoefficient, mieDirectionalG, sunPosition, cloudScale, cloudSpeed, cloudCoverage, cloudDensity, cloudElevation, showSunDisc, time`. The cloud and sun-disc uniforms are new in recent revisions, older ones only have the first five (verify your revision before touching the others).

| Knob | Effect | Starting range |
|---|---|---|
| `turbidity` | Haze. Higher is whiter and murkier | 2 to 10 |
| `rayleigh` | Blue scattering. Low gives a pale or sunset sky | 0.5 to 3 |
| `mieCoefficient`, `mieDirectionalG` | Glow around the sun | 0.003 to 0.01, 0.7 to 0.9 |
| Elevation | Time of day | 2 to 10 degrees for golden hour, 40 to 70 for noon |

Rules:
- **Light the scene from the sky.** Render the sky into an environment map with `PMREMGenerator.fromScene` and set `scene.environment`, set `showSunDisc.value = false` while capturing so the disc does not create a hot spot (addon header advice). Regenerate only when the sun moves, dispose the previous target. Needs a second `Sky` instance in its own scene (a mesh has one parent), capture flow not run here (verify).
- **Sun-driven grade.** Low sun: warmer key colour (about 2500 to 4000 K look), lower key intensity, longer shadows. Colour temperature contrast does more than intensity (`lighting-ibl-shadows`).
- **Tone mapping** decides the sky look. AgX or ACES roll off the bright sky gracefully. Check exposure after the sky is in (mapper rules in `color-management-grading`).
- **Fog colour** = sky colour near the horizon. Sample the rendered sky at the horizon row and use that.
- **Not a skybox for stylised art.** For a painted look use a gradient texture or an HDRI background.

## 6. Raymarched volumetric clouds

A box mesh drawn with back faces, a fragment shader that marches from the camera through the box and accumulates density with Beer-Lambert absorption, plus one light tap toward the sun. Verified in the browser (a cloud-like blob rendered, depth clamp changed the pixel from `[213, 206, 219]` to `[242, 194, 204]` over a red sphere inside the box).

```js
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

function noise3D(N = 48) {                                          // fractal noise, faded to zero at the box edge
  const data = new Uint8Array(N * N * N), p = new ImprovedNoise(); let i = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let a = 0, f = 4, amp = 0.5; for (let o = 0; o < 3; o++) { a += amp * p.noise(x / N * f, y / N * f, z / N * f); f *= 2; amp *= 0.5; }
    const edge = Math.max(0, 1 - Math.hypot(x / N - 0.5, y / N - 0.5, z / N - 0.5) * 2);
    data[i++] = Math.max(0, Math.min(255, (a * 0.5 + 0.5) * 255 * Math.min(1, edge * 1.4)));
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RedFormat; t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

function makeCloud(vol, depthTex, size, resolution) {            // resolution: drawing-buffer size, pixel ratio included
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    uniforms: { uVol: { value: vol }, tDepth: { value: depthTex }, uRes: { value: resolution }, uSize: { value: size },
      uSteps: { value: 48 }, uDensity: { value: 10 }, uThresh: { value: 0.25 }, uSun: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      uLocalCam: { value: new THREE.Vector3() }, uMV: { value: new THREE.Matrix4() } },
    vertexShader: `varying vec3 vLocal; void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      precision highp sampler3D;
      uniform sampler3D uVol; uniform sampler2D tDepth; uniform float uDensity, uThresh, uSize; uniform int uSteps;
      uniform vec2 uRes; uniform vec3 uSun, uLocalCam; uniform mat4 uMV; varying vec3 vLocal;
      vec2 hitBox(vec3 o, vec3 d) { vec3 inv = 1.0 / d; vec3 a = (-0.5 - o) * inv, b = (0.5 - o) * inv;
        vec3 mn = min(a, b), mx = max(a, b); return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z)); }
      float dens(vec3 p) { return smoothstep(uThresh, 1.0, texture(uVol, p + 0.5).r); }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 o = uLocalCam, d = normalize(vLocal - o);
        vec2 t = hitBox(o, d); t.x = max(t.x, 0.0); if (t.x >= t.y) discard;
        float sceneZ = texture2D(tDepth, gl_FragCoord.xy / uRes).r;          // view-space depth from the aux pass, 0 = nothing drawn
        if (sceneZ <= 0.0) sceneZ = 1e9;
        float dt = (t.y - t.x) / float(uSteps), tt = t.x + dt * hash(gl_FragCoord.xy);   // jitter hides banding
        vec3 col = vec3(0.0); float trans = 1.0;
        for (int i = 0; i < 128; i++) { if (i >= uSteps) break;
          vec3 p = o + d * tt;
          if (-(uMV * vec4(p * uSize, 1.0)).z > sceneZ) break;                 // stop at opaque geometry
          float s = dens(p) * uDensity;
          if (s > 0.001) {
            float l = dens(p + uSun * 0.12) * uDensity;                         // one shadow tap toward the sun
            vec3 lit = mix(vec3(0.95, 0.97, 1.0), vec3(0.45, 0.5, 0.62), 1.0 - exp(-l));
            float a = 1.0 - exp(-s * dt * uSize); col += trans * a * lit; trans *= 1.0 - a; if (trans < 0.02) break;
          }
          tt += dt; }
        gl_FragColor = vec4(col, 1.0 - trans);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat); mesh.scale.setScalar(size);
  mesh.onBeforeRender = (r, s, cam) => {
    mat.uniforms.uLocalCam.value.copy(cam.position); mesh.worldToLocal(mat.uniforms.uLocalCam.value);
    mat.uniforms.uMV.value.multiplyMatrices(cam.matrixWorldInverse, mesh.matrixWorld);
  };
  return mesh;
}
```

Rules:
- **`premultipliedAlpha: true`.** The shader accumulates premultiplied colour. With normal blending the cloud renders dark and thin (seen in testing).
- **`depthTest: false` plus the depth clamp.** With back faces and depth testing, anything opaque inside the box hides the cloud in front of it. Sampling a depth texture and stopping the march at the scene depth fixes both directions. The depth texture is the view-space z target from `render-passes-aov` section 3 (value 0 means nothing drawn).
- **Resolution.** `uRes` is the drawing-buffer size of the depth target, `gl_FragCoord` is in drawing-buffer pixels. Mismatched sizes or pixel ratio shift the depth lookup.
- **Do not read and write the same depth.** Render opaque depth to a separate target (the aux pass), never sample the active framebuffer's depth.
- **Cost knobs:** `uSteps` (24 to 64), half-resolution render with an upsample, jitter plus temporal accumulation for static shots, smaller box, early exit at `trans < 0.02` (in the sample). The light tap doubles texture reads, drop it on mid tier.
- **Box edges.** Fade density to zero near the box (done in `noise3D`) or the cube shows.
- **Animation:** scroll the sample position by time. A dynamic volume forbids accumulation.
- **Clouds as a sky layer** are cheaper with a scrolling 2D noise on a dome, or the cloud uniforms of recent `Sky` revisions (verify). Pick the raymarch only for close, shaped clouds, smoke or fog banks.
- **Memory.** The 3D noise is a `Data3DTexture`, 48^3 at one byte is about 110 KB. Sizes above 64^3 cost memory fast, check `performance-budget`.

## 7. Depth-aware blending rules

- Volumes and fog patches render **after opaque** geometry and clamp to the scene depth (section 6). Transparent meshes (glass, particles) sort against the volume by drawing order, so put the volume at a sensible `renderOrder`.
- Soft contact where a volume meets the floor comes from the same depth clamp. A hard cut line means the depth is wrong or missing.
- Particles and light cones fade near geometry with `smoothstep(0.0, softness, sceneZ - fragmentZ)` (soft particles, `realtime-engine-features`).
- Fog and volumes must **share one colour story**: fog colour at the horizon equals the sky horizon colour, volume lit colour matches key light colour.
- Do not stack a volume and height fog at the same density, the result doubles. Reduce one.

## 8. Cost per device tier

Starting guesses, to tune with `render-qa --gpu` and the budgets in `performance-budget`.

| Tier | Fog | Sky | God rays | Clouds | Notes |
|---|---|---|---|---|---|
| low (phones, iGPU) | `FogExp2` or height fog | `Sky` once, or an HDRI or gradient | Cone mesh only | None, or a few billboard sprites | No raymarching. Raymarch costs scale with pixel ratio squared, cap it |
| mid (laptops) | Height fog | `Sky` with sun control | Cone, optional half-res radial blur | Half-res raymarch, 24 to 32 steps, no light tap | Render the volume at 0.5 scale and upsample |
| high (desktop dGPU) | Height fog plus cone shafts | `Sky` plus PMREM environment from it | Library raymarch (verify) at half res | Raymarch, 48 to 64 steps, light tap, temporal accumulation when still | Stop rendering when the camera is still (`performance-budget` section 5) |

Rules: gate by the same `tier` flag as the rest of the scene, decide at load. If frame time exceeds budget, degrade in this order: light tap off, steps down, volume resolution down, volume off, then god rays off. Fog stays on.

## 9. Verify

1. `render-qa` at three views: ground level looking at the horizon, a hero close-up, a high angle over the scene. Atmosphere looks right from one angle and wrong from another often.
2. **Horizon:** no seam between ground, fog and sky, and the fog colour matches the sky at the horizon row.
3. **Colour:** a fogged object far away approaches the fog colour in the screenshot, not a darker or lighter tint (section 2 colour rule).
4. **Depth:** place an opaque object inside every volume. The volume must appear in front of and behind it with no hard rectangle and no missing cloud in front.
5. **Banding:** inspect fog gradients and sky at 100 percent crop, add grain if stepped.
6. **Cost:** run with the effect on and off at `--gpu` on a real device or a representative GPU, record frame time, and compare with the tier table. SwiftShader numbers are for comparison only.
7. Check it works across tiers: `--query tier=low` must still look intentional with the cheap fallback.
