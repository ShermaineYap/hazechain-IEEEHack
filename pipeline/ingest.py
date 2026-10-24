"""Ingest: clip FIRMS history (2019-2025, VIIRS S-NPP archive) and the live 7-day NRT feed (S-NPP, NOAA-20, NOAA-21)
to the AOI; merge concession pieces; fetch NASA POWER daily rainfall on a 0.5 degree grid."""
import glob, json, urllib.request, concurrent.futures as cf
import pandas as pd, geopandas as gpd, numpy as np
from common import RAW, OUT, AOI, in_aoi

# --- fire history (archive) ---
hist = []
for f in sorted(glob.glob(str(RAW / "snpp_20*.csv"))):
    d = pd.read_csv(f, dtype=str)
    d["latitude"] = d.latitude.astype(float); d["longitude"] = d.longitude.astype(float)
    hist.append(in_aoi(d))
hist = pd.concat(hist)
hist = hist[hist.confidence != "l"]
hist.to_parquet(OUT / "fires_history.parquet")
print("history detections in AOI:", len(hist), hist.acq_date.min(), hist.acq_date.max())

# --- live NRT (last 7 days, 3 satellites) ---
live = []
for f in glob.glob(str(RAW / "*_SouthEast_Asia_7d.csv")):
    d = pd.read_csv(f, dtype=str)
    d["latitude"] = d.latitude.astype(float); d["longitude"] = d.longitude.astype(float)
    live.append(in_aoi(d))
live = pd.concat(live)
live = live[live.confidence != "low"].copy()
live["sat"] = live.satellite.map({"N": "SNPP", "N20": "NOAA20", "N21": "NOAA21"}).fillna(live.satellite)
live = live.sort_values(["acq_date", "acq_time", "latitude", "longitude"]).reset_index(drop=True)
live.to_parquet(OUT / "fires_live.parquet")
print("live detections in AOI:", len(live), live.acq_date.min(), live.acq_date.max())
print(live.groupby("acq_date").size().to_dict())

# --- concessions: dissolve tile pieces into whole polygons ---
pieces = gpd.read_file(RAW / "concession_pieces.geojson")
pieces["geometry"] = pieces.buffer(0)
keep = ["kind", "gfw_fid", "conc_name", "company", "comp_group", "conc_type", "cont_type", "source", "source_yr", "gfw_area__ha"]
conc = pieces.dissolve(by=["kind", "gfw_fid"], aggfunc="first").reset_index()[keep + ["geometry"]]
conc["polygon_id"] = np.where(conc.kind == "oil_palm", "GFW-OP-", "GFW-WF-") + conc.gfw_fid.astype(int).astype(str)
conc = conc[conc.geometry.area > 0]
conc.to_file(OUT / "concessions.geojson", driver="GeoJSON")
print("concessions:", len(conc), conc.kind.value_counts().to_dict())

# --- rainfall, NASA POWER (MERRA-2), 0.5 deg grid ---
lons = np.arange(AOI[0] + 0.25, AOI[2], 0.5); lats = np.arange(AOI[1] + 0.25, AOI[3], 0.5)
pts = [(round(x, 2), round(y, 2)) for x in lons for y in lats]
def get(p):
    url = (f"https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG"
           f"&longitude={p[0]}&latitude={p[1]}&start=20190101&end=20261023&format=JSON")
    for _ in range(3):
        try:
            j = json.load(urllib.request.urlopen(url, timeout=120))
            s = j["properties"]["parameter"]["PRECTOTCORR"]
            return [(p[0], p[1], k, v) for k, v in s.items()]
        except Exception as e:
            err = e
    print("fail", p, err); return []
with cf.ThreadPoolExecutor(6) as ex:
    rows = [r for res in ex.map(get, pts) for r in res]
rain = pd.DataFrame(rows, columns=["lon", "lat", "date", "mm"])
rain["date"] = pd.to_datetime(rain.date, format="%Y%m%d"); rain.loc[rain.mm < 0, "mm"] = np.nan
rain.to_parquet(OUT / "rain.parquet")
print("rain points", len(pts), "rows", len(rain), "last valid", rain.dropna().date.max())
