#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
simplify_geojson.py — ลดขนาดไฟล์ GeoJSON ที่เบราว์เซอร์โหลด (perf)
--------------------------------------------------------------------------
ลดขนาดแบบ "ปลอดภัย" ไม่เปลี่ยน topology อย่างมีนัยสำคัญ:
  1) ปัดพิกัดเหลือ N ตำแหน่งทศนิยม (default 5 = ~1.1 ม. ที่เส้นศูนย์สูตร)
     ข้อมูล KMZ/GISTDA เดิมมี ~13 ตำแหน่ง (ระดับต่ำกว่าไมครอน) — เกินจำเป็นมาก
  2) ตัดค่า Z (ความสูง) ที่มักเป็น 0 จาก KMZ ออก → ประหยัด ~1/3 ของพิกัด
  3) ตัดจุดที่ซ้ำกันติดกันหลังปัดเศษ
  4) ทิ้ง ring/เส้น/โพลิกอนที่เหลือจุดน้อยเกินไป (degenerate)

ใช้: python3 scripts/simplify_geojson.py <file.geojson> [ndp]   (เขียนทับที่เดิม)
หมายเหตุ: ไฟล์ data/ สร้างใหม่ได้จากสคริปต์ fetch/convert ใน scripts/
"""
import json
import os
import sys


def rnd(v, ndp):
    return round(float(v), ndp)


def clean_line(coords, ndp, is_ring):
    out = []
    for p in coords:
        rp = [rnd(p[0], ndp), rnd(p[1], ndp)]   # ตัด z ทิ้ง (เก็บแค่ x,y)
        if not out or out[-1] != rp:
            out.append(rp)
    if is_ring:
        if out and out[0] != out[-1]:
            out.append(out[0][:])
        if len(out) < 4:
            return None
    else:
        if len(out) < 2:
            return None
    return out


def clean_polygon(rings, ndp):
    if not rings:
        return None
    ext = clean_line(rings[0], ndp, True)
    if ext is None:
        return None
    out = [ext]
    for hole in rings[1:]:
        h = clean_line(hole, ndp, True)
        if h is not None:
            out.append(h)
    return out


def clean_geom(g, ndp):
    if not g:
        return None
    t = g.get("type")
    if t == "Point":
        c = g["coordinates"]
        g["coordinates"] = [rnd(c[0], ndp), rnd(c[1], ndp)]
        return g
    if t == "MultiPoint":
        g["coordinates"] = [[rnd(p[0], ndp), rnd(p[1], ndp)] for p in g["coordinates"]]
        return g
    if t == "LineString":
        c = clean_line(g["coordinates"], ndp, False)
        if c is None:
            return None
        g["coordinates"] = c
        return g
    if t == "MultiLineString":
        out = [c for c in (clean_line(l, ndp, False) for l in g["coordinates"]) if c]
        if not out:
            return None
        g["coordinates"] = out
        return g
    if t == "Polygon":
        c = clean_polygon(g["coordinates"], ndp)
        if c is None:
            return None
        g["coordinates"] = c
        return g
    if t == "MultiPolygon":
        out = [c for c in (clean_polygon(p, ndp) for p in g["coordinates"]) if c]
        if not out:
            return None
        g["coordinates"] = out
        return g
    if t == "GeometryCollection":
        out = [c for c in (clean_geom(gg, ndp) for gg in g.get("geometries", [])) if c]
        if not out:
            return None
        g["geometries"] = out
        return g
    return g  # ชนิดที่ไม่รู้จัก — ปล่อยผ่าน


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    ndp = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    before = os.path.getsize(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    dropped = 0
    if data.get("type") == "FeatureCollection":
        kept = []
        for feat in data["features"]:
            g = clean_geom(feat.get("geometry"), ndp)
            if g is None:
                dropped += 1
                continue
            feat["geometry"] = g
            kept.append(feat)
        data["features"] = kept
    elif data.get("type") == "Feature":
        data["geometry"] = clean_geom(data.get("geometry"), ndp)
    else:
        data = clean_geom(data, ndp)

    # เขียนแบบกระชับ (ไม่มีช่องว่าง) + ตัด unicode escape เพื่อให้ไฟล์เล็กและอ่านออก
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    after = os.path.getsize(path)
    pct = (1 - after / before) * 100 if before else 0
    print("%-46s %7.1fMB -> %6.1fMB  (-%4.1f%%)  ndp=%d  dropped=%d"
          % (os.path.basename(path), before / 1e6, after / 1e6, pct, ndp, dropped))


if __name__ == "__main__":
    main()
