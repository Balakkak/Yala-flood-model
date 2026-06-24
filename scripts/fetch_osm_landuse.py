#!/usr/bin/env python3
"""
ดึง land use / land cover จริงจาก OpenStreetMap (แทนข้อ 4 LDD ที่โหลดอัตโนมัติไม่ได้)
ใช้แยกพื้นผิวซึมน้ำ (pervious) vs พื้นแข็ง (impervious) -> ค่าสัมประสิทธิ์การไหลบ่า + หาทำเลแก้มลิง
บันทึก data/yala_landuse_osm.geojson
"""
import json, urllib.request, urllib.parse, os, sys

S, W, N, E = 6.49, 101.23, 6.61, 101.37   # เมืองยะลา + รอบนอก
Q = f"""
[out:json][timeout:120];
(
  way["landuse"]({S},{W},{N},{E});
  way["natural"~"water|wood|scrub|wetland|grassland"]({S},{W},{N},{E});
  way["leisure"~"park|garden|pitch"]({S},{W},{N},{E});
);
out geom;
"""
# จัดกลุ่มเป็น pervious(ซึมน้ำ) / impervious(พื้นแข็ง) / water
IMPERV = {"residential","commercial","industrial","retail","construction","railway","quarry"}
WATER = {"water","reservoir","basin"}

def fetch():
    data = urllib.parse.urlencode({"data": Q}).encode()
    for url in ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]:
        try:
            print("... querying", url)
            req = urllib.request.Request(url, data=data, headers={"User-Agent": "yala-flood-gis/1.0"})
            with urllib.request.urlopen(req, timeout=150) as r:
                return json.load(r)
        except Exception as e:
            print("  failed:", e)
    sys.exit("Overpass ไม่ตอบสนอง")

def classify(tags):
    lu = tags.get("landuse") or tags.get("natural") or tags.get("leisure") or ""
    if lu in WATER or tags.get("natural") == "water":
        return "water"
    if lu in IMPERV:
        return "impervious"
    return "pervious"

osm = fetch()
feats = []
for el in osm.get("elements", []):
    if el["type"] != "way" or "geometry" not in el:
        continue
    coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
    if len(coords) < 4:
        continue
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    t = el.get("tags", {})
    feats.append({"type": "Feature",
                  "properties": {"class": classify(t),
                                 "tag": t.get("landuse") or t.get("natural") or t.get("leisure") or "",
                                 "name": t.get("name", "")},
                  "geometry": {"type": "Polygon", "coordinates": [coords]}})
gj = {"type": "FeatureCollection", "features": feats}
out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "yala_landuse_osm.geojson"))
with open(out, "w") as f:
    json.dump(gj, f)
cnt = {}
for ft in feats:
    cnt[ft["properties"]["class"]] = cnt.get(ft["properties"]["class"], 0) + 1
print("✅ saved", len(feats), "polygons ->", out)
print("   classes:", cnt)
