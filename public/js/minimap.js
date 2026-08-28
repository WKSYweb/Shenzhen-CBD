/**
 * 小地图：画瓦片加载状态网格 + 相机位置/朝向 + 视距圈。
 */
import { TileState } from './tiles.js';

const COLOR = {
  [TileState.IDLE]: '#151d29',
  [TileState.QUEUED]: '#2a2f3d',
  [TileState.FETCHING]: '#ffb547',
  [TileState.PENDING]: '#ffd98a',
  [TileState.READY]: '#2f7fd6',
  [TileState.ERROR]: '#c94b4b',
};

export class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./tiles.js').TileManager} tiles
   */
  constructor(canvas, tiles) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tiles = tiles;
    const b = tiles.manifest.bounds;
    this.minTx = b.minTx;
    this.maxTx = b.maxTx;
    this.minTz = b.minTz;
    this.maxTz = b.maxTz;
    this.cols = b.maxTx - b.minTx + 1;
    this.rows = b.maxTz - b.minTz + 1;

    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = canvas.width = 240 * dpr;
    this.h = canvas.height = 240 * dpr;
    this.cell = Math.min(this.w / this.cols, this.h / this.rows);
    this.offX = (this.w - this.cell * this.cols) / 2;
    this.offY = (this.h - this.cell * this.rows) / 2;

    /** 点击小地图传送 */
    this.onPick = null;
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('click', (e) => {
      if (!this.onPick) return;
      const r = canvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.w;
      const py = ((e.clientY - r.top) / r.height) * this.h;
      const tx = Math.floor((px - this.offX) / this.cell) + this.minTx;
      const tz = Math.floor((py - this.offY) / this.cell) + this.minTz;
      const size = this.tiles.tileSize;
      this.onPick(tx * size + size / 2, tz * size + size / 2);
    });
  }

  _toPx(x, z) {
    const size = this.tiles.tileSize;
    return [
      this.offX + (x / size - this.minTx) * this.cell,
      this.offY + (z / size - this.minTz) * this.cell,
    ];
  }

  /**
   * @param {{x:number,z:number}} cam 相机焦点
   * @param {{x:number,z:number}} dir 朝向
   * @param {number} dist 视距
   */
  draw(cam, dir, dist) {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // 瓦片格
    for (const t of this.tiles.tiles.values()) {
      const gx = this.offX + (t.tx - this.minTx) * this.cell;
      const gy = this.offY + (t.tz - this.minTz) * this.cell;
      c.fillStyle = COLOR[t.state] || COLOR[TileState.IDLE];
      c.globalAlpha = t.state === TileState.READY
        ? 0.35 + Math.min(0.6, (t.info.maxh || 0) / 260)
        : 0.85;
      c.fillRect(gx + 0.5, gy + 0.5, this.cell - 1, this.cell - 1);
    }
    c.globalAlpha = 1;

    // 视距圈
    const [cx, cy] = this._toPx(cam.x, cam.z);
    const rPx = (dist / this.tiles.tileSize) * this.cell;
    c.strokeStyle = 'rgba(124,243,208,.55)';
    c.lineWidth = 1;
    c.beginPath();
    c.arc(cx, cy, rPx, 0, Math.PI * 2);
    c.stroke();

    // 相机朝向扇形
    const ang = Math.atan2(dir.z, dir.x);
    const fov = 0.62;
    c.fillStyle = 'rgba(78,168,255,.22)';
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, rPx * 0.9, ang - fov, ang + fov);
    c.closePath();
    c.fill();

    // 相机点
    c.fillStyle = '#7cf3d0';
    c.beginPath();
    c.arc(cx, cy, 3.2, 0, Math.PI * 2);
    c.fill();

    // 原点十字（CBD 中心）
    const [ox, oy] = this._toPx(0, 0);
    c.strokeStyle = 'rgba(255,255,255,.25)';
    c.beginPath();
    c.moveTo(ox - 4, oy); c.lineTo(ox + 4, oy);
    c.moveTo(ox, oy - 4); c.lineTo(ox, oy + 4);
    c.stroke();
  }
}
