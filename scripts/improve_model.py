#!/usr/bin/env python3
"""
(ก) ลด over-prediction → ดัน CSI: เทียบ bathtub ดิบ vs HAND (Height Above Nearest Drainage) + ความลาด
HAND = ความสูงของเซลล์เหนือ "ทางระบายที่ใกล้ที่สุด" (ตามทิศไหล D8) → ท่วมเฉพาะที่ลุ่มจริงตามการระบาย
calibrate กับขอบเขตดาวเทียม GISTDA แล้วดูว่าวิธีไหน CSI สูงสุด
"""
import os, json, heapq
import numpy as np
from skimage.draw import polygon as sk_polygon

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
G = json.load(open(os.path.join(ROOT, "data", "dem_grid.json")))
NC, NR = G["ncols"], G["nrows"]; N = NC*NR
ground = np.array(G["ground_m"], float)
g2 = ground.reshape(NR, NC)
olon, olat, dlon, dlat = G["origin_lon"], G["origin_lat"], G["dlon"], G["dlat"]
sg = np.sort(ground); base = sg[int(N*0.012)]; seed = sg[int(N*0.03)]
CELL_M = dlat * 111000  # ~ขนาดเซลล์ (เมตร)

# ---- connectivity arrival (minimax) ----
arrival = np.full(N, np.inf); h=[]
for i in range(N):
    if ground[i] <= seed: arrival[i]=ground[i]; h.append((ground[i],i))
heapq.heapify(h)
D4X=[-1,1,0,0]; D4Y=[0,0,-1,1]
while h:
    a,cur=heapq.heappop(h)
    if a>arrival[cur]: continue
    r,c=divmod(cur,NC)
    for k in range(4):
        rr,cc=r+D4Y[k],c+D4X[k]
        if 0<=rr<NR and 0<=cc<NC:
            ni=rr*NC+cc; na=a if a>ground[ni] else ground[ni]
            if na<arrival[ni]: arrival[ni]=na; heapq.heappush(h,(na,ni))
arrival=arrival.reshape(NR,NC)
perm = arrival <= base+0.3

# ---- HAND: D8 ลงทางระบาย (seed = ทางระบาย) ----
D8=[(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
drainElev=np.full((NR,NC), np.nan)
isSeed = g2 <= seed
drainElev[isSeed]=g2[isSeed]
order=np.argsort(ground)  # ต่ำ→สูง (ประมวลจากต่ำขึ้นไป ทางระบายพร้อมก่อน)
for idx in order:
    r,c=divmod(idx,NC)
    if not np.isnan(drainElev[r,c]): continue
    path=[]; rr,cc=r,c; guard=0
    while np.isnan(drainElev[rr,cc]) and guard<100000:
        path.append((rr,cc)); guard+=1
        # steepest descent
        be=g2[rr,cc]; nr,ncc=-1,-1
        for dr,dc in D8:
            a,b=rr+dr,cc+dc
            if 0<=a<NR and 0<=b<NC and g2[a,b]<be:
                be=g2[a,b]; nr,ncc=a,b
        if nr<0:  # pit (ไม่ไหลต่อ) → เป็นทางระบายเฉพาะที่
            drainElev[rr,cc]=g2[rr,cc]; break
        if not np.isnan(drainElev[nr,ncc]):
            de=drainElev[nr,ncc]
            for (pr,pc) in path: drainElev[pr,pc]=de
            break
        rr,cc=nr,ncc
    de=drainElev[rr,cc]
    for (pr,pc) in path:
        if np.isnan(drainElev[pr,pc]): drainElev[pr,pc]=de
HAND = np.maximum(0.0, g2 - drainElev)

# ---- slope (เมตร/เมตร) ----
gy=np.zeros((NR,NC)); gx=np.zeros((NR,NC))
gy[1:-1,:]=(g2[2:,:]-g2[:-2,:])/(2*CELL_M); gx[:,1:-1]=(g2[:,2:]-g2[:,:-2])/(2*CELL_M)
slope=np.sqrt(gx**2+gy**2)

# ---- observed GISTDA ----
obsg=np.zeros((NR,NC),bool)
gj=json.load(open(os.path.join(ROOT,"data","yala_flood_gistda_kmz.geojson")))
def rings(g):
    t=g.get("type")
    if t=="Polygon": yield g["coordinates"][0]
    elif t=="MultiPolygon":
        for p in g["coordinates"]: yield p[0]
    elif t=="GeometryCollection":
        for gg in g.get("geometries",[]): yield from rings(gg)
for f in gj.get("features",[]):
    for ring in rings(f.get("geometry") or {}):
        if len(ring)<3: continue
        lon=np.array([p[0] for p in ring]); lat=np.array([p[1] for p in ring])
        rp,cp=sk_polygon((olat-lat)/dlat-0.5,(lon-olon)/dlon-0.5,shape=(NR,NC)); obsg[rp,cp]=True
obs=obsg & ~perm

def csi(pred):
    pred=pred&~perm
    hit=int((pred&obs).sum()); miss=int((obs&~pred).sum()); fa=int((pred&~obs).sum())
    c=hit/(hit+miss+fa) if (hit+miss+fa) else 0
    pod=hit/(hit+miss) if (hit+miss) else 0
    far=fa/(hit+fa) if (hit+fa) else 0
    return c,pod,far,round(100*int(pred.sum())/N,1)

def best(fn, params):
    bv=None
    for p in params:
        c,pod,far,pct=csi(fn(p))
        if bv is None or c>bv[0]: bv=(c,pod,far,pct,p)
    return bv

# baseline bathtub
b0=best(lambda s:(arrival<=s)&(g2<s), np.arange(base+0.5,base+18,0.25))
# HAND: ท่วมถ้า HAND<=h และเชื่อมแม่น้ำ
bH=best(lambda h:(HAND<=h)&(arrival<=base+h+1.0), np.arange(0.3,8,0.2))
# HAND + slope mask
best_hs=None
for smax in [0.05,0.08,0.12,0.2,0.5]:
    bb=best(lambda h:(HAND<=h)&(arrival<=base+h+1.0)&(slope<smax), np.arange(0.3,8,0.2))
    if best_hs is None or bb[0]>best_hs[0][0]: best_hs=(bb,smax)

print(f"HAND สูงสุด {HAND.max():.0f} ม. · เซลล์ pit-drain แล้ว")
print(f"\n  bathtub ดิบ : CSI {b0[0]:.3f}  POD {b0[1]:.2f}  FAR {b0[2]:.2f}  ท่วม {b0[3]}%")
print(f"  HAND        : CSI {bH[0]:.3f}  POD {bH[1]:.2f}  FAR {bH[2]:.2f}  ท่วม {bH[3]}%  (h={bH[4]:.1f}ม.)")
print(f"  HAND+slope  : CSI {best_hs[0][0]:.3f}  POD {best_hs[0][1]:.2f}  FAR {best_hs[0][2]:.2f}  ท่วม {best_hs[0][3]}%  (h={best_hs[0][4]:.1f} slope<{best_hs[1]})")
imp=(bH[0]-b0[0])/b0[0]*100 if b0[0] else 0
print(f"\n  → HAND ทำให้ CSI {'ดีขึ้น' if imp>0 else 'ลดลง'} {abs(imp):.0f}%")

# บันทึก HAND กลับเข้า dem_grid เพื่อให้โมเดล 3D ใช้
G["hand_m"]=[round(float(x),1) for x in HAND.flatten()]
G["hand_calibrated_h"]=round(float(bH[4]),1)
json.dump(G, open(os.path.join(ROOT,"data","dem_grid.json"),"w"), separators=(",",":"))
print("✅ เพิ่ม hand_m เข้า data/dem_grid.json (ไว้ให้โมเดล 3D ใช้)")
