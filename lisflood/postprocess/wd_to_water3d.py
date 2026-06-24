#!/usr/bin/env python3
"""
wd_to_water3d.py — สร้างข้อมูล "น้ำ 3D" รายเฟรมจากผล LISFLOOD-FP
-----------------------------------------------------------------
แทนที่จะ drape ภาพแบน ๆ → ส่งความลึกน้ำรายจุด (กริด) ให้หน้า 3D extrude
เป็นปริมาตรน้ำที่สูงตามความลึกจริง → เห็นน้ำค่อย ๆ ท่วมโคนตึก

ครอบเฉพาะเขตเมือง (ที่มี footprint ตึก) + downsample เพื่อให้เบา
บันทึก lisflood/frames/water3d.json
"""
import os, re, json, glob
import numpy as np

HERE    = os.path.dirname(os.path.abspath(__file__))
INPUTS  = os.path.normpath(os.path.join(HERE, "..", "inputs"))
RESULTS = os.path.join(INPUTS, "results")
FRAMES  = os.path.normpath(os.path.join(HERE, "..", "frames"))

# เขตเมือง (ตรงกับ bbox ที่ดึง footprint ตึก) + ระดับ downsample
CITY = dict(W=101.235, E=101.330, S=6.500, N=6.600)
FACTOR     = 3       # 3×30.8 ≈ 92 ม./เซลล์น้ำ
THRESH_CM  = 5       # ตื้นกว่านี้ถือว่าแห้ง
CAP_CM     = 600     # cap ความลึก (กัน outlier)

with open(os.path.join(INPUTS, "bbox.json")) as f:
    meta = json.load(f)
lon_min, lon_max = meta["lon_min"], meta["lon_max"]
lat_min, lat_max = meta["lat_min"], meta["lat_max"]
NC, NR = meta["ncols"], meta["nrows"]
px_lon = (lon_max - lon_min) / NC
px_lat = (lat_max - lat_min) / NR     # องศา/แถว (จากเหนือ→ใต้)

# ช่วง index ของ crop เขตเมือง (row นับจากเหนือ)
c0 = max(0, int((CITY["W"] - lon_min) / px_lon)); c1 = min(NC, int((CITY["E"] - lon_min) / px_lon))
r0 = max(0, int((lat_max - CITY["N"]) / px_lat)); r1 = min(NR, int((lat_max - CITY["S"]) / px_lat))
# ปัดให้หารด้วย FACTOR ลงตัว
c1 -= (c1 - c0) % FACTOR; r1 -= (r1 - r0) % FACTOR

def read_asc(path):
    hdr = {}
    with open(path) as f:
        for _ in range(6):
            k, v = f.readline().split(); hdr[k.lower()] = float(v)
        return np.loadtxt(f), hdr

def block_max(a, f):
    h, w = a.shape
    return a.reshape(h // f, f, w // f, f).max(axis=(1, 3))

wd_files = sorted(glob.glob(os.path.join(RESULTS, "*.wd")),
                  key=lambda p: int((re.findall(r"(\d+)", os.path.basename(p)) or [0])[-1]))
if not wd_files:
    raise SystemExit("ไม่พบ .wd — รัน LISFLOOD-FP ก่อน")

frames = []
for wf in wd_files:
    depth, hdr = read_asc(wf)
    nod = hdr.get("nodata_value", -9999.0)
    sub = depth[r0:r1, c0:c1]
    sub = np.where((sub == nod) | ~np.isfinite(sub), 0.0, sub)
    ds = block_max(sub, FACTOR)
    cm = np.clip(np.round(ds * 100), 0, CAP_CM).astype(int)
    cm[cm < THRESH_CM] = 0
    frames.append(cm.flatten().tolist())

# ความสูงพื้นดินจริง (DEM) ราย-เซลล์ → ให้ผิวน้ำ = ดิน + ความลึก (สมจริงตามภูมิประเทศ)
import tifffile
DEMTIF = os.path.normpath(os.path.join(HERE, "..", "..", "data", "output_fabdem.tif"))
dem = tifffile.imread(DEMTIF).astype(np.float64)        # (NR,NC) row0=เหนือ ตรงกับกริด .wd
dem = np.where((dem > -500) & (dem < 9000), dem, 0.0)
ground_ds = block_max(dem[r0:r1, c0:c1].copy(), FACTOR) # ใช้ max ให้เข้ากับ depth (กันน้ำโผล่ใต้ดิน)
ground_m = np.round(ground_ds, 1).flatten().tolist()

nrows_ds = (r1 - r0) // FACTOR
ncols_ds = (c1 - c0) // FACTOR
out = {
    "origin_lon": lon_min + c0 * px_lon,     # ขอบตะวันตกของ crop
    "origin_lat": lat_max - r0 * px_lat,     # ขอบเหนือของ crop
    "dlon": px_lon * FACTOR,
    "dlat": px_lat * FACTOR,                 # บวก; ใต้ = origin_lat - r*dlat
    "ncols": ncols_ds, "nrows": nrows_ds,
    "n_frames": len(frames),
    "saveint_s": meta["saveint_s"],
    "thresh_cm": THRESH_CM,
    "ground_m": ground_m,                    # ความสูงพื้นดิน (ม.) ราย-เซลล์ (static)
    "depths_cm": frames,                     # [frame][row*ncols + col] (row จากเหนือ)
}
path = os.path.join(FRAMES, "water3d.json")
with open(path, "w") as f:
    json.dump(out, f, separators=(",", ":"))
sz = os.path.getsize(path) / 1e6
wetmax = max(sum(1 for v in fr if v) for fr in frames)
print(f"✅ water3d.json: กริด {ncols_ds}×{nrows_ds} ({FACTOR*30.8:.0f} ม./เซลล์) "
      f"× {len(frames)} เฟรม · wet สูงสุด {wetmax} เซลล์/เฟรม · {sz:.1f} MB")
