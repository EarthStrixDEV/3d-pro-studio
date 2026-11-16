---
name: ocean-terrain-environment
description: Oceans, terrain and sky for Three.js, translating the Blender Ocean modifier and Landscape add-on and Maya Ocean shader into web techniques. Covers Gerstner wave shaders with matching CPU height sampling for buoyancy, FFT ocean design, foam, Beer-Lambert depth colour, fresnel, refraction and planar reflection (Water, Water2, WaterMesh, Reflector, Sky addons), heightmap terrain from fBm noise with thermal and hydraulic erosion, chunked LOD terrain with skirts or clipmaps, seamless terrain normals, splat-map and slope texturing, heightfield collision with Rapier, sky, sun and fog, per-tier budgets and a symptom table. Use when a scene needs sea, lake, river, island, mountains, ground, a horizon or a natural environment, or when waves look repetitive, terrain cracks or pops, textures stretch on cliffs, objects do not float, or the horizon looks fake. Thai triggers มหาสมุทร, ทะเล, คลื่น, ทะเลสาบ, ภูมิประเทศ, ภูเขา, เกาะ, พื้นดิน, ท้องฟ้า, หมอก, terrain, ocean, splat map.
argument-hint: "<sea, lake, terrain or all, the scale in metres, camera heights, and the target device tier>"
---

# Ocean, Terrain & Environment

An environment is three layers read from far to near: sky and fog set the mood, terrain gives the shape, water gives the motion. Decide each layer's method by camera distance and tier, then budget it in `performance-budget`. Physics for ground and floating objects: `physics-rigidbody`. Atmosphere beyond a gradient sky and linear fog: `volumetrics-atmosphere`.

## 1. Pick the method

| Layer | Option | Use when | Cost |
|---|---|---|---|
| Ocean | **Gerstner waves** (section 2) | Default. Stylised to realistic sea, boats, lakes, 3 to 8 waves | Vertex shader, cheap |
| Ocean | **FFT** (section 4) | Open ocean seen from low or high, storms, close-ups of choppy water | Several render passes per frame, desktop or WebGPU |
| Ocean | Normal-map scroll only | Small pond, distant sea, low tier | Almost free, no silhouette waves |
| Reflection | Environment map plus fresnel | Low tier, any distant water | Free |
| Reflection | Planar (`Reflector`, `Water`) (section 5) | Flat water near the camera | Re-renders the scene at reduced size |
| Reflection | Screen-space reflection | Desktop post chain (`post-processing-stack`) | Full-screen pass, artefacts at edges |
| Terrain | **Chunked LOD with skirts** (section 7) | Default, up to about 2 km square | Per-chunk draw call |
| Terrain | Geometry clipmap | Very large or streaming terrain | Rings follow the camera, heights from a texture in the vertex shader |
| Terrain | Single mesh | Under about 129 by 129 samples, small arenas | One draw call, no LOD |
| Sky | `Sky` addon plus fog | Outdoor day and dusk (section 10) | Cheap |

Rule: the horizon is mostly fog, sky and a distant terrain silhouette. Spend triangles and passes in the first 100 m.

## 2. Gerstner waves

Each wave moves points in a circle: up and down by `A`, sideways toward the wave direction by `Q * A`. Several waves with different directions and wavelengths sum into a believable sea. The same formula runs in JavaScript (for floating objects) and in the shader, so a boat sits on the surface the viewer sees.

```js
import * as THREE from 'three';

const G = 9.81;

/** list: [{ angle: degrees from +X toward +Z, wavelength: m, amplitude: m }]. Keep amplitude under wavelength / 14. */
export function makeWaves(list) {
  return list.map(({ angle, wavelength, amplitude }) => {
    const a = THREE.MathUtils.degToRad(angle), k = (2 * Math.PI) / wavelength;
    return { dx: Math.cos(a), dz: Math.sin(a), A: amplitude, L: wavelength, k, w: Math.sqrt(G * k) };   // deep water: w^2 = g k
  });
}

/** Surface point for the source coordinate (x0, z0) at time t. steep in 0..1, 1 is the sharpest crest without loops.
 *  Also writes the surface derivatives (sxx, sxz, szz, gx, gz) that the normal and the height search use. */
export function gerstnerPoint(waves, steep, x0, z0, t, out = {}) {
  let x = x0, y = 0, z = z0, sxx = 0, sxz = 0, szz = 0, gx = 0, gz = 0;
  const N = waves.length, S = steep / N;                       // S = Q * A * k, the same for every wave
  for (const { dx, dz, A, k, w } of waves) {
    const th = k * (dx * x0 + dz * z0) - w * t, c = Math.cos(th), s = Math.sin(th);
    x += (S / k) * dx * c; z += (S / k) * dz * c; y += A * s;
    sxx += S * dx * dx * s; sxz += S * dx * dz * s; szz += S * dz * dz * s;
    gx += A * k * dx * c; gz += A * k * dz * c;
  }
  out.x = x; out.y = y; out.z = z; out.sxx = sxx; out.sxz = sxz; out.szz = szz; out.gx = gx; out.gz = gz;
  return out;
}

/** Exact normal at the source coordinate (same maths as the shader). crest = 1 - Jacobian: 0 on flat water, toward 1 where the surface pinches. */
export function waterNormal(waves, steep, x0, z0, t, out = new THREE.Vector3()) {
  const p = gerstnerPoint(waves, steep, x0, z0, t);
  const tx = new THREE.Vector3(1 - p.sxx, p.gx, -p.sxz), tz = new THREE.Vector3(-p.sxz, p.gz, 1 - p.szz);
  const n = tz.cross(tx);
  out.crest = 1 - n.y;
  return out.copy(n).normalize();
}

/** The source coordinate whose surface point lands on WORLD (x, z). Points slide sideways, so Newton iteration on the horizontal map. */
export function waterSource(waves, steep, x, z, t) {
  let x0 = x, z0 = z; const p = {};
  for (let i = 0; i < 3; i++) {
    gerstnerPoint(waves, steep, x0, z0, t, p);
    const ex = x - p.x, ez = z - p.z, a = 1 - p.sxx, b = -p.sxz, d = 1 - p.szz, det = a * d - b * b;
    if (det < 1e-3) { x0 += ex; z0 += ez; continue; }          // looped surface (steep above 1): plain step
    x0 += (d * ex - b * ez) / det; z0 += (a * ez - b * ex) / det;
  }
  return { x0, z0 };
}

/** Water height at WORLD (x, z). */
export function waterHeight(waves, steep, x, z, t) {
  const { x0, z0 } = waterSource(waves, steep, x, z, t);
  return gerstnerPoint(waves, steep, x0, z0, t).y;
}

/** GLSL for the same waves. Uniforms: uWaves[i] = (dir.x, dir.z, amplitude, wavelength), uSteep, uTime. Returns the displacement, writes the exact normal and crest. */
export const gerstnerGLSL = (count) => `
  #define WAVES ${count}
  uniform vec4 uWaves[WAVES];
  uniform float uSteep;
  uniform float uTime;
  vec3 gerstner(vec2 p, out vec3 normal, out float crest) {
    vec3 d = vec3(0.0); float sxx = 0.0, sxz = 0.0, szz = 0.0, gx = 0.0, gz = 0.0;
    float S = uSteep / float(WAVES);
    for (int i = 0; i < WAVES; i++) {
      vec2 dir = uWaves[i].xy; float A = uWaves[i].z; float k = 6.28318530718 / uWaves[i].w;
      float th = k * dot(dir, p) - sqrt(9.81 * k) * uTime;
      float s = sin(th), c = cos(th);
      d.x += S / k * dir.x * c; d.z += S / k * dir.y * c; d.y += A * s;
      sxx += S * dir.x * dir.x * s; sxz += S * dir.x * dir.y * s; szz += S * dir.y * dir.y * s;
      gx += A * k * dir.x * c; gz += A * k * dir.y * c;
    }
    vec3 n = cross(vec3(-sxz, gz, 1.0 - szz), vec3(1.0 - sxx, gx, -sxz));   // surface normal, n.y is the Jacobian
    normal = normalize(n);
    crest = 1.0 - n.y;
    return d;
  }`;
```

Rules:
- **Wavelength ladder.** Use 4 to 6 waves from a long swell to short chop, each about half the previous wavelength (for example 60, 31, 17, 9 m), amplitudes `wavelength / 40` to `/ 25`, never above `/ 14`. Longest waves carry most of the amplitude.
- **Directions.** Spread within about 20 to 40 degrees of the wind and rotate the short waves a little more. Parallel waves look like corduroy, perpendicular ones look like a pond.
- **Steepness.** `uSteep` between 0 and 1 is the sum of all wave steepness. Above 1 the crests loop and the mesh folds. Calm sea 0.3, rough 0.7, storm up to 1.0 (guess, tune by eye).
- **Mesh density.** The shortest wavelength needs at least 4 vertices per wave, so `cell <= shortest / 4`. A 400 m plane with 256 segments has 1.56 m cells, so the shortest wave must be at least 6.3 m. Shorter detail belongs in the normal map, not the geometry.
- **Time.** One shared clock. The phase uses real water dispersion (`w = sqrt(g k)`), so long waves travel faster, which reads as correct without tuning. Use the loop's `dt` (`motion-choreography`).
- **Floating objects.** Sample `waterHeight` (it finds the source coordinate with a 3 step Newton search, plain fixed-point iteration stayed up to 0.4 m off at `uSteep` 0.6 to 1) at three points of the hull (bow, left, right), place the object at their mean and set the tilt from the plane through the three samples. Smooth with `damp` so it does not jitter (`motion-choreography`). A rigid body that should float uses the same height as a buoyancy target in `physics-rigidbody`.
- Move the ocean mesh with the camera, snapped to its cell size, and read **world** coordinates in the shader so the waves do not slide with the mesh.
- **Fade the plane out before its edge.** The horizon fade must finish inside `size / 2` (`uFade.y`, the sample uses `0.48 * size`), or the end of the plane shows as a hard line against the sky. A bigger sea means a bigger plane with more segments, or a clipmap ring layout (section 7 idea).

## 3. Water shading

| Effect | How |
|---|---|
| **Depth colour** | Beer-Lambert: `trans = exp(-absorb * depth)` per channel. Red is absorbed first, so shallow reads sandy or turquoise and deep reads blue. Starting `absorb` about `(0.35, 0.06, 0.015)` per metre for clear water (guess, tune by eye) |
| **Depth source** | A height texture of the terrain under the water (cheapest, section 6), or a scene depth pass (`DepthTexture` on a render target, one extra scene render, needed when the bed is not a heightfield) |
| **Fresnel** | `F = 0.02 + 0.98 * (1 - dot(N, V))^5`: little reflection looking down, mirror at grazing angles. Mix body colour with reflection by `F` |
| **Reflection** | Sky gradient or environment map (free), planar reflection (section 5) or SSR. Distort the lookup by the normal xz |
| **Refraction** | Cheap: tint the body colour by depth. Better: sample a copy of the opaque scene with the UV shifted by the normal. A `MeshPhysicalMaterial` with `transmission`, `ior: 1.33`, `thickness`, `attenuationColor` and `attenuationDistance` gives Beer-Lambert absorption without a custom shader, at the cost of a transmission pass (`performance-budget` section 1 limits transmission meshes) |
| **Sun glint** | `pow(max(dot(reflect(-V, N), sunDir), 0.0), 300.0)` on the sun colour. Needs HDR output to look right with bloom (`post-processing-stack`) |
| **Foam** | Crest foam: `smoothstep(lo, hi, crest)` where `crest = 1 - Jacobian` of the horizontal wave map (0 on flat water, toward 1 where the surface pinches). Shore foam: `1 - smoothstep(0, width, depth)`. Both multiplied by scrolling noise so it breaks up |
| **Shore blend** | Alpha `clamp(depth * k, 0, 1)` so water fades into the beach instead of cutting a hard line |
| **Horizon** | Fade colour toward the horizon colour with distance, the same colour as the scene fog |

Full material: displaced mesh, depth colour from a terrain height texture, fresnel against a sky gradient, sun glint, crest and shore foam, horizon fade.

```js
const NOISE = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`;

export function createOcean({ waves, steep = 0.6, size = 400, segments = 256, bed = null } = {}) {
  // bed: { texture (heights in metres, half float, see section 6), rect: [minX, minZ, sizeX, sizeZ] } or null for open sea
  const uniforms = {
    uWaves: { value: waves.map((w) => new THREE.Vector4(w.dx, w.dz, w.A, w.L)) }, uSteep: { value: steep }, uTime: { value: 0 },
    uDeep: { value: new THREE.Color('#06263a') }, uShallow: { value: new THREE.Color('#3fb7b0') }, uAbsorb: { value: new THREE.Vector3(0.35, 0.06, 0.015) },
    uSky: { value: new THREE.Color('#4f8fd8') }, uHorizon: { value: new THREE.Color('#bcd4e6') }, uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() }, uSunColor: { value: new THREE.Color('#fff2d8') },
    uFoam: { value: new THREE.Vector2(0.25, 0.5) }, uShoreFoam: { value: 0.7 }, uFade: { value: new THREE.Vector2(size * 0.25, size * 0.48) },
    uBed: { value: bed ? bed.texture : null }, uBedRect: { value: new THREE.Vector4(...(bed ? bed.rect : [0, 0, 1, 1])) }, uHasBed: { value: bed ? 1 : 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: !!bed, depthWrite: !bed,
    vertexShader: `
      ${gerstnerGLSL(waves.length)}
      varying vec3 vWorld; varying vec3 vN; varying float vCrest;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vec3 n; float crest;
        w.xyz += gerstner(w.xz, n, crest);                      // waves live in world space
        vWorld = w.xyz; vN = n; vCrest = crest;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uDeep, uShallow, uAbsorb, uSky, uHorizon, uSunDir, uSunColor; uniform vec2 uFoam, uFade;
      uniform float uShoreFoam, uTime, uHasBed; uniform sampler2D uBed; uniform vec4 uBedRect;
      varying vec3 vWorld; varying vec3 vN; varying float vCrest;
      ${NOISE}
      void main() {
        vec3 N = normalize(vN), V = normalize(cameraPosition - vWorld);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = mix(uHorizon, uSky, clamp(R.y * 1.5, 0.0, 1.0));
        float depth = 1000.0;
        if (uHasBed > 0.5) depth = max(vWorld.y - texture2D(uBed, (vWorld.xz - uBedRect.xy) / uBedRect.zw).r, 0.0);
        vec3 trans = exp(-uAbsorb * depth);
        vec3 body = uShallow * trans + uDeep * (1.0 - trans);
        vec3 col = mix(body, sky, fres);
        col += uSunColor * pow(max(dot(R, normalize(uSunDir)), 0.0), 300.0) * 2.0;
        float n = vnoise(vWorld.xz * 0.7 + uTime * 0.08);
        float shore = uHasBed > 0.5 ? 1.0 - smoothstep(0.0, uShoreFoam, depth) : 0.0;
        float foam = clamp(smoothstep(uFoam.x, uFoam.y, vCrest) + shore, 0.0, 1.0) * smoothstep(0.35, 0.65, n);
        col = mix(col, vec3(0.95), foam * 0.85);
        col = mix(col, uHorizon, smoothstep(uFade.x, uFade.y, distance(cameraPosition, vWorld)));
        gl_FragColor = vec4(col, uHasBed > 0.5 ? clamp(depth * 3.0, 0.0, 1.0) : 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const cellSize = size / segments;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size, segments, segments).rotateX(-Math.PI / 2), material);
  mesh.frustumCulled = false;                                   // vertices move far from the rest bounds
  return {
    mesh, uniforms, cellSize,
    update(t, camera) {
      uniforms.uTime.value = t;
      mesh.position.set(Math.round(camera.position.x / cellSize) * cellSize, 0, Math.round(camera.position.z / cellSize) * cellSize);
    },
    dispose() { mesh.geometry.dispose(); material.dispose(); },
  };
}
```

- `uTime` is in seconds and the same `t` goes to `waterHeight`. A mismatch of even 0.1 s puts the boat half a wave off.
- Colours here are in the working (linear) space of a `ShaderMaterial`. `colorspace_fragment` converts for the output, so author colours by eye on screen.
- Shore foam and alpha need the bed texture. Open sea (`bed = null`) skips both.
- The sample leans on a sky gradient for reflection. Swap in a cube or PMREM environment (`lighting-ibl-shadows`) or the planar reflection of section 5 for the real thing.

## 4. FFT ocean (design only, not built here)

Statistical ocean (Tessendorf, what Blender's Ocean modifier does) sums thousands of waves from a spectrum with an inverse FFT. It reads as real water but costs real passes.

| Part | Detail |
|---|---|
| Spectrum | JONSWAP or Phillips: wind speed, fetch, direction. Generate `h0(k)` once per cascade with a seeded Gaussian |
| Per frame | Advance phase by `w = sqrt(g k)`, inverse FFT of height, and of the two horizontal displacements and slopes |
| FFT | N = 256 or 512 per cascade, `log2(N)` butterfly stages in two directions with ping-pong targets. WebGL2: fragment passes with float or half-float targets. WebGPU: compute |
| Cascades | 3 patches at different tile sizes (for example 20, 80, 320 m) so the surface does not visibly repeat |
| Foam | Jacobian of the horizontal displacement below a threshold, accumulated and decayed in a texture |
| Cost | 3 cascades of N = 256: about 8 stages x 2 x 3 passes per frame plus mesh and fragment work. High tier only |

Decision: Gerstner for any scene where the camera is not the point of the sea. FFT only when the ocean is the hero and the tier is high. If you build it, check the spectrum normalisation against a known wave height before tuning the look, and treat every constant here as unverified.

## 5. The three.js water addons

| Addon (`three/addons/objects/`) | Renderer | What it is |
|---|---|---|
| `Water.js` | WebGL | Planar reflection plus a scrolling normal map, sun specular, distortion. Wave motion is normal-map only, no geometry waves |
| `Water2.js` | WebGL | Reflection and refraction with a flow map |
| `WaterMesh.js` | WebGPU only | Node-material version of the same idea |
| `Reflector.js` | WebGL | A mirror plane: renders the scene from the mirrored camera into a render target. Options `color`, `textureWidth`, `textureHeight`, `clipBias`, `shader`, `multisample` (default 4) |
| `Sky.js`, `SkyMesh.js` | WebGL, WebGPU | Preetham-style sky dome (section 10) |

```js
import { Water } from 'three/addons/objects/Water.js';

const normals = new THREE.TextureLoader().load('waternormals.jpg', (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; });
const water = new Water(new THREE.PlaneGeometry(2000, 2000), {
  waterNormals: normals, sunDirection: sun.clone().normalize(), sunColor: 0xffffff, waterColor: 0x001e0f,
  distortionScale: 3.7, textureWidth: 512, textureHeight: 512, fog: scene.fog !== undefined,
});
water.rotation.x = -Math.PI / 2;
scene.add(water);
// per frame: water.material.uniforms['time'].value += dt;
```

Rules:
- A planar reflection **renders the scene again** from below the surface. Cost is one more scene pass at `textureWidth` by `textureHeight`. Use 512 by 512 or half the screen, not the full size, and render only what shows in a mirror (sky, terrain, big props) by giving the rest a layer the reflection camera does not use (`render-qa` shows the extra draw calls).
- It reflects a **flat** plane. It does not follow Gerstner crests. Use it for lakes and calm sea. For waves, take the reflection from the normal-distorted sky and environment, or use SSR.
- Hide the water from its own reflection pass (the addon does) and never place it under another reflector.
- Update the reflection every second frame on mid tier (`mesh.onBeforeRender` runs per camera render, throttle it with a frame counter and `visible` toggles, verify the behaviour in your revision).
- The addons are examples, so their API can move. Check the exact revision before relying on an option name.
- Do not stack: Gerstner geometry plus the `Water` shader both want the vertex position. Pick one surface.

## 6. Terrain data

A terrain is a square grid of heights in metres, `h[iz * n + ix]`, `n` samples per side (`n - 1` cells), covering `size` metres centred on the origin. Everything else (mesh, collision, depth, splat) is derived from that one array, so generate it once and share it.

```js
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** fBm heights in metres. island > 0 pushes the border below sea level (0). Same seed, same terrain. */
export function generateHeights({ n = 257, size = 512, seed = 1, octaves = 6, frequency = 0.004, gain = 0.5, lacunarity = 2, height = 60, island = 0.6 } = {}) {
  const noise = new ImprovedNoise(), r = rng(seed), ox = r() * 1000, oz = r() * 1000;
  const h = new Float32Array(n * n);
  let norm = 0; for (let o = 0, a = 1; o < octaves; o++, a *= gain) norm += a;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const x = (ix / (n - 1) - 0.5) * size, z = (iz / (n - 1) - 0.5) * size;
    let v = 0, a = 1, f = frequency;
    for (let o = 0; o < octaves; o++, a *= gain, f *= lacunarity) v += a * noise.noise(x * f + ox, 0.37 * o, z * f + oz);
    v = v / norm * 0.5 + 0.5;                                                     // about 0..1
    const d = Math.hypot(x, z) / (size * 0.5);                                    // 0 centre, 1 edge midpoint
    v = v * (1 - island * THREE.MathUtils.smoothstep(d, 0.35, 1.0)) - island * 0.35 * THREE.MathUtils.smoothstep(d, 0.5, 1.0);
    h[iz * n + ix] = v * height;
  }
  return h;
}

/** Bilinear height at world (x, z). Use it for placement and gameplay queries. */
export function sampleHeight(h, n, size, x, z) {
  const u = Math.min(Math.max((x / size + 0.5) * (n - 1), 0), n - 1.0001), v = Math.min(Math.max((z / size + 0.5) * (n - 1), 0), n - 1.0001);
  const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz, i = iz * n + ix;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fz) + (h[i + n] * (1 - fx) + h[i + n + 1] * fx) * fz;
}

/** Thermal erosion: slopes steeper than `talus` (metres of drop per cell) slump toward lower neighbours. Conserves volume. */
export function thermalErosion(h, n, { iterations = 25, talus = 1.2, rate = 0.4 } = {}) {
  const d = new Float32Array(n * n), nb = [1, -1, n, -n];
  for (let it = 0; it < iterations; it++) {
    d.fill(0);
    for (let iz = 1; iz < n - 1; iz++) for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix; let total = 0, maxDrop = 0;
      for (const o of nb) { const drop = h[i] - h[i + o]; if (drop > talus) { total += drop - talus; maxDrop = Math.max(maxDrop, drop); } }
      if (!total) continue;
      const move = rate * (maxDrop - talus) * 0.5;
      for (const o of nb) { const drop = h[i] - h[i + o]; if (drop > talus) { const share = move * (drop - talus) / total; d[i] -= share; d[i + o] += share; } }
    }
    for (let i = 0; i < d.length; i++) h[i] += d[i];
  }
}

/** Droplet hydraulic erosion (the common particle method): each drop follows the slope, picks up sediment where it is fast, drops it where it slows.
 *  Works on heights scaled to 0..1 so the constants mean the same for any height range. A drop leaves its sediment where it dies, except when it runs off the map edge:
 *  that sediment is lost (depositing it there draws a ridge around the map). Tune by eye, lower erode and capacity for gentler results. */
export function hydraulicErosion(h, n, { drops = Math.round(n * n * 1.5), seed = 1, inertia = 0.05, capacity = 4, minSlope = 0.01, deposit = 0.3, erode = 0.3, evaporate = 0.02, gravity = 4, maxLife = 40, radius = 3 } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { lo = Math.min(lo, h[i]); hi = Math.max(hi, h[i]); }
  const range = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / range;
  const rand = rng(seed);
  const spread = (x, z, amount) => {                                 // add (or remove, if negative) height over a brush: single-cell changes show as speckle
    const cx = Math.round(x), cz = Math.round(z); let sum = 0;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = cx + dx, zz = cz + dz; if (xx < 0 || xx >= n || zz < 0 || zz >= n) continue;
      sum += Math.max(0, radius - Math.hypot(xx - x, zz - z));
    }
    if (sum === 0) return;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = cx + dx, zz = cz + dz; if (xx < 0 || xx >= n || zz < 0 || zz >= n) continue;
      h[zz * n + xx] += amount * Math.max(0, radius - Math.hypot(xx - x, zz - z)) / sum;
    }
  };
  for (let k = 0; k < drops; k++) {
    let x = 1 + rand() * (n - 3), z = 1 + rand() * (n - 3), dx = 0, dz = 0, speed = 1, water = 1, sediment = 0, exited = false;
    for (let life = 0; life < maxLife; life++) {
      const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, i = iz * n + ix;
      const h00 = h[i], h10 = h[i + 1], h01 = h[i + n], h11 = h[i + n + 1];
      dx = dx * inertia - ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) * (1 - inertia);
      dz = dz * inertia - ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * (1 - inertia);
      const len = Math.sqrt(dx * dx + dz * dz); if (len < 1e-6) break;
      dx /= len; dz /= len;
      const nx = x + dx, nz = z + dz;
      if (nx < 1 || nx >= n - 2 || nz < 1 || nz >= n - 2) { exited = true; break; }
      const hOld = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;
      const dh = sampleGrid(h, n, nx, nz) - hOld;
      const cap = Math.max(-dh, minSlope) * speed * water * capacity;
      let amount;
      if (sediment > cap || dh > 0) amount = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * deposit;   // deposit
      else amount = -Math.min((cap - sediment) * erode, -dh);                                                // erode, never below the new height
      sediment -= amount; spread(x, z, amount);
      speed = Math.sqrt(Math.max(speed * speed - dh * gravity, 0)); water *= 1 - evaporate; x = nx; z = nz;
    }
    if (sediment > 0 && !exited) spread(x, z, sediment);                          // the drop dies here: leave what it carries
  }
  for (let i = 0; i < h.length; i++) h[i] = h[i] * range + lo;
}
function sampleGrid(h, n, x, z) {                                    // bilinear in grid units
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, i = iz * n + ix;
  return (h[i] * (1 - fx) + h[i + 1] * fx) * (1 - fz) + (h[i + n] * (1 - fx) + h[i + n + 1] * fx) * fz;
}

/** Half-float height texture for shaders that need the bed (water depth). Linear filtering works on half float without an extension. */
export function heightTexture(h, n) {
  const data = new Uint16Array(n * n); for (let i = 0; i < data.length; i++) data[i] = THREE.DataUtils.toHalfFloat(h[i]);
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}

/** RGBA8 splat weights: R grass, G rock, B sand, A snow, from height and slope. Artists can paint over it. */
export function autoSplat(h, n, size, { waterLevel = 0, sandBand = 1.5, snowLine = 45, rockSlope = 0.55 } = {}) {
  const cell = size / (n - 1), out = new Uint8Array(n * n * 4), ss = THREE.MathUtils.smoothstep;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const i = iz * n + ix, x0 = Math.max(ix - 1, 0), x1 = Math.min(ix + 1, n - 1), z0 = Math.max(iz - 1, 0), z1 = Math.min(iz + 1, n - 1);
    const slope = Math.hypot((h[iz * n + x1] - h[iz * n + x0]) / ((x1 - x0) * cell), (h[z1 * n + ix] - h[z0 * n + ix]) / ((z1 - z0) * cell));   // rise over run
    const rock = ss(slope, rockSlope * 0.7, rockSlope * 1.1), sand = (1 - ss(h[i], waterLevel + sandBand * 0.5, waterLevel + sandBand)) * (1 - rock);
    const snow = ss(h[i], snowLine - 6, snowLine + 6) * (1 - rock * 0.8), grass = Math.max(0, 1 - rock - sand - snow);
    const sum = grass + rock + sand + snow || 1;
    out.set([grass / sum * 255, rock / sum * 255, sand / sum * 255, snow / sum * 255], i * 4);
  }
  return out;
}

/** Rapier wants the grid x-major (z contiguous): index ix * n + iz. Our grid is z-major. Checked with ray casts against Rapier 0.21. */
export function toRapierHeights(h, n) {
  const r = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) r[ix * n + iz] = h[iz * n + ix];
  return r;
}
```

Rules:
- **Noise.** `frequency` is cycles per metre of the first octave: `0.004` gives a feature about 250 m across. Octaves above 6 add detail smaller than the grid cell, which is wasted. For ridged mountains use `1 - abs(noise)` per octave, for plateaus raise the result to a power above 1.
- **Domain warp** (add `noise(p) * k` to the sample position before the fBm) breaks the "perlin look". One warp pass is enough.
- **Seeded and offline.** Generate at build time and ship the heights as a PNG16 or `.bin` when the terrain is authored, or generate at load from the seed when it is procedural. Never `Math.random`.
- **Erosion is expensive.** 40000 drops on 257 by 257 runs once at load in a worker (or offline). Thermal pass first for talus, then hydraulic for channels. Erosion moves material, so re-check the max height and the water level afterwards.
- Real sources (SRTM, Blender Landscape, World Machine) arrive as 16-bit heightmaps: convert `value / 65535 * height`. 8-bit heightmaps stair-step on smooth slopes (`mesh-texture-upscale` section 3).
- The height array is also the **bed** for water depth and the **splat** source. Build `heightTexture(h, n)` once and share it.
- Keep a `waterLevel` constant (usually 0) and let the terrain cross it for beaches. It is also where sand begins in `autoSplat`.

## 7. Terrain mesh: chunked LOD with skirts

Split the grid into square chunks of `chunk` cells. Each chunk has the same local vertex layout, so its three LOD index buffers are shared by every chunk. A skirt (a vertical strip around the edge) hides the cracks where neighbouring chunks use different LODs. Normals come from the global height array, so chunk borders shade without seams.

```js
export function createTerrain({ heights, n, size, chunk = 32, strides = [1, 2, 4], lodDistances = [0, 150, 320], skirt = 3, material }) {
  const cells = n - 1, cell = size / cells, C = chunk, V = (C + 1) * (C + 1), R = 4 * C;
  if (cells % C) throw new Error('n - 1 must be a multiple of chunk');
  for (const s of strides) if (C % s) throw new Error('chunk must be a multiple of every stride');

  const ring = [];                                                       // border vertices, clockwise seen from above
  for (let x = 0; x < C; x++) ring.push(x);
  for (let z = 0; z < C; z++) ring.push(z * (C + 1) + C);
  for (let x = C; x > 0; x--) ring.push(C * (C + 1) + x);
  for (let z = C; z > 0; z--) ring.push(z * (C + 1));

  const indexAttr = strides.map((s) => {                                 // shared by all chunks
    const idx = [];
    for (let z = 0; z < C; z += s) for (let x = 0; x < C; x += s) {
      const a = z * (C + 1) + x, b = a + s, c = a + s * (C + 1), d = c + s;
      idx.push(a, c, b, b, c, d);
    }
    for (let k = 0; k < R; k += s) {
      const a = ring[k], b = ring[(k + s) % R], a2 = V + k, b2 = V + ((k + s) % R);
      idx.push(a, b, a2, b, b2, a2);                                     // outward facing skirt quad
    }
    return new THREE.BufferAttribute(new Uint16Array(idx), 1);
  });

  const H = (ix, iz) => heights[Math.min(Math.max(iz, 0), n - 1) * n + Math.min(Math.max(ix, 0), n - 1)];
  const group = new THREE.Group(), geometries = [];
  const chunksPerSide = cells / C;
  for (let cz = 0; cz < chunksPerSide; cz++) for (let cx = 0; cx < chunksPerSide; cx++) {
    const pos = new Float32Array((V + R) * 3), nor = new Float32Array((V + R) * 3), uv = new Float32Array((V + R) * 2);
    const put = (vi, gx, gz, drop) => {
      pos.set([(gx - cx * C - C / 2) * cell, H(gx, gz) - drop, (gz - cz * C - C / 2) * cell], vi * 3);
      const nx = (H(gx - 1, gz) - H(gx + 1, gz)) / (2 * cell), nz = (H(gx, gz - 1) - H(gx, gz + 1)) / (2 * cell), l = Math.hypot(nx, 1, nz);
      nor.set([nx / l, 1 / l, nz / l], vi * 3);
      uv.set([gx / cells, gz / cells], vi * 2);
    };
    for (let z = 0; z <= C; z++) for (let x = 0; x <= C; x++) put(z * (C + 1) + x, cx * C + x, cz * C + z, 0);
    ring.forEach((src, k) => { const x = src % (C + 1), z = (src - x) / (C + 1); put(V + k, cx * C + x, cz * C + z, skirt); });
    const attrs = { position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nor, 3), uv: new THREE.BufferAttribute(uv, 2) };
    const box = new THREE.Box3().setFromBufferAttribute(attrs.position), sphere = box.getBoundingSphere(new THREE.Sphere());
    const lod = new THREE.LOD();
    strides.forEach((s, i) => {
      const g = new THREE.BufferGeometry();
      for (const k in attrs) g.setAttribute(k, attrs[k]);                // the three LODs share these buffers
      g.setIndex(indexAttr[i]); g.boundingBox = box.clone(); g.boundingSphere = sphere.clone();
      geometries.push(g);
      lod.addLevel(new THREE.Mesh(g, material), lodDistances[i], 0.1);
    });
    lod.position.set((cx * C + C / 2) * cell - size / 2, 0, (cz * C + C / 2) * cell - size / 2);
    group.add(lod);
  }
  return {
    group, chunks: chunksPerSide * chunksPerSide,
    triangles: strides.map((s) => 2 * (C / s) ** 2 + 2 * (R / s)),     // per chunk per LOD, skirts included
    heightAt: (x, z) => sampleHeight(heights, n, size, x, z),
    dispose() { geometries.forEach((g) => g.dispose()); indexAttr.length = 0; },
  };
}
```

Rules:
- `THREE.LOD` picks the level by distance from the chunk centre to the camera each render. `lodDistances` is the distance **at which each level starts**. Start values for a 512 m terrain with 64 m chunks (guess): `[0, 150, 320]`. Derive properly from geometric error: the distance where a level's largest height error projects to about 2 px, `d = error * viewportHeight / (2 * tan(fov / 2) * 2)`.
- **Skirt depth** must be at least the largest height gap between two LODs along a shared edge, or cracks show above the skirt. Measure it on your terrain (section 13 gives a number), do not guess for steep terrain.
- Chunk size 32 or 64 cells. Smaller chunks cull better and cost more draw calls, larger ones the reverse (`performance-budget` section 2: budget the chunk count).
- One material for all chunks (`createSplatMaterial`, section 8). Chunks never need their own.
- Frustum culling is per chunk through the bounding sphere. Do not set `frustumCulled = false`.
- Water below terrain level is fine. Fog and a dark under-sea tint hide terrain below the surface (`uBed` depth does the rest).
- **Geometry clipmap** alternative: concentric square rings centred on the camera, each ring twice the cell size of the one inside, heights read from `heightTexture` in the vertex shader, and a morph at ring borders to avoid cracks. Best for huge worlds (`n` of 2k and up). Not built here, the chunked version is simpler to debug and cull.
- **Vertex-texture displacement** (a flat plane displaced by `heightTexture`) works for small terrains and animated height, but loses the CPU copy for collision unless you keep both. Keep the array.

## 8. Texturing: splat map

A splat map stores per-pixel layer weights. Four layers fit one RGBA texture, `autoSplat` fills it from height and slope.

```js
export function createSplatMaterial({ splat, layers, tile = [0.25, 0.25, 0.25, 0.25] }) {
  // splat: Uint8Array from autoSplat plus n. layers: 4 sRGB colour textures with RepeatWrapping and mips. tile: repeats per metre.
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const uniforms = { uSplat: { value: splat }, uL0: { value: layers[0] }, uL1: { value: layers[1] }, uL2: { value: layers[2] }, uL3: { value: layers[3] }, uTile: { value: new THREE.Vector4(...tile) } };
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSplatUv; varying vec2 vTerrainXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplatUv = uv; vTerrainXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uSplat, uL0, uL1, uL2, uL3; uniform vec4 uTile;\nvarying vec2 vSplatUv; varying vec2 vTerrainXZ;')
      .replace('#include <map_fragment>', `
        vec4 w = texture2D(uSplat, vSplatUv); w /= max(w.r + w.g + w.b + w.a, 1e-4);
        diffuseColor.rgb *= texture2D(uL0, vTerrainXZ * uTile.x).rgb * w.r + texture2D(uL1, vTerrainXZ * uTile.y).rgb * w.g
                          + texture2D(uL2, vTerrainXZ * uTile.z).rgb * w.b + texture2D(uL3, vTerrainXZ * uTile.w).rgb * w.a;`);
  };
  m.customProgramCacheKey = () => 'splat-v1';
  return { material: m, uniforms };
}

export function splatTexture(data, n) {                // data from autoSplat
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;   // weights are data: no colour space
  return t;
}
```

Rules:
- Weights are **data**: keep the splat texture linear (default `NoColorSpace`). The layer textures are colour: `SRGBColorSpace`, mips on, anisotropy at the maximum (`mesh-texture-upscale` section 3).
- **Cliffs stretch** when layers are projected along Y. Sample the rock layer triplanar (`shader-craft` has the snippet) or at least blend it by slope so rock replaces grass before the stretching shows.
- **Tiling shows** on large flats. Mix each layer with a second sample at 0.17 times the frequency, multiplying 0.5 to 1.5 (macro variation), or break it with a noise-driven rotation.
- Blending by plain weights looks muddy. Height blending (use each layer's height map to bias the weights, then sharpen) gives crisp transitions. Add it only if the close view needs it.
- Splat resolution can equal the height grid (257 here). A painted splat needs 2 to 4 times that for sharp painted edges, check close up.
- Four layers per splat texture. More layers need a second splat texture and more fetches. Budget 4 layer fetches plus 1 splat fetch per pixel on low tier, which is already a lot (`performance-budget`).
- Roughness and normal per layer follow the same weights (`pbr-lookdev`). Start with colour only.
- Scatter the vegetation from the same slope and height data: grass where the splat weight is high (`fur-hair-grass-systems` density map).

## 9. Collision and ground queries

- Gameplay (placing objects, camera ground clamp, AI): `sampleHeight(heights, n, size, x, z)`. Bilinear, no physics world needed.
- Rigid bodies: a Rapier `heightfield` collider (collider table in `physics-rigidbody` section 5). The grid orientation is the trap:

```js
const hf = RAPIER.ColliderDesc.heightfield(n - 1, n - 1, toRapierHeights(heights, n), { x: size, y: 1, z: size });
world.createCollider(hf);                                   // centred on the origin, like the mesh
```

- Checked against Rapier 0.21 with ray casts: with `toRapierHeights` the collider matches `sampleHeight` at the sample points (section 13). Without the transpose x and z are swapped.
- `scale.y` is a multiplier of the heights you pass. Pass metres and `y: 1`.
- Heightfield triangulation differs from the render mesh diagonal, so the two disagree by a few centimetres inside a cell. Make the collider slightly thicker than the visual for resting objects (`physics-rigidbody` section 5).
- Water is not a collider. Buoyancy uses `waterHeight` from section 2.
- Do not build a trimesh collider from the visual chunks. The heightfield is cheaper and stable.

## 10. Sky, sun, fog

```js
import { Sky } from 'three/addons/objects/Sky.js';

const sky = new Sky(); sky.scale.setScalar(10000); scene.add(sky);
const u = sky.material.uniforms;
u.turbidity.value = 4; u.rayleigh.value = 1.5; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;

function setSun(elevationDeg, azimuthDeg) {
  const dir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevationDeg), THREE.MathUtils.degToRad(azimuthDeg));
  u.sunPosition.value.copy(dir);
  sun.position.copy(dir).multiplyScalar(200); sun.target.position.set(0, 0, 0);       // sun is a DirectionalLight
  ocean.uniforms.uSunDir.value.copy(dir);
}
```

- Light the scene from the sky: render the sky into a PMREM environment once (`PMREMGenerator.fromScene(sky)`) and set `scene.environment`, redo it when the sun moves a lot, not every frame (`lighting-ibl-shadows`).
- **Fog sets the horizon.** Use `THREE.FogExp2` or `Fog` with the same colour as the ocean's `uHorizon` and the sky near the horizon, otherwise terrain and sea end in a visible line. Distance fade in the ocean shader uses the same colour (`uFade`).
- Fog has to reach full density before the far plane and before the terrain edge, or the world looks like a cut-out.
- The camera must sit inside the sky dome and the far plane must contain it (`sky.scale` 10000 needs `camera.far` above that, or put the sky on its own pass with a depth-less render).
- Time of day: sun elevation drives sun colour (orange near the horizon), light intensity, sky turbidity and ocean sun glint together. Keep them on one function.
- Clouds, god rays, height fog, aerial perspective: `volumetrics-atmosphere`. Tone mapping and exposure: `lighting-ibl-shadows`, `post-processing-stack`.

## 11. Budget per tier

Start values (guess), tied to `performance-budget`.

| | Low (phone) | Mid (laptop) | High (desktop GPU) |
|---|---|---|---|
| Ocean | Gerstner 3 waves, 64 to 96 segments per side, env gradient reflection | Gerstner 4 to 5 waves, 192 segments, planar reflection 512 every other frame | Gerstner 6 waves, 256 to 384 segments, planar 1024, refraction, foam; FFT optional |
| Reflection render | none | 1 extra pass, 512 by 512 | 1 extra pass, 1024 by 1024 |
| Terrain heights | 129 by 129 | 257 by 257 | 513 by 513 |
| Terrain chunks | 16 chunks, chunk 32, stride up to 8 | 64 chunks, strides 1, 2, 4 | 64 to 256 chunks |
| Terrain triangles on screen | up to 60k | up to 200k | up to 500k |
| Splat layers | 2 to 3, no macro variation | 4 | 4 plus macro and triplanar rock |
| Shadows from terrain | off, baked AO in splat | one cascade | 2 to 3 cascades (`lighting-ibl-shadows`) |
| Draw calls for the environment | under 40 | under 80 | under 120 |

- Chunks beyond the fog end are hidden (`lod.visible = false` by distance, or a far plane inside the fog).
- The planar reflection is the most expensive single item here. On low tier drop it first.
- Terrain tiles on mobile: skip `strides[0] = 1` beyond the first ring, so far chunks are never at full resolution.

## 12. Failure symptoms

| Symptom | Cause | Fix |
|---|---|---|
| Waves look like a tiled quilt | One wave set, regular directions, or a repeating normal map | More waves with irrational wavelength ratios, mix a second normal map at another scale |
| Mesh folds and spikes appear | `uSteep` above 1, or amplitude too large for the wavelength | Steepness at most 1, amplitude under wavelength / 14 |
| Waves jitter or shimmer | Wavelength shorter than 4 cells | Raise segments or lengthen the short waves |
| Waves slide when the camera moves | Shader reads local position | World position in the shader (done), snap the mesh to its cell |
| Boat floats above or below the surface | JS and shader disagree, `t` differs, horizontal displacement ignored | Same waves and `t`, use `waterHeight` with the source search |
| Water cuts a hard line at the shore | No depth, no alpha | Bed texture and alpha by depth |
| Water looks black or flat blue | No reflection | Fresnel against sky, sun glint, an environment map |
| Reflection shows the water itself, or is blurry | Wrong layers, low target size | Hide the water in its pass, 512 and up |
| Cracks between terrain chunks | LOD mismatch, skirt too shallow | Skirt depth at least the measured gap |
| Terrain pops when LOD changes | Hard switch near the camera | Hysteresis, LOD distances from geometric error, texture hides the change |
| Lighting seams on chunk borders | Normals computed per chunk | Normals from the global heights (done) |
| Texture stretches on cliffs | Planar projection | Triplanar or slope blend |
| Grass or props float on terrain | Different height source for scatter | Use `sampleHeight` on the same array |
| Ball falls through or rests at the wrong height | Heightfield grid transposed | `toRapierHeights` |
| Horizon shows a line | Fog colour and sky disagree, far plane cuts terrain | Same colour, fog full before far |
| Terrain stairs on gentle slopes | 8-bit heightmap | 16-bit source or generated heights |
| Everything is slow | Reflection plus shadow plus high segments | Drop the planar pass first, then segments, then chunks |

## 13. Verify

Checks run for this skill (Node 22.22 for the maths, headless Chromium with SwiftShader and three 0.187.0 for the shaders, Rapier 0.21.0 for collision). The wave set was 60, 31, 17 and 9 m.

| Check | Result |
|---|---|
| Wave map Jacobian (positive means no loops) | `steep` 1: minimum 0.18. `steep` 0.6: 0.47. `steep` 1.6: negative, the surface folds |
| `waterNormal` against the finite-difference surface normal | Exact: 0 degrees at 2 decimals for `steep` 0.3, 0.6 and 1. The simpler normal that ignores the cross terms was off by 2.2, 5.3 and 18.6 degrees |
| `waterSource` landing error on world (x, z) | 0.002 m with 3 Newton steps. Plain fixed-point iteration (4 steps) was 0.42 m |
| GLSL displacement, normal and crest read back from a float render target against the JavaScript functions, 64 points | 0.0004 m, 0.025 degrees, 0.0001 |
| Ocean material (with a bed texture), `Water`, `Reflector`, `Sky` | compile and render, ocean pixels change with time, no console errors |
| `generateHeights` | Same seed same array, different seed differs, border below sea level with `island` |
| `thermalErosion` | Volume conserved (relative 2e-9), steepest step 1.68 to 1.51 m per cell |
| `hydraulicErosion`, 129 by 129, default drops | Deterministic, finite, 12% of the volume lost through the map edge, mean height change 2.7 m on a 43 m range, about 1.1 s in Node. Hill-shaded result shows radial gullies, no edge ridge |
| `createTerrain`, 129 by 129, chunk 32 | 16 chunks, triangles per chunk per LOD 2304, 640, 192 (skirts included), 256 skirt triangles all facing outward, no top triangle facing down, one shared index buffer per LOD across chunks, LODs share vertex buffers |
| Height gap between LOD edges on that terrain (cell 2 m, 43 m range) | stride 2: 0.16 m, stride 4: 0.55 m, stride 8: 1.28 m |
| `THREE.LOD` choice at 10, 200 and 500 m | levels 0, 1, 2 |
| Rendered triangles, 4 chunks, all near, mid, far | 9216, 2560, 768 |
| Splat material, left half red weight, right half green weight, top view | left (236, 43, 43), right (43, 236, 43) |
| Rapier `heightfield` against `sampleHeight`, ray casts at 6 points | With `toRapierHeights`: 0 m at the sample nodes, up to about 8 mm inside a cell (different triangulation). With a plain copy: 5.2 m, x and z swapped |
| Integrated frame (terrain, ocean with bed, sky, fog) | 18 draw calls, about 140k triangles (the 256 by 256 ocean is 131k of them), 6 shader programs |

Then, in your scene:
1. `render-qa` at a close orbit (water surface, shoreline), a grazing view of the horizon, and the phone shot. Look for cracks, a hard horizon, tiling, foam on flat water.
2. Read `renderer.info.render.calls` and `triangles` against the tier row in section 11.
3. Drop a floating object and a rigid ball and watch both for a minute. They must follow the surface and rest on the ground.
4. Fly the camera low over the water and high over the terrain. The LOD change must not be visible as popping.

Not verified in this skill: the FFT ocean (design only), the geometry clipmap, planar reflection throttling, screen-space depth for water depth, triplanar and height-blended splats, three.js water addon options beyond the compile check, performance numbers on real phones.
