# ระบบ GIS บริหารจัดการและจำลองน้ำท่วม — เทศบาลนครยะลา

แดชบอร์ดแผนที่เชิงโต้ตอบสำหรับเมืองยะลา ทำ **2 อย่างหลัก**:

1. **จำลองน้ำท่วม** — วิเคราะห์จาก **DEM จริง** ว่าบริเวณไหนจะท่วมก่อน-หลัง น้ำมาจากทิศใด
   และท่วมลึกแค่ไหน เมื่อปรับ ฝน / ระดับแม่น้ำปัตตานี / ระดับเขื่อนบางลาง
2. **วางแผนแก้โครงสร้าง** — เสนอ *ตำแหน่ง* มาตรการลดน้ำท่วม (คันกั้นริมแม่น้ำ · แก้มลิง ·
   ท่อ/สถานีสูบ · ประตูระบาย) พร้อมจำลอง **ก่อน-หลังสร้าง** และเช็กตามหลักวิศวกรรม/กฎหมาย

> เป็นเครื่องมือระดับ **screening (คัดกรองเบื้องต้น)** — ใช้เลือกจุด/เทียบมาตรการได้
> ยังไม่ใช่แบบจำลอง hydrodynamic ที่ออกแบบขนาดจริง (ดู [ข้อจำกัด](#ข้อจำกัด--roadmap))

## เริ่มใช้งาน (dev)
```bash
npm install          # ครั้งแรกครั้งเดียว
npm run dev          # หรือ ./scripts/START_SERVER.sh
```
เปิด **http://localhost:5173/** (Vite เสิร์ฟ `index.html` ที่รากให้อัตโนมัติ) — เข้าผ่านหน้า `login.html` ก่อน

> ต้องเปิดผ่าน dev server เท่านั้น — เปิดไฟล์ตรง ๆ (`file://`) จะโหลด DEM/GeoJSON ไม่ได้ เพราะ `fetch()` ถูกบล็อก

## Build & Deploy (production)
เว็บนี้เป็น **static multi-page** (path สัมพัทธ์ + ไลบรารีจาก CDN + fetch ข้อมูลตอนรันไทม์)
Vite ใช้แค่เป็น dev server (proxy CORS) — ตอน deploy ไม่ต้อง bundle
```bash
npm run build        # → bash scripts/build_static.sh สร้างโฟลเดอร์ dist/ (คัดเฉพาะไฟล์ที่ใช้ตอนรัน)
npm run preview      # เสิร์ฟ dist/ ที่ http://localhost:8080/
```
อัปโหลด `dist/` ไปโฮสต์ static ใดก็ได้ (Netlify / Vercel / GitHub Pages / nginx / S3) — ใช้ path สัมพัทธ์ วางที่ root หรือ subpath ก็ได้

> **ข้อมูลสด (เขื่อน/ฝน) บน production:** `assets/live_status.js` ไล่ลำดับ direct → vite proxy → `allorigins`
> ให้อัตโนมัติ (ThaiWater API รองรับ CORS โดยตรง) — ถ้าต่อ API ไม่ได้ จะ fallback ไปใช้ค่าที่ **แคชไว้** (last-known-good)
>
> ไลบรารี CDN ปักเวอร์ชันแล้วทั้งหมด (leaflet 1.9.4 · maplibre 4.7.1 · tabler-icons 3.44.0) กันหน้าพังเวลา CDN ออกเวอร์ชันใหม่

## หน้าเว็บ & การนำทาง
แบ่งเป็น **2 หน้าต่างหลัก** เลือกบนแถบบน · การเลือก **2D/3D อยู่บนแผนที่** (ที่เดียว ไม่ซ้ำซ้อน):

| หน้าต่าง | 2D | 3D |
|----------|-----|-----|
| **🌊 จำลองน้ำท่วม** | `dashboard.html` (Leaflet) | `index.html` (MapLibre + เมือง 3D) |
| **🛠️ แก้โครงสร้าง** | `interventions.html` (สลับในหน้า) | เหมือนกัน (ปุ่ม 2D/3D บนแผนที่) |

- **ระดับน้ำที่จำลองไหลข้ามทุกหน้า** — เก็บใน `localStorage["yalaSim"] = {rain, river, dam}`
  ตั้งระดับในหน้าจำลอง → เข้าหน้าแก้โครงสร้าง จะใช้ระดับเดิมทันที (มีแถบแจ้ง)
- **จำมุมมองล่าสุด** — `localStorage["yalaView"]` (2d/3d) ทำให้กดหน้าต่างไหนก็เปิดมุมมองที่เลือกไว้
- ตรรกะแถบนำทางรวมที่ [`assets/nav.js`](assets/nav.js)

## โครงสร้างโปรเจกต์
```
index.html                     🌊 จำลองน้ำท่วม 3D (MapLibre) + เมืองยะลา 3D
dashboard.html                 🌊 จำลองน้ำท่วม 2D (Leaflet) + แผงควบคุมการจำลอง
interventions.html             🛠️ แก้โครงสร้าง — เสนอ/จำลองมาตรการ (2D/3D)
city3d.html                    ฉาก 3D ที่ถูกฝัง (iframe) ในหน้า dashboard
login.html                     ด่านล็อกอิน (client-side gate สำหรับเดโม)
assets/
  nav.js                       แถบนำทาง 2 หน้าต่าง + จำมุมมอง (yalaView) + ระดับน้ำร่วม
  auth.js                      ด่านล็อกอินฝั่ง client (sessionStorage)
  styles.css                   สไตล์ทั้งหมด
  live_status.js               ดึงข้อมูลสด (เขื่อน/ฝน) + แคช last-known-good + ป้ายสถานะ
  geotiff.min.js               ไลบรารีอ่าน GeoTIFF (vendored)
  — จำลองน้ำท่วม —
  flood_analysis.js            ตัววิเคราะห์การแพร่น้ำท่วม (Priority-Flood) หน้า 2D
  lisflood_viewer.js           ตัวแสดงเฟรมน้ำท่วมจากโมเดล LISFLOOD
  — แก้โครงสร้าง —
  intervention_compare.js      engine กลาง: โหลด grid + รัน Priority-Flood ก่อน/หลังยกคันกั้น + สถิติ
  intervention_views.js        UI + วาด 2D (Leaflet canvas) + สไลเดอร์ระดับน้ำ + toggle มาตรการ
  intervention_3d.js           มุมมอง 3D (MapLibre): terrain + อาคาร + ผิวน้ำ + โมเดลคันกั้น/บ่อ/สูบ
data/                          ชั้นข้อมูลที่เว็บเรียกใช้
  output_fabdem.tif            DEM (FABDEM V1-2, 30 ม., bare-earth · ตรวจ ICESat-2 ±5.45 ม.)
  dem_grid.json                DEM เป็น grid + channel (ทางน้ำ) + drain_cm (ความจุระบาย) — engine ใช้
  flood_response.json          ค่าปรับเทียบ input→ระดับน้ำ (ตลิ่ง 14.0 · เริ่มท่วม 15.25 · เหตุการณ์ 18.25)
  yala_boundary.geojson        ขอบเขตเมือง (mask + คิดสถิติ)
  yala_waterways.geojson       แนวแม่น้ำปัตตานีหลัก (ใช้วางคันกั้นริมตลิ่ง)
  yala_roads.geojson           ถนน OSM (หลบวางโครงสร้าง + หาจุดประตูระบาย)
  yala_buildings.geojson       อาคาร (exposure + footprint กันวางทับ)
  yala_flood_gistda_kmz.geojson น้ำท่วมจริงจากดาวเทียม GISTDA (ground truth ยืนยัน hotspot)
  buildings_grid.json          จำนวนอาคารต่อเซลล์ (engine ใช้)
  intervention_candidates.geojson จุด/แนวมาตรการทั้งหมด (คันกั้น·แก้มลิง·ท่อ/สูบ·ประตู·จุดเสี่ยง)
  intervention_sim.json        เซลล์คันกั้น + ผลก่อน-หลัง (ให้ engine รันซ้ำในเบราว์เซอร์)
  intervention_summary.json    สรุปจัดอันดับ + benefit/cost + checklist หลักการ/กฎหมาย
  (และชั้นข้อมูล geojson/json อื่น ๆ ของยะลา)
scripts/                       สคริปต์เตรียมข้อมูล (Python) + build_static.sh + START_SERVER.sh
  analyze_interventions.py     สร้าง intervention_* ทั้งหมด (หัวใจของหน้าแก้โครงสร้าง)
  validate_model.js            ตรวจความถูกต้องเทียบ GISTDA (รันตอน npm test)
lisflood/                      โมเดล LISFLOOD (inputs, src, run.sh) + เฟรมผลลัพธ์
terrain/                       terrain tiles สำหรับมุมมอง 3D
docs/                          เอกสารโปรเจกต์ + data_checklist_yala.xlsx (เช็กลิสต์แหล่งข้อมูล)
raw/                           ข้อมูลดิบ/ตัวกลางขนาดใหญ่ (zip, tar.gz, overpass)
```

## วิธีวิเคราะห์

### 1) จำลองน้ำท่วม — Priority-Flood (minimax connectivity)
มองว่าระดับน้ำค่อย ๆ ยกตัวจากแม่น้ำปัตตานี แล้วหาสำหรับทุกเซลล์ของ DEM ว่า **arrival level**
(ระดับน้ำต่ำสุดที่เซลล์นั้นเชื่อมกับแหล่งน้ำ) เท่าไร → ได้ **ลำดับท่วมก่อน-หลัง · ทิศทางไหล (D8) ·
ความลึก ณ ระดับผิวน้ำ S** (`depth = S − elevation` เฉพาะเซลล์ที่ `arrival ≤ S`)

สไลเดอร์ ฝน/แม่น้ำ/เขื่อน → แปลงเป็นระดับน้ำ (ม.รทก.) ผ่านค่าปรับเทียบใน `flood_response.json`
ที่ calibrate กับเหตุการณ์จริง **พ.ย. 2568** (เหตุการณ์ออกแบบ = 18.25 ม.รทก.)

### 2) แก้โครงสร้าง — [`scripts/analyze_interventions.py`](scripts/analyze_interventions.py)
รันโมเดลน้ำท่วม **ตัวเดียวกัน** ซ้ำ (before/after) เพื่อเลือกและวัดผลมาตรการ ทำงานเป็นชั้น:

**สัญญาณที่คำนวณ:** `arrival` (ลำดับท่วม) · `flowAcc` (D8 น้ำไหลมารวม) · `mdist` (ระยะถึงแม่น้ำหลัก) ·
`occupied` (rasterize รอยอาคาร+ถนน กันวางทับ) · `observed` (GISTDA ยืนยัน)

**4 มาตรการ + เกณฑ์วางตำแหน่ง:**

| มาตรการ | วางที่ไหน | จำลองผลได้? |
|---------|-----------|:---:|
| **คันกั้นริมแม่น้ำ** | ริมตลิ่งฝั่งเมือง (`mdist=1`) ตลอดแนวแม่น้ำปัตตานี · หลบรอยอาคาร | ✅ รัน flood ซ้ำ |
| **ประตูระบาย/สถานีสูบ** | จุดที่คันกั้นตัดถนน (interior drainage บังคับ) | — |
| **แก้มลิง** | ก้นกระทะ `flowAcc≥p99` บนเซลล์ว่าง · เว้นระยะ ≥500 ม. | รอ SWMM |
| **ท่อ/สูบ (คอขวด)** | `flowAcc≥p96` **และ** `drain<10` · หลบอาคาร · เว้นระยะ | รอ SWMM |
| **จุดเสี่ยง (hotspot)** | ท่วมบ่อย × อาคารแน่น × ตรง GISTDA (หมุดอ้างอิง) | — |

**ถูกต้องตามหลักการ/กฎหมาย** (อ้างอิง USACE ULDC · FHWA HEC-22/24 · แก้มลิงพระราชดำริ · ASFPM):
- **No-Adverse-Impact** — นับอาคารที่ "แห้ง→ท่วม" หลังสร้าง + เตือนว่าต้องยืนยันด้วย HEC-RAS 2D
  (โมเดล connectivity ประเมินผลกระทบท้ายน้ำ/ฝั่งตรงข้ามไม่ได้)
- ทุกหมุดพก **checklist องค์ประกอบที่ต้องมี** (cutoff wall กันซึม · ต่อปลายกัน flanking ·
  ประตูจับจังหวะน้ำขึ้น-ลง · ปั๊มสำรอง+ไฟสำรอง ฯลฯ) โผล่ใน popup

หน้าเว็บโหลดผลลัพธ์ (`intervention_*`) มาแสดง แล้ว [`intervention_compare.js`](assets/intervention_compare.js)
รัน Priority-Flood ในเบราว์เซอร์ให้ **จำลองเปิด/ปิดคันกั้นสด ๆ** ได้

📄 **รายละเอียดเต็ม + พารามิเตอร์ + ผลตรวจสอบความถูกต้อง:** ดู [docs/METHODOLOGY.md](docs/METHODOLOGY.md)

## ข้อจำกัด & roadmap
เป็นระดับ **screening** บน DEM 30 ม. (±5 ม.) — บอก *ลำดับ/ทิศ/พื้นที่เสี่ยง* และ *เลือก/เทียบมาตรการ* ได้
แต่ **ยังทำไม่ได้** (ต้องต่อยอด): ขนาด/ความสูง/ฐานรากคันกั้น · ปริมาตรบ่อ/ขนาดท่อตาม return period ·
seepage/geotech · ผลกระทบท้ายน้ำจริง · อัตราการไหลเชิงเวลา

ต้องใช้ **LiDAR (±0.15 ม.) + HEC-RAS 2D + EPA SWMM + เจาะสำรวจดิน** เป็นขั้นถัดไป
(มี [`lisflood/`](lisflood/) LISFLOOD-FP 2D เป็นก้าวกลาง)

## การทดสอบ
```bash
npm test     # ตรวจความครบของ data/asset (scripts/*.test.mjs) + validation (ROC-AUC/POD/FAR/CSI)
```

## พิกัดมาตรฐาน
WGS84 / UTM Zone 47N — **EPSG:32647** (ใช้กับทุกชั้นข้อมูลและการคำนวณระยะ/พื้นที่)
