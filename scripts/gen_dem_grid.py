#!/usr/bin/env python3
"""
สร้างกริด DEM ละเอียด (30 ม.) เขตเมืองยะลา สำหรับโมเดลน้ำท่วม interactive + ผิวน้ำ 3D
output: data/dem_grid.json  { origin_lon, origin_lat, dlon, dlat, ncols, nrows, ground_m[] }
ground_m = ความสูงพื้นดิน (ม.) ราย-เซลล์ (row-major จากเหนือ)
"""
import os, json
import numpy as np
import tifffile

HERE   = os.path.dirname(os.path.abspath(__file__))
ROOT   = os.path.normpath(os.path.join(HERE, ".."))
DEMTIF = os.path.join(ROOT, "data", "output_fabdem.tif")

# --- อ่าน geotransform จาก tag ของ tif เอง → รองรับ DEM ความละเอียดใดก็ได้ (drop-in) ---
with tifffile.TiffFile(DEMTIF) as tf:
    page = tf.pages[0]
    dem = page.asarray().astype(np.float64)          # (NR,NC) row0=เหนือ
    tags = {t.code: t.value for t in page.tags}
PSX = PSY = 1.0 / 3600                                # default 30 ม.
LON0, LAT0 = 101.20, 6.70                             # default (FABDEM tile)
if 33550 in tags:                                    # ModelPixelScale (x,y,z)
    PSX, PSY = float(tags[33550][0]), float(tags[33550][1])
if 33922 in tags:                                    # ModelTiepoint (i,j,k, X,Y,Z)
    tp = tags[33922]; LON0, LAT0 = float(tp[3]), float(tp[4])
dem = np.where((dem > -500) & (dem < 9000), dem, 0.0)
NR, NC = dem.shape

# เขตเมือง (คงที่ ไม่ขึ้นกับ DEM) — crop ตาม bbox เมืองยะลา
W, E, S, N = 101.235, 101.330, 6.500, 6.600
c0 = max(0, int(round((W - LON0) / PSX))); c1 = min(NC, int(round((E - LON0) / PSX)))
r0 = max(0, int(round((LAT0 - N) / PSY))); r1 = min(NR, int(round((LAT0 - S) / PSY)))
sub = dem[r0:r1, c0:c1]
nr, nc = sub.shape

out = {
    "origin_lon": LON0 + c0 * PSX,       # ขอบตะวันตก
    "origin_lat": LAT0 - r0 * PSY,       # ขอบเหนือ
    "dlon": PSX, "dlat": PSY,
    "ncols": nc, "nrows": nr,
    "ground_m": [round(float(x), 1) for x in sub.flatten()],
}
path = os.path.join(ROOT, "data", "dem_grid.json")
with open(path, "w") as f:
    json.dump(out, f, separators=(",", ":"))
v = sub.flatten()
res_m = round(PSY * 111000)
print(f"✅ dem_grid.json: {nc}×{nr} (~{res_m} ม./เซลล์) · elev {v.min():.0f}–{v.max():.0f} ม. "
      f"· {os.path.getsize(path)/1e6:.1f} MB")
