---
name: hud-ui-labels
description: Design HUDs and in-scene UI labels for Three.js to a master UX/UI standard. Covers choosing between DOM overlay, CSS2DRenderer, CSS3DRenderer, sprites, troika-three-text/SDF text, canvas textures and in-world panels, projecting 3D anchors to the screen with viewport clamping, occlusion fade, label collision and declutter, leader lines and callouts, distance level of detail, screen-space versus world-space sizing, 44 px touch targets, focus order and keyboard access, ARIA and prefers-reduced-motion, contrast over a 3D background, Thai and multilingual text rendering, and UX laws (hierarchy, Fitts, progressive disclosure, Hick, motion language). Use when adding or fixing labels, annotations, hotspots, tooltips, markers, a HUD or any text or controls over a 3D scene, or when labels overlap, pop, clip, are unreadable, or are too small to tap. Thai triggers ป้ายกำกับ, ป้ายชื่อ, HUD, UI ทับฉาก 3D, hotspot, ตัวหนังสือซ้อนกัน, ฟอนต์ไทยแหว่ง, ปุ่มกดยาก.
argument-hint: "<scene or page, and what the labels or HUD must show>"
---

# HUD & UI Labels

Labels are UI first and 3D second. A label that is gorgeous and unreadable on a phone has failed. Decide the tech by what the label must do, then design the behaviour (occlude, declutter, disclose) before styling.

## 1. Pick the technology

| Option | Use when | Gives | Costs |
|---|---|---|---|
| Fixed DOM HUD | Menus, score, legend, controls not tied to a 3D point | Full CSS, native a11y, best text | None per frame |
| DOM overlay, own projection (section 2) | Need edge clamping, leader lines, batching, custom declutter | Total control, one `transform` write per label | You own sorting, z-order, cleanup |
| `CSS2DRenderer` | Anchored text or buttons, up to a few dozen | Real DOM text, a11y, Thai shaping by the browser, CSS styling | Not depth-tested, canvas capture excludes it, per-label layout cost |
| `CSS3DRenderer` | Panel that must tilt and foreshorten with the scene | Perspective DOM | Cannot be depth-tested against WebGL, harder to keep crisp, few panels only |
| `Sprite` + `SpriteMaterial` | Many icon markers, must sit inside the WebGL frame | Depth-tested, survives post-processing and canvas capture | Text is a texture, no DOM a11y |
| `troika-three-text` (SDF) | In-world text that scales with perspective and stays sharp | Crisp at any scale, outline props, depth-tested | Async `sync()`, Thai needs checking (section 11), no DOM a11y |
| `CanvasTexture` on a plane | Few static labels, simple plates | Cheap, full 2D canvas control | Blurs at distance and when magnified, memory per label, you measure text yourself |
| In-world panel (mesh plate + troika text) | XR or diegetic UI that exists in the scene | Spatially real | Pointer targeting via raycast, no free a11y |

Default: `CSS2DRenderer` for anchored labels, a fixed DOM HUD for global controls. Move to WebGL-native text only when the label must go through `post-processing-stack`, appear in XR or canvas capture, or number in the hundreds. Mix freely: DOM for the interactive 5, sprites for the passive 500.

Mount the label layer above the canvas and render it after the WebGL pass. Set the layer root to `pointer-events: none` and each interactive label to `auto`, otherwise the labels block `OrbitControls`. Dragging that starts on a label will not orbit, so keep labels compact.

## 2. Project an anchor to the screen, clamp to the viewport

`CSS2DRenderer` hides an object only when its projected depth is outside the range -1 to 1 and relies on the container's `overflow: hidden` for the sides. It does not clamp. When a label must stay visible at the edge (off-screen pointer, objective marker), project yourself:

```js
const _view = new THREE.Vector3(), _ndc = new THREE.Vector3();
export function anchorToScreen(world, camera, w, h, margin, out = { x: 0, y: 0, onScreen: true }) {
  _view.copy(world).applyMatrix4(camera.matrixWorldInverse);   // camera.updateMatrixWorld() first
  _ndc.copy(world).project(camera);
  const behind = _view.z > 0;                                  // camera looks down -Z
  let x = behind ? -_ndc.x : _ndc.x, y = behind ? -_ndc.y : _ndc.y;   // project() mirrors x,y behind the camera
  if (behind && Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;     // dead behind: pin to the bottom edge
  const lx = 1 - 2 * margin / w, ly = 1 - 2 * margin / h;      // NDC limit inside the margin
  const r = Math.max(Math.abs(x) / lx, Math.abs(y) / ly);
  const s = behind ? r : Math.max(r, 1);                       // behind: always push to the edge
  out.onScreen = !behind && r <= 1;
  out.x = (x / s * 0.5 + 0.5) * w;
  out.y = (-y / s * 0.5 + 0.5) * h;
  return out;
}
```

- Margin: 16 px plus the device safe area (guess, tune on a phone). Add `viewport-fit=cover` to the viewport meta and use `padding: max(16px, env(safe-area-inset-top))` style CSS on the HUD container so notches and home bars never cover controls.
- Off-screen markers show an arrow pointing at the anchor, not the full label. Rotate the arrow with `Math.atan2` of the clamped point from the screen centre.
- Write `transform: translate3d(x px, y px, 0)` and nothing that triggers layout. Read sizes once, cache them, and refresh with a `ResizeObserver`.

## 3. Occlusion: fade, never pop

| Method | Use when | Limit |
|---|---|---|
| Raycast anchor to camera | DOM labels (`CSS2DRenderer`, own overlay) | CPU cost: stagger it, test only occluder meshes, not `scene` |
| `depthTest: true` on sprite or troika material | WebGL-native labels | Hard cut, no fade. Cannot fade without a custom shader reading depth (verify) |
| `depthTest: false` plus high `renderOrder` | Labels that must always show (selected, objective) | Reads as floating, so pair with a leader line |
| Do nothing | Anchor is always in front (flat top-down view) | Check every orbit angle in section 13 |

Rules:
- Exponential fade, not a toggle: opacity `damp(shown, target, 12, dt)` settles in about 0.25 s (guess, tune against the motion language in section 12). Reduced motion snaps.
- Occluded does not mean removed. Keep the label in the layout so it does not reshuffle declutter, and set `visibility: hidden` once it reaches 0 so it also leaves the tab order.
- Self-occlusion: the anchor sits on a surface, so stop the ray a little short (`far = dist - 0.05`) or the owner mesh occludes its own label.
- Selected and focused labels ignore occlusion and distance rules.

## 4. Verified sample: `CSS2DRenderer` labels with occlusion fade

Tested in headless Chromium with three r170: front label settles at opacity 1, back label at 0 with `visibility: hidden`, camera flip swaps them, fade passes through intermediate values, removing the object removes its DOM node.

```js
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export function createLabelLayer({ scene, camera, container, occluders }) {
  const renderer = new CSS2DRenderer();
  const root = renderer.domElement;
  Object.assign(root.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.appendChild(root);

  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const ray = new THREE.Raycaster();
  const camPos = new THREE.Vector3(), world = new THREE.Vector3(), dir = new THREE.Vector3();
  const labels = [];
  let frame = 0;

  function add(text, parent, offset = new THREE.Vector3(0, 0.25, 0)) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'label';
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.copy(offset);
    parent.add(obj);
    const label = { el, obj, shown: 1, occluded: false };
    labels.push(label);
    return label;
  }

  function update(dt) {
    frame++;
    camera.getWorldPosition(camPos);
    labels.forEach((l, i) => {
      if ((frame + i) % 4 === 0) {                    // staggered: one raycast per label every 4th frame
        l.obj.getWorldPosition(world);
        dir.subVectors(world, camPos);
        const dist = dir.length();
        ray.set(camPos, dir.normalize());
        ray.far = Math.max(dist - 0.05, 0);           // stop just short of the anchor
        l.occluded = ray.intersectObjects(occluders, true).length > 0;
      }
      const target = l.occluded ? 0 : 1;
      l.shown = reduce.matches ? target : THREE.MathUtils.damp(l.shown, target, 12, dt);
      l.el.style.opacity = l.shown.toFixed(2);
      l.el.style.visibility = l.shown < 0.02 ? 'hidden' : 'visible';   // hidden also leaves the tab order
      l.el.style.pointerEvents = l.shown > 0.5 ? 'auto' : 'none';
    });
    renderer.render(scene, camera);
  }

  function setSize(w, h) { renderer.setSize(w, h); }

  function dispose() {
    labels.forEach((l) => l.obj.removeFromParent());  // CSS2DObject removes its element on 'removed'
    root.remove();
  }

  return { add, update, setSize, dispose };
}
```

Wire it: `layer.setSize(w, h)` on every resize next to `renderer.setSize`, `layer.update(dt)` after the WebGL render in the same loop (`motion-choreography` section 1 loop). Occluder matrices come from the previous render, so a fast-moving occluder lags one frame.

Facts about `CSS2DRenderer` this relies on: `new CSS2DRenderer({ element })` accepts an optional container, `domElement` gets `overflow: hidden`, `CSS2DObject.center` defaults to (0.5, 0.5), the object layers must match the camera layers, `sortObjects` assigns `z-index` by distance. Elements are appended to the DOM when they first become visible, so DOM order is not creation order (see section 9).

## 5. Declutter and collision

Greedy by priority on screen rectangles. Use the hit box (44 px minimum), not the visible plate, so touch targets never overlap.

```js
function declutter(items, gap = 4) {                 // item: { x, y, w, h, priority, show }
  items.sort((a, b) => b.priority - a.priority || Number(b.show) - Number(a.show));   // tie keeps last frame's winner
  const placed = [];
  for (const it of items) {
    const r = { l: it.x - it.w / 2 - gap, r: it.x + it.w / 2 + gap, t: it.y - it.h / 2 - gap, b: it.y + it.h / 2 + gap };
    it.show = !placed.some((p) => r.l < p.r && r.r > p.l && r.t < p.b && r.b > p.t);
    if (it.show) placed.push(r);
  }
}
```

- Priority order: selected or focused (`Infinity`), then user-relevant, then nearest, then the rest.
- Run at 10 to 15 Hz, not every frame, and fade `show` changes with section 3 timing. The tie-break on previous state is the hysteresis that stops flicker.
- Cap visible labels (guess: 6 on a phone, 12 on desktop) and show a count badge for the hidden rest. Fewer visible choices is Hick's law in practice.
- When a cluster cannot be resolved, collapse it into one cluster marker that expands on tap (progressive disclosure), not a pile of overlapping text.

## 6. Leader lines and callouts

- Use a leader line when the label is displaced from its anchor: declutter pushed it, the anchor is small, or the label sits in an edge column. Skip it when the label is within about 24 px of its anchor.
- One SVG overlay (`pointer-events: none`), one `<path>` per active label, updated in the same pass as the transforms. Straight or single-elbow lines only. Curves read as decoration.
- Anchor dot 6 to 8 px, with a transparent 44 px hit area on the label, not the dot.
- Line contrast on any backdrop: draw a 3 px dark stroke under a 1.5 px light stroke. Same occlusion opacity as the label.
- Callout plates align to a column or the screen edge nearest the anchor, ordered by anchor y so lines never cross.

## 7. Level of detail for labels

| Tier | Camera distance (relative to scene radius, guess) | Content |
|---|---|---|
| Far | > 3x | Dot or icon only, no text |
| Mid | 1x to 3x | Short name, one line |
| Near | < 1x | Name plus one secondary line |
| Selected | any | Full card with actions |

- Switch tiers with about 10% hysteresis so a boundary does not flicker.
- Fade between tiers, do not swap content in one frame. Keep the plate size stable between tiers where you can, because resizing plates re-triggers declutter.
- Distance fade is optional and only for tier Far. Never drop alpha under 0.5 on anything the user must read.

## 8. Sizing: screen space or world space

| Space | Behaviour | Use for |
|---|---|---|
| Screen (CSS2D, DOM, `sizeAttenuation: false` sprite) | Constant pixel size | Labels, buttons, anything read or tapped |
| World (plane, troika text, `sizeAttenuation: true` sprite) | Shrinks with distance | Diegetic signage that should feel part of the scene |

- Readable text never depends on world scale. Phones and desktops at the same world size differ by 3x in pixels.
- To hold a world-space object at a fixed pixel height: `unitsPerPx = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / viewportHeightPx`, then `scale = pxHeight * unitsPerPx`. Clamp between a min and max so it neither vanishes nor fills the screen.
- With `sizeAttenuation: false` the sprite scale relates to the camera projection, so tune by eye per camera (verify the exact unit relation before computing it).
- Type: 12 px floor and 14 px preferred for body labels on phones (guess, tune), in `px` or `rem`, never smaller because the scene is far away. Respect user font size where DOM text allows.

## 9. Touch, pointer, keyboard, ARIA

**Targets.** Minimum 44 by 44 CSS px for anything tappable (WCAG 2.2 enhanced target size is 44, the AA floor is 24; platform guidance is about 44 to 48). Make the hit area real so it is measurable: keep the visible plate small and pad it with a transparent border.

```css
.label {
  min-width: 44px; min-height: 44px; box-sizing: border-box;
  padding: 4px 10px; border: 8px solid transparent; border-radius: 20px;
  background: rgb(12 14 20 / 0.86) padding-box;    /* plate stops at the padding box, hit area is the border box */
  color: #fff; font: 600 13px/1.5 "Noto Sans Thai", "Sarabun", system-ui, sans-serif;
  touch-action: manipulation; cursor: pointer;
  max-width: min(220px, 70vw); overflow-wrap: anywhere;   /* long text wraps instead of leaving the screen */
}
.label:focus-visible { outline: 2px solid #fff; outline-offset: -8px; }   /* ring hugs the visible plate */
```

A pseudo-element hit area does not show in `getBoundingClientRect`, so the section 13 check cannot see it. Use border or padding.

**Fitts.** Put frequent and primary actions at the bottom and edges within thumb reach (inside safe area), big and few. Put destructive or rare actions farther away. Edge-anchored controls are easy to hit because the screen edge stops the pointer.

**Focus order.** `CSS2DRenderer` appends elements as they first become visible, so DOM order follows visibility, not meaning. For real keyboard and screen-reader use, keep an ordered off-canvas list as the source of truth:

- A `<ul>` of `<button>`s in a fixed meaningful order (side panel or visually hidden), each focusing or selecting the matching anchor and moving the camera there (`motion-choreography`).
- In-scene labels then duplicate it for pointer users: `aria-hidden="true"` and `tabindex="-1"`. Never leave `aria-hidden` on something focusable.
- If the in-scene labels are the only interface, set `tabindex` order explicitly and keep the list short.
- Escape closes a card and returns focus to its label. Enter and Space activate. Visible focus ring on every label, never `outline: none`. Focused label must not be covered by the HUD (WCAG 2.2 focus not obscured).

**ARIA.**
- `<canvas role="img" aria-label="...">` describes the scene once. Labels are real `<button>` or `<a>`, never `div` with click handlers.
- Announce state changes (selection, count of hidden labels) in one `aria-live="polite"` region, not per label per frame.
- Set `lang` on each label that differs from the page (`el.lang = 'th'`) so screen readers, hyphenation and font selection use the right rules.

**Reduced motion.** Read `matchMedia('(prefers-reduced-motion: reduce)')`, and listen for its `change` event rather than reading once. Reduced: snap fades, cut camera focus moves, no pulsing markers, no animated leader draw. Keep static feedback (colour, ring). The sample in section 4 already snaps.

## 10. Legibility over a moving 3D background

- Default to a **plate**: opacity at least 0.8, dark or light chosen per theme. Text on the plate must hit 4.5:1 (3:1 only for large text). Compute against the worst plate-plus-background mix, which is the brightest background pixel behind it.
- No plate (large HUD numerals, world text): add an outline or halo. DOM: layered `text-shadow` (0 0 2px dark, 0 1px 3px dark). troika: `outlineWidth`, `outlineColor`, `outlineBlur`. Test over the brightest and darkest regions of the scene.
- Icons and leader lines need 3:1 against whatever they cross (WCAG non-text contrast).
- Avoid `backdrop-filter` blur over the WebGL canvas on mobile unless `render-qa` shows it free, it can cost frame time (verify per device, budget in `performance-budget`).
- Never put text over bloom or emissive highlights. Render labels after `post-processing-stack`, or put the plate behind the glow.
- Safe margins: HUD inside the safe area and 16 px from edges. Do not place controls where a thumb covers the thing they act on.

## 11. Thai and multilingual text

| Concern | Rule |
|---|---|
| Clipping | Thai stacks vowels and tone marks above and below the baseline. Use `line-height` 1.5 or more (guess, verified at 1.5 in a headless check). No fixed `height`, no `overflow: hidden` on the plate. Use `min-height` and padding |
| Fonts | Ship a Thai-capable family, for example Noto Sans Thai or Sarabun, in the stack ahead of `system-ui`. Match Latin glyphs, since labels mix both |
| Loading | `await document.fonts.load('600 13px "Noto Sans Thai"', sampleText)` then re-measure labels (declutter uses cached sizes). Use `font-display: swap`, expect one relayout. Canvas textures must wait for the load or they bake the fallback font |
| Word breaks | Thai has no spaces. Browsers segment by dictionary when the element has `lang="th"`, so set it. Use `overflow-wrap: anywhere` as a safety net. Do not set `word-break: break-all` |
| Truncation | Cut on grapheme boundaries, not code units: `new Intl.Segmenter('th', { granularity: 'grapheme' })`. Cutting mid-cluster leaves a stray mark. Prefer wrapping to ellipsis |
| Canvas textures | Size the canvas from `ctx.measureText(t)` `actualBoundingBoxAscent` and `actualBoundingBoxDescent`, not from the font size, then pad. Thai ascent exceeds the em box |
| troika / SDF | Documented fallback loads Noto fonts through unicode-font-resolver from a CDN by default (self-host for production). The docs do not mention Thai. Test shaping of stacked marks and line breaking in your scene (verify). Give `font` an explicit Thai `.ttf` or `.woff` (woff2 support: verify). Raise `sdfGlyphSize` if small marks blur (guess), pre-break long strings with `Intl.Segmenter('th', { granularity: 'word' })` and `maxWidth` (zero-width space handling: verify) |
| RTL, mixed scripts | `dir="auto"` on DOM labels. Test one string per script you ship |
| Length | Thai and German run longer than English. Design the plate for 150% of the English width, wrap before shrinking the type |

## 12. UX principles as decisions

- **Visual hierarchy.** Three levels only: primary (selected, objective), secondary (labels in range), tertiary (dots, hints). Differ by size, weight and contrast, not by hue alone. At most one primary at a time.
- **Fitts.** Size and distance decide hit speed. 44 px minimum, thumb zone for primary actions, no tiny close buttons on cards (pad them to 44).
- **Progressive disclosure.** Dot, then name, then card on select. Details appear on demand, not all at once. Hover reveals on desktop need a tap equivalent on touch.
- **Hick.** More visible choices means slower decisions. Cap visible labels, group clusters, show one next step.
- **Consistent motion language.** One set of timings for the whole HUD (guess, tune): enter 150 to 200 ms ease-out, exit 100 to 150 ms ease-in, camera focus moves reuse the damping constant of the rest of the scene. The same gesture always yields the same motion. Source: `motion-choreography`.
- **Feedback.** Every tap acknowledges within 100 ms (press state), even when the camera move takes longer.
- **Forgiveness.** Selection survives orbit. A tap on empty space deselects. Nothing important disappears under the thumb.

## 13. Verify

1. `render-qa` the page, including the phone shot (`99-mobile`). Add an orbit that puts labels at the viewport edge and one that puts them behind the model: edge clamping and occlusion fade must both look intentional.
2. Run the check below at the phone viewport (Playwright `evaluate` or console). It must print no offenders.

```js
const els = [...document.querySelectorAll('button, a, [role="button"], input, [tabindex]:not([tabindex="-1"])')]
  .filter((e) => getComputedStyle(e).visibility !== 'hidden' && e.getClientRects().length);
const rects = els.map((e) => ({ e, r: e.getBoundingClientRect() }));
const tooSmall = rects.filter(({ r }) => r.width < 44 || r.height < 44).map(({ e, r }) => `${e.className || e.tagName} ${r.width | 0}x${r.height | 0}`);
const offscreen = rects.filter(({ r }) => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight).map(({ e }) => e.className || e.tagName);
const overlaps = [];
for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
  const a = rects[i].r, b = rects[j].r;
  if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlaps.push(`${rects[i].e.textContent.trim()} / ${rects[j].e.textContent.trim()}`);
}
console.log({ tooSmall, offscreen, overlaps });
```

3. Checklist, tick each on the phone screenshot at 100%:
   - [ ] Every label readable at arm's length, body text at least 12 px, contrast 4.5:1 on its plate
   - [ ] No label overlaps another, a leader line, or a control; no hit areas overlap
   - [ ] Nothing tappable under 44 by 44 CSS px, nothing inside the notch or home bar
   - [ ] Thai strings show every vowel and tone mark, no clipped line tops or bottoms, no stray mark after truncation
   - [ ] Longest translated string wraps inside the screen
   - [ ] Occluded labels fade, none pop; edge labels clamp inside the margin
   - [ ] Tab reaches every control in a meaningful order, focus ring visible over the brightest background, Escape closes cards
   - [ ] With reduced motion on (OS setting or browser emulation), fades snap and nothing pulses
   - [ ] Labels do not block orbit drags outside their own box
   - [ ] Frame time unchanged within noise after labels on (`performance-budget`)
4. Fix the top three failures, rerun, compare. Max 3 loops, then report what remains.

Not verified in this skill, check before relying on them: troika Thai shaping and line breaking, woff2 in troika, `sizeAttenuation: false` unit relation, `backdrop-filter` cost on target phones, depth-fade shaders for WebGL labels.
