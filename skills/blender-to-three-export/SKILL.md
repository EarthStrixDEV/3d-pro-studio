---
name: blender-to-three-export
description: Blender to glTF to Three.js export workflow, with notes for Maya. Covers exporter settings (`bpy.ops.export_scene.gltf`), applying modifiers and the shape key conflict, Principled BSDF to glTF PBR mapping and what never exports (procedural shader nodes must be baked), +Y up and metre units, shape keys to morph targets, animation export modes (actions, NLA tracks, sampling), custom properties to `extras` and `userData`, KHR extensions (clearcoat, transmission, volume, emissive strength, texture transform), headless export with `blender -b -P script.py`, a validated export script pattern, and exporting from Maya through third-party tools or FBX. Use when a Blender model arrives dark, flat, wrong colour, wrong scale or rotated, missing textures, materials or animation, when shape keys or custom data vanish, when automating export in CI, or when asked to export from Blender or Maya for the web. Thai triggers ส่งออก glTF, export จาก Blender, โมเดลเข้า three.js แล้วดำ, texture หาย, scale ผิด, shape key หาย, อนิเมชันไม่มา, Maya export.
argument-hint: "<the .blend or Maya scene, what breaks after export, and the Three.js version>"
---

# Blender to Three.js Export

Blender is not a glTF editor, so the export keeps what it recognises and drops the rest. Build the scene for the exporter: standard node layout, baked procedural data, applied transforms. Then compress in `gltf-asset-pipeline`, never in Blender.

Facts below come from the glTF-Blender-IO manual and source (`main`, add-on version 5.4.x, written for Blender 5.3) and the Three.js r187 `GLTFLoader` source. Older Blender releases differ: the script in section 9 reports parameters your build does not have. Blender was not installed on this machine, so no export was run here.

## 1. What breaks, and where to look

| Symptom in Three.js | Likely cause | Section |
|---|---|---|
| Whole model black or dark | No `scene.environment` or lights, or metalness 1 with no environment | `lighting-ibl-shadows`, `gltf-asset-pipeline` section 4 |
| Colour textures washed out or too dark | Colour data in a non-colour texture, or reverse | Section 4 |
| Procedural or noise material is flat grey or one colour | Procedural nodes do not export | Section 4 |
| Model lying on its side, mirrored or rotated | Axis option off, or unapplied rotation | Section 3 |
| Model 100 times too big or small | Scene unit scale, centimetres, or unapplied scale | Section 3 |
| Shape keys gone | Apply Modifiers is on | Sections 5 and 6 |
| Animation missing | Action not stashed, wrong animation mode | Section 7 |
| Custom data missing in `userData` | Custom Properties option off | Section 8 |
| Plastic look where Blender had coat or glass | Extension nodes not wired as the exporter expects | Sections 4 and 9 |
| Mesh has no UVs or `TEXCOORD_1` | UV Map node not on the texture, or export UVs off | `uv-unwrap-packing` section 6 |
| File is huge | Uncompressed PNG, uncompressed meshes | `gltf-asset-pipeline` section 2 |

## 2. Prepare the scene

Before touching the exporter:

1. **Apply Object transforms.** Scale and rotation applied (`object.transform_apply(location=False, rotation=True, scale=True)`), so a 2 by 2 by 2 cube is 2 m, not scale 100 on a 0.02 mesh. Negative scale produces flipped faces.
2. **Real-world size and origin.** Origin at the pivot you want in Three.js (base centre for props). Object origin becomes the node origin.
3. **One material per surface, one slot per primitive.** Each material slot becomes a glTF primitive, so each costs a draw call (`performance-budget`).
4. **Triangle count and UVs final** (`sculpt-retopology-workflow`, `uv-unwrap-packing`). Quads and n-gons are triangulated on export, so triangulate yourself before baking to keep the bake and runtime diagonals equal.
5. **Hard edges and UV seams cost vertices.** Discontinuous UVs and flat-shaded edges split vertices (manual), so counts in Three.js are higher than in Blender.
6. **Curves and other non-mesh data are not preserved** (manual). Convert with `bpy.ops.object.convert(target='MESH')`.
7. **Bake what the exporter cannot read** (section 4).
8. **Delete the unneeded:** cameras, lights, empties and helper objects, or set `use_selection` / `use_visible` (section 9).

## 3. Axes and units

- **+Y up:** `export_yup` is on by default (verified in the add-on source). It rotates Blender's Z-up to glTF's Y-up. Leave it on. Never fix axes by rotating the loaded scene in Three.js: bake correct data.
- **Front of the model:** the glTF spec says the front of an asset faces +Z, and +Y is up (verified in the spec text). A Blender object whose front faces -Y arrives facing +Z, which faces a default Three.js camera on +Z. `gltf-asset-pipeline` section 4 says the front faces -Z and may need `rotation.y = Math.PI`. That contradicts the spec, so check on your asset with a lit shot from the +Z side before rotating anything.
- **Units:** glTF is metres. Blender's default is 1 unit = 1 metre. I found no reference to the scene Unit Scale (`unit_settings.scale_length`) in the exporter files I read, so assume it is ignored (verify with a 1 m cube test). Keep Unit Scale 1.0 and metres. A model authored in centimetres should be scaled and applied, not exported at scale 0.01.
- **Check the result,** not the scene:

```bash
npx @gltf-transform/cli inspect model.glb
```

Then in Three.js `new THREE.Box3().setFromObject(gltf.scene).getSize(v)` must equal the real-world size.

## 4. Materials: Principled BSDF to glTF

The exporter reads a recognised node layout from the Principled BSDF. Anything else is ignored: it does not evaluate shader graphs, it pattern-matches them. All rows below are from the glTF-Blender-IO manual and exporter source.

| Blender | glTF | Three.js `MeshStandardMaterial` / `Physical` | Rule |
|---|---|---|---|
| Base Color (value or Image Texture) | `baseColorFactor`, `baseColorTexture` | `color`, `map` | Colour texture: sRGB. Alpha from the Alpha socket |
| Metallic and Roughness | One image, roughness in G and metalness in B | `roughnessMap`, `metalnessMap` | Wire the image through Separate RGB (G to Roughness, B to Metallic) and set Non-Color, so the file is copied verbatim. Anything else is repacked at export (slower) |
| Ambient occlusion | `occlusionTexture`, R channel | `aoMap` | Only through the custom node group `glTF Material Output`, input `Occlusion` (Add, Output, glTF Material Output, with Shader Editor Add-ons enabled). It can share the metal and rough image |
| Normal Map node, Tangent Space | `normalTexture` with `scale` from Strength | `normalMap`, `normalScale` | Image Non-Color. Only tangent space exports. Bake with default settings (Tangent, R +X, G +Y, B +Z) |
| Emission (colour, texture, strength) | `emissiveFactor`, `emissiveTexture` | `emissive`, `emissiveMap`, `emissiveIntensity` | Any emissive factor component above 1 adds `KHR_materials_emissive_strength`. The loader sets `emissiveIntensity` from it (verified in source) |
| Alpha | `alphaMode`: OPAQUE, MASK, BLEND | `transparent`, `alphaTest` | Decided from the nodes on Alpha: constant 1 gives OPAQUE, a Math Round (alpha 0 or 1) gives MASK, anything else BLEND. For cutouts use a Round node |
| Backface Culling (EEVEE material settings) off | `doubleSided: true` | `side: DoubleSide` | Inverse of the Blender checkbox |
| Coat Weight, Coat Roughness, Coat Normal | `KHR_materials_clearcoat` | `clearcoat`, `clearcoatRoughness` | Texture: coat in R, roughness in G, Non-Color |
| Transmission Weight | `KHR_materials_transmission` | `transmission` | Texture in R. Keep Alpha Opaque. Needs `KHR_materials_volume` for refraction |
| Volume Absorption node into the Volume output, Thickness on `glTF Material Output` | `KHR_materials_volume` | `thickness`, `attenuationColor`, `attenuationDistance` | Requires transmission. Thickness texture in G |
| Specular IOR Level, Specular Tint (non default) | `KHR_materials_specular` | `specularIntensity`, `specularColor` | |
| IOR | `KHR_materials_ior` | `ior` | Written only when transmission, volume or specular is also used. 1.5 (the default) is omitted |
| Sheen | `KHR_materials_sheen` | `sheen`, `sheenRoughness`, `sheenColor` | Sheen roughness texture in A |
| Anisotropic | `KHR_materials_anisotropy` | `anisotropy`, `anisotropyRotation` | Tangent socket must link to a Tangent node with the normal map's UV map |
| Thin Film (iridescence) with `glTF Material Output` thickness | `KHR_materials_iridescence` | `iridescence`, `iridescenceIOR` | |
| `glTF Material Output` Dispersion | `KHR_materials_dispersion` | `dispersion` | Needs volume |
| Shadeless: Camera Ray mixed in, no Principled BSDF | `KHR_materials_unlit` | `MeshBasicMaterial` | |
| Image Texture with UV Map node and Mapping node | `texCoord`, `KHR_texture_transform` | `texture.channel`, `offset`, `rotation`, `repeat` | Mapping type Point is recommended. Supported: location XY, rotation Z, scale XY. Texture type needs uniform scale |
| Material variants (Variants panel) | `KHR_materials_variants` | Loader supports it | |

**What does not export (bake or accept):**
- Procedural textures: Noise, Voronoi, Wave, Gradient, Musgrave, Brick, Magic, Checker and the node maths that combines them. They have no glTF equivalent. Bake them to images with Cycles Bake (`bpy.ops.object.bake`, signature checked in the API docs) onto the final UVs, wire the baked images as Image Textures, then export. Bake steps are in `texture-baking-pipeline`. The same applies to procedural bump, displacement, vertex colour mixes and mask mixes.
- Bump and Displacement nodes (the manual describes only the Normal Map node), Subsurface (no matching extension in the export list), and any shader arrangement the manual does not describe. Treat unlisted features as not exported (verify with `inspect`).
- Colour management: Filmic or AgX view transforms and exposure do not export. Tone mapping is set in Three.js (`post-processing-stack`, `lighting-ibl-shadows`).
- Lights (when exported they are `KHR_lights_punctual`, units differ between Blender watts and Three.js intensity) and world HDRI. Relight in Three.js, and keep `export_lights` and `export_cameras` off unless a viewer needs them.
- Physics, drivers, constraints (outside transforms and pose bones), particle systems, Grease Pencil, modifiers not applied.

`pbr-lookdev` explains the colour space rules the Three.js side uses. `GLTFLoader` sets texture colour spaces from the material slot, so do not override them after load.

## 5. Mesh and modifiers

| Decision | Setting | Note |
|---|---|---|
| Bake modifiers into the mesh | `export_apply=True` | **Prevents exporting shape keys** (the property description says so). Armature modifiers are not applied by this option |
| Keep shape keys and a modifier | Leave `export_apply` off, apply the modifier by hand where Blender allows it (`object.modifier_apply`) | Blender often refuses to apply a modifier on a mesh with shape keys (verify on your version). Otherwise choose: keys or the modifier result |
| UVs | `export_texcoords=True` (default) | Required if any texture exists |
| Normals | `export_normals=True` (default) | Needed for correct shading |
| Tangents | `export_tangents=False` (default) | Turn on only if normal maps show faceting in Three.js. Otherwise run `gltf-transform tangents` (`gltf-asset-pipeline`) |
| Vertex colours | `export_vertex_color='MATERIAL'` (default) | Exported only when a material uses them. Modes: `MATERIAL`, `ACTIVE`, `NAME`, `NONE` |
| Custom attributes | `export_attributes=True` | Only attributes whose name starts with an underscore. The loader lower-cases unknown names, so `_MASK` arrives as `_mask` |
| Material export | `export_materials='EXPORT'` | Other values: `PLACEHOLDER` (slots kept, no materials), `VIEWPORT`, `NONE` (primitives merged) |
| Images | `export_image_format='AUTO'` | `AUTO`, `JPEG`, `WEBP`, `NONE`. glTF needs PNG or JPEG, other formats are converted. For delivery convert with `gltf-asset-pipeline` (KTX2) rather than here |
| Geometry Nodes instances | `export_gn_mesh` (experimental), `export_gpu_instances` (limited, see manual) | Instances must be meshes without children, all children of one object. Details in `geometry-nodes-procedural` section 8 |

## 6. Shape keys to morph targets

- On by default: `export_morph=True`. Optional `export_morph_normal` and `export_morph_tangent` (names present in the add-on source). Without morph normals, shading stays at the rest pose while the shape deforms.
- Shape key names arrive as `mesh.extras.targetNames`, written whenever there is more than one key block, whether or not Custom Properties is on (source). The loader builds `mesh.morphTargetDictionary` from it (verified in the loader source). The Basis key is not a target.
- Three.js side:

```js
const face = gltf.scene.getObjectByName('Face');                 // the mesh node
const i = face.morphTargetDictionary['smile'];                   // index from targetNames
face.morphTargetInfluences[i] = 0.7;
```

- Every target stores a full set of vertex deltas (and normals when `export_morph_normal` is on), so memory grows with keys times vertices. Export only the keys you drive, and check the budget in `performance-budget`. Facial rigs are in `deformers-blendshapes-morph`.

## 7. Animation

| Setting | Value | Effect |
|---|---|---|
| `export_animations` | True | Master switch |
| `export_animation_mode` | `ACTIONS` (default) | Active actions, and actions stashed on NLA tracks, each become a glTF animation. **An action that is not active or stashed is not exported**. Name comes from the action, overridable by renaming the NLA track |
| | `ACTIVE_ACTIONS` | Everything active merged into one animation |
| | `NLA_TRACKS` | Each NLA track becomes one animation. Use with strip modifiers or several actions per track |
| | `SCENE` | The scene as seen in the viewport baked into one animation or one per object |
| | `BROADCAST` | Compatible actions broadcast to every compatible object |
| `export_force_sampling` | True (default) | Always bake keyframes to samples. Safe, but file size grows. Only `ACTIONS` and `ACTIVE_ACTIONS` modes can write non-sampled curves |
| `export_frame_range` | False | True limits to the playback range |
| `export_frame_step` | 1 | Sample stride. Raise it to shrink size, check the motion |
| `export_optimize_animation_size` | | Present in the add-on source, behaviour not checked here (verify) |

Exports only: object transforms, pose bones (skinning) and shape key values. Animation of materials, lights, physics and other properties is ignored, apart from the experimental animation pointer (`KHR_animation_pointer`).

Three.js side:

```js
const mixer = new THREE.AnimationMixer(gltf.scene);
const clip = THREE.AnimationClip.findByName(gltf.animations, 'Walk');
mixer.clipAction(clip).play();
renderer.setAnimationLoop((ms) => { mixer.update(Math.min((ms - last) / 1000, 1 / 20)); last = ms; renderer.render(scene, camera); });
```

- Name every action and track on purpose. Defaults like `Action.001` leak into the file and into game logic.
- glTF time is in seconds, so Blender's scene frame rate matters while sampling. Set it before export (verify the resulting clip duration).
- Retargeting and mixing characters: `character-animation-retarget`. Skeleton and weights: `rigging-skeleton-ik`. Curve editing: `animation-curves-graph-editor`.
- Compress animation with Meshopt or `gltf-transform resample` (`gltf-asset-pipeline`).

## 8. Custom properties to extras and `userData`

- Set `export_extras=True` (default off). Properties on objects, meshes and materials are written as `extras`. The loader copies `extras` to `userData` on nodes, meshes, materials, cameras, lights, scenes, animations, textures and primitive geometries (the `assignExtrasToUserData` call sites in the loader source).
- Only JSON-friendly values survive: numbers, strings, booleans, lists, simple dictionaries. Blender object references do not.
- Use it to tag gameplay and rendering data: `{"interactive": true, "lod": 1, "castShadow": false, "collider": "box"}`.

```js
gltf.scene.traverse((o) => {
  if (o.userData.castShadow === false) o.castShadow = false;     // from Blender custom property
  if (o.userData.interactive) interactive.push(o);
});
```

- `userData` keys are free-form. Agree on names with the person building the Three.js side. Missing keys read as `undefined`, not an error.
- Do not store large data in extras. Textures and meshes belong in the binary buffers.

## 9. Headless export

Run Blender without a window and execute a script. Arguments after `--` reach the script untouched in `sys.argv` (manual: `--` ends option processing). `--python-exit-code` makes a Python exception return a failing exit code, which a CI job needs.

```bash
blender -b scene.blend --python-exit-code 1 -P export_glb.py -- --out dist/model.glb --selection
```

```python
# export_glb.py
import sys, argparse
import bpy

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--selection', action='store_true')      # export selected objects only
ap.add_argument('--apply-modifiers', action='store_true')
ap.add_argument('--no-extras', action='store_true')
args = ap.parse_args(argv)

wanted = dict(
    filepath=args.out,
    export_format='GLB',                 # GLB, GLTF_SEPARATE
    use_selection=args.selection,
    use_visible=True,
    export_yup=True,
    export_apply=args.apply_modifiers,   # warning: no shape keys when True
    export_texcoords=True,
    export_normals=True,
    export_tangents=False,
    export_materials='EXPORT',
    export_image_format='AUTO',
    export_vertex_color='MATERIAL',
    export_morph=True,
    export_morph_normal=True,
    export_skins=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_force_sampling=True,
    export_extras=not args.no_extras,
    export_cameras=False,
    export_lights=False,
    export_draco_mesh_compression_enable=False,   # compress later, see gltf-asset-pipeline
)

try:
    known = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())   # (verify on your build)
except AttributeError:
    known = None
if known is not None:
    missing = [k for k in wanted if k not in known]
    if missing:
        print('WARNING: this Blender build does not have:', ', '.join(missing))
    wanted = {k: v for k, v in wanted.items() if k in known}

result = bpy.ops.export_scene.gltf(**wanted)
print('export result:', result)
if 'FINISHED' not in result:
    sys.exit(1)
```

Verified: parameter names and enum values were read from the add-on's `__init__.py` on `main` (`export_format` `GLB` and `GLTF_SEPARATE`, `export_image_format`, `export_materials`, `export_vertex_color`, `export_animation_mode`, `export_apply`, `export_yup`, `export_extras`, `export_morph`, `export_force_sampling`, `export_lights`, `export_cameras`, `export_texcoords`, `export_normals`, `export_tangents`, `export_skins`, `export_draco_mesh_compression_enable`, `use_selection`, `use_visible`). Blender's CLI flags (`-b`, `-P`, `--python-exit-code`, `--`) were read from the manual. Not run: Blender is not installed here. `get_rna_type()` is not in the API docs I checked, so it is guarded.

After export always:

```bash
npx @gltf-transform/cli validate dist/model.glb      # errors must be zero
npx @gltf-transform/cli inspect dist/model.glb       # meshes, materials, textures, animations
```

Then compress and deduplicate in `gltf-asset-pipeline`. Do not use the add-on's Draco or Meshopt options for production: the pipeline needs one place to tune quality and the loader setup (`DRACOLoader`, `MeshoptDecoder`, `KTX2Loader`) must match the choice. The add-on has `export_draco_mesh_compression_enable`, `export_meshopt_compression_enable` and gltfpack options, and a KTX option, none of which were run here.

## 10. Extensions: what Three.js reads

Blender writes these extensions (export list in the manual): `KHR_draco_mesh_compression`, `KHR_lights_punctual`, `KHR_materials_clearcoat`, `KHR_materials_transmission`, `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_materials_volume`, `KHR_materials_sheen`, `KHR_materials_specular`, `KHR_materials_anisotropy`, `KHR_materials_dispersion`, `KHR_materials_ior`, `KHR_materials_variants`, `KHR_texture_transform`, `EXT_mesh_gpu_instancing`, `EXT_meshopt_compression`, `KHR_meshopt_compression`, `KHR_animation_pointer`, `EXT_texture_webp`, `KHR_texture_basisu`. The `GLTFLoader` in r187 recognises, among others, all of the `KHR_materials_*` above plus `KHR_materials_iridescence`, `KHR_texture_transform`, `KHR_lights_punctual`, `EXT_mesh_gpu_instancing`, `KHR_draco_mesh_compression`, `EXT_meshopt_compression`, `KHR_meshopt_compression`, `KHR_texture_basisu`, `EXT_texture_webp` and `KHR_animation_pointer` (list from the loader source).

Needs on the Three.js side:

| Extension | Needs | Where |
|---|---|---|
| `KHR_draco_mesh_compression` | `DRACOLoader` with decoder path | `gltf-asset-pipeline` section 3 |
| `EXT_meshopt_compression`, `KHR_meshopt_compression` | `MeshoptDecoder` | same |
| `KHR_texture_basisu` | `KTX2Loader` with `detectSupport(renderer)` | same |
| `KHR_materials_transmission`, `volume` | Extra scene render, count against the transmission row in `performance-budget` | |
| `KHR_lights_punctual` | Loader creates lights. Blender and Three.js intensity units differ (`export_import_convert_lighting_mode`, `SPEC` default) | Prefer relighting in Three.js |
| `KHR_texture_transform` | Nothing. Loader applies offset, rotation and scale to the texture | |

Unknown extensions are ignored by the loader, which is why a feature silently vanishes. Compare the file against the table with `inspect`.

## 11. From Maya

I could not confirm a native glTF exporter in Maya. The Autodesk Community thread I found says it is not native (one reply disagrees), so verify in your version. Tools that turned up in a search, none tested here:

| Route | Tool | Note |
|---|---|---|
| Plugin | `iimachines/Maya2glTF` (Maya to glTF 2.0) | Open source, check its supported Maya versions |
| Plugin | `ThomasCat/glTFMaya` | Import and export of glTF and GLB, claims Maya 2019 to 2027 on Windows. Export through File, Export Selection |
| Plugin | `23d1/Maya-to-glTF-Exporter` | Python exporter for Maya 2026 and later |
| Plugin | `matiascodesal/maya-glTF` | Archived October 2025, read-only. Whole-scene export only |
| Commercial | ProtoTech GLTF Exporter for Maya | Trial of 30 exports over 15 days |
| Indirect | Maya, FBX export, Blender FBX import, then the Blender export in this skill | Materials do not survive FBX well. Re-wire textures in the Blender Principled BSDF (section 4) |

Whichever route: freeze transformations, delete history, set the up axis and units (Maya often Y up already, centimetres by default, so scale to metres), triangulate before baking normals, and use the PBR shader the plugin documents (check its README, I did not read it). Then follow sections 2, 4, 9 and 12 for the result. UVs: `uv-unwrap-packing` section 2 covers Maya UV tools. NURBS must be converted to polygons first (`nurbs-spline-surfaces`).

## 12. Verify

1. `validate`: zero errors. `inspect`: expected mesh, material, texture and animation counts, texture sizes within tier caps (`performance-budget`).
2. Load with the setup in `gltf-asset-pipeline`. `console` clean, no `GLTFLoader` warnings about unsupported extensions or missing attributes.
3. Size check: `Box3` equals the real-world size, front faces the camera, feet on y = 0 (`gltf-asset-pipeline` section 4).
4. Material check, material by material: a flat grey ball with the same environment against a Blender render of the same object (not pixel-equal, different renderers). Look for colour space errors, missing coat or transmission, double-sided surfaces.
5. Animation: `gltf.animations.map(a => a.name)` equals the list you expect. Play each, check loops.
6. Morph targets: `Object.keys(mesh.morphTargetDictionary)`. Extras: print `userData` for a tagged object.
7. `render-qa` at each tier. Max 3 fix loops.
