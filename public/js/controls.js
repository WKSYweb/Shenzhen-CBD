/**
 * 相机控制：orbit（环绕）/ walk（行走）/ fly（飞行）三种模式。
 * 不依赖 three/examples，全部自实现，避免额外 vendor 文件。
 */
import * as THREE from 'three';
import { CONFIG, clamp } from './config.js';

export const Mode = { ORBIT: 'orbit', WALK: 'walk', FLY: 'fly' };

export class Controls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLCanvasElement} dom
   * @param {import('./tiles.js').TileManager} tiles
   */
  constructor(camera, dom, tiles) {
    this.camera = camera;
    this.dom = dom;
    this.tiles = tiles;
    this.mode = Mode.ORBIT;
    this.speedScale = 1;

    // orbit 状态
    this.target = new THREE.Vector3(-300, 0, 0);
    this.radius = 900;
    this.theta = Math.PI * 0.75; // 水平角
    this.phi = 0.95;             // 天顶角（0=正上方）

    // 第一人称状态
    this.pos = new THREE.Vector3(-300, CONFIG.eyeHeight, 300);
    this.yaw = Math.PI;
    this.pitch = 0;
    this.velY = 0;
    this.grounded = true;

    this.keys = new Set();
    this.locked = false;
    this.dragging = 0; // 0 none, 1 rotate, 2 pan
    this.lastPointer = { x: 0, y: 0 };
    this.moved = 0;

    /** 点击（非拖拽）回调：(clientX, clientY) => void */
    this.onClick = null;
    this.onModeChange = null;

    this._bind();
  }

  /* ------------------------------------------------------------ */
  _bind() {
    const d = this.dom;

    d.addEventListener('contextmenu', (e) => e.preventDefault());

    d.addEventListener('pointerdown', (e) => {
      if (this.mode === Mode.ORBIT) {
        d.setPointerCapture(e.pointerId);
        this.dragging = e.button === 0 ? 1 : 2;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.moved = 0;
      } else if (!this.locked) {
        d.requestPointerLock?.();
      }
    });

    d.addEventListener('pointermove', (e) => {
      if (this.mode === Mode.ORBIT) {
        if (!this.dragging) return;
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.moved += Math.abs(dx) + Math.abs(dy);
        if (this.dragging === 1) {
          this.theta -= dx * 0.005;
          this.phi = clamp(this.phi - dy * 0.004, 0.08, 1.52);
        } else {
          const s = this.radius * 0.0016;
          const sin = Math.sin(this.theta), cos = Math.cos(this.theta);
          this.target.x -= (dx * cos - dy * sin) * s;
          this.target.z -= (dx * sin + dy * cos) * s;
        }
      } else if (this.locked) {
        this.yaw -= e.movementX * 0.0022;
        this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.45, 1.45);
      }
    });

    const up = (e) => {
      if (this.mode === Mode.ORBIT && this.dragging) {
        const wasClick = this.moved < 5;
        this.dragging = 0;
        if (wasClick && this.onClick) this.onClick(e.clientX, e.clientY);
      }
    };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', () => (this.dragging = 0));

    d.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.mode === Mode.ORBIT) {
          this.radius = clamp(this.radius * (1 + Math.sign(e.deltaY) * 0.12), 60, 4200);
        } else {
          this.speedScale = clamp(this.speedScale * (1 - Math.sign(e.deltaY) * 0.12), 0.2, 8);
        }
      },
      { passive: false },
    );

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === d;
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // 移动端：双指缩放 / 单指旋转由 pointer 事件覆盖
    let pinch = null;
    d.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
      }
    }, { passive: true });
    d.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) {
        const dd = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        this.radius = clamp(this.radius * (pinch / dd), 60, 4200);
        pinch = dd;
      }
    }, { passive: true });
    d.addEventListener('touchend', () => (pinch = null), { passive: true });
  }

  /* ------------------------------------------------------------ */
  /** 在 (x,z) 附近螺旋搜索一个不在建筑内的落点（行走模式用） */
  _findOpenSpot(x, z, maxR = 140) {
    if (this.tiles.heightAt(x, z) <= 0.5) return [x, z];
    for (let r = 12; r <= maxR; r += 12) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        if (this.tiles.heightAt(nx, nz) <= 0.5) return [nx, nz];
      }
    }
    return [x, z];
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === Mode.ORBIT) {
      // 从第一人称回到环绕：以当前位置为目标
      this.target.set(this.pos.x, 0, this.pos.z);
      this.radius = Math.max(320, this.radius);
      document.exitPointerLock?.();
    } else if (this.mode === Mode.ORBIT) {
      // 进入第一人称：落到 target 附近
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.yaw = Math.atan2(-dir.x, -dir.z);
      this.pitch = 0;
      if (mode === Mode.FLY) {
        const h = this.tiles.heightAt(this.target.x, this.target.z);
        this.pos.set(this.target.x, Math.max(140, h + 80), this.target.z);
      } else {
        const [sx, sz] = this._findOpenSpot(this.target.x, this.target.z);
        this.pos.set(sx, this.tiles.heightAt(sx, sz) + CONFIG.eyeHeight, sz);
      }
      this.velY = 0;
    } else if (mode === Mode.FLY && this.pos.y < 60) {
      this.pos.y = Math.max(this.pos.y, 90);
    }
    this.mode = mode;
    if (this.onModeChange) this.onModeChange(mode);
  }

  /** 传送到本地坐标 */
  teleport(x, z, opts = {}) {
    if (this.mode === Mode.ORBIT) {
      this.target.set(x, 0, z);
      if (opts.radius) this.radius = opts.radius;
    } else if (this.mode === Mode.FLY) {
      const h = this.tiles.heightAt(x, z);
      this.pos.set(x, Math.max(this.pos.y, h + 60), z);
      this.velY = 0;
    } else {
      const [sx, sz] = this._findOpenSpot(x, z);
      this.pos.set(sx, this.tiles.heightAt(sx, sz) + CONFIG.eyeHeight, sz);
      this.velY = 0;
    }
  }

  /** 当前「焦点」世界坐标（HUD / 瓦片调度用） */
  focus() {
    return this.mode === Mode.ORBIT ? this.target : this.pos;
  }

  reset() {
    this.mode = Mode.ORBIT;
    this.target.set(-300, 0, 0);
    this.radius = 900;
    this.theta = Math.PI * 0.75;
    this.phi = 0.95;
    document.exitPointerLock?.();
    if (this.onModeChange) this.onModeChange(this.mode);
  }

  topDown() {
    this.mode = Mode.ORBIT;
    this.phi = 0.1;
    this.radius = 2200;
    if (this.onModeChange) this.onModeChange(this.mode);
  }

  /* ------------------------------------------------------------ */
  update(dt) {
    if (this.mode === Mode.ORBIT) this._updateOrbit(dt);
    else this._updateFirstPerson(dt);
  }

  _updateOrbit(dt) {
    const k = this.keys;
    const move = dt * this.radius * 0.6 * this.speedScale;
    const sin = Math.sin(this.theta), cos = Math.cos(this.theta);
    let fx = 0, fz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) { fx -= sin; fz -= cos; }
    if (k.has('KeyS') || k.has('ArrowDown')) { fx += sin; fz += cos; }
    if (k.has('KeyA')) { fx -= cos; fz += sin; }
    if (k.has('KeyD')) { fx += cos; fz -= sin; }
    if (fx || fz) {
      const l = Math.hypot(fx, fz);
      this.target.x += (fx / l) * move;
      this.target.z += (fz / l) * move;
    }
    if (k.has('KeyQ')) this.theta += dt * 0.9;
    if (k.has('KeyE')) this.theta -= dt * 0.9;

    const r = this.radius;
    const y = Math.cos(this.phi) * r;
    const h = Math.sin(this.phi) * r;
    this.camera.position.set(
      this.target.x + Math.sin(this.theta) * h,
      Math.max(8, this.target.y + y),
      this.target.z + Math.cos(this.theta) * h,
    );
    this.camera.lookAt(this.target);
  }

  _updateFirstPerson(dt) {
    const k = this.keys;
    const fly = this.mode === Mode.FLY;
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') ? 3.2 : 1;
    const base = (fly ? CONFIG.flySpeed : CONFIG.walkSpeed) * this.speedScale * sprint;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) { fx -= sin; fz -= cos; }
    if (k.has('KeyS') || k.has('ArrowDown')) { fx += sin; fz += cos; }
    if (k.has('KeyA') || k.has('ArrowLeft')) { fx -= cos; fz += sin; }
    if (k.has('KeyD') || k.has('ArrowRight')) { fx += cos; fz -= sin; }

    if (fx || fz) {
      const l = Math.hypot(fx, fz);
      const nx = this.pos.x + (fx / l) * base * dt;
      const nz = this.pos.z + (fz / l) * base * dt;
      if (fly) {
        this.pos.x = nx; this.pos.z = nz;
      } else {
        // 行走：撞到明显高于脚下的建筑就挡住
        const h = this.tiles.heightAt(nx, nz);
        if (h <= this.pos.y - CONFIG.eyeHeight + 1.2) {
          this.pos.x = nx; this.pos.z = nz;
        }
      }
    }

    if (fly) {
      let vy = 0;
      if (k.has('Space')) vy += 1;
      if (k.has('KeyZ') || k.has('ControlLeft')) vy -= 1;
      // 视线俯仰也带动升降（更接近 sf.thijs.gg 的滑翔手感）
      this.pos.y = Math.max(2, this.pos.y + vy * base * dt);
      this.camera.position.copy(this.pos);
    } else {
      const groundH = this.tiles.heightAt(this.pos.x, this.pos.z);
      const feet = groundH + CONFIG.eyeHeight;
      if (this.grounded && k.has('Space')) {
        this.velY = CONFIG.jumpVelocity;
        this.grounded = false;
      }
      this.velY -= CONFIG.gravity * dt;
      this.pos.y += this.velY * dt;
      if (this.pos.y <= feet) {
        this.pos.y = feet;
        this.velY = 0;
        this.grounded = true;
      }
      this.camera.position.copy(this.pos);
    }

    const dir = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(this.camera.position.clone().add(dir));
  }

  headingVector() {
    const d = this.camera.getWorldDirection(new THREE.Vector3());
    return { x: d.x, z: d.z };
  }
}
