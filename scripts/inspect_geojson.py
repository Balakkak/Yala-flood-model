import json

with open('data/yala_drainage_system.geojson', encoding='utf-8') as f:
    gj = json.load(f)
lons, lats = [], []
for feat in gj['features']:
    for c in feat['geometry']['coordinates']:
        lons.append(c[0]); lats.append(c[1])
print(f"Drainage bbox: lon {min(lons):.3f}-{max(lons):.3f}, lat {min(lats):.3f}-{max(lats):.3f}")

with open('data/yala_overflow_flood_official.geojson', encoding='utf-8') as f:
    gj2 = json.load(f)
for i in [0, 100, 500, 1000]:
    feat = gj2['features'][i]
    geom = feat['geometry']
    sub = geom['geometries'][0]
    name = feat['properties']['name']
    print(f"Overflow[{i}]: name={name!r} sub={sub['type']} coords={len(sub['coordinates'])}")

with open('data/yala_drainage_basin_boundary.geojson', encoding='utf-8') as f:
    gj3 = json.load(f)
feat3 = gj3['features'][0]
ring = feat3['geometry']['coordinates'][0]
print(f"Basin[0]: props={feat3['properties']} ring_len={len(ring)}")
lons2 = [c[0] for c in ring]; lats2 = [c[1] for c in ring]
print(f"Basin[0] bbox: lon {min(lons2):.3f}-{max(lons2):.3f}, lat {min(lats2):.3f}-{max(lats2):.3f}")

with open('data/yala_flood_villages.geojson', encoding='utf-8') as f:
    gj4 = json.load(f)
lons4 = [f['geometry']['coordinates'][0] for f in gj4['features']]
lats4 = [f['geometry']['coordinates'][1] for f in gj4['features']]
print(f"Villages bbox: lon {min(lons4):.3f}-{max(lons4):.3f}, lat {min(lats4):.3f}-{max(lats4):.3f}")
print(f"Village names: {[f['properties']['name'] for f in gj4['features'][:5]]}")
