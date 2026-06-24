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
import json, os, heapq
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

# ---------- 4) อาคาร → ความหนาแน่นต่อเซลล์ (exposure) ----------
bld = np.zeros(N)
for f in J("yala_buildings.geojson")["features"]:
    g = f.get("geometry") or {}
    if g.get("type") != "Polygon":
        continue
    ring = g["coordinates"][0]
    lon = sum(p[0] for p in ring) / len(ring)
    la = sum(p[1] for p in ring) / len(ring)
    c, r = colOf(lon), rowOf(la)
    if 0 <= r < NR and 0 <= c < NC:
        bld[r * NC + c] += 1
print(f"อาคารในกริด {int(bld.sum())} · เซลล์เมือง {inStudy.sum()}")

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
    dmean = float(depth_hot[cells].mean())
    score = b * dmean * (1.0 + obs_frac)                # อาคาร × ความลึก × (ยืนยันด้วยของจริง)
    rs = cells // NC; cs = cells % NC
    cen_lon = float(np.mean([lonOf(c) for c in cs]))
    cen_lat = float(np.mean([latOf(r) for r in rs]))
    area_rai = len(cells) * 30 * 30 / 1600.0     # 1 ไร่ = 1600 ตร.ม.
    zones.append({"cells": cells, "buildings": int(b), "depth_mean": round(dmean, 2),
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
bottlenecks = bottlenecks[:5]
print(f"bottlenecks (top {len(bottlenecks)})")

# ---------- 6) what-if: คันกั้น/คันดินรอบ hotspot อันดับ 1 ----------
levee = None
if zones:
    z = zones[0]
    zmask = np.zeros(N, dtype=bool); zmask[z["cells"]] = True
    # perimeter = เซลล์ในโซนที่ติดเซลล์นอกโซน → ยกเป็นคันกั้นถึง design+freeboard
    elev2 = ground.copy()
    perim = []
    for i in z["cells"]:
        r, c = divmod(int(i), NC)
        edge = False
        for dr, dc in NB:
            nr, nc = r + dr, c + dc
            if not (0 <= nr < NR and 0 <= nc < NC) or not zmask[nr * NC + nc]:
                edge = True; break
        if edge:
            perim.append(int(i))
    for i in perim:
        elev2[i] = max(elev2[i], DESIGN_S + FREEBOARD)
    # channel ที่อยู่ในโซน = ยังเป็น seed (น้ำผุดจากในโซนได้ → ต้องมีสูบ); seed ที่เหลือเท่าเดิม
    arrival2 = priority_flood(elev2, channel)
    flooded2 = inStudy & np.isfinite(arrival2) & (arrival2 <= DESIGN_S)
    before = int(bld[zmask & flooded0].sum())
    after = int(bld[zmask & flooded2].sum())
    protected = max(0, before - after)
    cells = z["cells"]; rs = cells // NC; cs = cells % NC
    poly = hull([(round(lonOf(c), 6), round(latOf(r), 6)) for r, c in zip(rs, cs)])
    levee = {"protects_buildings": protected, "before": before, "after": after,
             "area_rai": z["area_rai"], "lon": z["lon"], "lat": z["lat"],
             "polygon": poly,
             "needs_pump": after > before * 0.25}    # ถ้ายังท่วมเยอะ = มี seed/ฝนในโซน ต้องสูบร่วม
    print(f"levee @ zone#1: ก่อน {before} → หลัง {after} อาคาร · ป้องกันได้ {protected}"
          + (" (ต้องมีสูบร่วม)" if levee["needs_pump"] else ""))

# ---------- เขียน GeoJSON ----------
feats = []
for rank, z in enumerate(zones, 1):
    feats.append({"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(z["lon"], 6), round(z["lat"], 6)]},
        "properties": {"kind": "hotspot", "rank": rank, "buildings": z["buildings"],
                       "depth_mean_m": z["depth_mean"], "area_rai": z["area_rai"],
                       "radius_m": int((z["n"] * 900 / 3.1416) ** 0.5),
                       "label": f"จุดเสี่ยงอันดับ {rank}",
                       "rationale": f"ท่วมในเหตุการณ์ออกแบบ ~{z['depth_mean']} ม. · อาคารโดน {z['buildings']} หลัง"}})
for i, b in enumerate(bottlenecks, 1):
    feats.append({"type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(b["lon"], 6), round(b["lat"], 6)]},
        "properties": {"kind": "bottleneck", "rank": i, "drain_cm": b["drain_cm"],
                       "label": f"คอขวดระบายน้ำ {i}",
                       "rationale": f"น้ำไหลมารวมสูง แต่ความจุระบายเพียง {b['drain_cm']} ซม. → ควรเพิ่มท่อ/สูบ"}})
if levee and levee["polygon"]:
    ring = levee["polygon"] + [levee["polygon"][0]]
    feats.append({"type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [[[p[0], p[1]] for p in ring]]},
        "properties": {"kind": "levee", "protects_buildings": levee["protects_buildings"],
                       "area_rai": levee["area_rai"], "needs_pump": levee["needs_pump"],
                       "label": "แนวคันกั้นน้ำรอบพื้นที่เสี่ยงอันดับ 1",
                       "rationale": f"ล้อมคันกั้น+สูบ → ป้องกันอาคารได้ ~{levee['protects_buildings']} หลัง"}})

fc = {"type": "FeatureCollection", "name": "intervention_candidates",
      "_meta": {"design_stage_m": DESIGN_S, "method": "Priority-Flood screening on FABDEM 30m",
                "generated_by": "scripts/analyze_interventions.py"}, "features": feats}
json.dump(fc, open(os.path.join(D, "intervention_candidates.geojson"), "w", encoding="utf-8"), ensure_ascii=False)

# ---------- เขียน summary (สำหรับ panel จัดอันดับ) ----------
recs = []
for rank, z in enumerate(zones, 1):
    recs.append({"priority": rank, "type": "พื้นที่เสี่ยง (hotspot)",
                 "where": f"ละติจูด {z['lat']:.3f}, ลองจิจูด {z['lon']:.3f}",
                 "buildings": z["buildings"], "depth_mean_m": z["depth_mean"],
                 "measure": "คันกั้นน้ำรอบพื้นที่ + สถานีสูบ / ยกระดับถนนรอบนอก",
                 "expected": f"ป้องกันอาคารได้สูงสุด ~{z['buildings']} หลัง"})
for i, b in enumerate(bottlenecks, 1):
    recs.append({"priority": len(zones) + i, "type": "คอขวดระบายน้ำ (bottleneck)",
                 "where": f"ละติจูด {b['lat']:.3f}, ลองจิจูด {b['lon']:.3f}",
                 "drain_cm": b["drain_cm"],
                 "measure": "เพิ่มท่อ/คูระบาย หรือสถานีสูบ ณ จุดคอขวด",
                 "expected": "ระบายน้ำที่มารวมได้เร็วขึ้น ลดความลึก/ระยะเวลาท่วม"})
summary = {"design_stage_m": DESIGN_S,
           "baseline_buildings_flooded": bld_flooded0,
           "baseline_flood_cells": int(flooded0.sum()),
           "levee_demo": levee and {k: levee[k] for k in ("protects_buildings", "before", "after", "area_rai", "needs_pump")},
           "recommendations": recs,
           "method_note": "ระดับ screening บน Priority-Flood (DEM FABDEM 30 ม., ±5 ม.) — ใช้เลือกจุด/เทียบมาตรการ "
                          "ไม่ใช่ออกแบบขนาดจริง (ต้อง HEC-RAS 2D + SWMM + LiDAR)",
           "generated": __import__("datetime").date.today().isoformat()}
json.dump(summary, open(os.path.join(D, "intervention_summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n✅ wrote data/intervention_candidates.geojson ({len(feats)} features) + intervention_summary.json")
