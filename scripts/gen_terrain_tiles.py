#!/usr/bin/env python3
"""
สร้าง terrain-RGB tiles (terrarium encoding) จาก DEM AW3D30 สำหรับ MapLibre setTerrain
→ พื้นแต่ละพื้นที่มีความสูงจริง + ถนน/ตึกแปะตามภูมิประเทศ
output: terrain/{z}/{x}/{y}.png  (zoom 12–16, เฉพาะเขตเมืองยะลา)
"""
import os, math
import numpy as np
import tifffile
from PIL import Image

HERE   = os.path.dirname(os.path.abspath(__file__))
ROOT   = os.path.normpath(os.path.join(HERE, ".."))
DEMTIF = os.path.join(ROOT, "data", "output_AW3D30.tif")
OUT    = os.path.join(ROOT, "terrain")

dem = tifffile.imread(DEMTIF).astype(np.float64)     # (NR,NC) row0=เหนือ
dem = np.where((dem > -500) & (dem < 9000), dem, 0.0)
NR, NC = dem.shape
LON0, LAT0, PX = 101.20, 6.70, 1.0/3600              # มุมบน-ซ้าย, องศา/พิกเซล
BBOX = dict(W=101.20, E=101.40, S=6.40, N=6.70)
ZMIN, ZMAX, TS = 12, 16, 256

def sample_bilinear(lon, lat):
    fc = (lon - LON0) / PX - 0.5
    fr = (LAT0 - lat) / PX - 0.5
    c0 = np.clip(np.floor(fc).astype(int), 0, NC - 1); c1 = np.clip(c0 + 1, 0, NC - 1)
    r0 = np.clip(np.floor(fr).astype(int), 0, NR - 1); r1 = np.clip(r0 + 1, 0, NR - 1)
    tc = np.clip(fc - c0, 0, 1); tr = np.clip(fr - r0, 0, 1)
    top = dem[r0, c0] * (1 - tc) + dem[r0, c1] * tc
    bot = dem[r1, c0] * (1 - tc) + dem[r1, c1] * tc
    return top * (1 - tr) + bot * tr

def deg2num(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lr = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lr)) / math.pi) / 2.0 * n)
    return x, y

def tile_lonlat(x, y, z):
    n = 2 ** z
    px = (np.arange(TS) + 0.5)
    lon = (x + px / TS) / n * 360.0 - 180.0
    yy = (y + px / TS) / n
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * yy))))
    return np.meshgrid(lon, lat)   # (TS,TS) each

count = 0
for z in range(ZMIN, ZMAX + 1):
    x0, y0 = deg2num(BBOX["N"], BBOX["W"], z)
    x1, y1 = deg2num(BBOX["S"], BBOX["E"], z)
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            lon, lat = tile_lonlat(x, y, z)
            e = sample_bilinear(lon, lat)
            v = np.clip(e + 32768.0, 0, 65535.999)
            R = np.floor(v / 256.0).astype(np.uint8)
            G = np.floor(v % 256.0).astype(np.uint8)
            B = np.floor((v - np.floor(v)) * 256.0).astype(np.uint8)
            img = np.dstack([R, G, B])
            d = os.path.join(OUT, str(z), str(x)); os.makedirs(d, exist_ok=True)
            Image.fromarray(img, "RGB").save(os.path.join(d, f"{y}.png"))
            count += 1
    print(f"  z{z}: tiles เสร็จ")
print(f"✅ terrain tiles: {count} ไฟล์ -> {OUT}")
