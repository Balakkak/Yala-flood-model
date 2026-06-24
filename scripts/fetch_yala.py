import requests
import json

query = """
[out:json][timeout:25];
relation["name"="เทศบาลนครยะลา"];
out geom;
"""
url = "http://overpass-api.de/api/interpreter"
r = requests.post(url, data={'data': query})
data = r.json()

features = []
for element in data.get('elements', []):
    if element['type'] == 'relation':
        coords = []
        for member in element.get('members', []):
            if member['type'] == 'way' and 'geometry' in member:
                way_coords = [[pt['lon'], pt['lat']] for pt in member['geometry']]
                coords.append(way_coords)
        
        # This is a naive conversion, real conversion needs proper ring sorting
        # We will just save the raw ways as MultiLineString for simplicity to check if we got data
        feat = {
            "type": "Feature",
            "properties": element.get('tags', {}),
            "geometry": {
                "type": "MultiLineString",
                "coordinates": coords
            }
        }
        features.append(feat)

geojson = {"type": "FeatureCollection", "features": features}
with open('yala_city.geojson', 'w', encoding='utf-8') as f:
    json.dump(geojson, f, ensure_ascii=False, indent=2)

print(f"Saved {len(features)} relations.")
if features:
    print(f"Name: {features[0]['properties'].get('name')}")
