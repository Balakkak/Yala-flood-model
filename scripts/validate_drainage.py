#!/usr/bin/env python3
"""
วัดผล: การฝังข้อมูลโครงสร้างระบายน้ำจริง (ทางน้ำ/สูบ/ฝาท่อ) ช่วยให้แม่นขึ้นไหม?
เทียบ CSI/POD/FAR กับขอบเขตน้ำท่วมจริงดาวเทียม GISTDA (เหตุการณ์ พ.ย.2568)
  A) baseline : seed จาก percentile ต่ำสุด · ไม่หักความจุระบาย  (โมเดลเดิม)
  B) improved : seed จากทางน้ำจริง (channel) · หักความจุระบาย drain (โมเดลใหม่)
รัน: python3 scripts/validate_drainage.py
"""
import os, json, heapq
import numpy as np
from skimage.draw import polygon as sk_polygon

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
D = os.path.join(ROOT, "data")
G = json.load(open(os.path.join(D, "dem_grid.json")))
NC, NR = G["ncols"], G["nrows"]; N = NC * NR
ground = np.array(G["ground_m"], float)
olon, olat, dlon, dlat = G["origin_lon"], G["origin_lat"], G["dlon"], G["dlat"]
sg = np.sort(ground); base = float(sg[int(N*0.012)]); seed = float(sg[int(N*0.03)])

channel = np.zeros(N, bool)
if G.get("channel"): channel[np.array(G["channel"], int)] = True
drain = (np.array(G["drain_cm"], float)/100.0) if G.get("drain_cm") else np.zeros(N)

def priority_flood(use_channel):
    arr = np.full(N, np.inf); h = []
    for i in range(N):
        if (channel[i] if use_channel else False) or ground[i] <= seed:
            arr[i] = ground[i]; h.append((ground[i], i))
    heapq.heapify(h)
    DX=[-1,1,0,0]; DY=[0,0,-1,1]
    while h:
        a, cur = heapq.heappop(h)
        if a > arr[cur]: continue
        r, c = divmod(cur, NC)
        for k in range(4):
            rr, cc = r+DY[k], c+DX[k]
            if 0<=rr<NR and 0<=cc<NC:
                ni = rr*NC+cc; na = a if a>ground[ni] else ground[ni]
                if na < arr[ni]: arr[ni]=na; heapq.heappush(h,(na,ni))
    return arr

# observed GISTDA
obs = np.zeros((NR, NC), bool)
gj = json.load(open(os.path.join(D, "yala_flood_gistda_kmz.geojson")))
def rings(g):
    t=g.get("type")
    if t=="Polygon": yield g["coordinates"][0]
    elif t=="MultiPolygon":
        for p in g["coordinates"]: yield p[0]
    elif t=="GeometryCollection":
        for gg in g.get("geometries",[]): yield from rings(gg)
for f in gj.get("features", []):
    for ring in rings(f.get("geometry") or {}):
        if len(ring) < 3: continue
        lon=np.array([p[0] for p in ring]); lat=np.array([p[1] for p in ring])
        rp,cp = sk_polygon((olat-lat)/dlat-0.5, (lon-olon)/dlon-0.5, shape=(NR,NC)); obs[rp,cp]=True
obs = obs.flatten()

def best_csi(arr, use_drain):
    perm = arr <= base + 0.3
    o = obs & ~perm
    dr = drain if use_drain else np.zeros(N)
    best = None
    for s in np.arange(base+0.5, base+18, 0.25):
        depth = s - ground - dr
        pred = (arr <= s) & (depth > 0) & ~perm
        hit=int((pred&o).sum()); miss=int((o&~pred).sum()); fa=int((pred&~o).sum())
        csi = hit/(hit+miss+fa) if (hit+miss+fa) else 0
        pod = hit/(hit+miss) if (hit+miss) else 0
        far = fa/(hit+fa) if (hit+fa) else 0
        if best is None or csi > best["CSI"]:
            best = dict(stage=round(float(s),2), CSI=round(csi,3), POD=round(pod,3),
                        FAR=round(far,3), pred_pct=round(100*int(pred.sum())/N,1))
    return best

arrP = priority_flood(False)   # percentile seed (เดิม)
arrC = priority_flood(True)    # channel seed (ใหม่)
A = best_csi(arrP, False)      # baseline
B = best_csi(arrC, True)       # improved

print("เทียบกับขอบเขตน้ำท่วมจริงดาวเทียม GISTDA (พ.ย.2568)")
print(f"  observed ท่วม {100*float(obs.sum())/N:.1f}% ของกริด\n")
print("                 CSI    POD    FAR    ท่วม%   stage")
print(f"  A) เดิม      : {A['CSI']:.3f}  {A['POD']:.3f}  {A['FAR']:.3f}  {A['pred_pct']:>5}  {A['stage']}")
print(f"  B) +ระบายน้ำ : {B['CSI']:.3f}  {B['POD']:.3f}  {B['FAR']:.3f}  {B['pred_pct']:>5}  {B['stage']}")
dC = (B['CSI']-A['CSI'])/A['CSI']*100 if A['CSI'] else 0
dF = (B['FAR']-A['FAR'])*100
print(f"\n  → CSI {'ดีขึ้น' if dC>=0 else 'ลดลง'} {abs(dC):.1f}%  ·  "
      f"FAR (เตือนเกิน) {'ลด' if dF<=0 else 'เพิ่ม'} {abs(dF):.1f} จุด  ·  "
      f"พื้นที่เตือนเกิน {A['pred_pct']}%→{B['pred_pct']}%")

out = {"reference": "GISTDA satellite flood extent พ.ย.2568",
       "baseline": A, "improved_drainage": B,
       "csi_change_pct": round(dC,1),
       "note": "B ใช้ทางน้ำจริงเป็น seed + หักความจุระบาย(สูบ+ฝาท่อ)",
       "generated": "2026-06-18"}
json.dump(out, open(os.path.join(D, "validation_drainage.json"), "w"), ensure_ascii=False, indent=2)
print("\n✅ บันทึก data/validation_drainage.json")
