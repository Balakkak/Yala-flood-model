import json
import math

coords = []
# ny from 1.0 to 0.0 (South to North)
for step in range(101):
    ny = 1.0 - (step / 100.0)
    # Match the JS function: riverX(ny) = 0.10 + 0.05 * sin(ny * 8)
    rx = 0.10 + 0.05 * math.sin(ny * 8)
    
    # Map to Lat/Lon bounds
    # West: 101.258, East: 101.305
    # North: 6.568, South: 6.525
    lon = 101.258 + rx * (101.305 - 101.258)
    lat = 6.568 - ny * (6.568 - 6.525)
    
    coords.append([lon, lat])

geojson = {
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "แม่น้ำปัตตานี (ทางน้ำหลักจากเขื่อน)",
        "type": "river"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": coords
      }
    }
  ]
}

with open('yala_waterways.geojson', 'w', encoding='utf-8') as f:
    json.dump(geojson, f, ensure_ascii=False)
