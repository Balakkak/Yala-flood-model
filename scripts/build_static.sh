#!/usr/bin/env bash
# ============================================================================
# build_static.sh — สร้างโฟลเดอร์ dist/ สำหรับ deploy เป็น static site
# ----------------------------------------------------------------------------
# เว็บนี้เป็น static multi-page (path สัมพัทธ์ + ไลบรารีจาก CDN + fetch ข้อมูลตอน
# รันไทม์) ไม่ได้ใช้การ bundle ของ Vite — Vite มีไว้แค่ dev server (proxy CORS)
# build = คัดลอกเฉพาะไฟล์ที่ต้องใช้ตอนรันจริงไปไว้ใน dist/
#
# Deploy: อัปโหลด dist/ ไปโฮสต์ static ใดก็ได้ (Netlify / Vercel / GitHub Pages /
#         nginx / S3) — ใช้ path สัมพัทธ์ จึงวางที่ root หรือ subpath ก็ได้
#
# หมายเหตุ: production ไม่มี dev proxy (/api-thaiwater-*) — ข้อมูลสดจะใช้เส้นทาง
#           direct → allorigins fallback ใน assets/live_status.js โดยอัตโนมัติ
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="dist"
rm -rf "$OUT"
mkdir -p "$OUT"

# 1) หน้าเว็บ (entry pages)
cp index.html dashboard.html city3d.html interventions.html login.html "$OUT"/

# 2) โค้ด/สไตล์ที่หน้าเว็บเรียกใช้
cp -R assets "$OUT"/

# 3) ชั้นข้อมูลที่ fetch ตอนรันไทม์ (เฉพาะไฟล์ flat ที่แอปเรียก — ข้ามโฟลเดอร์รูปภาพ
#    ต้นฉบับขนาดใหญ่ เช่น data/_น้ำท่วม/ ที่ไม่ได้ใช้ตอนรัน)
mkdir -p "$OUT/data"
cp data/*.geojson data/*.json data/*.tif "$OUT/data"/ 2>/dev/null || true

# terrain tiles (โหลดเป็น tile ตาม viewport — เบราว์เซอร์ดึงเฉพาะที่เห็น)
cp -R terrain "$OUT"/

# 4) เฟรมผลจำลอง LISFLOOD (เฉพาะที่ viewer เรียก — ไม่เอาโค้ดโมเดล)
if [ -d lisflood/frames ]; then
  mkdir -p "$OUT/lisflood"
  cp -R lisflood/frames "$OUT/lisflood"/
fi

echo "✓ Static build → $OUT/  ($(du -sh "$OUT" | cut -f1))"
echo "  เสิร์ฟทดสอบ: (cd $OUT && python3 -m http.server 8080) แล้วเปิด http://localhost:8080/"
