#!/usr/bin/env python3
"""
Calibration/Validation เทียบเหตุการณ์น้ำท่วมจริง (ขอบเขตดาวเทียม GISTDA)
----------------------------------------------------------------------
1. สร้างโมเดล connectivity-flood บน DEM 30 ม. (เหมือนในหน้า 3D)
2. แปลงขอบเขตน้ำท่วมจริง GISTDA → กริดเดียวกัน (observed)
3. กวาดหา "ระดับน้ำ (stage)" ที่ทำให้ขอบเขตโมเดลตรงของจริงที่สุด (max CSI)
4. รายงาน CSI / POD / FAR + ระดับน้ำที่ calibrate ได้ + ความลึกเทียบ AAR (0.8–1.0 ม.)

output: data/calibration_nov2568.json
หมายเหตุ: เป็น screening บน DEM 30 ม. — ตัวเลขนี้คือ "ความแม่นเท่าที่ข้อมูลปัจจุบันทำได้"
          เมื่อได้ LiDAR จะ calibrate ใหม่ได้แม่นกว่ามาก
"""
import os, json, heapq
import numpy as np
from skimage.draw import polygon as sk_polygon

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))

# ---------- 1. DEM grid + connectivity flood ----------
G = json.load(open(os.path.join(ROOT, "data", "dem_grid.json")))
NC, NR = G["ncols"], G["nrows"]; N = NC * NR
ground = np.array(G["ground_m"], dtype=np.float64)
olon, olat, dlon, dlat = G["origin_lon"], G["origin_lat"], G["dlon"], G["dlat"]

sortedG = np.sort(ground)
baseStage = sortedG[int(N * 0.012)]
seedLevel = sortedG[int(N * 0.03)]
print(f"DEM {NC}x{NR} | baseStage={baseStage:.1f} seedLevel={seedLevel:.1f} m")

# Priority-Flood: arrival[cell] = ระดับต่ำสุดที่เชื่อมแม่น้ำ (minimax)
arrival = np.full(N, np.inf)
heap = []
for i in range(N):
    if ground[i] <= seedLevel:
        arrival[i] = ground[i]; heap.append((ground[i], i))
heapq.heapify(heap)
DX = [-1, 1, 0, 0]; DY = [0, 0, -1, 1]
while heap:
    a, cur = heapq.heappop(heap)
    if a > arrival[cur]: continue
    r, c = divmod(cur, NC)
    for d in range(4):
        rr, cc = r + DY[d], c + DX[d]
        if 0 <= rr < NR and 0 <= cc < NC:
            ni = rr * NC + cc
            na = a if a > ground[ni] else ground[ni]
            if na < arrival[ni]:
                arrival[ni] = na; heapq.heappush(heap, (na, ni))
arrival = arrival.reshape(NR, NC)
ground2 = ground.reshape(NR, NC)
permanent = arrival <= baseStage + 0.3      # ร่องแม่น้ำ/แหล่งน้ำถาวร (ตัดออกจากการเทียบ)

# ---------- 2. rasterize observed GISTDA flood → grid ----------
gj = json.load(open(os.path.join(ROOT, "data", "yala_flood_gistda_kmz.geojson")))
observed = np.zeros((NR, NC), dtype=bool)

def rings_of(geom):
    t = geom.get("type")
    if t == "Polygon": yield geom["coordinates"][0]
    elif t == "MultiPolygon":
        for poly in geom["coordinates"]: yield poly[0]
    elif t == "GeometryCollection":
        for g in geom.get("geometries", []): yield from rings_of(g)

n_poly = 0
for f in gj.get("features", []):
    g = f.get("geometry") or {}
    for ring in rings_of(g):
        if len(ring) < 3: continue
        lon = np.array([p[0] for p in ring]); lat = np.array([p[1] for p in ring])
        cc = (lon - olon) / dlon - 0.5
        rr = (olat - lat) / dlat - 0.5
        rrp, ccp = sk_polygon(rr, cc, shape=(NR, NC))
        observed[rrp, ccp] = True; n_poly += 1
obs = observed & ~permanent
print(f"observed polygons: {n_poly} | observed cells (land): {obs.sum()} ({100*obs.sum()/N:.1f}% ของกริด)")

# ---------- 3. กวาดหา stage ที่ CSI สูงสุด ----------
def contingency(stage):
    pred = (arrival <= stage) & (ground2 < stage) & ~permanent
    hits = int(np.sum(pred & obs)); miss = int(np.sum(obs & ~pred)); fa = int(np.sum(pred & ~obs))
    csi = hits / (hits + miss + fa) if (hits + miss + fa) else 0
    pod = hits / (hits + miss) if (hits + miss) else 0
    far = fa / (hits + fa) if (hits + fa) else 0
    bias = (hits + fa) / (hits + miss) if (hits + miss) else 0
    return dict(stage=round(float(stage), 2), CSI=round(csi, 3), POD=round(pod, 3),
                FAR=round(far, 3), bias=round(bias, 2), pred_pct=round(100*int(pred.sum())/N, 1))

stages = np.arange(baseStage + 0.5, baseStage + 18, 0.25)
results = [contingency(s) for s in stages]
best = max(results, key=lambda r: r["CSI"])
S = best["stage"]

# จุดทำงานอื่นเพื่อเทียบ trade-off
obs_pct = 100 * float(obs.sum()) / N
matched = min(results, key=lambda r: abs(r["pred_pct"] - obs_pct))   # ขอบเขตเท่าจริง (bias≈1)
def median_depth_at(stage):
    p = (arrival <= stage) & (ground2 < stage) & ~permanent
    dd = (stage - ground2)[p]; return float(np.median(dd)) if dd.size else 0
depth_target = min(results, key=lambda r: abs(median_depth_at(r["stage"]) - 0.9))  # ลึก ~0.9 ม.(AAR)
print("\n--- จุดทำงานเทียบ ---")
print(f"  [max-CSI]       stage {best['stage']}  CSI {best['CSI']} POD {best['POD']} FAR {best['FAR']} ท่วม {best['pred_pct']}%")
print(f"  [ขอบเขต=จริง]   stage {matched['stage']}  CSI {matched['CSI']} POD {matched['POD']} FAR {matched['FAR']} ท่วม {matched['pred_pct']}%")
print(f"  [ลึก~AAR 0.9ม.] stage {depth_target['stage']}  CSI {depth_target['CSI']} POD {depth_target['POD']} ท่วม {depth_target['pred_pct']}% ลึก~{median_depth_at(depth_target['stage']):.2f}ม.")

# ---------- 4. ความลึก ณ stage ที่ calibrate ----------
pred = (arrival <= S) & (ground2 < S) & ~permanent
depths = (S - ground2)[pred]
depth_med = float(np.median(depths)) if depths.size else 0
depth_p95 = float(np.percentile(depths, 95)) if depths.size else 0

print("\n===== ผล Calibration (เทียบขอบเขตดาวเทียม GISTDA) =====")
print(f"  ระดับน้ำที่ calibrate ได้ (stage*) = {S:.2f} ม. (เหนือฐาน {S-baseStage:.1f} ม.)")
print(f"  CSI = {best['CSI']}  · POD(จับโดน) = {best['POD']}  · FAR(เตือนเกิน) = {best['FAR']}  · bias = {best['bias']}")
print(f"  พื้นที่ท่วมโมเดล {best['pred_pct']}%  vs จริง {100*obs.sum()/N:.1f}%")
print(f"  ความลึกบนพื้นดิน: median {depth_med:.2f} ม. · p95 {depth_p95:.2f} ม.  (AAR ย่านเศรษฐกิจ 0.8–1.0 ม.)")

out = {
    "ground_truth": "GISTDA satellite flood extent (เหตุการณ์ใหญ่ พื้นที่ยะลา)",
    "method": "connectivity-flood (Priority-Flood) บน AW3D30 30 ม.",
    "calibrated_stage_m": S,
    "stage_above_base_m": round(S - baseStage, 2),
    "CSI": best["CSI"], "POD": best["POD"], "FAR": best["FAR"], "bias": best["bias"],
    "pred_flood_pct": best["pred_pct"], "observed_flood_pct": round(100*float(obs.sum())/N, 1),
    "depth_median_m": round(depth_med, 2), "depth_p95_m": round(depth_p95, 2),
    "aar_reference_depth_m": "0.8-1.0",
    "note": "screening บน DEM 30 ม. — ความแม่นเท่าที่ข้อมูลปัจจุบันทำได้; ได้ LiDAR จะแม่นขึ้นมาก",
    "stage_sweep": results,
    "generated": "2026-06-16",
}
with open(os.path.join(ROOT, "data", "calibration_nov2568.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("\n✅ บันทึก data/calibration_nov2568.json")
