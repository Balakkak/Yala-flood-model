import requests
import json
import time

query = """
[out:json];
area["name"="จังหวัดยะลา"]->.yala;
relation(area.yala)["name"~"เทศบาลนครยะลา|สะเตง"];
out geom;
"""

endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
]

data = None
for ep in endpoints:
    try:
        r = requests.post(ep, data={'data': query}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            break
    except Exception as e:
        print(f"Failed {ep}: {e}")

if data and data.get('elements'):
    element = data['elements'][0]
    coords = []
    for member in element.get('members', []):
        if member['type'] == 'way' and 'geometry' in member:
            way_coords = [[pt['lon'], pt['lat']] for pt in member['geometry']]
            coords.append(way_coords)
    
    feat = {
        "type": "Feature",
        "properties": element.get('tags', {}),
        "geometry": {
            "type": "MultiLineString",
            "coordinates": coords
        }
    }
    geojson = {"type": "FeatureCollection", "features": [feat]}
    with open('yala_boundary.geojson', 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False)
    print("Success! Found:", element.get('tags', {}).get('name'))
else:
    print("Not found or API failed.")
