#!/usr/bin/env python3
"""
ดึงข้อมูลโทรมาตรจริงจาก CDDP (City Digital Data Platform) ของเทศบาลนครยะลา
→ ใช้เป็นข้อมูลตรวจสอบ "ด้านเวลา/ความลึก" (ลำดับ 2) ที่โมเดลยังขาด
=====================================================================
API ที่ค้นพบ (public, ไม่ต้อง auth):
  base = https://cddp-smartcity-api.localgov.ai
  GET  init/{muniName}                         → config เมือง (muniCode, modelId, forecast)
  GET  telemeters/{muniCode}/?type=water_level → สถานีวัดระดับน้ำ + ค่าล่าสุด
  GET  telemeters/{muniCode}/?type=rainfall    → สถานีวัดน้ำฝน
  GET  flood-forecast/latest?modelId={uuid}    → ผลพยากรณ์น้ำท่วมล่าสุด
  GET  flood-forecast/water-level?lat=&lng=&modelId=&locationId=  → พยากรณ์ระดับน้ำจุด

⚠️ หา MUNICODE ของยะลาก่อน (ผมเดา blind ไม่ได้ — host คืน default เชียงใหม่):
   1) เปิด  https://cddp-smartcity.localgov.ai/yala/telemeter
   2) กด F12 → แท็บ Network → รีเฟรช
   3) หา request ที่ขึ้นต้น  telemeters/XXXX/?type=...  →  XXXX คือ MUNICODE
   4) ใส่ค่าด้านล่าง แล้วรัน:  python3 scripts/fetch_cddp_telemetry.py
"""
import os, json, urllib.request, urllib.error

MUNICODE = os.environ.get("YALA_MUNICODE", "")   # <<< ใส่ตรงนี้ หรือ export YALA_MUNICODE=...
BASE = "https://cddp-smartcity-api.localgov.ai"
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "data")

def get(path):
    req = urllib.request.Request(f"{BASE}/{path}", headers={"Accept": "application/json", "User-Agent": "yala-gis/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_body": e.read().decode("utf-8", "replace")[:200]}
    except Exception as e:
        return {"_error": str(e)}

def main():
    if not MUNICODE:
        print("⚠️  ยังไม่ได้ตั้ง MUNICODE — ดูวิธีหาในหัวไฟล์ (F12 → Network → telemeters/XXXX/)")
        print("    ลองดึง config เพื่อช่วยหา:")
        cfg = get("init/yala")
        print("    init/yala →", json.dumps(cfg, ensure_ascii=False)[:300])
        return

    saved = {}
    for ty in ("water_level", "rainfall"):
        data = get(f"telemeters/{MUNICODE}/?type={ty}")
        if isinstance(data, list) and data:
            path = os.path.join(OUT, f"yala_telemetry_{ty}.json")
            json.dump(data, open(path, "w"), ensure_ascii=False, indent=2)
            saved[ty] = len(data)
            print(f"  ✅ {ty}: {len(data)} สถานี → data/yala_telemetry_{ty}.json")
            st = data[0]
            print(f"     ตัวอย่าง: {json.dumps(st, ensure_ascii=False)[:220]}")
        else:
            print(f"  ⚠️ {ty}: ไม่มีข้อมูล (muniCode ผิด? → {str(data)[:120]})")

    cfg = get(f"init/{MUNICODE}")
    if isinstance(cfg, dict) and cfg.get("forecast"):
        json.dump(cfg, open(os.path.join(OUT, "yala_cddp_config.json"), "w"), ensure_ascii=False, indent=2)
        print("  ✅ config + flood-forecast model → data/yala_cddp_config.json")

    if saved:
        print(f"\n✅ ดึงโทรมาตรจริงสำเร็จ — ใช้เทียบ 'เวลา/ระดับน้ำ' ที่โมเดลทำนาย vs ที่วัดได้จริง")
    print("\n(ถ้ายังว่าง: muniCode อาจผิด หรือข้อมูลเปิดเฉพาะช่วงมีเหตุการณ์)")

if __name__ == "__main__":
    main()
