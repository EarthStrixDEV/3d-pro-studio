---
name: gltf-asset-pipeline
description: Production asset pipeline for glTF/GLB in Three.js — inspecting, validating, optimizing and compressing models (Draco, Meshopt, KTX2/Basis, WebP), simplifying, instancing, texture resizing with the gltf-transform CLI, plus correct loader setup (GLTFLoader + DRACOLoader + KTX2Loader + MeshoptDecoder), scale/orientation conventions and post-load material fixes. Use when importing models, when a GLB is too big or slow, when models load black/dark/wrong scale, or when preparing assets for web delivery.
---

# glTF Asset Pipeline

## 1. Inspect before you touch

```bash
npx @gltf-transform/cli inspect model.glb      # meshes, materials, textures, sizes, draw calls
npx @gltf-transform/cli validate model.glb     # Khronos validator: errors must be zero
```
Read the texture table first — texture size is usually the problem, not geometry.

## 2. Optimize (verified with @gltf-transform/cli 4.x)

One-shot, good default:
```bash
npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp --texture-size 2048
```
- `--compress draco|meshopt|quantize|false` — Meshopt decodes faster and also compresses animation; Draco gives slightly smaller static meshes.
- `--texture-compress ktx2|webp|avif|auto|false` — **KTX2 is the only one that saves GPU memory**; it needs KTX-Software (`ktx`/`toktx`) installed on the machine. WebP/AVIF only shrink the download.
- `--simplify --simplify-ratio 0.5 --simplify-error 0.001` — decimate; check silhouettes afterwards.
- `--instance true` turns repeated meshes into `EXT_mesh_gpu_instancing`; `--join true` merges to cut draw calls.

Granular commands when you need control:
```bash
npx @gltf-transform/cli dedup in.glb a.glb
npx @gltf-transform/cli prune a.glb b.glb
npx @gltf-transform/cli weld b.glb c.glb
npx @gltf-transform/cli simplify c.glb d.glb --ratio 0.5 --error 0.001
npx @gltf-transform/cli resize d.glb e.glb --width 2048 --height 2048
npx @gltf-transform/cli uastc e.glb f.glb --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture}"   # high quality for data maps
npx @gltf-transform/cli etc1s f.glb g.glb --slots "{baseColorTexture,emissiveTexture}"                           # small for colour maps
npx @gltf-transform/cli meshopt g.glb out.glb
npx @gltf-transform/cli center out.glb out.glb --pivot below   # origin at base centre
```
Other useful: `tangents` (for anisotropy/normal maps without tangents), `palette`, `flatten`, `resample` (animation), `unlit`.

## 3. Loader setup (Three.js)

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const THREE_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0';       // same version as the import map
const draco = new DRACOLoader().setDecoderPath(`${THREE_PATH}/examples/jsm/libs/draco/gltf/`);
const ktx2 = new KTX2Loader().setTranscoderPath(`${THREE_PATH}/examples/jsm/libs/basis/`).detectSupport(renderer);
const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

const gltf = await loader.loadAsync('model.glb', (e) => progress(e.loaded / e.total));
```
Set `window.__sceneReady = true` only after the model is added and `await renderer.compileAsync(scene, camera)` resolves.

## 4. Post-load normalisation

```js
const root = gltf.scene;
const box = new THREE.Box3().setFromObject(root);
const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
root.position.sub(center).y += size.y / 2;                // sit on y = 0
root.scale.setScalar(TARGET_HEIGHT / size.y);             // normalise scale
root.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = o.receiveShadow = true;
  const m = o.material;
  if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
  m.envMapIntensity ??= 1;
});
```
- glTF is metres, +Y up, front faces −Z → +Z facing camera may need `rotation.y = Math.PI`.
- GLTFLoader already sets correct texture colour spaces — don't override them.
- Model looks black → no `scene.environment` / lights, or `metalness: 1` with no env. Looks too dark → emissive missing or env intensity too low. Faceted → normals missing/flat: `geometry.computeVertexNormals()` after `mergeVertices`.

## 5. Delivery

- Serve `.glb` with `model/gltf-binary`, gzip/brotli at the CDN, long cache headers with hashed filenames.
- Show a real progress indicator; reveal with an intro move only when ready.
- Keep a budget per asset: hero ≤ 5 MB, props ≤ 500 KB each after compression.
