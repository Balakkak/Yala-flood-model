#!/usr/bin/env python3
"""Convert KMZ/SHP files from the flood data folder to GeoJSON for the Yala dashboard."""
import sys, os, zipfile, json, re
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_ROOT = os.path.join(BASE, "data", "_น้ำท่วม")  # _น้ำท่วม
OUT = os.path.join(BASE, "data")


# ── KML helpers ──────────────────────────────────────────────────────────────

def strip_ns(text):
    # Remove CDATA sections (may contain HTML with XML namespaces that break the parser)
    text = re.sub(r'<!\[CDATA\[.*?\]\]>', '', text, flags=re.DOTALL)
    # Remove all namespace declarations
    text = re.sub(r'\s+xmlns(?::\w+)?="[^"]*"', '', text)
    # Remove namespace prefixes from tags (e.g. <kml:Placemark> -> <Placemark>)
    text = re.sub(r'<(/?)[\w-]+:', r'<\1', text)
    # Remove namespace prefixes from attributes (e.g. xsi:schemaLocation -> schemaLocation)
    text = re.sub(r'\s[\w-]+:[\w-]+=', lambda m: ' ' + m.group(0).strip().split(':',1)[1], text)
    return text


def parse_coords(s):
    pts = []
    for tok in (s or '').strip().split():
        p = tok.split(',')
        if len(p) >= 2:
            try:
                pts.append([float(p[0]), float(p[1])])
            except ValueError:
                pass
    return pts


def placemark_to_feature(pm):
    name = (pm.findtext('name') or '').strip()
    desc = (pm.findtext('description') or '').strip()
    props = {'name': name, 'description': desc}
    for sd in pm.findall('.//SimpleData'):
        k = sd.get('name', '')
        if k:
            props[k] = (sd.text or '').strip()

    geom = None

    c = pm.findtext('Point/coordinates')
    if c:
        pts = parse_coords(c)
        if pts:
            geom = {'type': 'Point', 'coordinates': pts[0]}

    c = pm.findtext('LineString/coordinates')
    if c:
        pts = parse_coords(c)
        if len(pts) >= 2:
            geom = {'type': 'LineString', 'coordinates': pts}

    c = pm.findtext('.//outerBoundaryIs/LinearRing/coordinates')
    if c:
        pts = parse_coords(c)
        if len(pts) >= 3:
            rings = [pts]
            for inner in pm.findall('.//innerBoundaryIs/LinearRing/coordinates'):
                ipts = parse_coords(inner.text or '')
                if len(ipts) >= 3:
                    rings.append(ipts)
            geom = {'type': 'Polygon', 'coordinates': rings}

    mg = pm.find('MultiGeometry')
    if mg is not None:
        sub = []
        for ls in mg.findall('LineString'):
            c = ls.findtext('coordinates')
            if c:
                pts = parse_coords(c)
                if len(pts) >= 2:
                    sub.append({'type': 'LineString', 'coordinates': pts})
        for poly in mg.findall('Polygon'):
            c = poly.findtext('.//outerBoundaryIs/LinearRing/coordinates')
            if c:
                pts = parse_coords(c)
                if len(pts) >= 3:
                    sub.append({'type': 'Polygon', 'coordinates': [pts]})
        for pt in mg.findall('Point'):
            c = pt.findtext('coordinates')
            if c:
                pts = parse_coords(c)
                if pts:
                    sub.append({'type': 'Point', 'coordinates': pts[0]})
        if sub:
            geom = {'type': 'GeometryCollection', 'geometries': sub}

    if geom:
        return {'type': 'Feature', 'geometry': geom, 'properties': props}
    return None


def kmz_to_geojson(path):
    with zipfile.ZipFile(path) as z:
        kml_name = next((n for n in z.namelist() if n.lower().endswith('.kml')), None)
        if not kml_name:
            raise ValueError("No KML inside KMZ")
        raw = z.read(kml_name).decode('utf-8', errors='replace')
    raw = strip_ns(raw)
    root = ET.fromstring(raw)
    features = [f for pm in root.iter('Placemark') for f in [placemark_to_feature(pm)] if f]
    return {'type': 'FeatureCollection', 'features': features}


# ── File finder ──────────────────────────────────────────────────────────────

def find_file(name_pattern, root=DATA_ROOT):
    """Walk DATA_ROOT and return the first file whose name matches name_pattern (case-insensitive)."""
    pat = name_pattern.lower()
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.lower() == pat:
                return os.path.join(dirpath, f)
    return None


# ── Conversions ───────────────────────────────────────────────────────────────

CONVERSIONS = [
    # (kmz_filename,                                   output_geojson)
    ("47 Major River YALA - mitrearth.kmz",           "yala_major_river_validated.geojson"),
    ("47 Drainage System YALA - mitrearth.KMZ",        "yala_drainage_system.geojson"),
    ("47 Drainage Basin YALA - mitrearth.KMZ",         "yala_drainage_basin_boundary.geojson"),
    ("47_Overflow_Flood_YALA_-_mitrearth.kmz",         "yala_overflow_flood_official.geojson"),
    ("47 Flood Riverbank YALA - mitrearth.kmz",        "yala_riverbank_flood.geojson"),
    ("47_Flood_Susceptible_Village_YALA_-_mitrearth.kmz", "yala_flood_villages.geojson"),
    ("47 Flood GISTDA YALA - mitrearth.kmz",           "yala_flood_gistda_kmz.geojson"),
]


def main():
    ok, fail = 0, 0
    for kmz_name, out_name in CONVERSIONS:
        src = find_file(kmz_name)
        out_path = os.path.join(OUT, out_name)
        if not src:
            print(f"  SKIP (not found): {kmz_name}")
            continue
        try:
            gj = kmz_to_geojson(src)
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(gj, f, ensure_ascii=False)
            print(f"  OK  {out_name}: {len(gj['features'])} features")
            ok += 1
        except Exception as e:
            print(f"  ERR {kmz_name}: {e}")
            fail += 1

    print(f"\nDone: {ok} converted, {fail} failed")


if __name__ == "__main__":
    main()
