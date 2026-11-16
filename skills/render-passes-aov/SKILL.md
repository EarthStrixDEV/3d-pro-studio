---
name: render-passes-aov
description: Render passes and AOVs for Three.js, translating Maya Arnold AOVs and Blender render passes (depth, normal, position, object ID, emission, AO, motion vectors) into WebGL2 multiple render targets with a WebGPU route, plus debug view modes (normals, depth, UVs, overdraw, wireframe, ID), exporting passes for compositing, and feeding them to render-qa. Use when a post effect needs depth or normals, outlines or masks need object IDs, a pass must be exported to Nuke, After Effects or Blender compositor, a shading problem needs a normal, UV or overdraw view, or when asked for AOVs, render passes, multiple render targets, G-buffer, motion vectors or depth maps. Thai triggers เรนเดอร์พาส, พาสแยกชั้น, depth map, normal pass, ID mask, ภาพแยกเลเยอร์สำหรับคอมโพสิต, มุมมองดีบัก, ตรวจ UV.
argument-hint: "<which passes, what consumes them (post effect, compositor, QA), and target device tier>"
---

# Render Passes & AOV

An AOV is one extra image the renderer writes next to the beauty image. In Three.js the practical form is one auxiliary geometry pass that writes several attachments at once (WebGL2 multiple render targets, MRT), and a set of debug override materials. Budgets live in `performance-budget`, post chain in `post-processing-stack`, the QA runner in `render-qa`.

Status: the MRT sample, per-object ID, motion vector, edge detection and debug overrides were run in a headless browser on three r187 (WebGL2). The WebGPU TSL route was not run (verify). Blender and Arnold names are from memory (verify).

## 1. Pass map

| Blender pass | Arnold AOV | Three.js source | Storage |
|---|---|---|---|
| Combined | beauty (RGBA) | Normal scene render | 8 bit or HalfFloat |
| Depth (Z) | `Z` | View-space z written by the aux pass, or a depth texture | Float. Never 8 bit |
| Normal | `N` | Aux pass, view or world space (choose and label it) | HalfFloat, or 8 bit encoded `n * 0.5 + 0.5` |
| Position | `P` | World position in the aux pass | Float |
| Object Index, Material Index | `id`, Cryptomatte (verify) | Aux pass with a per-object id uniform | 8 bit RGBA, exact, no filtering |
| Emission | `emission` | Re-render with emissive-only materials (section 5) | HalfFloat |
| AO | `ao` or AO shader | `GTAOPass` with `output = GTAOPass.OUTPUT.AO` for a view, or a baked map (`texture-baking-pipeline`) | 8 bit |
| Vector (motion) | `motionvector` | Aux pass with previous matrices (section 4) | HalfFloat, pixels or NDC delta |
| UV | UV AOV (verify) | Debug override (section 6) | 8 bit or Half |

Rules:
- **Pick the space and say it.** Blender Normal and Position passes are world space (verify), `MeshNormalMaterial` is view space. A compositor expects one or the other, mixing them gives rotated colours.
- **Never 8 bit for depth.** Banding quantises to 256 steps across the whole range.
- **Passes are data, not colour.** No tone mapping, no sRGB encode. `ShaderMaterial` output is raw as long as you do not include `colorspace_fragment`.

## 2. Choose the route

| Route | Geometry passes | Use when |
|---|---|---|
| Override material, one pass per AOV | 1 per AOV | One or two passes, simplest code, debug views |
| MRT aux pass (section 3) | 1 for all AOVs | Edge detection, SSAO-like effects, ID masks, motion vectors. Default |
| Beauty and AOVs in one pass | 1 | Not practical with PBR built-ins (they write only attachment 0). Needs patched shaders (verify) |
| WebGPU `pass().setMRT(mrt({...}))` (section 7) | 1 | `WebGPURenderer` projects |

Cost: the aux pass redraws the visible geometry once. On low tier, half-resolution targets (`performance-budget`) or no passes at all.

## 3. MRT aux pass (WebGL2)

Verified: four readbacks matched. Sphere ID `[1, 0, 0, 255]`, normal `[0.67, 0.5, 0.97]`, view depth `4.21` against a surface about `4.30` away, background ID `0`.

```js
const mrt = new THREE.WebGLRenderTarget(w, h, {
  count: 3,                                   // replaced WebGLMultipleRenderTargets in recent revisions (verify yours)
  type: THREE.HalfFloatType,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  depthBuffer: true,                          // samples stays 0, MSAA would blend ids and normals
});
mrt.textures[0].name = 'normal'; mrt.textures[1].name = 'depth'; mrt.textures[2].name = 'id';
mrt.textures[2].type = THREE.UnsignedByteType;          // exact bytes for ids, set per attachment before first use

const aov = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uId: { value: 0 } },
  vertexShader: `
    out vec3 vN; out float vZ;
    void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `
    uniform float uId; in vec3 vN; in float vZ;
    layout(location = 0) out vec4 oNormal;
    layout(location = 1) out vec4 oDepth;
    layout(location = 2) out vec4 oId;
    void main() {
      oNormal = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
      oDepth  = vec4(vZ, 0.0, 0.0, 1.0);
      oId     = vec4(mod(uId, 256.0) / 255.0, floor(uId / 256.0) / 255.0, 0.0, 1.0);   // 16 bit id in R and G
    }`,
});

// per-object id: onBeforeRender runs with the override material, uniformsNeedUpdate forces the upload
let nextId = 1;
scene.traverse((o) => { if (o.isMesh) { const id = nextId++; o.userData.aovId = id;
  o.onBeforeRender = () => { aov.uniforms.uId.value = id; aov.uniformsNeedUpdate = true; }; } });

function renderAOV(scene, camera) {
  const bg = scene.background; scene.background = null;
  scene.overrideMaterial = aov;
  renderer.setRenderTarget(mrt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
  scene.overrideMaterial = null; scene.background = bg; renderer.setRenderTarget(null);
}
```

Read a pixel back: `renderer.readRenderTargetPixels(rt, x, y, 1, 1, buffer, undefined, textureIndex)`. Half-float buffers are `Uint16Array` and need a half-to-float decode on the CPU. Use `FloatType` (needs `EXT_color_buffer_float`, check `renderer.extensions.has('EXT_color_buffer_float')`) when you want plain numbers.

Rules:
- **ID 0 is background.** Start ids at 1.
- **No MSAA on the aux target.** Averaged ids and normals are invalid values. Edge pixels of an ID pass stay aliased by design.
- **Skinned, morphed and instanced meshes.** A bare `ShaderMaterial` override does not skin or morph, so the pass shows the bind pose. Add the skinning and morph chunks (`skinbase_vertex`, `skinning_pars_vertex`, `skinning_vertex`, `skinnormal_vertex`, `morphtarget_pars_vertex`, `morphtarget_vertex`, chunk names listed in the r187 source, wiring not run) or use built-in `MeshNormalMaterial` and `MeshDepthMaterial` which handle them.
- **Cutouts and transparency.** An override ignores `alphaTest` and alpha maps, so a leaf card writes a full quad. Copy `map` and `alphaTest` into the aov material and `discard` below the threshold (verify the chunk wiring). Transparent glass writes nothing meaningful: decide per object whether it belongs in ID and depth, or hide it with a layer.
- **Reuse.** The same target feeds outlines (`npr-toon-outline`), soft particles, fog (`volumetrics-atmosphere`), DOF and SSAO. Render it once per frame, share it.
- **Resize** the target with the canvas, and dispose it on teardown (`performance-budget` section 6).

## 4. Motion vectors

Three core ships no velocity buffer for the WebGL composer (verify, see `antialiasing-resolution` section 4). Build it per object from the previous frame's model-view-projection. Verified: a plane moved 0.2 world units right produced x `0.0535` against `0.0534` expected, y `0`. Works for rigid objects with a static or moving camera. Skinned and morph motion needs the previous pose (not covered).

```js
const motion = new THREE.ShaderMaterial({
  uniforms: { uPrev: { value: new THREE.Matrix4() } },
  vertexShader: `uniform mat4 uPrev; varying vec4 vCur, vOld;
    void main() { vCur = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vOld = uPrev * vec4(position, 1.0); gl_Position = vCur; }`,
  fragmentShader: `varying vec4 vCur, vOld;
    void main() { gl_FragColor = vec4((vCur.xy / vCur.w - vOld.xy / vOld.w) * 0.5, 0.0, 1.0); }`,   // UV-space delta, +x right, +y up
});
const prevMVP = new WeakMap();      // object -> Matrix4 from the last frame
mesh.onBeforeRender = (r, s, camera) => {
  const prev = prevMVP.get(mesh) ?? new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
  motion.uniforms.uPrev.value.copy(prev); motion.uniformsNeedUpdate = true;
};
// after the frame: prevMVP.set(mesh, new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld));
```

Rules:
- **Update the previous matrix after rendering**, not before, or the delta is always zero.
- **Remove TAA jitter** from both matrices before computing the delta (`antialiasing-resolution` section 4), otherwise vectors carry sub-pixel noise.
- **Units.** This writes NDC/2 (UV space). Multiply by the resolution for pixels, flip y if your compositor expects image-space y down. Blender's Vector pass unit and sign convention: verify against a known move before using the file.

## 5. Emission and other re-render passes

For passes that depend on the beauty material, swap materials and render the target once (sample not run, plain API):

```js
const swapped = new Map(), emitMats = new WeakMap();
function emissivePass(scene, camera, target) {
  scene.traverse((o) => { if (!o.isMesh) return;
    let m = emitMats.get(o.material);
    if (!m) { m = new THREE.MeshBasicMaterial({ color: o.material.emissive ? o.material.emissive.clone().multiplyScalar(o.material.emissiveIntensity ?? 1) : 0x000000, map: o.material.emissiveMap ?? null }); emitMats.set(o.material, m); }
    swapped.set(o, o.material); o.material = m; });
  renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(null);
  swapped.forEach((mat, o) => { o.material = mat; }); swapped.clear();
}
```

Use `HalfFloatType` so emissive values above 1 survive (bloom threshold tuning in `post-processing-stack`). Cache the swapped materials, never create them per frame.

## 6. Debug view modes

| Mode | Technique | Reads as |
|---|---|---|
| Normals | `scene.overrideMaterial = new THREE.MeshNormalMaterial()` | Smooth gradients. Faceted blotches mean missing or flat normals |
| Depth | `MeshDepthMaterial` override, or the linear depth from section 3 | Near dark, far light. Banding means low precision |
| UVs | `ShaderMaterial` writing `vec4(fract(vUv), 0.0, 1.0)` | Stretching, mirrored or overlapping islands |
| Overdraw | `MeshBasicMaterial({ color: 0x220800, blending: AdditiveBlending, transparent: true, depthTest: false, depthWrite: false })` | Brighter means more layers drawn per pixel |
| Wireframe | `MeshBasicMaterial({ wireframe: true })` override | Triangle density, slivers |
| ID | Section 3 target, scaled for the eye | One flat colour per object |
| AO only | `gtaoPass.output = GTAOPass.OUTPUT.AO` | Contact darkening alone |

All override materials above compile and draw (verified, r187). Switching the mode:

```js
const VIEWS = { normal: new THREE.MeshNormalMaterial(), depth: new THREE.MeshDepthMaterial(), uv: uvMat, overdraw: overdrawMat, wire: wireMat };
function setView(mode) {
  scene.overrideMaterial = VIEWS[mode] ?? null;                 // null is the normal beauty render
  scene.background = mode ? null : savedBackground;             // otherwise the background tints every mode
  renderer.toneMapping = mode ? THREE.NoToneMapping : savedToneMapping;
}
const mode = new URLSearchParams(location.search).get('view'); if (mode) setView(mode);
```

Rules: hide helpers, lines and sprites that the override would redraw (use a layer). Overrides do not skin, see section 3. Keep this tooling behind `?view=` and out of the shipped build.

## 7. WebGPU route (not run, verify)

From the r187 source docs, `PassNode.setMRT`, `mrt`, `normalView`, `velocity`, `getTextureNode` and `getLinearDepthNode` exist. Confirm node names against your revision, TSL moves between releases (`shader-craft` section 4).

```js
import { pass, mrt, output, normalView, velocity } from 'three/tsl';
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: normalView, velocity }));    // attachment names are your keys
const normalTex = scenePass.getTextureNode('normal');
const depthTex = scenePass.getLinearDepthNode();
// call await scenePass.compileAsync(renderer) after configuring, then build the post chain from these nodes
```

`WebGPURenderer` falls back to WebGL2 when WebGPU is missing, so keep section 3 as the baseline on pages that must run everywhere.

## 8. Export for compositing

| Pass | Format | Notes |
|---|---|---|
| Beauty | PNG 8 bit, or EXR if graded later | `renderer.domElement.toBlob` |
| Depth, position, motion | EXR half or float | `EXRExporter` from `three/addons/exporters/EXRExporter.js`. It takes `(renderer, renderTarget, options)`. Option names and which MRT attachment it reads were not checked (verify), a single-attachment target is the safe input |
| Normal | EXR, or PNG 8 bit encoded | Document the space and the `n * 0.5 + 0.5` encoding |
| ID | PNG 8 bit, no colour management | Decode `id = r + g * 256`. Not anti-aliased: render 2x size and take nearest, or use it only as a mask |

Rules:
- **Same camera, same size for all passes**, and name files like Blender passes (`beauty`, `depth`, `normal`, `objectid`, `vector`) so a compositor template maps them.
- **Render deterministically** for export: freeze time, set `window.__sceneReady` after the last frame, no adaptive resolution.
- **Cryptomatte is not implemented here.** An ID pass has no coverage, so edges are hard.

## 9. Verify with `render-qa`

The checker accepts `--query`, so run one capture per view and compare:

```bash
for v in normal depth uv overdraw wire; do
  node <skill-dir>/scripts/render-check.mjs scene.html --out qa-$v --query "view=$v" --angles 2 --no-mobile
done
```

Expect `render-qa` rubric warnings about materials and tone mapping on debug views, they are false positives for override modes. Then check:

1. **Normals:** all pixels with alpha have a length near 1 (decode `n * 2 - 1`), no flipped faces on closed meshes.
2. **Depth:** monotonic from the camera, no all-zero image, far plane not clipping the hero.
3. **ID:** the number of distinct ids equals the number of meshes you tagged, background is 0.
4. **Motion:** zero everywhere with a still camera, uniform when only the camera moves.
5. **UV:** checker or gradient is uniform on islands that should be, no overlap on islands that must be unique (`uv-unwrap-packing`).
6. **Overdraw:** hotspots sit on particles, glass or foliage cards, not on opaque props.
7. Within budget: aux pass counted in draw calls and triangles per `performance-budget`. If a pass pushes the low tier over, drop it there.
