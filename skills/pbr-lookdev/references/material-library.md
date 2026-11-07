# Material library — starting values

All colours are sRGB hex (Three.js converts `Color` hex from sRGB to linear automatically). Tested under PMREM `RoomEnvironment`, `NeutralToneMapping`, exposure 1. Always tune against a screenshot.

## Metals (`metalness: 1`)

| Material | color | roughness | Extras |
|---|---|---|---|
| Polished gold | `#E8BE6A` | 0.12 | — |
| Brushed gold | `#D4AF7A` | 0.22 | `anisotropy: 0.6` |
| Chrome | `#F2F3F5` | 0.03 | needs a contrasty env/HDRI or it looks grey |
| Brushed aluminium | `#D6D8DB` | 0.3 | `anisotropy: 0.8`, brushed canvas `roughnessMap` |
| Copper | `#D9895B` | 0.25 | — |
| Gunmetal / dark steel | `#5A5E63` | 0.35 | — |
| Anodised aluminium | any saturated colour | 0.3 | `iridescence: 0.3` optional |
| Cast iron | `#6E6F70` | 0.65 | noisy `roughnessMap` |

## Dielectrics (`metalness: 0`)

| Material | Class | color | roughness | Extras |
|---|---|---|---|---|
| Glazed ceramic | Physical | any | 0.35 | `clearcoat: 1, clearcoatRoughness: 0.08` |
| Matte ceramic / clay | Standard | `#C9B8A6` | 0.85 | — |
| Glossy plastic (ABS) | Physical | any | 0.25 | `clearcoat: 0.3` |
| Soft-touch plastic | Physical | any | 0.6 | `sheen: 0.4, sheenRoughness: 0.6` |
| Car paint | Physical | saturated | 0.4 | `clearcoat: 1, clearcoatRoughness: 0.03`, optional flake normalMap |
| Rubber | Standard | `#2A2A2A` | 0.9 | — |
| Velvet / fabric | Physical | any | 0.8 | `sheen: 1, sheenRoughness: 0.5, sheenColor` lighter tint |
| Leather | Physical | `#6B3E26` | 0.55 | bump/normal grain, `clearcoat: 0.15` |
| Lacquered wood | Physical | wood map | 0.45 | `clearcoat: 0.8, clearcoatRoughness: 0.15` |
| Raw wood | Standard | wood map | 0.75 | — |
| Polished marble | Physical | marble map | 0.15 | `clearcoat: 0.5` |
| Concrete | Standard | `#9A9894` | 0.9 | noise bump |
| Paper / card | Standard | `#EDE8DF` | 0.9 | `sheen` not needed |

## Transmissive

| Material | color | transmission | thickness | ior | roughness | Extras |
|---|---|---|---|---|---|---|
| Clear glass | `#FFFFFF` | 1 | 0.5 | 1.5 | 0.02 | — |
| Frosted glass | `#FFFFFF` | 1 | 0.5 | 1.5 | 0.35 | — |
| Tinted bottle glass | `#FFFFFF` | 1 | 1.0 | 1.52 | 0.04 | `attenuationColor: #3E8E5A, attenuationDistance: 0.6` |
| Water | `#FFFFFF` | 1 | 1.0 | 1.33 | 0.0 | `attenuationColor: #9FD8E8` |
| Ice | `#F4FBFF` | 1 | 0.8 | 1.31 | 0.15 | bump noise |
| Diamond | `#FFFFFF` | 1 | 0.6 | 2.42 | 0.0 | `dispersion: 0.4` |
| Jelly / gummy | saturated | 0.9 | 1.5 | 1.4 | 0.2 | `attenuationDistance: 0.3` |

## Emissive

Emissive surfaces that should bloom: `color: #111`, `emissive: <hue>`, `emissiveIntensity` 8–20 so they exceed the bloom threshold (template uses 4.0). Screens/LEDs that should *not* bloom: intensity 1–2.
