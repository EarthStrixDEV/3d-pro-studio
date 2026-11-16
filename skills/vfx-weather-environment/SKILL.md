---
name: vfx-weather-environment
description: Build weather and ambient environment effects in Three.js. Covers rain and snow streaks, ground splashes and water ripples, dust motes, fireflies, falling leaves with shared wind, lightning bolts and flashes, fog banks, and the camera-relative particle volume that follows the camera without popping using wrap-around recycling, rain occlusion indoors, wet surface response and per tier counts, with one verified wrap-around volume sample (seamless over one box period and at huge camera coordinates). Use when a request asks for rain, snow, storm, thunder, lightning, dust, fireflies, falling leaves, drifting fog, ambient particles or an atmospheric mood, or when ambient particles pop, slide with the camera or run out when the camera travels. Thai triggers ฝน, หิมะ, พายุ, ฟ้าผ่า, ฟ้าแลบ, หมอก, ฝุ่นลอย, หิ่งห้อย, ใบไม้ร่วง.
argument-hint: "<weather or ambient effect, scene size in metres, indoor areas yes or no, and device tier>"
---

# VFX: Weather and Environment

Ambient effects surround the camera, so the core problem is not the look of one drop but keeping a believable cloud of them around a moving camera for free. Particle plumbing: `particle-system-architecture` and `particle-forces-fields` (wind, curl noise). Fog and sky: `volumetrics-atmosphere`. Water surfaces and shorelines: `ocean-terrain-environment`. Foliage that bends in the same wind: `fur-hair-grass-systems`.

## 1. Pick the construction

| Effect | Construction | Notes |
|---|---|---|
| Rain | Stretched streak quads in a camera volume (section 2) | Streak length is velocity times a shutter time. Layer 2 volumes with different speeds and sizes for depth |
| Snow | Same volume, no streak, sideways drift | Slow (0.5 to 1.5 m/s), large soft flakes, two sizes |
| Dust motes | Same volume, tiny, very slow, additive | Only visible inside light shafts, so tie brightness to them |
| Fireflies | Same volume, Lissajous path plus blink, additive HDR | Dusk only, bloom does the glow |
| Falling leaves | Instanced alpha cutout cards, flutter and tumble | Cutout (`alphaTest`) avoids sorting. Landed leaves need a CPU pool (`particle-system-architecture`) |
| Ground splashes | Fixed pool of ring quads on the ground, same wrap trick in 2D | Life 0.3 to 0.5 s, radius 0.02 to 0.15 m, fade with `1 - t` |
| Water ripples | A height or normal simulation on the water surface | Belongs to the water shader in `ocean-terrain-environment`. Rain only spawns the drops |
| Lightning | Bolt polyline plus a light and sky flash (section 5) | The flash carries the effect, the bolt is secondary |
| Fog banks, mist | Few huge soft cards with scrolling noise, or height fog | Section 6. Global fog stays in `volumetrics-atmosphere` |

## 2. Verified sample: camera-relative wrap-around volume

The particles live in a box of `size` metres that follows the camera. A particle's world position is fixed (it does not slide with the camera), and when it leaves the box on one side it re-enters on the other, faded out so the jump is invisible. Rain, snow, dust and fireflies are this one file with different parameters.

Verified on three 0.187: moving the camera by exactly one box period (and to 3,000,000 m) renders pixel identical frames, a 7.3 m move changes the image, snow and rain compile with no console errors.

```js
import * as THREE from 'three';

// Camera-relative wrap-around volume (rain, snow, dust, motes). Stateless and precision safe:
// the CPU computes shift = (velocity * t - camera) mod size in doubles, the shader only wraps and fades.
export function createWeatherVolume({
  count = 6000, size = new THREE.Vector3(30, 20, 30), velocity = new THREE.Vector3(-1.5, -14, 0),
  streak = 0.06, width = 0.012, drift = 0, color = 0xc8dcff, alpha = 0.5, seed = 1,
} = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);   // seeded: same weather every run
  const base = new THREE.PlaneGeometry(1, 1), geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index; geo.setAttribute('position', base.getAttribute('position')); geo.setAttribute('uv', base.getAttribute('uv'));
  geo.instanceCount = count;
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seeds.set([rnd(), rnd(), rnd(), rnd()], i * 4);
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));

  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,   // the quad is built in the shader, its winding flips with the streak direction
    uniforms: {
      uShift: { value: new THREE.Vector3() }, uSize: { value: size.clone() }, uVel: { value: velocity.clone() },
      uStreak: { value: streak }, uWidth: { value: width }, uDrift: { value: drift }, uPhase: { value: 0 },
      uColor: { value: new THREE.Color(color) }, uAlpha: { value: alpha },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uShift, uSize, uVel; uniform float uStreak, uWidth, uDrift, uPhase;
      attribute vec4 aSeed;
      varying vec2 vUv; varying float vFade;
      void main() {
        vec3 q = mod(aSeed.xyz * uSize + uShift, uSize);               // wrapped inside the box
        vec3 rel = q - 0.5 * uSize;                                     // camera relative position
        rel.xz += uDrift * vec2(sin(uPhase + aSeed.w * 6.2832), cos(uPhase * 0.8 + aSeed.w * 12.566));
        vec3 e = abs(q / uSize - 0.5) * 2.0;
        vFade = 1.0 - smoothstep(0.8, 1.0, max(e.x, max(e.y, e.z)));    // fade before the wrap, so no pop
        vec3 a = mat3(viewMatrix) * rel;                                // translation cancels: no precision loss
        vec3 b = a - mat3(viewMatrix) * uVel * uStreak;                 // tail of the streak
        vFade *= smoothstep(0.4, 1.5, -a.z);                            // fade drops that reach the lens
        vec2 d = b.xy - a.xy; float len = length(d);
        d = len > 1e-5 ? d / len : vec2(0.0, 1.0);
        vec3 v = a;
        v.xy += d * (position.y + 0.5) * max(len, uWidth * 2.0) + vec2(-d.y, d.x) * position.x * uWidth;
        vUv = uv;
        gl_Position = projectionMatrix * vec4(v, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uAlpha;
      varying vec2 vUv; varying float vFade;
      void main() {
        float side = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float a = smoothstep(0.0, 0.6, side) * mix(1.0, 0.25, vUv.y) * vFade * uAlpha;   // soft sides, fading tail
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;   // the box follows the camera, never cull it
  const mod = (x, m) => ((x % m) + m) % m;
  return {
    mesh,
    update(t, camera) {                                                 // t: seconds, doubles are fine on the CPU
      const u = material.uniforms, v = u.uVel.value, z = u.uSize.value, c = camera.position;
      u.uShift.value.set(mod(v.x * t - c.x, z.x), mod(v.y * t - c.y, z.y), mod(v.z * t - c.z, z.z));
      u.uPhase.value = (t * 0.7) % (Math.PI * 2);
    },
    dispose() { geo.dispose(); material.dispose(); },
  };
}
```

Usage:

```js
const rain = createWeatherVolume({ count: 8000, velocity: new THREE.Vector3(-1.5, -14, 0) });
const snow = createWeatherVolume({ count: 2000, velocity: new THREE.Vector3(0, -1.2, 0), streak: 0, width: 0.03,
  drift: 0.4, color: 0xffffff, alpha: 0.9, seed: 7 });
scene.add(rain.mesh, snow.mesh);
// every frame: rain.update(clock.elapsedTime, camera); snow.update(clock.elapsedTime, camera);
```

Why it works, and the traps:
- **Wrap with `mod` on camera relative coordinates.** `q = mod(seed * size + shift, size)` where `shift = (velocity * t - camera) mod size` is computed on the CPU in doubles. The shader never sees large numbers, so there is no jitter far from the origin and no precision loss as `t` grows.
- **Fade before the wrap.** `vFade` goes to zero near every face of the box. Without it you see particles blink out at the edge.
- **`DoubleSide` is required.** The quad is rebuilt in the shader and its winding flips with the streak direction. Front face culling makes the whole effect vanish (this was the first failure of the sample).
- **`frustumCulled = false`.** The bounding sphere comes from one unit quad.
- **Seeded random.** The sample uses a seeded generator, so the same weather appears on every run. Never `Math.random` for anything you need to reproduce in `render-qa`.
- **Box size sets density.** Density is `count / (size.x * size.y * size.z)`. Shrink the box and keep the count to densify.
- **Streak is in view space.** The width is metric, so distant drops thin to under a pixel and shimmer. Use a minimum pixel width (derive it from `uWidth` and distance) or fade by distance if shimmer shows.
- **Per layer parameters.** One volume is one draw call. Two or three volumes at different sizes and speeds look denser than one with the same total count.
- **Wind.** Add a shared wind vector to `velocity` (slant for rain, drift for snow). Time varying gusts follow `particle-forces-fields`. Use the same wind source for leaves, foliage and cloth.

## 3. Starting values per effect

Tune against a screenshot. Tiers are starting guesses (`performance-budget`, `vfx-performance-scaling`).

| Effect | Speed | Streak or size | Box | Count (low / mid / high) | Blend |
|---|---|---|---|---|---|
| Rain | 10 to 15 m/s down, slant with wind | Streak 0.04 to 0.08 s, width 0.01 m | 30 x 20 x 30 | 1.5k / 5k / 10k | Normal, low alpha 0.3 to 0.6 |
| Heavy rain | 12 to 16 m/s | Same, add a second layer | 20 x 15 x 20 | 3k / 10k / 20k | Normal |
| Snow | 0.5 to 1.5 m/s, drift 0.2 to 0.6 m | Flake 0.02 to 0.05 m | 20 x 12 x 20 | 800 / 2.5k / 6k | Normal or additive |
| Dust motes | 0.02 to 0.1 m/s | 0.01 to 0.03 m | 8 x 5 x 8 | 100 / 300 / 600 | Additive, brightness from light shafts |
| Fireflies | Path speed 0.2 to 0.6 m/s | 0.05 to 0.12 m with blink | 20 x 6 x 20 | 20 / 60 / 150 | Additive, HDR 3 to 6 |
| Leaves | 0.8 to 2 m/s fall, wind push | 0.05 to 0.12 m | 25 x 12 x 25 | 40 / 150 / 400 | Alpha cutout |

Rules:
- **Rain looks like rain from sound, grade and secondary effects:** splashes, wet surfaces, a cooler grade, reduced fog distance and darker sky. Streaks alone read as scratches on the lens.
- **Rain over bright sky needs alpha blending.** Additive rain disappears on a bright background. Use normal blending with a pale colour.
- **Fireflies:** per instance path `p = base + A * (sin(w1 t + a), 0.5 * sin(w2 t + b), sin(w3 t + c))`, blink `pow(0.5 + 0.5 * sin(f t + d), 6)`. Randomise `w`, `f` and the phases per instance, keep the amplitude under 1.5 m.
- **Leaves:** lateral flutter `0.3 to 0.6 m` at 0.8 to 1.5 Hz, tumble 1 to 4 rad/s around a random axis, spawn upwind of the camera, wrap the same way. Use the fall plus flutter in the vertex shader and a cutout leaf texture (`vfx-flipbook-authoring` for atlases of several leaf shapes).
- **Dust motes** need a reason to be seen. Brightness is the product of a light shaft mask and the mote, otherwise they read as noise.

## 4. Rain occlusion and the ground

**Rain indoors.** A camera volume rains inside buildings unless you stop it. Cheapest fix: render the static scene once from above with an orthographic camera into a depth target, store the top surface height per xz, and in the vertex shader hide a drop whose world height is under the stored height at its xz (verify, not run in this sample). Limits: roofs and canopies only (it knows the highest surface, not gaps under it), and it must be redone when the scene changes. For levels with defined interiors, simply fade the volume out by a zone weight when the camera enters.

**Splashes.** Not stateless in the rain volume (it has no ground knowledge). Use a separate fixed pool of ring quads on the ground, wrapped around the camera in xz by the same mod trick, each with a random phase and a life of 0.3 to 0.5 s. Place them on uneven terrain using the height array (`ocean-terrain-environment` section 6). Add a few 3 to 5 point crown sprites at the closest radius.

**Wet look.** Lower roughness, darken albedo by 10 to 30 percent, add puddle reflections by masking roughness with a noise (`pbr-lookdev`). Ramp the wetness up over 20 to 60 s so rain does not switch it on instantly.

**Water surfaces.** Ripples on ponds and sea come from the water shader and its normal or height map (`ocean-terrain-environment`). Rain drops add impulses at random points. Do not simulate per drop.

## 5. Lightning

| Part | Recipe |
|---|---|
| Strike schedule | Random interval 4 to 12 s, skip while the camera is under a cutscene lock |
| Flash envelope | Keyframes in seconds: `0:0, 0.03:1, 0.08:0.2, 0.14:0.7, 0.3:0`. Multiply by a peak that drives light, ambient and sky together |
| Light | One `DirectionalLight` from the sky for key light, plus a hemisphere or ambient boost. Intensity follows the envelope. Cast shadow only if cheap |
| Sky and fog | Lift sky and fog colour toward blue white by the envelope (`volumetrics-atmosphere`). Bloom strength rises with it (`post-processing-stack`) |
| Bolt | Midpoint displacement polyline: split a segment, offset the midpoint sideways by up to 25 percent of its length, recurse 5 to 7 levels, add 2 to 3 branches at half width. Draw with `Line2` and `LineMaterial` from `three/addons/lines` for pixel width, thin `LineSegments` stay 1 px wide in WebGL. Or use ribbons (`particle-trails-ribbons`) |
| Bolt life | 2 to 4 frames of full bright, then re-flash once. Flicker the bolt, never fade it smoothly |
| Thunder | Sound delay of `distance / 343` seconds. Louder and sharper when near |

Safety: cap flashes to 3 per second and offer a reduced effects switch that drops the flash to a gentle brighten (`vfx-magic-energy-stylized` section 1, `vfx-timing-choreography`).

## 6. Fog banks and mist

| Method | Use | Notes |
|---|---|---|
| Height fog in the sky and ground shader | Global mood, cheapest | `volumetrics-atmosphere` section 3 |
| Large soft cards (5 to 10 per bank) | Visible banks drifting low over a valley or floor | Alpha 0.05 to 0.2 each, size 10 to 40 m, scrolling noise at 0.01 to 0.05 m/s, tint to the fog colour |
| Wrap volume with big soft sprites | Walking through mist | Same sample as section 2 with `width` 2 to 6 m and low alpha. Fade near the camera strongly |

Rules: depth fade the cards where they cut into the ground (the `inter` term from `vfx-magic-energy-stylized` section 4, used as a soft particle fade). Fade near the camera or the card edge shows. Few big cards cost less fill than many small ones. Do not stack opaque looking banks, keep alpha low and rely on layering.

## 7. Verify (`render-qa`)

1. Fly the camera along a line for 200 m: no pop at the box edge, no sliding with the camera, density unchanged.
2. Rotate quickly: particles are world fixed, they must not swim.
3. Teleport the camera 1,000,000 m away (if the project allows it): no jitter.
4. Screenshot over a dark and a bright background, with bloom on and off.
5. Walk indoors, then back: rain must stop and return without a pop.
6. Check overdraw on the lowest tier (`render-qa --gpu` where available, `performance-budget`).
7. Check `prefers-reduced-motion` and the flash safety switch.
