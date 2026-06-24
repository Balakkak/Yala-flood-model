#!/usr/bin/env python3
"""
เทียบความแม่นน้ำท่วม: AW3D30 (มีตึก/ต้นไม้) vs FABDEM (bare-earth)
รัน connectivity-flood + calibrate กับขอบเขตดาวเทียม GISTDA บนทั้งสอง DEM แล้วเทียบ CSI
"""
import os, json, heapq
import numpy as np, tifffile
from skimage.draw import polygon as sk_polygon

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
PX = 1/3600
W, E, S, N = 101.235, 101.330, 6.500, 6.600   # city crop

def crop(tif, lon0, lat0):
    a = tifffile.imread(tif).astype(np.float64)
    c0 = round((W-lon0)/PX); c1 = round((E-lon0)/PX)
    r0 = round((lat0-N)/PX); r1 = round((lat0-S)/PX)
    return a[r0:r1, c0:c1]

aw  = crop(os.path.join(ROOT,"data","output_AW3D30.tif"), 101.20, 6.70)
fab = crop(os.path.join(ROOT,"raw","fabdem_N06E101.tif"), 101.00, 7.00)
aw  = np.where((aw>-500)&(aw<9000), aw, 0.0)
fab = np.where((fab>-500)&(fab<9000), fab, 0.0)
NR, NC = aw.shape
print(f"grid {NC}x{NR}")
d = fab - aw
print(f"FABDEM−AW3D30: mean {d.mean():+.2f} ม. (ติดลบ=bare-earth ต่ำกว่า เพราะเอาตึก/ต้นไม้ออก) "
      f"| ต่ำลง >2ม. {100*np.mean(d<-2):.0f}% ของพื้นที่")

# observed GISTDA (rasterize ครั้งเดียว บนกริดนี้)
olon, olat, dlon, dlat = W, N, PX, PX
gj = json.load(open(os.path.join(ROOT,"data","yala_flood_gistda_kmz.geojson")))
observed = np.zeros((NR,NC), bool)
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
        rr=(olat-lat)/dlat-0.5; cc=(lon-olon)/dlon-0.5
        rp,cp=sk_polygon(rr,cc,shape=(NR,NC)); observed[rp,cp]=True

def best_csi(ground):
    g=ground.flatten(); Ncell=g.size
    sg=np.sort(g); base=sg[int(Ncell*0.012)]; seed=sg[int(Ncell*0.03)]
    arr=np.full(Ncell, np.inf); h=[]
    for i in range(Ncell):
        if g[i]<=seed: arr[i]=g[i]; h.append((g[i],i))
    heapq.heapify(h)
    DX=[-1,1,0,0]; DY=[0,0,-1,1]
    while h:
        a,cur=heapq.heappop(h)
        if a>arr[cur]: continue
        r,c=divmod(cur,NC)
        for k in range(4):
            rr,cc=r+DY[k],c+DX[k]
            if 0<=rr<NR and 0<=cc<NC:
                ni=rr*NC+cc; na=a if a>g[ni] else g[ni]
                if na<arr[ni]: arr[ni]=na; heapq.heappush(h,(na,ni))
    arr=arr.reshape(NR,NC); G2=ground; perm=arr<=base+0.3
    obs=observed&~perm
    bestv=None
    for s in np.arange(base+0.5, base+18, 0.25):
        pred=(arr<=s)&(G2<s)&~perm
        hit=int((pred&obs).sum()); miss=int((obs&~pred).sum()); fa=int((pred&~obs).sum())
        csi=hit/(hit+miss+fa) if (hit+miss+fa) else 0
        pod=hit/(hit+miss) if (hit+miss) else 0
        far=fa/(hit+fa) if (hit+fa) else 0
        dep=np.median((s-G2)[pred]) if pred.any() else 0
        if bestv is None or csi>bestv["CSI"]:
            bestv=dict(stage=round(float(s),2),CSI=round(csi,3),POD=round(pod,3),FAR=round(far,3),
                       pred_pct=round(100*int(pred.sum())/Ncell,1), depth=round(float(dep),2))
    return bestv

rAW = best_csi(aw); rFAB = best_csi(fab)
print(f"\nobserved (จริง) ท่วม {100*float(observed.sum())/observed.size:.1f}% ของกริด — ใช้เทียบ")
print("\n===== เทียบความแม่น (max-CSI) =====")
print(f"  AW3D30 : CSI {rAW['CSI']}  POD {rAW['POD']}  FAR {rAW['FAR']}  ท่วม {rAW['pred_pct']}%  ลึก {rAW['depth']}ม.")
print(f"  FABDEM : CSI {rFAB['CSI']}  POD {rFAB['POD']}  FAR {rFAB['FAR']}  ท่วม {rFAB['pred_pct']}%  ลึก {rFAB['depth']}ม.")
imp = (rFAB['CSI']-rAW['CSI'])/rAW['CSI']*100 if rAW['CSI'] else 0
print(f"  → CSI {'ดีขึ้น' if imp>0 else 'ลดลง'} {abs(imp):.0f}%")
