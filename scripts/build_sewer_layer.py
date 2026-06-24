#!/usr/bin/env python3
"""
สร้าง yala_sewers.geojson สำหรับแสดงแนวท่อ/คูระบายน้ำในเขตเทศบาลนครยะลา
รวมข้อมูลจาก:
  1. yala_drainage_network_filtered.geojson  - โครงข่ายระบายน้ำจาก DEM (ในตัวเมือง)
  2. yala_waterways_osm.geojson              - คลอง/ท่อระบายน้ำ/ลำธารจาก OSM
     (กรอง เฉพาะ drain / ditch / canal ที่อยู่ในขอบเขตเทศบาล)
"""
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(BASE, "data")

# ขอบเขตเทศบาลนครยะลา (Yala municipality bbox)
MUN_W, MUN_S, MUN_E, MUN_N = 101.230, 6.495, 101.345, 6.590

def in_mun(coords):
    """ตรวจว่าเส้นมีจุดอย่างน้อยหนึ่งจุดในขอบเขตเทศบาล"""
    pts = coords if isinstance(coords[0], list) else [coords]
    for pt in pts:
        if MUN_W <= pt[0] <= MUN_E and MUN_S <= pt[1] <= MUN_N:
            return True
    return False

features = []

# ── 1. โครงข่ายระบายน้ำจาก DEM (yala_drainage_network_filtered) ──────────────
drain_path = os.path.join(DATA, "yala_drainage_network_filtered.geojson")
if os.path.exists(drain_path):
    with open(drain_path, encoding="utf-8") as f:
        gj = json.load(f)
    for feat in gj["features"]:
        coords = feat["geometry"]["coordinates"]
        if in_mun(coords):
            features.append({
                "type": "Feature",
                "geometry": feat["geometry"],
                "properties": {
                    "source": "dem_drainage",
                    "kind": "drain",
                    "label": "แนวระบายน้ำ (จาก DEM)",
                    "name": feat["properties"].get("name", ""),
                }
            })
    print(f"DEM drainage: {len(gj['features'])} features loaded")
else:
    print("SKIP: yala_drainage_network_filtered.geojson not found")

# ── 2. OSM waterways — คัดเฉพาะ drain / ditch / canal ──────────────────────
osm_path = os.path.join(DATA, "yala_waterways_osm.geojson")
SEWER_KINDS = {"drain", "ditch", "canal"}
if os.path.exists(osm_path):
    with open(osm_path, encoding="utf-8") as f:
        gj2 = json.load(f)
    added = 0
    for feat in gj2["features"]:
        kind = feat["properties"].get("kind", "")
        if kind not in SEWER_KINDS:
            continue
        geom = feat["geometry"]
        coords = geom.get("coordinates", [])
        pts = coords[0] if geom["type"] == "Polygon" else coords
        if not in_mun(pts):
            continue
        features.append({
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "source": "osm",
                "kind": kind,
                "label": {"drain": "ท่อ/คูระบายน้ำ", "ditch": "คูน้ำ", "canal": "คลองชลประทาน"}.get(kind, kind),
                "name": feat["properties"].get("name", ""),
            }
        })
        added += 1
    print(f"OSM drain/ditch/canal in municipality: {added} features")
else:
    print("SKIP: yala_waterways_osm.geojson not found")

# ── 3. บันทึก ─────────────────────────────────────────────────────────────────
out_path = os.path.join(DATA, "yala_sewers.geojson")
out_gj = {"type": "FeatureCollection", "features": features}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out_gj, f, ensure_ascii=False)

kinds = {}
sources = {}
for feat in features:
    k = feat["properties"]["kind"]; kinds[k] = kinds.get(k,0)+1
    s = feat["properties"]["source"]; sources[s] = sources.get(s,0)+1

print(f"\nSaved {len(features)} total features -> {os.path.basename(out_path)}")
print(f"  by kind:   {kinds}")
print(f"  by source: {sources}")
