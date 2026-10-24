"""AI layer, part 1: space-time clustering of satellite detections into fire events, ignition-point estimation,
spread direction, and attribution of each event to a concession and a sub-district (kecamatan).

Method
- Each detection is projected to km (equirectangular around the AOI centre) and time is scaled so that
  24 h counts like 1.5 km. DBSCAN (eps = 1.5, min_samples = 2) on (x_km, y_km, t_scaled) groups detections
  that touch in space and time into one event. Singletons are kept as 1-detection events with low confidence.
- Ignition point = the earliest overpass of the event; if that overpass has several pixels, the one with the
  highest fire radiative power (FRP).
- Spread vector = centroid of the last overpass minus centroid of the first.
- Attribution: the polygon containing the ignition point. Confidence combines
    persistence  : 1 - exp(-n_detections / 4)              (one-pixel blips are weak evidence)
    boundary     : clip(distance_to_boundary / 750 m, .3, 1) (VIIRS pixel is 375 m; near-edge ignitions are uncertain)
    containment  : share of the event's pixels inside the polygon (fires that mostly burn elsewhere are weak)
    origin       : 0.5 if earlier pixels of the same event lie outside the polygon (fire entered from outside)
  conf = persistence * boundary * (0.5 + 0.5 * containment) * origin
  It is a transparent heuristic, not a legal finding. The escrow only slashes above 0.70 and always allows dispute.
"""
import numpy as np, pandas as pd, geopandas as gpd
from sklearn.cluster import DBSCAN
from shapely.geometry import Point, MultiPoint
from common import OUT, WEB, AOI, peat_at

LAT0 = (AOI[1] + AOI[3]) / 2
KX, KY = 111.32 * np.cos(np.radians(LAT0)), 110.57

live = pd.read_parquet(OUT / "fires_live.parquet")
live["ts"] = pd.to_datetime(live.acq_date + " " + live.acq_time.str.zfill(4), format="%Y-%m-%d %H%M", utc=True)
live["frp_f"] = live.frp.astype(float)
t0 = live.ts.min()
X = np.c_[(live.longitude - AOI[0]) * KX, (live.latitude - AOI[1]) * KY, (live.ts - t0).dt.total_seconds() / 3600 / 24 * 1.5]
lab = DBSCAN(eps=1.5, min_samples=2).fit_predict(X)
nxt = lab.max() + 1
single = lab < 0
lab[single] = np.arange(nxt, nxt + single.sum())
live["event"] = lab
live["det_id"] = ("D-" + live.acq_date.str.replace("-", "") + "-" + live.acq_time.str.zfill(4) + "-" + live.sat + "-"
                  + live.latitude.map("{:.5f}".format) + "_" + live.longitude.map("{:.5f}".format))

conc = gpd.read_file(OUT / "concessions.geojson")
dist = gpd.read_file(OUT / "districts.geojson")
UTM = 32750  # WGS84 / UTM 50S, metres
conc_m = conc.to_crs(UTM); dist_m = dist.to_crs(UTM)

pts = gpd.GeoDataFrame(live, geometry=gpd.points_from_xy(live.longitude, live.latitude), crs=4326)
pj = gpd.sjoin(pts, conc[["polygon_id", "geometry"]], how="left", predicate="within")
pj = pj[~pj.index.duplicated()]
live["conc"] = pj["polygon_id"].values
dj = gpd.sjoin(pts, dist[["polygon_id", "geometry"]], how="left", predicate="within")
dj = dj[~dj.index.duplicated()]
live["kec"] = dj["polygon_id"].values
live["peat"] = peat_at(live.longitude.values, live.latitude.values)

ev_rows, link_rows = [], []
for eid, g in live.groupby("event", sort=False):
    g = g.sort_values(["ts", "frp_f"], ascending=[True, False])
    first_ts, last_ts = g.ts.iloc[0], g.ts.iloc[-1]
    ign = g.iloc[0]
    firstpass = g[g.ts == first_ts]; lastpass = g[g.ts == last_ts]
    dx = (lastpass.longitude.mean() - firstpass.longitude.mean()) * KX
    dy = (lastpass.latitude.mean() - firstpass.latitude.mean()) * KY
    n = len(g)
    persistence = 1 - np.exp(-n / 4)

    censored = first_ts < t0 + pd.Timedelta(hours=24)   # already burning when the record starts: true ignition unknown
    ign_pt_m = gpd.GeoSeries([Point(ign.longitude, ign.latitude)], crs=4326).to_crs(UTM).iloc[0]

    def touched(col, polys_m):
        """One attribution row per polygon the event touched: did the fire START there or SPREAD IN?"""
        out = []
        for pid, gi in g[g[col].notna()].groupby(col):
            started = isinstance(ign[col], str) and ign[col] == pid
            share = len(gi) / n
            if started:
                poly = polys_m.loc[polys_m.polygon_id == pid, "geometry"].iloc[0]
                boundary = float(np.clip(poly.boundary.distance(ign_pt_m) / 750, 0.3, 1.0))
                conf = persistence * boundary * (0.5 + 0.5 * share) * (0.5 if censored else 1.0)
            else:
                conf = 0.0   # spread in from outside: affected, not liable
            out.append(dict(polygon_id=pid, level=col, role="started" if started else "spread-in",
                            pixels=len(gi), share=round(share, 3), first_inside=gi.ts.min().isoformat(),
                            conf=round(float(conf), 3)))
        return out

    eid_s = f"E-{first_ts:%Y%m%d}-{eid:05d}"
    links = touched("conc", conc_m) + touched("kec", dist_m)
    for r in links: r["event_id"] = eid_s
    link_rows.extend(links)
    cstart = next((r for r in links if r["level"] == "conc" and r["role"] == "started"), None)
    kstart = next((r for r in links if r["level"] == "kec" and r["role"] == "started"), None)
    hull = MultiPoint(list(zip(g.longitude, g.latitude))).convex_hull.buffer(0.0018)  # ~200 m pad (half a VIIRS pixel)
    ev_rows.append(dict(
        event_id=eid_s, n=n, first=first_ts.isoformat(), last=last_ts.isoformat(),
        duration_h=round((last_ts - first_ts).total_seconds() / 3600, 1), censored=bool(censored),
        ign_lat=round(float(ign.latitude), 5), ign_lon=round(float(ign.longitude), 5), ign_det=ign.det_id,
        spread_km=round(float(np.hypot(dx, dy)), 2), spread_deg=round(float(np.degrees(np.arctan2(dx, dy)) % 360), 0),
        frp_sum=round(float(g.frp_f.sum()), 1), peat_share=round(float(g.peat.mean()), 2),
        concession=cstart["polygon_id"] if cstart else None, conc_conf=cstart["conf"] if cstart else 0.0,
        spread_into=",".join(r["polygon_id"] for r in links if r["level"] == "conc" and r["role"] == "spread-in"),
        district=kstart["polygon_id"] if kstart else None, dist_conf=kstart["conf"] if kstart else 0.0,
        day=f"{first_ts:%Y%m%d}", geometry=hull))
    live.loc[g.index, "event_id"] = eid_s

ev = gpd.GeoDataFrame(ev_rows, crs=4326).sort_values(["first", "event_id"]).reset_index(drop=True)
ev.to_file(OUT / "events.geojson", driver="GeoJSON")
live.drop(columns=["ts"]).to_parquet(OUT / "fires_live_labeled.parquet")
links = pd.DataFrame(link_rows); links.to_csv(OUT / "event_polygon_links.csv", index=False)

big = ev[ev.n >= 3]
print(f"detections {len(live)} -> events {len(ev)} (>=3 px: {len(big)})")
print("detections on peat:", round(live.peat.mean() * 100, 1), "%  | inside a concession:", round(live.conc.notna().mean() * 100, 1), "%")
print("censored (burning at record start):", int(ev.censored.sum()))
print("events started inside a concession:", int(ev.concession.notna().sum()), "| conf>=0.7:", int((ev.conc_conf >= 0.7).sum()))
cl = links[links.level == "conc"]
print("concession links: started", int((cl.role == "started").sum()), "| spread-in", int((cl.role == "spread-in").sum()),
      "| concessions only hit by spread-in:", len(set(cl[cl.role=="spread-in"].polygon_id) - set(cl[cl.role=="started"].polygon_id)))
print(ev.sort_values("n", ascending=False).head(8)[["event_id", "n", "duration_h", "spread_km", "peat_share", "censored", "concession", "conc_conf", "spread_into"]].to_string())
