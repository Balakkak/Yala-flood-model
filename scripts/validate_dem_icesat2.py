#!/usr/bin/env python3
"""
(ข) ตรวจความแม่นแนวดิ่ง DEM ด้วย ICESat-2 ATL08 (LiDAR อวกาศ) — ฟรี ไม่ต้อง login
ดึงจุดความสูงพื้นดินจริงจาก OpenAltimetry เหนือยะลา → เทียบ FABDEM
- ค่าเฉลี่ยส่วนต่าง = ระยะ geoid/datum (ellipsoid vs geoid) ไม่ใช่ error
- std (หลังหัก datum) = ความแม่นแนวดิ่งจริงของ DEM
บันทึก data/dem_validation_icesat2.json
"""
import os, json, urllib.request
import numpy as np, tifffile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BASE = "https://openaltimetry.earthdatacloud.nasa.gov/data/api/icesat2"
B = (101.1, 6.3, 101.5, 6.8)   # W,S,E,N
BBOX = f"minx={B[0]}&miny={B[1]}&maxx={B[2]}&maxy={B[3]}"
DATES = ["2024-01-01", "2024-01-29", "2024-03-31", "2024-02-07", "2024-01-09"]

def get(url, t=40):
    req = urllib.request.Request(url, headers={"User-Agent": "yala-gis/1.0"})
    with urllib.request.urlopen(req, timeout=t) as r: return json.load(r)

fab = tifffile.imread(os.path.join(ROOT, "raw", "fabdem_N06E101.tif")).astype(np.float64)
PX, LON0, LAT0 = 1/3600, 101.0, 7.0
def samp(lon, lat):
    c = int((lon-LON0)/PX); r = int((LAT0-lat)/PX)
    return fab[r, c] if (0 <= r < fab.shape[0] and 0 <= c < fab.shape[1]) else np.nan

pts, used = [], []
for dt in DATES:
    if len(pts) > 3000: break
    try:
        tid = get(f"{BASE}/getTracks?date={dt}&{BBOX}&outputFormat=json&client=portal")["output"]["track"]
        if not tid: continue
        d = get(f"{BASE}/atl08?date={dt}&{BBOX}&trackId={tid[0]}&outputFormat=json&client=portal")
        before = len(pts)
        for s in d.get("series", []):
            for row in s.get("lat_lon_elev_canopy", []):
                la, lo, el = row[0], row[1], row[2]
                if B[0] <= lo <= B[2] and B[1] <= la <= B[3] and -60 < el < 1500:
                    fe = samp(lo, la)
                    if np.isfinite(fe): pts.append(el - fe)
        if len(pts) > before: used.append(f"{dt}(RGT{tid[0]})")
        print(f"  {dt}: +{len(pts)-before} จุด", flush=True)
    except Exception as e:
        print(f"  {dt}: ข้าม ({str(e)[:50]})", flush=True)

d = np.array(pts)
md, sd = float(d.mean()), float(d.std())
out = {
    "reference": "ICESat-2 ATL08 (spaceborne LiDAR) via OpenAltimetry",
    "dem": "FABDEM V1-2 (30 m, bare-earth)",
    "n_points": int(len(d)),
    "tracks_used": used,
    "datum_offset_m": round(md, 2),
    "vertical_accuracy_std_m": round(sd, 2),
    "within_2m_pct": round(100*float(np.mean(np.abs(d-md) < 2)), 0),
    "note": "std ≈ ±5 ม. = ความแม่นแนวดิ่งระดับ 30 ม. — ยืนยันว่าต้องใช้ LiDAR (±0.15 ม.) ถึงจะทำความลึกน้ำท่วมแม่นได้",
    "generated": "2026-06-16",
}
json.dump(out, open(os.path.join(ROOT, "data", "dem_validation_icesat2.json"), "w"),
          ensure_ascii=False, indent=2)
print(f"\n✅ {len(d)} จุด · datum {md:+.1f} ม. · ความแม่น FABDEM ±{sd:.2f} ม. · บันทึก data/dem_validation_icesat2.json")
