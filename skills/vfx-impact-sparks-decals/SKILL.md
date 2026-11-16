---
name: vfx-impact-sparks-decals
description: Build hit and impact effects in Three.js. Covers hit sparks, bullet and melee impacts, dust puffs, debris chips, surface dependent responses (metal, stone, dirt, wood), normal aligned emitters, projected decals with DecalGeometry (pooled, faded, with a proxy mesh trick) and with a depth reconstructing projected box material that works on moving and skinned surfaces, decal pooling and fade, and camera shake and hit stop hooks, with verified DecalPool, Shake, HitStop and projected decal samples. Use when a request asks for bullet holes, scorch marks, hit sparks, impact dust, footprints, blood or paint splats, scratches, hit reactions, "game feel" on contact, or when decals stretch, z fight, stack up or hitch on spawn. Thai triggers รอยกระสุน, ประกายไฟตอนกระทบ, รอยไหม้, ฝุ่นกระเด็น, เดคัล, แรงสั่นกล้อง, ฮิตสต็อป, ความหนักมือ.
argument-hint: "<what hits what, target surfaces (static, moving, skinned), decal count, and device tier>"
---

# VFX: Impact, Sparks and Decals

An impact is four things in the same 100 ms: a flash or spark burst, dust and debris, a mark that stays, and a hit of weight in the camera and the clock. Particle plumbing: `particle-system-architecture`, forces in `particle-forces-fields`, rendering in `particle-rendering-blending`. A generic decal line also exists in `realtime-engine-features` section 1, this skill goes deeper. The master timeline and shake or hit stop policy live in `vfx-timing-choreography`. Bigger destruction: `rigid-destruction-fracture` and `fluid-sph-3d`.

## 1. Pick the decal method

| Method | Use when | Cost and limits |
|---|---|---|
| `DecalGeometry` (section 4) | Static targets, up to a few dozen decals, lit and shadowed like the surface | CPU cost per spawn scales with the target's triangles (measured 2.4 ms at 1k triangles, 8 ms at 9k, 55 ms at 100k, hitch risk). Output is world space, so the target must not move. Skinned meshes are not supported (it reads the bind pose) |
| Projected box material (section 5) | Moving, skinned or curved targets, many decals, no geometry rebuild | Needs a scene depth texture (extra pass). Flat shaded normal from derivatives, stretches at depth discontinuities |
| Sticky quad on the hit point | Cheap, small decals on flat surfaces | Floats off curved surfaces. Fine for bullet holes on walls and floors |
| Paint into a texture (render target mapped on target UVs) | Persistent paint, blood, tracks on one surface | Needs unique UVs (`uv-unwrap-packing`). Costs texture memory per painted object |
| Particles that stick | Short lived splats, cheap | Not persistent. See `vfx-flipbook-authoring` for splat atlases |

Default: projected box for anything that moves, `DecalGeometry` with a proxy mesh for the static world.

## 2. Surface dependent responses

Tag meshes with `mesh.userData.surface`. One table drives sparks, dust, debris, decal, sound and shake, so adding a material means adding a row. Counts are starting guesses (`RESPONSES` in section 4).

| Surface | Sparks | Dust | Debris | Decal | Notes |
|---|---|---|---|---|---|
| Metal | 12 to 20, bright, long streaks | None | None | Scratch or dent, small | Add a short flash sprite. Ricochet along the reflection |
| Stone, concrete | 4 to 8 | 3 to 6 grey puffs | 2 to 4 chips | Chip with a darker crater | Dust lingers 0.5 to 1 s |
| Dirt, sand | None | 5 to 8 puffs tinted by the surface | 2 chips | Soft crater | Puff colour from the surface albedo, not grey |
| Wood | None | 1 to 3 | 3 to 5 splinters | Splinter hole | Pale chips |
| Glass | Few small sparks | None | 8 to 20 shards, fast | Crack star | Use a decal then `rigid-destruction-fracture` for breakage |
| Water | None | Splash crown, ripples | None | None | Ripples belong to `ocean-terrain-environment` |
| Organic or stylised flesh | None | Mist or splatter | Optional | Splat | Gate by a content setting |

Rules:
- **Tint by the surface.** Dust and debris pick the albedo (sample the hit UV colour or store a per surface colour).
- **Decal size follows the hit.** 0.05 to 0.15 m for bullets, 0.3 to 1 m for explosions and magic. Random roll and a 10 percent scale jitter hide the repetition.
- **Never stack decals.** The pool skips a hit closer than `spacing` to a live decal.

## 3. Sparks, dust and normal aligned emitters

| Layer | Recipe (starting guesses) |
|---|---|
| Sparks | 8 to 24, speed 3 to 9 m/s, cone of 25 to 40 degrees around the reflected direction, life 0.15 to 0.4 s, gravity 6 to 10, additive, ramp white to orange (`vfx-fire-smoke-explosion` ramp), stretch along velocity by `speed * 0.02` |
| Flash | 1 sprite, life 0.05 s, HDR 6 to 10, faces the camera |
| Dust puff | 3 to 6 soft cards, grow 0.1 to 0.4 m, life 0.5 to 1 s, drift along the normal, alpha blended, surface tint |
| Debris | 2 to 5 instanced chips, 2 to 6 m/s, gravity full, life 0.6 to 1.5 s, spin |

Orient the emitter to the surface with the hit normal. Offset it a little along the normal so nothing z fights.

```js
const Y = new THREE.Vector3(0, 1, 0);
const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);   // world normal
emitter.position.copy(hit.point).addScaledVector(n, 0.01);
emitter.quaternion.setFromUnitVectors(Y, n);              // emitter +Y along the surface normal
const bounce = incoming.clone().reflect(n);               // ricochet direction for sparks (incoming is unit length)
```

Mix the cone axis between `n` and `bounce` (`lerp(n, bounce, 0.5)`) for sparks. Fire the whole response from one pooled function, never construct emitters per hit (`particle-system-architecture`).

## 4. Verified sample: decal pool, surface table, shake and hit stop

Verified on three 0.187 with a 980 triangle sphere and six raycast hits: decals land on the hit point (bounding box centre 0.05 m from the hit on a curved surface), a pool of 4 recycles the oldest, a repeated hit is skipped, fades hold, shake decays to zero, hit stop slows then releases.

```js
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

// Surface tag on mesh.userData.surface selects the response. Counts are starting guesses.
export const RESPONSES = {
  metal:    { sparks: 16, dust: 0, debris: 0, decal: 'scratch', shake: 0.15 },
  stone:    { sparks: 6,  dust: 4, debris: 3, decal: 'chip',    shake: 0.2 },
  dirt:     { sparks: 0,  dust: 6, debris: 2, decal: 'crater',  shake: 0.1 },
  wood:     { sparks: 0,  dust: 2, debris: 4, decal: 'splinter', shake: 0.15 },
  default:  { sparks: 4,  dust: 3, debris: 0, decal: 'chip',    shake: 0.1 },
};
export const responseFor = (object) => RESPONSES[object.userData.surface] ?? RESPONSES.default;

const Z = new THREE.Vector3(0, 0, 1), _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _e = new THREE.Euler();

// Pool of decal meshes recycled oldest first. DecalGeometry output is in WORLD space, so the pool
// meshes stay at identity and the targets must be static (moving or skinned targets: projected decal below).
export class DecalPool {
  constructor(scene, { max = 24, life = 12, fade = 3, spacing = 0.03, material }) {
    Object.assign(this, { life, fade, spacing, next: 0 });
    this.slots = Array.from({ length: max }, () => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material.clone());   // own material: own opacity
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 1;
      scene.add(mesh);
      return { mesh, born: -Infinity, point: new THREE.Vector3() };
    });
  }
  spawn(hit, size, now) {                                  // hit: a Raycaster intersection
    for (const s of this.slots) if (now - s.born < this.life && s.point.distanceTo(hit.point) < this.spacing) return null;   // no stacking
    _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);                 // local to world normal
    _q.setFromUnitVectors(Z, _n).multiply(_r.setFromAxisAngle(Z, Math.random() * Math.PI * 2));   // z along the normal, random roll
    const slot = this.slots[this.next]; this.next = (this.next + 1) % this.slots.length;
    slot.mesh.geometry.dispose();                          // the old decal geometry is freed, never leaked
    slot.mesh.geometry = new DecalGeometry(hit.object, hit.point, _e.setFromQuaternion(_q), new THREE.Vector3(size, size, size));
    slot.mesh.material.opacity = 1; slot.mesh.visible = true;
    slot.born = now; slot.point.copy(hit.point);
    return slot.mesh;
  }
  update(now) {
    for (const s of this.slots) {
      const age = now - s.born;
      if (age >= this.life) { s.mesh.visible = false; continue; }
      s.mesh.material.opacity = Math.min(1, (this.life - age) / this.fade);              // linear fade over the last `fade` seconds
    }
  }
  dispose() { for (const s of this.slots) { s.mesh.geometry.dispose(); s.mesh.material.dispose(); s.mesh.removeFromParent(); } }
}

// Trauma shake: add() on every hit, apply to a rig that parents the camera, never to the camera itself.
export class Shake {
  constructor(maxPos = 0.12, maxRot = 0.02) { Object.assign(this, { maxPos, maxRot, trauma: 0 }); }
  add(a) { this.trauma = Math.min(1, this.trauma + a); }
  update(dt, t, rig) {
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const s = this.trauma * this.trauma, n = (k) => Math.sin(t * (31 + k * 17)) * Math.sin(t * (11 + k * 7) + k);   // cheap smooth noise
    rig.position.set(this.maxPos * s * n(0), this.maxPos * s * n(1), 0);
    rig.rotation.z = this.maxRot * s * n(2);
  }
}

// Hit stop: slow game time briefly. Feed it REAL time so it ends on schedule, keep shake and flashes on real dt.
export class HitStop {
  constructor(scale = 0.05) { Object.assign(this, { scale, until: 0 }); }
  trigger(now, ms) { this.until = Math.max(this.until, now + ms / 1000); }
  dt(now, rawDt) { return now < this.until ? rawDt * this.scale : rawDt; }
}
```

Usage:

```js
const pool = new DecalPool(scene, { max: 24, life: 12, fade: 3,
  material: new THREE.MeshStandardMaterial({ map: holeTex, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4 }) });
// on a hit (ray from the weapon):
const hit = raycaster.intersectObject(world, true)[0];
if (hit) {
  const r = responseFor(hit.object);
  pool.spawn(hit, 0.12, now);                     // decal
  shake.add(r.shake); hitStop.trigger(now, 50);   // game feel
  // spawn r.sparks, r.dust, r.debris from your particle pool here
}
// frame: pool.update(now); shake.update(dt, now, cameraRig); dt = hitStop.dt(now, rawDt) for gameplay
```

Rules:
- **`polygonOffset` is required** or decals z fight with the surface. `depthWrite: false` and `transparent: true` for soft edges.
- **Static targets only.** `DecalGeometry` bakes world space vertices and the pool meshes stay at identity. Never parent a decal to a moving object.
- **Proxy mesh for cost.** The constructor reads only `mesh.geometry` and `mesh.matrixWorld` (read from the three source). Pass a low poly proxy with the same `matrixWorld` as the render mesh, and the spawn cost follows the proxy. Keep the proxy surface close to the real one, `polygonOffset` hides small gaps.
- **Normals come from the hit, not the decal.** `hit.face.normal` is in local space, transform it to world as in the sample. A skipped transform tilts decals on rotated meshes.
- **Corners distort.** A decal on a sharp corner stretches (known three.js limitation). Keep decals small near edges or switch to the projected box.
- **Dispose geometry on recycle.** The sample disposes the slot's old geometry before assigning a new one, otherwise `renderer.info.memory.geometries` climbs.
- **Shake the rig, not the camera.** Parent the camera to an `Object3D` rig and apply the offset to the rig (`cinematic-camera-rig`). Trauma squared gives small hits a faint shake and big hits a strong one.
- **Hit stop uses real time.** Feed `HitStop.dt` the unscaled time, and keep shake, flashes and spark creation on real dt so they do not freeze with the world. 40 to 80 ms is the usual range, release is an instant return, not an ease.
- Reduced motion: scale `shake.maxPos` and `maxRot` toward 0 and disable hit stop.

## 5. Verified sample: projected box decal

A unit box, rendered back faces only with depth test off. Each fragment rebuilds the surface behind it from the depth texture, converts it to the box's local space, discards outside the box, and uses local xy as the uv. It follows moving or skinned surfaces automatically. Verified on three 0.187: the decal renders on a sphere, and when the sphere is rotated with the decal as its child the decal follows the surface (its pixel centroid lands within about 25 px of the projected anchor). Skinned targets are not tested (verify).

```js
import * as THREE from 'three';
import { FX_LAYER } from './shield.js';   // the same layer and depth pre-pass as the shield (vfx-magic-energy-stylized)

// Projected decal: a unit box whose fragments reconstruct the surface behind them from the scene depth
// texture, then map it into the box's local space. Works on moving, skinned and curved surfaces, no geometry rebuild.
// +Z of the box is the projection axis. Scale the box to (width, height, depth).
export function createProjectedDecal(texture, { color = 0xffffff, angleFade = [0.3, 0.7] } = {}) {
  const inv = new THREE.Matrix4();
  const material = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide,   // BackSide: still draws when the camera is inside the box
    uniforms: {
      tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.1 }, uFar: { value: 100 },
      uInvMV: { value: new THREE.Matrix4() }, uMap: { value: texture }, uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1 }, uAngle: { value: new THREE.Vector2(...angleFade) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vV;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      #include <packing>
      uniform sampler2D tDepth, uMap; uniform vec2 uRes, uAngle; uniform float uNear, uFar, uOpacity;
      uniform mat4 uInvMV; uniform vec3 uColor;
      varying vec3 vV;
      void main() {
        float z = perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uRes).x, uNear, uFar);
        vec3 pv = vV * (z / vV.z);                                  // view space position of the surface behind this pixel
        vec3 l = (uInvMV * vec4(pv, 1.0)).xyz;                      // decal local space, the box spans -0.5..0.5
        if (any(greaterThan(abs(l), vec3(0.5)))) discard;
        vec3 nv = normalize(cross(dFdx(pv), dFdy(pv)));             // surface normal from depth derivatives
        float facing = smoothstep(uAngle.x, uAngle.y, dot(normalize(mat3(uInvMV) * nv), vec3(0.0, 0.0, 1.0)));
        vec4 t = texture2D(uMap, l.xy + 0.5);
        gl_FragColor = vec4(t.rgb * uColor, t.a * facing * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.layers.set(FX_LAYER); mesh.frustumCulled = false; mesh.renderOrder = 1;
  mesh.onBeforeRender = (renderer, scene, camera) => {            // modelViewMatrix is stale here, build it by hand
    inv.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).invert();
    material.uniforms.uInvMV.value.copy(inv);
  };
  return mesh;   // each frame also set tDepth, uRes, uNear, uFar like the shield does (share one depth pass)
}
```

Use the same depth pre-pass as the shield (`createDepthPass` in `vfx-magic-energy-stylized` section 4, which takes every material that reads the depth texture). Layer the decal onto `FX_LAYER` so the pre-pass skips it.

```js
const decal = createProjectedDecal(holeTex);
decal.position.copy(hit.point); decal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
decal.scale.set(0.3, 0.3, 0.3);                       // depth (z) must cover the surface curvature
scene.add(decal);                                      // or hit.object.add(decal) for a moving target
// frame: depthPass.render(scene, camera, now, decal.material);   // pass all decal materials, share one pass
```

Rules:
- **Depth decode assumes a standard perspective depth buffer** (reversed or logarithmic buffers need another decode, verify).
- **One pass for all decals.** Every decal reads the same depth texture, so the extra scene pass is paid once. Fade by age with `uOpacity` and remove at the end of the pool lifetime.
- **Skinned targets** appear in the depth pre-pass because it renders the normal scene (verify with your rig). Parent the decal to a bone (`rigging-skeleton-ik`) to follow animation.
- **Angle fade hides stretching.** Raise `angleFade` for grazing surfaces to hide smear on steep angles.
- **Fill rate.** Back faces of a large box cover many pixels even when most discard. Keep boxes tight and few on low tier.
- Normals from derivatives are flat per triangle, so decals on normal mapped surfaces ignore the normal map. Fine for dirt and burns.

## 6. Pooling and lifetime

| Rule | Value (starting guess) |
|---|---|
| Max live decals | 24 to 64, 12 low tier |
| Life | 10 to 20 s, fade the last 2 to 3 s linearly |
| Spacing | 0.03 to 0.1 m minimum between decals |
| Recycle order | Oldest first. Prefer reuse over destroy, no per hit allocation of materials |
| Explosions | One large scorch decal plus a few small ones, not 20 small |
| Culling | Decals far from the camera skip updates. Despawn when the area streams out (`scene-assembly-prefabs`) |

## 7. Verify (`render-qa`)

1. Fire at flat, curved, rotated, moving and skinned targets. Each decal sits flush, the right way up, with no float or stretch.
2. Fire 100 hits at one spot: the pool caps, no hitch, `renderer.info.memory.geometries` is flat after warm up.
3. Time a spawn on the largest target. Over about 4 ms (guess) means move to a proxy mesh or the projected box.
4. Screenshot at grazing angles for z fighting and smear.
5. Tint check: stone dust grey, dirt dust brown. A grey puff on dirt is a failure.
6. Timing check: shake and hit stop do not freeze the flash or sparks, and hit stop releases cleanly.
