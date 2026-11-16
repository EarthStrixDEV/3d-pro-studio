---
name: vfx-fire-smoke-explosion
description: Build fire, smoke, explosion, shockwave, ember and debris effects in Three.js on top of a particle system. Covers flipbook cards versus raymarched or grid volumes, colour ramps over life, temperature to emission mapping, HDR emission for bloom, smoke lighting and soft edges, heat distortion hand-off, shockwave rings, debris bursts, light flicker and the timing of an explosion beat (flash, fireball, smoke, embers), with one verified stateless explosion sample. Use when a request asks for fire, campfire, torch, explosion, blast, smoke plume, muzzle flash, embers or burning, or when fire looks flat, smoke looks like grey cotton, or the explosion reads weak. Thai triggers ไฟ, ควัน, ระเบิด, ลูกไฟ, ประกายไฟ, คลื่นกระแทก, เอฟเฟกต์ไฟลุก.
argument-hint: "<effect wanted, e.g. campfire, grenade explosion, torch, plus target device tier>"
---

# VFX: Fire, Smoke and Explosions

Recipe level classic effects. The particle machinery lives in `particle-system-architecture`, `gpu-particles-compute` and `particle-rendering-blending`. One billboard flipbook sample is in `realtime-engine-features` section 2. This skill decides what to layer, which colours and timings sell it, and what to hand to other passes.

## 1. Pick the technique

| Need | Technique | Cost and limits |
|---|---|---|
| Background fire, torches, small blasts, anything under about 5 m on screen | Procedural billboard cards (section 3 sample) | Cheapest. Fill rate is the cost. No parallax up close |
| Hero fire or explosion filmed from close | Flipbook cards authored from a sim (`vfx-flipbook-authoring`) | Best look per cost. Needs authored frames and texture memory |
| Fireball or smoke the camera flies into, volume lit by its own fire | Raymarched volume (`volumetrics-atmosphere`) | Heavy. Half resolution target, 32 to 64 steps, desktop only |
| Smoke that wraps around obstacles and reacts to wind | Grid smoke (`grid-fluid-smoke`) | Compute budget. Cache offline if the shot is fixed (`sim-cache-baking-vat`) |
| Mesh shaped fireball (a displaced sphere with a noise scroll) | Shell mesh plus ramp lookup | One draw call. Reads well for stylised blasts, see `vfx-magic-energy-stylized` |

Default: layered cards. Add one volume or sim only for the single hero shot that needs it.

## 2. What makes it read

- **Temperature drives everything.** Keep one value `temp` per particle: 1 at birth, falling with age. Colour is a lookup `ramp(temp)`, emission is `hdr * temp`. Never author fire as a fixed texture colour.
- **Ramp order, hot to cold:** white yellow core, yellow, orange, deep red, black. Fire and embers share the ramp. Smoke takes over where the ramp reaches black.
- **HDR emission is the glow.** Output values above 1 (core 6 to 14, embers 8 to 10, starting guesses) into a half float target. Bloom (`post-processing-stack`) turns them into glow. In an 8 bit output the core clips to flat white and the effect looks pasted on.
- **Fire is additive, smoke is not.** Additive layers need no sorting. Smoke needs alpha blending, so it darkens what is behind it. Use premultiplied alpha, render smoke first and fire after it.
- **Lit smoke.** Fake a sphere normal from the quad uv, light it with the sun and add a warm term driven by the fireball age. Dark smoke with no light term reads as black cotton.
- **Soft edges.** Alpha from noise eroded by age, never a hard disc. For contact with geometry fade by depth difference (soft particles, depth sampling is in `vfx-magic-energy-stylized` section 4, hooks in `particle-rendering-blending`).
- **Size grows with `sqrt(age)`.** Fast expansion then slowing reads as pressure release. Linear growth reads as balloons.
- **Buoyancy and drag.** Hot gas rises (gravity upward, small). Blast gas decelerates fast (drag 2 to 3). Debris and embers fall (gravity downward, low drag).

## 3. Verified sample: stateless explosion beat

Four layers share one shader: flash, fireball, smoke, embers. Position is a closed form of age with drag, `p = dir * speed * (1 - e^(-k age)) / k + 0.5 g age^2`, so nothing runs on the CPU per frame. Verified on three 0.187: renders, no console errors, half float readback shows peak 18 (HDR reaches the buffer).

```js
import * as THREE from 'three';

// Temperature ramp: x = temperature 0..1, stored 8 bit and linear (NoColorSpace). HDR comes from uHdr, not the texture.
function makeRamp(stops) {
  const w = 128, data = new Uint8Array(w * 4), a = new THREE.Color(), b = new THREE.Color();
  for (let i = 0; i < w; i++) {
    const x = i / (w - 1);
    let k = 0;
    while (k < stops.length - 2 && stops[k + 1][0] < x) k++;
    const [x0, c0] = stops[k], [x1, c1] = stops[k + 1];
    a.set(c0); b.set(c1);                                  // hex in, converted to linear working space
    a.lerp(b, THREE.MathUtils.clamp((x - x0) / (x1 - x0), 0, 1));
    data.set([a.r * 255, a.g * 255, a.b * 255, 255], i * 4);
  }
  const t = new THREE.DataTexture(data, w, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace; t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
  uniform float uTime, uStart, uLoop, uDrag;
  uniform vec3 uGravity;
  uniform vec2 uSize;
  attribute vec4 aDir;      // xyz unit direction, w random 0..1
  attribute vec4 aMotion;   // x speed, y life, z delay, w spin rate
  varying vec2 vP; varying float vT, vR;
  void main() {
    float age = uTime - uStart - aMotion.z;
    if (uLoop > 0.5) age = mod(age, aMotion.y);
    float t = age / aMotion.y;
    if (age < 0.0 || t > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float k = max(uDrag, 1e-3);
    vec3 p = aDir.xyz * aMotion.x * (1.0 - exp(-k * age)) / k + 0.5 * uGravity * age * age;  // closed form drag
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float s = sin(aMotion.w * age + aDir.w * 6.2832), c = cos(aMotion.w * age + aDir.w * 6.2832);
    mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y)
           * mix(uSize.x, uSize.y, sqrt(t)) * (0.7 + 0.6 * aDir.w);
    vP = position.xy * 2.0; vT = t; vR = aDir.w;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform sampler2D uRamp;
  uniform float uHdr, uTempPow, uOpacity, uGlow;
  uniform vec3 uLightDir, uSmokeTint, uGlowColor;   // light dir in VIEW space
  varying vec2 vP; varying float vT, vR;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
  void main() {
    float r = length(vP); if (r > 1.0) discard;
    float n = vn(vP * 2.5 + vR * 17.0);
    float body = smoothstep(1.0, 0.15, r);
    float a = clamp((body * (0.5 + n) - vT * 0.6) * 2.0, 0.0, 1.0) * smoothstep(0.0, 0.05, vT) * uOpacity;
    #ifdef FIRE
      float temp = pow(1.0 - vT, uTempPow) * (0.6 + 0.4 * n) * body;
      vec3 col = texture2D(uRamp, vec2(temp, 0.5)).rgb * uHdr * temp;   // emission scales with temperature
      gl_FragColor = vec4(col, a);                                       // additive: rgb * a
    #else
      vec3 nrm = vec3(vP, sqrt(max(0.0, 1.0 - r * r)));                  // sphere normal faked from the quad
      float lit = dot(nrm, uLightDir) * 0.5 + 0.5;
      vec3 col = uSmokeTint * (0.25 + 0.75 * lit) + uGlowColor * uGlow * pow(1.0 - vT, 2.0);
      gl_FragColor = vec4(col * a, a);                                   // premultiplied
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const sphere = (v) => { do v.set(Math.random(), Math.random(), Math.random()).multiplyScalar(2).subScalar(1); while (v.lengthSq() > 1 || v.lengthSq() < 0.01); return v.normalize(); };
const rr = ([a, b]) => a + Math.random() * (b - a);

export function makeLayer(o, shared) {
  const base = new THREE.PlaneGeometry(1, 1), geo = new THREE.InstancedBufferGeometry(), v = new THREE.Vector3();
  geo.index = base.index; geo.setAttribute('position', base.getAttribute('position'));
  geo.instanceCount = o.count;
  const dir = new Float32Array(o.count * 4), mot = new Float32Array(o.count * 4);
  for (let i = 0; i < o.count; i++) {
    sphere(v); if (o.upBias) v.y = Math.abs(v.y) * o.upBias + v.y * (1 - o.upBias);
    dir.set([v.x, v.y, v.z, Math.random()], i * 4);
    mot.set([rr(o.speed), rr(o.life), rr(o.delay ?? [0, 0]), (Math.random() - 0.5) * 2], i * 4);
  }
  geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 4));
  geo.setAttribute('aMotion', new THREE.InstancedBufferAttribute(mot, 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    defines: o.fire ? { FIRE: 1 } : {},
    blending: o.fire ? THREE.AdditiveBlending : THREE.NormalBlending, premultipliedAlpha: !o.fire,
    uniforms: {
      uTime: shared.uTime, uStart: shared.uStart, uLoop: { value: o.loop ? 1 : 0 }, uDrag: { value: o.drag },
      uGravity: { value: new THREE.Vector3(...o.gravity) }, uSize: { value: new THREE.Vector2(...o.size) },
      uRamp: { value: shared.ramp }, uHdr: { value: o.hdr ?? 1 }, uTempPow: { value: o.tempPow ?? 1.5 },
      uOpacity: { value: o.opacity ?? 1 }, uGlow: shared.uGlow, uLightDir: shared.uLightDir,
      uSmokeTint: { value: new THREE.Color(o.tint ?? 0x3a3632) }, uGlowColor: { value: new THREE.Color(0xff6a1a) },
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = o.order ?? 0;   // smoke first, then additive fire on top
  return mesh;
}

// Explosion beat: flash, fireball, smoke, embers. Shockwave and debris are separate (see the skill).
export function createExplosion() {
  const shared = {
    uTime: { value: 0 }, uStart: { value: 0 }, uGlow: { value: 1 }, uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    ramp: makeRamp([[0, 0x000000], [0.25, 0x2a0500], [0.5, 0xc03000], [0.8, 0xffa020], [1, 0xfff0c0]]),
  };
  const group = new THREE.Group();
  group.add(
    makeLayer({ count: 70, life: [2.5, 4.5], delay: [0.15, 0.4], speed: [1.5, 3.5], drag: 2, gravity: [0, 0.6, 0], size: [1.2, 3.6], opacity: 0.85, order: 0 }, shared),
    makeLayer({ count: 48, life: [0.6, 1.1], speed: [3, 6], drag: 3, gravity: [0, 1.5, 0], size: [1.0, 2.6], fire: true, hdr: 6, order: 1 }, shared),
    makeLayer({ count: 3, life: [0.1, 0.16], speed: [0, 0.1], drag: 1, gravity: [0, 0, 0], size: [2.5, 6], fire: true, hdr: 14, tempPow: 0.5, order: 2 }, shared),
    makeLayer({ count: 120, life: [1, 2.4], speed: [6, 14], drag: 0.8, gravity: [0, -6, 0], size: [0.07, 0.03], fire: true, hdr: 9, tempPow: 1, upBias: 0.6, order: 1 }, shared),
  );
  const toView = new THREE.Vector3(), sun = new THREE.Vector3(0.4, 1, 0.3).normalize();
  return {
    group,
    start(now) { shared.uStart.value = now; },
    update(now, camera) {
      const t = now - shared.uStart.value;
      shared.uTime.value = now;
      shared.uGlow.value = Math.exp(-t * 2.2);                                   // fireball light on the smoke fades fast
      shared.uLightDir.value.copy(toView.copy(sun).transformDirection(camera.matrixWorldInverse));
    },
    dispose() {
      for (const m of group.children) { m.geometry.dispose(); m.material.dispose(); }
      shared.ramp.dispose();
    },
  };
}
```

Usage:

```js
const fx = createExplosion();           // import from your own module
scene.add(fx.group);
fx.group.position.set(0, 0, 0);
fx.start(clock.elapsedTime);            // fire the one shot
// every frame: fx.update(clock.elapsedTime, camera);
// when done: scene.remove(fx.group); fx.dispose();
```

Notes:
- `uLoop = 1` turns a layer into a loop (campfire, torch). Spread `aMotion.z` delays so loops do not pulse in unison.
- `frustumCulled = false` is required (bounding sphere comes from one unit quad).
- One mesh is one draw call, but eight overlapping large smoke cards can cost more fill than the whole scene. Cap count and size per tier (`vfx-performance-scaling`, `performance-budget`).
- Within a layer instances are not sorted. Smoke overlaps resolve in index order, hidden by low opacity and a similar tint. If order shows, split smoke into two or three layers by delay and rely on `renderOrder`.
- Use a flipbook instead of the noise erosion when the look must be art directed (`vfx-flipbook-authoring`). Swap the fragment body, keep the vertex path.
- For physics driven debris and reusable pools, use `particle-system-architecture` rather than growing this sample.

## 4. Explosion beat timing

An explosion is five overlapping events, not one effect. Starting values at 60 fps, tune against the shot (`vfx-timing-choreography` owns the master timeline).

| Time | Event | Notes |
|---|---|---|
| 0 ms | Flash plus a point light spike | 2 to 3 frames of near white. Light decays in 300 to 600 ms. One light only, no shadow |
| 0 to 100 ms | Camera shake and hit stop | Small hit stop (40 to 80 ms) sells weight. Hooks in `vfx-impact-sparks-decals` |
| 0 to 400 ms | Shockwave ring, heat distortion | Ring expands fast then slows. Distortion rides the ring |
| 50 to 1100 ms | Fireball | Peaks around 200 ms, cools to red by 700 ms |
| 100 ms | Scorch decal and ground dust | Decal pool in `vfx-impact-sparks-decals` |
| 150 ms to 4.5 s | Smoke | Starts when the fireball is still bright, so it picks up the glow |
| 0 to 2.5 s | Embers and debris | Debris leaves first, embers hang longest |

Rules:
- **Anticipation then release.** A frame or two of dark before the flash, then the flash, makes it hit harder. Do not start at full brightness.
- **Ease out the light, never cut it.** Exponential decay on the point light and on the smoke glow term (`exp(-t * 2.2)` in the sample).
- **Scale tells size.** Camera distance, shake amplitude and smoke height carry scale. A bigger sprite does not.

## 5. Shockwave, distortion, debris

**Shockwave ring.** A ground aligned `RingGeometry` with additive material, scaled by a radius law, alpha fading out as it grows. Blast waves grow roughly like `t^0.4` (Sedov Taylor), fast then slow.

```js
const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 96),
  new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2;
// per frame, t in seconds since start, R final radius, T duration
const k = Math.min(t / T, 1);
ring.scale.setScalar(Math.max(R * Math.pow(k, 0.4), 1e-3));
ring.material.opacity = (1 - k) * (1 - k);
```

**Heat distortion hand-off.** Do not distort in the particle shader. Render distortion sources (ring, fire columns) into a small offscreen target as a 2D offset (RG, 0.5 = no offset), then let the composite pass in `vfx-post-fx-compositing` offset the scene sample by it. Rules: depth test the distortion layer against opaque geometry so it never bends things in front of it, keep strength tiny (around 0.005 to 0.02 uv, guess), fade by age, and skip it on low tier.

**Debris.** Two groups, both short lived:

| Group | Count | Speed | Gravity | Life | Render |
|---|---|---|---|---|---|
| Chunks | 8 to 30 | 4 to 12 m/s, upward cone | Full (9.8) | 1 to 3 s | `InstancedMesh` of 2 to 4 shapes, random spin |
| Sparks, embers | 50 to 200 | 6 to 14 m/s | Low (3 to 6), drag | 1 to 2.5 s | Stretched additive cards, ramp colour, HDR |

Chunks with real bounce use `physics-rigidbody` (sleep them quickly, cap the active count). Pre fractured walls and pieces belong to `rigid-destruction-fracture` and `mograph-procedural`. Chunks leave a trail of smoke puffs (`particle-trails-ribbons`).

## 6. Sustained fire (campfire, torch)

| Layer | Setup |
|---|---|
| Core | 10 to 20 additive cards, life 0.4 to 0.8 s, loop, strong buoyancy, `tempPow` 1.5, HDR 4 to 6 |
| Tongues | 4 to 8 tall stretched cards, fast flicker, narrow |
| Smoke | 6 to 12 alpha cards, life 2 to 4 s, spawns above the core |
| Embers | 10 to 30 tiny additive points, rise with wind drift (`particle-forces-fields`) |
| Light | One `PointLight`, intensity from layered sine or noise (two frequencies, 3 and 11 Hz), colour from the ramp at temp 0.6 |

Rules: flicker the light, not only the sprites. Keep the light colour tied to the ramp so grade (`color-management-grading`) stays consistent. A wind vector should bend both smoke and flames.

## 7. Verify (`render-qa`)

1. Screenshot at 0.05, 0.3, 0.8, 1.8 and 3.5 s. Flash, fireball, embers hanging, then smoke must each be visible in order.
2. Read back a half float target or enable bloom: peak above 1 on the fireball, nothing above 1 on smoke.
3. Look for a hard disc edge, flat grey smoke, a rectangular edge where cards cut into geometry (needs soft depth fade) and a pop when the effect ends.
4. Orbit around it. Billboards must face the camera and no layer vanishes at the screen edge.
5. Check fill rate on the lowest tier (`performance-budget`, `vfx-performance-scaling`). Halve counts first, then sizes.
6. Reduced motion: cut the flash to a soft fade and drop shake and distortion.

## 8. Do not do these

- Do not colour fire with a fixed texture colour. Drive it with temperature.
- Do not use alpha blending for fire cores, they go muddy.
- Do not run per particle logic on the CPU past a few thousand particles (see `gpu-particles-compute`).
- Do not skip disposal: geometry, material and ramp textures.
