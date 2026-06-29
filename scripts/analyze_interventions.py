#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_interventions.py — วิเคราะห์ "จุดที่ควรแก้โครงสร้าง" เพื่อลดน้ำท่วม
--------------------------------------------------------------------------
ทำตามขั้นตอน (ดูบทวิเคราะห์): hotspot × bottleneck → มาตรการ → จำลองก่อน-หลัง

ใช้ data/dem_grid.json (DEM FABDEM 30 ม. + channel ทางน้ำจริง + drain_cm ความจุระบาย)
ไม่พึ่ง dependency หนัก (numpy + stdlib)

ผลลัพธ์:
  data/intervention_candidates.geojson  — จุด/พื้นที่ที่ควรแก้ (hotspot / bottleneck / levee)
  data/intervention_summary.json        — สรุปจัดอันดับ + ผลก่อน-หลัง สำหรับแสดงในหน้าเว็บ

วิธี (screening-level บน Priority-Flood):
  1) arrival = ระดับน้ำต่ำสุดที่เซลล์เชื่อมแม่น้ำ (minimax) — ต่ำ = ท่วมก่อน
  2) flow accumulation (D8) = น้ำไหลมารวมที่เซลล์มากแค่ไหน — สูง = ทางระบายหลัก/คอขวด
  3) hotspot = บริเวณที่ "ท่วมในเหตุการณ์ออกแบบ + อาคารหนาแน่น + ตรงกับน้ำท่วมจริง GISTDA"
  4) bottleneck = เซลล์ flowAcc สูง แต่ drain_cm ต่ำ (น้ำมารวมแต่ระบายไม่ทัน)
  5) levee/dike = ล้อมพื้นที่ hotspot อันดับ 1 ด้วยคันกั้น → รัน Priority-Flood ซ้ำ →
     นับอาคารที่หลุดจากโซนน้ำท่วม (ผลก่อน-หลังจริงจากโมเดล)
"""
import json, os, heapq, math
import numpy as np

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
D = os.path.join(ROOT, "data")
def J(p): return json.load(open(os.path.join(D, p), encoding="utf-8"))

# ---------- โหลด DEM grid ----------
G = J("dem_grid.json")
NC, NR = G["ncols"], G["nrows"]
N = NC * NR
ground = np.array(G["ground_m"], dtype=np.float64)
drain_cm = np.array(G["drain_cm"], dtype=np.float64) if "drain_cm" in G else np.zeros(N)
valid = (ground > 0) & (ground < 9000) & np.isfinite(ground)
OLON, OLAT, DLON, DLAT = G["origin_lon"], G["origin_lat"], G["dlon"], G["dlat"]
FR = J("flood_response.json")
DESIGN_S = FR["event_stage_m"]      # 18.25 ม.รทก. = เหตุการณ์ใหญ่ พ.ย. 2568 (ใช้ประเมินผลคันกั้น)
HOTSPOT_S = FR["onset_stage_m"]     # 15.25 ม.รทก. = เริ่มท่วม (ใช้หา hotspot ที่ท่วม "บ่อย" + เฉพาะจุด)
FREEBOARD = 0.5

def lonOf(c): return OLON + (c + 0.5) * DLON
def latOf(r): return OLAT - (r + 0.5) * DLAT
def colOf(lon): return int((lon - OLON) / DLON)
def rowOf(lat): return int((OLAT - lat) / DLAT)

NB = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]

# ---------- กันแนะนำซ้ำในจุดเดียว: ตัดจุดที่อยู่ใกล้จุดอันดับสูงกว่าเกินไป (non-max suppression) ----------
# จุด flowAcc สูงมักเกาะกลุ่มในร่องระบายเดียวกัน → ถ้าไม่กรองจะได้สูบ/บ่อ 4-5 จุดทับซ้อนใน ~400 ม.
MIN_SPACING_M = 500       # ระยะห่างขั้นต่ำระหว่างมาตรการชนิดเดียวกัน (ปรับได้)
def dedupe_spatial(items, minm=MIN_SPACING_M):
    kept = []
    for it in items:                                      # items ต้องเรียงตามลำดับความสำคัญมาก่อนแล้ว
        ok = True
        for k in kept:
            dx = (it["lon"] - k["lon"]) * 111320.0 * math.cos(math.radians(it["lat"]))
            dy = (it["lat"] - k["lat"]) * 111320.0
            if dx * dx + dy * dy < minm * minm:
                ok = False; break
        if ok:
            kept.append(it)
    return kept

# ---------- 1) Priority-Flood (minimax) จาก channel ----------
def priority_flood(elev, seeds):
    arr = np.full(N, np.inf)
    h = []
    for i in seeds:
        if valid[i]:
            arr[i] = elev[i]; heapq.heappush(h, (elev[i], i))
    while h:
        L, i = heapq.heappop(h)
        if L > arr[i]:
            continue
        r, c = divmod(i, NC)
        for dr, dc in NB:
            nr, nc = r + dr, c + dc
            if 0 <= nr < NR and 0 <= nc < NC:
                j = nr * NC + nc
                if not valid[j]:
                    continue
                nl = max(L, elev[j])
                if nl < arr[j]:
                    arr[j] = nl; heapq.heappush(h, (nl, j))
    return arr

channel = [int(i) for i in G.get("channel", []) if valid[int(i)]]
arrival = priority_flood(ground, channel)
reach = np.isfinite(arrival)
print(f"grid {NC}×{NR} · channel seeds {len(channel)} · reachable {reach.sum()}")

# ---------- 1b) ระยะถึงแม่น้ำ (BFS จาก channel) → ใช้วางคันกั้น "ริมตลิ่ง" ----------
import collections
rdist = np.full(N, -1, dtype=np.int64)
_q = collections.deque()
for i in channel:
    rdist[i] = 0; _q.append(i)
while _q:
    i = _q.popleft(); r, c = divmod(i, NC)
    for dr, dc in NB:
        nr, nc = r + dr, c + dc
        if 0 <= nr < NR and 0 <= nc < NC:
            j = nr * NC + nc
            if valid[j] and rdist[j] < 0:
                rdist[j] = rdist[i] + 1; _q.append(j)

# ---------- 2) Flow accumulation (D8) ----------
def flow_accum(elev):
    acc = np.ones(N)
    order = np.argsort(-np.where(valid, elev, -np.inf))   # สูง→ต่ำ
    rcv = np.full(N, -1, dtype=np.int64)
    for i in order:
        if not valid[i]:
            continue
        r, c = divmod(int(i), NC)
        best, bj = elev[i], -1
        for dr, dc in NB:
            nr, nc = r + dr, c + dc
            if 0 <= nr < NR and 0 <= nc < NC:
                j = nr * NC + nc
                if valid[j] and elev[j] < best:
                    best, bj = elev[j], j
        rcv[i] = bj
    for i in order:                                       # ส่งน้ำลงปลายน้ำ
        j = rcv[i]
        if j >= 0:
            acc[j] += acc[i]
    return acc

flowAcc = flow_accum(ground)

# ---------- 3) study mask ----------
SB = J("yala_boundary.geojson")["features"][0]["geometry"]["coordinates"][0]
def pin(lo, la, ring):
    s = False; n = len(ring); j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]; xj, yj = ring[j][0], ring[j][1]
        if ((yi > la) != (yj > la)) and (lo < (xj - xi) * (la - yi) / (yj - yi + 1e-30) + xi):
            s = not s
        j = i
    return s
inStudy = np.zeros(N, dtype=bool)
for r in range(NR):
    for c in range(NC):
        i = r * NC + c
        if valid[i] and pin(lonOf(c), latOf(r), SB):
            inStudy[i] = True

# ---------- 4) อาคาร → ความหนาแน่นต่อเซลล์ (exposure) + footprint mask ----------
# bld = จำนวนอาคาร (จุดศูนย์กลาง) ต่อเซลล์ → ใช้นับ exposure
# building_cell = เซลล์ที่ "รอยอาคารจริงทับ" (ไม่ใช่แค่จุดศูนย์กลาง) → ใช้กันไม่ให้สิ่งก่อสร้างทับอาคาร
#   สำคัญ: อาคารใหญ่ 1 หลังกินหลายเซลล์ แต่มีศูนย์กลางเดียว — ต้อง rasterize รอยอาคารถึงจะกันทับได้จริง
bld = np.zeros(N)
building_cell = np.zeros(N, dtype=bool)
for f in J("yala_buildings.geojson")["features"]:
    g = f.get("geometry") or {}
    if g.get("type") != "Polygon":
        continue
    ring = g["coordinates"][0]
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    lon = sum(xs) / len(xs); la = sum(ys) / len(ys)
    c, r = colOf(lon), rowOf(la)
    if 0 <= r < NR and 0 <= c < NC:
        bld[r * NC + c] += 1
        building_cell[r * NC + c] = True          # อาคารเล็กกว่าเซลล์ → อย่างน้อยกันเซลล์ศูนย์กลาง
    c0 = max(0, colOf(min(xs))); c1 = min(NC - 1, colOf(max(xs)))     # rasterize รอยอาคารทุกเซลล์ที่ทับ
    r0 = max(0, rowOf(max(ys))); r1 = min(NR - 1, rowOf(min(ys)))
    for rr in range(r0, r1 + 1):
        for cc in range(c0, c1 + 1):
            i = rr * NC + cc
            if not building_cell[i] and pin(lonOf(cc), latOf(rr), ring):
                building_cell[i] = True
print(f"อาคารในกริด {int(bld.sum())} · เซลล์รอยอาคาร {int(building_cell.sum())} · เซลล์เมือง {inStudy.sum()}")

# ---------- 4a) ถนน → road mask (rasterize LineString ลงเซลล์ 30 ม.) ----------
# ใช้คัด/หลีกตำแหน่งสิ่งก่อสร้าง: บ่อหน่วง/สูบ ไม่ควรทับถนน · คันกั้นรายงานจุดที่พาดถนน
road_cell = np.zeros(N, dtype=bool)
def fcol(lon): return (lon - OLON) / DLON
def frow(lat): return (OLAT - lat) / DLAT
try:
    for f in J("yala_roads.geojson")["features"]:
        g = f.get("geometry") or {}
        if g.get("type") != "LineString":
            continue
        co = g["coordinates"]
        for a, b in zip(co, co[1:]):
            c0, r0 = fcol(a[0]), frow(a[1]); c1, r1 = fcol(b[0]), frow(b[1])
            steps = int(max(abs(c1 - c0), abs(r1 - r0)) * 2) + 1
            for s in range(steps + 1):
                t = s / steps
                cc = int(c0 + (c1 - c0) * t); rr = int(r0 + (r1 - r0) * t)
                if 0 <= rr < NR and 0 <= cc < NC:
                    road_cell[rr * NC + cc] = True
except Exception as e:
    print("  (ข้ามชั้นถนน:", e, ")")

# occupied = เซลล์ที่ "รอยอาคารทับ หรือ ถนนพาด" → ใช้ไม่ได้สำหรับบ่อหน่วง/สูบ
occupied = building_cell | road_cell
print(f"ถนน {int(road_cell.sum())} เซลล์ · occupied {int(occupied.sum())} · ว่างในเมือง {int((inStudy & ~occupied).sum())}")

# ---------- 4b) น้ำท่วมจริง GISTDA (โพลิกอนดาวเทียม) → observed mask (ถ่วงน้ำหนัก hotspot) ----------
observed = np.zeros(N, dtype=bool)
def each_poly(geom, cb):
    if not geom: return
    t = geom.get("type")
    if t == "Polygon": cb(geom["coordinates"])
    elif t == "MultiPolygon":
        for p in geom["coordinates"]: cb(p)
    elif t == "GeometryCollection":
        for gg in geom.get("geometries", []): each_poly(gg, cb)
def fill_ring(ring):
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    c0 = max(0, colOf(min(xs))); c1 = min(NC - 1, colOf(max(xs)))
    r0 = max(0, rowOf(max(ys))); r1 = min(NR - 1, rowOf(min(ys)))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            if not observed[r * NC + c] and pin(lonOf(c), latOf(r), ring):
                observed[r * NC + c] = True
try:
    for f in J("yala_flood_gistda_kmz.geojson")["features"]:
        each_poly(f.get("geometry"), lambda poly: fill_ring(poly[0]))
except Exception as e:
    print("  (ข้าม GISTDA observed:", e, ")")

# ---------- 5) น้ำท่วม baseline (เหตุการณ์ออกแบบ) + hotspot (ระดับเริ่มท่วม=ท่วมบ่อย) ----------
flooded0 = inStudy & reach & (arrival <= DESIGN_S)            # เหตุการณ์ใหญ่ → ใช้ประเมินคันกั้น
depth0 = np.where(flooded0, DESIGN_S - arrival, 0.0)
bld_flooded0 = int(bld[flooded0].sum())
flooded_hot = inStudy & reach & (arrival <= HOTSPOT_S)        # ท่วมตั้งแต่ระดับเริ่มท่วม = เฉพาะจุด/บ่อย
depth_hot = np.where(flooded_hot, HOTSPOT_S - arrival, 0.0)
print(f"baseline @ {DESIGN_S} ม.: ท่วม {flooded0.sum()} เซลล์ · อาคารโดน {bld_flooded0}")
print(f"hotspot @ {HOTSPOT_S} ม.: ท่วม {flooded_hot.sum()} เซลล์ · GISTDA observed {observed.sum()} เซลล์")

# ---------- connected components (BFS) ----------
def components(mask):
    lab = np.full(N, -1, dtype=np.int64); cid = 0
    for s in range(N):
        if mask[s] and lab[s] < 0:
            stack = [s]; lab[s] = cid
            while stack:
                i = stack.pop(); r, c = divmod(i, NC)
                for dr, dc in NB:
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < NR and 0 <= nc < NC:
                        j = nr * NC + nc
                        if mask[j] and lab[j] < 0:
                            lab[j] = cid; stack.append(j)
            cid += 1
    return lab, cid

lab, ncomp = components(flooded_hot)

# convex hull (monotone chain) ของจุด (lon,lat)
def hull(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    def cross(o, a, b): return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lo = []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    up = []
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]

# ---------- hotspot zones (จัดอันดับด้วย อาคาร × ความลึก) ----------
zones = []
for k in range(ncomp):
    cells = np.where(lab == k)[0]
    if len(cells) < 8:                  # ตัดหย่อมเล็ก
        continue
    b = float(bld[cells].sum())
    if b < 5:
        continue
    obs_frac = float(observed[cells].mean())            # สัดส่วนที่ตรงกับน้ำท่วมจริง GISTDA
    dmean_onset = float(depth_hot[cells].mean())        # ความลึกที่ระดับ "เริ่มท่วม" → ใช้คัดเลือก/ถ่วงน้ำหนัก (ท่วมบ่อย)
    dmean_design = float(depth0[cells].mean())          # ความลึกที่ "เหตุการณ์ออกแบบ" → ใช้แสดงผล (สอดคล้อง before/after & baseline)
    score = b * dmean_onset * (1.0 + obs_frac)          # อาคาร × ความลึก(เริ่มท่วม) × (ยืนยันด้วยของจริง)
    rs = cells // NC; cs = cells % NC
    cen_lon = float(np.mean([lonOf(c) for c in cs]))
    cen_lat = float(np.mean([latOf(r) for r in rs]))
    area_rai = len(cells) * 30 * 30 / 1600.0     # 1 ไร่ = 1600 ตร.ม.
    zones.append({"cells": cells, "buildings": int(b), "depth_mean": round(dmean_design, 2),
                  "obs_pct": round(obs_frac * 100), "score": score, "lon": cen_lon, "lat": cen_lat,
                  "area_rai": round(area_rai), "n": len(cells)})
zones.sort(key=lambda z: -z["score"])
zones = zones[:4]
print(f"hotspot zones (top {len(zones)}): " + ", ".join(f"{z['buildings']} อาคาร/ลึก{z['depth_mean']}ม." for z in zones))

# ---------- bottlenecks (flowAcc สูง + drain ต่ำ) ----------
acc_thr = np.percentile(flowAcc[inStudy], 96)
bott_mask = inStudy & (flowAcc >= acc_thr) & (drain_cm < 10) & reach
bl, bn = components(bott_mask)
bottlenecks = []
for k in range(bn):
    cells = np.where(bl == k)[0]
    if len(cells) < 3:
        continue
    rs = cells // NC; cs = cells % NC
    bottlenecks.append({"lon": float(np.mean([lonOf(c) for c in cs])),
                        "lat": float(np.mean([latOf(r) for r in rs])),
                        "flowacc": float(flowAcc[cells].max()),
                        "drain_cm": int(np.median(drain_cm[cells])),
                        "n": len(cells)})
bottlenecks.sort(key=lambda b: -b["flowacc"])
bottlenecks = dedupe_spatial(bottlenecks)[:5]      # เว้นระยะ ≥500 ม. กันแนะนำซ้ำในร่องเดียวกัน
print(f"bottlenecks (top {len(bottlenecks)} หลังเว้นระยะ ≥{MIN_SPACING_M} ม.)")

# ---------- ต้นทุนคร่าว ๆ (สมมุติเพื่อจัดลำดับ benefit/cost — ไม่ใช่ราคาออกแบบจริง) ----------
LEVEE_RATE = 30000        # บาท/เมตร (กำแพง/คันกั้น)
PUMP_COST  = 5_000_000    # บาท/สถานีสูบ
DRAIN_COST = 2_000_000    # บาท/จุด (เพิ่มท่อ/คูระบาย)
POND_RATE  = 1200         # บาท/ลบ.ม. ความจุเก็บกัก
POND_DEPTH = 2.0          # ม. (ความลึกบ่อหน่วงสมมุติ)

def buildings_near(i, rad=10):
    r0, c0 = divmod(int(i), NC); s = 0.0
    for r in range(max(0, r0 - rad), min(NR, r0 + rad + 1)):
        for c in range(max(0, c0 - rad), min(NC, c0 + rad + 1)):
            s += bld[r * NC + c]
    return int(s)

# ---------- 6) คันกั้นริมแม่น้ำปัตตานี: กำแพงตามริมตลิ่งฝั่งเมือง (แนวแม่น้ำหลักจริง) หลบอาคาร ----------
# แนวคิดตรงกับการออกแบบจริง: น้ำล้นจากแม่น้ำปัตตานี → วางกำแพงตามริมตลิ่งฝั่งเมืองตลอดแนว
# (ไม่ใช่ล้อมรอบพื้นที่ ซึ่งพาดอาคาร/ตัดถนน) · วางบนเซลล์ว่าง เลี่ยงรอยอาคาร
# 6a) rasterize แนวแม่น้ำหลัก (yala_waterways.geojson) → mainriver → BFS ระยะถึงแม่น้ำหลัก (mdist)
mainriver = np.zeros(N, dtype=bool)
def _burn_line(co):
    for a, b in zip(co, co[1:]):
        c0, r0 = fcol(a[0]), frow(a[1]); c1, r1 = fcol(b[0]), frow(b[1])
        steps = int(max(abs(c1 - c0), abs(r1 - r0)) * 2) + 1
        for s in range(steps + 1):
            t = s / steps; cc = int(c0 + (c1 - c0) * t); rr = int(r0 + (r1 - r0) * t)
            if 0 <= rr < NR and 0 <= cc < NC: mainriver[rr * NC + cc] = True
def _each_line(geom, cb):
    t = (geom or {}).get("type")
    if t == "LineString": cb(geom["coordinates"])
    elif t == "MultiLineString":
        for ls in geom["coordinates"]: cb(ls)
    elif t == "GeometryCollection":
        for g in geom.get("geometries", []): _each_line(g, cb)
river_line = []
try:
    for f in J("yala_waterways.geojson")["features"]:
        g = f.get("geometry") or {}
        _each_line(g, _burn_line)
        if g.get("type") == "LineString": river_line = g["coordinates"]
except Exception as e:
    print("  (ข้ามแนวแม่น้ำหลัก:", e, ")")
mdist = np.full(N, -1, dtype=np.int64); _mq = collections.deque()
for i in np.where(mainriver)[0]:
    mdist[i] = 0; _mq.append(int(i))
while _mq:
    i = _mq.popleft(); r, c = divmod(i, NC)
    for dr, dc in NB:
        nr, nc = r + dr, c + dc
        if 0 <= nr < NR and 0 <= nc < NC:
            j = nr * NC + nc
            if valid[j] and mdist[j] < 0: mdist[j] = mdist[i] + 1; _mq.append(j)

def riverbank_levee():
    # เซลล์ริมตลิ่งฝั่งเมือง = ติดแม่น้ำหลัก (mdist==1) · ในเขตเมือง · มีอาคารใกล้ (= ฝั่งเมือง ไม่ใช่ตลิ่งโล่ง)
    bank = [int(i) for i in np.where((mdist == 1) & inStudy & valid & (~mainriver))[0]
            if buildings_near(int(i), rad=6) > 0]
    # หลบอาคาร: เซลล์ริมตลิ่งที่ทับรอยอาคาร → ขยับไปเซลล์ว่างใกล้สุดที่ยังติดแม่น้ำหลัก
    wallset = set()
    for i in bank:
        if not building_cell[i]:
            wallset.add(i); continue
        r0, c0 = divmod(i, NC); best = None; bd = 1e9
        for rr in range(max(0, r0 - 3), min(NR, r0 + 4)):
            for cc in range(max(0, c0 - 3), min(NC, c0 + 4)):
                j = rr * NC + cc
                if valid[j] and not building_cell[j] and 1 <= mdist[j] <= 3:
                    dd = (rr - r0) ** 2 + (cc - c0) ** 2
                    if dd < bd: bd = dd; best = j
        if best is not None: wallset.add(best)
    perim = sorted(wallset)
    elev2 = ground.copy()
    for i in perim: elev2[i] = max(elev2[i], DESIGN_S + FREEBOARD)
    arrival2 = priority_flood(elev2, channel)
    flooded2 = inStudy & np.isfinite(arrival2) & (arrival2 <= DESIGN_S)
    before = int(bld[flooded0].sum()); after = int(bld[flooded2].sum())     # ทั้งเมือง (แนวกั้นแม่น้ำคุ้มทั้งเมือง)
    length_m = len(perim) * 30
    needs_pump = True   # ริมแม่น้ำ: ต้องมีประตูระบาย/สถานีสูบที่จุดท่อระบายออกแม่น้ำ
    cost = length_m * LEVEE_RATE + (PUMP_COST if needs_pump else 0)
    bld_under_wall = int(sum(bld[i] for i in perim))            # ตั้งใจให้ ~0 (หลบอาคารแล้ว)
    road_under_wall = int(sum(1 for i in perim if road_cell[i]))
    wall_h = [max(0.0, (DESIGN_S + FREEBOARD) - ground[i]) for i in perim]
    wall_h_mean = round(float(np.mean(wall_h)), 1) if wall_h else 0.0
    wall_h_max = round(float(max(wall_h)), 1) if wall_h else 0.0
    return {"rank": 1, "label": "แนวคันกั้นริมแม่น้ำปัตตานี (ฝั่งเมือง)",
            "before": before, "after": after, "protected": max(0, before - after),
            "line": [[round(p[0], 6), round(p[1], 6)] for p in river_line],
            "length_m": length_m, "needs_pump": needs_pump, "cost": cost,
            "bld_under_wall": bld_under_wall, "road_under_wall": road_under_wall,
            "wall_h_mean": wall_h_mean, "wall_h_max": wall_h_max,
            "wall_cells": [int(i) for i in perim]}

riverbank = riverbank_levee()
levees = [riverbank] if riverbank["wall_cells"] else []
print(f"riverbank levee: wall {len(riverbank['wall_cells'])} cells (~{round(riverbank['length_m']/1000,1)} กม.) · "
      f"สูงเฉลี่ย {riverbank['wall_h_mean']} ม. · ป้องกัน {riverbank['protected']} (จากท่วม {riverbank['before']}) · "
      f"ทับอาคาร {riverbank['bld_under_wall']}/ถนน {riverbank['road_under_wall']}")

# เซลล์ที่ "ถูกจองแล้ว" โดยคันกั้น → สิ่งก่อสร้างอื่นห้ามทับ (กันชนกันเอง)
levee_wall = set()
for lv in levees:
    levee_wall.update(lv["wall_cells"])

# ---------- 7) แก้มลิง/บ่อหน่วงน้ำ ที่จุด flow-accumulation สูงสุด (เลือกบน "ที่ว่าง") ----------
pond_thr = np.percentile(flowAcc[inStudy], 99)
pl, pn = components(inStudy & (flowAcc >= pond_thr) & reach)
ponds = []
for k in range(pn):
    cells = np.where(pl == k)[0]
    if len(cells) < 4:
        continue
    # แยกเซลล์ "ว่างจริง" (ไม่มีอาคาร ไม่มีถนน ไม่ทับคันกั้น) = ส่วนที่สร้างบ่อได้
    free = [int(i) for i in cells if not occupied[i] and int(i) not in levee_wall]
    bld_on_site = int(bld[cells].sum())                 # อาคารบนพื้นที่บ่อ → "สร้างได้ไหม"
    road_on_site = int(sum(1 for i in cells if road_cell[i]))
    occ_frac = round(1 - len(free) / len(cells), 2)     # สัดส่วนถูกอาคาร/ถนนทับ (0=ว่างหมด)
    use = free if len(free) >= 4 else [int(i) for i in cells]   # ใช้เซลล์ว่างคิดที่ตั้ง/ความจุ
    rs = [i // NC for i in use]; cs = [i % NC for i in use]
    lon = float(np.mean([lonOf(c) for c in cs])); lat = float(np.mean([latOf(r) for r in rs]))
    area_m2 = len(free) * 900                            # ความจุคิดจากพื้นที่ "ว่าง" เท่านั้น
    storage = area_m2 * POND_DEPTH
    ponds.append({"lon": lon, "lat": lat, "flowacc": float(flowAcc[cells].max()),
                  "area_rai": round(area_m2 / 1600), "storage_m3": int(storage),
                  "cost": int(storage * POND_RATE), "bld_on_site": bld_on_site,
                  "road_on_site": road_on_site, "occ_frac": occ_frac, "free_cells": len(free),
                  "free_idx": [int(i) for i in free],     # เซลล์ว่างจริง → ให้ 3D วาดบ่อตามรูปจริง (ไม่ทับอาคาร)
                  "near_buildings": buildings_near(int(use[len(use) // 2]))})
# เลือก "จุดที่สร้างได้จริงก่อน": ทับอาคาร/ถนนน้อยที่สุดก่อน แล้วจึงดูปริมาณน้ำที่มารวม (flowacc)
# ต้องมีที่ว่างพอสร้างจริง (≥4 เซลล์ ≈ 0.2 ไร่ขึ้นไป) มิฉะนั้นข้าม
ponds = [p for p in ponds if p["free_cells"] >= 4]
ponds.sort(key=lambda p: (p["occ_frac"], -p["flowacc"]))
ponds = dedupe_spatial(ponds)[:3]                  # เว้นระยะ ≥500 ม. กันบ่อหน่วงซ้อนจุดเดียว
print(f"retention ponds (top {len(ponds)}): " + ", ".join(
    f"flowAcc{round(p['flowacc'])}/ว่าง{p['free_cells']}ช่อง/ทับถนน{p['road_on_site']}" for p in ponds))

# ---------- 7b) ขยับจุด "สูบ/ท่อ" (คอขวด) ไปที่ว่างข้างเคียง (ไม่ทับอาคาร/คันกั้น) ----------
# คอขวดมักอยู่บนแนวถนน/ร่องน้ำ — ตัวสถานีสูบ/บ่อพักต้องมีที่ตั้งข้างทาง จึง snap ไปเซลล์ว่างใกล้สุด
def nearest_free(r0, c0, rad=4):
    best, bd = None, 1e9
    for r in range(max(0, r0 - rad), min(NR, r0 + rad + 1)):
        for c in range(max(0, c0 - rad), min(NC, c0 + rad + 1)):
            i = r * NC + c
            if valid[i] and not building_cell[i] and i not in levee_wall:   # ยอมให้อยู่ริมถนนได้ แต่ไม่ทับรอยอาคาร
                d = (r - r0) ** 2 + (c - c0) ** 2
                if d < bd:
                    bd, best = d, i
    return best
for b in bottlenecks:
    r0, c0 = rowOf(b["lat"]), colOf(b["lon"])
    on_road = bool(0 <= r0 < NR and 0 <= c0 < NC and road_cell[r0 * NC + c0])
    on_bld = bool(0 <= r0 < NR and 0 <= c0 < NC and bld[r0 * NC + c0] > 0)
    b["on_road"] = on_road
    if on_bld:                                   # ทับอาคาร → ย้ายไปที่ว่างใกล้สุด
        nf = nearest_free(r0, c0)
        if nf is not None:
            b["lat"] = latOf(nf // NC); b["lon"] = lonOf(nf % NC); b["relocated"] = True
        else:
            b["relocated"] = False
    else:
        b["relocated"] = False

def per_million(benefit, cost):
    return round(benefit / (cost / 1e6), 2) if cost else 0.0

# ---------- เขียน GeoJSON ----------
feats = []
for rank, z in enumerate(zones, 1):
    feats.append({"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(z["lon"], 6), round(z["lat"], 6)]},
        "properties": {"kind": "hotspot", "rank": rank, "buildings": z["buildings"],
                       "depth_mean_m": z["depth_mean"], "area_rai": z["area_rai"],
                       "radius_m": int((z["n"] * 900 / 3.1416) ** 0.5),
                       "label": f"จุดเสี่ยงอันดับ {rank}",
                       "rationale": f"ท่วม ~{z['depth_mean']} ม. · อาคารโดน {z['buildings']} หลัง · อยู่ริมแม่น้ำ → คันกั้นริมตลิ่งช่วยได้"}})
for i, b in enumerate(bottlenecks, 1):
    site = ("ย้ายจุดติดตั้งไปที่ว่างข้างเคียง (เลี่ยงอาคาร)" if b.get("relocated")
            else ("อยู่บนแนวถนน — ตั้งบ่อพัก/สูบริมทางได้" if b.get("on_road") else "มีที่ว่างติดตั้ง"))
    feats.append({"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(b["lon"], 6), round(b["lat"], 6)]},
        "properties": {"kind": "bottleneck", "rank": i, "drain_cm": b["drain_cm"], "cost_thb": DRAIN_COST,
                       "on_road": b.get("on_road", False), "relocated": b.get("relocated", False),
                       "label": f"คอขวดระบายน้ำ {i}",
                       "rationale": f"น้ำไหลมารวมสูง แต่ความจุระบายเพียง {b['drain_cm']} ซม. → ควรเพิ่มท่อ/สูบ · {site}"}})
for i, p in enumerate(ponds, 1):
    if p["bld_on_site"] == 0 and p["road_on_site"] == 0:
        feas = "พื้นที่ว่าง ไม่ทับอาคาร/ถนน"
    elif p["bld_on_site"] == 0:
        feas = f"เลี่ยงอาคารได้ · มีถนนพาด ~{p['road_on_site']} ช่อง (คิดความจุจากที่ว่างแล้ว)"
    else:
        feas = f"⚠ มีอาคาร ~{p['bld_on_site']} หลังบนพื้นที่ — ต้องจัดหาที่ดิน/เวนคืน"
    feats.append({"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(p["lon"], 6), round(p["lat"], 6)]},
        "properties": {"kind": "retention", "rank": i, "area_rai": p["area_rai"],
                       "storage_m3": p["storage_m3"], "cost_thb": p["cost"],
                       "buildings_on_site": p["bld_on_site"], "road_on_site": p["road_on_site"],
                       # ศูนย์กลางเซลล์ว่างจริง (30 ม.) → 3D วาดบ่อเป็นรูปจริง ไม่ใช่วงกลมทับอาคาร
                       "cells": [[round(lonOf(idx % NC), 6), round(latOf(idx // NC), 6)] for idx in p["free_idx"]],
                       "label": f"แก้มลิง/บ่อหน่วงน้ำ {i}",
                       "rationale": f"จุดน้ำไหลมารวมหลัก → บ่อหน่วง ~{p['area_rai']} ไร่ เก็บได้ ~{p['storage_m3']:,} ลบ.ม. · {feas}"}})
for lv in levees:
    if lv["line"]:
        feats.append({"type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[p[0], p[1]] for p in lv["line"]]},
            "properties": {"kind": "levee", "rank": lv["rank"], "protects_buildings": lv["protected"],
                           "needs_pump": lv["needs_pump"], "cost_thb": lv["cost"],
                           "length_m": lv["length_m"], "bld_under_wall": lv["bld_under_wall"],
                           "road_under_wall": lv["road_under_wall"],
                           "wall_h_mean": lv["wall_h_mean"], "wall_h_max": lv["wall_h_max"],
                           "label": lv["label"],
                           "rationale": f"กำแพงริมตลิ่งฝั่งเมือง ~{round(lv['length_m']/1000,1)} กม. · สูงเฉลี่ย ~{lv['wall_h_mean']} ม. (สูงสุด ~{lv['wall_h_max']}) → ป้องกัน ~{lv['protected']} หลัง (จากท่วม {lv['before']})"
                                        + (f" · เลี่ยงอาคารแล้ว (ทับ {lv['bld_under_wall']} หลัง) ข้ามถนน {lv['road_under_wall']} จุด" )
                                        + " · ต้องมีประตูระบาย/สูบที่ปากท่อ · แนวคัดกรอง ต้องจัดแนวจริงด้วย LiDAR+HEC-RAS"}})

fc = {"type": "FeatureCollection", "name": "intervention_candidates",
      "_meta": {"design_stage_m": DESIGN_S, "method": "Priority-Flood screening on FABDEM 30m",
                "generated_by": "scripts/analyze_interventions.py"}, "features": feats}
json.dump(fc, open(os.path.join(D, "intervention_candidates.geojson"), "w", encoding="utf-8"), ensure_ascii=False)

# ---------- buildings grid (สำหรับ engine จำลองสดในเบราว์เซอร์) ----------
json.dump({"ncols": NC, "nrows": NR, "counts": [int(x) for x in bld],
           "total": int(bld.sum())},
          open(os.path.join(D, "buildings_grid.json"), "w", encoding="utf-8"))

# ---------- intervention_sim.json (เปรียบเทียบก่อน-หลัง 2D/3D ในหน้าโครงสร้าง) ----------
# เก็บ "เซลล์คันกั้น" ต่อมาตรการ ให้ engine ฝั่งเว็บยกคันแล้วรัน Priority-Flood ซ้ำเอง
# (นิยาม depth/พื้นที่/ปริมาตร = นอกร่องน้ำจริง (channel) เพื่อให้เป็น "น้ำท่วมในเมือง" ไม่รวมร่องแม่น้ำ)
chan_mask = np.zeros(N, dtype=bool)
for i in channel:
    chan_mask[i] = True
city0 = flooded0 & ~chan_mask
CELL_M2 = 30 * 30
sim = {
    "design_stage_m": DESIGN_S, "freeboard_m": FREEBOARD,
    "ncols": NC, "nrows": NR,
    "origin_lon": OLON, "origin_lat": OLAT, "dlon": DLON, "dlat": DLAT,
    "baseline": {
        "flood_cells": int(city0.sum()),
        "buildings": int(bld[city0].sum()),
        "area_rai": round(int(city0.sum()) * CELL_M2 / 1600),
        "volume_m3": int((depth0[city0]).sum() * CELL_M2),
    },
    "levees": [
        {
            "rank": lv["rank"],
            "label": lv["label"],
            "line": lv["line"],                        # แนวแม่น้ำหลัก (สำหรับวาด 2D)
            "wall_cells": lv["wall_cells"],            # เซลล์กำแพงริมตลิ่ง (engine รันซ้ำ + วาดกำแพง 3D)
            "before": lv["before"], "after": lv["after"],
            "protected": lv["protected"],
            "needs_pump": lv["needs_pump"], "cost_thb": lv["cost"],
            "bld_under_wall": lv["bld_under_wall"], "road_under_wall": lv["road_under_wall"],
            "wall_h_mean": lv["wall_h_mean"], "wall_h_max": lv["wall_h_max"],
        }
        for lv in levees
    ],
    "note": "depth = design_stage − arrival (Priority-Flood minimax) นอกร่องน้ำจริง · "
            "ปริมาตรเป็นระดับ screening (ต้อง HEC-RAS 2D + SWMM เพื่อออกแบบจริง)",
}
json.dump(sim, open(os.path.join(D, "intervention_sim.json"), "w", encoding="utf-8"), ensure_ascii=False)

# ---------- เขียน summary (จัดอันดับ + cost/benefit) ----------
recs = []
for lv in levees:
    recs.append({"type": "คันกั้นริมแม่น้ำ (levee)", "kind": "levee",
                 "where": "ริมแม่น้ำปัตตานี ฝั่งเมือง",
                 "measure": f"กำแพงริมตลิ่ง ~{round(lv['length_m']/1000,1)} กม. สูงเฉลี่ย ~{lv['wall_h_mean']} ม."
                           + (" + ประตูระบาย/สถานีสูบ" if lv["needs_pump"] else ""),
                 "protects_buildings": lv["protected"], "cost_thb": lv["cost"],
                 "benefit_per_million": per_million(lv["protected"], lv["cost"]),
                 "expected": f"ป้องกันอาคารได้ ~{lv['protected']} หลัง (จากที่ท่วม {lv['before']}) · เลี่ยงรอยอาคาร (ทับ {lv['bld_under_wall']} หลัง)"})
for rank, z in enumerate(zones, 1):
    recs.append({"type": "พื้นที่เสี่ยง (hotspot)", "kind": "hotspot",
                 "where": f"{z['lat']:.3f}, {z['lon']:.3f}",
                 "buildings": z["buildings"], "depth_mean_m": z["depth_mean"],
                 "measure": "จุดเสี่ยงน้ำท่วม (อ้างอิงเลือกแนวคันกั้น/มาตรการ)",
                 "protects_buildings": None, "cost_thb": None, "benefit_per_million": None,
                 "expected": f"ท่วม ~{z['depth_mean']} ม. · อาคาร {z['buildings']} หลัง"})
for p in ponds:
    recs.append({"type": "แก้มลิง/บ่อหน่วงน้ำ (retention)", "kind": "retention",
                 "where": f"{p['lat']:.3f}, {p['lon']:.3f}",
                 "storage_m3": p["storage_m3"], "area_rai": p["area_rai"],
                 "measure": f"บ่อหน่วงน้ำ ~{p['area_rai']} ไร่ ที่จุดน้ำไหลมารวมหลัก",
                 "protects_buildings": None, "cost_thb": p["cost"],
                 # ยังไม่ได้จำลองผลลดน้ำท่วมของบ่อหน่วง (ต้อง SWMM) → ไม่ใส่ benefit/cost ที่จะไปจัดอันดับ
                 # เทียบกับคันกั้นที่มีผลจากโมเดล (เลี่ยงเทียบคนละหน่วย) — โชว์อาคารใกล้จุดเป็น "บริบท" เท่านั้น
                 "benefit_per_million": None,
                 "nearby_buildings": p["near_buildings"],
                 "buildings_on_site": p["bld_on_site"],   # อาคารบนพื้นที่บ่อ → ใช้เตือน feasibility
                 "road_on_site": p["road_on_site"],       # ถนนพาดพื้นที่บ่อ → คิดความจุจากที่ว่างแล้ว
                 "expected": f"หน่วงน้ำ ~{p['storage_m3']:,} ลบ.ม. (คิดจากที่ว่าง) ลดยอดน้ำท่วมท้ายน้ำ (ปริมาตรจริงต้อง SWMM)"})
for i, b in enumerate(bottlenecks, 1):
    recs.append({"type": "คอขวดระบายน้ำ (bottleneck)", "kind": "bottleneck",
                 "where": f"{b['lat']:.3f}, {b['lon']:.3f}", "drain_cm": b["drain_cm"],
                 "measure": "เพิ่มท่อ/คูระบาย หรือสถานีสูบ ณ จุดคอขวด"
                           + (" (ขยับจุดติดตั้งเลี่ยงอาคารแล้ว)" if b.get("relocated") else ""),
                 "protects_buildings": None, "cost_thb": DRAIN_COST,
                 "benefit_per_million": None,
                 "expected": "ระบายน้ำที่มารวมได้เร็วขึ้น ลดความลึก/ระยะเวลาท่วม"})
# จัดลำดับ: มาตรการที่ "จำลองผลได้" (มี benefit/cost) มาก่อน เรียงมากสุด→น้อย
# จากนั้นเป็นมาตรการที่ "รอประเมินด้วยแบบจำลองรายละเอียด" (ไม่มีตัวเลข) — แก้มลิงก่อนคอขวด
KIND_ORDER = {"levee": 0, "retention": 1, "bottleneck": 2, "hotspot": 3}
recs.sort(key=lambda r: (r["benefit_per_million"] is None,
                         -(r["benefit_per_million"] or 0),
                         KIND_ORDER.get(r["kind"], 9)))
for i, r in enumerate(recs, 1):
    r["priority"] = i

summary = {"design_stage_m": DESIGN_S,
           "baseline_buildings_flooded": bld_flooded0,
           "baseline_flood_cells": int(flooded0.sum()),
           "levee_demo": (levees[0] and {"protects_buildings": riverbank["protected"], "before": riverbank["before"],
                                    "after": riverbank["after"], "needs_pump": riverbank["needs_pump"],
                                    "cost_thb": riverbank["cost"], "length_m": riverbank["length_m"]}) if levees else None,
           "cost_note": "ต้นทุนเป็นค่าสมมุติคร่าว ๆ (คันกั้น 30,000 ฿/ม. · สูบ 5 ล้าน฿ · ท่อ 2 ล้าน฿ · บ่อหน่วง 1,200 ฿/ลบ.ม.) "
                        "คันกั้นริมแม่น้ำต้องมีประตูระบาย/สถานีสูบที่ปากท่อระบายออกแม่น้ำ · "
                        "ใช้จัดลำดับ benefit/cost เท่านั้น ไม่ใช่ราคาจริง · "
                        "แก้มลิง/คอขวด: ตัวเลขข้างจุดเป็นบริบท (อาคารใกล้/ความจุ) ยังไม่ใช่ผลลดน้ำท่วมจากแบบจำลอง",
           "recommendations": recs,
           "method_note": "ระดับ screening บน Priority-Flood (DEM FABDEM 30 ม., ±5 ม.) — ใช้เลือกจุด/เทียบมาตรการ "
                          "ไม่ใช่ออกแบบขนาดจริง (ต้อง HEC-RAS 2D + SWMM + LiDAR)",
           "generated": __import__("datetime").date.today().isoformat()}
json.dump(summary, open(os.path.join(D, "intervention_summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n✅ wrote intervention_candidates.geojson ({len(feats)} feats) + intervention_summary.json + buildings_grid.json")
