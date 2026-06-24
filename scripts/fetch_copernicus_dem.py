#!/usr/bin/env python3
"""
ดาวน์โหลด Copernicus GLO-30 DEM (คุณภาพดีกว่า AW3D30 เล็กน้อย) ของเขตยะลา
แล้ว crop เป็นกริดเดียวกับ output_fabdem.tif → ใช้แทนได้ใน pipeline เดิม (terrain/dem_grid)

ต้องมี rasterio:  pip install rasterio
(tifffile อ่าน COG ของ Copernicus ไม่ได้ — ต้องใช้ GDAL/rasterio)

หมายเหตุ: นี่ยังเป็น 30 ม. (DSM) — ดีขึ้นเล็กน้อยเท่านั้น
ตัวเปลี่ยนเกมจริงคือ LiDAR DTM 1–2 ม. (ดู docs/PHASE1_DATA.md)
วิธีอัปเกรดเป็น LiDAR: วางไฟล์ DEM ละเอียดแทน output_fabdem.tif แล้วรัน gen_terrain_tiles.py + gen_dem_grid.py ใหม่
"""
import os, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
TILE_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/"
            "Copernicus_DSM_COG_10_N06_00_E101_00_DEM/"
            "Copernicus_DSM_COG_10_N06_00_E101_00_DEM.tif")
RAW = os.path.join(ROOT, "raw", "copernicus_N06E101.tif")
OUT = os.path.join(ROOT, "data", "output_copernicus_yala.tif")
BBOX = (101.20, 6.40, 101.40, 6.70)   # W,S,E,N (ตรงกับ DEM ปัจจุบัน)

def download():
    if os.path.exists(RAW) and os.path.getsize(RAW) > 37_000_000:
        print("มีไฟล์ tile แล้ว"); return
    print("... ดาวน์โหลด Copernicus GLO-30 tile (~37MB)")
    urllib.request.urlretrieve(TILE_URL, RAW)
    print("   เสร็จ:", os.path.getsize(RAW), "bytes")

def crop():
    import rasterio
    from rasterio.windows import from_bounds
    with rasterio.open(RAW) as src:
        win = from_bounds(*BBOX, transform=src.transform)
        data = src.read(1, window=win)
        prof = src.profile.copy()
        prof.update(height=data.shape[0], width=data.shape[1],
                    transform=src.window_transform(win), driver="GTiff", compress="deflate")
        with rasterio.open(OUT, "w", **prof) as dst:
            dst.write(data, 1)
    print(f"✅ crop -> {OUT}  ({data.shape[1]}×{data.shape[0]} @ 30 ม.)")
    print("   ถัดไป: เปลี่ยนชื่อเป็น output_fabdem.tif (สำรองเดิมไว้) แล้วรัน")
    print("          python3 scripts/gen_terrain_tiles.py && python3 scripts/gen_dem_grid.py")

if __name__ == "__main__":
    download()
    try:
        crop()
    except ImportError:
        print("⚠️ ยังไม่มี rasterio — ติดตั้งก่อน:  pip install rasterio")
