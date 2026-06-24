# LISFLOOD-FP 2D — ต่อยอดจากโมเดล screening เดิม

ยกระดับการจำลองน้ำท่วมยะลาจาก **Priority-Flood (screening)** เดิม → **LISFLOOD-FP 8.1**
ซึ่งเป็น **2D hydrodynamic จริง** (แก้สมการน้ำตื้นแบบ local-inertial/acceleration)
ให้น้ำไหลตามเวลาจริง มีอัตราการไหล/ความเร็ว/ความลึกราย-เวลา

โมเดลรัน **offline** บนเครื่อง แล้วป้อนผล (depth ราย-เวลา) เข้าแดชบอร์ดเป็นเลเยอร์เคลื่อนไหว

## โครงสร้าง
```
lisflood/
  src/                 ซอร์ส LISFLOOD-FP 8.1 (GPLv3) + แพตช์ให้ build บน macOS arm64
    config_macos.cmake   ปิด NetCDF/NUMA (เพิ่มใหม่)
    CMakeLists.txt       แก้: ข้าม NUMA บน Apple
  inputs/
    make_inputs.py       DEM (.tif) -> yala.dem.asc + .rain + .bci + .par + bbox.json
    yala.par             พารามิเตอร์หลัก (acceleration solver, rain-on-grid)
    results/             ผล .wd ที่โมเดลเขียนออกมา
  postprocess/
    wd_to_frames.py      .wd -> frames PNG + manifest.json
  frames/                เฟรม PNG + manifest.json (แดชบอร์ดอ่านชั้นนี้)
  run.sh                 รันครบวงจร: build -> inputs -> run -> postprocess
```

## วิธีรัน (macOS Apple Silicon)
```bash
brew install cmake libomp        # ครั้งเดียว (ติดตั้งแล้ว)
bash lisflood/run.sh             # build + รัน + แปลงผล
```
จากนั้นเปิดแดชบอร์ด (`npm run dev`) แล้วติ๊กเลเยอร์ **"ผลจำลอง LISFLOOD-FP 2D"**
มุมซ้ายล่างจะมีแผงเล่นไทม์ไลน์ของผลจำลอง

## สถานการณ์ที่จำลอง (ปรับได้ใน make_inputs.py)
- **Rain-on-grid**: พายุออกแบบ 24 ชม. พีค 50 mm/hr (คล้ายเหตุการณ์ พ.ย. 2568)
- ขอบโดเมนทั้ง 4 ด้าน = FREE (น้ำระบายออกตามภูมิประเทศ)
- Manning's n = 0.06, บันทึกผลทุก 30 นาที (48 เฟรม)
- จะเพิ่ม **point inflow** (น้ำระบายเขื่อนบางลาง) ก็เพิ่มบรรทัด `P x y QVAR INFLOW`
  ใน `yala.bci` + ไฟล์ `yala.bdy` ได้

## ข้อจำกัด (เหมือนเดิม)
รันบน **AW3D30 30 ม.** (±5 ม.) — flow routing สมจริงขึ้นมาก แต่ **ความลึก/ขอบเขตยังเชื่อเป็นค่าสัมบูรณ์ไม่ได้**
จะแม่นจริงต่อเมื่อเปลี่ยนเป็น **LiDAR 1–5 ม.** + boundary/ฝน/ท่อจริง (เพียงวาง DEM ละเอียดแทนแล้วรัน `run.sh` ใหม่)

ที่มาโมเดล: LISFLOOD-FP 8.1, GPLv3 — Zenodo DOI 10.5281/zenodo.6912932 (Bristol/Sheffield SEAMLESS-WAVE)
```
