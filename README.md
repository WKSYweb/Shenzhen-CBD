# SHENZHEN CBD 3D — 深圳福田中心区立体地图

纯静态的浏览器 3D 城市地图，参考 [sf.thijs.gg](https://sf.thijs.gg/) 的界面结构与
「瓦片流式加载」思路，覆盖深圳福田 CBD（平安金融中心 / 市民中心 / 会展中心一带）。

- **零后端**：所有数据在构建期切好成 JSON 瓦片，运行时只有 `fetch` 静态文件。
- **逐块加载**：250 m × 250 m 网格，以相机为中心按距离排队拉取，超出「视距 + 350 m」自动卸载并释放 GPU 资源。
- **无 CDN 依赖**：three.js 以 importmap 指向本地 `vendor/`，Cloudflare Pages 直接托管即可。
- 数据源 OpenStreetMap（ODbL），共 324 块瓦片 / 约 1.06 MB。

## 目录结构

```
sz-cbd-3d/
├── public/                  # ← Cloudflare Pages 的输出目录
│   ├── index.html           # 页面骨架 + 全部 UI 面板
│   ├── _headers             # 缓存与安全响应头
│   ├── css/style.css        # 深色玻璃拟态样式
│   ├── js/
│   │   ├── main.js          # 入口：场景、光照、主循环、HUD
│   │   ├── config.js        # 配置常量 + 经纬度↔本地米制换算
│   │   ├── tiles.js         # 瓦片状态机 / 调度 / 装配 / 卸载 / 拾取
│   │   ├── geometry.js      # footprint → 挤出建筑、道路 ribbon、水体绿地
│   │   ├── controls.js      # orbit / walk / fly 三种相机模式
│   │   ├── minimap.js       # 瓦片状态小地图
│   │   └── labels.js        # DOM 标签层（投影 + 去重叠）
│   ├── vendor/              # three.js r160（本地化，含 LICENSE）
│   └── data/
│       ├── manifest.json    # 瓦片索引 + 原点 + 地标
│       └── tiles/<tx>_<tz>.json
├── scripts/
│   ├── fetch_osm.py         # 从 Overpass 抓原始 OSM
│   └── build_tiles.py       # 投影 → 切片 → 写 JSON
├── raw/                     # 原始 OSM（已 gitignore）
└── wrangler.toml
```

## 本地预览

```bash
cd public && python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

必须走 HTTP 服务，不能用 `file://`（ES module + importmap + fetch 都受同源限制）。

## 部署到 Cloudflare Pages

**方式一：Git 集成（推荐）**

推到 GitHub 后在 Pages 里新建项目：

| 配置项 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | *(留空)* |
| Build output directory | `public` |

**方式二：Wrangler 直传**

```bash
npm i -g wrangler
wrangler pages deploy public --project-name sz-cbd-3d
```

`_headers` 会给 `vendor/` 打上一年不变的 immutable 缓存，瓦片 7 天，manifest 1 小时。

## 重新生成数据

改 bbox / 视野范围 / 高度推断规则后重跑：

```bash
python3 scripts/fetch_osm.py     # 抓 Overpass（约 6 MB）
python3 scripts/build_tiles.py   # 切片到 public/data/
```

`scripts/build_tiles.py` 顶部的可调参数：

| 常量 | 含义 | 当前值 |
| --- | --- | --- |
| `ORIGIN_LAT/LON` | 本地坐标原点 | 22.5390, 114.0580 |
| `TILE_SIZE` | 瓦片边长（米） | 250 |
| `HALF_EXTENT` | 渲染半径（米），超出丢弃 | 2100 |
| `DEFAULT_LEVEL_HEIGHT` | 无 `height` 时每层高度 | 3.2 m |

高度优先级：`height` → `building:height` → `building:levels × 3.2` → 按 `building=*`
类型的经验值兜底。OSM 里福田只有 89 栋标了精确 `height`、776 栋标了层数，其余靠兜底，
所以远处的普通住宅高度是估算值，主要地标（平安金融中心等）是真实数据。

## 坐标系

本地米制右手系：**+X 向东，+Z 向南，+Y 向上**。瓦片内的坐标是相对该瓦片原点
（`tx * 250, tz * 250`）的偏移，这样每个数字都很小，JSON 体积更省。

## 操作

| 键 | 作用 |
| --- | --- |
| 拖拽 / 滚轮 | 环绕模式旋转 / 缩放 |
| `W` `A` `S` `D` | 移动 |
| `Shift` | 加速 |
| `Space` | 跳跃（行走）/ 上升（飞行） |
| `C` | 环绕 ↔ 行走 |
| `V` / `F` / `T` / `R` | 行走 / 飞行 / 俯视 / 重置 |
| `L` / `G` | 切换标签 / 瓦片网格 |

点击建筑弹出名称、高度、层数、类型与经纬度；点小地图任意格子即传送；
「复制链接」会把当前经纬度与朝向写进 URL hash，可直接分享视角。

## 已知限制

- 建筑是「footprint 直接挤出」，没有屋顶造型、没有 `building:part` 分段。
- 行走碰撞用「脚下点是否落在建筑轮廓内」判定，贴墙移动时可能出现轻微穿插。
- 视距拉到 2400 m 时需要拉全部 324 块瓦片，首次约 1 MB 流量，之后走浏览器缓存。
