#!/usr/bin/env python3
"""Fetch raw OSM data for the Futian CBD area from Overpass API.

Output: raw/futian_cbd.json  (Overpass JSON, `out body; >; out skel qt;`)

The bbox is intentionally a bit larger than the render area so that
buildings clipped at the border still have complete geometry.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Futian CBD (Shenzhen) -- Ping An IFC / Civic Center / Shenzhen Bay north edge
BBOX = (22.5210, 114.0380, 22.5580, 114.0820)  # south, west, north, east

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

QUERY = """
[out:json][timeout:180];
(
  way["building"]({bbox});
  relation["building"]({bbox});
  way["building:part"]({bbox});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|service|pedestrian|footway)$"]({bbox});
  way["natural"="water"]({bbox});
  way["waterway"="riverbank"]({bbox});
  relation["natural"="water"]({bbox});
  way["leisure"~"^(park|garden|pitch)$"]({bbox});
  way["landuse"~"^(grass|forest|recreation_ground|village_green)$"]({bbox});
  way["natural"="wood"]({bbox});
  node["place"~"^(suburb|neighbourhood|quarter)$"]({bbox});
  node["railway"="station"]({bbox});
  node["subway"="yes"]({bbox});
);
out body;
>;
out skel qt;
"""


def build_query() -> str:
    bbox = ",".join(str(v) for v in BBOX)
    return QUERY.format(bbox=bbox)


def fetch() -> dict:
    data = urllib.parse.urlencode({"data": build_query()}).encode()
    last_err: Exception | None = None
    for url in ENDPOINTS:
        for attempt in range(2):
            try:
                print(f"[overpass] POST {url} (attempt {attempt + 1})", flush=True)
                req = urllib.request.Request(
                    url,
                    data=data,
                    headers={
                        "User-Agent": "sz-cbd-3d/1.0 (static map builder)",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                )
                with urllib.request.urlopen(req, timeout=240) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                n = len(payload.get("elements", []))
                print(f"[overpass] ok, {n} elements", flush=True)
                if n == 0:
                    raise RuntimeError("empty response")
                return payload
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                print(f"[overpass] failed: {exc}", flush=True)
                time.sleep(5)
    raise SystemExit(f"all endpoints failed: {last_err}")


def main() -> int:
    out = Path(__file__).resolve().parent.parent / "raw" / "futian_cbd.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = fetch()
    out.write_text(json.dumps(payload), encoding="utf-8")
    print(f"[overpass] wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
