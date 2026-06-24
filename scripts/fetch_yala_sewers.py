#!/usr/bin/env python3
"""
ดึงข้อมูลระบบระบายน้ำ (ท่อระบายน้ำ / คูระบายน้ำ / คลองในเขตเทศบาล)
จาก OpenStreetMap ผ่าน Overpass API — ขอบเขตเทศบาลนครยะลา
บันทึกเป็น data/yala_sewers.geojson
"""
import sys, json, os, urllib.request, urllib.parse

sys.stdout.reconfigure(encoding='utf-8')

# ขอบเขตเทศบาลนครยะลา (Yala municipality)
S, W, N, E = 6.495, 101.230, 6.590, 101.345

QUERY = f"""
[out:json][timeout:120];
(
  way["waterway"~"^(drain|ditch|canal|stream)$"]({S},{W},{N},{E});
  way["man_made"="pipeline"]["substance"~"sewage|wastewater"]({S},{W},{N},{E});
  way["tunnel"="culvert"]["waterway"]({S},{W},{N},{E});
  node["man_made"="manhole"]({S},{W},{N},{E});
  node["man_made"="pumping_station"]({S},{W},{N},{E});
  node["waterway"="drain"]({S},{W},{N},{E});
);
out geom;
"""

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch_osm():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    for url in ENDPOINTS:
        try:
            print(f"  querying {url} ...")
            req = urllib.request.Request(url, data=data,
                                         headers={"User-Agent": "yala-flood-gis/1.0"})
            with urllib.request.urlopen(req, timeout=150) as r:
                return json.load(r)
        except Exception as e:
            print(f"  failed: {e}")
    sys.exit("Overpass ไม่ตอบสนองทุก endpoint")


KIND_LABELS = {
    "drain":    "ท่อระบาย/คูระบายน้ำ",
    "ditch":    "คูน้ำ",
    "canal":    "คลองชลประทาน",
    "stream":   "ลำธาร",
    "manhole":  "บ่อพัก (manhole)",
    "pumping_station": "สถานีสูบน้ำ",
    "culvert":  "ท่อลอดเหลี่ยม",
    "pipeline": "ท่อส่งน้ำ",
}


def to_geojson(osm):
    features = []
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        name = tags.get("name", "")

        wtype = (
            tags.get("waterway") or
            ("pipeline" if tags.get("man_made") == "pipeline" else None) or
            ("manhole" if tags.get("man_made") == "manhole" else None) or
            ("pumping_station" if tags.get("man_made") == "pumping_station" else None) or
            "water"
        )
        label = KIND_LABELS.get(wtype, wtype)

        props = {
            "name": name,
            "kind": wtype,
            "label": label,
            "tunnel": tags.get("tunnel", ""),
            "covered": tags.get("covered", ""),
            "layer": tags.get("layer", "0"),
        }

        if el["type"] == "way" and "geometry" in el:
            coords = [[p["lon"], p["lat"]] for p in el["geometry"]]
            if len(coords) < 2:
                continue
            is_closed = (coords[0] == coords[-1] and len(coords) >= 4 and
                         wtype in ("water", "canal"))
            geom = ({"type": "Polygon", "coordinates": [coords]} if is_closed
                    else {"type": "LineString", "coordinates": coords})
            features.append({"type": "Feature", "geometry": geom, "properties": props})

        elif el["type"] == "node" and "lat" in el:
            geom = {"type": "Point", "coordinates": [el["lon"], el["lat"]]}
            features.append({"type": "Feature", "geometry": geom, "properties": props})

    return {"type": "FeatureCollection", "features": features}


def main():
    raw = fetch_osm()
    gj = to_geojson(raw)

    out = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "yala_sewers.geojson"))
    with open(out, "w", encoding="utf-8") as f:
        json.dump(gj, f, ensure_ascii=False)

    kinds = {}
    for feat in gj["features"]:
        k = feat["properties"]["kind"]
        kinds[k] = kinds.get(k, 0) + 1
    named = sorted({feat["properties"]["name"] for feat in gj["features"]
                    if feat["properties"]["name"]})

    print(f"Saved {len(gj['features'])} features -> {out}")
    print("  kinds:", kinds)
    if named:
        print("  named:", ", ".join(named[:30]))


if __name__ == "__main__":
    main()
