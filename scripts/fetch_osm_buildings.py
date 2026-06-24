#!/usr/bin/env python3
"""
ดึง footprint อาคารจริงจาก OpenStreetMap สำหรับปั้นโมเดล 3D เมืองยะลา
- ความสูงแต่ละตึก: ใช้ tag height ถ้ามี > building:levels×3 ม. > ค่า default ตามประเภท
บันทึก data/yala_buildings.geojson  (properties: height, levels, btype, name, src)
"""
import json, urllib.request, urllib.parse, os, sys, re

# bbox = เขตเมืองยะลา (urban core) — แน่นพอให้เห็นโมเดล 3D ชัด, ดาวน์โหลดไม่อืด
S, W, N, E = 6.515, 101.248, 6.585, 101.315
Q = f"""
[out:json][timeout:180];
( way["building"]({S},{W},{N},{E}); );
out geom;
"""

# ค่า default ความสูง (ม.) ตามประเภทอาคาร เมื่อไม่มี tag height/levels
DEFAULT_H = {
    "house": 6, "detached": 6, "residential": 9, "apartments": 18, "hotel": 24,
    "commercial": 12, "retail": 9, "office": 21, "industrial": 9, "warehouse": 9,
    "school": 9, "university": 15, "hospital": 21, "temple": 12, "mosque": 15,
    "church": 15, "public": 12, "civic": 12, "government": 15, "yes": 7,
}
LEVEL_M = 3.2   # ความสูงต่อชั้นโดยประมาณ

def fetch():
    data = urllib.parse.urlencode({"data": Q}).encode()
    for url in ["https://overpass-api.de/api/interpreter",
                "https://overpass.kumi.systems/api/interpreter"]:
        try:
            print("... querying", url)
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": "yala-flood-gis/1.0"})
            with urllib.request.urlopen(req, timeout=200) as r:
                return json.load(r)
        except Exception as e:
            print("  failed:", e)
    sys.exit("Overpass ไม่ตอบสนอง")

def num(s):
    m = re.search(r"[-+]?\d*\.?\d+", str(s))
    return float(m.group()) if m else None

def height_of(t):
    """คืน (height_m, src)"""
    if t.get("height") is not None:
        h = num(t["height"])
        if h and h > 0:
            return round(h, 1), "tag"
    if t.get("building:levels") is not None:
        lv = num(t["building:levels"])
        if lv and lv > 0:
            return round(lv * LEVEL_M, 1), "levels"
    bt = t.get("building", "yes")
    return float(DEFAULT_H.get(bt, DEFAULT_H["yes"])), "default"

osm = fetch()
feats, n_tag, n_lvl, n_def = [], 0, 0, 0
for el in osm.get("elements", []):
    if el.get("type") != "way" or "geometry" not in el:
        continue
    coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
    if len(coords) < 4:
        continue
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    t = el.get("tags", {})
    h, src = height_of(t)
    lv = num(t.get("building:levels")) if t.get("building:levels") else None
    n_tag += src == "tag"; n_lvl += src == "levels"; n_def += src == "default"
    feats.append({
        "type": "Feature",
        "properties": {
            "height": h,
            "levels": lv,
            "btype": t.get("building", "yes"),
            "name": t.get("name", ""),
            "src": src,
        },
        "geometry": {"type": "Polygon", "coordinates": [coords]},
    })

gj = {"type": "FeatureCollection", "features": feats}
out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "yala_buildings.geojson"))
with open(out, "w") as f:
    json.dump(gj, f)
print(f"✅ saved {len(feats)} buildings -> {out}")
print(f"   height source: tag={n_tag}  levels={n_lvl}  default={n_def}")
