---
name: render-qa
description: Automated render quality gate for Three.js scenes — headless screenshots from multiple orbit angles plus a phone viewport and dark mode, exposure/contrast/clipping analysis, renderer and material configuration checks (tone mapping, colour spaces, environment, shadows, pixel ratio, cheap materials), draw-call/triangle budgets, console errors, and a visual critique rubric. Use before calling any 3D work done, after every significant visual change, or when asked to review, critique, screenshot or verify a 3D scene.
---

# Render QA

Never declare a 3D scene finished without looking at it. This skill renders it, measures it and critiques it.

## 1. Run the checker

`scripts/render-check.mjs` sits next to this file. It needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` if missing).

```bash
node <skill-dir>/scripts/render-check.mjs path/to/scene.html --out qa-out
node <skill-dir>/scripts/render-check.mjs path/to/scene.html --out qa-out-dark --dark --no-mobile --angles 0
node <skill-dir>/scripts/render-check.mjs http://localhost:5173 --out qa-out --query tier=low
```
Options: `--angles n` (orbit shots, default 4), `--size 1280x720`, `--no-mobile`, `--dark`, `--query "tier=high"`, `--wait ms`, `--timeout ms`, `--gpu` (real GPU instead of SwiftShader), `--offline-three <node_modules/three>` (serve CDN three@x requests locally in sandboxes that block CDNs).

Outputs `qa-out/report.md`, `report.json`, and PNGs (`01-hero`, `0N-orbit-*`, `99-mobile`). Exit code 1 = blocking issues.

Scene contract (template already does this):
```js
window.__three = { THREE, renderer, scene, camera, controls, composer, tier };
window.__sceneReady = true;   // after assets load and a frame is drawn
```
The script pauses the page's `requestAnimationFrame` loop between shots so even slow CPU-rendered scenes screenshot reliably.

## 2. What it checks automatically

**Blocking:** console/page errors, failed requests, blank frames (no contrast).
**Warnings:** low subject contrast (centre std < 28), > 8% blown highlights, > 15% crushed blacks (40% in `--dark`), overall too dark/bright, wrong `outputColorSpace`, no tone mapping, no `scene.environment`, shadows off, pixel ratio > 2, `MeshBasic/Lambert/Phong/Normal` materials, over-budget draw calls/triangles, colour textures not sRGB / data textures sRGB, low texture anisotropy, meshes without normals, no shadow casters.

## 3. Then look at every screenshot yourself

Read each PNG and score 1–5 on this rubric. Anything < 4 goes on the fix list.

| # | Criterion | 5 looks like |
|---|---|---|
| 1 | Silhouette & form | Clear read at thumbnail size, smooth curves, bevelled edges |
| 2 | Materials | Each surface identifiable (metal vs ceramic vs glass) with believable roughness |
| 3 | Lighting | Defined key direction, rim separation, no flat or muddy areas |
| 4 | Grounding | Contact shadows/AO; nothing floats |
| 5 | Exposure & colour | No clipping, palette matches brief, whites aren't grey, blacks aren't crushed |
| 6 | Composition | Subject well placed, breathing room, good on the phone shot |
| 7 | Artifacts | No acne, banding, halos, AO slabs, z-fighting, aliasing shimmer |
| 8 | Consistency across angles | Every orbit shot still looks intentional |
| 9 | Dark/light theme | Both look designed (when the page supports both) |
| 10 | Performance | Within tier budget in the report |

## 4. Fix loop

1. List the top 3 issues by visual impact, each with the concrete parameter change (e.g. "bloom threshold 1.6 → 4.0, emissive 6 → 14").
2. Apply, re-run, compare numbers and images with the previous run.
3. Max 3 loops; then report remaining issues honestly.

## 5. Known false positives / limits

- **FPS** under SwiftShader (default) is CPU rendering, typically 5–15 fps — compare runs, don't report it as real performance. Use `--gpu` on a machine with a GPU.
- Dark, moody scenes legitimately have many dark pixels — run with `--dark` or judge visually.
- Minimal compositions on a flat backdrop have low *full-frame* contrast; the *subject* (centre) contrast is what's checked.
- Verified real bug the checker helped find: GTAO + texture `scene.background` → dark slabs (fix in `post-processing-stack`).
