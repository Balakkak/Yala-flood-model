#!/bin/bash
# ลำดับ 3 — เสียบ DEM ใหม่ (เช่น GISTDA 5 ม. / LiDAR) เข้าระบบด้วยคำสั่งเดียว
# ใช้:  bash scripts/rebuild_from_dem.sh [data/dem_highres.tif]
#   - ใส่ path = ใช้ DEM ใหม่ (GeoTIFF, EPSG:4326 หรือมี geotag) แทนของเดิม
#   - ไม่ใส่   = rebuild จาก DEM ปัจจุบัน
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
NEW="${1:-}"

if [ -n "$NEW" ]; then
  [ -f "$NEW" ] || { echo "ไม่พบไฟล์: $NEW"; exit 1; }
  echo "→ สำรอง DEM เดิม → data/output_prev.tif"
  cp -f data/output_AW3D30.tif data/output_prev.tif 2>/dev/null || true
  echo "→ ใช้ DEM ใหม่: $NEW"
  cp -f "$NEW" data/output_AW3D30.tif
fi

echo "1/4  สร้างกริด DEM (อ่าน geotransform เอง รองรับทุกความละเอียด)..."
python3 scripts/gen_dem_grid.py
echo "2/4  ฝังทางน้ำ/สถานีสูบ/ฝาท่อ (channel + drain)..."
python3 scripts/build_drainage_grid.py
echo "3/4  คำนวณเส้นโค้งตอบสนอง + เกณฑ์เริ่มท่วม..."
python3 scripts/flood_response.py
echo "4/4  วัดความแม่นเทียบดาวเทียม GISTDA (CSI ก่อน/หลัง)..."
python3 scripts/validate_drainage.py

echo ""
echo "✅ เสร็จ — ทั้ง 2D และ 3D ใช้ DEM ใหม่ทันที (รีเฟรชเว็บ)"
echo "   (ถ้าต้องการพื้นผิว 3D ใหม่ด้วย: python3 scripts/gen_terrain_tiles.py — ช้า ~2–3 นาที)"
