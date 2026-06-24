#!/usr/bin/env python3
"""
สร้าง "เส้นโค้งตอบสนองน้ำท่วม" + เกณฑ์เริ่มท่วม จาก DEM จริง
------------------------------------------------------------
ตอบ 2 คำถามหลักของเทศบาล:
  (1) ระดับน้ำแม่น้ำ / ฝน / เขื่อน เท่าไหร่ "ถึงจะเริ่มท่วม"  (threshold)
  (2) ถ้าถึงระดับนั้นแล้ว "ท่วมลึก/กว้างแค่ไหน"            (depth/extent)

วิธี: Priority-Flood (ชุดเดียวกับโมเดล 3D) → กวาดระดับน้ำ (stage) ทีละขั้น
ทุกขั้นบันทึก พื้นที่ท่วม% + ความลึกกลาง(median) + ความลึก p95
แล้วหา "จุดเริ่มท่วมชุมชน" (onset) = stage แรกที่น้ำขึ้นบนพื้นดิน (ไม่ใช่ร่องแม่น้ำ) เกินเกณฑ์

ผูกค่าสไลเดอร์เข้ากับเกณฑ์กายภาพจริง:
  - แม่น้ำปัตตานี 75% = ล้นตลิ่ง +14.00 ม.รทก  → ตรงกับ onset (เริ่มท่วม)
  - เหตุการณ์ใหญ่ พ.ย. 2568 = stage ที่ calibrate กับดาวเทียม GISTDA
  - ฝน ≥30 มม./ชม. = เสี่ยงน้ำท่วมฉับพลัน  ·  เขื่อน ≥90% = ระบายฉุกเฉิน

ผลลัพธ์: data/flood_response.json  (UI + เอกสารใช้ร่วมไฟล์เดียว = single source of truth)
"""
import os, json, heapq
import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
G = json.load(open(os.path.join(ROOT, "data", "dem_grid.json")))
NC, NR = G["ncols"], G["nrows"]; N = NC * NR
ground = np.array(G["ground_m"], float)

# ---- base / seed (เหมือนโมเดล 3D ใน index.html เป๊ะ) ----
sg = np.sort(ground)
base = float(sg[int(N * 0.012)])      # ก้นแม่น้ำ
seed = float(sg[int(N * 0.03)])       # เซลล์ต่ำสุด = แหล่งน้ำ/แม่น้ำ

# ---- ข้อมูลโครงสร้างระบายน้ำจริง (scripts/build_drainage_grid.py) ----
channel = np.zeros(N, bool)
if G.get("channel"):
    channel[np.array(G["channel"], int)] = True   # ทางน้ำจริง = ต้นทางการไหล
drain = np.zeros(N, float)
if G.get("drain_cm"):
    drain = np.array(G["drain_cm"], float) / 100.0  # ความจุระบาย (ม.) สูบ+ฝาท่อ

# ---- Priority-Flood (minimax) arrival — seed จากทางน้ำจริง + เซลล์ต่ำสุด ----
arrival = np.full(N, np.inf); h = []
for i in range(N):
    if channel[i] or ground[i] <= seed:
        arrival[i] = ground[i]; h.append((ground[i], i))
heapq.heapify(h)
DX = [-1, 1, 0, 0]; DY = [0, 0, -1, 1]
while h:
    a, cur = heapq.heappop(h)
    if a > arrival[cur]: continue
    r, c = divmod(cur, NC)
    for k in range(4):
        rr, cc = r + DY[k], c + DX[k]
        if 0 <= rr < NR and 0 <= cc < NC:
            ni = rr * NC + cc
            na = a if a > ground[ni] else ground[ni]
            if na < arrival[ni]:
                arrival[ni] = na; heapq.heappush(h, (na, ni))

CHANNEL = arrival <= base + 0.3       # ร่องแม่น้ำ (ไม่นับเป็น "ท่วมชุมชน")

# ---- ฟังก์ชันสถิติ ณ ระดับน้ำหนึ่ง (เหมือน updateStats ใน 3D) ----
def stats(stage):
    depth = stage - ground - drain    # หักความจุระบาย (สูบ+ฝาท่อ)
    wet = (arrival <= stage) & (depth > 0.03)
    land = wet & ~CHANNEL              # ท่วมบนพื้นดิน
    area_pct = 100.0 * int(wet.sum()) / N
    land_pct = 100.0 * int(land.sum()) / N
    if land.any():
        dl = depth[land]
        med = float(np.median(dl)); p95 = float(np.percentile(dl, 95))
    else:
        med = p95 = 0.0
    return area_pct, land_pct, med, p95

# ---- กวาด stage หา onset + เส้นโค้ง ----
ONSET_LAND_PCT = 0.5                   # เริ่มท่วมชุมชน = พื้นดินท่วม > 0.5% ของกริด
curve, onset_stage = [], None
stage = base
while stage <= base + 8.0 + 1e-9:
    ap, lp, med, p95 = stats(stage)
    curve.append({"stage": round(stage, 2), "above_base": round(stage - base, 2),
                  "area_pct": round(ap, 1), "land_pct": round(lp, 1),
                  "depth_median": round(med, 2), "depth_p95": round(p95, 2)})
    if onset_stage is None and lp >= ONSET_LAND_PCT:
        onset_stage = round(stage, 2)
    stage += 0.25
if onset_stage is None:
    onset_stage = round(base + 1.25, 2)
onset_rise = round(onset_stage - base, 2)

# ---- stage ของเหตุการณ์ใหญ่ พ.ย. 2568 (จาก calibration) ----
try:
    cal = json.load(open(os.path.join(ROOT, "data", "calibration_nov2568.json")))
    event_stage = float(cal.get("calibrated_stage_m", base + 4.25))
except Exception:
    event_stage = base + 4.25
event_rise = round(event_stage - base, 2)

# ================================================================
#  การจับคู่ input → ระดับน้ำ (stage)  — ผูกกับเกณฑ์กายภาพจริง
#  stage = base + riseRiver + riseRain + riseDam   (มีเพดาน)
#  ออกแบบให้: แม่น้ำ 75% → ผิวน้ำ = onset (ล้นตลิ่งพอดี = เริ่มท่วม)
# ================================================================
RIVER_BANKFULL_PCT = 75.0             # 75% = ล้นตลิ่ง +14.00 ม.รทก (เกณฑ์จริงในแดชบอร์ด)
# เหนือ 75% แม่น้ำดันผิวน้ำขึ้นอีก จนถึงเหตุการณ์ใหญ่เมื่อ ~100%
RIVER_EXTRA = round((event_rise - onset_rise) * 0.78, 2)   # แม่น้ำเป็นตัวขับหลัก (~78% ของส่วนเกิน)
RAIN_MAX    = round((event_rise - onset_rise) * 0.30, 2)   # ฝน 100 มม./ชม. → surcharge สูงสุด
DAM_MAX     = round((event_rise - onset_rise) * 0.22, 2)   # เขื่อน 100% → surcharge สูงสุด
DAM_ONSET_PCT = 70.0                  # เขื่อนต่ำกว่า 70% = ปฏิบัติการปกติ ไม่ดันน้ำเพิ่ม

def rise_river(p):
    p = max(0.0, min(100.0, p))
    if p <= RIVER_BANKFULL_PCT:
        return onset_rise * (p / RIVER_BANKFULL_PCT)            # 0 → onset ที่ 75%
    return onset_rise + (p - RIVER_BANKFULL_PCT) / (100 - RIVER_BANKFULL_PCT) * RIVER_EXTRA

def rise_rain(mmhr):
    return RAIN_MAX * min(1.0, max(0.0, mmhr) / 100.0) ** 0.85  # ฝนหนัก → ท่วมขังเพิ่ม (เว้าเล็กน้อย)

def rise_dam(p):
    if p <= DAM_ONSET_PCT: return 0.0
    return DAM_MAX * (p - DAM_ONSET_PCT) / (100 - DAM_ONSET_PCT)

def stage_of(river, rain, dam):
    s = base + rise_river(river) + rise_rain(rain) + rise_dam(dam)
    return min(s, base + event_rise + 0.5)   # เพดานกันเกินจริง

def lookup(stage):
    """ประมาณ พื้นที่ท่วม%/ลึก จากเส้นโค้ง (interpolate)"""
    xs = [c["stage"] for c in curve]
    if stage <= xs[0]: c = curve[0]
    elif stage >= xs[-1]: c = curve[-1]
    else:
        i = np.searchsorted(xs, stage)
        lo, hi = curve[i - 1], curve[i]
        t = (stage - lo["stage"]) / (hi["stage"] - lo["stage"] + 1e-9)
        return {k: round(lo[k] + (hi[k] - lo[k]) * t, 2)
                for k in ("area_pct", "land_pct", "depth_median", "depth_p95")}
    return {k: c[k] for k in ("area_pct", "land_pct", "depth_median", "depth_p95")}

# ---- เกณฑ์เริ่มท่วม รายตัวขับ (ตรึงอีกสองตัวที่ "ค่าปกติ") ----
NORMAL = {"river": 50, "rain": 0, "dam": 60}   # สภาพปกติอ้างอิง
def solve_threshold(driver, lo, hi):
    """หา ค่าต่ำสุดของ driver ที่ทำให้ stage ถึง onset (อีกสองตัว = ค่าปกติ)"""
    for v in np.arange(lo, hi + 1e-9, (hi - lo) / 400):
        kw = dict(river=NORMAL["river"], rain=NORMAL["rain"], dam=NORMAL["dam"]); kw[driver] = float(v)
        if stage_of(**kw) >= onset_stage - 1e-6:
            return round(float(v), 1)
    return None

thr = {
    "river_pct":  solve_threshold("river", 0, 100),
    "rain_mmhr":  solve_threshold("rain", 0, 200),
    "dam_pct":    solve_threshold("dam", 0, 100),
}

out = {
    "_doc": "เส้นโค้งตอบสนองน้ำท่วม + เกณฑ์เริ่มท่วม (scripts/flood_response.py)",
    "method": "Priority-Flood บน DEM FABDEM 30 ม. · ผูกเกณฑ์กายภาพ (ตลิ่ง +14 ม.รทก, เหตุการณ์ พ.ย.2568)",
    "base_stage_m": round(base, 2),
    "onset_stage_m": onset_stage,
    "onset_rise_m": onset_rise,
    "event_stage_m": round(event_stage, 2),
    "event_rise_m": event_rise,
    "mapping": {
        "river_bankfull_pct": RIVER_BANKFULL_PCT, "river_extra_m": RIVER_EXTRA,
        "rain_max_m": RAIN_MAX, "dam_max_m": DAM_MAX, "dam_onset_pct": DAM_ONSET_PCT,
        "normal_baseline": NORMAL,
    },
    "onset_thresholds": thr,
    "curve": curve,
    "generated": "2026-06-17",
}
json.dump(out, open(os.path.join(ROOT, "data", "flood_response.json"), "w"),
          ensure_ascii=False, indent=2)

# ---- รายงาน ----
print(f"DEM {NC}x{NR} · base {base:.1f} ม. · seed {seed:.1f} ม.")
print(f"จุดเริ่มท่วมชุมชน (onset): stage {onset_stage} ม. (+{onset_rise} ม. เหนือก้นแม่น้ำ)")
print(f"เหตุการณ์ใหญ่ พ.ย.2568: stage {event_stage:.2f} ม. (+{event_rise} ม.)")
print(f"\nเกณฑ์เริ่มท่วม (ตรึงอีกสองตัว=ปกติ river50/rain0/dam60):")
print(f"  • แม่น้ำปัตตานี ≥ {thr['river_pct']}%   (ล้นตลิ่งที่ 75%)")
print(f"  • ฝน ≥ {thr['rain_mmhr']} มม./ชม.")
print(f"  • เขื่อนบางลาง ≥ {thr['dam_pct']}%")
print(f"\nตัวอย่างความลึก/พื้นที่ท่วม ณ บางสถานการณ์:")
for lbl, (rv, rn, dm) in [("ปกติ", (50, 0, 60)), ("ฝนหนัก", (55, 60, 65)),
                          ("แม่น้ำล้นตลิ่ง", (80, 20, 70)), ("วิกฤตรวม", (95, 80, 95)),
                          ("เหตุการณ์ พ.ย.2568", (100, 100, 90))]:
    s = stage_of(rv, rn, dm); lk = lookup(s)
    flood = "ท่วม" if s >= onset_stage else "ไม่ท่วม"
    print(f"  {lbl:18s} river{rv} rain{rn} dam{dm} → stage {s:.2f} [{flood}] "
          f"ท่วม {lk['area_pct']}% · ลึกทั่วไป {lk['depth_median']} ม. · ลึกสุด(p95) {lk['depth_p95']} ม.")
print(f"\n✅ บันทึก data/flood_response.json ({len(curve)} จุดเส้นโค้ง)")
