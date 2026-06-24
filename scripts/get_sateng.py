import urllib.request
import json

url = "https://raw.githubusercontent.com/apisit/thailand.json/master/tambon.json"
try:
    print("Downloading tambon.json...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        
        sateng_feature = None
        for f in data.get('features', []):
            props = f.get('properties', {})
            # Depending on property names, usually PROV_NAMT, AMP_NAMT, TAM_NAMT
            # Let's just search the string representations
            prop_str = json.dumps(props, ensure_ascii=False)
            if "ยะลา" in prop_str and "สะเตง" in prop_str:
                sateng_feature = f
                break
                
        if sateng_feature:
            out_geojson = {"type": "FeatureCollection", "features": [sateng_feature]}
            with open('yala_boundary.geojson', 'w', encoding='utf-8') as out:
                json.dump(out_geojson, out, ensure_ascii=False)
            print("Successfully saved Tambon Sateng boundary!")
        else:
            print("Could not find Tambon Sateng in the dataset.")
except Exception as e:
    print("Error:", e)
