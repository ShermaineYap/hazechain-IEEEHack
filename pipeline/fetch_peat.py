"""Peatland mask for the AOI from GFW's public peatland raster tiles (non-transparent pixel = peat)."""
import io, urllib.request, numpy as np, mercantile
from PIL import Image
AOI = (112.5, -3.8, 115.5, -1.5); Z = 10
tiles = list(mercantile.tiles(*AOI, Z))
xs = sorted({t.x for t in tiles}); ys = sorted({t.y for t in tiles})
mosaic = np.zeros((256 * len(ys), 256 * len(xs)), dtype=np.uint8)
for t in tiles:
    url = f"https://tiles.globalforestwatch.org/gfw_peatlands/v20230315/is/{t.z}/{t.x}/{t.y}.png"
    try:
        im = Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=30).read())).convert("RGBA")
        a = np.array(im)[:, :, 3] > 0
    except Exception as e:
        a = np.zeros((256, 256), bool)
    mosaic[(t.y - ys[0]) * 256:(t.y - ys[0] + 1) * 256, (t.x - xs[0]) * 256:(t.x - xs[0] + 1) * 256] = a
nw = mercantile.bounds(mercantile.Tile(xs[0], ys[0], Z)); se = mercantile.bounds(mercantile.Tile(xs[-1], ys[-1], Z))
np.savez_compressed("data/raw/peat_mask.npz", mask=mosaic, west=nw.west, north=nw.north, east=se.east, south=se.south, z=Z)
print("peat share", mosaic.mean().round(3), mosaic.shape)
