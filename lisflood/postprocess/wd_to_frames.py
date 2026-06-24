#!/usr/bin/env python3
"""
wd_to_frames.py — แปลงผล LISFLOOD-FP (.wd water-depth grids) เป็นเฟรม PNG + manifest
-----------------------------------------------------------------------------------
อ่าน  lisflood/inputs/results/yala-*.wd  (Esri ASCII, ความลึกน้ำเป็นเมตร ราย-เวลา)
เขียน lisflood/frames/frame_NNN.png  (โปร่งใสที่แห้ง, ไล่สีน้ำตื้น→ลึก)
      lisflood/frames/manifest.json   (รายการเฟรม + bbox + เวลา + สถิติ)

ใช้สี/threshold ให้เข้ากับแดชบอร์ดเดิม (ตื้น = ฟ้าอ่อน, ลึก = น้ำเงินเข้ม)
"""
import os, re, json, glob
import numpy as np
from PIL import Image

HERE      = os.path.dirname(os.path.abspath(__file__))
INPUTS    = os.path.normpath(os.path.join(HERE, "..", "inputs"))
RESULTS   = os.path.join(INPUTS, "results")
FRAMES    = os.path.normpath(os.path.join(HERE, "..", "frames"))
os.makedirs(FRAMES, exist_ok=True)

DRY_THRESH = 0.05    # ม. : ตื้นกว่านี้ถือว่าแห้ง (โปร่งใส)
DEEP_CAP   = 2.0     # ม. : ความลึกที่ให้สีเข้มสุด

with open(os.path.join(INPUTS, "bbox.json")) as f:
    meta = json.load(f)

def read_asc(path):
    """อ่าน Esri ASCII grid -> (numpy array, header dict)"""
    hdr = {}
    with open(path) as f:
        for _ in range(6):
            k, v = f.readline().split()
            hdr[k.lower()] = float(v)
        data = np.loadtxt(f)
    return data, hdr

# ไล่สีความลึก -> RGBA (โปร่งใสเมื่อแห้ง)
def colorize(depth, nodata):
    h, w = depth.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    wet = (depth > DRY_THRESH) & (depth != nodata) & np.isfinite(depth)
    norm = np.clip(depth / DEEP_CAP, 0, 1)
    # ตื้น (179,229,252) ฟ้าอ่อน -> ลึก (3,52,110) น้ำเงินเข้ม
    r = (179 + (3   - 179) * norm)
    g = (229 + (52  - 229) * norm)
    b = (252 + (110 - 252) * norm)
    rgba[..., 0] = np.where(wet, r, 0)
    rgba[..., 1] = np.where(wet, g, 0)
    rgba[..., 2] = np.where(wet, b, 0)
    rgba[..., 3] = np.where(wet, (150 + 105 * norm).astype(np.uint8), 0)
    return rgba

wd_files = sorted(glob.glob(os.path.join(RESULTS, "*.wd")),
                  key=lambda p: int(re.findall(r"(\d+)", os.path.basename(p))[-1])
                  if re.findall(r"(\d+)", os.path.basename(p)) else 0)
if not wd_files:
    raise SystemExit(f"ไม่พบไฟล์ .wd ใน {RESULTS} — รัน LISFLOOD-FP ก่อน")

saveint = meta["saveint_s"]
total_valid = None
frames = []
for idx, wf in enumerate(wd_files):
    depth, hdr = read_asc(wf)
    nod = hdr.get("nodata_value", -9999.0)
    if total_valid is None:
        total_valid = int(np.sum((depth != nod)))  # โดเมนทั้งหมด (ทุก .wd มีขนาดเท่ากัน)
    wet_mask = (depth > DRY_THRESH) & (depth != nod) & np.isfinite(depth)
    wet_vals = depth[wet_mask]
    png = f"frame_{idx:03d}.png"
    Image.fromarray(colorize(depth, nod), "RGBA").save(os.path.join(FRAMES, png))
    frames.append({
        "file": png,
        "t_seconds": idx * saveint,
        "t_hours": round(idx * saveint / 3600.0, 2),
        "flooded_pct": round(100.0 * wet_mask.sum() / max(total_valid, 1), 2),
        # P95 = ความลึกตัวแทนที่เชื่อได้ (กันหลุมเดี่ยว ๆ ดันค่า max ให้เพี้ยน)
        "depth_p95": round(float(np.percentile(wet_vals, 95)) if wet_vals.size else 0.0, 2),
        "max_depth": round(float(wet_vals.max()) if wet_vals.size else 0.0, 2),
        "mean_depth": round(float(wet_vals.mean()) if wet_vals.size else 0.0, 2),
    })
    print(f"  {png}  t={frames[-1]['t_hours']:>4} ชม.  "
          f"ท่วม {frames[-1]['flooded_pct']:>5}%  ลึก P95 {frames[-1]['depth_p95']} ม.")

manifest = {
    "bbox": {"lat_min": meta["lat_min"], "lat_max": meta["lat_max"],
             "lon_min": meta["lon_min"], "lon_max": meta["lon_max"]},
    "model": "LISFLOOD-FP 8.1 (acceleration, rain-on-grid)",
    "dry_thresh_m": DRY_THRESH,
    "n_frames": len(frames),
    "frames": frames,
}
with open(os.path.join(FRAMES, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print(f"✅ {len(frames)} เฟรม + manifest.json -> {FRAMES}")
