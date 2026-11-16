# Performance

Outcome: the scene fits its tier budget, and the number you report is explained.

1. Pick the tier and read its row in `performance-budget`.
2. Run `render-qa` and read draw calls, triangles, materials and warnings. FPS under SwiftShader is for before and after comparison only. Say so in the reply.
3. Find the single biggest cost: draw calls, triangles, texture memory, transmission, shadows or full-resolution post. Fix that one only.
4. Use the matching skill. Draw calls and triangles: `performance-budget`. Textures: `gltf-asset-pipeline`. Instanced repeats: `mograph-procedural`. Resolution or AA cost: `antialiasing-resolution`. Path tracing cost: `raytracing-light-transport` fallback ladder.
5. Re-measure with the same command. Confirm the picture did not get worse with a `render-qa` screenshot.
6. For a real frame rate, run `render-qa` with `--gpu` on a machine with a GPU. If none is available, say the real number is unverified.

Dispatch `3d-performance-engineer` for steps 3 to 5 when the scene is large.

Reply: before and after table, what limited the number, what changed visually, and what is unverified.
