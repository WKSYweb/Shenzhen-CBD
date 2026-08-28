/**
 * 全局配置与地理坐标换算。
 * 本地坐标系：+X 向东，+Z 向南，+Y 向上（米制）。
 */

export const CONFIG = {
  dataRoot: './data',
  /** 瓦片加载并发数 */
  concurrency: 8,
  /** 默认视距（米），可在 UI 调整 */
  viewDistance: 1200,
  /** 超出视距多少米才卸载，避免边界抖动 */
  unloadMargin: 350,
  /** 每帧最多把多少个已下载瓦片装配进场景（避免掉帧） */
  buildBudgetPerFrame: 2,
  /** 相机 */
  fov: 62,
  near: 1,
  far: 9000,
  /** 行走参数 */
  eyeHeight: 1.7,
  walkSpeed: 26,
  flySpeed: 90,
  gravity: 24,
  jumpVelocity: 8.5,
};

export const PALETTE = {
  sky: 0x0a1020,
  fog: 0x0b1524,
  ground: 0x0d131c,
  grid: 0x1d2c42,
  water: 0x123a5c,
  green: 0x14351f,
  roadMajor: 0x2b3646,
  roadMid: 0x252f3d,
  roadMinor: 0x1f2833,
  roadPath: 0x1a212b,
  building: {
    residential: 0x33445c,
    commercial: 0x3d5876,
    civic: 0x4a4763,
    transit: 0x2f5a5e,
    industrial: 0x3a3f4a,
    generic: 0x323d4e,
  },
  emissiveTall: 0x1b3550,
};

/** 由 manifest 初始化的地理换算器 */
export class Geo {
  constructor(manifest) {
    this.lat0 = manifest.origin.lat;
    this.lon0 = manifest.origin.lon;
    this.mpdLon = manifest.metresPerDegree.lon;
    this.mpdLat = manifest.metresPerDegree.lat;
    this.tileSize = manifest.tileSize;
  }

  /** 经纬度 -> 本地 [x, z] */
  toLocal(lat, lon) {
    return [(lon - this.lon0) * this.mpdLon, -(lat - this.lat0) * this.mpdLat];
  }

  /** 本地 -> { lat, lon } */
  toLatLon(x, z) {
    return {
      lat: this.lat0 - z / this.mpdLat,
      lon: this.lon0 + x / this.mpdLon,
    };
  }

  tileOf(x, z) {
    return [Math.floor(x / this.tileSize), Math.floor(z / this.tileSize)];
  }
}

export const tileId = (tx, tz) => `${tx}_${tz}`;

/** 朝向角（弧度，three.js 中 -Z 为北）-> 罗盘方位 */
export function headingOf(dirX, dirZ) {
  let deg = (Math.atan2(dirX, -dirZ) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const name = names[Math.round(deg / 45) % 8];
  return { deg, name };
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
