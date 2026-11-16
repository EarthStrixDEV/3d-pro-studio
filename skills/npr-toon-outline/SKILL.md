---
name: npr-toon-outline
description: Non-photorealistic rendering for Three.js, translating Blender Toon BSDF, Freestyle and Grease Pencil line art and the Maya toon shader and outlines into web techniques. Covers cel shading with MeshToonMaterial and gradientMap, rim light, halftone, outline methods (inverted hull, post-process edge detection on normal and depth, OutlinePass, OutlineEffect, crease lines), consistent line width in pixels, smooth normals for hulls, anti-aliasing of lines, cost per device tier and a verification routine. Use when a scene should look like anime, cel shading, comic, ink, flat illustration or toon, when outlines are needed, broken, uneven or flicker, or when asked for toon shader, cel shade, outline, edge lines, halftone or stylised rendering. Thai triggers การ์ตูน, อนิเมะ, เซลเชด, เส้นขอบ, เส้นเอาท์ไลน์, สไตล์วาดมือ, ฮาล์ฟโทน, ภาพวาดหมึก, โทนแบน.
argument-hint: "<model or scene, the style reference (anime, comic, ink) and target device tier>"
---

# NPR, Toon & Outline

A toon look is three decisions: how light is quantised (shading), how silhouettes and creases are drawn (lines), and how lines survive pixels (width and anti-aliasing). Pick each on purpose. Material basics are in `pbr-lookdev`, AA theory in `antialiasing-resolution`, normal and depth passes in `render-passes-aov`, budgets in `performance-budget`.

Status: run in a headless browser on three r187: gradient toon, rim patch, inverted hull with constant pixel width, hull on a hard-edged box with and without smooth normals, `OutlineEffect`, `OutlinePass`, normal and depth edge detection, halftone patch, `HalftonePass` construction. Blender and Maya names are from memory (verify). Cost numbers are starting guesses.

## 1. Map from DCC to Three.js

| Blender or Maya | Three.js | Section |
|---|---|---|
| Toon BSDF, or Shader to RGB into a constant Color Ramp (verify) | `MeshToonMaterial` with `gradientMap` | 2 |
| Maya toon shader ramp (verify) | Same | 2 |
| Freestyle lines (silhouette, crease, border, verify) | Inverted hull, post edge detection, `EdgesGeometry` lines | 3 |
| Grease Pencil strokes | Not a render feature on the web. Bake to textures or use fat lines (`Line2`, `antialiasing-resolution` section 5) | 3 |
| Maya toon outline (verify) | Inverted hull or edge detection | 3 |
| Rim and halftone looks via node trees | Shader patches | 2 |

## 2. Shading

### Gradient steps

```js
const bands = new Uint8Array([70, 160, 255]);                    // shadow, mid, light
const gradientMap = new THREE.DataTexture(bands, bands.length, 1, THREE.RedFormat);
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;   // linear filtering smears the bands
gradientMap.needsUpdate = true;
const mat = new THREE.MeshToonMaterial({ color: 0xe85d4a, gradientMap });
```

- `gradientMap` is data, not colour: leave `colorSpace` alone (the r187 docs say so). The map has 2 to 4 steps for cel looks, 5 or more reads as soft shading.
- Bands follow the light's `N . L`. Choose the key direction first (`lighting-ibl-shadows` rig), because the band edges are where the eye lands. A key at about 45 degrees above and to the side gives a clean terminator on spheres and faces.
- Toon materials ignore physically based environment reflections, so a toon object in an HDRI scene gets no ambient fill from it (verify on your revision). Add `AmbientLight` or `HemisphereLight` at 0.3 to 0.5 so shadow bands do not go black.
- Shadow map still works: one key light with `castShadow`. For hard shadow edges use `PCFShadowMap` with a low-res map (`PCFSoftShadowMap` is marked deprecated since r186 in the r187 constants, so prefer `PCFShadowMap` on new revisions).
- Flat colour areas look best with 8-bit friendly palettes. No tone mapping, or a mild `NeutralToneMapping`, keeps hand-picked colours (`color-management-grading`).

### Rim light

Verified: this patch compiles and draws a clean toon rim band.

```js
mat.onBeforeCompile = (s) => {
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', `#include <common>
      float rimBand(vec3 n, vec3 v) { float r = 1.0 - saturate(dot(n, v)); return smoothstep(0.55 - fwidth(r), 0.55 + fwidth(r), r); }`)
    .replace('#include <opaque_fragment>', `#include <opaque_fragment>
      gl_FragColor.rgb += vec3(0.35, 0.3, 0.25) * rimBand(normalize(normal), normalize(vViewPosition));`);
};
mat.customProgramCacheKey = () => 'toon-rim-v1';
```

`fwidth` keeps the band edge about one pixel wide at any size. Raise the `0.55` threshold for a thinner rim. Patch rules: `shader-craft` section 2.

### Halftone

Two routes:

| Route | Look | Cost |
|---|---|---|
| `HalftonePass` from `three/addons/postprocessing/HalftonePass.js` | Print-like colour dots over the whole frame. Constructor params verified in r187: `shape, radius, rotateR, rotateG, rotateB, scatter, blending, blendingMode, greyscale` | One fullscreen pass |
| Material patch (below) | Single ink colour dots in shadow areas only, per material | Free |

Verified patch (dots appear where the surface is dark, screen-space grid at 45 degrees, filtered edge):

```js
const u = { uCell: { value: 8 }, uInk: { value: new THREE.Color(0x222244) } };      // uCell in drawing-buffer pixels
m.onBeforeCompile = (s) => {
  Object.assign(s.uniforms, u);
  s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
    uniform float uCell; uniform vec3 uInk;
    float halftone(float darkness, vec2 frag, float cell, float angle) {
      mat2 r = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
      vec2 f = fract(r * frag / cell) - 0.5;
      float radius = sqrt(darkness) * 0.7071;                  // dot area follows darkness, 0.7071 fills the cell
      float d = length(f), w = fwidth(d);
      return smoothstep(radius + w, radius - w, d);
    }`).replace('#include <opaque_fragment>', `#include <opaque_fragment>
    float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uInk, halftone(1.0 - clamp(lum * 1.4, 0.0, 1.0), gl_FragCoord.xy, uCell, 0.785398));`);
};
m.customProgramCacheKey = () => 'toon-halftone-v1';
```

Tuning: at the shown setting small dots remain in the lit band, raise the `1.4` multiplier to clear them. Scale `uCell` with the pixel ratio so dot size stays the same on high-dpi screens.

## 3. Outlines: pick the method

| Method | Draws | Width | Inner creases | Cost | Skinned | Main weakness |
|---|---|---|---|---|---|---|
| Inverted hull (section 4) | Silhouettes | Constant pixels with the clip-space shader | No | One extra draw per mesh, 2x triangles | Needs skinning chunks (see `render-passes-aov`) | Hard edges tear unless normals are smoothed |
| `OutlineEffect` addon | Silhouettes (an inverted hull by material swap) | Fraction of screen height, not pixels | No | Doubles draw calls, swaps materials each frame | Handled by its material cache (verify) | Thickness in clip units, no per-pixel control |
| Post edge detection (section 5) | Silhouettes, creases, object borders | Pixels, from the sample offset | Yes | Aux pass plus one fullscreen pass | Yes, if the aux pass skins | Grazing angles and thin geometry noise |
| `OutlinePass` addon | Selected objects only, glowing edge | Blur radius | No | Mask re-render of the selection plus blur passes | Yes | Additive blending (see below), not a drawn ink line |
| `EdgesGeometry` lines | Hard edges of angular models | Fat line width | Yes (sharp ones) | Few draws | Static only | Misses smooth silhouettes |

Decision rules:
- **Characters and rounded shapes:** inverted hull for the base line, optional post crease pass for interior.
- **Hard-surface and buildings:** post edge detection on normals and depth, or `EdgesGeometry` lines. A hull on a cube tears at the corners.
- **A selection highlight, not ink:** `OutlinePass`.
- **Both silhouette and creases, one tool:** post edge detection.

**`OutlinePass` blends additively** (verified in source and in a screenshot: a red edge on a light background washed out to pale pink). Dark ink lines are not possible with it. Use it on dark or mid backgrounds for glow, or use another method for ink.

## 4. Inverted hull

Draw a back-face copy of the mesh pushed outward along the normal. Verified compile and draw. Pushing in clip space, scaled by `w`, gives a constant pixel width at any distance.

```js
const hullMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { uPx: { value: 3 }, uRes: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0x000000) } },
  vertexShader: `
    uniform float uPx; uniform vec2 uRes;
    void main() {
      vec4 c = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      vec3 n = normalize(normalMatrix * normal);
      vec2 d = (projectionMatrix * vec4(n, 0.0)).xy;
      d = length(d) > 1e-5 ? normalize(d) : vec2(0.0);       // screen-space push direction
      c.xy += d * uPx * 2.0 / uRes * c.w;                    // pixels to clip units
      gl_Position = c;
    }`,
  fragmentShader: `uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }`,
});
const hull = new THREE.Mesh(mesh.geometry, hullMat);        // share the geometry, add as a sibling with the same transform
// on resize: hullMat.uniforms.uRes.value.set(drawingBufferWidth, drawingBufferHeight); uPx = cssPx * pixelRatio
```

Rules:
- **Smooth normals for the hull.** On hard-edged geometry (boxes, split normals) the hull vertices at a corner move in different directions and open gaps. Verified with a cube: original normals left gaps and bright dots at corners, `toCreasedNormals(geometry, Math.PI)` gave a continuous outline. Build a separate hull geometry:
```js
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
const hullGeo = toCreasedNormals(mesh.geometry, Math.PI);   // fully smooth, returns non-indexed geometry
```
- **Skinned meshes.** The hull must deform too. Use the same skinning chunks in the hull shader or an `onBeforeCompile` patch (`render-passes-aov` section 3 lists the chunk names). The hull and the mesh must share the same skeleton.
- **Width in pixels** (`uPx`) is constant. For distance-based thinning, multiply `uPx` by a falloff from view depth in the vertex shader.
- **Z-fighting and intersections.** Hull lines do not appear where two meshes intersect. Combine with post edge detection if intersection lines matter.
- **Thin parts.** A hull wider than the part swallows it. Limit `uPx` for thin geometry or per-mesh values.
- `OutlineEffect` implements the same idea by swapping materials. Usage verified to run: `const effect = new OutlineEffect(renderer, { defaultThickness: 0.006, defaultColor: [0, 0, 0] }); effect.render(scene, camera);` in place of `renderer.render`. Per-material overrides go in `material.userData.outlineParameters` (`thickness`, `color`, `alpha`, `visible`, `keepAlive`). Default thickness is 0.003 and its unit is clip space scaled by `w` (source), so line width follows screen height, not CSS pixels, and does not scale with pixel ratio by itself.

## 5. Post-process edge detection

Run an edge filter on normal and linear depth targets from the aux pass in `render-passes-aov` section 3. Verified output: clean silhouettes and creases on a sphere and a torus knot.

```glsl
uniform sampler2D tN, tD; uniform vec2 uTexel; uniform float uNT, uDT; varying vec2 vUv;   // uTexel = 1 / target size, uNT ~ 0.4, uDT ~ 0.05
void main() {
  vec2 o = uTexel;                                                     // scale o by the wanted pixel width
  vec3 n0 = texture2D(tN, vUv).xyz, n1 = texture2D(tN, vUv + o).xyz, n2 = texture2D(tN, vUv + vec2(o.x, 0.)).xyz, n3 = texture2D(tN, vUv + vec2(0., o.y)).xyz;
  float d0 = texture2D(tD, vUv).x, d1 = texture2D(tD, vUv + o).x, d2 = texture2D(tD, vUv + vec2(o.x, 0.)).x, d3 = texture2D(tD, vUv + vec2(0., o.y)).x;
  float en = length(n0 - n1) + length(n2 - n3);                        // Roberts cross on normals
  float ed = abs(d0 - d1) + abs(d2 - d3);                              // and on depth
  float e = max(step(uNT, en), step(uDT * max(d0, 0.1), ed));          // depth threshold relative to distance
  gl_FragColor = vec4(vec3(1. - e), 1.);                               // multiply onto the beauty image
}
```

Rules:
- **Depth threshold relative to depth** (`uDT * d0`), otherwise grazing floors and far objects light up.
- **Normal threshold** picks creases, depth threshold picks silhouettes and object borders. Add an ID target (`render-passes-aov`) for borders between two touching objects of similar normal and depth.
- **Line width** = sample offset in pixels. Multiply `uTexel` by the width, and by the pixel ratio for a stable look across screens. Widths above about 2 px sample too far apart, switch to a dilate pass or the hull.
- **Binary edges alias.** Replace `step` with `smoothstep` over the gradient magnitude to soften, then keep SMAA after `OutputPass` (`antialiasing-resolution` section 3). Aux targets stay non-MSAA, so the lines inherit their pixel grid.
- **Run at full resolution** for crisp lines, half resolution is visibly soft.
- **Order:** composite lines onto the HDR image before bloom and `OutputPass`, or after `OutputPass` if the lines must stay pure black (`post-processing-stack`).

## 6. Consistent line width

| Method | What stays constant | Check on |
|---|---|---|
| Hull, clip-space (section 4) | Pixels | Distance, pixel ratio via `uPx * ratio` |
| Hull, world-space push | World units, so lines thin with distance (useful for depth cueing) | Close and far |
| `OutlineEffect` | Screen-height fraction | Window size, pixel ratio |
| Post edges | Pixels via the sample offset | Pixel ratio |

Rules: pick one width rule per project and state it. Thin lines below about 1.5 px flicker while orbiting (`antialiasing-resolution` thin lines rule), so use 2 px as the floor at pixel ratio 1.

## 7. Cost per tier

Starting guesses, tune against `performance-budget` and `render-qa --gpu`.

| Tier | Shading | Lines | Notes |
|---|---|---|---|
| low (phones, iGPU) | `MeshToonMaterial`, no extra patches | Hull on up to about 5 hero meshes, or lines baked into the texture | No aux pass, no post lines |
| mid (laptops) | Toon plus rim patch | Hull on all outlined meshes | Aux pass only if post lines are the style |
| high (desktop dGPU) | Toon, rim, halftone patch | Hull plus post crease lines from the shared aux pass | SMAA after `OutputPass` |

Cost model: a hull is 2x the vertex work and one more draw per mesh. Post lines cost one aux geometry pass (shared with any other AOV consumer) and one fullscreen pass, scaling with pixels. `OutlineEffect` doubles draw calls. Check `renderer.info.render.calls` before and after (`performance-budget` section 1).

## 8. Verify

1. `render-qa` at four angles plus the phone shot, and a low-tier run (`--query tier=low`).
2. **100 percent crops** of: a silhouette against a bright background, against a dark one, a concave junction, a hard corner (cube corners must not show gaps), a thin part (finger, cable), a far object.
3. **Width consistency:** screenshot near and far. A pixel-width hull must measure the same in both. Measure by counting dark pixels across the line in the crop.
4. **Pixel ratio:** capture at ratio 1 and 2. The line should look the same thickness relative to the object. If it halves at ratio 2, the width lacks the pixel ratio factor.
5. **Shimmer:** orbit by 0.25 degree steps and compare frames with the script in `antialiasing-resolution` section 7. Lines must not crawl or pop on and off.
6. **Light and dark background:** black ink disappears on dark backgrounds, switch the line colour per theme.
7. **Transparency and cutouts:** check that hair cards, glass and alpha-tested leaves outline sensibly. Hull and edge passes ignore alpha unless you copy it in.
8. Report calls and triangles against the tier budget. Max 3 fix loops (`render-qa` rule), then list what remains.
