---
name: scene-assembly-prefabs
description: Scene assembly, prefabs and asset libraries for Three.js, translating Maya references and Blender collections, collection instances and linked libraries into a web workflow. Covers prefab design, the Object3D.clone pitfalls (shared geometry and materials, userData deep copy, lost material patches, SkeletonUtils.clone for skinned meshes), choosing clone versus InstancedMesh, an asset manifest JSON, a reference-counted asset library with lazy loading and dedupe, copy-on-write per-instance overrides, naming conventions that survive glTF export, scene graph hygiene and audit, JSON scene serialization and correct disposal. Use when building a level or product configurator from reusable assets, when many copies of a model are needed, when clones share state unexpectedly, when skinned clones animate together, when loading many glTF files, or when memory climbs after removing objects. Thai triggers ประกอบฉาก, prefab, คัดลอกโมเดล, clone แล้วสีเปลี่ยนทุกตัว, ไลบรารีแอสเซท, โหลดแบบ lazy, ล้างหน่วยความจำ.
argument-hint: "<the assets to reuse, how many copies, and whether they animate or change per copy>"
---

# Scene Assembly & Prefabs

A scene is an assembly of reusable assets, not a pile of unique models. Load each asset once, instance it cheaply, change only what differs, and free it when the last copy goes. Delivery format and compression are in `gltf-asset-pipeline`.

## 1. DCC concepts to Three.js

| Maya or Blender | Three.js equivalent | Rule |
|---|---|---|
| Maya reference, Blender linked library | A glTF file listed in the manifest, loaded once | The file is the single source. Never edit a copy |
| Blender collection, Maya group or assembly | A prefab: a detached `Object3D` template | Never add the template to the scene. Add clones |
| Blender collection instance, Maya reference instance | `instantiate` (clone sharing geometry and materials), or `InstancedMesh` for many | Section 2 |
| Maya reference edits, Blender library overrides | A list of per-instance overrides (section 7) | Stored as data, replayed on load |
| Blender Make Local, Make Single User | Copy on write: clone a material or geometry for one instance only | Only when an override needs it |
| Blender asset browser catalogs and tags, Maya namespaces | Manifest `tags` and unique asset ids | Section 4 |
| Blender Apply Transforms, Maya Freeze Transformations | Apply in the DCC before export | Scale 1, rotation 0 on the prefab root, pivot at the logical origin |

## 2. Pick the instancing method

| Copies | Per-copy change | Animated | Use |
|---|---|---|---|
| 1 to about 30 | Transform and a few overrides | Yes or no | **Clone** with shared geometry and materials (section 3) |
| 30 to thousands | Transform and colour | No | `InstancedMesh`, `setColorAt` for tint (`performance-budget` section 2) |
| Many different props sharing one material | Transform | No | `BatchedMesh` (`performance-budget` section 2) |
| Any | Skinned mesh | Yes | `SkeletonUtils.clone`, one mixer per instance |
| Any | Different material or shape | n/a | A separate asset, not an override |

A clone is a scene graph copy and one draw call per mesh. Past about 30 copies of a static prop switch to `InstancedMesh`, the draw-call budget goes first.

## 3. Clone pitfalls (checked in three r187)

| Pitfall | What happens | Fix |
|---|---|---|
| `mesh.clone()` | Geometry and material are **shared by reference**. `clone.material.color.set(...)` recolours every copy | Copy on write (section 7), or `InstancedMesh` with `setColorAt` |
| `SkinnedMesh` via `Object3D.clone()` | The clone keeps the **original skeleton**. Its own bones are copies that drive nothing, so every clone animates as one | `SkeletonUtils.clone(root)` from `three/addons/utils/SkeletonUtils.js`. It rebinds a cloned skeleton to the cloned bones. Geometry and materials stay shared |
| `userData` | Deep-copied with `JSON.parse(JSON.stringify(...))`. Functions and `undefined` are dropped, a `Date` becomes a string, a cycle **throws** | Keep `userData` plain JSON. Hold live objects in a `WeakMap` keyed by the object |
| `material.clone()` | Does not copy `onBeforeCompile` or `customProgramCacheKey`, so a shader-patched material clones into a plain one (`shader-craft`) | Re-apply the patch through one `applyPatch(material)` function after any clone |
| Custom properties on an object (`mesh.myData = ...`) | Not copied | Use `userData` |
| `customDepthMaterial`, `customDistanceMaterial` | Not copied by `Mesh.copy` | Reassign after cloning |
| `animations` | The array is copied (`slice`), clips are shared. Fine, clips hold no state | One `AnimationMixer` per instance root |
| Renaming nodes inside an instance | Animation tracks bind by node name, the clip stops finding its targets | Never rename inside a prefab |

Check each of these in your three revision, the clone code changes between releases.

## 4. Asset manifest

One JSON file describes every asset. The code never hard-codes a URL.

```json
{
  "version": 1,
  "baseUrl": "/assets/",
  "assets": {
    "crate_wood": {
      "url": "props/crate_wood.a1b2c3.glb",
      "bytes": 184320,
      "tags": ["prop", "wood"],
      "preload": false,
      "budget": { "triangles": 1200, "textureBytes": 1398101 },
      "lods": [{ "url": "props/crate_wood_lod1.a1b2c3.glb", "maxDistance": 30 }],
      "license": "CC0"
    },
    "guard": {
      "url": "chars/guard.d4e5f6.glb",
      "bytes": 912384,
      "tags": ["character"],
      "preload": true,
      "budget": { "triangles": 14000, "textureBytes": 5592405 }
    }
  }
}
```

| Field | Purpose |
|---|---|
| `url` | Relative to `baseUrl`. Put a content hash in the file name and serve with a long immutable cache header, so a changed asset is a new URL |
| `bytes` | Download size, used by the loader to show progress and to skip big assets on a low tier |
| `tags` | Query by role (`prop`, `character`), by tier (`high-only`), by area |
| `preload` | Load before the scene reveals (hero assets). Everything else loads lazily |
| `budget` | Declared triangles and texture bytes. Validate against `renderer.info` after load so a swapped asset cannot blow the budget (`performance-budget` section 1) |
| `lods` | Optional lower-detail files with the distance they apply from (`THREE.LOD` or your own swap) |
| `license`, `source` | Keep provenance with the file |

Generate it from the asset folder in the build step (one script), never edit by hand. Validate it at load: unknown asset ids should throw, not return `undefined`.

## 5. Asset library (code)

Dedupes concurrent loads, limits parallel downloads, reference counts every live instance, and disposes shared resources only when the last instance is gone. Pass a `load(url)` that wraps your configured `GLTFLoader` (Draco, KTX2 and Meshopt set up once, `gltf-asset-pipeline`).

```js
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const owned = new WeakSet();            // materials cloned for exactly one instance: safe to dispose with it
let uidCounter = 0;

export function createAssetLibrary({ manifest, load, maxParallel = 4 }) {
  const entries = new Map();            // id -> { refs, template, animations, promise }
  const queue = []; let active = 0;

  const pump = () => {
    while (active < maxParallel && queue.length) {
      active++;
      queue.shift()().finally(() => { active--; pump(); });
    }
  };
  const schedule = (fn) => new Promise((resolve, reject) => { queue.push(() => fn().then(resolve, reject)); pump(); });

  function entry(id) {
    const def = manifest.assets[id];
    if (!def) throw new Error(`unknown asset "${id}"`);
    let e = entries.get(id);
    if (!e) {
      e = { refs: 0, template: null, animations: [], promise: null };
      e.promise = schedule(() => load((manifest.baseUrl ?? '') + def.url)).then(
        (g) => { e.template = g.scene; e.animations = g.animations ?? []; return e; },
        (err) => { entries.delete(id); throw err; },
      );
      entries.set(id, e);
    }
    return e;
  }

  /** Load once, even if called from ten places at the same time. Holds one reference until unpin(id). */
  async function pin(id) {
    const e = entry(id); e.refs++;
    try { await e.promise; } catch (err) { e.refs--; throw err; }
    return e.template;
  }
  const unpin = (id) => release(id);

  function release(id) {
    const e = entries.get(id);
    if (!e || --e.refs > 0) return;
    if (e.template) disposeTree(e.template, { shared: true });
    entries.delete(id);
  }

  /** Clone a prefab into a new detached root. Resolves when loaded. Call despawn(root) when done. */
  async function spawn(id, { name, overrides = [] } = {}) {
    await pin(id);
    const e = entries.get(id);
    const root = SkeletonUtils.clone(e.template);          // handles skinned meshes, shares geometry and materials
    root.name = name ?? id;
    root.animations = e.animations;
    root.userData.prefabId = id;
    root.userData.uid = `${id}#${uidCounter++}`;
    if (overrides.length) setOverrides(root, overrides);
    return root;
  }

  function despawn(root) {
    root.removeFromParent();
    disposeTree(root, { shared: false });                  // owned materials and cloned skeletons only
    release(root.userData.prefabId);
  }

  return { pin, unpin, spawn, despawn, has: (id) => entries.has(id), refs: (id) => entries.get(id)?.refs ?? 0 };
}

/** shared: true disposes everything (template). false disposes only what this instance owns. */
export function disposeTree(root, { shared }) {
  const done = new Set();                                  // meshes often share one material or geometry: dispose each once
  const once = (x) => { if (done.has(x)) return false; done.add(x); return true; };
  root.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();
    if (o.isSkinnedMesh) o.skeleton?.dispose();            // each clone has its own bone texture
    if (!o.geometry) return;
    if (shared && once(o.geometry)) o.geometry.dispose();
    for (const m of [].concat(o.material)) {
      if (!m || (!shared && !owned.has(m)) || !once(m)) continue;
      if (shared) for (const v of Object.values(m)) if (v && v.isTexture && once(v)) v.dispose();
      m.dispose();
    }
  });
}
```

Rules:
- The **template stays detached**. Never `scene.add(template)`. It has no parent, it is only cloned.
- A reference is one live instance (`spawn` adds one, `despawn` removes one). `pin` is for hero assets you want resident regardless.
- `spawn` fails loudly on a bad id. Catch per instance and show a placeholder, do not abort the whole scene.
- A mixer per skinned instance: `const mixer = new THREE.AnimationMixer(root); mixer.clipAction(root.animations[0]).play()`. Update every mixer with the loop's `dt` (`motion-choreography`). Stop updating mixers of instances that are off screen.
- Share one `GLTFLoader` and one `DRACOLoader`/`KTX2Loader`. Creating a loader per asset spins up workers each time.
- When assets come in on frame N, call `await renderer.compileAsync(root, camera)` before adding them, so first display does not hitch (`performance-budget` section 5).

## 6. Lazy loading

| Trigger | Do | Notes |
|---|---|---|
| Scene reveal | `await Promise.all(preloadIds.map(pin))` | Only `preload: true` assets, behind a loading screen with `bytes` progress |
| Camera near an area | `spawn` the area's assets when the camera is within a radius (about 1.5x the draw distance, guess) | Add a cheap placeholder first (below) |
| User action (open a configurator option) | `spawn` on click, swap when ready | Show a spinner at the anchor, never freeze input |
| Camera far | `despawn` after a delay (10 to 30 s, guess) so back and forth does not reload | Keep the last N in memory under a byte budget |

- **Placeholder:** a `Box3Helper` or a low-contrast box of the declared bounds, so layout and collision are right before the model arrives. Swap in place with `placeholder.parent.add(real); placeholder.removeFromParent()`.
- Prioritise: assets nearest the camera first. The library queue is first in first out, so enqueue in the order you want. Keep `maxParallel` at 3 to 4 on mobile networks (guess).
- Network failure: retry twice with backoff, then keep the placeholder and log a warning. A failed asset must not block the rest.
- Do not preload by `tags` alone on mobile. Check `bytes` against a per-tier download budget.
- Texture memory arrives with the asset, check `renderer.info.memory.textures` after each batch against the tier caps (`performance-budget` section 4).

## 7. Per-instance overrides

Overrides are data: a node path and the properties to change. They are stored, serialized and replayed. The material is cloned only when an override touches it (copy on write), so unchanged instances keep sharing.

```js
/** Find a node by a path of names below root, "body/paint". Names must be unique among siblings (section 8). */
export function findByPath(root, path) {
  let node = root;
  for (const part of path.split('/')) {
    node = node.children.find((c) => c.name === part);
    if (!node) return null;
  }
  return node;
}

/** overrides: [{ path: 'body', material: { color: '#c0392b', roughness: 0.4 } }, { path: 'lid', visible: false }]. Stores them on the root too. */
export function setOverrides(root, overrides) {
  root.userData.overrides = overrides;
  for (const o of overrides) {
    const node = o.path ? findByPath(root, o.path) : root;
    if (!node) { console.warn(`override path not found: ${o.path}`); continue; }
    if (o.visible !== undefined) node.visible = o.visible;
    if (o.material && node.isMesh && !Array.isArray(node.material)) {
      if (!owned.has(node.material)) { node.material = node.material.clone(); owned.add(node.material); }   // copy on write
      for (const [k, v] of Object.entries(o.material)) {
        const cur = node.material[k];
        if (cur && cur.isColor) cur.set(v); else node.material[k] = v;
      }
    }
  }
}
```

- Overrides cover scalars, colours and visibility. Texture overrides refer to another manifest asset id, never to a URL inside the override.
- `material.clone()` keeps texture references, so a coloured crate still shares its maps. After cloning, reapply any `onBeforeCompile` patch (section 3).
- A change that must apply to many copies at once (tint a whole team) belongs on `InstancedMesh.setColorAt` or a shared material, not on N clones.
- Multi-material meshes (`material` is an array) are skipped by this helper. Split them in the DCC.
- Live edits at runtime: write the override list again with `setOverrides`, do not mutate shared materials.

## 8. Naming conventions

glTF export and the loader rewrite names, so choose names that survive. `GLTFLoader` strips `[ ] . : /` and replaces whitespace with `_` (`PropertyBinding.sanitizeNodeName`), so Blender's `Cube.001` arrives as `Cube001` and a Maya namespace `ref:crate` as `refcrate`. It also appends `_1`, `_2` to duplicate names within a file.

| Item | Convention |
|---|---|
| Asset id and file | `snake_case`, `[a-z0-9_]`, 48 characters at most: `crate_wood`, `guard` |
| Prefab root | Equal to the asset id. One root, scale 1, at the logical origin (feet on the floor for props, centre for pickups) |
| Children | Short role names: `body`, `lid`, `door_left`. Unique among siblings, so `findByPath` is exact |
| Level of detail | `lod0`, `lod1`, `lod2` suffix on the mesh node |
| Collider proxies | `col_box`, `col_hull_1`, hidden at load, read by `physics-rigidbody` as the collider source |
| Attachment points | `sock_hand_r`, `sock_muzzle`: empty nodes, read by name (`rigging-skeleton-ik` for bone sockets) |
| Instances in a scene | `<asset_id>_<nn>`, set at spawn: `crate_wood_07` |
| Assembly groups | `env`, `props`, `chars`, `fx`, `lights`, one level deep |
| Never | Spaces, dots, slashes, brackets, colons, non-unique siblings, renaming after export |

- Names are the contract between DCC, animation clips, overrides and code. Treat a rename as a breaking change, bump the asset revision.
- Export hygiene (apply transforms, name checks, single root) lives in `blender-to-three-export`.

## 9. Scene graph hygiene

- **Shallow graph.** Every `updateMatrixWorld` walks every node. Keep assembly depth under about 6 and prefab depth under about 12 (guess). Flatten pure grouping nodes in the DCC.
- **Freeze static content.** A static node needs its matrix computed once: `o.updateMatrix(); o.matrixAutoUpdate = false`. Do it after placement, never on anything that moves. For a whole static root also set `root.matrixWorldAutoUpdate = false` after one `updateMatrixWorld(true)` (the renderer checks the flag). `Object3D.static` is WebGPU only.
- **Re-parent with `attach`**, which keeps the world transform. `add` keeps the local one and the object jumps.
- No empty groups, no negative scale (it flips winding and normals), no cycles in `userData`, no unnamed nodes in an exported asset.
- One mesh, one purpose. Hidden helper meshes (`col_*`) should be removed or kept out of the render list: `visible = false` still costs traversal.

```js
/** Report graph problems. Run after load in development, fail the build on any 'error'. */
export function auditScene(root, { maxDepth = 12 } = {}) {
  const issues = [];
  const bad = /[\s.:/[\]]/;
  const walk = (o, depth, path) => {
    if (depth > maxDepth) issues.push({ level: 'warn', kind: 'deep', path });
    const seen = new Set();
    for (const c of o.children) {
      const p = `${path}/${c.name}`;
      if (!c.name) issues.push({ level: 'warn', kind: 'unnamed', path: p });
      else if (bad.test(c.name)) issues.push({ level: 'error', kind: 'bad-name', path: p });
      if (seen.has(c.name)) issues.push({ level: 'error', kind: 'duplicate-sibling', path: p });
      seen.add(c.name);
      if ((c.type === 'Group' || c.type === 'Object3D') && c.children.length === 0) issues.push({ level: 'warn', kind: 'empty', path: p });
      if (c.scale.x * c.scale.y * c.scale.z < 0) issues.push({ level: 'error', kind: 'negative-scale', path: p });
      try { JSON.stringify(c.userData); } catch { issues.push({ level: 'error', kind: 'userdata-not-json', path: p }); }
      walk(c, depth + 1, p);
    }
  };
  walk(root, 0, root.name);
  return issues;
}

/** Bake placement, stop per-frame matrix work. Never call on anything that moves. */
export function freezeStatic(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
  root.matrixWorldAutoUpdate = false;
}
```

## 10. Serialization

Save the assembly as a small JSON document of references, not geometry. `Object3D.toJSON()` and `ObjectLoader` embed geometry and materials, so they suit a tiny scene or an undo snapshot, not a level.

```json
{
  "version": 1,
  "nodes": [
    { "uid": "crate_wood#0", "prefab": "crate_wood", "name": "crate_wood_00", "parent": null,
      "position": [2, 0, -1], "quaternion": [0, 0.7071, 0, 0.7071], "scale": [1, 1, 1], "visible": true,
      "overrides": [{ "path": "body", "material": { "color": "#c0392b" } }] }
  ]
}
```

```js
const r6 = (n) => Math.round(n * 1e6) / 1e6;       // stable, diff-friendly numbers

export function serializeScene(root) {
  const nodes = [];
  root.traverse((o) => {
    if (o === root || !o.userData.prefabId) return;
    let p = o.parent; while (p && p !== root && !p.userData.uid) p = p.parent;
    nodes.push({
      uid: o.userData.uid, prefab: o.userData.prefabId, name: o.name,
      parent: p && p !== root ? p.userData.uid : null,
      position: o.position.toArray().map(r6), quaternion: o.quaternion.toArray().map(r6), scale: o.scale.toArray().map(r6),
      visible: o.visible, overrides: o.userData.overrides ?? [],
    });
  });
  return { version: 1, nodes };
}

export async function deserializeScene(doc, library, root) {
  if (doc.version !== 1) throw new Error(`unsupported scene version ${doc.version}`);
  const made = new Map();
  for (const n of doc.nodes) {                      // parents are listed before children (traversal order)
    const o = await library.spawn(n.prefab, { name: n.name, overrides: n.overrides });
    o.userData.uid = n.uid;
    o.position.fromArray(n.position); o.quaternion.fromArray(n.quaternion); o.scale.fromArray(n.scale);
    o.visible = n.visible;
    (n.parent ? made.get(n.parent) : root).add(o);
    made.set(n.uid, o);
  }
  return made;
}
```

- Save **quaternions**, not Euler angles, so a round trip does not change orientation. Round to 6 places to keep version-control diffs small.
- Version the document. A loader that meets an unknown version fails with a clear error, never half-loads.
- Never put URLs, textures or functions in the document. Only asset ids from the manifest.
- To hand a finished scene to someone else as one file, flatten it with `GLTFExporter` (`three/addons/exporters/GLTFExporter.js`). Prefab links are lost, the output is a plain glTF.
- Spawn order above awaits one at a time. For speed, `pin` all unique ids first with `Promise.all`, then spawn, since pinned assets resolve instantly.

## 11. Disposal

- **Never dispose geometry, textures or materials of an instance directly.** They are shared. Call `library.despawn(root)`: it removes the root, disposes only owned materials and the instance's own skeleton texture, and releases one reference. The library disposes the template when the count reaches zero.
- `dispose()` on a shared resource is not fatal, three re-uploads it on next use, but it causes a hitch and a memory spike for every other user. That is the symptom of "removed one crate and all of them flicker".
- Instances with overrides own their cloned material: tracked in `owned`, freed on `despawn`.
- Dispose render targets, `PMREMGenerator` and loaders you create (`performance-budget` section 6).
- After a route change or a scene swap, `renderer.info.memory.geometries` and `textures` must return to the baseline you recorded before loading.

## 12. Failure symptoms

| Symptom | Cause | Fix |
|---|---|---|
| Changing one crate recolours all | Shared material | Copy on write (section 7) |
| All characters play the same animation in sync | `Object3D.clone` shared the skeleton, or one mixer | `SkeletonUtils.clone`, one mixer per instance |
| Skinned clone stands in a T-pose | Clone bound to the original skeleton | `SkeletonUtils.clone` |
| Clone loses its wind or dissolve effect | `material.clone` dropped `onBeforeCompile` | Reapply the patch after cloning |
| Animation clip does nothing on a clone | A node was renamed | Never rename inside a prefab |
| `JSON` error or missing data after clone | Cycle or class instance in `userData` | Plain JSON only |
| Draw calls climb with copy count | Clones, not instances | `InstancedMesh` past about 30 |
| Memory grows after removing objects | `remove` without `dispose`, or dispose of shared parts | `despawn`, check `renderer.info.memory` |
| One crate removed, the rest flicker | Shared geometry or texture disposed | Release by reference count |
| First view of a new asset hitches | Shader compile and upload on first draw | `compileAsync` before adding |
| Same asset downloaded twice | Concurrent calls without dedupe | `pin` shares one promise |
| Override applied to the wrong part | Duplicate sibling names | Unique names, `auditScene` |
| Frame time rises with scene size | Deep graph, matrices recomputed every frame | Flatten, `freezeStatic` |

## 13. Verify

Numeric checks run for this skill (Node 22, three 0.187.0, synthetic assets and a fake loader, no renderer):

| Check | Result |
|---|---|
| `Object3D.clone` shares geometry and material | geometry and material identical |
| `Object3D.clone` of a skinned mesh shares the skeleton, `SkeletonUtils.clone` does not | confirmed |
| Rotating a cloned bone moves only that clone's bone matrices | confirmed |
| `material.clone()` drops `onBeforeCompile`, `Mesh.clone` drops `customDepthMaterial` and custom properties, `userData` drops functions and throws on a cycle | confirmed |
| Two spawned skinned prefabs with one clip each, mixers updated separately | independent: 0.194 against 0 on the same bone |
| `PropertyBinding.sanitizeNodeName` | `Cube.001` gives `Cube001`, `ref:crate left` gives `refcrate_left` |
| Three concurrent loads of one id call the loader once | 1 call |
| Release order: no geometry disposed while one instance is alive, disposed after the last despawn | confirmed |
| An override clones one material, the others still share | confirmed |
| `serializeScene` then `deserializeScene` into a new library | world matrices equal within 1e-5, override restored |
| `auditScene` flags duplicate siblings, bad names, negative scale, cycles in `userData`, empty groups, deep nesting | confirmed |
| `freezeStatic` then moving the root | child world position unchanged (6, 2, 3) |

Then in the browser:
1. `render-qa` the assembly, compare `renderer.info.render.calls` against the clone and instance counts you intended.
2. Spawn and despawn the same asset 20 times, `renderer.info.memory` must return to the baseline.
3. Throttle the network, confirm placeholders show, nothing blocks input and the scene finishes loading.
4. Run `auditScene` on the assembled root and on each prefab after load. Zero errors.

Not verified in this skill: `GLTFLoader` behaviour with your actual files (checked only through a fake loader), `BatchedMesh` swap, per-LOD loading, a texture override path.
