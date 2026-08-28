/**
 * SHENZHEN CBD 3D — 入口
 * 静态托管，无后端；瓦片按需 fetch。
 */
import * as THREE from 'three';
import { CONFIG, PALETTE, Geo, headingOf, clamp } from './config.js';
import { TileManager } from './tiles.js';
import { Controls, Mode } from './controls.js';
import { Minimap } from './minimap.js';
import { LabelLayer } from './labels.js';

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $('scene'),
  statusDot: $('statusDot'),
  cityState: $('cityState'),
  fps: $('fps'),
  tileCount: $('tileCount'),
  outLatLon: $('outLatLon'),
  outXZ: $('outXZ'),
  outY: $('outY'),
  outHeading: $('outHeading'),
  outTile: $('outTile'),
  streamState: $('streamState'),
  outLoaded: $('outLoaded'),
  outQueue: $('outQueue'),
  outBuildings: $('outBuildings'),
  outBytes: $('outBytes'),
  outMode: $('outMode'),
  minimap: $('minimap'),
  rngDist: $('rngDist'),
  valDist: $('valDist'),
  rngSpeed: $('rngSpeed'),
  valSpeed: $('valSpeed'),
  chkLabels: $('chkLabels'),
  chkGrid: $('chkGrid'),
  chkShadow: $('chkShadow'),
  chkFog: $('chkFog'),
  landmarkList: $('landmarkList'),
  inpSearch: $('inpSearch'),
  btnGo: $('btnGo'),
  btnTop: $('btnTop'),
  btnCopyLink: $('btnCopyLink'),
  btnCopyDebug: $('btnCopyDebug'),
  debugLog: $('debugLog'),
  debugHead: $('debugHead'),
  cardDebug: $('cardDebug'),
  gate: $('gate'),
  gateBar: $('gateBar'),
  gateState: $('gateState'),
  btnEnter: $('btnEnter'),
  tooltip: $('tooltip'),
  crosshair: $('crosshair'),
  btnHelp: $('btnHelp'),
  modalHelp: $('modalHelp'),
  btnCloseHelp: $('btnCloseHelp'),
};

/* ================================================================
 * 场景
 * ================================================================ */
const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setClearColor(PALETTE.sky, 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
const fog = new THREE.Fog(PALETTE.fog, 300, 2600);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(CONFIG.fov, 1, CONFIG.near, CONFIG.far);
camera.position.set(300, 500, 700);

// 光照
const hemi = new THREE.HemisphereLight(0x93b7ff, 0x141a24, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe3bb, 1.35);
sun.position.set(-900, 1400, 700);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 200;
sun.shadow.camera.far = 4200;
const S = 1300;
sun.shadow.camera.left = -S;
sun.shadow.camera.right = S;
sun.shadow.camera.top = S;
sun.shadow.camera.bottom = -S;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(sun.target);

// 无限地面
const groundMat = new THREE.MeshLambertMaterial({ color: PALETTE.ground });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.2;
ground.receiveShadow = true;
scene.add(ground);

/* ================================================================
 * 引导：加载 manifest
 * ================================================================ */
let geo, tiles, controls, minimap, labels, gridHelper;
let viewDist = CONFIG.viewDistance;
let entered = false;

function setGate(pct, text) {
  el.gateBar.style.width = `${clamp(pct, 0, 100)}%`;
  if (text) el.gateState.textContent = text;
}

async function boot() {
  setGate(8, '正在拉取瓦片清单…');
  let manifest;
  try {
    const res = await fetch(`${CONFIG.dataRoot}/manifest.json`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    setGate(0, `清单加载失败：${err.message}`);
    el.cityState.textContent = '错误';
    return;
  }

  geo = new Geo(manifest);
  tiles = new TileManager(scene, manifest);
  controls = new Controls(camera, el.canvas, tiles);
  minimap = new Minimap(el.minimap, tiles);
  labels = new LabelLayer(camera, tiles);

  gridHelper = new THREE.GridHelper(
    manifest.tileSize * (manifest.bounds.maxTx - manifest.bounds.minTx + 1),
    manifest.bounds.maxTx - manifest.bounds.minTx + 1,
    PALETTE.grid,
    PALETTE.grid,
  );
  gridHelper.position.set(
    ((manifest.bounds.minTx + manifest.bounds.maxTx + 1) / 2) * manifest.tileSize,
    0.6,
    ((manifest.bounds.minTz + manifest.bounds.maxTz + 1) / 2) * manifest.tileSize,
  );
  gridHelper.visible = false;
  scene.add(gridHelper);

  el.tileCount.textContent = `0/${manifest.tiles.length}`;
  el.cityState.textContent = '装配中';
  el.statusDot.className = 'dot load';

  buildLandmarkList(manifest.landmarks);
  wireUI();
  applyHash();

  minimap.onPick = (x, z) => controls.teleport(x, z, { radius: 620 });
  controls.onClick = pickFromScreen;
  controls.onModeChange = (m) => {
    el.outMode.textContent = m.toUpperCase();
    el.crosshair.hidden = m === Mode.ORBIT;
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === m);
    });
  };
  controls.onModeChange(controls.mode);

  // 首屏：等中心区域的瓦片装配完成再开门
  const f = controls.focus();
  tiles.update(f.x, f.z, 700);
  await waitForNeighborhood();

  setGate(100, '街区已就绪');
  el.btnEnter.disabled = false;
  el.btnEnter.textContent = '进入城市';
  el.cityState.textContent = '在线';
  el.statusDot.className = 'dot ok';
  requestAnimationFrame(loop);
}

async function waitForNeighborhood() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = () => {
      tiles.drain(4);
      const s = tiles.stats();
      const pct = 20 + Math.min(75, (s.ready / Math.max(1, Math.min(28, s.total))) * 75);
      setGate(pct, `正在装配街区… ${s.ready} 块 / ${(s.bytes / 1024).toFixed(0)} KB`);
      const f = controls.focus();
      tiles.update(f.x, f.z, 700);
      const done = !s.busy && s.ready > 0;
      if (done || performance.now() - t0 > 12000) {
        resolve();
      } else {
        requestAnimationFrame(step);
      }
    };
    step();
  });
}

/* ================================================================
 * UI
 * ================================================================ */
function buildLandmarkList(landmarks) {
  el.landmarkList.innerHTML = '';
  for (const lm of landmarks) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${lm.name}</span><i>${lm.lat.toFixed(4)}, ${lm.lon.toFixed(4)}</i>`;
    li.addEventListener('click', () => {
      controls.teleport(lm.pos[0], lm.pos[1], { radius: 560 });
      flash(li);
    });
    el.landmarkList.appendChild(li);
  }
  window._landmarks = landmarks;
}

function flash(node) {
  node.style.background = 'rgba(124,243,208,.22)';
  setTimeout(() => (node.style.background = ''), 260);
}

function wireUI() {
  el.rngDist.addEventListener('input', () => {
    viewDist = +el.rngDist.value;
    el.valDist.textContent = viewDist;
  });
  el.rngSpeed.addEventListener('input', () => {
    controls.speedScale = +el.rngSpeed.value;
    el.valSpeed.textContent = (+el.rngSpeed.value).toFixed(1);
  });
  el.chkLabels.addEventListener('change', () => labels.setEnabled(el.chkLabels.checked));
  el.chkGrid.addEventListener('change', () => (gridHelper.visible = el.chkGrid.checked));
  el.chkShadow.addEventListener('change', () => {
    renderer.shadowMap.enabled = el.chkShadow.checked;
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  });
  el.chkFog.addEventListener('change', () => {
    scene.fog = el.chkFog.checked ? fog : null;
    scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });
  });

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => controls.setMode(b.dataset.mode));
  });
  el.btnTop.addEventListener('click', () => controls.topDown());

  el.btnGo.addEventListener('click', doSearch);
  el.inpSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  el.btnCopyLink.addEventListener('click', () => {
    const f = controls.focus();
    const { lat, lon } = geo.toLatLon(f.x, f.z);
    const h = headingOf(controls.headingVector().x, controls.headingVector().z);
    const url = `${location.origin}${location.pathname}#${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(h.deg)},${controls.mode}`;
    copy(url, el.btnCopyLink, '已复制');
    history.replaceState(null, '', url);
  });

  el.btnCopyDebug.addEventListener('click', () =>
    copy(el.debugLog.textContent, el.btnCopyDebug, '已复制'));

  el.debugHead.addEventListener('click', () => {
    el.cardDebug.classList.toggle('closed');
    el.debugHead.querySelector('.tag').textContent =
      el.cardDebug.classList.contains('closed') ? '+' : '−';
  });

  el.btnEnter.addEventListener('click', () => {
    entered = true;
    el.gate.classList.add('gone');
    setTimeout(() => (el.gate.style.display = 'none'), 650);
  });

  el.btnHelp.addEventListener('click', () => (el.modalHelp.hidden = false));
  el.btnCloseHelp.addEventListener('click', () => (el.modalHelp.hidden = true));
  el.modalHelp.addEventListener('click', (e) => {
    if (e.target === el.modalHelp) el.modalHelp.hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.code) {
      case 'KeyV': controls.setMode(Mode.WALK); break;
      case 'KeyF': controls.setMode(Mode.FLY); break;
      case 'KeyC':
        controls.setMode(controls.mode === Mode.ORBIT ? Mode.WALK : Mode.ORBIT);
        break;
      case 'KeyT': controls.topDown(); break;
      case 'KeyR': controls.reset(); break;
      case 'KeyL':
        el.chkLabels.checked = !el.chkLabels.checked;
        labels.setEnabled(el.chkLabels.checked);
        break;
      case 'KeyG':
        el.chkGrid.checked = !el.chkGrid.checked;
        gridHelper.visible = el.chkGrid.checked;
        break;
      case 'Escape': el.modalHelp.hidden = true; break;
      default: break;
    }
  });

  window.addEventListener('resize', resize);
  resize();
}

function copy(text, btn, okText) {
  const old = btn.textContent;
  const done = () => {
    btn.textContent = okText;
    setTimeout(() => (btn.textContent = old), 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => (btn.textContent = '复制失败'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { btn.textContent = '复制失败'; }
    ta.remove();
  }
}

function doSearch() {
  const q = el.inpSearch.value.trim();
  if (!q) return;
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const [x, z] = geo.toLocal(+m[1], +m[2]);
    controls.teleport(x, z, { radius: 600 });
    el.inpSearch.value = '';
    return;
  }
  const hit = (window._landmarks || []).find((l) => l.name.includes(q));
  if (hit) {
    controls.teleport(hit.pos[0], hit.pos[1], { radius: 560 });
    el.inpSearch.value = '';
    return;
  }
  // 在已载入瓦片的建筑名里找
  for (const t of tiles.tiles.values()) {
    if (!t.meta) continue;
    for (const b of t.meta) {
      if (b.name && b.name.includes(q)) {
        const cx = t.tx * tiles.tileSize + (b.bbox[0] + b.bbox[2]) / 2;
        const cz = t.tz * tiles.tileSize + (b.bbox[1] + b.bbox[3]) / 2;
        controls.teleport(cx, cz, { radius: 420 });
        el.inpSearch.value = '';
        return;
      }
    }
  }
  el.inpSearch.value = '';
  el.inpSearch.placeholder = `未找到「${q}」`;
  setTimeout(() => (el.inpSearch.placeholder = '搜索地标 / 输入 22.5372,114.0503'), 1800);
}

function applyHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const parts = h.split(',');
  const lat = +parts[0], lon = +parts[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const [x, z] = geo.toLocal(lat, lon);
  controls.target.set(x, 0, z);
  controls.pos.set(x, CONFIG.eyeHeight, z);
  if (parts[3] && Object.values(Mode).includes(parts[3])) controls.setMode(parts[3]);
  const deg = +parts[2];
  if (Number.isFinite(deg)) {
    controls.theta = Math.PI - (deg * Math.PI) / 180;
    controls.yaw = Math.PI - (deg * Math.PI) / 180;
  }
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* ================================================================
 * 拾取
 * ================================================================ */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickFromScreen(clientX, clientY) {
  ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  const hit = hits.find((h) => h.object !== ground && h.object.visible) || hits[0];
  if (!hit) return hideTooltip();

  const p = hit.point;
  const info = tiles.pickAt(p.x, p.z);
  const { lat, lon } = geo.toLatLon(p.x, p.z);
  const kindZh = {
    residential: '住宅', commercial: '商业 / 办公', civic: '公共设施',
    transit: '交通枢纽', industrial: '工业 / 仓储', generic: '未分类',
  };
  let html = `<b>${info?.name || '未命名建筑'}</b>`;
  if (info) {
    html += `高度 ${info.height.toFixed(0)} m · ${info.levels} 层<br>`;
    html += `类型 ${kindZh[info.kind] || info.kind}<br>`;
  } else {
    html = '<b>地面</b>';
  }
  html += `<span style="color:#7f8ea6">${lat.toFixed(5)}, ${lon.toFixed(5)}</span>`;
  showTooltip(html, clientX, clientY);
}

let tipTimer = 0;
function showTooltip(html, x, y) {
  el.tooltip.innerHTML = html;
  el.tooltip.hidden = false;
  const pad = 14;
  const r = el.tooltip.getBoundingClientRect();
  el.tooltip.style.left = `${clamp(x + pad, 8, innerWidth - r.width - 8)}px`;
  el.tooltip.style.top = `${clamp(y + pad, 52, innerHeight - r.height - 70)}px`;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTooltip, 4200);
}
function hideTooltip() {
  el.tooltip.hidden = true;
}

/* ================================================================
 * 主循环
 * ================================================================ */
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, hudAcc = 0;

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  controls.update(dt);

  const f = controls.focus();
  tiles.update(f.x, f.z, viewDist);
  tiles.drain(entered ? CONFIG.buildBudgetPerFrame : 3);

  // 光源跟随，保证阴影贴图覆盖当前区域
  sun.position.set(f.x - 900, 1400, f.z + 700);
  sun.target.position.set(f.x, 0, f.z);

  // 雾按「视距」与「相机到焦点的距离」同时缩放，避免俯视时整城被雾吃掉
  const camDist = camera.position.distanceTo(new THREE.Vector3(f.x, 0, f.z));
  const fogRef = Math.max(viewDist, camDist * 1.2);
  fog.near = fogRef * 0.45;
  fog.far = fogRef * 2.4;
  labels.update(innerWidth, innerHeight, Math.min(viewDist, 1400));
  renderer.render(scene, camera);

  fpsAcc += dt; fpsFrames++;
  hudAcc += dt;
  if (hudAcc > 0.25) {
    updateHUD(fpsFrames / fpsAcc);
    fpsAcc = 0; fpsFrames = 0; hudAcc = 0;
  }
  requestAnimationFrame(loop);
}

function updateHUD(fps) {
  const s = tiles.stats();
  const f = controls.focus();
  const { lat, lon } = geo.toLatLon(f.x, f.z);
  const hv = controls.headingVector();
  const hd = headingOf(hv.x, hv.z);
  const [tx, tz] = geo.tileOf(f.x, f.z);

  el.fps.textContent = fps.toFixed(0);
  el.tileCount.textContent = `${s.ready}/${s.total}`;
  el.outLatLon.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  el.outXZ.textContent = `${f.x.toFixed(0)} / ${f.z.toFixed(0)} m`;
  el.outY.textContent = `${camera.position.y.toFixed(0)} m`;
  el.outHeading.textContent = `${hd.name} · ${String(Math.round(hd.deg)).padStart(3, '0')}°`;
  el.outTile.textContent = `${tx}_${tz}`;
  el.outLoaded.textContent = `${s.ready} / ${s.total}`;
  el.outQueue.textContent = String(s.queue);
  el.outBuildings.textContent = s.buildings.toLocaleString();
  el.outBytes.textContent = s.bytes > 1e6
    ? `${(s.bytes / 1e6).toFixed(2)} MB`
    : `${(s.bytes / 1024).toFixed(0)} KB`;

  el.streamState.textContent = s.busy ? 'STREAMING' : 'IDLE';
  el.streamState.style.color = s.busy ? 'var(--warn)' : 'var(--accent-2)';
  el.statusDot.className = `dot ${s.busy ? 'load' : 'ok'}`;
  el.cityState.textContent = s.busy ? '流式加载' : '在线';

  minimap.draw({ x: f.x, z: f.z }, hv, viewDist);

  if (!el.cardDebug.classList.contains('closed')) {
    el.debugLog.textContent = [
      `mode      ${controls.mode}`,
      `focus     x=${f.x.toFixed(1)} z=${f.z.toFixed(1)} y=${camera.position.y.toFixed(1)}`,
      `latlon    ${lat.toFixed(6)}, ${lon.toFixed(6)}`,
      `tile      ${tx}_${tz}  size=${tiles.tileSize}m`,
      `viewDist  ${viewDist}m  unload=${viewDist + CONFIG.unloadMargin}m`,
      `tiles     ready=${s.ready} queue=${s.queue} inflight=${s.inFlight} total=${s.total}`,
      `buildings ${s.buildings}`,
      `bytes     ${s.bytes}`,
      `errors    ${s.errors}${s.lastError ? ` (${s.lastError})` : ''}`,
      `fps       ${fps.toFixed(1)}`,
      `draws     ${renderer.info.render.calls} tris=${renderer.info.render.triangles}`,
      `geoms     ${renderer.info.memory.geometries}`,
    ].join('\n');
  }
}

boot().catch((err) => {
  console.error(err);
  setGate(0, `初始化失败：${err.message}`);
});
