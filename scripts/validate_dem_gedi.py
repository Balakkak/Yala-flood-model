#!/usr/bin/env python3
"""
(ข) ตรวจสอบความแม่นแนวดิ่งของ FABDEM ด้วย GEDI (LiDAR จากอวกาศ)
----------------------------------------------------------------
GEDI L2A ให้ความสูงพื้นดิน (elev_lowestmode) จาก LiDAR จริง → เอามาเทียบ FABDEM
รายงาน RMSE / bias ของ FABDEM ที่จุด GEDI เหนือยะลา

ต้องมี:  pip install earthaccess
และ login NASA Earthdata ฟรี (สมัครที่ urs.earthdata.nasa.gov) — รันครั้งแรกจะถาม user/pass
(หมายเหตุ: ICESat-2 ผ่านยะลาน้อย; GEDI ครอบคลุมหนาแน่นกว่า เหมาะกว่า)
"""
import os, numpy as np, tifffile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BBOX = (101.20, 6.40, 101.40, 6.70)   # W,S,E,N

def load_fabdem():
    a = tifffile.imread(os.path.join(ROOT, "raw", "fabdem_N06E101.tif")).astype(np.float64)
    LON0, LAT0, PX = 101.0, 7.0, 1/3600
    def sample(lon, lat):
        c = int((lon - LON0) / PX); r = int((LAT0 - lat) / PX)
        if 0 <= r < a.shape[0] and 0 <= c < a.shape[1]: return a[r, c]
        return np.nan
    return sample

def main():
    import earthaccess
    earthaccess.login()   # ครั้งแรกถาม Earthdata user/pass (สมัครฟรี)
    print("... ค้น GEDI L2A เหนือยะลา")
    res = earthaccess.search_data(short_name="GEDI02_A", version="002",
                                  bounding_box=BBOX, count=20)
    if not res: print("ไม่พบ granule"); return
    files = earthaccess.download(res[:3], os.path.join(ROOT, "raw", "gedi"))
    samp = load_fabdem()
    import h5py
    diffs = []
    for fp in files:
        try:
            with h5py.File(fp, "r") as f:
                for beam in [k for k in f.keys() if k.startswith("BEAM")]:
                    g = f[beam]
                    lat = g["lat_lowestmode"][:]; lon = g["lon_lowestmode"][:]
                    elev = g["elev_lowestmode"][:]; q = g["quality_flag"][:]
                    m = (q == 1) & (lon >= BBOX[0]) & (lon <= BBOX[2]) & (lat >= BBOX[1]) & (lat <= BBOX[3])
                    for lo, la, e in zip(lon[m], lat[m], elev[m]):
                        fe = samp(lo, la)
                        if np.isfinite(fe) and -50 < e < 1000: diffs.append(e - fe)
        except Exception as ex:
            print("  อ่านไฟล์พลาด:", ex)
    if diffs:
        d = np.array(diffs)
        print(f"\n✅ จุด GEDI ที่เทียบได้: {len(d)}")
        print(f"   FABDEM bias (GEDI−FABDEM): {d.mean():+.2f} ม.")
        print(f"   RMSE: {np.sqrt((d**2).mean()):.2f} ม.  ·  |error|<2ม.: {100*np.mean(np.abs(d)<2):.0f}%")
    else:
        print("ไม่มีจุดคุณภาพดีในกรอบ")

if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print("ติดตั้งก่อน:  pip install earthaccess h5py")
