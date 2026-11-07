#!/usr/bin/env node
// render-check.mjs — headless render QA for Three.js scenes.
//
// Usage:
//   node render-check.mjs <scene.html | http(s)://url> [options]
//
// Options:
//   --out <dir>            output folder (default: ./render-qa-out)
//   --angles <n>           extra orbit shots around controls.target (default 4, 0 = off)
//   --size <WxH>           desktop viewport (default 1280x720)
//   --no-mobile            skip the 390x844 phone shot
//   --wait <ms>            settle time after __sceneReady (default 1500)
//   --timeout <ms>         max wait for __sceneReady (default 20000)
//   --offline-three <dir>  serve any ".../three@x.y.z/<path>" request from a local
//                          node_modules/three folder (for sandboxes that block CDNs)
//   --query <qs>           query string appended to the page, e.g. "tier=high"
//   --gpu                  use the real GPU instead of SwiftShader
//   --dark                 emulate prefers-color-scheme: dark
//
// Scene contract (optional but recommended):
//   window.__three = { THREE, renderer, scene, camera, controls }
//   window.__sceneReady = true   // once assets are loaded and a frame is drawn
//
// Exit code: 0 = no blocking issues, 1 = blocking issues (errors, blank frame, no WebGL).

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Playwright not found. Install it with: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

// ───────── args ─────────
const argv = process.argv.slice(2);
const opt = { out: 'render-qa-out', angles: 4, size: '1280x720', mobile: true, wait: 1500, timeout: 20000, offlineThree: null, query: '', gpu: false };
let target = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--angles') opt.angles = +argv[++i];
  else if (a === '--size') opt.size = argv[++i];
  else if (a === '--no-mobile') opt.mobile = false;
  else if (a === '--wait') opt.wait = +argv[++i];
  else if (a === '--timeout') opt.timeout = +argv[++i];
  else if (a === '--offline-three') opt.offlineThree = path.resolve(argv[++i]);
  else if (a === '--query') opt.query = argv[++i].replace(/^\?/, '');
  else if (a === '--gpu') opt.gpu = true;
  else if (a === '--dark') opt.dark = true;
  else if (!a.startsWith('--')) target = a;
}
if (!target) { console.error('usage: node render-check.mjs <scene.html|url> [--out dir] [--angles n] ...'); process.exit(2); }
const [W, H] = opt.size.split('x').map(Number);
fs.mkdirSync(opt.out, { recursive: true });

// ───────── static server for local files ─────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm' };
let server = null, url = target;
if (!/^https?:\/\//.test(target)) {
  const file = path.resolve(target);
  const root = path.dirname(file);
  server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(path.basename(file))}`;
}
if (opt.query) url += (url.includes('?') ? '&' : '?') + opt.query;

// ───────── browser ─────────
const browser = await chromium.launch({
  args: opt.gpu ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function openPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: opt.dark ? 'dark' : 'light', ...extra });
  const page = await ctx.newPage();
  const log = { errors: [], warnings: [], failedRequests: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') log.errors.push(t);
    else if (m.type() === 'warning' && !/GPU stall|swiftshader|Automatic fallback/i.test(t)) log.warnings.push(t);
  });
  page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => log.failedRequests.push(`${r.failure()?.errorText} ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) log.failedRequests.push(`${r.status()} ${r.url()}`); });
  if (opt.offlineThree) {
    await page.route(/\/three@[^/]+\/.+/, (route) => {
      const rel = route.request().url().split(/\/three@[^/]+\//)[1].split('?')[0];
      const p = path.join(opt.offlineThree, rel);
      if (!fs.existsSync(p)) return route.fulfill({ status: 404, body: 'not found offline: ' + rel });
      route.fulfill({ status: 200, contentType: MIME[path.extname(p)] || 'text/javascript', body: fs.readFileSync(p) });
    });
  }
  // Frame gate: lets QA pause the scene's rAF loop and step exact frames.
  // Without it a slow (CPU / SwiftShader) render loop starves screenshots.
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    let paused = false, queue = [];
    window.requestAnimationFrame = (cb) => { if (paused) { queue.push(cb); return 0; } return raf(cb); };
    window.__qa = {
      pause() { paused = true; },
      resume() { paused = false; const q = queue; queue = []; q.forEach((cb) => raf(cb)); },
      async frames(n = 2) { this.resume(); for (let i = 0; i < n; i++) await new Promise((r) => raf(r)); this.pause(); },
    };
  });
  page.setDefaultTimeout(Math.max(60000, opt.timeout * 2));
  await page.goto(url, { waitUntil: 'load' });
  const ready = await page.waitForFunction(() => window.__sceneReady === true, null, { timeout: opt.timeout, polling: 250 }).then(() => true).catch(() => false);
  await page.waitForTimeout(opt.wait);
  await page.evaluate(() => window.__qa.pause());
  return { ctx, page, log, ready };
}

// Luminance statistics of a PNG, computed inside the browser (no extra deps).
async function analyse(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    const s = Math.min(1, 480 / img.width);
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sum2 = 0, black = 0, white = 0, sat = 0, cn = 0, cs = 0, cs2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
      if (px > c.width * 0.2 && px < c.width * 0.8 && py > c.height * 0.2 && py < c.height * 0.8) { cn++; cs += L; cs2 += L * L; }
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      sum += L; sum2 += L * L; n++;
      if (L < 6) black++; if (L > 250) white++;
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
    const mean = sum / n, cm = cs / cn;
    return { meanLuma: +mean.toFixed(1), contrastStd: +Math.sqrt(sum2 / n - mean * mean).toFixed(1),
      subjectContrastStd: +Math.sqrt(cs2 / cn - cm * cm).toFixed(1),
      clippedBlackPct: +(100 * black / n).toFixed(2), clippedWhitePct: +(100 * white / n).toFixed(2), meanSaturation: +(sat / n).toFixed(3) };
  }, png.toString('base64'));
}

// Inspect renderer / scene configuration through window.__three
async function inspect(page) {
  return page.evaluate(() => {
    const T = window.__three;
    if (!T || !T.renderer) return null;
    const { THREE, renderer, scene, camera } = T;
    const gl = renderer.getContext();
    // Clean single-pass render for honest scene stats (post passes excluded)
    const auto = renderer.info.autoReset;
    renderer.info.autoReset = false; renderer.info.reset();
    renderer.render(scene, camera);
    const r = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points, lines: renderer.info.render.lines };
    renderer.info.autoReset = auto;
    const mem = { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? null };

    const mats = new Set(), types = {}, issues = [];
    let meshes = 0, instanced = 0, castShadow = 0, lights = 0, shadowLights = 0, maxShadowMap = 0;
    const texSeen = new Set();
    const colorSlots = ['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap'];
    const dataSlots = ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap', 'displacementMap', 'clearcoatNormalMap'];
    scene.traverse((o) => {
      if (o.isLight) {
        lights++;
        if (o.castShadow) { shadowLights++; maxShadowMap = Math.max(maxShadowMap, o.shadow?.mapSize?.x || 0); }
      }
      if (!o.isMesh) return;
      meshes++; if (o.isInstancedMesh) instanced++; if (o.castShadow) castShadow++;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m) continue;
        mats.add(m.uuid); types[m.type] = (types[m.type] || 0) + 1;
        for (const k of colorSlots) { const t = m[k]; if (t && !texSeen.has(t.uuid + k)) { texSeen.add(t.uuid + k); if (t.colorSpace !== THREE.SRGBColorSpace && !t.isRenderTargetTexture) issues.push(`${m.name || m.type}.${k} should use SRGBColorSpace`); } }
        for (const k of dataSlots) { const t = m[k]; if (t && t.colorSpace === THREE.SRGBColorSpace) issues.push(`${m.name || m.type}.${k} is data, must NOT be SRGBColorSpace`); }
        if (m.map && m.map.anisotropy < 4) issues.push(`${m.name || m.type}.map anisotropy ${m.map.anisotropy} (set to renderer.capabilities.getMaxAnisotropy())`);
      }
      const g = o.geometry;
      if (g && !g.attributes.normal) issues.push(`mesh "${o.name || o.uuid.slice(0, 6)}" has no normals`);
    });

    const ToneNames = Object.fromEntries(Object.entries(THREE).filter(([k]) => /ToneMapping$/.test(k)).map(([k, v]) => [v, k]));
    const ShadowNames = { [THREE.BasicShadowMap]: 'Basic', [THREE.PCFShadowMap]: 'PCF', [THREE.PCFSoftShadowMap]: 'PCFSoft', [THREE.VSMShadowMap]: 'VSM' };
    return {
      three: THREE.REVISION,
      webgl: gl.getParameter(gl.VERSION),
      gpu: (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })(),
      tier: T.tier ?? null,
      config: {
        outputColorSpace: renderer.outputColorSpace,
        toneMapping: ToneNames[renderer.toneMapping] || renderer.toneMapping,
        exposure: renderer.toneMappingExposure,
        pixelRatio: renderer.getPixelRatio(),
        shadowMap: renderer.shadowMap.enabled ? ShadowNames[renderer.shadowMap.type] : 'off',
        environment: !!scene.environment,
        environmentIntensity: scene.environmentIntensity ?? null,
        fog: scene.fog ? scene.fog.type : null,
        cameraFov: camera.fov ?? null,
        postProcessing: !!T.composer,
      },
      render: r, memory: mem,
      scene: { meshes, instanced, materials: mats.size, materialTypes: types, lights, shadowLights, maxShadowMap, meshesCastingShadow: castShadow },
      issues,
    };
  });
}

// Orbit the camera around controls.target at constant distance and elevation
async function orbitTo(page, deg) {
  return page.evaluate(async (deg) => {
    const { camera, controls } = window.__three;
    const tgt = controls?.target ?? camera.position.clone().set(0, 0, 0);
    if (controls) controls.autoRotate = false;
    const off = camera.position.clone().sub(tgt);
    const r = Math.hypot(off.x, off.z), y = off.y;
    const base = Math.atan2(off.x, off.z);
    const a = base + (deg * Math.PI) / 180;
    camera.position.set(tgt.x + Math.sin(a) * r, tgt.y + y, tgt.z + Math.cos(a) * r);
    camera.lookAt(tgt);
    controls?.update?.();
    return true;
  }, deg);
}

// Rough frame-rate sample. SwiftShader is CPU rendering: treat as relative, not absolute.
async function sampleFps(page, ms = 2000) {
  return page.evaluate((ms) => new Promise((res) => {
    window.__qa.resume();
    let f = 0; const t0 = performance.now();
    const tick = () => {
      f++;
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else { window.__qa.pause(); res(+(f * 1000 / (performance.now() - t0)).toFixed(1)); }
    };
    requestAnimationFrame(tick);
  }), ms);
}

// ───────── run ─────────
const report = { url, time: new Date().toISOString(), renderer: opt.gpu ? 'gpu' : 'swiftshader (CPU — fps is relative only)', shots: [], blocking: [], warnings: [] };
const desk = await openPage({ width: W, height: H });
report.ready = desk.ready;
if (!desk.ready) report.warnings.push('window.__sceneReady never became true — screenshots may show a half-loaded scene');

const info = await inspect(desk.page);
report.inspect = info;
if (!info) report.warnings.push('window.__three not exposed — config/stat checks skipped (expose { THREE, renderer, scene, camera, controls })');

async function shoot(page, name) {
  await page.evaluate(() => window.__qa.frames(3)); // render fresh frames, then freeze the loop
  const buf = await page.screenshot({ path: path.join(opt.out, name + '.png') });
  const stats = await analyse(page, buf);
  report.shots.push({ name, file: path.join(opt.out, name + '.png'), ...stats });
  return stats;
}

await shoot(desk.page, '01-hero');
report.fpsSample = await sampleFps(desk.page);

if (info && opt.angles > 0) {
  const start = await desk.page.evaluate(() => window.__three.camera.position.toArray());
  for (let i = 1; i <= opt.angles; i++) {
    await desk.page.evaluate((p) => window.__three.camera.position.fromArray(p), start);
    await orbitTo(desk.page, (360 / (opt.angles + 1)) * i);
    await desk.page.waitForTimeout(250);
    await shoot(desk.page, `0${i + 1}-orbit-${Math.round((360 / (opt.angles + 1)) * i)}deg`);
  }
}

if (opt.mobile) {
  const mob = await openPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await shoot(mob.page, '99-mobile');
  report.mobileInspect = await inspect(mob.page).then((i) => i && { tier: i.tier, config: i.config, render: i.render });
  desk.log.errors.push(...mob.log.errors.map((e) => '[mobile] ' + e));
  await mob.ctx.close();
}

report.console = desk.log;

// ───────── verdicts ─────────
if (desk.log.errors.length) report.blocking.push(`${desk.log.errors.length} console/page error(s)`);
if (desk.log.failedRequests.length) report.blocking.push(`${desk.log.failedRequests.length} failed request(s)`);
for (const s of report.shots) {
  if (s.contrastStd < 3) report.blocking.push(`${s.name}: frame looks blank (contrast std ${s.contrastStd})`);
  if (s.clippedWhitePct > 8) report.warnings.push(`${s.name}: ${s.clippedWhitePct}% pixels blown out — lower exposure/bloom/light intensity`);
  if (s.clippedBlackPct > (opt.dark ? 40 : 15)) report.warnings.push(`${s.name}: ${s.clippedBlackPct}% pixels crushed to black — add fill/env light`);
  if (s.subjectContrastStd < 28) report.warnings.push(`${s.name}: low subject contrast (centre std ${s.subjectContrastStd}) — image reads flat/hazy; strengthen key vs env, darken backdrop, check tone mapping`);
  if (s.meanLuma < (opt.dark ? 12 : 35)) report.warnings.push(`${s.name}: very dark overall (mean luma ${s.meanLuma})`);
  if (s.meanLuma > 225) report.warnings.push(`${s.name}: very bright/washed out (mean luma ${s.meanLuma})`);
}
if (info) {
  const c = info.config;
  if (c.outputColorSpace !== 'srgb') report.warnings.push(`outputColorSpace is ${c.outputColorSpace}, expected srgb`);
  if (/NoToneMapping/.test(String(c.toneMapping))) report.warnings.push('No tone mapping — use AgX, ACESFilmic or Neutral');
  if (!c.environment) report.warnings.push('scene.environment not set — PBR materials will look flat (use PMREM + RoomEnvironment/HDRI)');
  if (c.shadowMap === 'off') report.warnings.push('Shadow map disabled — objects will float');
  if (c.pixelRatio > 2) report.warnings.push(`pixelRatio ${c.pixelRatio} > 2 — cap with Math.min(devicePixelRatio, 2)`);
  const t = info.scene.materialTypes;
  for (const cheap of ['MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshNormalMaterial']) if (t[cheap]) report.warnings.push(`${t[cheap]}× ${cheap} — hero surfaces should be MeshStandard/MeshPhysical`);
  if (info.render.calls > 300) report.warnings.push(`${info.render.calls} draw calls — over desktop budget (≤300); instance/merge`);
  if (info.render.triangles > 1_500_000) report.warnings.push(`${(info.render.triangles / 1e6).toFixed(2)}M triangles — over desktop budget (≤1.5M)`);
  if (info.scene.meshes > 3 && info.scene.meshesCastingShadow === 0) report.warnings.push('No mesh casts shadows');
  report.warnings.push(...info.issues);
}
report.pass = report.blocking.length === 0;

// ───────── write ─────────
fs.writeFileSync(path.join(opt.out, 'report.json'), JSON.stringify(report, null, 2));
const md = [
  `# Render QA — ${report.pass ? 'PASS' : 'FAIL'}`, '', `URL: ${url}`, `Renderer: ${report.renderer}`, '',
  info ? `three r${info.three} · ${info.webgl} · tier ${info.tier ?? '-'} · ${info.render.calls} draw calls · ${(info.render.triangles / 1000).toFixed(1)}k tris · ${info.scene.materials} materials · ${info.scene.lights} lights` : '_no __three hook_',
  `FPS sample: ${report.fpsSample}`, '',
  '## Blocking', ...(report.blocking.length ? report.blocking.map((x) => '- ' + x) : ['- none']), '',
  '## Warnings', ...(report.warnings.length ? report.warnings.map((x) => '- ' + x) : ['- none']), '',
  '## Shots', '| shot | mean luma | contrast | subject contrast | black % | white % | sat |', '|---|---|---|---|---|---|---|',
  ...report.shots.map((s) => `| ${s.name} | ${s.meanLuma} | ${s.contrastStd} | ${s.subjectContrastStd} | ${s.clippedBlackPct} | ${s.clippedWhitePct} | ${s.meanSaturation} |`), '',
  info ? '## Config\n```json\n' + JSON.stringify(info.config, null, 2) + '\n```' : '',
  desk.log.errors.length ? '## Console errors\n' + desk.log.errors.map((e) => '- ' + e).join('\n') : '',
].join('\n');
fs.writeFileSync(path.join(opt.out, 'report.md'), md);
console.log(md);

await browser.close();
server?.close();
process.exit(report.pass ? 0 : 1);
