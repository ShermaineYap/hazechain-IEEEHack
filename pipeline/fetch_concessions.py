"""Download GFW concession polygons (oil palm, wood fibre) for the AOI from public vector tiles."""
import gzip, json, sys, urllib.request, mercantile, mapbox_vector_tile, geopandas as gpd
from shapely.geometry import shape, box
from shapely.ops import unary_union
from shapely.affinity import affine_transform

AOI = (112.5, -3.8, 115.5, -1.5)  # Central Kalimantan peat belt (W,S,E,N)
Z = int(sys.argv[1]) if len(sys.argv) > 1 else 10
LAYERS = {"oil_palm": "gfw_oil_palm/v2025", "wood_fiber": "gfw_wood_fiber/v2025"}

def tile_feats(ds, t):
    url = f"https://tiles.globalforestwatch.org/{ds}/default/{t.z}/{t.x}/{t.y}.pbf"
    try:
        raw = urllib.request.urlopen(url, timeout=30).read()
    except Exception as e:
        return []
    if not raw: return []
    if raw[:2] == b'\x1f\x8b': raw = gzip.decompress(raw)
    dec = mapbox_vector_tile.decode(raw)
    b = mercantile.bounds(t); out = []
    for lname, layer in dec.items():
        ext = layer.get("extent", 4096)
        sx = (b.east - b.west) / ext; sy = (b.north - b.south) / ext
        for f in layer["features"]:
            g = shape(f["geometry"])
            # tile coords (y up in mapbox_vector_tile default) -> lon/lat (linear approx inside tile)
            g = affine_transform(g, [sx, 0, 0, sy, b.west, b.south])
            out.append({**f["properties"], "geometry": g})
    return out

rows = []
for kind, ds in LAYERS.items():
    tiles = list(mercantile.tiles(*AOI, Z))
    for t in tiles:
        for f in tile_feats(ds, t):
            f["kind"] = kind; rows.append(f)
    print(kind, "tiles", len(tiles), "pieces", sum(r["kind"] == kind for r in rows))
g = gpd.GeoDataFrame(rows, crs=4326)
print(g.columns.tolist()); print(g.head(3).drop(columns="geometry").to_string())
g.to_file("data/raw/concession_pieces.geojson", driver="GeoJSON")
