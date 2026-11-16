---
name: scene-editor-viewport-tools
description: Build an in-browser 3D scene editor or viewport tool in Three.js, translating Blender and Maya viewport features. Covers TransformControls gizmos with snapping and multi-selection pivots, selection by raycast, GPU ID picking and box select, selection outline, a typed command-pattern undo and redo history with merge and disposal, an outliner tree model, orthographic top, front and side views and quad view, frame selected, infinite grid and axis helpers, shading and wireframe modes, schema-driven inspector panels and an on-demand render loop. Use when adding editing, placing, selecting, moving, inspecting or debugging tools to a scene, configurator or level editor, or when picking is wrong, undo breaks, the gizmo fights the camera, or orthographic views behave oddly. Thai triggers แก้ไขฉาก, เลือกวัตถุ, ย้ายวัตถุ, gizmo, undo redo, มุมมอง top front side, outliner, กริด, ตัวช่วยแก้ไข 3D.
argument-hint: "<what users edit (objects, materials, layout), scene size, and desktop or touch>"
---

# Scene Editor & Viewport Tools

Blender and Maya are editors first and renderers second. An in-browser editor needs the same four things: a stable **document** (what the scene is), a **history** (every change is a command), **selection** (what is targeted) and **viewports** (how it is seen). Keep them separate so any one can change without touching the others. UI rules are in `hud-ui-labels`, scene structure and asset reuse in `scene-assembly-prefabs`.

## 1. Architecture and DCC mapping

| Module | Owns | Never |
|---|---|---|
| Document | The scene root, lookup by `uuid` | Hold UI state |
| History | Commands, undo and redo stacks | Call the renderer |
| Selection | Ordered ids, the active id | Live in the history (section 4) |
| Viewports | Cameras, controls, render loop, overlays | Mutate the document |
| Panels | Outliner, inspector, toolbar | Write to objects directly. They issue commands |

Every edit is `history.execute(command)`. If a change skips the history, it cannot be undone and it breaks every command recorded after it.

| Blender | Maya | Here |
|---|---|---|
| G, R, S | W, E, R | `TransformControls` modes translate, rotate, scale. Pick one key set and show it in the toolbar |
| Numpad 1, 3, 7 (Ctrl for opposite) | Hotbox view menu | Front, right, top ortho views (section 8) |
| Numpad period, View Selected | F | Frame selected (section 8) |
| A, Alt A | Select all, deselect | `Selection.set`, `Selection.clear` |
| H, Alt H | Hide, show | `SetValueCommand` on `visible` |
| Shift D | Ctrl D | Duplicate (clone, `scene-assembly-prefabs`) then `AddObjectCommand` |
| X, Delete | Delete | `RemoveObjectCommand` |
| Ctrl Z, Ctrl Shift Z | Ctrl Z, Shift Z | `history.undo()`, `history.redo()` |
| Shift click toggles, Ctrl click removes (Maya) | Shift toggles | Section 4 modifier table |
| Outliner | Outliner | Section 7 |
| Solid, Wireframe, Material Preview | Shading menu | Section 10 |

Match the conventions of the audience. Offer one preset and do not mix the two sets, `R` means rotate in Maya and scale in Blender.

## 2. Document and history (typed)

Commands reference objects by `uuid`, never by object reference, so a command still works after its object was removed and re-added by undo. The sample is TypeScript with erasable syntax only (types from `@types/three`), run directly on Node 22.18 or later in the checks below.

```ts
// file: history.ts
import * as THREE from 'three';

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];
export interface Pose { p: Vec3; q: Vec4; s: Vec3 }

export interface Doc {
  root: THREE.Object3D;
  find(uuid: string): THREE.Object3D;                  // throws if missing
}
export function createDoc(root: THREE.Object3D): Doc {
  return {
    root,
    find(uuid) {
      const o = root.getObjectByProperty('uuid', uuid);   // O(n). Index uuids in a Map for scenes past a few thousand nodes
      if (!o) throw new Error(`object ${uuid} is not in the document`);
      return o;
    },
  };
}

export interface Command {
  readonly label: string;
  readonly mergeKey?: string;                           // same key within the merge window: fold into one undo step
  execute(): void;                                      // must be idempotent: history may call it after the edit was applied live
  undo(): void;
  merge?(next: Command): boolean;
  discard?(from: 'undo' | 'redo'): void;                // the command left a stack for good: release what it owns
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private last = -Infinity;
  private listeners = new Set<() => void>();
  readonly limit: number;
  readonly mergeMs: number;
  private now: () => number;

  constructor(opts: { limit?: number; mergeMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? 200;
    this.mergeMs = opts.mergeMs ?? 500;
    this.now = opts.now ?? (() => performance.now());
  }

  execute(cmd: Command): void {
    cmd.execute();
    const t = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    const merged = !!top && cmd.mergeKey !== undefined && top.mergeKey === cmd.mergeKey
      && t - this.last < this.mergeMs && !!top.merge && top.merge(cmd);
    if (!merged) {
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.limit) this.undoStack.shift()!.discard?.('undo');
    }
    for (const c of this.redoStack) c.discard?.('redo');     // a new edit kills the redo branch
    this.redoStack.length = 0;
    this.last = t;
    this.emit();
  }
  undo(): boolean {
    const c = this.undoStack.pop(); if (!c) return false;
    c.undo(); this.redoStack.push(c); this.last = -Infinity; this.emit(); return true;
  }
  redo(): boolean {
    const c = this.redoStack.pop(); if (!c) return false;
    c.execute(); this.undoStack.push(c); this.last = -Infinity; this.emit(); return true;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }
}

/** Several commands as one undo step. Undo runs in reverse order. */
export class MultiCommand implements Command {
  readonly label: string;
  readonly mergeKey?: string;
  readonly children: Command[];
  constructor(label: string, children: Command[], mergeKey?: string) { this.label = label; this.children = children; this.mergeKey = mergeKey; }
  execute() { for (const c of this.children) c.execute(); }
  undo() { for (let i = this.children.length - 1; i >= 0; i--) this.children[i].undo(); }
  merge(next: Command) {
    if (!(next instanceof MultiCommand) || next.children.length !== this.children.length) return false;
    this.children.forEach((c, i) => c.merge?.(next.children[i]));
    return true;
  }
  discard(from: 'undo' | 'redo') { for (const c of this.children) c.discard?.(from); }
}

export const getPose = (o: THREE.Object3D): Pose => ({ p: o.position.toArray() as Vec3, q: o.quaternion.toArray() as Vec4, s: o.scale.toArray() as Vec3 });
export function setPose(o: THREE.Object3D, k: Pose) { o.position.fromArray(k.p); o.quaternion.fromArray(k.q); o.scale.fromArray(k.s); o.updateMatrix(); }

export class TransformCommand implements Command {
  readonly label = 'Transform';
  readonly mergeKey: string;
  private doc: Doc; private uuid: string; private before: Pose; private after: Pose;
  constructor(doc: Doc, uuid: string, before: Pose, after: Pose) { this.doc = doc; this.uuid = uuid; this.before = before; this.after = after; this.mergeKey = `transform:${uuid}`; }
  execute() { setPose(this.doc.find(this.uuid), this.after); }
  undo() { setPose(this.doc.find(this.uuid), this.before); }
  merge(next: Command) { if (!(next instanceof TransformCommand) || next.uuid !== this.uuid) return false; this.after = next.after; return true; }
}

function resolve(obj: any, path: string): { owner: any; key: string } {
  const parts = path.split('.'); const key = parts.pop()!; let owner = obj;
  for (const p of parts) owner = owner[p];
  return { owner, key };
}
const readPath = (obj: any, path: string) => { const { owner, key } = resolve(obj, path); const v = owner[key]; return v && v.isColor ? v.getHex() : v; };
function writePath(obj: any, path: string, value: unknown) {
  const { owner, key } = resolve(obj, path);
  if (owner[key] && owner[key].isColor) owner[key].setHex(value as number); else owner[key] = value;
}

/** Any property by path: 'visible', 'name', 'position.x', 'material.roughness', 'material.color' (as a hex number). The old value is read when constructed. */
export class SetValueCommand implements Command {
  readonly label: string;
  readonly mergeKey: string;
  private doc: Doc; private uuid: string; private path: string; private before: unknown; private after: unknown;
  constructor(doc: Doc, uuid: string, path: string, after: unknown) {
    this.doc = doc; this.uuid = uuid; this.path = path; this.after = after;
    this.before = readPath(doc.find(uuid), path);
    this.label = `Set ${path}`; this.mergeKey = `set:${uuid}:${path}`;
  }
  execute() { writePath(this.doc.find(this.uuid), this.path, this.after); }
  undo() { writePath(this.doc.find(this.uuid), this.path, this.before); }
  merge(next: Command) { if (!(next instanceof SetValueCommand) || next.mergeKey !== this.mergeKey) return false; this.after = next.after; return true; }
}

function insertAt(parent: THREE.Object3D, obj: THREE.Object3D, index: number) {
  parent.add(obj);                                      // fires 'added', detaches from any old parent
  const kids = parent.children; kids.pop(); kids.splice(Math.min(index, kids.length), 0, obj);
}

export class AddObjectCommand implements Command {
  readonly label = 'Add object';
  private doc: Doc; private object: THREE.Object3D; private parentUuid: string; private index = Infinity; private dispose?: (o: THREE.Object3D) => void;
  constructor(doc: Doc, object: THREE.Object3D, parentUuid?: string, dispose?: (o: THREE.Object3D) => void) {
    this.doc = doc; this.object = object; this.parentUuid = parentUuid ?? doc.root.uuid; this.dispose = dispose;
  }
  execute() { insertAt(this.doc.find(this.parentUuid), this.object, this.index); }
  undo() { const p = this.object.parent; if (p) this.index = p.children.indexOf(this.object); this.object.removeFromParent(); }
  discard(from: 'undo' | 'redo') { if (from === 'redo') this.dispose?.(this.object); }   // undone and never redone: gone for good
}

export class RemoveObjectCommand implements Command {
  readonly label = 'Remove object';
  private doc: Doc; private object: THREE.Object3D; private parentUuid: string; private index: number; private dispose?: (o: THREE.Object3D) => void;
  constructor(doc: Doc, uuid: string, dispose?: (o: THREE.Object3D) => void) {
    this.doc = doc; this.object = doc.find(uuid); this.dispose = dispose;
    if (!this.object.parent) throw new Error('cannot remove the document root');
    this.parentUuid = this.object.parent.uuid; this.index = this.object.parent.children.indexOf(this.object);
  }
  execute() { this.object.removeFromParent(); }
  undo() { insertAt(this.doc.find(this.parentUuid), this.object, this.index); }
  discard(from: 'undo' | 'redo') { if (from === 'undo') this.dispose?.(this.object); }   // removed and can no longer be restored
}

/** Outliner drag. Keeps the world transform, so the object does not jump. */
export class ReparentCommand implements Command {
  readonly label = 'Reparent';
  private doc: Doc; private uuid: string; private newParent: string; private newIndex: number;
  private oldParent: string; private oldIndex: number; private oldPose: Pose;
  constructor(doc: Doc, uuid: string, newParent: string, newIndex = Infinity) {
    const o = doc.find(uuid), np = doc.find(newParent);
    for (let a: THREE.Object3D | null = np; a; a = a.parent) if (a === o) throw new Error('cannot parent an object under itself');
    this.doc = doc; this.uuid = uuid; this.newParent = newParent; this.newIndex = newIndex;
    this.oldParent = o.parent!.uuid; this.oldIndex = o.parent!.children.indexOf(o); this.oldPose = getPose(o);
  }
  execute() { const o = this.doc.find(this.uuid); const np = this.doc.find(this.newParent); np.attach(o); insertAt(np, o, this.newIndex); }
  undo() { const o = this.doc.find(this.uuid); insertAt(this.doc.find(this.oldParent), o, this.oldIndex); setPose(o, this.oldPose); }
}
```

Rules:
- **`execute` must be idempotent.** A drag moves the object live, then you record the command once with `before` and `after`. `history.execute` applies `after` again, which changes nothing.
- **Record on release, not per frame.** One drag is one undo step. Continuous controls (inspector sliders, arrow-key nudges) call `execute` on every change and the `mergeKey` plus a 500 ms window folds them into one step. `undo` and `redo` reset the window so a new edit never folds into an undone one.
- **Disposal belongs to the history.** Undoing a remove needs the geometry alive, so nothing is disposed on `RemoveObjectCommand.execute`. The `discard` hook disposes once the object can never return (trimmed off the undo stack, or an undone add whose redo branch was cleared). For prefab instances pass `(o) => library.despawn(o)` so shared resources are reference counted (`scene-assembly-prefabs` section 11).
- **Materials are shared by default.** `SetValueCommand` on `material.color` changes every object that shares it. Clone the material for that object first (copy on write, `scene-assembly-prefabs` section 7) and record that as part of a `MultiCommand`.
- Selection is not in the history (section 4). Make `onChange` the only way UI learns of changes: every panel and the render loop subscribe to it and redraw.
- Cap the stack (`limit`, default 200) and keep commands small: store poses and ids, not copies of geometry. A command that holds a large `ArrayBuffer` needs its own `discard`.
- Save and load do not replay commands. Serialize the document (`scene-assembly-prefabs` section 10) and clear the history on load.

## 3. Picking

| Method | Use when | Limits |
|---|---|---|
| `Raycaster` | Under about 5k meshes, static or ordinary skinned meshes, single click | CPU cost grows with triangles. **It ignores `visible`**: a hidden mesh is still hit. It tests the rest shape, not vertex-shader displacement |
| Raycaster with a BVH | Dense or large meshes | `three-mesh-bvh` (verify the API for your revision). One-time build per mesh |
| **GPU ID picking** | Thousands of objects, thin or tiny things, shader-displaced geometry, box select that must respect occlusion | One extra render of a small viewport. Needs an ID material that reproduces any vertex-shader motion |
| `SelectionBox` (`three/addons/interactive/SelectionBox.js`) | Quick box select without GPU work | Tests each mesh's **bounding sphere centre**. It selects hidden and fully occluded meshes too and ignores `visible`. Instances come back in `instances[uuid]` |

**Raycast rules.**
- Put editor helpers (gizmo, grid, outlines, labels) on a layer the raycaster does not use (`obj.layers.set(1)`, raycaster stays on layer 0), or filter on `userData.editorOnly`.
- Filter hits by `object.visible` and by your own `locked` flag yourself.
- Climb from the hit mesh to the selectable root: the nearest ancestor with `userData.prefabId` (`scene-assembly-prefabs`) or your own `selectable` flag. A click on a crate's lid selects the crate. Double click enters the group.
- Skip the click when the pointer moved more than about 4 px between down and up, or orbiting selects things. Skip it when `transformControls.axis` is not `null` (the pointer is over a gizmo handle).
- For `InstancedMesh` the hit carries `instanceId`. Select the pair (mesh uuid, instance id). Per-instance transforms need their own command that writes `setMatrixAt`.
- Touch: use `pointer` events, give hit tolerance by raising `raycaster.params.Line.threshold` and `Points.threshold`, and make the gizmo bigger (`transformControls.size`).

**GPU picking.** Each pickable mesh is drawn with a flat colour that encodes its index, into a 1 by 1 pixel view of the camera (`setViewOffset`). Read the pixel back, decode the index.

```ts
// file: gpu-pick.ts
import * as THREE from 'three';

export function createGpuPicker(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
  const target = new THREE.WebGLRenderTarget(1, 1);                    // 8 bit RGBA, no colour management on read
  const mats: THREE.MeshBasicMaterial[] = [];
  const idMaterial = (id: number) => (mats[id] ??= new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255),
    fog: false, toneMapped: false, side: THREE.DoubleSide,
  }));
  const clear = new THREE.Color();

  /** Run `fn` with every pickable drawn as its id colour (id = index + 1, 0 is empty). Restores everything afterwards. */
  function withIdScene(pickables: THREE.Mesh[], fn: () => void) {
    const saved = pickables.map((m) => ({ m, material: m.material }));
    const visibility = new Map<THREE.Object3D, boolean>();
    scene.traverse((o: any) => {                                       // hide other drawable content on layer 0, lines and sprites too
      if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !pickables.includes(o)) { visibility.set(o, o.visible); o.visible = false; }
    });
    const layers = camera.layers.mask; camera.layers.set(0);               // editor overlays live on layer 1 and stay out of the pass
    const bg = scene.background, fog = scene.fog, override = scene.overrideMaterial, shadow = renderer.shadowMap.autoUpdate;
    const clearAlpha = renderer.getClearAlpha(); renderer.getClearColor(clear);
    scene.background = null; scene.fog = null; scene.overrideMaterial = null; renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 1);
    pickables.forEach((m, i) => { m.material = idMaterial(i + 1); });
    try { fn(); } finally {
      saved.forEach(({ m, material }) => { m.material = material; });
      visibility.forEach((v, o) => { o.visible = v; });
      camera.layers.mask = layers;
      scene.background = bg; scene.fog = fog; scene.overrideMaterial = override; renderer.shadowMap.autoUpdate = shadow;
      renderer.setClearColor(clear, clearAlpha);
    }
  }

  function render(x: number, y: number, w: number, h: number) {         // x, y, w, h in CSS pixels of the canvas
    const pr = renderer.getPixelRatio(), size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = Math.floor(x * pr), py = Math.floor(y * pr), pw = Math.max(1, Math.floor(w * pr)), ph = Math.max(1, Math.floor(h * pr));
    target.setSize(pw, ph);
    camera.setViewOffset(size.x, size.y, px, py, pw, ph);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target); renderer.render(scene, camera); renderer.setRenderTarget(prev);
    camera.clearViewOffset();
    const buf = new Uint8Array(pw * ph * 4);
    renderer.readRenderTargetPixels(target, 0, 0, pw, ph, buf);
    return buf;
  }

  return {
    /** The pickable under one canvas pixel, or null. */
    pick(pickables: THREE.Mesh[], x: number, y: number): THREE.Mesh | null {
      let hit: THREE.Mesh | null = null;
      withIdScene(pickables, () => { const b = render(x, y, 1, 1); const id = (b[0] << 16) | (b[1] << 8) | b[2]; hit = id > 0 ? pickables[id - 1] ?? null : null; });
      return hit;
    },
    /** Every pickable with at least one visible pixel inside the rectangle. Occluded objects are excluded. */
    pickRect(pickables: THREE.Mesh[], x0: number, y0: number, x1: number, y1: number): THREE.Mesh[] {
      const found = new Set<THREE.Mesh>();
      withIdScene(pickables, () => {
        const b = render(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let i = 0; i < b.length; i += 4) { const id = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]; if (id > 0) found.add(pickables[id - 1]); }
      });
      return [...found];
    },
    dispose() { target.dispose(); mats.forEach((m) => m.dispose()); },
  };
}
```

- The ID material is plain `MeshBasicMaterial`, so a mesh whose shape is moved in the vertex shader (wind, waves, cloth on the GPU) is picked at its rest position. Give those meshes an ID material with the same vertex patch (`shader-craft`), or pick them by raycast against a proxy.
- Overlays (gizmo, grid, helpers) are on layer 1 and the pass renders layer 0 only. Hiding them with `visible` is **not** enough: `TransformControls` rewrites its handles' visibility every frame, so its lines and handles paint the ID buffer and a click on the selected object returns nothing (seen in the check). Other layer 0 content that is not pickable (floor, sky) is hidden by `visible`, lines and sprites included.
- Anti-aliasing and tone mapping must stay off for the ID target. A render target has neither by default.
- Cap the box select rectangle (for example 1024 by 1024 device pixels). A bigger rectangle only costs readback time.
- 24 bits give 16.7 million ids. For instances, write `setColorAt` ids on an `InstancedMesh` with a second ID material, then decode the same way (not verified here).
- `readRenderTargetPixels` stalls the pipeline. Call it on click and release, never per frame. For a hover highlight use a throttled raycast.

## 4. Selection and modifiers

`Selection` keeps an ordered list of uuids. The last one is the active object (the one the inspector shows and multi-edits pivot around).

```ts
// file: selection.ts
import * as THREE from 'three';
import { getPose, setPose, TransformCommand, MultiCommand, type Doc, type Pose } from './history.ts';

export class Selection {
  private ids: string[] = [];
  private listeners = new Set<(ids: readonly string[]) => void>();
  get list(): readonly string[] { return this.ids; }
  get active(): string | null { return this.ids[this.ids.length - 1] ?? null; }
  set(ids: string[]) { this.ids = [...new Set(ids)]; this.emit(); }
  toggle(id: string) { this.ids = this.ids.includes(id) ? this.ids.filter((x) => x !== id) : [...this.ids, id]; this.emit(); }
  remove(id: string) { this.ids = this.ids.filter((x) => x !== id); this.emit(); }
  clear() { if (this.ids.length) { this.ids = []; this.emit(); } }
  onChange(fn: (ids: readonly string[]) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(this.ids); }
}

/** One gizmo for many objects: the gizmo moves a pivot, every selected object follows it. */
export class SelectionPivot {
  readonly pivot = new THREE.Object3D();
  private items: { o: THREE.Object3D; rel: THREE.Matrix4; before: Pose }[] = [];
  private _m = new THREE.Matrix4(); private _pw = new THREE.Matrix4();

  /** Call on drag start (or when the selection changes). Pivot sits at the median of the objects' world positions. */
  begin(objects: THREE.Object3D[]) {
    const c = new THREE.Vector3(), v = new THREE.Vector3();
    objects.forEach((o) => { o.updateWorldMatrix(true, false); c.add(v.setFromMatrixPosition(o.matrixWorld)); });
    c.divideScalar(Math.max(objects.length, 1));
    this.pivot.position.copy(c); this.pivot.quaternion.identity(); this.pivot.scale.set(1, 1, 1); this.pivot.updateMatrixWorld(true);
    const inv = this.pivot.matrixWorld.clone().invert();
    this.items = objects.map((o) => ({ o, rel: inv.clone().multiply(o.matrixWorld), before: getPose(o) }));
  }
  /** Call on every gizmo change. */
  sync() {
    this.pivot.updateMatrixWorld(true);
    for (const { o, rel } of this.items) {
      this._m.multiplyMatrices(this.pivot.matrixWorld, rel);                          // wanted world matrix
      if (o.parent) { o.parent.updateWorldMatrix(true, false); this._pw.copy(o.parent.matrixWorld).invert(); this._m.premultiply(this._pw); }
      this._m.decompose(o.position, o.quaternion, o.scale); o.updateMatrix();
    }
  }
  /** Call on drag end. Returns one undoable command, or null if nothing moved. */
  end(doc: Doc): MultiCommand | null {
    const cmds = this.items
      .filter(({ o, before }) => JSON.stringify(getPose(o)) !== JSON.stringify(before))
      .map(({ o, before }) => new TransformCommand(doc, o.uuid, before, getPose(o)));
    return cmds.length ? new MultiCommand('Transform', cmds, cmds.map((c) => c.mergeKey).join('|')) : null;
  }
}
```

| Input | Result |
|---|---|
| Click on an object | `set([id])` |
| Shift click (Blender and Maya) | `toggle(id)`, last added becomes active |
| Ctrl click (Maya) | `remove(id)` |
| Click empty space | `clear()` (forgiving, as in `hud-ui-labels` section 12) |
| Box drag | `set(ids)`, with Shift to add. GPU box when occlusion matters, `SelectionBox` otherwise |
| Select all, none, invert | Ids of selectable roots only, never helpers |

Rules:
- Selection is **not** undoable. Maya treats it that way and an undo that jumps the selection around is confusing. If you want Blender behaviour, wrap changes in a command with the old and new id lists.
- A non-uniform scale on a rotated multi-selection shears the children, and `decompose` drops the shear. Limit the pivot to uniform scale for multi selections, or scale each object about its own origin.
- Do not attach the gizmo to a removed object. On `RemoveObjectCommand` and on undo of an add, call `selection.remove(uuid)` before the object leaves.
- Locked and hidden objects are excluded from picking and from select all.

## 5. Gizmos, snapping, wiring

`TransformControls` (`three/addons/controls/TransformControls.js`). It is no longer an `Object3D`, add `getHelper()` to the scene. Its events: `dragging-changed` (with `value`), `objectChange` (the attached object moved), `mouseDown`, `mouseUp`, and `<property>-changed` for each property. It handles its own pointer events on the canvas.

```ts
// file: gizmo.ts
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { History, Doc } from './history.ts';
import { SelectionPivot } from './selection.ts';

export function createGizmo(opts: { camera: THREE.Camera; dom: HTMLElement; scene: THREE.Scene; orbit: { enabled: boolean }; history: History; doc: Doc; getSelected: () => THREE.Object3D[]; requestRender: () => void }) {
  const { camera, dom, scene, orbit, history, doc, getSelected, requestRender } = opts;
  const tc = new TransformControls(camera, dom);
  const helper = tc.getHelper(); helper.traverse((o: THREE.Object3D) => o.layers.set(1));   // keep it out of raycasts and ID passes
  scene.add(helper);
  const sp = new SelectionPivot();
  sp.pivot.userData.editorOnly = true; scene.add(sp.pivot);      // TransformControls logs an error for an object that is not in the scene graph

  tc.addEventListener('dragging-changed', (e: any) => {
    orbit.enabled = !e.value;                                  // the gizmo and OrbitControls both listen to the same pointer
    if (e.value) sp.begin(getSelected());
    else { const cmd = sp.end(doc); if (cmd) history.execute(cmd); }
  });
  tc.addEventListener('objectChange', () => { sp.sync(); requestRender(); });
  tc.addEventListener('change', requestRender);

  return {
    tc,
    /** Call when the selection changes. Pass the selected objects. */
    attach(objects: THREE.Object3D[]) {
      if (!objects.length) { tc.detach(); return; }
      sp.begin(objects); tc.attach(sp.pivot);
    },
    setMode(m: 'translate' | 'rotate' | 'scale') { tc.setMode(m); },
    setSpace(s: 'world' | 'local') { tc.setSpace(s); },
    /** Grid snap. Pass null to turn it off. Rotation snap is in radians. */
    setSnap(on: boolean, move = 0.25, rotDeg = 15, scale = 0.1) {
      tc.setTranslationSnap(on ? move : null); tc.setRotationSnap(on ? THREE.MathUtils.degToRad(rotDeg) : null); tc.setScaleSnap(on ? scale : null);
    },
    dispose() { tc.dispose(); scene.remove(helper); scene.remove(sp.pivot); },
  };
}
```

- The pivot is an empty `Object3D` that the gizmo moves. It **must be in the scene graph** (`TransformControls` logs "The attached 3D object must be a part of the scene graph" otherwise), so `createGizmo` adds it and flags it `userData.editorOnly`. The outliner, the audit and `serializeScene` skip it. Keep it out of exports.
- Keep the gizmo a constant screen size: `tc.size` is relative to the view, 0.8 to 1.2 is a good range (guess). On touch raise it to 1.5 or more and keep handles reachable (`hud-ui-labels` section 9).
- Hold Ctrl to invert snap (toggle `setSnap` on key down and up), as Blender does.
- Space: `local` for rotating a door about its own axis, `world` for placing on a floor. Show the current space in the toolbar.
- **Vertex and surface snap** is yours. The simple version snaps to the nearest vertex of the hit face, within a pixel radius:

```ts
// file: vertex-snap.ts
import * as THREE from 'three';

/** World position of the hit-face vertex nearest the hit point, if it is within `maxPx` on screen. Otherwise null. */
export function snapToVertex(hit: THREE.Intersection, camera: THREE.Camera, viewportH: number, maxPx = 12): THREE.Vector3 | null {
  const mesh = hit.object as THREE.Mesh, face = hit.face;
  if (!face) return null;
  const pos = mesh.geometry.getAttribute('position');
  let best: THREE.Vector3 | null = null, bestD = Infinity;
  for (const i of [face.a, face.b, face.c]) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const d = v.distanceTo(hit.point);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (!best) return null;
  const persp = camera as THREE.PerspectiveCamera;
  const unitsPerPx = persp.isPerspectiveCamera
    ? 2 * hit.distance * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2) / viewportH
    : (((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom) / (camera as THREE.OrthographicCamera).zoom) / viewportH;
  return bestD / unitsPerPx <= maxPx ? best : null;
}
```

  Move the selection by `snapPoint - gizmoOrigin` while dragging, then record one command on release. Edge and face snap follow the same pattern with more candidates.

## 6. Selection outline

| Method | Cost | Use |
|---|---|---|
| `BoxHelper` or `Box3Helper` | Almost free | Default for many selected objects, and any tier |
| `OutlinePass` (`three/addons/postprocessing/OutlinePass.js`) | Several extra passes at screen size | Desktop editors, silhouette outline on the selected few |
| `OutlineNode` (`three/addons/tsl/display/OutlineNode.js`) | Same idea on WebGPU | When the editor runs on `WebGPURenderer` (verify the usage for your revision) |
| Inverted hull (a scaled-up back-face copy) | One extra draw per object | Cheap, thickness varies with mesh scale and concave shapes show gaps |

```ts
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const outline = new OutlinePass(new THREE.Vector2(innerWidth, innerHeight), scene, camera);
outline.edgeStrength = 3; outline.edgeThickness = 1; outline.visibleEdgeColor.set('#ffb000'); outline.hiddenEdgeColor.set('#553300');
composer.addPass(outline);
composer.addPass(new OutputPass());
outline.selectedObjects = selectedMeshes;          // set on every selection change
```

- Set `outline.selectedObjects` only from selection changes, never every frame. It rebuilds internal lists.
- Resize the composer and the pass with the renderer. Keep the passes order from `post-processing-stack`. A composer makes anti-aliasing a pass decision (`antialiasing-resolution`).
- Mark the active object in a different colour from the rest of the selection (Blender and Maya both do): outline the active mesh in a second pass instance.
- Outline thickness in pixels does not scale with the pixel ratio. Check on a phone.

## 7. Outliner

The outliner is a flat list of rows computed from the scene graph, not a tree of DOM nodes. A flat model is easy to filter, to virtualise and to test.

```ts
// file: outline.ts
import * as THREE from 'three';

export interface Row { uuid: string; depth: number; name: string; type: string; visible: boolean; hasChildren: boolean; expanded: boolean }

/** Rows below `root` in display order. Hidden helpers (`userData.editorOnly`) are skipped. With a filter, matches and their ancestors show. */
export function outlineRows(root: THREE.Object3D, expanded: ReadonlySet<string>, filter = ''): Row[] {
  const q = filter.trim().toLowerCase(), rows: Row[] = [];
  const matches = (o: THREE.Object3D): boolean => o.name.toLowerCase().includes(q) || o.children.some((c) => !c.userData.editorOnly && matches(c));
  const walk = (o: THREE.Object3D, depth: number) => {
    for (const c of o.children) {
      if (c.userData.editorOnly) continue;
      if (q && !matches(c)) continue;
      const kids = c.children.filter((k) => !k.userData.editorOnly);
      const open = q ? true : expanded.has(c.uuid);
      rows.push({ uuid: c.uuid, depth, name: c.name || `(${c.type})`, type: c.type, visible: c.visible, hasChildren: kids.length > 0, expanded: open });
      if (open) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
```

- Markup: `<ul role="tree">` with `<li role="treeitem" aria-level aria-expanded aria-selected>`. Arrow keys move and expand, Enter selects, F2 renames, Delete removes. Roving `tabindex`, one tab stop for the whole tree (`hud-ui-labels` section 9).
- Past a few thousand rows render only the visible window (a fixed row height and a spacer).
- Drag to reparent builds a `ReparentCommand`, rename builds `SetValueCommand` on `name`, the eye icon builds `SetValueCommand` on `visible`. Dropping on a descendant must be refused (the command throws).
- Selection in the outliner and in the viewport share one `Selection`. Scroll the row into view when the viewport selects.
- Name conventions that keep the list readable: `scene-assembly-prefabs` section 8. Use the object type icon, not the type string, in the UI.
- Rebuild rows on `history.onChange` and on `Selection.onChange`. Do not poll the scene.

## 8. Views: ortho, quad, frame selected

Standard views for a Y-up scene (three and glTF, Maya). Blender is Z-up, the exporter converts the axes (`blender-to-three-export`).

```ts
// file: views.ts
import * as THREE from 'three';

export const VIEWS = {
  top:    { dir: [0, 1, 0],  up: [0, 0, -1] },
  bottom: { dir: [0, -1, 0], up: [0, 0, 1] },
  front:  { dir: [0, 0, 1],  up: [0, 1, 0] },
  back:   { dir: [0, 0, -1], up: [0, 1, 0] },
  right:  { dir: [1, 0, 0],  up: [0, 1, 0] },
  left:   { dir: [-1, 0, 0], up: [0, 1, 0] },
} as const;
export type ViewName = keyof typeof VIEWS;

/** Orthographic camera framed on `target`, `halfHeight` world units from the centre to the top edge. */
export function makeOrtho(view: ViewName, target: THREE.Vector3, distance: number, aspect: number, halfHeight: number) {
  const cam = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, -1000, 1000);   // negative near keeps things behind the camera visible (verify on your scene)
  cam.up.set(...VIEWS[view].up);                                  // set BEFORE creating OrbitControls
  cam.position.copy(target).addScaledVector(new THREE.Vector3(...VIEWS[view].dir), distance);
  cam.lookAt(target);
  return cam;
}

/** Distance (perspective) at which a bounding sphere fits both the vertical and the horizontal field of view. */
export function fitDistance(sphere: THREE.Sphere, camera: THREE.PerspectiveCamera, margin = 1.15): number {
  const v = THREE.MathUtils.degToRad(camera.fov), h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
  return (sphere.radius * margin) / Math.sin(Math.min(v, h) / 2);
}

/** Frame objects. Moves the camera along its current view direction. Returns the new orbit target. */
export function frameObjects(objects: THREE.Object3D[], camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, margin = 1.15): THREE.Vector3 {
  const box = new THREE.Box3();
  for (const o of objects) box.expandByObject(o);                  // pass precise: true to Box3.setFromObject for skinned or displaced meshes
  if (box.isEmpty()) return new THREE.Vector3();
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dir = camera.getWorldDirection(new THREE.Vector3());
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    camera.position.copy(sphere.center).addScaledVector(dir, -fitDistance(sphere, camera as THREE.PerspectiveCamera, margin));
  } else {
    const o = camera as THREE.OrthographicCamera;
    o.zoom = Math.min((o.right - o.left), (o.top - o.bottom)) / (2 * sphere.radius * margin);   // frustum size is for zoom 1
    o.position.copy(sphere.center).addScaledVector(dir, -Math.max(sphere.radius * 2, 1));
    o.updateProjectionMatrix();
  }
  camera.lookAt(sphere.center);
  return sphere.center;
}
```

- **Set `camera.up` before `new OrbitControls(camera, dom)`.** The controls compute their up-axis rotation once in the constructor (checked in the source). Changing `up` afterwards gives a wrong or flipped orbit. In practice: one camera and one controls object per view, and for ortho views `controls.enableRotate = false` so only pan and zoom work. A top view orbiting by accident is a bug, Blender locks to the axis until you rotate on purpose.
- An orthographic camera zooms by `camera.zoom`, not by moving, and `OrbitControls` supports that. Keep the frustum at zoom 1 and change only the zoom.
- Perspective to ortho toggle that keeps the same framing: `halfHeight = distance * Math.tan(fov / 2)`.
- After `frameObjects`, set the orbit controls target to the returned centre and call `controls.update()`. Animate the move with damping, the same constant as the rest of the UI (`motion-choreography`), and snap when `prefers-reduced-motion` is set.
- F frames the selection, Home (or A in Maya) frames everything. Empty selection frames everything.
- **Quad view** (top, front, side, perspective): one renderer, four viewports, each with its own camera and controls.

```ts
export function renderViews(renderer: THREE.WebGLRenderer, scene: THREE.Scene, views: { camera: THREE.Camera; rect: [number, number, number, number] }[]) {
  const size = renderer.getSize(new THREE.Vector2());               // rect is 0..1 of the canvas, origin bottom left
  renderer.setScissorTest(true);
  for (const v of views) {
    const x = v.rect[0] * size.x, y = v.rect[1] * size.y, w = v.rect[2] * size.x, h = v.rect[3] * size.y;
    renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h);
    renderer.render(scene, v.camera);
  }
  renderer.setScissorTest(false);
}
```

  Route pointer events to the viewport that contains the pointer on `pointerdown` and keep it captured until `pointerup`. Set each camera's `aspect` (or ortho left and right) from its own rect on resize. Draw a 1 px divider and highlight the active viewport.

## 9. Grid, axes, orientation

| Tool | Use |
|---|---|
| `GridHelper(size, divisions, centerColor, gridColor)` | Small bounded floors and quick prototypes. Fixed size, z-fights with coplanar geometry, aliases at distance |
| `AxesHelper(size)` | World origin. Red X, green Y, blue Z |
| `ViewHelper` (`three/addons/helpers/ViewHelper.js`) | Blender-style orientation gizmo. `new ViewHelper(camera, dom)`, call `render(renderer)` after the scene, `handleClick(event)` snaps the view, `update(delta)` while `animating` |
| Infinite shader grid (below) | Editors: fades with distance, anti-aliased lines, no end |

```ts
// file: grid.ts
import * as THREE from 'three';

/** Infinite grid on y = 0. Add the mesh once, it follows the camera in x and z. Minor lines every `cell`, major every 10 cells, red X axis, blue Z axis. */
export function createInfiniteGrid({ cell = 1, fade = 80 } = {}) {
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uCell: { value: cell }, uFade: { value: fade } },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uCell; uniform float uFade; varying vec3 vWorld;
      float line(vec2 p, float cell) {
        vec2 q = p / cell;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);          // distance to the nearest line, in pixels
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = line(vWorld.xz, uCell), major = line(vWorld.xz, uCell * 10.0);
        float ax = 1.0 - min(abs(vWorld.z) / fwidth(vWorld.z), 1.0);   // X axis lies where z = 0
        float az = 1.0 - min(abs(vWorld.x) / fwidth(vWorld.x), 1.0);
        vec3 col = mix(vec3(0.55), vec3(0.9, 0.22, 0.22), ax);
        col = mix(col, vec3(0.22, 0.42, 0.95), az);
        float a = max(max(minor * 0.22, major * 0.45), max(ax, az) * 0.9);
        a *= 1.0 - smoothstep(uFade * 0.5, uFade, distance(vWorld.xz, cameraPosition.xz));
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), material);
  mesh.frustumCulled = false; mesh.renderOrder = -1; mesh.layers.set(1);
  mesh.onBeforeRender = (_r, _s, camera) => {
    const step = material.uniforms.uCell.value * 10;                  // snap to the major grid so lines do not swim
    mesh.position.set(Math.round(camera.position.x / step) * step, 0, Math.round(camera.position.z / step) * step);
  };
  return mesh;
}
```

- The grid lives on layer 1 so picking ignores it, and the camera must have layer 1 enabled (`camera.layers.enable(1)`). Show it only in editor mode, never in the exported scene.
- In ortho top and side views the grid cell should follow the zoom: pick `uCell` from a ladder (0.1, 1, 10) so lines stay 8 to 80 px apart, and label the scale.
- Use the same units everywhere: metres. Show the current snap step next to the grid.
- Fade the grid near the horizon, and fade it out at grazing angles to hide moire (a `1 - abs(viewDir.y)` factor, tune by eye).

## 10. Shading and overlay modes

| Mode | How | Notes |
|---|---|---|
| Solid, lit | No override | The default scene |
| Wireframe | `scene.overrideMaterial = new MeshBasicMaterial({ wireframe: true })` | Shows all triangle edges. Line width stays 1 px (`wireframeLinewidth` is ignored) |
| Solid plus wire | Overlay: `LineSegments` of `WireframeGeometry` or `EdgesGeometry` per selected mesh, with `polygonOffset` on the solid material | Do it for the selection only, not the whole scene |
| Normals | `scene.overrideMaterial = new MeshNormalMaterial()` | Finds flipped normals and shading seams |
| Depth | `scene.overrideMaterial = new MeshDepthMaterial()` | Checks near and far planes |
| UV check | A per-mesh swap to `MeshBasicMaterial({ map: checkerTexture })` | Needs UVs (`uv-unwrap-packing`) |
| Unlit albedo | Per-mesh swap to `MeshBasicMaterial({ map, color })` from the original | Judge textures without lights |

```ts
// file: shading.ts
import * as THREE from 'three';

export type Shading = 'solid' | 'wire' | 'normals' | 'depth';

export function setShading(scene: THREE.Scene, mode: Shading) {
  scene.overrideMaterial?.dispose();
  scene.overrideMaterial =
    mode === 'wire' ? new THREE.MeshBasicMaterial({ wireframe: true, color: 0xdddddd }) :
    mode === 'normals' ? new THREE.MeshNormalMaterial() :
    mode === 'depth' ? new THREE.MeshDepthMaterial() : null;
}

/** Selection wire overlay. Offset the solid so lines do not z-fight with it. Returns a remover. */
export function addWireOverlay(mesh: THREE.Mesh, color = 0xffb000): () => void {
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), new THREE.LineBasicMaterial({ color }));
  lines.userData.editorOnly = true; lines.layers.set(1);
  mesh.add(lines);
  const mats = [].concat(mesh.material as any) as THREE.Material[];
  mats.forEach((m) => { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; });
  return () => { lines.removeFromParent(); lines.geometry.dispose(); (lines.material as THREE.Material).dispose(); };
}
```

- `overrideMaterial` replaces every material, including alpha cutouts and double-sided settings, so foliage and glass look solid. That is expected for a debug view.
- Show the mode in the toolbar and keep it out of screenshots meant for QA.
- Overlays (grid, gizmo, outlines, helpers, wire) go on layer 1 and render in a pass the exported scene never has. Verify that exporting or `render-qa` capture does not include them.
- Light mode and an editor background: use a neutral grey (about 0.25 linear) so both dark and bright objects read, as DCCs do.

## 11. Inspector

A schema describes each editable property once. The panel is generated from it, and every change becomes a command.

```ts
// file: inspector.ts
export type Field =
  | { kind: 'number'; path: string; label: string; min?: number; max?: number; step?: number }
  | { kind: 'bool' | 'text' | 'color'; path: string; label: string };

export const OBJECT_FIELDS: Field[] = [
  { kind: 'text', path: 'name', label: 'Name' }, { kind: 'bool', path: 'visible', label: 'Visible' },
  { kind: 'number', path: 'position.x', label: 'X', step: 0.01 }, { kind: 'number', path: 'position.y', label: 'Y', step: 0.01 }, { kind: 'number', path: 'position.z', label: 'Z', step: 0.01 },
  { kind: 'number', path: 'scale.x', label: 'Sx', step: 0.01, min: 0.001 }, { kind: 'number', path: 'scale.y', label: 'Sy', step: 0.01, min: 0.001 }, { kind: 'number', path: 'scale.z', label: 'Sz', step: 0.01, min: 0.001 },
];
export const MATERIAL_FIELDS: Field[] = [
  { kind: 'color', path: 'material.color', label: 'Colour' },
  { kind: 'number', path: 'material.roughness', label: 'Roughness', min: 0, max: 1, step: 0.01 },
  { kind: 'number', path: 'material.metalness', label: 'Metalness', min: 0, max: 1, step: 0.01 },
];
export const fieldsFor = (o: any): Field[] => [...OBJECT_FIELDS, ...(o.isMesh && o.material?.isMeshStandardMaterial ? MATERIAL_FIELDS : [])];
```

- Rotation is edited as degrees and written as a quaternion through `TransformCommand`. Do not expose `rotation.x` directly, Euler gimbal makes it unstable.
- Multi-selection: show a field only if every object has it, and show "mixed" when values differ. An edit writes one `SetValueCommand` per object inside a `MultiCommand`.
- Scrubbing (drag on a number to change it, as in Blender): `setPointerCapture`, 1 px is `step`, Shift for fine, Ctrl for coarse. Every move executes a command, the merge window folds them into one step. Typed values apply on Enter or blur.
- Colour edits write hex numbers (the sample reads `getHex`). That is sRGB-ish 8 bit, fine for UI colours, not for HDR emissive.
- Show units (metres, degrees). Clamp with `min`, `max`. Reject NaN.
- UI quality (target sizes, focus order, labels for screen readers, Thai text and font fallback) follows `hud-ui-labels`.

## 12. Render loop, performance

- **Render on demand.** An editor is idle most of the time. Call `requestRender()` from `history.onChange`, `Selection.onChange`, controls `change`, gizmo `change`, resize and asset load. One `requestAnimationFrame` per request, coalesced. Keep a continuous loop only while an animation preview or a damped orbit is running (`performance-budget` section 5).
- Pause rendering when the tab is hidden.
- The picking ID pass and a quad view each add render work: four viewports is four scene renders. Drop shadows and post processing in the ortho viewports.
- Keep overlays cheap: one grid mesh, one helper per selected object, `BoxHelper` and `Box3Helper` updated on selection change only.
- Large scenes: raycast against a pickable list (meshes only, no helpers), refresh it when the document changes. For GPU picking the list is the same.
- Show draw calls and triangles in a stats readout (`renderer.info`), as the budgets in `performance-budget` are the editor's main feedback.

## 13. Failure symptoms

| Symptom | Cause | Fix |
|---|---|---|
| Orbit moves while dragging the gizmo | Both listen to the pointer | `orbit.enabled = !event.value` on `dragging-changed` |
| Click after orbit selects something | No drag threshold | Ignore pointer up if it moved more than about 4 px |
| Clicking the gizmo selects what is behind it | Selection ignores the gizmo | Skip selection when `tc.axis !== null`, gizmo on layer 1 |
| A hidden object is still selected by click | `Raycaster` ignores `visible` | Filter hits on `visible` and `locked` |
| Undo changes nothing visible | Command holds object references that were replaced | Store uuids, resolve at execute time |
| Undo undoes too little or too much | One command per frame during a drag | Record on release, or use `mergeKey` |
| A recoloured object recolours all its copies | Shared material | Copy on write (`scene-assembly-prefabs`) |
| Undone remove cannot be restored, black or missing mesh | Disposed on remove | Dispose in `discard` only |
| Memory climbs in a long session | Discarded commands keep objects | Implement `discard`, cap `limit` |
| Top view orbit flips or rolls | `camera.up` changed after the controls were created | Set `up` before the controls, or one camera per view |
| Ortho view clips objects near the camera | Positive near plane | Negative near, or place the camera outside the scene |
| Frame selected leaves the object cut off | Used the vertical FOV only | `fitDistance` uses the smaller of vertical and horizontal |
| Box select picks hidden objects | `SelectionBox` tests centres, ignores occlusion | GPU `pickRect`, or filter by visibility |
| GPU pick returns the wrong object on animated geometry | ID material has no vertex animation | Give it the same vertex patch |
| GPU pick returns nothing | Tone mapping, fog, anti-aliasing or lights changed the colour | ID materials with `toneMapped: false`, `fog: false`, no MSAA on the target |
| Grid lines shimmer | No anti-aliasing in the grid shader | Use the `fwidth` form (section 9) |
| Overlays appear in exported renders | Helpers on layer 0 | Layer 1, camera layers per pass |

## 14. Verify

Checks run for this skill (Node 22.22 for the TypeScript, headless Chromium with SwiftShader and three 0.187.0 for the rendering):

| Check | Result |
|---|---|
| History: execute, undo, redo, redo cleared by a new edit | confirmed |
| Merge: 20 slider edits inside the window fold into one undo step, a pause splits them | confirmed |
| Add and remove restore the object at the same index, same instance | confirmed |
| Remove then trim: object disposed only when it falls off the undo stack | confirmed |
| `MultiCommand` undoes in reverse order | confirmed |
| `ReparentCommand` keeps the world matrix and refuses a cycle | confirmed |
| `SelectionPivot`: a moved pivot moves two objects with different parents, one command, undo restores | confirmed |
| `outlineRows` with collapse, expand, filter and `editorOnly` | confirmed |
| `frameObjects` and `fitDistance`: all 8 box corners fall inside the viewport for perspective and ortho | confirmed |
| `snapToVertex` near and far from a corner | confirmed |
| `Raycaster` hits a mesh with `visible = false` | confirmed |
| GPU `pick` and `pickRect`: right mesh at pixel ratio 1 and 2, the occluder where it hides another mesh, nothing on empty space, two fully occluded meshes excluded from the box, scene state restored, still correct with the gizmo attached | confirmed |
| `TransformControls` driven programmatically (`dragging` true, move the pivot, `objectChange`, `dragging` false) | orbit disabled during the drag, two objects moved together, one undo step, undo restores both |
| Projecting with a camera whose matrices were never updated | gives wrong pixels on the first call, call `camera.updateMatrixWorld()` first |
| Infinite grid (red and blue axis pixels found in a top view), normals, depth and wire shading, wire overlay add and remove, `OutlinePass` (amber outline pixels found), quad view with four different quadrants, `ViewHelper` | rendered, no console errors |

Then, in your own editor:
1. Do ten edits of mixed kinds, undo all of them, redo all of them. The scene and the inspector must match the start and the end exactly.
2. Run an add, a remove and a reparent, undo them in reverse, check `renderer.info.memory` is unchanged.
3. Click, drag a box over occluded objects, orbit and click again on a phone-sized viewport. Nothing selects by accident.
4. `render-qa` the scene with the editor overlays off and compare with the exported view.

Not verified in this skill: `three-mesh-bvh` usage, `OutlineNode` on WebGPU, instance-level GPU picking, negative near planes on every platform, touch gestures on a real device.
