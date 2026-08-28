/**
 * 瓦片流式加载管理器。
 *
 * 状态机：idle -> queued -> fetching -> pending(已下载待装配) -> ready
 * 以相机位置为中心按视距筛选，超出 视距+margin 卸载并释放 GPU 资源。
 */
import * as THREE from 'three';
import { CONFIG, tileId } from './config.js';
import {
  buildBuildingGeometry,
  buildRoadGeometry,
  buildCoverGeometry,
  pointInRing,
} from './geometry.js';

export const TileState = {
  IDLE: 'idle',
  QUEUED: 'queued',
  FETCHING: 'fetching',
  PENDING: 'pending',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
};

export class TileManager {
  /**
   * @param {THREE.Scene} scene
   * @param {object} manifest
   */
  constructor(scene, manifest) {
    this.scene = scene;
    this.manifest = manifest;
    this.tileSize = manifest.tileSize;

    /** @type {Map<string, object>} */
    this.tiles = new Map();
    for (const t of manifest.tiles) {
      this.tiles.set(tileId(t.tx, t.tz), {
        tx: t.tx,
        tz: t.tz,
        info: t,
        state: TileState.IDLE,
        group: null,
        meta: null,
        raw: null,
        labels: null,
      });
    }

    this.queue = [];
    this.inFlight = 0;
    this.pending = [];
    this.loadedBytes = 0;
    this.buildingCount = 0;
    this.readyCount = 0;
    this.errorCount = 0;
    this.lastError = '';

    this.materials = {
      building: new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      }),
      flat: new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      }),
    };

    /** 装配完成后的回调（用于刷新标签层） */
    this.onTileReady = null;
  }

  get total() {
    return this.tiles.size;
  }

  tile(tx, tz) {
    return this.tiles.get(tileId(tx, tz));
  }

  /* ---------------- 调度 ---------------- */

  /**
   * 根据相机位置刷新加载/卸载计划。
   * @param {number} cx 相机 x
   * @param {number} cz 相机 z
   * @param {number} dist 视距（米）
   */
  update(cx, cz, dist) {
    const size = this.tileSize;
    const keep = dist + CONFIG.unloadMargin;
    const wanted = [];

    for (const t of this.tiles.values()) {
      // 瓦片中心到相机的距离
      const mx = t.tx * size + size / 2;
      const mz = t.tz * size + size / 2;
      const d = Math.hypot(mx - cx, mz - cz);
      t._dist = d;

      if (d <= dist) {
        if (t.state === TileState.IDLE || t.state === TileState.ERROR) {
          wanted.push(t);
        }
      } else if (d > keep && t.state === TileState.READY) {
        this.unload(t);
      }
    }

    if (wanted.length) {
      wanted.sort((a, b) => a._dist - b._dist);
      for (const t of wanted) {
        t.state = TileState.QUEUED;
        this.queue.push(t);
      }
    }
    // 队列按距离重排，保证「先近后远」
    if (this.queue.length > 1) this.queue.sort((a, b) => a._dist - b._dist);

    this.pump();
  }

  pump() {
    while (this.inFlight < CONFIG.concurrency && this.queue.length) {
      const t = this.queue.shift();
      if (t.state !== TileState.QUEUED) continue;
      this.fetchTile(t);
    }
  }

  async fetchTile(t) {
    t.state = TileState.FETCHING;
    this.inFlight++;
    const url = `${CONFIG.dataRoot}/tiles/${t.tx}_${t.tz}.json`;
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      this.loadedBytes += text.length;
      t.raw = JSON.parse(text);
      t.state = TileState.PENDING;
      this.pending.push(t);
    } catch (err) {
      t.state = TileState.ERROR;
      this.errorCount++;
      this.lastError = `${t.tx}_${t.tz}: ${err.message}`;
    } finally {
      this.inFlight--;
    }
  }

  /** 每帧调用：按预算把已下载瓦片装配进场景 */
  drain(budget = CONFIG.buildBudgetPerFrame) {
    let built = 0;
    while (built < budget && this.pending.length) {
      const t = this.pending.shift();
      if (t.state !== TileState.PENDING) continue;
      this.assemble(t);
      built++;
    }
    if (built) this.pump();
    return built;
  }

  assemble(t) {
    const data = t.raw;
    t.raw = null;
    const group = new THREE.Group();
    group.name = `tile_${t.tx}_${t.tz}`;
    group.position.set(t.tx * this.tileSize, 0, t.tz * this.tileSize);

    // 地面覆盖
    if ((data.water && data.water.length) || (data.green && data.green.length)) {
      const g = buildCoverGeometry(data.water, data.green);
      if (g.attributes.position.count) {
        const m = new THREE.Mesh(g, this.materials.flat);
        m.renderOrder = 1;
        group.add(m);
      }
    }
    // 道路
    if (data.roads && data.roads.length) {
      const g = buildRoadGeometry(data.roads);
      if (g.attributes.position.count) {
        const m = new THREE.Mesh(g, this.materials.flat);
        m.renderOrder = 2;
        group.add(m);
      }
    }
    // 建筑
    let meta = [];
    if (data.buildings && data.buildings.length) {
      const out = buildBuildingGeometry(data.buildings);
      meta = out.meta;
      if (out.geometry.attributes.position.count) {
        const m = new THREE.Mesh(out.geometry, this.materials.building);
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.tile = tileId(t.tx, t.tz);
        group.add(m);
      }
      this.buildingCount += meta.length;
    }

    t.group = group;
    t.meta = meta;
    t.labels = data.labels || [];
    t.state = TileState.READY;
    this.readyCount++;
    this.scene.add(group);
    if (this.onTileReady) this.onTileReady(t);
  }

  unload(t) {
    if (t.group) {
      this.scene.remove(t.group);
      t.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      t.group = null;
    }
    this.buildingCount -= t.meta ? t.meta.length : 0;
    t.meta = null;
    t.labels = null;
    t.state = TileState.IDLE;
    this.readyCount--;
  }

  /** 已就绪瓦片中所有标签，返回世界坐标 */
  *iterLabels() {
    for (const t of this.tiles.values()) {
      if (t.state !== TileState.READY || !t.labels) continue;
      const ox = t.tx * this.tileSize;
      const oz = t.tz * this.tileSize;
      for (const l of t.labels) {
        yield { name: l.n, kind: l.t, x: ox + l.p[0], z: oz + l.p[1], h: l.h };
      }
    }
  }

  /**
   * 在给定世界坐标处查找建筑（用于点击拾取）。
   * @returns {object|null}
   */
  pickAt(wx, wz) {
    const [tx, tz] = [
      Math.floor(wx / this.tileSize),
      Math.floor(wz / this.tileSize),
    ];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const t = this.tile(tx + dx, tz + dz);
        if (!t || t.state !== TileState.READY || !t.meta) continue;
        const lx = wx - (t.tx * this.tileSize);
        const lz = wz - (t.tz * this.tileSize);
        for (const b of t.meta) {
          const [minX, minZ, maxX, maxZ] = b.bbox;
          if (lx < minX || lx > maxX || lz < minZ || lz > maxZ) continue;
          if (!pointInRing(lx, lz, b.ring)) continue;
          return { ...b, tile: `${t.tx}_${t.tz}` };
        }
      }
    }
    return null;
  }

  /** 某点的地面/屋顶高度，行走碰撞用 */
  heightAt(wx, wz) {
    const hit = this.pickAt(wx, wz);
    return hit ? hit.height : 0;
  }

  stats() {
    return {
      total: this.total,
      ready: this.readyCount,
      queue: this.queue.length + this.pending.length,
      inFlight: this.inFlight,
      bytes: this.loadedBytes,
      buildings: this.buildingCount,
      errors: this.errorCount,
      lastError: this.lastError,
      busy: this.inFlight > 0 || this.queue.length > 0 || this.pending.length > 0,
    };
  }
}
