---
name: physics-rigidbody
description: Realistic physics and rigidbody environments in Three.js. Covers engine choice (Rapier, cannon-es, Ammo, Jolt), fixed-timestep loop with accumulator and render interpolation, a typed mesh-to-body registry, collider choice, mass, friction and restitution ranges for real materials, metre scale, sleeping, CCD against tunnelling, joints, character controllers, raycasts and sensors, stacking stability, determinism, workers, debug draw and a symptom table. Use when objects should fall, collide, stack, roll, hinge or be pushed, when physics jitters, tunnels, explodes or runs in slow motion, or when asked to add physics or rigidbodies. Thai triggers ฟิสิกส์, ชน, ตกกระแทก, วัตถุทะลุ, ของสั่น, วางซ้อนล้ม, ตัวละครเดิน, rigidbody.
argument-hint: "<what should move and collide, and the scene scale>"
---

# Physics & Rigidbody

Physics is a second world that the render world mirrors. Keep them separate: bodies own the truth, meshes only display it. Every body costs budget in `performance-budget`.

## 1. Pick the engine

| Engine | Package | Choose when | Watch |
|---|---|---|---|
| **Rapier** (default) | `@dimforge/rapier3d-compat` | Almost always: CCD, joints, character controller, scene queries, snapshots, documented cross-platform determinism | Needs `await RAPIER.init()`. WASM objects are not garbage collected, call `world.free()` on teardown |
| cannon-es | `cannon-es` | Tiny prototype, pure JS, no WASM step, a few dozen bodies | Weaker stacking and tunnelling control than Rapier (verify for your scene) |
| Ammo | `ammo.js` | You need Bullet features (soft bodies, vehicles) or ship Bullet content | Large download, manual memory on every Ammo object (verify) |
| Jolt | `jolt-physics` (verify package name) | Thousands of bodies, ragdolls, heavy stacking | Larger WASM, verbose API, manual memory (verify) |

Use the `-compat` Rapier build unless your bundler already handles WASM: the docs show it for no-bundler setups. Everything below uses Rapier. The rules in sections 2 to 6 apply to every engine.

## 2. Scale, bodies and the registry

- **Work in metres, kilograms, seconds.** Rapier recommends SI units. A 100 unit wide box is a 100 m wall and falls like it: slow-motion. Scale the scene so a person is about 1.7 and a crate about 0.5 to 1.
- If the scene cannot be metric, set `world.lengthUnit` (units per metre) instead of rescaling (verify behaviour on your scene).
- **One typed registry, never scattered arrays.** Key by `body.handle`, hold mesh, body and the two poses interpolation needs. Everything that moves a mesh goes through it.

```js
/** @typedef {{ mesh: THREE.Object3D, body: RAPIER.RigidBody, asleep: boolean,
 *   prevP: THREE.Vector3, currP: THREE.Vector3, prevQ: THREE.Quaternion, currQ: THREE.Quaternion }} Entry */
/** @type {Map<number, Entry>} */ const registry = new Map();
```

- **The mesh pivot must equal the body origin.** If the pivot is off-centre, offset the collider with `ColliderDesc.setTranslation`, not the mesh.
- **Colliders ignore `mesh.scale`.** Bake scale into the collider dimensions or vertices when you build it.
- Never write `mesh.position` for a dynamic body. Teleport with `body.setTranslation(v, true)`, move kinematics with `setNextKinematicTranslation`.
- Remove with `world.removeRigidBody(body)` and delete the registry entry, then dispose the mesh (see `performance-budget` section 6).

## 3. The loop: fixed step plus interpolation

Never pass the frame `dt` to physics. A variable step changes the result per machine and explodes on long frames. Step at a fixed rate, accumulate leftover time, and blend the last two poses for rendering.

| Setting | Value | Why |
|---|---|---|
| `world.timestep` | `1/60` (Rapier default, set it explicitly) | Must equal the loop's `STEP` or time runs fast or slow |
| Frame clamp | `Math.min(dt, 0.1)` | Tab switch must not queue hundreds of steps |
| Max steps per frame | 5 | Beyond that, drop the debt. Slow motion beats a freeze |
| Render pose | `lerp(prev, curr, acc / STEP)` | Removes stutter on 120 and 144 Hz screens |

Do not change `STEP` per device tier. Cut bodies instead (section 11).

## 4. Minimal scene (verified)

Run headless with `@dimforge/rapier3d-compat` 0.21.0 and `three` 0.187.0: an 8 box tower and a 0.1 m ball dropped from 50 m settled correctly (numbers in section 12).

```js
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export const STEP = 1 / 60;
const MAX_STEPS = 5;

export async function createPhysics({ gravity = -9.81 } = {}) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  world.timestep = STEP;
  const registry = new Map();                       // body.handle -> Entry
  let acc = 0;

  const readPose = (e) => {
    const t = e.body.translation(), r = e.body.rotation();
    e.currP.set(t.x, t.y, t.z);
    e.currQ.set(r.x, r.y, r.z, r.w);
  };

  function add(mesh, bodyDesc, colliderDescs) {
    const body = world.createRigidBody(bodyDesc);
    for (const c of colliderDescs) world.createCollider(c, body);
    const e = { asleep: false, mesh, body, prevP: new THREE.Vector3(), currP: new THREE.Vector3(),
                prevQ: new THREE.Quaternion(), currQ: new THREE.Quaternion() };
    readPose(e); e.prevP.copy(e.currP); e.prevQ.copy(e.currQ);
    registry.set(body.handle, e);
    return e;
  }

  function update(frameDt) {
    acc += Math.min(frameDt, 0.1);
    let n = 0;
    while (acc >= STEP && n++ < MAX_STEPS) {
      for (const e of registry.values()) { e.prevP.copy(e.currP); e.prevQ.copy(e.currQ); }
      world.step();
      for (const e of registry.values()) {
        if (e.body.isFixed()) continue;
        const s = e.body.isSleeping();
        if (!s || !e.asleep) readPose(e);           // one extra read after it falls asleep
        e.asleep = s;
      }
      acc -= STEP;
    }
    if (acc >= STEP) acc = 0;                       // still behind: drop the debt
    const alpha = acc / STEP;
    for (const e of registry.values()) {
      e.mesh.position.lerpVectors(e.prevP, e.currP, alpha);
      e.mesh.quaternion.slerpQuaternions(e.prevQ, e.currQ, alpha);
    }
  }

  function remove(e) { world.removeRigidBody(e.body); registry.delete(e.body.handle); }
  return { RAPIER, world, registry, add, update, remove };
}
```

Usage:

```js
const P = await createPhysics();
const { RAPIER } = P;
P.add(groundMesh, RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
  [RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setFriction(0.8)]);          // half extents, 1 m thick
P.add(boxMesh, RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 2, 0).setCanSleep(true),
  [RAPIER.ColliderDesc.cuboid(0.25, 0.25, 0.25).setDensity(600).setFriction(0.6).setRestitution(0)]);
renderer.setAnimationLoop(() => { P.update(clock.getDelta()); renderer.render(scene, camera); });
```

Rules:
- **`cuboid` takes half extents.** A 0.5 m box is `cuboid(0.25, 0.25, 0.25)`. Matching it to `BoxGeometry(0.5, 0.5, 0.5)` is the most common sizing bug.
- **Add colliders to the body**: `world.createCollider(desc, body)`. A collider without a parent is static.
- For many identical bodies (debris, crates) use one `InstancedMesh` and write `setMatrixAt` from the same interpolated pose, then `computeBoundingSphere()` as in `performance-budget` section 2.

## 5. Colliders and material values

| Collider | Use for | Rules |
|---|---|---|
| `ball`, `cuboid`, `capsule` (also `cylinder`) | Almost everything | Cheapest and most stable. Approximate with these first |
| Compound (several colliders on one body) | L shapes, tables, chairs, vehicles | Prefer over a hull for concave props |
| `convexHull(points)` | Rocks, tools, irregular dynamic props | Convex only. Pass a `Float32Array` of positions, from a decimated mesh (`gltf-asset-pipeline` `simplify`). Check for a `null` return (verify) |
| `trimesh(vertices, indices)` | **Static only**: level geometry, buildings | Never on a dynamic body. Mass needs a closed, consistently wound mesh, and thin triangles tunnel |
| `heightfield(nrows, ncols, heights, scale)` | Terrain | Cheaper than a trimesh for a grid |

- **Colliders are invisible approximations.** Make them slightly smaller than the visual for objects that rest on a surface, and thicker than the visual for floors and walls.
- Zero-thickness shapes have no mass. Never use a plane or lone triangles for a dynamic body.
- Rapier defaults: friction 0.5, density 1.0, restitution 0, friction and restitution combine by `Average` (`setFrictionCombineRule`, `setRestitutionCombineRule`). Because of the average, a high-friction crate on an icy floor lands in between, so set both sides on purpose.

Starting values (guess, tune by watching a drop; real tables vary by surface condition):

| Material | Density kg/m3 | Friction | Restitution |
|---|---|---|---|
| Wood | 500 to 800 | 0.3 to 0.5 | 0.3 to 0.5 |
| Steel | 7800 | 0.4 to 0.7 | 0.3 to 0.6 |
| Concrete, stone | 2400 | 0.6 to 0.8 | 0.05 to 0.2 |
| Rubber | 1100 | 0.8 to 1.2 | 0.7 to 0.9 |
| Glass | 2500 | 0.3 to 0.6 | 0.4 to 0.6 |
| Cardboard, cloth, sand | 100 to 1600 | 0.5 to 0.8 | 0 to 0.05 |
| Ice | 920 | 0.02 to 0.1 | 0.1 to 0.3 |

- **Set `density`, not `mass`**, so mass follows the collider volume. Use `setMass` or `setAdditionalMass` only to force a gameplay weight.
- Keep mass ratios between touching bodies under about 10:1 for stable stacks (guideline). Heavier crushers go on joints or kinematic bodies.
- Restitution above about 0.8 on many bodies never settles and keeps them awake.

## 6. Stability: sleeping, tunnelling, stacking

**Sleeping** (`RigidBodyDesc.setCanSleep(true)`, `body.isSleeping()`, `body.sleep()`, `body.wakeUp()`). A resting body stops costing solver time. Wake it when you change it: pass `true` as the last argument of `setTranslation`, `setLinvel`, `applyImpulse`, `addForce`, `setGravityScale`.

**Tunnelling** happens when `speed x STEP` exceeds the thickness of what it hits.

| Case | Fix |
|---|---|
| Fast small body (bullet, ball, thrown prop) | `RigidBodyDesc.setCcdEnabled(true)` or `body.enableCcd(true)` on that body only |
| Cheaper margin for medium speeds | `setSoftCcdPrediction(distance)` on the desc or body |
| Thin walls or floors | Make the collider 0.2 m or thicker, hide the extra thickness behind the visual |
| Still tunnelling | Cap speed with `setLinvel`, raise `world.integrationParameters.maxCcdSubsteps` |

CCD costs per body. Enable it for projectiles and fast props only, never for the whole scene.

**Stacking** (the standard test of a physics setup):
- Use cuboids, not hulls or trimeshes, and give them friction 0.5 or more.
- Start boxes about 1 mm apart, not interpenetrating and not dropped from height.
- Raise `world.integrationParameters.numSolverIterations` (reads 4 by default in Rapier 0.21) to 8 for towers (guess, measure). Cost grows with it.
- Add `setLinearDamping` 0.01 to 0.1 and `setAngularDamping` 0.05 to 0.5 for rolling objects that never stop.
- Let towers sleep. Do not wake them every frame from gameplay code.

## 7. Joints, character, queries, sensors

**Joints** (`world.createImpulseJoint(params, bodyA, bodyB, true)`):

| Need | Params |
|---|---|
| Rigid weld | `JointData.fixed(frameA, rotA, frameB, rotB)` |
| Ball and socket (ragdoll limb, chain) | `JointData.spherical(anchorA, anchorB)` |
| Hinge (door, wheel) | `JointData.revolute(anchorA, anchorB, axis)` |
| Slider (drawer, piston) | `JointData.prismatic(anchorA, anchorB, axis)` |

Anchors are in each body's local space. Motors: `joint.configureMotorVelocity(targetVel, damping)` and `configureMotorPosition(targetPos, stiffness, damping)` on the revolute or prismatic joint. Joined bodies of very different mass give a soft, stretchy joint.

**Character controller** (kinematic capsule, no ragdoll feel):

```js
const cc = world.createCharacterController(0.01);          // skin offset in metres
cc.enableAutostep(0.3, 0.1, true);                         // max height, min width, include dynamic bodies
cc.enableSnapToGround(0.2);
cc.setMaxSlopeClimbAngle(45 * Math.PI / 180);
const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
const col = world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.3), body);   // half height, radius
// each fixed step:
cc.computeColliderMovement(col, { x: vx * STEP, y: vy * STEP, z: vz * STEP });
const m = cc.computedMovement(), p = body.translation();
body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
// cc.computedGrounded() tells you whether to allow a jump
```
Apply gravity yourself in `vy`. Step the character before `world.step()`.

**Raycasts.** Gameplay and picking use Rapier, not `THREE.Raycaster`, because meshes and colliders differ:

```js
const hit = world.castRayAndGetNormal(new RAPIER.Ray(ray.origin, ray.direction), 100, true);
if (hit) { const body = hit.collider.parent(); /* hit.timeOfImpact, hit.normal */ }
```
`ray.origin` and `ray.direction` from a `THREE.Raycaster` are accepted as plain vectors (checked). `castRay` returns `collider` and `timeOfImpact`.

**Sensors and events.** A sensor reports overlap and does not push.

```js
const eq = new RAPIER.EventQueue(true);
const trigger = world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setSensor(true)
  .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS));
world.step(eq);
eq.drainCollisionEvents((h1, h2, started) => { /* world.getCollider(h1) */ });
```
- Both colliders need `setActiveEvents` for events on a pair (set it on the sensor and on the mover).
- **Events fire when at least one body is dynamic.** A kinematic mover (character) against a fixed sensor gives nothing by default. Add `setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED)` to both colliders (checked headless).
- Filter who collides with whom with `setCollisionGroups(0x000D0004)`: upper 16 bits membership, lower 16 bits filter.

## 8. Determinism and workers

- The Rapier JS build is documented as cross-platform deterministic for the same Rapier version and the same initial conditions. Replays and lockstep netcode need: fixed `STEP`, the same insertion order, the same inputs per step index, no frame `dt` anywhere in the simulation.
- **Seed your initial values.** `Math.sin` and `Math.cos` can differ across platforms, so compute starting transforms with exact numbers or a seeded integer generator, not trig at runtime.
- Compare runs with `world.takeSnapshot()` (a `Uint8Array`) and hash it. `RAPIER.World.restoreSnapshot(bytes)` returns a world, use it for rewind and save states.
- **Worker.** Move the world to a worker when the step exceeds about 20% of the frame budget (`performance-budget`). The worker owns `world`, steps on its own fixed clock, and posts a `Float32Array` of `[x, y, z, qx, qy, qz, qw]` per body by transferring the buffer. The main thread keeps the last two snapshots and interpolates by their timestamps. Commands (spawn, impulse, teleport) go the other way as messages applied before the next step. Shared memory needs cross-origin isolation headers (verify for your host). The registry stays on the main thread and maps an index to a mesh.

## 9. Debug draw

Draw the collider shapes the engine sees, not your meshes. Most physics bugs are a collider of the wrong size or place. Debug only, off by default.

```js
const dbg = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
dbg.frustumCulled = false; scene.add(dbg);
function drawDebug(world) {
  const { vertices, colors } = world.debugRender();          // flat Float32Arrays, colours are RGBA
  const n = vertices.length / 3, rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { rgb[i * 3] = colors[i * 4]; rgb[i * 3 + 1] = colors[i * 4 + 1]; rgb[i * 3 + 2] = colors[i * 4 + 2]; }
  dbg.geometry.dispose();
  dbg.geometry = new THREE.BufferGeometry();
  dbg.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  dbg.geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
}
```
Toggle with a key or `?debug=physics`. Never ship it enabled, it allocates every frame.

## 10. Failure symptoms

| Symptom | Likely cause | Fix |
|---|---|---|
| Objects pass through floor or walls | Speed x STEP above thickness, thin collider, trimesh | CCD on the fast body, thicken the collider, section 6 |
| Jitter or vibration at rest | Variable `dt`, overlapping start poses, low solver iterations, restitution on stacks | Fixed step, spawn without overlap, `numSolverIterations` 8, restitution 0 |
| Visual stutter though physics is fine | No interpolation, or mesh written directly | Section 3 interpolation, write only through the registry |
| Objects explode or fly apart | Overlapping spawn, huge mass ratio, NaN input, runaway joint | Spawn apart, rebalance mass, guard inputs with `Number.isFinite`, add damping |
| Everything feels slow, floaty, like the moon | Scene in centimetres or hundreds of units, `timestep` below the loop `STEP` | Rescale to metres, one `STEP` constant for both |
| Everything too fast on 144 Hz | Stepping once per frame or `dt` mismatch | Accumulator loop |
| Freeze after tab switch | Unclamped `dt` | `Math.min(dt, 0.1)` and `MAX_STEPS` |
| Tower slowly leans and falls | Friction too low, few solver iterations, hull colliders, never sleeps | Cuboids, friction 0.5 or more, 8 iterations, `setCanSleep(true)` |
| Body stuck in the air, ignores a move | Asleep | Pass `wakeUp = true` |
| Body does not fall | Not dynamic, gravity scale 0, locked translations, zero mass from a plane collider | Check body type and collider volume |
| Character slides on slopes or snags on steps | No autostep or snap | `enableAutostep`, `enableSnapToGround`, slope angles |
| No sensor events | Missing `setActiveEvents`, or kinematic against fixed | Section 7 |
| Memory climbs | Bodies removed from the world but not the registry, `free()` never called | `remove(e)` always, `world.free()` on teardown |
| Mesh and collider drift apart | Collider ignores `mesh.scale`, mesh pivot off-centre | Section 2 |

## 11. Performance

Tie every choice to the tier table in `performance-budget`.

- **Physics gets a slice of the frame.** Measure `performance.now()` around `world.step()`. Starting target (guess, measure): at most 20% of the frame budget, so about 3 ms at 60 fps.
- **Cost drivers**, most to least: awake dynamic body count, solver iterations, CCD bodies, contacts per body, trimesh triangles in contact range.
- **Cut cost without cutting `STEP`:** let bodies sleep, `setEnabled(false)` on bodies far from the camera, cull spawned debris after a lifetime, replace distant physics props with static meshes, merge dynamic clutter into fewer compound bodies.
- **Draw calls are separate.** 500 crates as separate meshes break the draw-call budget long before the physics does. Use `InstancedMesh` and write matrices from the registry.
- Read poses only for awake bodies (the sample does, with one extra read after sleep). Reuse the `Vector3` and `Quaternion` temporaries.
- Teardown: `world.free()`, and free `EventQueue` and character controllers you created (verify `free` per type). Check `renderer.info.memory` returns to baseline on route change.
- Step at the same time each frame, before render, never inside event handlers.

## 12. Verify

Physics fails slowly, so test over time, in numbers and in pictures.

1. **Numeric drop and stack test, headless** (Node, no renderer): build the section 4 scene with an 8 box tower (0.5 m cubes, density 600, friction 0.6) and a ball (`radius 0.1`, CCD on) dropped from 50 m, run 600 steps, assert:

| Check | Pass | Measured (Rapier 0.21.0) |
|---|---|---|
| Top box y vs ideal stack height | within 0.05 m | 0.015 m low |
| Horizontal drift of any box | under 0.02 m | 0.006 m |
| Max speed of tower after 6 s | under 0.01 m/s | 0 |
| Tower asleep by 10 s | true | true |
| Ball lowest y | at least radius minus 0.02 | 0.093 for radius 0.1 |

Rerun the same test whenever you change `STEP`, solver iterations, material values or Rapier version. Add a second run with the same inputs and compare snapshot hashes (`takeSnapshot`) if the project needs determinism.

2. **Screenshots through `render-qa`.** Real-time capture is unreliable because SwiftShader renders at 5 to 15 fps and the loop clamps time. Make the scene read `?simt=<seconds>`, call `update(STEP)` that many times before setting `window.__sceneReady = true`, then:

```bash
node <skill-dir>/scripts/render-check.mjs scene.html --out qa-t0 --query "simt=0" --angles 2 --no-mobile
node <skill-dir>/scripts/render-check.mjs scene.html --out qa-t3 --query "simt=3" --angles 2 --no-mobile
node <skill-dir>/scripts/render-check.mjs scene.html --out qa-t10 --query "simt=10" --angles 2 --no-mobile
```
   Compare the three: the tower stands, nothing floats or sinks into the floor (rubric item 4, grounding), no object left the world, no console errors. Turn on the section 9 overlay for one run to confirm collider size.
3. **Perturb.** Apply one impulse to the tower top, rerun the numeric test. It must topple convincingly and settle asleep, not jitter forever.
4. Report the physics step time and awake body count next to the `render-qa` calls and triangles.
