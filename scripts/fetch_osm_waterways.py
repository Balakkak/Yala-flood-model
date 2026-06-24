#!/usr/bin/env python3
"""
ดึงทางน้ำจริง (คลอง/แม่น้ำ/ลำธาร/บึง) จาก OpenStreetMap ผ่าน Overpass API
ครอบคลุมขอบเขต DEM ของโปรเจกต์ (รวมต้นน้ำฝั่งตะวันออก: บอยอ/สะเตงนอก/บึงแบเมาะ)
แล้วบันทึกเป็น data/yala_waterways_osm.geojson เพื่อใช้เป็น "ต้นน้ำ" เพิ่มเติมใน priority-flood
"""
import json, urllib.request, urllib.parse, os, sys

# bbox เดียวกับ DEM AW3D30: [W,S,E,N] -> Overpass ใช้ (S,W,N,E)
S, W, N, E = 6.40, 101.20, 6.70, 101.40
QUERY = f"""
[out:json][timeout:90];
(
  way["waterway"~"river|canal|stream|drain|ditch"]({S},{W},{N},{E});
  way["natural"="water"]({S},{W},{N},{E});
  relation["natural"="water"]({S},{W},{N},{E});
);
out geom;
"""

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

def fetch():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in ENDPOINTS:
        try:
            print(f"... querying {url}")
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "yala-flood-gis/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:
            print(f"  failed: {e}")
    sys.exit("Overpass ไม่ตอบสนองทุก endpoint")

def to_geojson(osm):
    feats = []
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name", "")
        if el["type"] == "way" and "geometry" in el:
            coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
            if len(coords) < 2:
                continue
            wtype = tags.get("waterway") or tags.get("natural") or "water"
            # natural=water ที่เป็นวงปิด -> Polygon, นอกนั้น LineString
            if tags.get("natural") == "water" and coords[0] == coords[-1] and len(coords) >= 4:
                geom = {"type": "Polygon", "coordinates": [coords]}
            else:
                geom = {"type": "LineString", "coordinates": coords}
            feats.append({"type": "Feature",
                          "properties": {"name": name, "kind": wtype},
                          "geometry": geom})
    return {"type": "FeatureCollection", "features": feats}

if __name__ == "__main__":
    osm = fetch()
    gj = to_geojson(osm)
    out = os.path.join(os.path.dirname(__file__), "..", "data", "yala_waterways_osm.geojson")
    out = os.path.abspath(out)
    with open(out, "w") as f:
        json.dump(gj, f)
    kinds = {}
    for ft in gj["features"]:
        k = ft["properties"]["kind"]; kinds[k] = kinds.get(k, 0) + 1
    named = sorted({ft["properties"]["name"] for ft in gj["features"] if ft["properties"]["name"]})
    print(f"✅ saved {len(gj['features'])} features -> {out}")
    print("   kinds:", kinds)
    print("   named:", ", ".join(named[:40]))
