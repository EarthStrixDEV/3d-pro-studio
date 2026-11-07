---
name: lighting-ibl-shadows
description: Advanced lighting for Three.js — image-based lighting (PMREM, RoomEnvironment, HDRI/EXR), studio and cinematic light rigs, physically based intensities, tone mapping choice and exposure, high-quality shadows (bias, frustum fitting, PCFSoft vs VSM, cascaded shadows, contact shadows, shadow catchers) and grounding. Use when a scene looks flat, floaty, too dark/bright, has shadow acne, peter-panning, jagged or missing shadows, or needs a studio/product/cinematic lighting setup.
---

# Lighting, IBL & Shadows

## 1. Environment first, lights second

PBR surfaces reflect their surroundings. With no environment they look like grey plastic no matter how many lights you add.

```js
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // procedural studio, zero downloads
scene.environmentIntensity = 0.45;   // r163+. Fill level — the key light must still dominate
pmrem.dispose();
```

HDRI (better reflections, real-world mood):
```js
new RGBELoader().load('studio_small_09_1k.hdr', (hdr) => {     // HDRLoader in newer revisions
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr;                                     // three PMREMs it internally
  // scene.background = hdr; scene.backgroundBlurriness = 0.4; // optional, blurred backdrop
});
```
- 1k HDR is enough for lighting; 2k–4k only if visible as a background.
- Rotate the environment with `scene.environmentRotation` (r162+) to move the main reflection highlight instead of moving the object.
- For an HDRI ground that objects sit on, use `GroundedSkybox` (addons/objects).

## 2. Light rigs

**Studio product (default in the template):**
| Light | Type | Position | Intensity | Shadow |
|---|---|---|---|---|
| Key | Directional, warm `#FFF1E0` | high front-side (4, 7, 3) | 3.0–3.5 | yes |
| Rim | Directional, cool `#C9DCFF` | behind opposite side (-5, 4, -6) | 1.5–2 | no |
| Fill | Hemisphere or env only | — | 0.1–0.3 | no |

**Softbox reflections:** `RectAreaLight` (+ `RectAreaLightUniformsLib.init()`) gives long rectangular highlights on glossy objects. Standard/Physical only, no shadows — pair with the shadow-casting key.

**Cinematic / moody:** one strong key at 60–90° to camera, env intensity ≤ 0.2, coloured rim, fog to separate depth layers, exposure 0.8–1.0.

**Interior / architectural:** HDRI or baked lightmap carries most of the light; point/spot lights only for practicals; consider baking (`lightMap`) when the scene is static.

Rules:
- One shadow-casting light is usually enough. Each extra one is another full scene render.
- Lights have physical units (r155+): Point/Spot in candela with `decay = 2`. Large scenes in metres need large intensities — that is expected.
- Colour temperature contrast (warm key, cool rim) does more for depth than intensity.

## 3. Tone mapping & exposure

| Mapper | Use when |
|---|---|
| `NeutralToneMapping` (r162+) | Product, e-commerce, UI-adjacent scenes: base colours stay true |
| `AgXToneMapping` (r160+) | Cinematic HDR, bright emissives, sunsets — graceful highlight roll-off, but desaturates and can look washed on light backdrops |
| `ACESFilmicToneMapping` | Punchy, contrasty, slightly shifts hues; classic "game" look |

Set `renderer.outputColorSpace = SRGBColorSpace`. With `EffectComposer`, tone mapping is applied by `OutputPass` — do not add it twice. Adjust `toneMappingExposure` (0.8–1.3) last.

## 4. Shadows that look expensive

```js
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;  // or VSMShadowMap for very soft
key.castShadow = true;
key.shadow.mapSize.setScalar(2048);                // 1024 on low tier
Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
key.shadow.bias = -0.0003;                         // fixes acne
key.shadow.normalBias = 0.02;                      // fixes acne on curved surfaces without peter-panning
```
- **Fit the shadow frustum tightly** to the content (use `CameraHelper(key.shadow.camera)` while tuning). A huge frustum = blurry, blocky shadows.
- `shadow.radius` and `blurSamples` only affect **VSM** (and basic PCF) — they do nothing with `PCFSoftShadowMap`.
- **Acne** (stripes) → more negative `bias` / more `normalBias`. **Peter-panning** (gap under objects) → less bias.
- Large outdoor scenes → `CSM` (addons/csm) cascaded shadow maps.
- Static scene → set `renderer.shadowMap.autoUpdate = false` and `needsUpdate = true` when something moves.

### Grounding
Nothing may float. Options from cheapest to richest:
1. **Shadow catcher**: `ShadowMaterial({ opacity: 0.25–0.5 })` plane — shows only shadow over any background (template default, seamless "infinite studio").
2. **Contact shadow**: render depth from below into a blurred texture on a plane (three example `webgl_shadow_contact`) — soft, no light needed.
3. **Baked AO blob**: radial-gradient texture on a plane under each object — near-free, good for mobile.
4. **Screen-space AO** (`post-processing-stack`) for crevices between objects.

## 5. Diagnosis table

| Symptom | Likely cause | Fix |
|---|---|---|
| Everything grey/flat | No environment, or env too strong vs key | Add PMREM env; env 0.3–0.6, key 3+ |
| Washed out, hazy | AgX on light backdrop, env too high, bloom threshold too low | Neutral tone mapping, lower env, bloom threshold above diffuse |
| Chrome looks grey | Featureless environment | HDRI with contrast, or add bright `RectAreaLight` strips |
| Objects float | No contact shadow | Shadow catcher / contact shadow / AO |
| Horizon seam | Lit ground vs unlit background colour mismatch | ShadowMaterial catcher or fog matched to background |
| Black shadows | No fill | Hemisphere 0.1–0.3 or env |
