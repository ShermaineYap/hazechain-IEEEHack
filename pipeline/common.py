"""Shared settings and helpers for the HazeChain pipeline."""
import json, math, numpy as np, mercantile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data/raw", ROOT / "data/processed", ROOT / "web/data"
for p in (OUT, WEB, ROOT / "data/bundles"): p.mkdir(parents=True, exist_ok=True)

AOI = (112.5, -3.8, 115.5, -1.5)          # W,S,E,N — Central Kalimantan peat belt (Pulang Pisau, Kapuas, Palangka Raya)
CELL = 0.05                                 # risk grid cell, degrees (~5.5 km)
MODEL_VERSION = "hazechain-0.4.0 (dbscan-st 1.5km/24h; attrib-v2; risk-lgbm-2019-2024)"

def in_aoi(df):
    w, s, e, n = AOI
    return df[df.longitude.between(w, e) & df.latitude.between(s, n)]

def cell_of(lon, lat):
    return (np.floor((lon - AOI[0]) / CELL).astype(int), np.floor((lat - AOI[1]) / CELL).astype(int))

NX = int(round((AOI[2] - AOI[0]) / CELL)); NY = int(round((AOI[3] - AOI[1]) / CELL))

_peat = None
def peat_at(lon, lat):
    """1 if the point falls on GFW-mapped peat, else 0 (web-mercator tile mosaic lookup)."""
    global _peat
    if _peat is None: _peat = np.load(RAW / "peat_mask.npz")
    m, z = _peat["mask"], int(_peat["z"])
    lon = np.asarray(lon, float); lat = np.asarray(lat, float)
    n = 2 ** z
    xt = (lon + 180) / 360 * n
    yt = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2 * n
    x0 = mercantile.tile(float(_peat["west"]) + 1e-9, float(_peat["north"]) - 1e-9, z)
    px = ((xt - x0.x) * 256).astype(int); py = ((yt - x0.y) * 256).astype(int)
    ok = (px >= 0) & (py >= 0) & (px < m.shape[1]) & (py < m.shape[0])
    out = np.zeros(lon.shape, np.uint8); out[ok] = m[py[ok], px[ok]]
    return out

def canon(d):
    return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=lambda o: o.isoformat() if hasattr(o, "isoformat") else float(o))
