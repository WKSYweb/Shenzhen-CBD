/**
 * 地标标签层：把已就绪瓦片里的 label 投影到屏幕，用 DOM 元素显示。
 * DOM 复用池，避免每帧创建节点。
 */
import * as THREE from 'three';

const MAX_LABELS = 46;

export class LabelLayer {
  constructor(camera, tiles) {
    this.camera = camera;
    this.tiles = tiles;
    this.enabled = true;
    this.root = document.createElement('div');
    this.root.className = 'label-layer';
    document.body.appendChild(this.root);
    /** @type {HTMLElement[]} */
    this.pool = [];
    this._v = new THREE.Vector3();
  }

  _el(i) {
    while (this.pool.length <= i) {
      const d = document.createElement('div');
      d.className = 'map-label';
      d.style.display = 'none';
      this.root.appendChild(d);
      this.pool.push(d);
    }
    return this.pool[i];
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.style.display = on ? '' : 'none';
  }

  update(w, h, maxDist) {
    if (!this.enabled) return;
    const cam = this.camera;
    const camPos = cam.position;
    const items = [];

    for (const l of this.tiles.iterLabels()) {
      const dx = l.x - camPos.x;
      const dz = l.z - camPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxDist * maxDist) continue;
      items.push({ l, d2 });
    }
    // 近的优先，且高楼优先
    items.sort((a, b) => a.d2 / (1 + a.l.h) - b.d2 / (1 + b.l.h));

    let used = 0;
    const taken = [];
    for (const { l, d2 } of items) {
      if (used >= MAX_LABELS) break;
      this._v.set(l.x, l.h + 12, l.z).project(cam);
      if (this._v.z > 1 || this._v.z < -1) continue;
      const sx = (this._v.x * 0.5 + 0.5) * w;
      const sy = (-this._v.y * 0.5 + 0.5) * h;
      if (sx < 40 || sx > w - 40 || sy < 52 || sy > h - 70) continue;
      // 简单去重叠
      let overlap = false;
      for (const [ox, oy] of taken) {
        if (Math.abs(ox - sx) < 76 && Math.abs(oy - sy) < 18) { overlap = true; break; }
      }
      if (overlap) continue;
      taken.push([sx, sy]);

      const el = this._el(used++);
      if (el._name !== l.name || el._kind !== l.kind) {
        el.textContent = l.name;
        el.className = `map-label ${l.kind === 'building' ? '' : l.kind}`;
        el._name = l.name;
        el._kind = l.kind;
      }
      el.style.display = '';
      el.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
      el.style.opacity = String(Math.max(0.25, 1 - Math.sqrt(d2) / maxDist));
    }
    for (let i = used; i < this.pool.length; i++) {
      if (this.pool[i].style.display !== 'none') this.pool[i].style.display = 'none';
    }
  }
}
