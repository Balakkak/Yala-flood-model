#!/usr/bin/env python3
"""
ดึง footprint อาคารจากชุด Microsoft Global ML Building Footprints (Thailand)
— ครอบคลุมยะลาดีกว่า OSM มาก (สกัดจากภาพดาวเทียมด้วย AI)
ความสูง: ใช้ height จากชุดข้อมูลถ้ามี (>0) มิฉะนั้นประเมินจากพื้นที่ footprint
บันทึก data/yala_buildings.geojson
"""
import json, csv, gzip, io, os, sys, math, urllib.request

S, W, N, E = 6.50, 101.235, 6.60, 101.33     # เขตเมืองยะลา
LINKS = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"

def quadkey(lat, lon, z=9):
    sin = math.sin(math.radians(lat))
    x = int((lon + 180.0) / 360.0 * (1 << z))
    y = int((0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * (1 << z))
    qk = ""
    for i in range(z, 0, -1):
        d = 0; mask = 1 << (i - 1)
        if x & mask: d += 1
        if y & mask: d += 2
        qk += str(d)
    return qk

# quadkeys (z9) ที่คลุม bbox ยะลา
qks = {quadkey(la, lo) for la in (S, N) for lo in (W, E)}
print("quadkeys ที่ต้องใช้:", qks)

def get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "yala-gis/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)

print("... โหลด dataset-links.csv")
text = get(LINKS, 120).read().decode("utf-8", "replace")
rows = list(csv.DictReader(io.StringIO(text)))
want = [r for r in rows if r.get("Location") == "Thailand" and r.get("QuadKey") in qks]
print(f"   พบ tile ไทยที่ตรง quadkey: {len(want)}")
if not want:
    sys.exit("ไม่พบ tile — ตรวจ quadkey/bbox")

def inbox(lon, lat):
    return W <= lon <= E and S <= lat <= N

def area_m2(ring):
    # shoelace แบบหยาบในหน่วยเมตร (พอประมาณความสูงจากพื้นที่)
    latm = sum(p[1] for p in ring) / len(ring)
    mx = 111320 * math.cos(math.radians(latm)); my = 110574
    a = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0]*mx, ring[i][1]*my
        x2, y2 = ring[i+1][0]*mx, ring[i+1][1]*my
        a += x1*y2 - x2*y1
    return abs(a) / 2.0

def est_height(area, h_tag):
    if h_tag is not None and h_tag > 0:
        return round(h_tag, 1), "tag"
    # ประเมินจากขนาด footprint: ยิ่งใหญ่มักยิ่งสูง (คร่าว ๆ 2–6 ชั้น)
    if area < 60:   h = 6
    elif area < 120: h = 7
    elif area < 250: h = 9
    elif area < 600: h = 12
    else:            h = 16
    return float(h), "area"

feats, n_tag, n_est = [], 0, 0
for r in want:
    url = r["Url"]
    print("... โหลด tile", r["QuadKey"], "(gz geojsonl)")
    raw = get(url).read()
    buf = gzip.GzipFile(fileobj=io.BytesIO(raw))
    for line in buf:
        line = line.strip()
        if not line:
            continue
        try:
            ft = json.loads(line)
        except Exception:
            continue
        geom = ft.get("geometry") or {}
        if geom.get("type") != "Polygon":
            continue
        ring = geom["coordinates"][0]
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        if not inbox(cx, cy):
            continue
        h_tag = (ft.get("properties") or {}).get("height")
        h_tag = h_tag if isinstance(h_tag, (int, float)) and h_tag > 0 else None
        h, src = est_height(area_m2(ring), h_tag)
        n_tag += src == "tag"; n_est += src != "tag"
        feats.append({"type": "Feature",
                      "properties": {"height": h, "src": src,
                                     "area_m2": round(area_m2(ring))},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})

out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "yala_buildings.geojson"))
with open(out, "w") as f:
    json.dump({"type": "FeatureCollection", "features": feats}, f)
print(f"✅ saved {len(feats)} buildings -> {out}")
print(f"   height: tag={n_tag}  estimated={n_est}")
