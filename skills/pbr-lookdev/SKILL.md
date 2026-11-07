---
name: pbr-lookdev
description: Physically based material look-development for Three.js — MeshStandard/MeshPhysical parameters (clearcoat, transmission, sheen, iridescence, anisotropy, dispersion), real-world value ranges, texture colour spaces, roughness breakup, procedural textures and material libraries. Use when materials look plastic, flat, CG or wrong, or when creating metal, glass, ceramic, fabric, car paint, skin-like, wood or stone surfaces.
---

# PBR Look-dev

Good materials are 70% of "looks expensive". Work through this in order.

## 1. Pick the right material class

| Need | Use |
|---|---|
| Most surfaces | `MeshStandardMaterial` (cheaper) |
| Clearcoat, glass/liquids, fabric sheen, iridescence, brushed metal, gemstones | `MeshPhysicalMaterial` |
| Stylised but lit | `MeshToonMaterial` with a gradient map — only if the brief is stylised |
| Never for hero surfaces | `MeshBasic`, `MeshLambert`, `MeshPhong`, `MeshNormal` |

Without `scene.environment` set, every PBR material looks dull — fix lighting first if it is missing (`lighting-ibl-shadows`).

## 2. Rules that separate pro from amateur

- **Metalness is binary.** 0 for dielectrics, 1 for bare metal. Values in between only on masks (dirt over metal).
- **Albedo is never pure white or black.** Keep base colour roughly within sRGB 30–240 (linear ≈ 0.02–0.85). Snow ≈ 0.85, charcoal ≈ 0.04.
- **Metal colour lives in `color`**, not in an emissive or a light. Gold `#E6B85C`-ish, copper `#D9895B`, aluminium `#D6D8DB`, iron `#9EA1A3`.
- **Roughness carries realism.** A single flat roughness value reads as CG. Break it up with a subtle noise/smudge `roughnessMap` (±0.05–0.15).
- **Edges catch light.** Bevelled geometry + clearcoat or a fresnel-driven roughness change sells "manufactured object".
- **Colour textures (`map`, `emissiveMap`, `sheenColorMap`, `specularColorMap`) → `SRGBColorSpace`. Data textures (normal, roughness, metalness, AO, displacement) → leave as `NoColorSpace`.** render-qa flags violations.
- Set `texture.anisotropy = renderer.capabilities.getMaxAnisotropy()` on every tiled colour map viewed at grazing angles (floors, tables).
- Prefer a packed ORM texture (R=AO, G=roughness, B=metalness) and assign it to `aoMap`, `roughnessMap`, `metalnessMap` — one texture fetch, glTF-standard.
- `aoMap` uses `uv` (r152+); no second UV set needed unless your asset says otherwise.

## 3. MeshPhysicalMaterial features — when and how

| Feature | Params | Use for | Notes |
|---|---|---|---|
| Clearcoat | `clearcoat` 0.5–1, `clearcoatRoughness` 0.03–0.15 | Car paint, lacquer, glazed ceramic, varnished wood | Adds a second specular lobe; cheapest "premium" upgrade |
| Transmission | `transmission` 1, `thickness` (world units), `ior` 1.33–1.6, `roughness` 0–0.2 | Glass, liquids, ice, gems | Extra render of opaque scene; keep count low. Set `attenuationColor` + `attenuationDistance` for tinted thick glass |
| Dispersion | `dispersion` 0.1–1 (r166+) | Diamonds, prisms | Needs transmission; subtle values |
| Sheen | `sheen` 0.3–1, `sheenRoughness` 0.3–0.8, `sheenColor` | Velvet, cloth, peach-fuzz, soft-touch plastic | Lifts grazing angles |
| Iridescence | `iridescence` 1, `iridescenceIOR` 1.3, `iridescenceThicknessRange` [100, 400] | Soap bubbles, oil film, beetle shells, anodised metal | Stay subtle — 0.3–0.6 for anodised |
| Anisotropy | `anisotropy` 0.3–1, `anisotropyRotation` | Brushed metal, hair, satin, CDs | Needs tangents; smooth UVs; works best with a strong environment |
| Specular | `specularIntensity`, `specularColor` | Tuning dielectric reflectance | Defaults are fine for most surfaces |

## 4. Procedural textures without files

For single-file artifacts, generate maps on a `<canvas>` and wrap in `THREE.CanvasTexture`:
- **Roughness breakup:** fill mid-grey, overlay 2–3 octaves of soft noise at 5–10% opacity. Set `colorSpace = NoColorSpace`.
- **Brushed metal:** draw thousands of 1 px horizontal lines with random alpha, then set `anisotropy` on the material.
- **Tiles/planks:** draw the pattern on canvas for `map` and a matching height pattern for `bumpMap` (tune `bumpScale` against a screenshot).
- Use `wrapS = wrapT = RepeatWrapping` and `repeat.set(n, n)`; 512–1024 px is plenty.
Shader-based procedural surfaces (triplanar, noise-driven colour) → `shader-craft`.

## 5. Material library

`references/material-library.md` holds tested starting values for ~20 common materials. Start from the nearest entry, then adjust against a screenshot — never against the number alone.

## 6. Look-dev loop

1. Neutral grey environment + one key light. Judge materials on a sphere and on the real mesh.
2. Change one parameter family at a time (colour → roughness → specular features).
3. Screenshot from 3 angles via `render-qa` — materials that look right head-on often fail at grazing angles.
4. Check both light and dark backgrounds if the page supports both.
