# Asset prep

Outcome: a delivery-ready GLB and texture set inside the asset budget, with no visible quality loss.

1. Inspect and validate the source with `gltf-asset-pipeline` before touching it. Keep the original next to the output. Never process an already processed file.
2. Decide the problem. Too big: compress per `gltf-asset-pipeline`. Too soft up close: `mesh-texture-upscale`. Too faceted: `mesh-texture-upscale`, mesh section.
3. Apply per-map rules for textures. Colour maps tagged sRGB. Data maps never AI upscaled.
4. Load the result in the pro scene template with the loader setup from `gltf-asset-pipeline`. Normalise scale and orientation.
5. Run `render-qa` including a close orbit. Compare crops at 100% against the original.
6. Check the budget: hero 5 MB or less, props 500 KB or less each, textures within the tier cap in `performance-budget`.

Reply: sizes before and after, what was compressed or upscaled and how, crops, and the original file path.
