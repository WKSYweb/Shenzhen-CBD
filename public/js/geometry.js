/**
 * 瓦片几何构建：把瓦片 JSON 转成合并后的 BufferGeometry。
 * 每个瓦片最多产出 3 个 Mesh（建筑 / 道路 / 地面覆盖），draw call 极少。
 */
import * as THREE from 'three';
import { PALETTE } from './config.js';

const tmpColor = new THREE.Color();

/* ------------------------------------------------------------------ *
 * 建筑：三角化屋顶 + 挤出侧墙，顶点色着色
 * ------------------------------------------------------------------ */
function buildingColor(kind, height) {
  const base = PALETTE.building[kind] ?? PALETTE.building.generic;
  tmpColor.setHex(base);
  // 越高越亮一点，模拟玻璃幕墙受光
  const t = Math.min(height / 320, 1);
  tmpColor.offsetHSL(0, -0.05 * t, 0.06 + 0.22 * t);
  return tmpColor.clone();
}

/**
 * @param {Array} buildings tile.buildings
 * @returns {{geometry:THREE.BufferGeometry, meta:Array}}
 */
export function buildBuildingGeometry(buildings) {
  const pos = [];
  const nor = [];
  const col = [];
  const meta = [];

  for (const b of buildings) {
    const ring = b.r;
    if (!ring || ring.length < 3) continue;
    const h = b.h;
    const color = buildingColor(b.k, h);
    const cr = color.r, cg = color.g, cb = color.b;

    // ---- 屋顶（三角化）----
    const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    // 顶面亮一档
    const rr = Math.min(1, cr * 1.25), rg = Math.min(1, cg * 1.25), rb = Math.min(1, cb * 1.25);
    for (const f of faces) {
      // 注意：本地坐标 z 向南，三角化在 (x,z) 平面上做，需反转绕序使法线朝上
      for (const idx of [f[0], f[2], f[1]]) {
        const p = contour[idx];
        pos.push(p.x, h, p.y);
        nor.push(0, 1, 0);
        col.push(rr, rg, rb);
      }
    }

    // ---- 侧墙 ----
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const [x1, z1] = ring[i];
      const [x2, z2] = ring[(i + 1) % n];
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // 外法线（CCW 环，(dz,-dx) 归一化）
      const nx = dz / len, nz = -dx / len;
      // 朝向决定明暗，模拟方向光
      const shade = 0.72 + 0.28 * Math.max(0, nx * 0.55 - nz * 0.83);
      const sr = cr * shade, sg = cg * shade, sb = cb * shade;
      // 两个三角形：(x1,0)(x2,0)(x2,h) / (x1,0)(x2,h)(x1,h)
      const quad = [
        [x1, 0, z1], [x2, 0, z2], [x2, h, z2],
        [x1, 0, z1], [x2, h, z2], [x1, h, z1],
      ];
      for (const [px, py, pz] of quad) {
        pos.push(px, py, pz);
        nor.push(nx, 0, nz);
        col.push(sr, sg, sb);
      }
    }

    // ---- 拾取元数据 ----
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    meta.push({
      name: b.n || null,
      height: h,
      levels: b.lv || Math.max(1, Math.round(h / 3.2)),
      kind: b.k,
      ring,
      bbox: [minX, minZ, maxX, maxZ],
    });
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return { geometry: g, meta };
}

/* ------------------------------------------------------------------ *
 * 道路：折线 -> 带宽度的 ribbon，贴在 y≈0.1
 * ------------------------------------------------------------------ */
const ROAD_COLOR = {
  major: PALETTE.roadMajor,
  mid: PALETTE.roadMid,
  minor: PALETTE.roadMinor,
  path: PALETTE.roadPath,
};
const ROAD_Y = { major: 0.5, mid: 0.4, minor: 0.3, path: 0.2 };

export function buildRoadGeometry(roads) {
  const pos = [];
  const col = [];
  if (!roads || !roads.length) return emptyFlat(pos, col);

  for (const r of roads) {
    const pts = r.p;
    if (!pts || pts.length < 2) continue;
    const hw = (r.w || 6) / 2;
    const y = ROAD_Y[r.c] ?? 0.3;
    tmpColor.setHex(ROAD_COLOR[r.c] ?? PALETTE.roadMinor);
    const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;

    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i];
      const [x2, z2] = pts[i + 1];
      const dx = x2 - x1, dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      const nx = (-dz / len) * hw, nz = (dx / len) * hw;
      const a = [x1 + nx, y, z1 + nz];
      const b = [x2 + nx, y, z2 + nz];
      const c = [x2 - nx, y, z2 - nz];
      const d = [x1 - nx, y, z1 - nz];
      for (const p of [a, b, c, a, c, d]) {
        pos.push(p[0], p[1], p[2]);
        col.push(cr, cg, cb);
      }
      // 关节补一个正方形，避免转角缺口
      if (i > 0) {
        const s = hw;
        const j = [
          [x1 - s, y, z1 - s], [x1 + s, y, z1 - s], [x1 + s, y, z1 + s],
          [x1 - s, y, z1 - s], [x1 + s, y, z1 + s], [x1 - s, y, z1 + s],
        ];
        for (const p of j) {
          pos.push(p[0], p[1], p[2]);
          col.push(cr, cg, cb);
        }
      }
    }
  }
  return emptyFlat(pos, col);
}

/* ------------------------------------------------------------------ *
 * 地面覆盖（水体 / 绿地）
 * ------------------------------------------------------------------ */
export function buildCoverGeometry(water, green) {
  const pos = [];
  const col = [];
  const push = (areas, hex, y) => {
    tmpColor.setHex(hex);
    const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;
    for (const a of areas || []) {
      const ring = a.r;
      if (!ring || ring.length < 3) continue;
      const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
      let faces;
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        continue;
      }
      for (const f of faces) {
        for (const idx of [f[0], f[2], f[1]]) {
          const p = contour[idx];
          pos.push(p.x, y, p.y);
          col.push(cr, cg, cb);
        }
      }
    }
  };
  push(green, PALETTE.green, 0.08);
  push(water, PALETTE.water, 0.12);
  return emptyFlat(pos, col);
}

function emptyFlat(pos, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 点是否在多边形内（射线法），用于建筑拾取 */
export function pointInRing(px, pz, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
