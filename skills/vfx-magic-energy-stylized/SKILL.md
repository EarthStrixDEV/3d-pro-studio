---
name: vfx-magic-energy-stylized
description: Build stylised magic and energy effects in Three.js. Covers spell casts and summon circles, auras, energy beams, shields with fresnel and depth based intersection glow and hit ripples, portals, dissolve and hit flashes, stylised trails, colour ramp driven looks that restyle one effect into fire, ice or poison, readability rules (silhouette, contrast against the scene, colour coding, flash safety) and toon variants, with one verified shield sample (depth pre-pass, intersection glow, ripples). Use when a request asks for magic, spell, aura, force field, shield, energy beam, laser, portal, teleport, power up, glow effect or hit flash, or when a stylised effect is hard to read against the scene. Thai triggers เวทมนตร์, ออร่า, โล่พลัง, ลำแสง, พอร์ทัล, เอฟเฟกต์พลัง, แฟลชตอนโดนตี, สลายตัว.
argument-hint: "<effect wanted, e.g. force field shield, beam, portal, plus art style and device tier>"
---

# VFX: Magic, Energy and Stylised Effects

Stylised effects are shapes, ramps and timing, not simulation. Particle plumbing is in `particle-system-architecture` and `particle-rendering-blending`. Fresnel, dissolve and noise code is in `shader-craft` (copy it, do not re-derive). Toon outlines and banding are in `npr-toon-outline`. This skill picks the construction, the colour logic and the readability rules.

## 1. Readability rules

An effect that looks good in isolation and cannot be read in play has failed. Check each rule on a screenshot.

| Rule | Test | Fix |
|---|---|---|
| Silhouette | Blur the screenshot or view it at 10 percent. Can you still tell what it is and where it is? | Add a bright core and a clear outer edge. Avoid thin soft wisps as the only shape |
| Contrast with the scene | Convert to greyscale. Effect luminance must differ from the background | Raise HDR core, or put a dark soft underlay (alpha blended) behind a bright additive layer. Additive on white fails, there is nothing to add to |
| Hue budget | Count hues | 2 to 3 per effect. Core near white, body saturated, edge shifted toward a neighbour hue. Pick the accent complementary to the scene |
| Colour coding | Can a player tell friend from foe, element from element | One hue per meaning, kept consistent across every effect in the project. Do not rely on hue alone, vary shape too (accessibility) |
| Anticipation and hold | Timeline | 100 to 300 ms build up, a hold long enough to read (200 ms or more), then fade. Starting guesses, tune with `vfx-timing-choreography` |
| Clutter | Spawn the worst case | Cap simultaneous effects and the largest screen area they may cover. Fade the oldest first |
| Flash safety | Count full screen luminance flashes | At most 3 per second (WCAG 2.3.1). Offer a reduced effects switch: no flashes, no shake, no distortion, lower bloom |

## 2. Pick the construction

| Effect | Construction | Key controls |
|---|---|---|
| Shield, force field | Sphere or mesh shell, additive, fresnel rim, depth intersection glow, hit ripples (section 4) | Fresnel power 2 to 4, edge width 0.1 to 0.4 m (guess) |
| Aura around a character | Shell mesh scaled 1 to 3 percent along normals, fresnel times scrolling noise through a ramp | Skinned characters need the shell to deform with the same skeleton (`rigging-skeleton-ik`, verify). Offset along normals, never uniform scale |
| Energy beam | Two quads or cylinders: white core plus wider coloured glow. UV scrolls along the length, a noise mask erodes the edge | Billboard around the beam axis. Impact flash sprite plus sparks at the end. Ribbons: `particle-trails-ribbons` |
| Portal | Disc with polar uv (angle, radius). Swirl by adding `radius * k - time` to the angle. Emissive rim ring, noise eroded edge | Add the depth fade from section 4 so the rim never clips. Particles sucked in by a vortex field (`particle-forces-fields`) |
| Cast or summon circle | Flat quad with a rune texture, additive, slow rotation, scale in with ease out back | Project it onto uneven ground with a decal (`vfx-impact-sparks-decals`) |
| Power up, charge | Rising particles with inward then outward velocity, ramp brighter with charge, ends in a pulse ring | Camera shake rises with charge (hooks in `vfx-timing-choreography`) |
| Stylised trail | Ribbon with width over life and a ramp over length | `particle-trails-ribbons`. Taper to a point, fade by length not by time alone |
| Dissolve, spawn, despawn | Noise threshold with a glowing edge band (section 6) | Edge colour in HDR so bloom lights it |
| Hit flash | Short emissive override (section 6) | 1 to 3 frames, mostly white |
| Hologram, scanline | Fresnel plus scanlines plus flicker | Code in `shader-craft` |

## 3. Colour ramp driven looks

Compute a scalar (fresnel, noise, age, distance along a beam), then look the colour up in a 1D ramp texture. The geometry and animation stay the same, only the ramp changes, so one effect becomes fire, ice or poison.

| Look | Ramp, dark to bright | Notes |
|---|---|---|
| Arcane | deep violet, magenta, cyan, white | Cool body, warm accent flash |
| Fire magic | dark red, orange, yellow, white | Same ramp as `vfx-fire-smoke-explosion` |
| Ice | deep blue, cyan, pale blue, white | Add sparkle points, keep shapes hard edged |
| Poison, nature | dark green, lime, yellow green | Low bloom, slower motion |
| Holy | gold, pale yellow, white | Soft long rays, high bloom |

Rules:
- Load ramps with `NoColorSpace` if you store linear values, or `SRGBColorSpace` if you author them as sRGB colours. Pick one rule per project.
- Multiply the looked up colour by an HDR scalar (2 to 8, guess) so bloom picks it up (`post-processing-stack`). Ramp stores colour, scalar stores energy.
- Stylised does not mean flat: ramp by value, not by hue only, or the effect loses depth under toon shading.
- Authoring ramp code is in `shader-craft`. Swapping ramps at runtime means swapping one texture uniform, no recompile.

## 4. Verified sample: shield with fresnel, depth intersection and hit ripples

Three parts: a fresnel rim, a glow where the shield meets geometry (compares its own view depth to a depth texture of the opaque scene), and ripples spawned at hit points. Verified on three 0.187 (depth pre-pass, intersection glow on ground and box, ripple adds light, no console errors). This is also the soft particle recipe: use the `inter` term as `1 - inter` to fade particle cards where they cut into geometry.

```js
import * as THREE from 'three';

export const FX_LAYER = 1;   // put every effect mesh on this layer so the depth pre-pass skips it

export function createShield({ radius = 1.5, color = 0x4fb6ff, hdr = 3 } = {}) {
  const hits = Array.from({ length: 4 }, () => new THREE.Vector4(0, 1, 0, -1000));   // xyz local direction, w start time
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: {
      tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 100 },
      uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uHdr: { value: hdr },
      uEdge: { value: 0.25 }, uFresnelPow: { value: 3 }, uHits: { value: hits },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN, vV, vLocal;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = mv.xyz; vN = normalMatrix * normal; vLocal = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tDepth;
      uniform vec2 uRes; uniform float uNear, uFar, uTime, uHdr, uEdge, uFresnelPow;
      uniform vec3 uColor; uniform vec4 uHits[4];
      varying vec3 vN, vV, vLocal;
      void main() {
        float sceneZ = perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x, uNear, uFar);
        float inter = 1.0 - smoothstep(0.0, uEdge, vV.z - sceneZ);        // 1 where the shield touches geometry
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(-vV))), uFresnelPow);
        float scan = 0.85 + 0.15 * sin(vLocal.y * 40.0 - uTime * 3.0);   // slow scanline keeps the surface alive
        float ripple = 0.0;
        for (int i = 0; i < 4; i++) {
          float age = uTime - uHits[i].w;
          float d = acos(clamp(dot(normalize(vLocal), uHits[i].xyz), -1.0, 1.0));   // angle from the hit point
          float ring = exp(-pow((d - age * 2.5) / 0.12, 2.0)) * exp(-age * 2.0);
          float flash = exp(-d * 6.0) * exp(-age * 8.0);
          ripple += (ring + flash) * step(0.0, age);
        }
        float e = fres * scan + inter * 1.5 + ripple * 2.0;
        gl_FragColor = vec4(uColor * uHdr * e, clamp(e, 0.0, 1.0));      // additive: rgb * alpha
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  mesh.layers.set(FX_LAYER);
  let next = 0;
  return {
    mesh,
    hit(worldPoint, now) {                                              // ring buffer of 4 simultaneous ripples
      const l = mesh.worldToLocal(worldPoint.clone()).normalize();
      hits[next].set(l.x, l.y, l.z, now); next = (next + 1) % hits.length;
    },
  };
}

// Depth pre-pass (opaque scene only, FX layer off), then the main render. Costs one extra scene pass:
// reuse a depth texture from your post chain (post-processing-stack) when you already have one.
export function createDepthPass(renderer) {
  const size = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1);
  target.depthTexture = new THREE.DepthTexture(1, 1);
  return {
    render(scene, camera, now, ...materials) {      // materials: every ShaderMaterial that reads tDepth
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);   // resizes the depth texture too
      for (const m of materials) {
        const u = m.uniforms;
        u.tDepth.value = target.depthTexture; u.uRes.value.copy(size); u.uNear.value = camera.near; u.uFar.value = camera.far;
        if (u.uTime) u.uTime.value = now;
      }
      camera.layers.disable(FX_LAYER);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      camera.layers.enable(FX_LAYER);
      renderer.render(scene, camera);
    },
    dispose() { target.dispose(); target.depthTexture.dispose(); },
  };
}
```

Usage:

```js
const shield = createShield({ radius: 1.5, color: 0x4fb6ff, hdr: 3 });
scene.add(shield.mesh);
const depthPass = createDepthPass(renderer);
// every frame, instead of renderer.render(scene, camera):
depthPass.render(scene, camera, clock.elapsedTime, shield.mesh.material);   // pass every material that reads tDepth
// on a hit:
shield.hit(worldPoint, clock.elapsedTime);
```

Rules:
- **Depth formula assumes a standard perspective depth buffer.** Reversed or logarithmic depth buffers need a different decode (verify against your renderer options).
- **Resolution must match.** `gl_FragCoord / uRes` only maps correctly when the depth target equals the drawing buffer size, including pixel ratio. The sample resizes from `getDrawingBufferSize`.
- **No feedback loop.** Never sample the depth texture of the target you are drawing to. The sample uses a separate pre-pass target.
- **The pre-pass is an extra opaque scene pass.** If the post stack already produces a depth texture, reuse it and delete `createDepthPass`.
- Back faces of the shield also draw (`DoubleSide`), so the inside of the shield reads from within. Use `FrontSide` for cheaper single layer looks.
- Ripples are angular distance on a sphere. For non spherical shields drive ripples from world or object distance to the hit point instead.
- Extra ripples beyond 4 overwrite the oldest, which is fine for a shield and cheap.
- Pair with `particle-trails-ribbons` or sparks at the impact point and a `vfx-impact-sparks-decals` hit response for the receiver.

## 5. Beams, auras and portals in practice

| Detail | Rule |
|---|---|
| Beam width | Core 0.05 to 0.15 m, glow 3 to 5 times wider (guess). Width pulses by 5 to 10 percent so it feels alive |
| Beam scroll | Scroll noise along the length faster than the beam travels. Two noise layers at different speeds hide repetition |
| Beam length change | Update the endpoints each frame and rebuild no geometry: scale one unit quad along the axis |
| Beam hit point | Raycast for the end, place the impact sprite and sparks there, face the surface normal |
| Aura | Keep alpha low, brightness from the ramp. A bright aura flattens the model, so mask it to rim and base |
| Portal rim | HDR ring plus a noise eroded outer edge. The interior is a swirl or a render target view of another scene (budget a second render) |
| Portal approach | Fade the portal with distance to the camera, otherwise near plane clipping shows the disc edge |
| Particle companions | Embers, motes or sparks around any construction sell it more than shader tricks. Counts 20 to 100, low tier 10 to 30 |
| Distortion | Optional refraction ring on portals and shields, hand off to `vfx-post-fx-compositing` |

## 6. Dissolve and hit flashes

**Dissolve.** Noise value `n` in 0 to 1 against `progress`. Discard below the threshold, add an edge band `smoothstep(p, p + w, n)` inverted, coloured with an HDR edge colour. Code in `shader-craft` (the `onBeforeCompile` dissolve patch). Rules:
- Start progress slightly below zero and finish slightly above one so the first and last frames show no band.
- Use the same noise for the shadow caster (`customDepthMaterial`) or the shadow stays solid while the mesh dissolves.
- Emit edge embers from the dissolve band only, not from the whole mesh.

**Hit flash.** One float `uFlash` per object, set to 1 on hit and decayed (`flash = max(0, flash - dt / 0.1)`). In the shader add `mix(base, hdrWhite, flash)` or add to emissive. Rules:
- Flash lasts 1 to 3 frames of white, then a short coloured decay. Longer reads as a status effect.
- `material.clone()` drops `onBeforeCompile` patches, so re-apply the patch on each clone. Share one material and drive `uFlash` from an `InstancedBufferAttribute` for crowds.
- Pair with a hit stop and tiny shake (`vfx-timing-choreography`, `vfx-impact-sparks-decals`).

## 7. Toon variants

Stylised often means toon. Quantise the ramp lookup (`floor(x * steps) / steps`) or use a ramp texture with hard stops and `NearestFilter`. Keep VFX meshes out of the outline pass: an inverted hull outline on a shield or aura draws an unwanted black shell. Put effects on a layer the outline pass skips (`npr-toon-outline`). Keep bloom low or use thresholded bloom with a hard edge.

## 8. Performance and verify (`render-qa`)

| Item | Guide (starting guesses) |
|---|---|
| Overdraw | Large additive shells and portals cost fill, not geometry. Shrink on low tier, drop second noise layers |
| Draw calls | One shield, beam or portal is one draw. Batch many auras with instancing |
| Depth pre-pass | One extra opaque pass, skip it on low tier and use fresnel only |
| Bloom | The effect's whole glow depends on it. Check the effect with bloom off as the fallback look |

1. Screenshot the effect over a bright, a dark and a busy background. It must stay readable on all three.
2. Greyscale and blur check from section 1.
3. Orbit the shield, check the intersection band stays a constant width and shows on every surface.
4. Verify near plane behaviour for portals and beams that the camera crosses.
5. Verify the low tier and reduced effects variants and the reduced motion setting.
