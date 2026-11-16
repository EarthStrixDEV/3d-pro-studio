# Fix visual bug

Outcome: the defect is gone in a rendered screenshot, and the cause is named.

1. Reproduce first. Run `render-qa` at the angle, viewport and theme where it appears. Keep the failing screenshot.
2. Match the symptom, then load only that skill.

| Symptom | Skill and section |
|---|---|
| Dark rectangles around objects with AO on | `post-processing-stack`, ambient occlusion gotchas |
| Whole frame glows | `post-processing-stack`, bloom threshold |
| Striped shadows, or a gap under objects | `lighting-ibl-shadows`, shadows bias |
| Grey, flat, washed out, objects float | `lighting-ibl-shadows`, diagnosis table |
| Plastic or CG looking surface | `pbr-lookdev` |
| Model loads black or the wrong scale | `gltf-asset-pipeline`, post-load normalisation |
| Jagged edges, sparkle or crawl while orbiting | `antialiasing-resolution` |
| Faceted silhouette, blurry texture up close | `mesh-texture-upscale` |
| Shader fails to compile or looks wrong | `shader-craft`, then `3d-shader-engineer` |
| Objects jitter, tunnel or explode | `physics-rigidbody` |
| Labels overlap, pop or clip | `hud-ui-labels` |

3. State the root cause in one sentence before editing. If two fixes in a row fail, write down the premise they share and test it directly.
4. Change one thing. Re-run `render-qa` at the same angle. Compare with the failing screenshot.
5. Check two other angles and the phone viewport for regressions.

Reply: the cause, the one change, before and after crops, and any related symptom you saw but did not fix.
