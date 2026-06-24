#!/usr/bin/env python3
"""
ฝังข้อมูลโครงสร้างระบายน้ำจริง (ทางน้ำ/สถานีสูบ/ฝาท่อ) ลงในกริด DEM
เพื่อให้โมเดลจำลองน้ำท่วม "ขึ้น-ลง" ตามจริงมากขึ้น
----------------------------------------------------------------------
เพิ่ม 2 ชั้นข้อมูลเข้า data/dem_grid.json:
  channel  : เซลล์ที่เป็น "ทางน้ำจริง" (แม่น้ำ/คลอง) → ใช้เป็นต้นทางการไหล (seed)
             → น้ำขึ้นจากทางน้ำจริง ทิศ/ลำดับการท่วมแม่นขึ้น
  drain_cm : "ความจุระบายน้ำ" ของแต่ละเซลล์ (ซม.) จาก สถานีสูบ + ความหนาแน่นฝาท่อ
             → ย่านระบายดี ท่วมตื้นกว่า และ "น้ำลดก่อน"

รัน: python3 scripts/build_drainage_grid.py
"""
import os, json
import numpy as np
from skimage.draw import polygon as sk_polygon

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
D = os.path.join(ROOT, "data")
G = json.load(open(os.path.join(D, "dem_grid.json")))
NC, NR = G["ncols"], G["nrows"]; N = NC * NR
olon, olat, dlon, dlat = G["origin_lon"], G["origin_lat"], G["dlon"], G["dlat"]
CELL_M = dlat * 111000.0  # ~30.8 ม./เซลล์

def rc(lon, lat):
    return (olat - lat) / dlat - 0.5, (lon - olon) / dlon - 0.5

def rings(geom):
    t = geom.get("type")
    if t == "Polygon": yield geom["coordinates"][0]
    elif t == "MultiPolygon":
        for p in geom["coordinates"]: yield p[0]

# ---------- 1) channel mask จากทางน้ำจริง ----------
channel = np.zeros((NR, NC), bool)
ww = json.load(open(os.path.join(D, "yala_waterways_kmz.geojson")))
for f in ww["features"]:
    for ring in rings(f.get("geometry") or {}):
        if len(ring) < 3: continue
        lon = np.array([p[0] for p in ring]); lat = np.array([p[1] for p in ring])
        rr, cc = rc(lon, lat)
        rp, cp = sk_polygon(rr, cc, shape=(NR, NC))
        channel[rp, cp] = True
n_ch = int(channel.sum())

# ---------- 2) drain capacity จาก ฝาท่อ + สถานีสูบ ----------
# (ก) ความหนาแน่นฝาท่อ → ระบายผิวดิน
mh_count = np.zeros((NR, NC), float)
mh = json.load(open(os.path.join(D, "yala_drainage_manholes.geojson")))
for f in mh["features"]:
    lon, lat = f["geometry"]["coordinates"][:2]
    r, c = rc(lon, lat); r, c = int(round(r)), int(round(c))
    if 0 <= r < NR and 0 <= c < NC: mh_count[r, c] += 1
# นับในละแวก 3x3 (รวมความหนาแน่นรอบ ๆ)
dens = np.zeros((NR, NC), float)
for dr in (-1, 0, 1):
    for dc in (-1, 0, 1):
        dens += np.roll(np.roll(mh_count, dr, 0), dc, 1)
manhole_drain = np.minimum(0.25, 0.035 * dens)   # ม. (สูงสุด 0.25 ม. เมื่อฝาท่อหนาแน่น)

# (ข) สถานีสูบ → ระบายเชิงรุกในรัศมีรอบสถานี
pump_drain = np.zeros((NR, NC), float)
R_M = 350.0; R_CELL = R_M / CELL_M
pp = json.load(open(os.path.join(D, "yala_pump_stations.geojson")))
rad = int(np.ceil(R_CELL))
for f in pp["features"]:
    lon, lat = f["geometry"]["coordinates"][:2]
    flow = float(f["properties"].get("flow_total") or 0)
    cap = min(0.40, 0.12 + 0.10 * flow)          # ความจุระบายที่ใจกลางสถานี (ม.)
    r0, c0 = rc(lon, lat); r0, c0 = int(round(r0)), int(round(c0))
    for r in range(max(0, r0 - rad), min(NR, r0 + rad + 1)):
        for c in range(max(0, c0 - rad), min(NC, c0 + rad + 1)):
            d = np.hypot(r - r0, c - c0) / R_CELL
            if d <= 1.0:
                pump_drain[r, c] = max(pump_drain[r, c], cap * (1.0 - d))

drain = np.minimum(0.60, manhole_drain + pump_drain)   # รวม, เพดาน 0.60 ม.
drain[channel] = 0.0    # ในร่องน้ำเองไม่หักความจุ (เป็นทางน้ำ)
drain_cm = np.clip(np.round(drain * 100), 0, 100).astype(int)

# ---------- บันทึกกลับเข้า dem_grid.json ----------
G["channel"] = [int(i) for i in np.flatnonzero(channel.flatten())]   # sparse index list
G["drain_cm"] = [int(x) for x in drain_cm.flatten()]                 # ต่อเซลล์ (ซม.)
G["drainage_meta"] = {
    "channel_cells": n_ch,
    "pump_stations": len(pp["features"]),
    "manholes": len(mh["features"]),
    "drain_max_cm": int(drain_cm.max()),
    "drain_mean_cm": round(float(drain_cm.mean()), 1),
    "note": "channel=ทางน้ำจริง(seed) · drain_cm=ความจุระบาย(สูบ+ฝาท่อ) หักความลึก → ท่วมตื้น/ลดก่อน",
}
json.dump(G, open(os.path.join(D, "dem_grid.json"), "w"), separators=(",", ":"))

print(f"กริด {NC}x{NR} · เซลล์ {N:,}")
print(f"  channel (ทางน้ำจริง) : {n_ch:,} เซลล์  ({100*n_ch/N:.1f}%)")
print(f"  ฝาท่อ {len(mh['features']):,} · สถานีสูบ {len(pp['features'])}")
print(f"  drain_cm: เฉลี่ย {drain_cm.mean():.1f} · สูงสุด {drain_cm.max()} ซม. · "
      f"เซลล์ที่มีระบาย {100*np.mean(drain_cm>0):.0f}%")
print("✅ เพิ่ม channel + drain_cm เข้า data/dem_grid.json")
