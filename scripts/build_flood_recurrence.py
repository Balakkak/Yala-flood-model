#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_flood_recurrence.py
--------------------------------------------------------------------------
สร้าง data/yala_flood_recurrence.geojson — ชั้น "validation" รายตำบล
ที่ใช้ในหน้า dashboard (เทียบผลโมเดลกับน้ำท่วมจริง)

แหล่งข้อมูลจริงล้วน (ไม่มีการสมมุติตัวเลข):
  - data/yala_tambons.geojson            14 ตำบล อ.เมืองยะลา (โพลิกอน)
  - data/yala_flood_gistda_kmz.geojson   พื้นที่น้ำท่วม GISTDA (โพลิกอน 3,668 รูป)
  - data/yala_flood_villages.geojson     จุดหมู่บ้านที่เคยประสบอุทกภัย (921 จุด)

สำหรับแต่ละตำบลคำนวณ "ตัวชี้วัดความเสี่ยงน้ำท่วมจริง" 2 ค่า:
  flood_area_pct  = % พื้นที่ตำบลที่ทับซ้อนกับพื้นที่น้ำท่วม GISTDA
                    (ประมาณด้วย grid-sampling / Monte-Carlo บนกริดสม่ำเสมอ)
  flood_villages  = จำนวนจุดหมู่บ้านที่เคยประสบอุทกภัยภายในตำบล

หมายเหตุความตรงไปตรงมา:
  ข้อมูล GISTDA ที่มีอยู่เป็น "ขอบเขตพื้นที่เคยท่วม" รวม ไม่มีปีรายเหตุการณ์
  จึงรายงานเป็น "สัดส่วนพื้นที่เสี่ยง/จำนวนจุดที่เคยท่วม" ตามข้อมูลจริง
  ไม่ใช่ "จำนวนครั้งที่ท่วม" ที่ประดิษฐ์ขึ้น
"""
import json
import os
import math

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

GRID_STEP_DEG = 0.0012      # ~130 ม. ที่ละติจูดยะลา — ความละเอียดของ grid-sampling
INDEX_CELL_DEG = 0.01       # ขนาดช่องของ spatial index สำหรับ prefilter โพลิกอนน้ำท่วม


def load(fn):
    with open(os.path.join(DATA, fn), encoding="utf-8") as f:
        return json.load(f)


def ring_bbox(ring):
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return (min(xs), min(ys), max(xs), max(ys))


def point_in_ring(x, y, ring):
    """ray-casting even-odd บนวงเดียว ([[lon,lat],...])"""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-30) + xi):
            inside = not inside
        j = i
    return inside


def point_in_polygon(x, y, rings):
    """rings = [exterior, hole1, hole2, ...] — inside ก็ต่อเมื่ออยู่ใน exterior และไม่อยู่ใน hole"""
    if not rings:
        return False
    if not point_in_ring(x, y, rings[0]):
        return False
    for hole in rings[1:]:
        if point_in_ring(x, y, hole):
            return False
    return True


def polygons_of(geom):
    """คืน list ของ polygon โดยแต่ละ polygon = [exterior, hole...] รองรับ Polygon/MultiPolygon/GeometryCollection"""
    if not geom:
        return []
    t = geom.get("type")
    if t == "Polygon":
        return [geom["coordinates"]]
    if t == "MultiPolygon":
        return [poly for poly in geom["coordinates"]]
    if t == "GeometryCollection":
        out = []
        for g in geom.get("geometries", []):
            out.extend(polygons_of(g))
        return out
    return []


def main():
    tambons = load("yala_tambons.geojson")
    flood = load("yala_flood_gistda_kmz.geojson")
    villages = load("yala_flood_villages.geojson")

    # ---- เตรียมโพลิกอนน้ำท่วม + spatial index (grid ของ INDEX_CELL_DEG) ----
    flood_polys = []  # list of (bbox, rings)
    for feat in flood["features"]:
        for rings in polygons_of(feat.get("geometry")):
            if not rings or len(rings[0]) < 3:
                continue
            flood_polys.append((ring_bbox(rings[0]), rings))

    index = {}  # (cx,cy) -> [poly_idx,...]

    def cell(x, y):
        return (math.floor(x / INDEX_CELL_DEG), math.floor(y / INDEX_CELL_DEG))

    for idx, (bb, _) in enumerate(flood_polys):
        cx0, cy0 = cell(bb[0], bb[1])
        cx1, cy1 = cell(bb[2], bb[3])
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                index.setdefault((cx, cy), []).append(idx)

    print(f"flood polygons: {len(flood_polys)}  index cells: {len(index)}")

    def in_any_flood(x, y):
        cand = index.get(cell(x, y))
        if not cand:
            return False
        for i in cand:
            bb, rings = flood_polys[i]
            if bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3] and point_in_polygon(x, y, rings):
                return True
        return False

    # ---- จุดหมู่บ้านน้ำท่วม ----
    vpts = []
    for f in villages["features"]:
        g = f.get("geometry") or {}
        if g.get("type") == "Point":
            vpts.append((g["coordinates"][0], g["coordinates"][1]))

    out_features = []
    for feat in tambons["features"]:
        p = feat["properties"]
        name = p.get("adm3_name1") or p.get("adm3_name") or "?"
        polys = polygons_of(feat.get("geometry"))
        if not polys:
            continue

        # bbox รวมของตำบล
        xs, ys = [], []
        for rings in polys:
            for ring in rings:
                for pt in ring:
                    xs.append(pt[0]); ys.append(pt[1])
        minx, miny, maxx, maxy = min(xs), min(ys), max(xs), max(ys)

        # grid-sampling: นับจุดในตำบล (denominator) และจุดที่ตกในพื้นที่น้ำท่วม (numerator)
        inside_n = 0
        flooded_n = 0
        y = miny
        while y <= maxy:
            x = minx
            while x <= maxx:
                in_tambon = any(point_in_polygon(x, y, rings) for rings in polys)
                if in_tambon:
                    inside_n += 1
                    if in_any_flood(x, y):
                        flooded_n += 1
                x += GRID_STEP_DEG
            y += GRID_STEP_DEG

        area_pct = round(100.0 * flooded_n / inside_n, 1) if inside_n else 0.0

        # นับจุดหมู่บ้านน้ำท่วมในตำบล
        vcount = 0
        for (vx, vy) in vpts:
            if minx <= vx <= maxx and miny <= vy <= maxy:
                if any(point_in_polygon(vx, vy, rings) for rings in polys):
                    vcount += 1

        out_features.append({
            "type": "Feature",
            "properties": {
                "subdistrict": name,
                "subdistrict_en": p.get("adm3_name") or "",
                "flood_area_pct": area_pct,     # % พื้นที่เสี่ยงน้ำท่วม (GISTDA)
                "flood_villages": vcount,       # จำนวนจุดหมู่บ้านเคยท่วม
                "area_sqkm": round(p.get("area_sqkm") or 0, 2),
                "source": "GISTDA flood extent + flood villages, aggregated per tambon",
            },
            "geometry": feat["geometry"],
        })
        print(f"  {name:<12} area%={area_pct:>5}  villages={vcount:>3}  (samples in={inside_n})")

    fc = {
        "type": "FeatureCollection",
        "name": "yala_flood_recurrence",
        "_meta": {
            "description": "Per-tambon historical flood exposure (real GISTDA data). "
                           "flood_area_pct = % of tambon area within GISTDA flood extent "
                           "(grid-sampled); flood_villages = recorded flood-affected village points inside.",
            "crs": "EPSG:4326",
            "generated_by": "scripts/build_flood_recurrence.py",
        },
        "features": out_features,
    }

    out_path = os.path.join(DATA, "yala_flood_recurrence.geojson")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False)
    print(f"\nwrote {out_path}  ({len(out_features)} tambons)")


if __name__ == "__main__":
    main()
