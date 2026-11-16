---
name: color-management-grading
description: Colour management and grading for Three.js, translating Blender colour management (view transforms Standard, Filmic, AgX, Khronos PBR Neutral, looks, exposure, gamma) and OCIO or ACES concepts to the web. Covers working space versus display space, ColorManagement and outputColorSpace, picking a tone mapper, matching colour between a DCC tool and the browser, wide gamut (Display P3), lift gamma gain and ASC CDL, authoring and exporting a .cube LUT, where grading sits in the chain, and HDR display notes. Use when colours differ between Blender or Maya and the browser, the render looks washed out or too saturated, whites turn grey, exposure or contrast needs matching to a reference, a LUT or colour grade must be built, or when asked about colour space, ACES, AgX, Filmic, gamma or tone mapping. Thai triggers สีไม่ตรงกับ Blender, สีจืด, สีซีด, โทนสี, เกรดสี, ปรับสี, ค่าแสง, ตารางสี LUT.
argument-hint: "<reference render or tool, and how the browser result differs>"
---

# Colour Management & Grading

Colour is a chain: scene-linear light, a view transform (tone mapping), display encoding, then optional grade. Most mismatches are one link applied twice, skipped, or tagged wrongly. Tone mapper choice for the look is in `lighting-ibl-shadows`, pass order in `post-processing-stack`. This skill covers matching, the maths and LUT authoring.

Status: the samples below were run in a headless browser on three r187 (`ColorManagement`, P3, fog colour, composer chain, LUT) and in node (`.cube` writer read back by `LUTCubeLoader`). Blender setting names and OCIO tools were not run, so they carry `(verify)`. Repo templates pin an older three, check addon import paths against your revision.

## 1. The chain

```
textures (sRGB tag) --> linear working space --> lighting maths --> view transform --> display encoding --> grade (optional)
   Color management         ColorManagement         light, env         toneMapping        outputColorSpace       LUTPass
```

| Link | Blender | Three.js |
|---|---|---|
| Working space | Linear Rec.709 by default (verify) | `THREE.ColorManagement.workingColorSpace`, default `LinearSRGBColorSpace` (r187 source) |
| Texture decode | Image colour space: sRGB or Non-Color | `texture.colorSpace = SRGBColorSpace` for colour, `NoColorSpace` for data. GLTFLoader does this |
| View transform | Standard, Filmic, AgX, Khronos PBR Neutral, False Color, Raw (verify list in your version) | `renderer.toneMapping` |
| Exposure | Stops (EV) | `renderer.toneMappingExposure`, a linear multiplier |
| Display encoding | Display device sRGB | `renderer.outputColorSpace = SRGBColorSpace` |
| Look | Per view transform look list (verify) | A grade pass or LUT |
| Gamma | Extra power after the transform (verify direction) | None. Put it in the grade pass |

## 2. Tone mapper equivalents

| Blender view transform | Three.js | Match quality |
|---|---|---|
| Standard | `NoToneMapping` | Exact, sRGB encode only. Highlights clip at 1 |
| Khronos PBR Neutral | `NeutralToneMapping` | Same algorithm family. Best for brand colours |
| AgX | `AgXToneMapping` | Close, not identical. Three's code is based on Filament's AgX (source comment), Blender ships its own OCIO config and looks (verify) |
| Filmic | none | No equivalent. Use AgX or a LUT sampled from Filmic |
| ACES (OCIO config) | `ACESFilmicToneMapping` | Approximate only. Three's is a modified fit tuned for a brighter viewing environment (source comment), not the full OCIO RRT and ODT |
| Raw | `NoToneMapping` with grading off | Data inspection only |

Verified in the r187 source, both are common surprises:
- **`toneMappingExposure` does nothing with `NoToneMapping`.** The exposure uniform is only compiled into the tone mapping chunk. If a Standard-transform match ignores your exposure, apply it yourself (section 3).
- **`LinearToneMapping` clamps to 0..1** (`saturate(exposure * color)`), so it is exposure plus a hard clip, not a neutral pass.

Blender Exposure is in stops: `renderer.toneMappingExposure = 2 ** blenderExposureEV`.

Choice rule: pick by what must stay true. Brand or product colours: Neutral. Cinematic highlights and bright emissives: AgX. Punchy game look: ACES. Exactly matching a Blender render: use the same view transform in both and compare numbers (section 7), never by eye.

## 3. Match a DCC render to the browser

Work down this list, stop at the first mismatch.

1. **Same lights and units.** Blender watts versus Three.js candela and lux are different scales. Calibrate by a white furnace test and key-to-fill ratio, details in `raytracing-light-transport` section 3. Exposure last.
2. **Same view transform and exposure.** Table in section 2.
3. **Texture tags.** Colour sRGB, data Non-Color. `render-qa` flags violations.
4. **Vertex colours and emissive colours** in glTF are linear. A Blender colour attribute shown in sRGB looks different once exported (verify per exporter version).
5. **No double tone mapping.** With `EffectComposer`, `OutputPass` tone maps. Do not also set a mapper on materials or add a second pass (`post-processing-stack`).
6. **Fog colour is display-referred.** Verified in the r187 source: `fog_fragment` runs after tone mapping and colour-space conversion, and three converts `scene.fog.color` into the output space for you. A custom fog patch must do the same. Passing a plain `THREE.Color` uniform shifts the fog colour. This works (flat test returned exactly 170, 184, 200 for `#aab8c8`):

```js
const fogRGB = new THREE.Color('#aab8c8').getRGB(new THREE.Color(), renderer.outputColorSpace);
// uniform vec3 uFogColor = fogRGB, mixed into gl_FragColor.rgb after <fog_fragment>
```

7. **Background versus page CSS.** A flat `scene.background` colour should read back as the CSS hex. Sample one pixel of a screenshot and compare. A mismatch means tone mapping or a wrong output space is active.
8. **Exposure with `NoToneMapping`:** multiply by hand in the grade pass if you need it.

## 4. Working space and wide gamut

Default is Rec.709 primaries (sRGB) end to end. Switch to Display P3 only when the brief needs saturated colours outside sRGB and the audience has P3 screens.

```js
import { DisplayP3ColorSpace, LinearDisplayP3ColorSpace, DisplayP3ColorSpaceImpl, LinearDisplayP3ColorSpaceImpl }
  from 'three/addons/math/ColorSpaces.js';          // in r187. Older revisions may export them from core: check yours
THREE.ColorManagement.define({
  [DisplayP3ColorSpace]: DisplayP3ColorSpaceImpl,
  [LinearDisplayP3ColorSpace]: LinearDisplayP3ColorSpaceImpl,
});
THREE.ColorManagement.workingColorSpace = LinearDisplayP3ColorSpace;
renderer.outputColorSpace = DisplayP3ColorSpace;     // sets gl.drawingBufferColorSpace to 'display-p3' (verified)
```

Verified: working space switched to `display-p3-linear`, the drawing buffer reported `display-p3`, and `#ff0000` became `[0.822, 0.033, 0.017]` in the P3 linear space, as expected for sRGB red.

Rules:
- Set the working space **before** creating colours, materials and loading textures. Anything created earlier keeps sRGB-linear values.
- Detect support: `matchMedia('(color-gamut: p3)').matches`. Fall back to sRGB, do not ship P3 to an sRGB screen.
- Three's AgX and ACES matrices assume Rec.709 linear input. With a P3 working space the tone mapper behaviour is untested here (verify by sampling saturated patches).
- Blender and most DCC tools author in Rec.709. Convert authored assets rather than relabelling them.

## 5. OCIO and ACES in one page

OpenColorIO is a config that lists colour spaces and transforms between them. ACES is one such config: scene-referred AP0 or AP1 primaries, then a Reference Rendering Transform and an Output Device Transform to the display. Blender can load an OCIO config (verify settings path), Maya does through its colour management preferences.

Three.js has no OCIO runtime. Options, cheapest first:
1. **Use the closest built-in mapper** (section 2) and accept a small difference.
2. **Bake the OCIO transform into a 3D LUT** (the OCIO command line tool `ociobakelut` writes LUT files, verify format flags) and apply it with `LUTPass` after `OutputPass` with the renderer set to `NoToneMapping`. The LUT then owns the whole view transform. Input must be scene-linear clamped to the LUT domain, so high-range scenes need a shaper (verify) or exposure control first.
3. **Do not hand-copy ACES matrices into shaders** unless you can verify them against a reference image.

## 6. Grading

### Where it goes

| Place | Input space | Use for | Cost |
|---|---|---|---|
| ShaderPass **before** `OutputPass` | Scene-linear HDR | Exposure, white balance, CDL that must behave like Blender's compositor Color Balance (verify its space). Interacts with the tone mapper | One fullscreen pass |
| `LUTPass` **after** `OutputPass` | Display-referred sRGB | A look the viewer sees. What you grade in a tool is what you get | One fullscreen pass plus a 3D texture |

Chain verified in a headless browser: `RenderPass` then CDL `ShaderPass`, `OutputPass`, `LUTPass`. An identity LUT left the pixel unchanged (127 to 127), a warm LUT (R x1.2, B x0.8) gave 153, 127, 102 as defined, and slope 2 in linear gave 175 against 176 expected from the formula (rounding).

### Lift, gamma, gain and ASC CDL

ASC CDL is the portable one, three numbers per channel plus saturation:

```
out = clamp( (in * slope + offset) ^ power )          per channel
luma = 0.2126 r + 0.7152 g + 0.0722 b                 Rec.709
out = luma + (out - luma) * saturation
```

| Control | Effect | CDL term | Typical range |
|---|---|---|---|
| Gain (highlights) | Scales | slope | 0.9 to 1.1 |
| Lift (shadows) | Raises blacks | offset | -0.02 to 0.03 |
| Gamma (mids) | Bends mids | power, as `1 / gamma` | 0.9 to 1.1 |
| Saturation | Colour intensity | sat | 0.8 to 1.2 |

Lift, gamma, gain formulas differ between tools. When matching one, convert numbers to CDL first, and test with a grey ramp.

```glsl
// ShaderPass fragment, CDL on whatever space the pass sits in
uniform sampler2D tDiffuse; uniform vec3 slope, offset, power; uniform float sat; varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec3 x = pow(max(c.rgb * slope + offset, 0.0), power);     // max() guards negative HDR values
  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(mix(vec3(l), x, sat), c.a);
}
```

Rules:
- Grade towards the brief palette, not away from accurate materials (`post-processing-stack`).
- Keep slope and power deviations small (under 10 percent). Large pushes clip and band.
- Clip warning: values above 1 after the grade are clamped by 8-bit output, check highlights in the crops.

### Author a LUT and export `.cube`

A `.cube` file is a 3D table: `LUT_3D_SIZE n`, then n^3 lines of `r g b`, red index varying fastest. Verified: this node script writes a CDL grade, `LUTCubeLoader.parse` reads it, and a sampled texel matched the function within 8-bit rounding (0.3098 vs 0.3128).

```js
import { writeFileSync } from 'node:fs';
const LUMA = [0.2126, 0.7152, 0.0722];
const cdl = { slope: [1.05, 1.0, 0.95], offset: [0, 0, 0.01], power: [1, 1, 1], sat: 1.1 };
function grade(rgb) {
  const c = rgb.map((v, i) => Math.pow(Math.max(v * cdl.slope[i] + cdl.offset[i], 0), cdl.power[i]));
  const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  return c.map((v) => Math.min(Math.max(l + (v - l) * cdl.sat, 0), 1));
}
function writeCube(path, size, fn, title = 'grade') {
  const rows = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++)
    rows.push(fn([r, g, b].map((i) => i / (size - 1))).map((v) => v.toFixed(6)).join(' '));
  writeFileSync(path, rows.join('\n') + '\n');
}
writeCube('grade.cube', 33, grade);
```

Load and apply:

```js
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
const lut = await new LUTCubeLoader().loadAsync('grade.cube');   // { title, size, texture3D }
const pass = new LUTPass({ lut: lut.texture3D, intensity: 0.8 });
composer.addPass(pass);                                           // after OutputPass
```

Sizes: 17 for a subtle grade, 33 default, 64 for strong or non-smooth looks. Memory is trivial (33^3 x 4 bytes is about 144 KB). The loader returns 8-bit by default, `setType(THREE.FloatType)` is the float option, and linear filtering of float 3D textures needs hardware support (verify extension).

Other authoring routes:
- **DaVinci Resolve** or any grading tool that exports `.cube`: grade a reference frame, export a 33 point LUT. Grade in display space to match the post-OutputPass slot.
- **Blender:** no `.cube` export (verify). The compositor Color Balance node has Lift, Gamma, Gain and an Offset, Power, Slope (CDL) mode (verify). Copy its numbers into the CDL script above, and expect them to behave in scene-linear space, so apply them in the ShaderPass before `OutputPass` for a numeric match, or accept a stylistic difference after.
- **Match a reference by sampling:** render a grey ramp and six saturated patches in both tools, read values, fit slope, offset, power per channel.

## 7. Verify numerically

1. Render a test chart in both tools with the same view transform: 11-step grey ramp, plus red, green, blue, cyan, magenta, yellow patches at 0.5 intensity.
2. Read patch values in the browser (`render-qa` screenshot, or `gl.readPixels` right after render with `preserveDrawingBuffer: true`).
3. Standard or Neutral: patches within about 3 of 255. AgX or ACES: expect small hue differences, look for hue direction and highlight roll-off, not equality.
4. White must read near 255 only if the exposure intends it. Grey ramp must be monotonic with no flat steps (clipping) and no banding.
5. Check light and dark backgrounds (`render-qa` rubric 5 and 9).
6. Confirm one tone mapper is active: `renderer.toneMapping` set once, composer ends in `OutputPass`.
7. If the grade pushes a gradient, inspect it at 100 percent for banding and add grain (`post-processing-stack` section 6).

## 8. HDR display notes (verify before promising)

- Everything above is SDR: tone mappers compress to 0..1 for a standard display. Do not describe it as HDR output.
- Detect screens: `matchMedia('(dynamic-range: high)').matches` and `matchMedia('(color-gamut: p3)').matches` are standard CSS media features.
- In r187, `WebGPURenderer` accepts an `outputType` option. With `HalfFloatType` its canvas switches to the `extended` tone mapping mode (read from `WebGPUBackend.js`). Browser, OS and display support, and how to author highlights above 1 for it, were not tested (verify).
- `ExtendedSRGBColorSpace` exists in `three/addons/math/ColorSpaces.js` (listing checked, behaviour not tested).
- A real HDR pipeline also needs HDR-safe grading, no 8-bit clamps in post and a fallback. Treat it as a separate project, default to SDR.
