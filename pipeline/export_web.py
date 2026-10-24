"""Per-polygon fire ledger + compact files for the dashboard."""
import json, numpy as np, pandas as pd, geopandas as gpd
from common import OUT, WEB, AOI, MODEL_VERSION, peat_at

# IPCC 2013 Wetlands Supplement, Ch.2: Table 2.6 (tropical drained peat wildfire, 353 t d.m./ha, 95% CI 170-536)
# and Table 2.7 (tropical: 464 g CO2-C, 21 g CH4 per kg d.m.). CH4 GWP100 = 27 (IPCC AR6, non-fossil).
FUEL, FUEL_LO, FUEL_HI = 353, 170, 536
CO2_PER_T = 0.464 * 44 / 12   # t CO2 per t d.m.
CH4_PER_T = 0.021 * 27        # t CO2e per t d.m.
TCO2E_PER_HA = FUEL * (CO2_PER_T + CH4_PER_T)
PIXEL_HA = 0.375 * 0.375 * 100  # VIIRS I-band nadir footprint, ha

live = pd.read_parquet(OUT / "fires_live_labeled.parquet")
ev = gpd.read_file(OUT / "events.geojson")
links = pd.read_csv(OUT / "event_polygon_links.csv")
conc = gpd.read_file(OUT / "concessions.geojson")
dist = gpd.read_file(OUT / "districts.geojson")
hist = pd.read_parquet(OUT / "fires_history.parquet")
days = sorted(live.acq_date.unique()); last_day = pd.Timestamp(days[-1])

# 2025 dry-season context per polygon (single sensor archive)
h25 = hist[hist.acq_date.between("2025-06-01", "2025-11-30")]
h25 = gpd.GeoDataFrame(h25, geometry=gpd.points_from_xy(h25.longitude, h25.latitude), crs=4326)

def ledger(polys, col):
    out = []
    utm = polys.to_crs(32750)
    j25 = gpd.sjoin(h25, polys[["polygon_id", "geometry"]], predicate="within").groupby("polygon_id").size()
    for i, p in polys.iterrows():
        pid = p.polygon_id
        d = live[live[col] == pid]
        L = links[links.polygon_id == pid]
        started = L[L.role == "started"]; spread = L[L.role == "spread-in"]
        confident = started[started.conf >= 0.7]
        streak = (last_day - pd.Timestamp(d.acq_date.max())).days if len(d) else None
        # peat share of the polygon (sample interior points)
        g = p.geometry; minx, miny, maxx, maxy = g.bounds
        xs, ys = np.meshgrid(np.linspace(minx, maxx, 12), np.linspace(miny, maxy, 12))
        inside = gpd.points_from_xy(xs.ravel(), ys.ravel()).within(g)
        peat = float(peat_at(xs.ravel()[inside], ys.ravel()[inside]).mean()) if inside.any() else 0.0
        px = d.assign(px=(d.longitude / 0.003375).round().astype(int).astype(str) + "_" + (d.latitude / 0.003375).round().astype(int).astype(str))
        peat_px = px[px.peat == 1].px.nunique()
        if len(confident): status = "confident-ignition"
        elif len(started): status = "low-confidence-ignition"
        elif len(spread): status = "affected-spread-in"
        else: status = "fire-free"
        out.append(dict(polygon_id=pid, area_ha=round(float(utm.geometry.iloc[i].area / 1e4)), peat_share=round(peat, 2),
                        detections_week=int(len(d)), events_started=int(len(started)), events_confident=int(len(confident)),
                        max_conf=round(float(started.conf.max()), 3) if len(started) else 0.0,
                        events_spread_in=int(len(spread)), days_since_fire=streak, fire_free_week=len(d) == 0,
                        peat_pixels=int(peat_px), detections_2025_season=int(j25.get(pid, 0)), status=status))
    return pd.DataFrame(out)

lc = ledger(conc, "conc"); ld = ledger(dist, "kec")
C = conc.merge(lc, on="polygon_id"); D = dist.merge(ld, on="polygon_id")
C["name"] = C.conc_name.str.title(); C["company"] = C.company.fillna("").str.title()
D["name"] = D.NAME_3.str.replace(r"(?<=[a-z])(?=[A-Z])", " ", regex=True)
D["regency"] = D.NAME_2.str.replace(r"(?<=[a-z])(?=[A-Z])", " ", regex=True)
D["province"] = D.NAME_1.str.replace(r"(?<=[a-z])(?=[A-Z])", " ", regex=True)

simp = lambda g: g.assign(geometry=g.geometry.simplify(0.0015, preserve_topology=True))
ccols = ["polygon_id", "kind", "name", "company", "conc_type", "source", "source_yr"] + list(lc.columns.drop("polygon_id"))
dcols = ["polygon_id", "name", "regency", "province"] + list(ld.columns.drop("polygon_id"))
simp(C[ccols + ["geometry"]]).to_file(WEB / "concessions.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
simp(D[dcols + ["geometry"]]).to_file(WEB / "districts.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
C[ccols].to_csv(OUT / "ledger_concessions.csv", index=False); D[dcols].to_csv(OUT / "ledger_districts.csv", index=False)

E = ev[ev.n >= 2].copy()
E["geometry"] = E.geometry.simplify(0.001)
E[["event_id", "n", "first", "last", "duration_h", "censored", "ign_lat", "ign_lon", "spread_km", "spread_deg", "frp_sum",
   "peat_share", "concession", "conc_conf", "spread_into", "district", "dist_conf", "day", "geometry"]].to_file(
    WEB / "events.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)

di = {d: i for i, d in enumerate(days)}
det = [[round(r.latitude, 4), round(r.longitude, 4), di[r.acq_date], round(float(r.frp), 1)] for r in live.itertuples()]
json.dump({"days": days, "rows": det}, open(WEB / "detections.json", "w"), separators=(",", ":"))

peat_px_all = live[live.peat == 1].assign(px=(live.longitude / 0.003375).round().astype(int).astype(str) + "_" + (live.latitude / 0.003375).round().astype(int).astype(str)).px.nunique()
peat_ha = peat_px_all * PIXEL_HA
summary = {
    "asof": days[-1], "window": [days[0], days[-1]], "aoi": AOI, "model_version": MODEL_VERSION,
    "detections": int(len(live)), "detections_by_day": live.groupby("acq_date").size().astype(int).to_dict(),
    "events": int(len(ev)), "events_multi": int((ev.n >= 2).sum()), "events_censored": int(ev.censored.sum()),
    "share_on_peat": round(float(live.peat.mean()), 3), "share_in_concessions": round(float(live.conc.notna().mean()), 3),
    "concessions_total": int(len(C)), "concessions_with_fire": int((C.detections_week > 0).sum()),
    "concessions_confident_ignition": int((C.status == "confident-ignition").sum()),
    "concessions_spread_in_only": int((C.status == "affected-spread-in").sum()),
    "concessions_fire_free": int((C.status == "fire-free").sum()),
    "districts_total": int(len(D)), "districts_with_fire": int((D.detections_week > 0).sum()),
    "peat_pixels": int(peat_px_all), "peat_pixel_area_ha": round(peat_ha),
    "tco2e_per_ha": round(TCO2E_PER_HA), "tco2e_per_ha_range": [round(FUEL_LO * (CO2_PER_T + CH4_PER_T)), round(FUEL_HI * (CO2_PER_T + CH4_PER_T))],
    "emissions_upper_bound_mt": round(peat_ha * TCO2E_PER_HA / 1e6, 1),
    "emission_method": "IPCC 2013 Wetlands Supplement Tier 1: 353 t d.m./ha (Table 2.6, tropical drained peat wildfire) x (464 g CO2-C + 21 g CH4 x GWP 27)/kg (Table 2.7). Area = unique VIIRS 375 m pixels on peat (upper bound; a detection does not mean the whole pixel burned).",
}
json.dump(summary, open(WEB / "summary.json", "w"), indent=1)
print(json.dumps(summary, indent=1))
print(C.status.value_counts().to_dict()); print(D.status.value_counts().to_dict())
print(C.sort_values("detections_week", ascending=False)[["polygon_id", "name", "peat_share", "detections_week", "events_started", "events_confident", "max_conf", "events_spread_in", "status"]].head(10).to_string())
print(C[(C.status == "fire-free") & (C.peat_share > 0.5)][["polygon_id", "name", "area_ha", "peat_share", "detections_2025_season"]].head(8).to_string())
