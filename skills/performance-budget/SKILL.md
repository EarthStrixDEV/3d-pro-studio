---
name: performance-budget
description: Performance engineering for Three.js — device-tier budgets (draw calls, triangles, texture memory), profiling with renderer.info, InstancedMesh, BatchedMesh, geometry merging, LOD, texture compression, shader warm-up, adaptive pixel ratio, on-demand rendering and memory disposal. Use when a scene stutters, drops frames on phones, overheats, loads slowly, leaks memory, or before shipping any high-quality 3D scene.
---

# Performance Budget

Quality that drops to 20 fps is not quality. Budget first, then spend it where the eye looks.

## 1. Budgets per tier (60 fps target, per frame)

| | Low (phones, iGPU) | Mid (laptops) | High (desktop dGPU) |
|---|---|---|---|
| Draw calls | ≤ 100 | ≤ 200 | ≤ 300 |
| Triangles | ≤ 300k | ≤ 800k | ≤ 1.5M |
| Texture memory | ≤ 64 MB | ≤ 256 MB | ≤ 512 MB |
| Shadow-casting lights | 1 @ 1024 | 1 @ 2048 | 1–2 @ 2048–4096 |
| Pixel ratio cap | 1.5 | 1.75 | 2 |
| Post | bloom + AA | + AO | + DOF/grade |
| Transmission meshes | ≤ 1 | ≤ 3 | ≤ 6 |

Measure: `renderer.info.render.calls/triangles`, `renderer.info.memory`, `renderer.info.programs.length`. With a composer, set `renderer.info.autoReset = false` and call `renderer.info.reset()` once per frame, otherwise you only see the last pass. render-qa reports a clean scene-only render.

## 2. Cut draw calls

1. **Share materials** — identical materials should be one instance.
2. **InstancedMesh** for repeats of one geometry (trees, bolts, particles): `setMatrixAt`, `setColorAt`, then `instanceMatrix.needsUpdate = true`. Call `computeBoundingSphere()` after moving instances or culling breaks.
3. **BatchedMesh** (r159+) for many *different* geometries sharing one material.
4. **Merge static geometry** with `BufferGeometryUtils.mergeGeometries` (same material); keep it separate if it needs culling or interaction.
5. Texture atlases / palette textures so more meshes can share a material (`gltf-transform palette`).

## 3. Cut triangles where they don't show

- Silhouette and close-ups need density; flat interiors don't. Decimate with `gltf-transform simplify` or `SimplifyModifier`.
- `THREE.LOD` with 2–3 levels (`lod.addLevel(mesh, distance)`); hysteresis avoids popping (r155+ `addLevel(obj, dist, hysteresis)`).
- Sphere segments: 64×32 is plenty for hero spheres at 1080p; 32×16 for background.

## 4. Textures (usually the real memory hog)

- GPU memory ≈ w × h × 4 bytes × 1.33 (mips). A 4k RGBA = ~89 MB. A phone dies after a few.
- Use **KTX2/Basis** (stays compressed on GPU) — see `gltf-asset-pipeline`. WebP/AVIF only shrink downloads, not VRAM.
- Cap sizes per tier: hero 2048, props 1024, background 512.
- Pack channels (ORM) and reuse tiling textures.

## 5. Frame pacing & startup

- `await renderer.compileAsync(scene, camera)` before revealing the scene → no first-interaction shader hitches.
- Create materials/geometries once; never inside the loop. Reuse `Vector3` temporaries.
- **Adaptive DPR**: measure average frame time over ~1 s; if > 20 ms, step pixel ratio down by 0.25 (floor 1); if < 12 ms for 3 s, step up. Resize composer too.
- **On-demand rendering** for static product viewers: render only on `controls` change / animation, stops fans and saves battery.
- Pause when hidden (`IntersectionObserver`, `visibilitychange`).

## 6. Memory hygiene

Dispose what you remove: `geometry.dispose()`, `material.dispose()`, each texture's `dispose()`, render targets, `pmrem.dispose()`, `composer.dispose()` on teardown. In SPAs watch `renderer.info.memory` climb across route changes — it must return to baseline.

## 7. Profiling workflow

1. Run `render-qa` → read calls/tris/materials/warnings.
2. Real GPU: Chrome DevTools Performance (GPU track) and `about:gpu`; Spector.js to inspect a frame's draw calls.
3. Find the top cost (usually: too many draw calls, oversized textures, transmission, shadows, full-res post) → fix one → re-measure.
4. SwiftShader FPS in headless QA is CPU rendering — use it only to compare before/after, never as the real number.
