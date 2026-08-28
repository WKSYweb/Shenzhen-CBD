#!/usr/bin/env python3
"""Convert raw Overpass JSON into per-tile static JSON chunks for the web app.

Pipeline
--------
1. Read ``raw/futian_cbd.json``.
2. Project lon/lat to a local metric frame (equirectangular around ORIGIN).
   +X = east, +Z = south (three.js right-handed, y up).
3. Assign every feature to a 250 m tile based on its centroid.
4. Write ``public/data/tiles/<tx>_<tz>.json`` + ``public/data/manifest.json``.

Buildings keep their footprint rings; extrusion happens in the browser
(three.js ExtrudeGeometry), which keeps the payload small.
"""
from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "futian_cbd.json"
OUT_DIR = ROOT / "public" / "data"
TILES_DIR = OUT_DIR / "tiles"

# Local frame origin: Ping An Finance Centre area, Futian CBD
ORIGIN_LAT = 22.5390
ORIGIN_LON = 114.0580

TILE_SIZE = 250.0  # metres
# Render half-extent around origin (metres). Anything outside is dropped.
HALF_EXTENT = 2100.0

DEFAULT_LEVEL_HEIGHT = 3.2
MIN_HEIGHT = 4.0

ROAD_WIDTH = {
    "motorway": 22.0,
    "trunk": 18.0,
    "primary": 16.0,
    "secondary": 12.0,
    "tertiary": 9.0,
    "residential": 7.0,
    "unclassified": 6.5,
    "living_street": 5.5,
    "service": 4.0,
    "pedestrian": 5.0,
    "footway": 2.4,
}
ROAD_CLASS = {
    "motorway": "major",
    "trunk": "major",
    "primary": "major",
    "secondary": "mid",
    "tertiary": "mid",
    "residential": "minor",
    "unclassified": "minor",
    "living_street": "minor",
    "service": "minor",
    "pedestrian": "path",
    "footway": "path",
}

# Landmarks used by the "teleport" menu (lat, lon, label)
LANDMARKS = [
    ("平安金融中心", 22.5372, 114.0503),
    ("市民中心", 22.5470, 114.0546),
    ("深圳会展中心", 22.5350, 114.0600),
    ("京基100", 22.5443, 114.0930),
    ("深圳北站方向", 22.5580, 114.0450),
    ("华强北", 22.5470, 114.0900),
    ("莲花山公园", 22.5560, 114.0570),
    ("深圳湾体育中心", 22.5210, 114.0380),
]


def deg_scale(lat: float) -> tuple[float, float]:
    """Metres per degree of longitude / latitude at ``lat``."""
    m_per_deg_lat = 111132.92 - 559.82 * math.cos(2 * math.radians(lat))
    m_per_deg_lon = 111412.84 * math.cos(math.radians(lat)) - 93.5 * math.cos(
        3 * math.radians(lat)
    )
    return m_per_deg_lon, m_per_deg_lat


MPD_LON, MPD_LAT = deg_scale(ORIGIN_LAT)


def project(lon: float, lat: float) -> tuple[float, float]:
    """lon/lat -> (x east, z south) in metres relative to ORIGIN."""
    x = (lon - ORIGIN_LON) * MPD_LON
    z = -(lat - ORIGIN_LAT) * MPD_LAT
    return x, z


_NUM = re.compile(r"-?\d+(?:\.\d+)?")


def parse_number(value: str | None) -> float | None:
    if not value:
        return None
    m = _NUM.search(str(value))
    if not m:
        return None
    try:
        return float(m.group())
    except ValueError:
        return None


def guess_height(tags: dict) -> float:
    h = parse_number(tags.get("height"))
    if h is None:
        h = parse_number(tags.get("building:height"))
    if h is None:
        lv = parse_number(tags.get("building:levels"))
        if lv is not None:
            h = lv * DEFAULT_LEVEL_HEIGHT + 1.0
    if h is None:
        kind = tags.get("building", "yes")
        h = {
            "apartments": 42.0,
            "residential": 30.0,
            "commercial": 34.0,
            "retail": 14.0,
            "office": 60.0,
            "hotel": 55.0,
            "school": 16.0,
            "kindergarten": 10.0,
            "college": 22.0,
            "hospital": 32.0,
            "train_station": 18.0,
            "roof": 6.0,
            "house": 8.0,
            "construction": 20.0,
        }.get(kind, 18.0)
    return max(MIN_HEIGHT, min(h, 700.0))


def building_kind(tags: dict) -> str:
    b = tags.get("building", "yes")
    if b in {"apartments", "residential", "house", "dormitory"}:
        return "residential"
    if b in {"commercial", "office", "retail", "hotel", "supermarket", "mall"}:
        return "commercial"
    if b in {"school", "college", "university", "kindergarten", "hospital", "civic",
             "public", "government", "museum", "library"}:
        return "civic"
    if b in {"train_station", "transportation"}:
        return "transit"
    if b in {"industrial", "warehouse", "construction"}:
        return "industrial"
    return "generic"


def ring_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        a += x1 * z2 - x2 * z1
    return a / 2.0


def centroid(pts: list[tuple[float, float]]) -> tuple[float, float]:
    a = ring_area(pts)
    if abs(a) < 1e-9:
        sx = sum(p[0] for p in pts) / len(pts)
        sz = sum(p[1] for p in pts) / len(pts)
        return sx, sz
    cx = cz = 0.0
    n = len(pts)
    for i in range(n):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % n]
        f = x1 * z2 - x2 * z1
        cx += (x1 + x2) * f
        cz += (z1 + z2) * f
    return cx / (6 * a), cz / (6 * a)


def simplify(pts: list[tuple[float, float]], tol: float = 1.2) -> list[tuple[float, float]]:
    """Radial-distance simplification; cheap and good enough for footprints."""
    if len(pts) <= 4:
        return pts
    out = [pts[0]]
    for p in pts[1:]:
        px, pz = out[-1]
        if (p[0] - px) ** 2 + (p[1] - pz) ** 2 >= tol * tol:
            out.append(p)
    if len(out) < 3:
        return pts
    return out


def r1(v: float) -> float:
    return round(v, 1)


def tile_key(x: float, z: float) -> tuple[int, int]:
    return math.floor(x / TILE_SIZE), math.floor(z / TILE_SIZE)


def in_extent(x: float, z: float) -> bool:
    return abs(x) <= HALF_EXTENT and abs(z) <= HALF_EXTENT


def main() -> int:
    data = json.loads(RAW.read_text(encoding="utf-8"))
    elements = data["elements"]

    nodes: dict[int, tuple[float, float]] = {}
    ways: dict[int, dict] = {}
    relations: list[dict] = []
    poi_nodes: list[dict] = []

    for el in elements:
        t = el["type"]
        if t == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
            if el.get("tags"):
                poi_nodes.append(el)
        elif t == "way":
            ways[el["id"]] = el
        elif t == "relation":
            relations.append(el)

    def way_points(way: dict) -> list[tuple[float, float]]:
        pts: list[tuple[float, float]] = []
        for nid in way.get("nodes", []):
            ll = nodes.get(nid)
            if ll is None:
                continue
            pts.append(project(*ll))
        return pts

    tiles: dict[tuple[int, int], dict] = defaultdict(
        lambda: {"buildings": [], "roads": [], "water": [], "green": [], "labels": []}
    )
    stats = defaultdict(int)

    # ---- buildings (ways) -------------------------------------------------
    used_in_relation: set[int] = set()
    for rel in relations:
        if not rel.get("tags", {}).get("building"):
            continue
        for m in rel.get("members", []):
            if m["type"] == "way" and m.get("role") in {"outer", ""}:
                used_in_relation.add(m["ref"])

    def add_building(pts: list[tuple[float, float]], tags: dict) -> None:
        if len(pts) < 4:
            return
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        pts = simplify(pts)
        if len(pts) < 3:
            return
        area = abs(ring_area(pts))
        if area < 25.0:
            return
        cx, cz = centroid(pts)
        if not in_extent(cx, cz):
            return
        if ring_area(pts) < 0:  # normalise to CCW
            pts = pts[::-1]
        key = tile_key(cx, cz)
        h = guess_height(tags)
        entry: dict = {
            "r": [[r1(x - key[0] * TILE_SIZE), r1(z - key[1] * TILE_SIZE)] for x, z in pts],
            "h": round(h, 1),
            "k": building_kind(tags),
        }
        lv = parse_number(tags.get("building:levels"))
        if lv:
            entry["lv"] = int(lv)
        name = tags.get("name")
        if name and (h >= 90.0 or area >= 9000.0):
            entry["n"] = name
            tiles[key]["labels"].append(
                {
                    "n": name,
                    "p": [r1(cx - key[0] * TILE_SIZE), r1(cz - key[1] * TILE_SIZE)],
                    "h": round(h, 1),
                    "t": "building",
                }
            )
        tiles[key]["buildings"].append(entry)
        stats["buildings"] += 1

    for wid, way in ways.items():
        tags = way.get("tags") or {}
        if not tags.get("building"):
            continue
        if wid in used_in_relation:
            continue
        add_building(way_points(way), tags)

    for rel in relations:
        tags = rel.get("tags") or {}
        if not tags.get("building"):
            continue
        for m in rel.get("members", []):
            if m["type"] != "way" or m.get("role") not in {"outer", ""}:
                continue
            w = ways.get(m["ref"])
            if w:
                add_building(way_points(w), tags)

    # ---- roads ------------------------------------------------------------
    for way in ways.values():
        tags = way.get("tags") or {}
        hw = tags.get("highway")
        if not hw or hw not in ROAD_WIDTH:
            continue
        pts = way_points(way)
        if len(pts) < 2:
            continue
        # split polyline at tile boundaries by chunking on segment midpoints
        cur_key: tuple[int, int] | None = None
        cur: list[tuple[float, float]] = []

        def flush() -> None:
            nonlocal cur, cur_key
            if cur_key is not None and len(cur) >= 2:
                ox, oz = cur_key[0] * TILE_SIZE, cur_key[1] * TILE_SIZE
                tiles[cur_key]["roads"].append(
                    {
                        "p": [[r1(x - ox), r1(z - oz)] for x, z in cur],
                        "w": ROAD_WIDTH[hw],
                        "c": ROAD_CLASS[hw],
                    }
                )
                stats["roads"] += 1
            cur = []

        for i, p in enumerate(pts):
            if not in_extent(*p):
                flush()
                cur_key = None
                continue
            k = tile_key(*p)
            if cur_key is None:
                cur_key = k
                cur = [p]
                continue
            if k != cur_key:
                cur.append(p)  # overlap one point for continuity
                flush()
                cur_key = k
                cur = [pts[i - 1], p]
            else:
                cur.append(p)
        flush()

    # ---- water & green ----------------------------------------------------
    def add_area(pts: list[tuple[float, float]], bucket: str) -> None:
        if len(pts) < 4:
            return
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        pts = simplify(pts, 2.5)
        if len(pts) < 3:
            return
        if abs(ring_area(pts)) < 120.0:
            return
        cx, cz = centroid(pts)
        if not in_extent(cx, cz):
            return
        if ring_area(pts) < 0:
            pts = pts[::-1]
        key = tile_key(cx, cz)
        ox, oz = key[0] * TILE_SIZE, key[1] * TILE_SIZE
        tiles[key][bucket].append(
            {"r": [[r1(x - ox), r1(z - oz)] for x, z in pts]}
        )
        stats[bucket] += 1

    for way in ways.values():
        tags = way.get("tags") or {}
        if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            add_area(way_points(way), "water")
        elif (
            tags.get("leisure") in {"park", "garden", "pitch"}
            or tags.get("landuse") in {"grass", "forest", "recreation_ground", "village_green"}
            or tags.get("natural") == "wood"
        ):
            add_area(way_points(way), "green")

    for rel in relations:
        tags = rel.get("tags") or {}
        if tags.get("natural") != "water":
            continue
        for m in rel.get("members", []):
            if m["type"] == "way" and m.get("role") in {"outer", ""}:
                w = ways.get(m["ref"])
                if w:
                    add_area(way_points(w), "water")

    # ---- transit / place labels ------------------------------------------
    for nd in poi_nodes:
        tags = nd["tags"]
        name = tags.get("name")
        if not name:
            continue
        kind = None
        if tags.get("railway") == "station":
            kind = "station"
        elif tags.get("place") in {"suburb", "neighbourhood", "quarter"}:
            kind = "place"
        if not kind:
            continue
        x, z = project(nd["lon"], nd["lat"])
        if not in_extent(x, z):
            continue
        key = tile_key(x, z)
        ox, oz = key[0] * TILE_SIZE, key[1] * TILE_SIZE
        tiles[key]["labels"].append(
            {"n": name, "p": [r1(x - ox), r1(z - oz)], "h": 30.0, "t": kind}
        )
        stats["labels"] += 1

    # ---- write ------------------------------------------------------------
    TILES_DIR.mkdir(parents=True, exist_ok=True)
    for old in TILES_DIR.glob("*.json"):
        old.unlink()

    index: list[dict] = []
    for (tx, tz), payload in sorted(tiles.items()):
        if not any(payload[k] for k in ("buildings", "roads", "water", "green")):
            continue
        name = f"{tx}_{tz}.json"
        doc = {
            "tx": tx,
            "tz": tz,
            "size": TILE_SIZE,
            "origin": [tx * TILE_SIZE, tz * TILE_SIZE],
            **payload,
        }
        (TILES_DIR / name).write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        maxh = max((b["h"] for b in payload["buildings"]), default=0.0)
        index.append(
            {
                "tx": tx,
                "tz": tz,
                "b": len(payload["buildings"]),
                "r": len(payload["roads"]),
                "w": len(payload["water"]),
                "g": len(payload["green"]),
                "maxh": round(maxh, 1),
                "bytes": (TILES_DIR / name).stat().st_size,
            }
        )

    txs = [t["tx"] for t in index]
    tzs = [t["tz"] for t in index]
    manifest = {
        "generated": "static build",
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "city": "Shenzhen · Futian CBD",
        "origin": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON},
        "metresPerDegree": {"lon": round(MPD_LON, 3), "lat": round(MPD_LAT, 3)},
        "tileSize": TILE_SIZE,
        "halfExtent": HALF_EXTENT,
        "bounds": {
            "minTx": min(txs),
            "maxTx": max(txs),
            "minTz": min(tzs),
            "maxTz": max(tzs),
        },
        "counts": dict(stats),
        "tiles": index,
        "landmarks": [
            {
                "name": n,
                "lat": la,
                "lon": lo,
                "pos": [r1(project(lo, la)[0]), r1(project(lo, la)[1])],
            }
            for n, la, lo in LANDMARKS
            if in_extent(*project(lo, la))
        ],
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    total = sum(t["bytes"] for t in index)
    print(f"[build] tiles={len(index)} total={total / 1e6:.2f} MB")
    print(f"[build] stats={dict(stats)}")
    print(f"[build] tile range x[{min(txs)},{max(txs)}] z[{min(tzs)},{max(tzs)}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
