import urllib.request, urllib.parse, json, sys
sys.stdout.reconfigure(encoding='utf-8')

S, W, N, E = 6.495, 101.230, 6.590, 101.345
Q = """[out:json][timeout:120];
(
  way["waterway"]({S},{W},{N},{E});
  way["man_made"="pipeline"]({S},{W},{N},{E});
  node["man_made"~"manhole|pumping_station"]({S},{W},{N},{E});
);
out geom;""".replace("{S}",str(S)).replace("{W}",str(W)).replace("{N}",str(N)).replace("{E}",str(E))

data = urllib.parse.urlencode({"data": Q}).encode()
req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=data,
      headers={"User-Agent":"yala-flood-gis/1.0"})
with urllib.request.urlopen(req, timeout=150) as r:
    osm = json.load(r)
elements = osm.get("elements", [])
print(f"Total elements: {len(elements)}")
tags_seen = {}
for el in elements:
    tags = el.get("tags", {})
    wtype = tags.get("waterway", tags.get("man_made", "other"))
    tags_seen[wtype] = tags_seen.get(wtype, 0) + 1
    name = tags.get("name","")
    if name:
        print(f"  [{el['type']}] {wtype}: {name}")
print("Types:", tags_seen)
