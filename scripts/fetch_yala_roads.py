#!/usr/bin/env python3
"""
ดึงข้อมูลถนนในเขตเทศบาลนครยะลาจาก OpenStreetMap ผ่าน Overpass API
บันทึกเป็น data/yala_roads.geojson
ใช้สำหรับ burn ลง DEM เพื่อสร้างแนวกั้นน้ำตามแนวถนน
"""
import sys, json, os, urllib.request, urllib.parse
sys.stdout.reconfigure(encoding='utf-8')

S, W, N, E = 6.495, 101.230, 6.590, 101.345

QUERY = f"""[out:json][timeout:150];
(
  way["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified)$"]({S},{W},{N},{E});
);
out geom;"""

# ระดับความสูงที่ burn เพิ่มเข้าไปในความสูง DEM ตามประเภทถนน (เมตร)
BURN_HEIGHT = {
    'trunk':        0.8,   # ถนนหลักสายหลัก
    'primary':      0.7,   # ถนนหลัก
    'secondary':    0.5,   # ถนนรอง
    'tertiary':     0.4,   # ถนนท้องถิ่น
    'residential':  0.3,   # ซอย
    'unclassified': 0.2,
}

def fetch_osm():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ]:
        try:
            print(f"  querying {url} ...")
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "yala-flood-gis/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)
        except Exception as e:
            print(f"  failed: {e}")
    sys.exit("Overpass API ไม่ตอบสนอง")

raw = fetch_osm()
features = []
for el in raw.get("elements", []):
    if el["type"] != "way" or "geometry" not in el:
        continue
    tags = el.get("tags", {})
    highway = tags.get("highway", "")
    if highway not in BURN_HEIGHT:
        continue
    coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
    if len(coords) < 2:
        continue
    features.append({
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "highway": highway,
            "name": tags.get("name", ""),
            "burn_m": BURN_HEIGHT[highway],
        }
    })

out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "yala_roads.geojson"))
with open(out, "w", encoding="utf-8") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f, ensure_ascii=False)

kinds = {}
for feat in features:
    k = feat["properties"]["highway"]
    kinds[k] = kinds.get(k, 0) + 1
print(f"Saved {len(features)} road features -> {os.path.basename(out)}")
print("  by type:", kinds)
