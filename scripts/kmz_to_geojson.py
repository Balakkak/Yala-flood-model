#!/usr/bin/env python3
"""
แปลง KMZ (ฝาท่อ / สถานีสูบ / ทางน้ำ) ของเทศบาลนครยะลา → GeoJSON ใช้บนแผนที่ 2D+3D
- ฝาท่อ (จุด)   : วัสดุ/ขนาด/รูปร่าง
- สถานีสูบ (จุด) : ชื่อ/จำนวนเครื่องสูบ/อัตราการสูบรวม
- ทางน้ำ (polygon): ชื่อ/ประเภท/กว้าง/ยาว
รัน: python3 scripts/kmz_to_geojson.py
"""
import os, re, json, zipfile, html, ast

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DL = os.path.expanduser("~/Downloads")
OUT = os.path.join(ROOT, "data")

JOBS = [
    ("ยะลา_ตำแหน่งฝาท่อ_20260615.kmz",   "yala_drainage_manholes.geojson", "manhole"),
    ("ยะลา_ตำแหน่งสถานีสูบ_20260615.kmz", "yala_pump_stations.geojson",     "pump"),
    ("ยะลา_ทางน้ำ_20260615.kmz",          "yala_waterways_kmz.geojson",     "waterway"),
]

def read_kml(kmz):
    with zipfile.ZipFile(kmz) as z:
        name = next(n for n in z.namelist() if n.endswith(".kml"))
        return z.read(name).decode("utf-8", "replace")

def parse_desc(desc):
    """ดึง key→value จากตาราง HTML ใน <description>"""
    d = html.unescape(desc or "")
    props = {}
    for k, v in re.findall(r"<td><b>(.*?)</b></td><td>(.*?)</td>", d, re.S):
        props[k.strip()] = re.sub(r"<.*?>", "", v).strip()
    return props

def coords_from(block):
    """คืน list ของ [lon,lat] จากข้อความ <coordinates>"""
    out = []
    for c in re.findall(r"<coordinates>(.*?)</coordinates>", block, re.S):
        ring = []
        for tok in c.split():
            p = tok.split(",")
            if len(p) >= 2:
                ring.append([round(float(p[0]), 6), round(float(p[1]), 6)])
        if ring:
            out.append(ring)
    return out

def pump_summary(props):
    """ย่อ 'รายละเอียดเฉพาะ' (dict) ของสถานีสูบ → จำนวนเครื่อง/อัตราสูบรวม/ผู้ดูแล"""
    raw = props.get("รายละเอียดเฉพาะ", "")
    info = {}
    try:
        d = ast.literal_eval(raw)
        pumps = d.get("pumpInfo", []) or []
        info["pump_count"] = len(pumps)
        info["flow_total"] = round(sum(float(p.get("waterFlowRate") or 0) for p in pumps), 2)
        info["pump_on"] = sum(1 for p in pumps if str(p.get("status")).upper() == "ON")
        info["gate_count"] = len(d.get("stationGate", []) or [])
        c = d.get("contactInfo") or {}
        if c.get("name"): info["contact"] = c.get("name")
    except Exception:
        pass
    return info

def build(kml, kind):
    feats = []
    for pm in re.findall(r"<Placemark\b.*?</Placemark>", kml, re.S):
        name = (re.search(r"<name>(.*?)</name>", pm, re.S) or [None, ""])[1]
        name = html.unescape(name).strip()
        desc = (re.search(r"<description>(.*?)</description>", pm, re.S) or [None, ""])[1]
        props = parse_desc(desc)

        if kind == "manhole":
            m = re.search(r"<coordinates>(.*?)</coordinates>", pm, re.S)
            if not m: continue
            p = m.group(1).split(",")
            geom = {"type": "Point", "coordinates": [round(float(p[0]), 6), round(float(p[1]), 6)]}
            keep = {"material": props.get("วัสดุ"), "w": props.get("กว้าง"),
                    "l": props.get("ยาว"), "shape": props.get("รูปร่าง")}
            feats.append({"type": "Feature", "geometry": geom,
                          "properties": {k: v for k, v in keep.items() if v}})

        elif kind == "pump":
            m = re.search(r"<coordinates>(.*?)</coordinates>", pm, re.S)
            if not m: continue
            p = m.group(1).split(",")
            geom = {"type": "Point", "coordinates": [round(float(p[0]), 6), round(float(p[1]), 6)]}
            pr = {"name": name, "maintained": props.get("วันที่ซ่อมบำรุง")}
            pr.update(pump_summary(props))
            feats.append({"type": "Feature", "geometry": geom,
                          "properties": {k: v for k, v in pr.items() if v not in (None, "")}})

        elif kind == "waterway":
            rings = coords_from(pm)
            if not rings: continue
            geom = ({"type": "Polygon", "coordinates": [rings[0]]} if len(rings) == 1
                    else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]})
            pr = {"name": name, "wtype": props.get("ประเภทน้ำ"),
                  "width_m": props.get("กว้าง"), "length_m": props.get("ยาว")}
            feats.append({"type": "Feature", "geometry": geom,
                          "properties": {k: v for k, v in pr.items() if v}})
    return feats

for fname, out, kind in JOBS:
    kmz = os.path.join(DL, fname)
    if not os.path.exists(kmz):
        print(f"  ข้าม (ไม่พบ): {fname}"); continue
    feats = build(read_kml(kmz), kind)
    gj = {"type": "FeatureCollection", "features": feats}
    path = os.path.join(OUT, out)
    json.dump(gj, open(path, "w"), ensure_ascii=False, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"  ✅ {out}: {len(feats)} features · {kb:.0f} KB")

print("เสร็จ")
