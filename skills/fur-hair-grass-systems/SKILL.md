---
name: fur-hair-grass-systems
description: Fur, hair and grass for Three.js, translating Maya XGen and Blender hair particles and hair curves into real-time techniques. Covers choosing between instanced grass blades, shell fur, hair cards and strand ribbons, placement from density maps and mesh surfaces, GPU wind with spatial phase and gusts, shell layer shaders, hair card materials with alpha-to-coverage, camera-facing strand ribbons with a minimum pixel width, chunked culling and density LOD, cost per device tier and a symptom table. Use when a scene needs lawns, meadows, fur, pelts, moss, carpet, character hair, beards, feathers or any dense strand-like surface, or when grass looks flat, pops, shimmers, costs too many triangles, or hair looks like plastic cards. Thai triggers หญ้า, ขน, ผม, เส้นผม, ขนสัตว์, สนามหญ้า, ทุ่งหญ้า, hair card, fur shell.
argument-hint: "<what is covered (field, animal, head), camera distance range, and the target device tier>"
---

# Fur, Hair & Grass Systems

Maya XGen and Blender hair render millions of strands offline. Real time fakes them with a few thousand cheap shapes placed where the camera can see. Pick the technique by camera distance, then spend the budget from `performance-budget`.

## 1. Pick the technique

| Target | Technique | Maya and Blender counterpart | Cost driver |
|---|---|---|---|
| Lawn, meadow, field, reeds | **Instanced blades** (section 3) | XGen Core instancing, Blender Hair Curves with Geometry Nodes scatter | Triangles per blade times count |
| Short fur, pelt, moss, carpet, felt on a mesh | **Shell fur** (section 5) | XGen short fur, Blender particle hair with short length | Mesh triangles times shell count, overdraw |
| Head hair, beard, mane, long fur at mid distance | **Hair cards** (section 6) | XGen guides baked to cards | Card count, alpha overdraw |
| Hero close-up strands | **Strand ribbons** (section 7) | XGen splines, Blender Hair Curves | Strand count times points |
| Far away | Colour and normal on the base mesh | n/a | Free |

Rules:
- One technique per distance band. A character gets cards for the body of the hair and ribbons only for the close-up flyaways.
- Never render real strands (a line per hair) at scene scale. Count the strands: 100k strands times 6 points is already 1.2M triangles.
- Anything that can be baked into texture and normal on the base mesh at that distance should be, see `pbr-lookdev`.

## 2. Placement: density maps, surfaces, clumps

XGen "density mask" and Blender vertex-group or texture density become a function from position to 0..1. Scatter by rejection sampling with a **seeded** generator so the field is identical on every load and for every user.

```js
/** Seeded generator (mulberry32). Same seed gives the same field. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Density map (greyscale ImageData, white is dense) as a function of world x, z. The image covers size x size metres centred on 0. */
export function densityFromImageData(img, size) {
  return (x, z) => {
    const u = Math.min(img.width - 1, Math.max(0, Math.floor((x / size + 0.5) * img.width)));
    const v = Math.min(img.height - 1, Math.max(0, Math.floor((z / size + 0.5) * img.height)));
    return img.data[(v * img.width + u) * 4] / 255;
  };
}
```

- A density map is **data, not colour.** Read raw bytes from a canvas (`getImageData`) and never colour-manage it. Author it in the DCC as a plain greyscale image.
- Terrain: pass `heightAt(x, z)` into the scatter so roots sit on the surface (`ocean-terrain-environment` for the height function). Sink roots 1 to 2 cm so slopes never show gaps.
- Scatter on an arbitrary mesh (fur, moss on a rock, hair on a scalp) with `MeshSurfaceSampler` from `three/addons/math/MeshSurfaceSampler.js`. Paint density as a vertex colour in the DCC and use it as the weight. Orient strands along the sampled normal.

```js
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
const sampler = new MeshSurfaceSampler(mesh).setWeightAttribute('color').setRandomGenerator(rng(7)).build();
const p = new THREE.Vector3(), n = new THREE.Vector3();
for (let i = 0; i < count; i++) { sampler.sample(p, n); /* write p and n into your instance data */ }
```

- **Clumping** (XGen Clump modifier, Blender Clump): pick clump centres first, then place strands near a centre and lean their tips toward it by 20 to 60% (guess). Clumped blades read as tufts and hide the instance repetition.
- **Random order matters.** Rejection sampling emits instances in a random order, so the first N instances are a uniform thinning of the field. Section 8 relies on that. Keep it, never sort instances by position.

## 3. Instanced grass

One `InstancedMesh` per chunk. A blade is 5 triangles (3 segments) at hero distance and 1 to 3 triangles far away. Grass is opaque geometry, so it needs no alpha sorting and no alpha-to-coverage.

```js
import * as THREE from 'three';
// plus rng from section 2

/** Tapered blade, `segments` rows, rest curve leaning toward +Z. Height 1, scaled per instance. 3 segments = 7 vertices, 5 triangles. */
export function bladeGeometry({ segments = 3, width = 0.06, lean = 0.12 } = {}) {
  const pos = [], uv = [], idx = [];
  for (let s = 0; s < segments; s++) {
    const t = s / segments, w = width * 0.5 * (1 - t);
    pos.push(-w, t, lean * t * t, w, t, lean * t * t);
    uv.push(0, t, 1, t);
  }
  pos.push(0, 1, lean); uv.push(0.5, 1);                                   // tip
  for (let s = 0; s < segments - 1; s++) { const a = 2 * s; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const a = 2 * (segments - 1); idx.push(a, a + 1, 2 * segments);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createGrass({
  size = 20, count = 40000, seed = 1, segments = 3, bladeHeight = [0.35, 0.8], bladeWidth = 0.06,
  density = () => 1, heightAt = () => 0,
} = {}) {
  const geometry = bladeGeometry({ segments, width: bladeWidth });
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85 });
  const uniforms = {
    uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.35, 0.12) }, uFade: { value: 40 },
    uRoot: { value: new THREE.Color('#2b5a1c') }, uTip: { value: new THREE.Color('#a6d65c') },
  };
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform vec2 uWind; uniform float uFade;
        varying float vH; varying float vRnd;
        float gust(vec2 p) { return 0.5 + 0.5 * sin(dot(p, vec2(0.6, 0.35)) + uTime * 1.4) * sin(dot(p, vec2(-0.2, 0.5)) - uTime * 0.8 + 1.7); }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, 0.35));`)   // up-biased normals hide the flat blade
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec3 rootM = instanceMatrix[3].xyz;
          vec3 rootW = (modelMatrix * vec4(rootM, 1.0)).xyz;           // world root: wind stays continuous across chunks
          vH = uv.y;
          vRnd = fract(sin(dot(rootW.xz, vec2(12.9898, 78.233))) * 43758.5453);
          float g = 0.35 + 0.65 * gust(rootW.xz);
          vec2 push = uWind * g * vH * vH;                             // tip moves most, root not at all
          mvPosition.xz += push;
          mvPosition.y -= length(push) * 0.5;                          // keep the blade length roughly constant
          float fade = 1.0 - smoothstep(uFade * 0.75, uFade, distance(rootW, cameraPosition));
          mvPosition.y = rootM.y + (mvPosition.y - rootM.y) * fade;    // shrink to the ground instead of popping
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRoot; uniform vec3 uTip; varying float vH; varying float vRnd;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(uRoot, uTip, vH) * (0.85 + 0.3 * vRnd);`);   // root to tip gradient doubles as cheap AO
  };
  material.customProgramCacheKey = () => 'grass-v1';

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const rand = rng(seed), m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let n = 0;
  for (let tries = 0; n < count && tries < count * 8; tries++) {
    const x = (rand() - 0.5) * size, z = (rand() - 0.5) * size;
    if (rand() > density(x, z)) continue;
    p.set(x, heightAt(x, z) - 0.01, z);
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    sc.set(1, THREE.MathUtils.lerp(bladeHeight[0], bladeHeight[1], rand()), 1);
    mesh.setMatrixAt(n++, m.compose(p, q, sc));
  }
  mesh.count = n;                                  // fewer than requested if density is sparse
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();                    // culling is wrong without it
  mesh.castShadow = false; mesh.receiveShadow = true;

  return {
    mesh, uniforms, total: n,
    update(t) { uniforms.uTime.value = t; },
    setLod(fraction) { mesh.count = Math.floor(n * THREE.MathUtils.clamp(fraction, 0, 1)); },
    dispose() { geometry.dispose(); material.dispose(); mesh.dispose(); },
  };
}
```

Notes:
- `mesh.count` is a draw-time instance count. Lowering it thins the field uniformly because the instances are in random order (section 2). The bounding sphere stays valid.
- Wind runs in the vertex shader, so a blade costs nothing on the CPU. Never move blades from JS.
- **The mesh must not be rotated.** `uWind` is applied in model space. Translate chunks only (`mesh.position.set(cx, 0, cz)`), the wind phase uses the world root so it is continuous across chunk borders.
- Blades do **not cast shadows**: 40k casters in a shadow pass is expensive and the shadow wind offset would disagree with the visible blade. Receive shadows, and rely on the root-dark gradient for contact shading. If a hero shot needs it, patch `customDepthMaterial` with the same wind (`shader-craft` section 2).
- Colour variety: tint per instance with the hash in the shader (done) or use `setColorAt`. Add a low-frequency patch texture on the ground colour so the field is not a single green.
- Double-sided blades light both faces. The up-biased normal avoids dark backfaces.
- Tall dense grass hides the ground. Fade the ground colour toward the grass root colour so gaps between blades do not read as bare dirt.

## 4. Wind

| Layer | Frequency and scale | Purpose |
|---|---|---|
| Base lean | One direction vector, constant | Everything bends the same way, sells the scene |
| Gusts | Spatial wave travelling across the field (about 0.1 to 0.5 rad/m, 0.5 to 2 rad/s, guess) | Visible bands of wind. `sin(dot(pos, dir) + t * speed)` in the sample |
| Flutter | Per blade phase (hash of root), small, higher frequency | Breaks uniformity. Keep under 10% of the lean |

- **Spatial phase is the whole trick.** A phase of `uTime` alone makes the whole field sway as one block. Always offset by the world position.
- Wind speed ties to the scene: a storm raises `uWind` and `uTime` rate together, calm drops both. One `uWind` for grass, fur, trees (`motion-choreography` for the shared clock).
- Noise texture alternative: scroll a tiling noise map and sample it in the vertex shader by world xz (vertex texture fetch, check `renderer.capabilities.maxVertexTextures`). It gives organic gusts for the price of one fetch per vertex (`shader-craft` for noise snippets).
- Interaction (a character pushing grass): pass a few world-space sphere positions as uniforms and push roots away inside a radius, with the same shrink and recovery as wind. Cap at 4 to 8 pushers (guess).
- Reduced motion: scale `uWind` toward a small constant and stop the gust time (`hud-ui-labels` section 9 for how the reduced-motion query is read).

## 5. Shell fur

The mesh is drawn N times, each copy pushed out along its normal by `layer * length`. A fragment shader keeps a strand-shaped cell of each layer and discards the rest, so the stack reads as a volume of strands. It is the cheapest convincing short fur. Draw one `InstancedMesh` of identity matrices with a per-instance layer attribute.

```js
import * as THREE from 'three';

/** Shell fur for a static or rigidly animated Mesh. Child of `source`, so it follows its transform. */
export function createShellFur(source, {
  shells = 20, length = 0.05, density = 160, thickness = 0.6, root = '#24150c', tip = '#c8935a',
} = {}) {
  const g = new THREE.BufferGeometry();                              // shares the source buffers, adds one attribute
  g.index = source.geometry.index;
  for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, source.geometry.getAttribute(k));
  const layers = Float32Array.from({ length: shells }, (_, i) => (i + 1) / shells);
  g.setAttribute('aLayer', new THREE.InstancedBufferAttribute(layers, 1));

  const uniforms = {
    uLength: { value: length }, uDensity: { value: density }, uThick: { value: thickness },
    uForce: { value: new THREE.Vector3(0, -0.6, 0) },                // gravity plus wind, object space, in fur lengths
    uRoot: { value: new THREE.Color(root) }, uTip: { value: new THREE.Color(tip) },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLayer; uniform float uLength; uniform vec3 uForce;
        varying float vLayer; varying vec2 vFurUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLayer = aLayer; vFurUv = uv;
        transformed += objectNormal * uLength * aLayer + uForce * uLength * aLayer * aLayer;`);   // strands bend more at the tip
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uDensity; uniform float uThick; uniform vec3 uRoot; uniform vec3 uTip;
        varying float vLayer; varying vec2 vFurUv;
        float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec2 cell = vFurUv * uDensity;
        float strandLen = 0.35 + 0.65 * hash21(floor(cell));            // each strand has its own length
        float radius = 0.5 * uThick * (1.0 - 0.8 * vLayer);              // strands taper toward the tip
        if (vLayer > strandLen || length(fract(cell) - 0.5) > radius) discard;
        diffuseColor.rgb *= mix(uRoot, uTip, vLayer);`);
  };
  material.customProgramCacheKey = () => 'shell-fur-v1';

  const mesh = new THREE.InstancedMesh(g, material, shells);
  const I = new THREE.Matrix4();
  for (let i = 0; i < shells; i++) mesh.setMatrixAt(i, I);           // InstancedMesh starts zeroed, not identity
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;                                        // shells grow past the base bounds
  source.add(mesh);

  const _inv = new THREE.Matrix4(), _down = new THREE.Vector3();
  return {
    mesh, uniforms,
    /** Call per frame with world gravity plus wind, e.g. (0, -0.6, 0.2). Converts to object space. */
    setForce(world) { source.updateWorldMatrix(true, false); _inv.copy(source.matrixWorld).invert(); uniforms.uForce.value.copy(_down.copy(world).transformDirection(_inv)); },
    setLod(fraction) { mesh.count = Math.max(1, Math.floor(shells * THREE.MathUtils.clamp(fraction, 0, 1))); },
    dispose() { g.dispose(); material.dispose(); mesh.removeFromParent(); mesh.dispose(); },
  };
}
```

Rules:
- The **source mesh keeps drawing the base layer** in the root colour (`source.material.color` close to `root`). The shells add the strands above it.
- **`setLod` drops the outer shells.** `mesh.count` draws the first N instances, which are the inner layers, so the fur looks shorter, not thinner. For a distance LOD prefer fewer shells with a larger `uThick`.
- **Silhouettes show the layers** at grazing angles. Hide it with a fatter `uLength` fade at the edge, extra fin cards at the outline, or a slight fresnel darkening at the rim. Do not add shells to fix it, it only costs.
- **Strand cells must be at least 2 to 3 px on screen at the closest camera distance.** `density` is cells per UV unit, so cell size in pixels = (UV span in metres / `density`) / (metres per pixel at that distance). Finer than that, strands alias into noise and the fur looks like a smooth sphere. Coarser than about 10 px, they read as quills (a 28 cell sphere at 8 px cells did, in the check).
- UV stretch and seams distort the strand grid. Fix the UVs (`uv-unwrap-packing`) or compute the cell grid from object-space position (triplanar, `shader-craft`).
- Shells use `discard`, so they are hard-edged. With MSAA that is fine. Alpha-to-coverage is not needed.
- Skinned characters are not supported by this sample: an `InstancedMesh` is not skinned. Options: a few `SkinnedMesh` copies bound to the same skeleton (`bind(source.skeleton, source.bindMatrix)`, N draw calls, verify), or hair cards and ribbons for the animated parts (`rigging-skeleton-ik` for the chain bones).
- Cost is `source triangles x shells` plus overdraw of the full-screen silhouette. A 5k-triangle animal at 20 shells is 100k triangles (`performance-budget` section 3).

## 6. Hair cards

Flat strips textured with a bundle of strands, with the alpha channel cutting out the shape. This is the standard real-time hair for characters. XGen and Blender hair curves are authored first, then baked into card strips and an atlas (offline step in the DCC, then `blender-to-three-export` and `gltf-asset-pipeline` for delivery).

```js
const hair = new THREE.MeshStandardMaterial({
  map: hairColor,              // RGBA, alpha is the strand cutout, sRGB
  alphaTest: 0.5,              // hard cutout, writes depth, no sorting
  alphaToCoverage: true,       // smooth edges when the target is MSAA (antialiasing-resolution section 5)
  transparent: false,          // keep depth writes and skip transparent sorting
  side: THREE.DoubleSide,
  roughness: 0.55,
});
```

Rules:
- **Cutout, not blend.** `transparent: true` cards sort wrongly and flicker as the head turns. A glTF material with `alphaMode: MASK` loads as `alphaTest`. Use `BLEND` only for a final soft fringe pass (a second copy of the cards with a low `alphaTest`, `depthWrite: false`, `transparent: true`, drawn after the opaque pass, verify the order in your scene).
- A2C needs an MSAA target. On low and mid tiers without MSAA keep the hard `alphaTest`, and fix thinning with coverage-preserving mips (`antialiasing-resolution` section 5, `mesh-texture-upscale` for mips).
- Card layout: dense inner layer for body, 2 to 3 outer layers of narrower, wispier cards overlapping 30 to 50% (guess). Cards that all share one width read as a helmet.
- Root-dark, tip-light gradient (vertex colour or the texture) fakes self shadowing. Real hair shadows are not worth the cost.
- **Highlights:** `MeshPhysicalMaterial` has `anisotropy` and `anisotropyRotation` for stretched speculars (the properties exist in r187). Whether it reads as hair along card tangents depends on the UV direction, so test it (verify). A Kajiya-Kay model needs a custom shader (`shader-craft`).
- Back faces: `DoubleSide` doubles fragment cost on hair. Use `FrontSide` plus a mirrored duplicate card where you can.
- Triangles: one card strip of 4 segments is 8 triangles. Count the whole head (section 9 table).
- Physics for hair: simulate a handful of guide chains and skin the cards to them, the chain solver is the same as the cloth sample in `cloth-fluid-simulation` (distance constraints on a polyline, pinned root), or use bone chains (`rigging-skeleton-ik`).

## 7. Strand ribbons

For hero close-ups where cards look flat: each strand is a ribbon that always turns toward the camera. Build the geometry once from polylines (hand-authored, exported curves, or `CatmullRomCurve3.getPoints`). Width is in world units with a floor in pixels so far strands never shimmer.

```js
/** Camera-facing ribbons from polylines. strands: THREE.Vector3[][], all with the same point count. */
export function strandRibbons(strands) {
  const P = strands[0].length, S = strands.length;
  const pos = new Float32Array(S * P * 6), tan = new Float32Array(S * P * 6);
  const side = new Float32Array(S * P * 2), t = new Float32Array(S * P * 2), index = [];
  const d = new THREE.Vector3();
  strands.forEach((pts, s) => {
    for (let i = 0; i < P; i++) {
      d.subVectors(pts[Math.min(i + 1, P - 1)], pts[Math.max(i - 1, 0)]).normalize();
      for (let k = 0; k < 2; k++) {
        const v = (s * P + i) * 2 + k;
        pos.set([pts[i].x, pts[i].y, pts[i].z], v * 3); tan.set([d.x, d.y, d.z], v * 3);
        side[v] = k ? 1 : -1; t[v] = i / (P - 1);
      }
      if (i < P - 1) { const a = (s * P + i) * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTangent', new THREE.BufferAttribute(tan, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  g.setIndex(index);
  return g;
}

export const strandMaterial = (width = 0.004) => new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { uWidth: { value: width }, uPxScale: { value: 0.001 }, uRoot: { value: new THREE.Color('#2a1a10') }, uTip: { value: new THREE.Color('#8a5a32') } },
  vertexShader: `
    attribute vec3 aTangent; attribute float aSide; attribute float aT;
    uniform float uWidth; uniform float uPxScale; varying float vT;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec3 tw = normalize(mat3(modelMatrix) * aTangent);
      vec3 sideDir = normalize(cross(tw, normalize(cameraPosition - wp.xyz)));
      float minW = distance(cameraPosition, wp.xyz) * uPxScale * 0.75;       // never thinner than ~1 pixel
      wp.xyz += sideDir * aSide * max(uWidth * (1.0 - 0.85 * aT), minW);
      vT = aT;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: `
    uniform vec3 uRoot; uniform vec3 uTip; varying float vT;
    void main() { gl_FragColor = vec4(mix(uRoot, uTip, vT), 1.0);
      #include <colorspace_fragment>
    }`,
});
// on resize: mat.uniforms.uPxScale.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / renderer.domElement.height;
```

- This material is unlit. For lit hair, derive a shading normal from `sideDir` and `tw` and add a Kajiya-Kay term (`shader-craft`, verify against your look).
- Strands thinner than a pixel alias. The `minW` floor keeps them at about one pixel. Pair with alpha-to-coverage or TAA (`antialiasing-resolution`) for clean edges.
- Cost is `strands x (points - 1) x 2` triangles. 2k strands at 6 points is 20k triangles.
- For many identical strands use instancing plus a noise offset instead of unique polylines.
- `Line2` fat lines (`three/addons/lines/`) are an alternative with constant pixel width but no shading, and heavier than this per strand (verify against your count).

## 8. Culling and LOD

- **Chunk the field.** One `InstancedMesh` per square chunk (10 to 20 m, guess). Frustum culling works per chunk, and each chunk gets its own LOD. A single 100k mesh is never culled.
- **Density LOD by chunk distance**, with hysteresis (about 10%, as in `hud-ui-labels` section 7) so a border does not flicker. Compensate for lost blades by widening the survivors.

| Distance band (guess, scale to the scene) | `setLod` fraction | Blade width multiplier | Blade segments |
|---|---|---|---|
| Near, under 8 m | 1.0 | 1.0 | 3 |
| Mid, 8 to 25 m | 0.4 | 1.5 | 2 |
| Far, 25 to 60 m | 0.12 | 2.5 | 1 |
| Beyond | hidden, ground colour carries the look | | |

- Geometry LOD (segments) means one `InstancedMesh` per LOD with its own blade geometry, built from the same scatter seed. Swap `visible` per chunk.
- The `uFade` shrink in the shader (section 3) removes the visible pop at the last band.
- Fur: `setLod` or toggle the shells off beyond a distance and let the base mesh colour carry it. Cards: swap to a lower-card variant with `THREE.LOD` (`performance-budget` section 3).
- Offscreen and tiny: skip updates for chunks outside the frustum, there is nothing on the CPU to skip for pure shader wind.

## 9. Cost per device tier

Start values (guess, derived by taking about one third of each tier's triangle budget in `performance-budget` section 1, then measure with `renderer.info`).

| | Low (phone) | Mid (laptop) | High (desktop GPU) |
|---|---|---|---|
| Grass blades visible (5 triangles) | up to 20k | up to 50k | up to 100k |
| Blade segments near | 2 | 3 | 4 |
| Grass shadow casting | off | off | optional, one hero chunk |
| Chunk draw calls for grass | 8 to 12 | 16 to 24 | 30 to 40 |
| Shell fur layers | 8 to 12 | 16 to 24 | 32 to 48 |
| Fur base mesh triangles | up to 3k | up to 8k | up to 20k |
| Hair cards (triangles for the whole head) | 3k to 5k | 10k to 15k | 25k to 40k |
| Strand ribbons | none | up to 2k strands (hero only) | up to 8k strands |
| Hair alpha-to-coverage | off, hard `alphaTest` | MSAA 4 if the tier has it | on |
| Wind | vertex shader, 2 gust waves | 2 gust waves plus flutter | plus pushers |

- **Overdraw is the real cost.** Dense grass and shells cover each pixel many times. Test at full pixel ratio, the low tier caps pixel ratio at 1.5 for this reason (`performance-budget` section 1).
- Pick the tier once at load (`render-qa` reports it) and build the field for it. Do not rebuild the field per frame.
- Texture memory for hair atlases follows the same caps as other textures (hero 2048, props 1024, background 512 on low).

## 10. Failure symptoms

| Symptom | Cause | Fix |
|---|---|---|
| Grass looks flat and plastic | Flat colour, flat normals, no variation | Root to tip gradient, per blade tint, up-biased normals, patch colour on the ground |
| Whole field sways as one block | Wind phase without position | Offset by world root (section 4) |
| Wind breaks at chunk borders | Phase uses model-space root | Use `modelMatrix * root` (done in the sample) |
| Field disappears at close angles | Bounding sphere missing or stale | `computeBoundingSphere()` after writing matrices |
| Blades pop at the LOD edge | Hard `count` change and no fade | `uFade` shrink, hysteresis, widen survivors |
| Grass shimmers at distance | Sub-pixel blade width | Widen far blades, fewer segments far, MSAA or TAA |
| Grass floats or sinks on slopes | Root height from the wrong heightfield | Use the same `heightAt` as the terrain, sink 1 to 2 cm |
| Same pattern on every load | `Math.random` in scatter | Seeded `rng` |
| Shell fur looks like stacked slices | Too few layers, grazing silhouette | More layers only near the camera, fin cards, rim darkening |
| Fur grid stretches on seams | UV stretch | Fix UVs or use object-space cells |
| Fur invisible | Shell instances still zeroed matrices, `uLength` too small for the model scale | Identity matrices (done), length relative to model size |
| Hair cards flicker when the head turns | `transparent: true` sorting | `alphaTest` cutout plus A2C (section 6) |
| Hair thins out at distance | Alpha loses coverage in mips | Coverage-preserving mips (`antialiasing-resolution` section 5) |
| Hair looks like a helmet | Uniform cards, one layer | Layered cards, varied width and length, wisps |
| Frame time spikes with fur | Overdraw from shells at full screen | Fewer shells, `setLod`, lower pixel ratio |

## 11. Verify

1. Count first: `renderer.info.render.triangles` and `calls` per tier, against `performance-budget`. Report grass blades, shells and card triangles separately.
2. Numeric checks already run for the samples above (headless Chromium with SwiftShader, three 0.187.0, no console errors, 4 programs compiled): the same seed gives identical matrices, a density map with an empty half places 0 of 20000 blades in it, `setLod(0.25)` removed exactly 75% of the grass triangles (75000 of 100000), wind changed 25863 pixels between two times, shell fur widened the silhouette (81383 against 79959 px in a close-up), 150 strand ribbons (1500 triangles) compiled and rendered, `MeshSurfaceSampler` with a colour weight placed 0 of 500 samples in the zero-weight region. Rerun them when you change a shader.
3. Screenshots through `render-qa` with a close orbit (blade level), a grazing angle on the fur, and the phone shot. Look for slices on the fur silhouette, shimmer on distant grass, and cards turning to cutouts.
4. Take two screenshots one second apart. The field must visibly move and not shear at chunk borders.
5. Check `renderer.info.memory` returns to baseline after `dispose()`.

Not verified in this skill, check before relying on them: skinned fur via shared-skeleton `SkinnedMesh` copies, the two-pass soft fringe for hair cards, `MeshPhysicalMaterial.anisotropy` on card UVs, `Line2` strand cost, TSL or WebGPU versions of the shaders.
