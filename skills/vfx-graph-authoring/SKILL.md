---
name: vfx-graph-authoring
description: Niagara and Houdini style data-driven effect definition for Three.js. Covers a typed effect description (emitter, modules, parameters, curves) as JSON with a schema, a runtime that builds a particle system from it, presets and variants (extends, seeded overrides), parameter exposure and live editing with tweakpane, lil-gui or leva, hot reload, serialization and version migration, and validation of bad effect files with path based errors. Includes a verified effect-definition loader with validation. Use when effects should be authored as data instead of code, when artists or a panel must tune effects live, when presets or variants of one effect are needed, or when effect files must survive version changes. Thai triggers กำหนดเอฟเฟกต์ด้วยข้อมูล, ไฟล์เอฟเฟกต์ JSON, พรีเซ็ตเอฟเฟกต์, ปรับพารามิเตอร์สด, ตรวจไฟล์เอฟเฟกต์, โมดูลพาร์ติเคิล.
argument-hint: "<effect to define as data, and who edits it: artist panel, designer JSON or code only>"
---

# VFX Graph Authoring

An effect is data plus a small set of code modules. Data holds numbers, curves and the module list. Code holds what each module does. This is the useful half of Niagara and Houdini, without a node editor (the visual graph is not worth building, see `realtime-engine-features` section 5). The particle system that consumes the data is in `particle-system-architecture`.

## 1. Data or code

| Situation | Choice | Why |
|---|---|---|
| One effect, one developer, never tuned by others | Plain code with constants | A schema costs more than it saves |
| Several effects sharing modules, or a designer tunes numbers | **JSON effect files** plus module registry | Tuning without a rebuild, diffable files |
| Artists need sliders and save buttons | JSON plus a panel (section 5) | Panel edits the same validated object |
| Behaviour differs by logic, not numbers | New module in code, then reference it from JSON | Never put expressions or functions in JSON |
| Effects must come from Blender or Houdini | Export JSON from a script, or bake (`sim-cache-baking-vat`) | Keep the runtime format yours, not the DCC's |

## 2. Effect description

Four layers, all plain JSON. Keep it flat and small.

| Field | Holds | Notes |
|---|---|---|
| `version` | Integer | Section 7. Required, no default |
| `name`, `extends` | Id, optional preset name | Section 4 |
| `emitter` | `capacity`, `lifetime [min,max]`, spawn mode and rate | Capacity is the hard cap, size it against `vfx-performance-scaling` |
| `modules[]` | Ordered list `{ type, ...params }` | Order is execution order. Initial modules run once, update modules every step |
| `render` | Blend mode, flipbook grid, colour over life | Draw state comes from `particle-rendering-blending` |
| `curves` or inline | `[[t, v], ...]` keys or a named preset | `t` in 0..1 over life, strictly increasing. Authoring follows `animation-curves-graph-editor` |

```json
{ "version": 2, "extends": "sparks-base", "name": "sparks-big",
  "emitter": { "capacity": 4000 },
  "modules": [{ "type": "initialVelocity", "speed": [4, 9] }, { "type": "sizeOverLife", "curve": "easeOut" }] }
```

Rules:
- **Parameters are typed and ranged.** Every parameter declares type, min, max and default in one registry. The panel, validator and docs all read that registry.
- **No functions, no strings evaluated as code.** Curves are key arrays or names from a table.
- **Randomness is ranges plus a seed**, never `Math.random()` in the file. Same file plus same seed gives the same burst (needed for tests and replays).
- **Units are fixed:** metres, seconds, degrees. State them in the registry comments.

## 3. Verified loader with validation

Registry, migration, `extends` resolution, validation with path based errors, and the hand-off to the runtime. Run in Node 22 with a stub system class: valid file, v1 migration, extends merge, unknown module, out of range, misspelt parameter, inverted range, bad curve, NaN, future version, extends cycle and missing factory all behave as shown.

```js
// Spec language: { type, min?, max?, default?, of?, options? }
const num = (min, max, def) => ({ type: 'number', min, max, default: def });
export const MODULES = {
  initialVelocity: { speed: { type: 'range', min: 0, max: 50, default: [2, 5] }, coneDeg: num(0, 180, 30) },
  gravity: { value: { type: 'vec3', default: [0, -9.8, 0] } },
  drag: { value: num(0, 20, 0) },
  sizeOverLife: { from: num(0, 10, 0.2), to: num(0, 10, 0), curve: { type: 'curve', default: 'linear' } },
};
export const CURVES = { linear: [[0, 0], [1, 1]], easeOut: [[0, 0], [0.5, 0.75], [1, 1]] };
export const CURRENT = 2;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function check(spec, v, path, errs) {
  if (v === undefined) return spec.default;
  const bad = (m) => (errs.push(`${path}: ${m}`), spec.default);
  switch (spec.type) {
    case 'number':
      if (!isNum(v)) return bad('expected finite number');
      if (v < spec.min || v > spec.max) return bad(`${v} outside ${spec.min}..${spec.max}`);
      return v;
    case 'range':
      if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum) || v[0] > v[1]) return bad('expected [min,max] with min<=max');
      if (v[0] < spec.min || v[1] > spec.max) return bad(`outside ${spec.min}..${spec.max}`);
      return v;
    case 'vec3':
      return Array.isArray(v) && v.length === 3 && v.every(isNum) ? v : bad('expected [x,y,z]');
    case 'curve': {
      if (typeof v === 'string') return CURVES[v] ? v : bad(`unknown curve "${v}"`);
      const ok = Array.isArray(v) && v.length >= 2 && v.every((k, i) => Array.isArray(k) && isNum(k[0]) && isNum(k[1]) && k[0] >= 0 && k[0] <= 1 && (i === 0 || k[0] > v[i - 1][0]));
      return ok ? v : bad('keys must be [t,v] pairs, t in 0..1 and strictly increasing');
    }
  }
}

const MIGRATIONS = { 1: (d) => { // v1 had a flat gravityY, v2 uses a gravity module
  const { gravityY, ...rest } = d;
  const modules = [...(rest.modules ?? [])];
  if (gravityY !== undefined) modules.push({ type: 'gravity', value: [0, gravityY, 0] });
  return { ...rest, modules, version: 2 };
} };

export function migrate(d) {
  if (!isNum(d.version) || d.version > CURRENT) throw new Error(`unsupported version ${d.version}, runtime supports <= ${CURRENT}`);
  while (d.version < CURRENT) d = MIGRATIONS[d.version](d);
  return d;
}

const merge = (a, b) => Array.isArray(b) || typeof b !== 'object' || b === null ? b
  : Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a?.[k], b[k]) : a[k]]));

// presets: { name: effect JSON }. "extends" names a preset, the child overrides by deep merge, arrays replace.
export function resolve(def, presets, seen = []) {
  if (!def.extends) return def;
  if (seen.includes(def.extends)) throw new Error(`extends cycle: ${[...seen, def.extends].join(' -> ')}`);
  const base = presets[def.extends];
  if (!base) throw new Error(`unknown preset "${def.extends}"`);
  const { extends: _e, ...own } = def;
  return merge(resolve(base, presets, [...seen, def.extends]), own);
}

export function validate(raw, presets = {}) {
  const errs = [];
  let d;
  try { d = migrate(resolve(raw, presets)); } catch (e) { return { ok: false, errors: [e.message] }; }
  const cap = d.emitter?.capacity;
  if (!Number.isInteger(cap) || cap < 1 || cap > 100000) errs.push('emitter.capacity: integer 1..100000');
  const life = check({ type: 'range', min: 0.05, max: 30, default: [1, 1] }, d.emitter?.lifetime, 'emitter.lifetime', errs);
  const modules = (d.modules ?? []).map((m, i) => {
    const spec = MODULES[m.type];
    if (!spec) { errs.push(`modules[${i}].type: unknown "${m.type}"`); return null; }
    for (const k of Object.keys(m)) if (k !== 'type' && !spec[k]) errs.push(`modules[${i}].${k}: unknown parameter for ${m.type}`);
    const out = { type: m.type };
    for (const [k, s] of Object.entries(spec)) out[k] = check(s, m[k], `modules[${i}].${k}`, errs);
    return out;
  }).filter(Boolean);
  return errs.length ? { ok: false, errors: errs } : { ok: true, value: { version: CURRENT, name: d.name ?? 'unnamed', emitter: { capacity: cap, lifetime: life }, modules } };
}

// Runtime hand-off: one factory per module type, each returns a per particle update. Particle system itself: particle-system-architecture.
export function build(value, factories, System) {
  const sys = new System({ capacity: value.emitter.capacity, lifetime: value.emitter.lifetime });
  for (const m of value.modules) {
    const make = factories[m.type];
    if (!make) throw new Error(`no runtime factory for module "${m.type}"`);
    sys.addModule(make(m));
  }
  return sys;
}
```

Rules:
- **Validate once at load, never per frame.** The runtime receives a clean value object with defaults filled.
- **Collect all errors, then fail.** One bad file should list every problem, each with a path like `modules[2].value`.
- **Unknown keys are errors.** A silently ignored typo (`vlaue`) is the most common authoring bug.

## 4. Runtime and presets

Build step: validated value in, particle system out (`build` above). Each module type has one factory that returns a per particle update, or a uniform setter when the system runs on the GPU (`gpu-particles-compute`). Forces and fields come from `particle-forces-fields`.

| Parameter kind | Change at runtime by | Rebuild? |
|---|---|---|
| Scalar, vec3, colour, curve values | Write to a uniform or the baked curve texture | No |
| `capacity`, flipbook grid, module list or order | Dispose and build again | Yes |
| Blend mode, depth settings | Material state change | Material only |

Curves go to the GPU as a 1D `DataTexture` (256 samples, `LinearFilter`, `NoColorSpace`) so editing a curve rewrites one small texture and nothing else.

**Presets and variants.**
- `extends` names a preset. The child deep merges over it. **Arrays replace, they do not merge**, so a child module list is a full list. State this in the preset docs.
- Variants of one effect (small, big, frozen) are tiny files that extend the base and override a few numbers. Do not copy the base.
- Resolve `extends` before validating, detect cycles, and fail on an unknown preset (shown above).
- Per spawn variation (colour jitter, scale) is a seeded range inside the file, not a new preset per instance.

## 5. Parameter exposure and live editing

Expose only the registry entries marked for tuning. Bind the panel to the **resolved, validated value object**, so sliders edit the same data the runtime reads.

| Library | Use | Verified in this session |
|---|---|---|
| `tweakpane` 4 | Best fit for vanilla Three.js. `new Pane()`, `pane.addFolder({ title })`, `pane.addBinding(obj, 'key', { min, max })`, `pane.addButton({ title })`, `pane.refresh()`, `pane.exportState()` and `importState()` | Method names present in 4.0.5. v3 used `addInput`, check your version |
| `lil-gui` | Zero setup, ships with three examples | Familiar API, not re-checked here (verify) |
| `leva` | React and react-three-fiber apps only: `useControls`, `folder`, `button`, `levaStore` exports | Exports present in 0.10.1 |

```js
import { Pane } from 'tweakpane';
const pane = new Pane({ title: 'sparks-big' });
const f = pane.addFolder({ title: 'initialVelocity' });
f.addBinding(mod, 'coneDeg', { min: 0, max: 180 });   // mod = value.modules[0]
pane.on('change', () => applyToUniforms(value));      // rebuild only for structural keys, see table in section 4
pane.addButton({ title: 'Copy JSON' }).on('click', () => navigator.clipboard.writeText(JSON.stringify(value, null, 2)));
```

Rules:
- **Generate the panel from the registry.** Hand written panels drift from the schema.
- **Range sliders:** bind the two ends as two numbers, or use a plugin interval blade (verify plugin name). Do not bind an array directly.
- **Copy JSON button** is the save path: tune live, paste into the file. It round trips only if the exported object passes `validate` again.
- **Gate panels behind `?debug`** and strip them from the shipped page. `pane.dispose()` on teardown.
- **A burst button** that respawns the effect is worth more than any slider. Tune with the effect looping or retriggering.

## 6. Hot reload

1. Load the changed file, run `validate`. **On errors keep the previous working effect** and show the error list in the panel or console. Never swap in a half valid effect.
2. Diff old and new resolved values. Only uniform class changes: write uniforms and keep live particles. Structural changes: dispose, build, restart the emitter.
3. Dispose old geometry, materials and textures on rebuild. Leaks show as climbing `renderer.info.memory`.

With Vite, importing the JSON makes it a module, so the module API can accept updates:

```js
import sparks from './fx/sparks-big.json';
if (import.meta.hot) import.meta.hot.accept('./fx/sparks-big.json', (m) => reload(m.default));
```

Other bundlers differ (verify). Without a bundler, poll `fetch(url, { cache: 'no-store' })` on `?debug` every second and compare the text. Hot reload is a dev feature, tree it out of production builds.

## 7. Serialization and versioning

- **`version` is an integer in every file.** The loader refuses a version newer than it knows (shown above), and upgrades older ones with a chain of small migrations, one per step. Keep migrations forever, files in the wild do not update.
- **A migration only renames, moves or fills defaults.** It never changes the look. Test each one against a stored fixture file.
- **Round trip test:** `validate(JSON.parse(JSON.stringify(value)))` must return the same value. Run it in CI over every effect file.
- **Stable key order and 2 space indent** so git diffs show real changes.
- **Do not store derived data** (baked curve textures, resolved `extends`). Store the source, rebuild at load.
- **Ship minified JSON** or bundle effects into one file. Hundreds of small requests cost more than the parse. Binary caches belong to `sim-cache-baking-vat`.
- **Asset references** (flipbook texture, mesh) are ids resolved by your asset table, not raw URLs, so files move without edits.

## 8. Bad files

| Fault | Policy | Why |
|---|---|---|
| Wrong type, NaN, missing required field | Error, reject the file | The result would be undefined |
| Out of range number | Error with the allowed range (clamping hides authoring mistakes) | Offer clamp only in the panel |
| Unknown module or parameter | Error | Typos must not pass |
| Unknown future version | Error naming both versions | Do not guess |
| Capacity above the tier cap | Warning, clamp at runtime to the tier cap | The tier decides, see `vfx-performance-scaling` |
| Missing optional asset | Warning, use a 1x1 white fallback | Effect still plays |

Show errors where the author looks: console for files, the panel for live edits. A failed load must never break the page, fall back to a built in neutral effect or play nothing.

## 9. Verify

1. Run the loader checks above on every shipped file plus one deliberately broken copy per fault class. Each must fail with a path.
2. Change a uniform class parameter in the panel while the effect runs. No rebuild, no particle reset.
3. Change a structural parameter. Old resources disposed, `renderer.info.memory` back to baseline after three edits.
4. Corrupt the file while hot reloading. The previous effect keeps playing and the error shows.
5. Compare the same file with the same seed twice. Frames identical (`render-qa`).

## 10. Not verified here

- `lil-gui` method names, tweakpane interval blade plugin name, non Vite hot reload APIs.
- End to end GPU rebuild behaviour (the loader was tested against a stub system, not a real particle renderer).
- Houdini and Blender side exporters for the JSON format (design only).

## 11. Do not do these

- Do not put expressions or code in JSON.
- Do not build a node editor. A panel plus JSON covers the need.
- Do not validate per frame or per particle.
- Do not let a failed hot reload replace a working effect.
- Do not copy a base effect to make a variant. Extend it.
