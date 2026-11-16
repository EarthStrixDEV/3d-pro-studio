# Surface and bake

Outcome: a hero asset with clean UVs, baked maps that read correctly under the scene lighting, and a colour pipeline that matches the source tool.

1. Settle the form first. Sculpt then retopo with `sculpt-retopology-workflow`. Curve-based or CAD-like shapes use `nurbs-spline-surfaces`. Scattered detail uses `geometry-nodes-procedural`. Never bake on geometry that will still change.
2. Unwrap and pack with `uv-unwrap-packing`. Check stretch with a checker texture and keep one texel density.
3. Bake with `texture-baking-pipeline`. Check the normal map convention (green channel, tangent basis) on a lit sphere before trusting it.
4. Build the material with `pbr-lookdev`. For a stylised brief use `npr-toon-outline` instead of PBR realism.
5. Match colour to the source with `color-management-grading`. Decide the view transform once and keep it.
6. Debug with `render-passes-aov` views (normals, UVs, overdraw) when something looks wrong. Do not guess.
7. Export with `blender-to-three-export` and compress with `gltf-asset-pipeline`.
8. Run `render-qa` including a close orbit. Compare crops at 100% against the source render.

Reply: before and after crops, the bake settings used, the convention check result, and anything that could not be matched to the source tool.
