---
name: realtime-engine-features
description: Reproduce Unreal Engine style features in Three.js and say honestly what the web can and cannot do. Covers Niagara style GPU particles (instanced quads, data textures, WebGPU compute, soft particles, flipbooks), Sequencer style cinematic timelines (keyframed tracks, camera cuts, easing, scrubbing, event tracks), Nanite substitutes (LOD, BatchedMesh, offline simplify), Lumen substitutes (baked probes, light probes, SSGI, hybrid), Post Process Volumes, decals, material instances, Blueprint style data-driven behaviours, level streaming and the editor workflow gap. Use when a request says "like Unreal", "like Niagara", "like Nanite", "like Lumen", "Sequencer", "game engine quality", or when deciding whether an engine feature is worth building for the web. Thai triggers เอฟเฟกต์ระดับเกม, ฟีเจอร์แบบ Unreal, พาร์ติเคิล GPU, ไทม์ไลน์ซีนเมติก, ระบบ LOD, แสงสะท้อนแบบ GI.
argument-hint: "<engine feature wanted, e.g. Niagara particles or Sequencer timeline, plus target device tier>"
---

# Realtime Engine Features

Engines ship these features with native GPU access, editors and a content pipeline. A browser has a WebGL2 or WebGPU context, a JS main thread and a download. Pick the web substitute, say what is lost, and stay inside `performance-budget`.

## 1. Feasibility table

Ratings: **feasible** (build it, quality close to the engine), **approximate** (a cheaper substitute that reads similar), **not worth attempting** (do not build the real thing on the web).

| Engine feature | Rating | Minimal verified approach | Lost vs the engine |
|---|---|---|---|
| Niagara particles | Feasible (stateless), approximate (stateful) | Section 2: instanced quads with the motion computed in the vertex shader. Stateful simulation via a data texture ping pong (`GPUComputationRenderer`, `three/addons/misc`) or WebGPU compute (verify TSL names) | Collision, ribbons, mesh emitters, event chains, GPU sorting |
| Sequencer | Feasible | Section 3: keyframed tracks, camera cuts, easing, scrub, event track. Or `AnimationClip` with `VectorKeyframeTrack` plus `AnimationMixer` | The editor UI, take recording, nested sequences |
| Nanite | Not worth attempting | No cluster hierarchy or software rasteriser on the web. Substitute: `THREE.LOD`, `BatchedMesh`, offline `gltf-transform simplify` (see `gltf-asset-pipeline`) | Unlimited triangle counts, automatic continuous LOD |
| Lumen | Not worth attempting (dynamic), approximate (baked) | Baked lightmaps plus `LightProbe` (`LightProbeGenerator.fromCubeRenderTarget`, `three/addons/lights`) plus `scene.environment`. Hybrid: bake static, probe dynamic. SSGI as a post pass (verify library). See `raytracing-light-transport` for path traced reference and offline bakes | Fully dynamic bounce light, emissive GI, large scale reflections |
| Post Process Volumes | Feasible | Section 4: weight per volume by camera position, lerp grade and exposure | Per volume LUT blends need your own shader |
| Decals | Feasible | `DecalGeometry(mesh, position, orientation, size)` from `three/addons/geometries/DecalGeometry.js`, material with `polygonOffset` | Deferred projected decals that follow any surface at runtime |
| Material Instances | Feasible | One shared material, per instance data in `InstancedBufferAttribute` or `setColorAt` | Editor side parameter overrides |
| Blueprint | Feasible (data driven), not worth attempting (visual graph) | Section 5: entity component table plus systems loop | Visual node graph editor, hot reload of graphs |
| Level streaming, World Partition | Feasible | Section 6: chunked GLB files, load by distance to the camera, dispose out of range | Automatic cell generation, HLOD generation, texture streaming |
| Editor workflow | Approximate | Section 7: `lil-gui`, `tweakpane` or `leva` panels bound to scene state, `TransformControls` for gizmos | Content browser, viewport editing, play in editor |

## 2. Niagara style GPU particles

### Choose the tier

| Need | Approach | Notes |
|---|---|---|
| Fire, smoke, sparks, dust, magic with simple motion | **Stateless**: position is a pure function of `uTime` and per instance seeds | No CPU work per frame. Verified sample below |
| Particles that react to forces, flow fields or other particles | **Stateful**: positions in a float data texture, update with ping pong render targets | `GPUComputationRenderer` handles the ping pong |
| Millions of particles, sorting, atomic counters | **WebGPU compute** | Needs `three/webgpu` and a WebGPU browser. Needs a WebGL2 fallback (verify) |
| Soft intersection with geometry | **Soft particles** | Needs a depth texture of the opaque scene. Sample it in the fragment shader and fade by `smoothstep` of the depth difference (verify integration with your pass setup) |
| Animated sprite look (fire, explosion, smoke) | **Flipbook** | Sprite sheet with a grid, pick the cell from particle age (in the sample) |

### Verified sample: stateless instanced billboard particles with flipbook

```js
import * as THREE from 'three';

const COUNT = 20000;
const base = new THREE.PlaneGeometry(1, 1);
const geo = new THREE.InstancedBufferGeometry();
geo.index = base.index;
geo.setAttribute('position', base.getAttribute('position'));
geo.setAttribute('uv', base.getAttribute('uv'));
geo.instanceCount = COUNT;

const origin = new Float32Array(COUNT * 4);   // xyz start, w birth offset
const motion = new Float32Array(COUNT * 4);   // xyz velocity, w lifetime
for (let i = 0; i < COUNT; i++) {
  const life = 1.5 + Math.random() * 1.5;
  origin.set([(Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4, Math.random() * life], i * 4);
  motion.set([(Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6, life], i * 4);
}
geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 4));
geo.setAttribute('aMotion', new THREE.InstancedBufferAttribute(motion, 4));

const mat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: { value: 0 },
    uGravity: { value: new THREE.Vector3(0, -0.4, 0) },
    uSheet: { value: sheetTexture },            // 4x4 flipbook, colorSpace = SRGBColorSpace
    uGrid: { value: new THREE.Vector2(4, 4) },  // columns, rows
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform vec3 uGravity;
    attribute vec4 aOrigin;
    attribute vec4 aMotion;
    varying vec2 vUv;
    varying float vAge;
    void main() {
      float age = mod(uTime - aOrigin.w, aMotion.w);
      float t = age / aMotion.w;
      vec3 p = aOrigin.xyz + aMotion.xyz * age + 0.5 * uGravity * age * age;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      mv.xy += position.xy * mix(0.08, 0.35, t);   // camera facing billboard
      vUv = uv;
      vAge = t;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D uSheet;
    uniform vec2 uGrid;
    varying vec2 vUv;
    varying float vAge;
    void main() {
      float frame = floor(vAge * uGrid.x * uGrid.y);
      vec2 cell = vec2(mod(frame, uGrid.x), uGrid.y - 1.0 - floor(frame / uGrid.x));
      vec4 c = texture2D(uSheet, (vUv + cell) / uGrid);
      c.a *= 1.0 - smoothstep(0.8, 1.0, vAge);
      gl_FragColor = c;
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});

const particles = new THREE.Mesh(geo, mat);
particles.frustumCulled = false;   // bounding sphere comes from one unit quad, not the particles
scene.add(particles);
// in the loop: mat.uniforms.uTime.value = clock.elapsedTime;
```

Notes:
- `frustumCulled = false` is required. Culling uses the quad's bounding sphere, so particles vanish when the origin leaves the view.
- The flipbook cell has no blending between frames. Pad sprite cells or use `generateMipmaps = false` to stop bleed at cell edges.
- Additive blending needs no sorting. Alpha blended smoke needs back to front order, which a stateless shader cannot give. Use additive, premultiplied alpha or a few depth sorted batches.
- Authoring patches for shaders follow `shader-craft`.

### Performance (tie to `performance-budget`)

- One instanced mesh is one draw call, whatever the count. The cost is fill rate: overdraw of large transparent quads. Cap particle count and screen size per tier, for example 5k (low), 20k (mid), 50k (high) as a starting guess to tune.
- Halve the particle resolution on low tier by rendering smoke to a half size target (adds a pass, check against the budget table).
- Dispose the geometry, material and sheet texture when the effect is removed.

## 3. Sequencer style cinematic timeline

Core pieces: keyframed value tracks with per key easing, camera cuts, an event track, a playhead you can scrub. This is plain JS and small.

```js
import * as THREE from 'three';

const EASE = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
const _b = new THREE.Vector3();

// keys: [{ t, v: [x, y, z], ease? }], ease on a key shapes the segment that starts there
function sampleKeys(keys, t, out) {
  if (t <= keys[0].t) return out.fromArray(keys[0].v);
  const last = keys[keys.length - 1];
  if (t >= last.t) return out.fromArray(last.v);
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const k = EASE[a.ease ?? 'linear']((t - a.t) / (b.t - a.t));
  return out.fromArray(a.v).lerp(_b.fromArray(b.v), k);
}

export class Timeline {
  constructor(duration) {
    this.duration = duration;
    this.time = 0;
    this.playing = false;
    this.tracks = [];
    this.cuts = [];
    this.events = [];
    this.activeCamera = null;
  }
  track(target, keys) { this.tracks.push({ target, keys }); return this; }   // target: a Vector3, e.g. camera.position
  cut(t, camera) { this.cuts.push({ t, camera }); this.cuts.sort((a, b) => a.t - b.t); return this; }
  event(t, fn) { this.events.push({ t, fn }); return this; }
  seek(t, { fire = false } = {}) {
    const prev = this.time;
    this.time = THREE.MathUtils.clamp(t, 0, this.duration);
    for (const { target, keys } of this.tracks) sampleKeys(keys, this.time, target);
    this.activeCamera = this.cuts[0]?.camera ?? null;
    for (const c of this.cuts) if (c.t <= this.time) this.activeCamera = c.camera;
    if (fire) for (const e of this.events) if (e.t > prev && e.t <= this.time) e.fn();
  }
  update(dt) {
    if (!this.playing) return;
    this.seek(this.time + dt, { fire: true });
    if (this.time >= this.duration) this.playing = false;
  }
}

// usage
const look = new THREE.Vector3();
const tl = new Timeline(8)
  .track(camA.position, [{ t: 0, v: [0, 2, 9], ease: 'inOutCubic' }, { t: 4, v: [4, 1.5, 4] }])
  .track(look, [{ t: 0, v: [0, 1, 0] }])
  .cut(0, camA)
  .cut(4, camB)
  .event(2, () => door.visible = true);
tl.seek(0);
tl.playing = true;
// loop: tl.update(dt); tl.activeCamera.lookAt(look); renderer.render(scene, tl.activeCamera);
// scrub: slider.oninput = () => tl.seek(slider.value * tl.duration);   // scrubbing does not fire events
```

Rules:
- Events fire only while playing forward, and not at `t = 0`. Run time zero setup by hand.
- Scrubbing backwards does not undo events. Make event targets idempotent (set a state from the playhead) when scrub fidelity matters.
- Drive the camera `lookAt` from its own track, then update once per frame after `tl.update`.
- Rotations: use `QuaternionKeyframeTrack` or slerp, never lerp Euler angles.
- Built in alternative: `AnimationClip`, `VectorKeyframeTrack('.position', times, values)` and `AnimationMixer`. For scrubbing call `mixer.setTime(t)` (verify it exists in your three revision). The mixer has no camera cuts or event tracks, add them as above.
- Match easing and durations to `motion-choreography`. Honour `prefers-reduced-motion` by cutting to the final pose.

Performance: timeline cost is trivial. Cuts between cameras can reveal unseen geometry and shaders, so run `await renderer.compileAsync(scene, camB)` for every cut camera before play (`performance-budget` section 5).

## 4. Post Process Volumes

Blend grade and exposure by where the camera is.

1. Define volumes as `{ box: THREE.Box3 or sphere, blend: metres, settings: { exposure, saturation, bloom, tint } }` with a global default.
2. Weight per volume: distance of the camera to the volume (0 when outside by more than `blend`, 1 when inside), via `box.distanceToPoint(camera.position)`.
3. Accumulate `settings * weight` over volumes, normalise with the default as the remainder, then damp the result over time (`THREE.MathUtils.damp`) so crossings never snap.
4. Apply to `renderer.toneMappingExposure`, bloom strength and your grade pass uniforms (`post-processing-stack`).

Rules: damp every blended value. Keep the volume count small, the loop cost is per frame on the CPU. Do not blend between different tone mappers, switch them at a cut instead.

## 5. Blueprint style data driven behaviour

A visual graph is not worth building. The useful half of Blueprints is data driven behaviour: entities, components, systems.

| Concept | Web form |
|---|---|
| Actor | Entity id plus a `THREE.Object3D` |
| Component | Plain data object per entity, kept in a `Map` per component type (`Transform`, `Spin`, `Trigger`, `Health`) |
| Event | Small emitter, or `EventTarget` |
| Graph logic | System functions that loop over entities having the needed components |
| Authoring | JSON file listing entities and component values, loaded at start |

```js
const spin = new Map();   // entity -> { speed }
const objects = new Map(); // entity -> Object3D
const systems = [(dt) => { for (const [e, c] of spin) objects.get(e).rotation.y += c.speed * dt; }];
// loop: for (const s of systems) s(dt);
```

Performance: systems run on the main thread, keep per frame loops over thousands of entities allocation free. For identical objects move the data into `InstancedMesh` matrices (`performance-budget` section 2).

## 6. Level streaming and World Partition

1. Split the world offline into chunks on a grid, one GLB per cell, compressed (`gltf-asset-pipeline`).
2. Each frame (or every 250 ms), compute the camera cell. Load cells inside the load radius, unload cells outside a larger unload radius (hysteresis stops thrash).
3. Load with `GLTFLoader` (plus Draco and KTX2 loaders) and `await` before `scene.add`. Keep a loading set so one cell loads once.
4. Unload with a full dispose: geometries, materials, textures, then `scene.remove`. Check `renderer.info.memory` returns to baseline.
5. Warm shaders for the incoming cell with `renderer.compileAsync` to avoid a hitch when it appears.

Rules: stream by distance but also by tier, low tier uses a smaller radius. Keep a low detail proxy for far cells (the HLOD idea) built offline. Never create loaders per cell.

## 7. Editor workflow gap

The web has no Unreal editor. Substitute with small control panels while building, and strip them from the shipped page.

| Tool | Use | Note |
|---|---|---|
| `lil-gui` | Zero setup panel, ships with three examples | Good default |
| `tweakpane` | Cleaner panel, folders, graphs | Binding method name changed between major versions (verify `addBinding` vs `addInput`) |
| `leva` | Panels in a React app | React only |
| `TransformControls` (`three/addons/controls`) | Move and rotate objects, copy the numbers into data | |

Rules: bind panels to the same data objects the systems read (section 5), so tuning edits real state. Add an export button that prints JSON to paste back into the source. Gate panels behind a query flag such as `?debug`.

## 8. Verify (`render-qa`)

For every feature built:

1. Run the checker on the scene, with `--gpu` when a real GPU is available. Read `report.md` for draw calls, triangles and console errors.
2. **Particles:** screenshot at several `uTime` values and from orbit angles. Confirm billboards face the camera, no culling pop when the emitter leaves frame, no clipping, no hard cell edges in the flipbook.
3. **Timeline:** screenshot at the start, mid and end of each cut by calling `tl.seek(t)` from the test page, then confirm the active camera and framing match intent. Scrub back and forth, state must be stable.
4. **Post volumes:** screenshot on both sides of a volume boundary and at the midpoint. No pop, no clipped highlights.
5. **LOD, BatchedMesh, streaming:** screenshot at the close and far camera positions. No visible pop, holes or missing chunks.
6. **GI substitutes:** compare a screenshot with probes against one without. Check grounding and colour bleed read correctly.
7. Compare numbers against the tier table in `performance-budget`. Report remaining issues honestly after three fix loops.

## 9. Do not do these

- Do not claim parity with Nanite or Lumen. State the substitute and what is lost.
- Do not build a visual scripting editor or a content browser for a web page.
- Do not run per particle logic on the CPU past a few thousand particles.
- Do not stream without disposing. Leaks show as climbing `renderer.info.memory`.
