# ระบบ GIS บริหารจัดการและจำลองน้ำท่วม — เทศบาลนครยะลา

แดชบอร์ดแผนที่เชิงโต้ตอบสำหรับวิเคราะห์พื้นที่เสี่ยงน้ำท่วมซ้ำซากของเมืองยะลา
วิเคราะห์จาก **DEM จริง** ว่าบริเวณไหนจะท่วมก่อน-หลัง น้ำมาจากทิศใด และท่วมลึกแค่ไหนในแต่ละช่วงเวลา

## เริ่มใช้งาน (dev)
```bash
npm install          # ครั้งแรกครั้งเดียว
npm run dev          # หรือ ./scripts/START_SERVER.sh
```
เปิด **http://localhost:5173/** (Vite เสิร์ฟ `index.html` ที่รากให้อัตโนมัติ)

> ต้องเปิดผ่าน dev server เท่านั้น — เปิดไฟล์ตรง ๆ (`file://`) จะโหลด DEM/GeoJSON ไม่ได้ เพราะ `fetch()` ถูกบล็อก

## Build & Deploy (production)
เว็บนี้เป็น **static multi-page** (path สัมพัทธ์ + ไลบรารีจาก CDN + fetch ข้อมูลตอนรันไทม์)
Vite ใช้แค่เป็น dev server (proxy CORS) — ตอน deploy ไม่ต้อง bundle
```bash
npm run build        # → สร้างโฟลเดอร์ dist/ (คัดเฉพาะไฟล์ที่ใช้ตอนรัน)
npm run preview      # ทดสอบ dist/ ที่ http://localhost:8080/
```
อัปโหลด `dist/` ไปโฮสต์ static ใดก็ได้ (Netlify / Vercel / GitHub Pages / nginx / S3)
ใช้ path สัมพัทธ์ จึงวางที่ root หรือ subpath ก็ได้

> **ข้อมูลสด (เขื่อน/ฝน) บน production:** ไม่มี dev proxy (`/api-thaiwater-*`) แล้ว
> `assets/live_status.js` จะไล่ลำดับ direct → vite proxy → `allorigins` ให้อัตโนมัติ
> (ThaiWater API รองรับ CORS โดยตรง จึงทำงานได้บน static host) — ถ้าต่อ API ไม่ได้
> จะ fallback ไปใช้ค่าที่ **แคชไว้** (last-known-good) แทน
>
> ไลบรารี CDN ปักเวอร์ชันแล้วทั้งหมด (leaflet 1.9.4 · maplibre 4.7.1 · tabler-icons 3.44.0)
> เพื่อกันหน้าพังเวลา CDN ออกเวอร์ชันใหม่

## โครงสร้างโปรเจกต์
```
index.html                     หน้าหลัก — มุมมอง 3D เมืองยะลา (MapLibre) + จำลองน้ำท่วม
dashboard.html                 มุมมองแผนที่ 2D (Leaflet) + แผงควบคุมการจำลอง
city3d.html                    ฉาก 3D ที่ถูกฝัง (iframe) ในหน้า dashboard
assets/
  styles.css                   สไตล์ทั้งหมดของแดชบอร์ด
  flood_analysis.js            ตัววิเคราะห์การแพร่น้ำท่วม (Priority-Flood บน DEM จริง)
  lisflood_viewer.js           ตัวแสดงผลเฟรมน้ำท่วมจากโมเดล LISFLOOD
  live_status.js               ดึงข้อมูลสด (เขื่อน/ฝน) + แคช last-known-good + ป้ายสถานะ header
  geotiff.min.js               ไลบรารีอ่าน GeoTIFF (vendored — เลี่ยงปัญหา CDN)
data/                          ชั้นข้อมูลที่แดชบอร์ดเรียกใช้
  output_fabdem.tif            DEM (FABDEM V1-2, 30 ม., bare-earth · ตรวจ ICESat-2 ±5.45 ม.)
  yala_boundary.geojson        ขอบเขตเมือง (ใช้ทำ mask + คิดสถิติ)
  yala_waterways_osm.geojson   ทางน้ำจริงจาก OpenStreetMap (สร้างด้วย scripts/fetch_osm_waterways.py)
  yala_eastern_inflow.geojson  ต้นน้ำฝั่งตะวันออก (สะเตงนอก/บึงแบเมาะ — โดยประมาณ รอข้อมูลคลองจริง)
  yala_elevation_zones.geojson พื้นที่เสี่ยง สูง/ต่ำ
  yala_stations.geojson        สถานีสูบน้ำ / จุดตรวจวัด
  yala_district_mueang.geojson  อำเภอเมืองยะลา (ลุ่มน้ำที่ไหลเข้าเมือง)
  yala_tambons.geojson          14 ตำบลในอำเภอเมืองยะลา
  yala_landuse_osm.geojson      land use จาก OSM (pervious/impervious)
  yala_flood_recurrence.geojson พื้นที่เสี่ยงน้ำท่วมจริงรายตำบล (สร้างจาก scripts/build_flood_recurrence.py
                                — ชั้น validation เทียบผลโมเดลกับน้ำท่วม GISTDA จริง)
  (และชั้นข้อมูล geojson/json อื่น ๆ ของยะลา)
scripts/                       สคริปต์เตรียมข้อมูล (Python) + START_SERVER.sh
lisflood/                      โมเดล LISFLOOD (inputs, src, run.sh) + เฟรมผลลัพธ์
terrain/                       terrain tiles สำหรับมุมมอง 3D
docs/                          เอกสารโปรเจกต์ + data_checklist_yala.xlsx (เช็กลิสต์แหล่งข้อมูล)
raw/                           ข้อมูลดิบ/ตัวกลางขนาดใหญ่ (zip, tar.gz, overpass)
```

## วิธีวิเคราะห์ (สรุป)
**Priority-Flood (minimax connectivity)** — จำลองระดับน้ำที่ค่อย ๆ ยกตัวจากแม่น้ำปัตตานี
แล้วคำนวณว่าทุกเซลล์ของ DEM เชื่อมต่อกับมวลน้ำที่ระดับเท่าไร (arrival level)
→ ได้ลำดับท่วมก่อน-หลัง, ทิศทางการไหล (D8), และความลึกรายช่วงเวลา

**ข้อจำกัด:** เป็นระดับ *screening* บน DEM 30 ม. — ยังไม่ใช่ hydrodynamic จริง
(ไม่มีอัตราการไหล/ฝน/ท่อระบายเป็นฟังก์ชันของเวลาจริง) เป็นขั้น "เดินได้ก่อน"
ก่อนต่อยอดเป็น **HEC-RAS 2D + EPA SWMM** เมื่อได้ DEM/LiDAR ละเอียดและข้อมูลท่อจากเทศบาล

📄 **รายละเอียดเต็ม + พารามิเตอร์ + ผลตรวจสอบความถูกต้อง:** ดู [docs/METHODOLOGY.md](docs/METHODOLOGY.md)

## การทดสอบ
```bash
npm test     # ตรวจความครบของ data/asset + รัน validation (ROC-AUC/POD/FAR/CSI) — ไม่ต้องลง dependency
```

## พิกัดมาตรฐาน
WGS84 / UTM Zone 47N — **EPSG:32647** (ใช้กับทุกชั้นข้อมูลและการคำนวณระยะ/พื้นที่)
