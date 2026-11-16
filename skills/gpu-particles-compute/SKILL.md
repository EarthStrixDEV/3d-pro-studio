---
name: gpu-particles-compute
description: Stateful GPU particle simulation in Three.js. Covers ping-pong float textures with GPUComputationRenderer (WebGL2), WebGPU compute with TSL storage buffers, position and velocity texture layout, reading simulation state in the vertex shader, particle counts per device tier, GPU sorting limits (BitonicSort, CountingSort, chunked sorting), readback stalls and async alternatives, and the fallback chain from WebGPU to WebGL2 to CPU. Includes a tested WebGL2 ping-pong sample. Use when particles must react to forces or collisions on the GPU, counts go past 10k, a CPU particle loop is the bottleneck, or when choosing between GPUComputationRenderer and WebGPU compute. Thai triggers พาร์ติเคิล GPU, อนุภาคจำนวนมาก, compute shader, ping-pong texture, จำลองฟิสิกส์บน GPU.
argument-hint: "<particle count wanted, forces needed, WebGPU allowed or WebGL2 only>"
---

# GPU Particles (Compute)

Simulation state lives in GPU memory and is updated by a shader pass each step. The CPU only sets uniforms. Data shape, lifetime and seeding rules come from `particle-system-architecture`, forces from `particle-forces-fields`, drawing from `particle-rendering-blending`.

## 1. Pick the path

| Situation | Path |
|---|---|
| Motion is a closed-form function of time (fire, dust, sparks, no reaction) | Stateless vertex shader, no compute. `realtime-engine-features` section 2 |
| Needs forces, noise fields, collision, trails, 10k to 1M particles, WebGL2 required | **Ping-pong textures** (section 2 to 5) |
| Millions of particles, sorting, atomics, indirect draw, WebGPU only audience | **WebGPU compute** (section 6) |
| Under 2k particles or gameplay reads positions | CPU (`particle-system-architecture`) |

Ship a fallback chain (section 9). Most audiences still include browsers without WebGPU.

## 2. Ping-pong textures: layout

`GPUComputationRenderer` (`three/addons/misc/GPUComputationRenderer.js`) owns two render targets per variable and swaps them each `compute()`. Each variable is an RGBA float texture, one texel per particle.

| Texture (variable) | xyz | w |
|---|---|---|
| `texturePosition` | position | age |
| `textureVelocity` | velocity | life |
| Optional third (spin, colour seed, state flags) | per effect | per effect |

- **Size is square, count = size squared.** 128 is 16k, 256 is 65k, 512 is 262k, 1024 is 1M. Pick a size, not a count.
- Each extra variable costs a full-screen pass and a texture fetch in the vertex shader. Two is the sweet spot, pack extras into `w`.
- **Names matter.** The variable name becomes the sampler uniform in every shader that lists it as a dependency. `resolution` is defined as a `vec2` constant for you.
- Use `gl_FragCoord.xy / resolution.xy` as the texel uv in compute shaders.
- `gpu.init()` returns an error string or `null`, it does not throw. It fails when vertex texture fetch is unavailable. Check it.
- Defaults: nearest filtering, clamp, float type. `gpu.setDataType(THREE.HalfFloatType)` where float render targets are unavailable (some mobile GPUs). Half floats lose precision away from the origin (11 bits mantissa), keep positions local or accept jitter.

## 3. Verified sample: 65k particles, two variables

Run in headless Chromium (WebGL2, software rasteriser) with three r187. Checks: particle 0 after 30 steps matched a CPU reference of the same formula within 2e-7, 300 more steps stayed finite with respawns happening, no GL error, one draw call. Real GPU timing was not measured.

```js
import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';

const SIZE = 256;                                   // 256 x 256 = 65536 particles
const COUNT = SIZE * SIZE;

// Shared chunk. Both compute shaders read the PREVIOUS step, so each one calls the same force function.
const COMMON = /* glsl */ `
  uniform float uDt;
  uniform float uTime;
  vec3 accel(vec3 p, vec3 v) { return vec3(0.0, -2.0, 0.0) - 0.5 * v; }
  float hash(vec2 s) { return fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453); }
`;
// texturePosition: xyz position, w age.  textureVelocity: xyz velocity, w life.
const posFrag = /* glsl */ `${COMMON}
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(texturePosition, uv);
    vec4 v = texture2D(textureVelocity, uv);
    if (p.w >= v.w) { gl_FragColor = vec4(0.0); return; }                   // respawn at the origin, age 0
    vec3 vNew = v.xyz + accel(p.xyz, v.xyz) * uDt;                          // semi-implicit: new velocity first
    gl_FragColor = vec4(p.xyz + vNew * uDt, p.w + uDt);
  }`;
const velFrag = /* glsl */ `${COMMON}
  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec4 p = texture2D(texturePosition, uv);
    vec4 v = texture2D(textureVelocity, uv);
    if (p.w >= v.w) {                                                       // same respawn test as the position shader
      float a = hash(uv + uTime) * 6.2831853, s = 1.0 + 2.0 * hash(uv + uTime + 1.7);
      gl_FragColor = vec4(cos(a) * s * 0.5, 2.0 + s, sin(a) * s * 0.5, 1.0 + 2.0 * hash(uv + uTime + 3.1));
      return;
    }
    gl_FragColor = vec4(v.xyz + accel(p.xyz, v.xyz) * uDt, v.w);
  }`;

export function createGpuParticles(renderer) {
  const gpu = new GPUComputationRenderer(SIZE, SIZE, renderer);
  // gpu.setDataType(THREE.HalfFloatType);          // fallback where float render targets are unavailable
  const pos0 = gpu.createTexture(), vel0 = gpu.createTexture();
  for (let i = 0; i < COUNT; i++) {
    pos0.image.data[i * 4 + 3] = 3;                  // age >= life, so every particle respawns on step 1
    vel0.image.data[i * 4 + 3] = 2;                  // life
  }
  const posVar = gpu.addVariable('texturePosition', posFrag, pos0);
  const velVar = gpu.addVariable('textureVelocity', velFrag, vel0);
  gpu.setVariableDependencies(posVar, [posVar, velVar]);
  gpu.setVariableDependencies(velVar, [posVar, velVar]);
  for (const v of [posVar, velVar]) {
    v.material.uniforms.uDt = { value: 1 / 60 };
    v.material.uniforms.uTime = { value: 0 };
  }
  const err = gpu.init();
  if (err) throw new Error(err);                     // init returns a message string, it does not throw

  const ref = new Float32Array(COUNT * 2);           // texel centre of each particle
  for (let i = 0; i < COUNT; i++) {
    ref[i * 2] = ((i % SIZE) + 0.5) / SIZE;
    ref[i * 2 + 1] = (Math.floor(i / SIZE) + 0.5) / SIZE;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));  // unused, sets the draw count
  geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 12);                    // honest bounds, culling stays on
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPos: { value: null }, uSize: { value: 2 } },
    vertexShader: /* glsl */ `
      uniform sampler2D uPos; uniform float uSize; attribute vec2 aRef; varying float vAge;
      void main() {
        vec4 p = texture2D(uPos, aRef);
        vAge = p.w;
        gl_PointSize = uSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p.xyz, 1.0);
      }`,
    fragmentShader: /* glsl */ `varying float vAge; void main() { gl_FragColor = vec4(1.0, 0.6, 0.2, 0.15 * (1.0 - vAge / 3.0)); }`,
  });
  const points = new THREE.Points(geo, mat);

  return {
    points, gpu, posVar, velVar,
    update(dt, time) {
      for (const v of [posVar, velVar]) {
        v.material.uniforms.uDt.value = dt;
        v.material.uniforms.uTime.value = time;
      }
      gpu.compute();
      mat.uniforms.uPos.value = gpu.getCurrentRenderTarget(posVar).texture;   // re-fetch every frame, the targets swap
    },
    dispose() { gpu.dispose(); geo.dispose(); mat.dispose(); },
  };
}
```

Use it:

```js
const fx = createGpuParticles(renderer);
scene.add(fx.points);
// per frame (fixed or clamped dt): fx.update(Math.min(dt, 1 / 30), clock.elapsedTime);
// teardown: scene.remove(fx.points); fx.dispose();
```

Facts the sample depends on:
- **All dependencies are read from the previous step.** `compute()` binds every dependency from the current target, then writes the alternate ones. The position pass therefore sees the old velocity, not the one the velocity pass just wrote. For semi-implicit Euler, recompute the new velocity inside the position shader (shared `accel` chunk), or accept one step of lag (explicit Euler, less stable under strong forces).
- **Respawn tests must agree.** Both shaders test the same old state (`age >= life`), so they respawn the same particle on the same step.
- **Re-fetch the render target every frame.** `getCurrentRenderTarget(variable).texture` changes after each `compute()`. Caching the texture shows state two frames old, or frozen.
- **`geometry.boundingSphere` set by hand.** The position attribute is zeros, so default culling would drop the system (`particle-system-architecture` section 8).
- Hash randomness (`fract(sin(...))`) varies slightly across GPUs. Fine for looks, not for networked determinism.

## 4. Reading state in the vertex shader

| Method | Use when |
|---|---|
| Per-vertex `aRef` uv attribute, `texture2D(uPos, aRef)` | Default, works everywhere (sample) |
| `gl_VertexID` with `texelFetch` (WebGL2, `ShaderMaterial`) (verify) | Saves the attribute, needs integer indexing `ivec2(id % W, id / W)` |
| `InstancedBufferGeometry` with `aRef` per instance | Quad or mesh particles. One instance per particle, billboard in the shader |

- Vertex texture fetch needs `renderer.capabilities.maxVertexTextures > 0`. Practically universal on WebGL2.
- Unfiltered `texture2D` on a float target works with nearest filtering. Never set linear filtering on a float target without checking `OES_texture_float_linear`.
- Derive display values (size, colour, alpha) from `age / life` in the vertex shader instead of storing them.
- Mesh particles on the GPU: read position and a stored orientation, build the matrix in the shader (`particle-rendering-blending`).

## 5. Emission, counts and tiers

**Emission without CPU work:** keep the sample's self-respawn for looping effects. For bursts and a moving emitter, add uniforms the compute shader reads: `uEmitterPos`, and a spawn window `uSpawnStart`, `uSpawnCount`. Each texel computes its linear index `id = y * W + x` and respawns when `id` lies inside the window modulo `W*W`. That is the GPU ring buffer. Advance `uSpawnStart` on the CPU by the spawn count each frame (accumulator rule from `particle-system-architecture`). This snippet logic was not run.

| Tier | Texture size | Particles | Notes (starting guesses, tune on device) |
|---|---|---|---|
| Low (phones, iGPU) | 128 to 256 | 16k to 65k | Half float if needed. Point size 1 to 3 px. Cap overdraw |
| Mid (laptops) | 256 to 512 | 65k to 262k | Two variables, no per-particle collision beyond depth or plane |
| High (desktop dGPU) | 512 to 1024 | 262k to 1M | Fill rate of the sprites becomes the limit, not the simulation |

- Simulation cost scales with texels (count), render cost with covered pixels. Ten thousand large soft sprites can cost more than a million 1 px points.
- Run the simulation at a lower rate than the frame rate if needed (every second frame with doubled dt). Clamp dt, a big dt explodes explicit forces.
- Choose the tier from measured frame time, not user agent (`performance-budget`, `vfx-performance-scaling`).

## 6. WebGPU compute with TSL storage buffers

Import from `three/webgpu` and `three/tsl`. Every name below exists in the r187 source, behaviour was not run here. API surface moves between releases, so mark it (verify) and pin the three version.

```js
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, vec3, hash } from 'three/tsl';  // (verify)

const COUNT = 1_000_000;
const pos = instancedArray(COUNT, 'vec3');            // storage buffers, no texture size limit
const vel = instancedArray(COUNT, 'vec3');
const uDt = uniform(1 / 60);

const init = Fn(() => {
  const p = pos.element(instanceIndex);
  const v = vel.element(instanceIndex);
  p.assign(vec3(0));
  v.assign(vec3(hash(instanceIndex).sub(0.5), 2, hash(instanceIndex.add(7)).sub(0.5)));
})().compute(COUNT);

const step = Fn(() => {
  const p = pos.element(instanceIndex);
  const v = vel.element(instanceIndex);
  v.addAssign(vec3(0, -2, 0).mul(uDt));               // velocity first
  p.addAssign(v.mul(uDt));                            // then position, semi-implicit
})().compute(COUNT);

const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
mat.positionNode = pos.toAttribute();                 // storage buffer to vertex stage
const sprites = new THREE.Sprite(mat);
sprites.count = COUNT;                                // instance count of the sprite (verify)
scene.add(sprites);

const renderer = new THREE.WebGPURenderer({ antialias: true });
await renderer.init();
await renderer.computeAsync(init);
renderer.setAnimationLoop(() => { renderer.compute(step); renderer.render(scene, camera); });
```

Rules:
- `await renderer.init()` before the first `compute`. `compute()` before init warns and falls back to `computeAsync`.
- In compute, buffers update in place. There is no ping-pong, reads and writes hit the same element, so each invocation must only touch its own index (or use atomics and barriers for neighbours).
- Seed in an `init` compute dispatch, not on the CPU, for large counts.
- `instancedArray` for storage, `.toAttribute()` for rendering. Count is in elements.
- Ring buffer emission: a `uniform` for the write window and an `if` on `instanceIndex`, same logic as section 5.
- Pass the same data contract (position, velocity, age, life) so forces ported from `particle-forces-fields` need only syntax changes.

## 7. GPU sorting limits

Alpha-blended particles need back to front order. Additive and premultiplied-alpha particles do not (see `particle-rendering-blending`), so avoid sorting when the look allows.

| Backend | Options | Limits |
|---|---|---|
| WebGL2 ping-pong | No real GPU sort. Split into N chunks drawn as separate objects and sort chunks by view depth on the CPU. Or sort a small subset on the CPU (needs readback, section 8) | Chunk sorting is approximate, particles inside a chunk are unordered |
| WebGPU | `BitonicSort` (`three/addons/gpgpu/BitonicSort.js`): `new BitonicSort(renderer, dataBuffer, options)`, `compute(renderer)`. `CountingSort` (`three/addons/gpgpu/CountingSort.js`): `setBinNode`, `compute(renderer)`, result in `orderRead`. Both (verify) | Bitonic is exact but O(n log² n) passes and takes a power-of-two count (it uses `log2(count)`). Counting sort is approximate by bin count and much faster at 100k+ |

Sorting runs every frame it matters. Sort only what is alpha blended, and consider sorting every second frame.

## 8. Readback pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Frame time spikes when reading particle data | `renderer.readRenderTargetPixels` blocks until the GPU finishes | Use `readRenderTargetPixelsAsync` (WebGLRenderer) or `renderer.getArrayBufferAsync(attribute)` (WebGPU), and accept one or more frames of latency |
| Readback returns zeros or throws | Float target needs the `EXT_color_buffer_float` extension, format must be RGBA | Check `renderer.extensions.has('EXT_color_buffer_float')`, read into `Float32Array` |
| Half float readback gives odd numbers | Data is 16 bit | Read as `Uint16Array` and decode, or use float type |
| Gameplay lags behind visuals | Async latency | Keep gameplay logic CPU side and let the GPU follow, not the reverse |

Rule: never read back every frame at full size. Read a small region (`width`, `height` parameters) or a reduced summary. If CPU logic needs particle positions, the effect belongs on the CPU (`particle-system-architecture`).

## 9. Fallback chain

1. Detect WebGPU: `navigator.gpu` and `await navigator.gpu.requestAdapter()` (the `three/addons/capabilities/WebGPU.js` helper does the same).
2. WebGPU present: section 6 path (`WebGPURenderer`).
3. Else WebGL2: `WebGLRenderer` and section 2 to 5. `WebGPURenderer` with `forceWebGL: true` runs a WebGL2 backend, but compute support on it is limited (verify for your features), so treat it as a render fallback, not a compute one.
4. Else, or when `gpu.init()` returns an error: CPU system at a reduced count (section 2 of `particle-system-architecture`).

Keep one effect description (counts, forces, colour curves as plain data) and two thin backends. Materials differ (`ShaderMaterial` versus node materials), simulation maths should not. Test each path by forcing it with a query flag.

## 10. Verify

1. Run `render-qa` with `--gpu` on real hardware. Software rasterisers prove correctness, not speed.
2. Compare one particle against a CPU reference of the same formula (as in section 3).
3. Check `renderer.info.render.calls` stays flat as the count grows.
4. Confirm no stalls: frame time graph must not spike when particles respawn or when the tab regains focus (clamp dt).
5. Dispose on removal: `gpu.dispose()`, geometry, material. Watch `renderer.info.memory.textures` return to baseline.

## 11. Do not do these

- Do not cache render target textures across frames.
- Do not read GPU state back synchronously per frame.
- Do not use `Math.random` for per-frame respawn values in shaders. Hash uv and time uniform.
- Do not raise count before measuring overdraw.
- Do not assume `forceWebGL` gives you WebGPU compute features.

Related: `particle-forces-fields`, `particle-rendering-blending`, `particle-trails-ribbons`, `sim-cache-baking-vat`, `vfx-performance-scaling`, `vfx-graph-authoring`.
