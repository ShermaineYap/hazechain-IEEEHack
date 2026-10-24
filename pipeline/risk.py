"""AI layer, part 2: 7-day fire-risk model on a 0.05 degree grid (~5.5 km cells).

Question: given what the satellites and rain gauges show up to day t, will this cell have at least one
VIIRS detection in days t+1..t+7?
Data: VIIRS S-NPP archive 2019-2025 (the same single sensor is used for live scoring, so counts are comparable),
NASA POWER daily rainfall, GFW peat and concession maps. Dry-season days only (June-November).
Split by year (no leakage across seasons): train 2019-2023, early-stop on 2024, report on held-out 2025.
"""
import json, numpy as np, pandas as pd, geopandas as gpd, lightgbm as lgb
from sklearn.metrics import roc_auc_score, average_precision_score
from shapely.geometry import Point
from common import OUT, WEB, AOI, CELL, NX, NY, peat_at, cell_of

rng = np.random.default_rng(7)

# ---------- static cell features: peat share, concession share ----------
cx = AOI[0] + (np.arange(NX) + 0.5) * CELL; cy = AOI[1] + (np.arange(NY) + 0.5) * CELL
off = (np.arange(5) + 0.5) / 5 * CELL - CELL / 2
sx, sy = np.meshgrid(off, off)
peat = np.zeros((NY, NX)); op = np.zeros((NY, NX)); wf = np.zeros((NY, NX))
conc = gpd.read_file(OUT / "concessions.geojson")
lon_s = (cx[None, :, None, None] + sx[None, None]).repeat(NY, 0)
lat_s = (cy[:, None, None, None] + sy[None, None]).repeat(NX, 1)
peat = peat_at(lon_s.ravel(), lat_s.ravel()).reshape(NY, NX, 25).mean(-1)
pts = gpd.GeoDataFrame(geometry=gpd.points_from_xy(lon_s.ravel(), lat_s.ravel()), crs=4326)
j = gpd.sjoin(pts, conc[["kind", "geometry"]], how="left", predicate="within")
j = j[~j.index.duplicated()]
op = (j.kind == "oil_palm").values.reshape(NY, NX, 25).mean(-1)
wf = (j.kind == "wood_fiber").values.reshape(NY, NX, 25).mean(-1)
np.savez_compressed(OUT / "static_cells.npz", peat=peat, op=op, wf=wf)

# ---------- daily fire count cubes ----------
def cube(df, days):
    idx = {d: i for i, d in enumerate(days)}
    c = np.zeros((len(days), NY, NX), np.float32)
    ix, iy = cell_of(df.longitude.values, df.latitude.values)
    di = df.acq_date.map(idx).values
    ok = ~pd.isna(di) & (ix >= 0) & (ix < NX) & (iy >= 0) & (iy < NY)
    np.add.at(c, (di[ok].astype(int), iy[ok], ix[ok]), 1)
    return c

def window_sum(c, w):   # sum over [t-w+1, t]
    cs = np.cumsum(np.concatenate([np.zeros_like(c[:1]), c]), 0)
    out = cs[w:] - cs[:-w]
    return np.concatenate([np.repeat(out[:1] * 0, w - 1, 0) + cs[1:w], out], 0)

def neigh(c, r):        # sum over the (2r+1)^2 neighbourhood, excluding the centre
    p = np.pad(c, ((0, 0), (r, r), (r, r)))
    s = np.zeros_like(c)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx or dy: s += p[:, r + dy:r + dy + NY, r + dx:r + dx + NX]
    return s

# ---------- rainfall per cell (nearest 0.5 degree POWER point) ----------
rain = pd.read_parquet(OUT / "rain.parquet")
rp = rain.pivot_table(index="date", columns=["lon", "lat"], values="mm")
rp = rp.reindex(pd.date_range("2019-01-01", "2026-10-31")).ffill(limit=5).fillna(rp.mean())
plon = np.array([c[0] for c in rp.columns]); plat = np.array([c[1] for c in rp.columns])
near = np.array([[np.argmin((plon - x) ** 2 + (plat - y) ** 2) for x in cx] for y in cy])  # (NY,NX) -> column
R = rp.values  # (days, points)
R7 = pd.DataFrame(R, index=rp.index).rolling(7).sum(); R30 = pd.DataFrame(R, index=rp.index).rolling(30).sum()
clim30 = R30.groupby(R30.index.dayofyear).transform("mean")
A30 = R30 - clim30

FEATS = ["f1", "f3", "f7", "n1_7", "n2_7", "rain7", "rain30", "rain30_anom", "peat", "oil_palm", "wood_fiber", "doy_s", "doy_c"]

def features(c, days):
    f1, f3, f7 = c, window_sum(c, 3), window_sum(c, 7)
    n1, n2 = neigh(f7, 1), neigh(f7, 2) - neigh(f7, 1)
    d = pd.DatetimeIndex(days)
    r7 = R7.loc[d].values[:, near]; r30 = R30.loc[d].values[:, near]; a30 = A30.loc[d].values[:, near]
    T = len(days)
    st = lambda a: np.broadcast_to(a, (T, NY, NX))
    doy = d.dayofyear.values[:, None, None] * np.ones((1, NY, NX))
    cols = [f1, f3, f7, n1, n2, r7, r30, a30, st(peat), st(op), st(wf), np.sin(2 * np.pi * doy / 365), np.cos(2 * np.pi * doy / 365)]
    return np.stack([x.reshape(T, -1) for x in cols], -1)  # (T, cells, F)

hist = pd.read_parquet(OUT / "fires_history.parquet")
hist = hist[hist.satellite.isin(["N", "1"]) | (hist.instrument == "VIIRS")]
X_all, y_all, yr_all = [], [], []
for yr in range(2019, 2026):
    days = pd.date_range(f"{yr}-05-01", f"{yr}-12-15").strftime("%Y-%m-%d").tolist()
    c = cube(hist[hist.acq_date.str.startswith(str(yr))], days)
    F = features(c, days)
    fut = window_sum(c[::-1], 7)[::-1]                      # sum over [t, t+6]
    fut = np.concatenate([fut[1:], np.zeros_like(fut[:1])])  # -> [t+1, t+7]
    keep = [i for i, d in enumerate(days) if d[5:7] in ("06", "07", "08", "09", "10", "11") and i < len(days) - 7]
    X_all.append(F[keep].reshape(-1, len(FEATS))); y_all.append((fut[keep] > 0).reshape(-1)); yr_all.append(np.full(len(keep) * NX * NY, yr))
X = np.concatenate(X_all); y = np.concatenate(y_all); yr = np.concatenate(yr_all)
print("panel rows", len(y), "positive rate", round(y.mean(), 4))

tr, va, te = yr <= 2023, yr == 2024, yr == 2025
model = lgb.LGBMClassifier(n_estimators=2000, learning_rate=0.03, num_leaves=63, min_child_samples=200,
                           subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, verbose=-1)
model.fit(X[tr], y[tr], eval_set=[(X[va], y[va])], eval_metric="average_precision",
          callbacks=[lgb.early_stopping(100, verbose=False)])
p = model.predict_proba(X[te])[:, 1]
pers = X[te][:, FEATS.index("f7")] + 0.1 * X[te][:, FEATS.index("n1_7")]  # persistence baseline

def capture(score, yy, top=0.05):
    k = int(len(score) * top); idx = np.argsort(-score)[:k]
    return yy[idx].sum() / max(yy.sum(), 1)

metrics = {
    "test_season": "2025 (Jun-Nov), held out",
    "rows_train": int(tr.sum()), "rows_test": int(te.sum()), "positive_rate_test": round(float(y[te].mean()), 4),
    "roc_auc": round(float(roc_auc_score(y[te], p)), 3), "pr_auc": round(float(average_precision_score(y[te], p)), 3),
    "roc_auc_persistence": round(float(roc_auc_score(y[te], pers)), 3), "pr_auc_persistence": round(float(average_precision_score(y[te], pers)), 3),
    "capture_top5pct": round(float(capture(p, y[te])), 3), "capture_top5pct_persistence": round(float(capture(pers, y[te])), 3),
    "best_iteration": int(model.best_iteration_),
    "feature_importance_gain": dict(sorted(zip(FEATS, map(float, model.booster_.feature_importance("gain"))), key=lambda kv: -kv[1])),
}
tot = sum(metrics["feature_importance_gain"].values())
metrics["feature_importance_gain"] = {k: round(v / tot, 3) for k, v in metrics["feature_importance_gain"].items()}
# robustness: El Nino season 2023 held out (train 2019-2022 + 2025, early-stop on 2024)
tr2, te2 = np.isin(yr, [2019, 2020, 2021, 2022, 2025]), yr == 2023
m2 = lgb.LGBMClassifier(**model.get_params()).fit(X[tr2], y[tr2], eval_set=[(X[va], y[va])], eval_metric="average_precision",
                                                  callbacks=[lgb.early_stopping(100, verbose=False)])
p2 = m2.predict_proba(X[te2])[:, 1]; pers2 = X[te2][:, FEATS.index("f7")] + 0.1 * X[te2][:, FEATS.index("n1_7")]
metrics["el_nino_2023_holdout"] = {"positive_rate": round(float(y[te2].mean()), 4),
    "roc_auc": round(float(roc_auc_score(y[te2], p2)), 3), "roc_auc_persistence": round(float(roc_auc_score(y[te2], pers2)), 3),
    "pr_auc": round(float(average_precision_score(y[te2], p2)), 3), "pr_auc_persistence": round(float(average_precision_score(y[te2], pers2)), 3),
    "capture_top5pct": round(float(capture(p2, y[te2])), 3), "capture_top5pct_persistence": round(float(capture(pers2, y[te2])), 3)}
print(json.dumps(metrics, indent=1))
json.dump(metrics, open(OUT / "risk_metrics.json", "w"), indent=1)
model.booster_.save_model(str(OUT / "risk_model.txt"))

# ---------- live scoring: as of the latest full day, single sensor (S-NPP) to match training ----------
live = pd.read_parquet(OUT / "fires_live.parquet")
live_snpp = live[live.sat == "SNPP"]
asof = sorted(live.acq_date.unique())[-2]          # last complete day (today's file is partial)
days = pd.date_range(pd.Timestamp(asof) - pd.Timedelta(days=29), asof).strftime("%Y-%m-%d").tolist()
c = cube(live_snpp, days)                         # days before the live window are empty -> f7 etc. only use last 7 d
F = features(c, days)[-1]
risk = model.predict_proba(F)[:, 1].reshape(NY, NX)
np.savez_compressed(OUT / "risk_live.npz", risk=risk, asof=asof)
cells = []
for iy in range(NY):
    for ix in range(NX):
        cells.append({"x": ix, "y": iy, "p": round(float(risk[iy, ix]), 3)})
json.dump({"asof": asof, "aoi": AOI, "cell": CELL, "nx": NX, "ny": NY,
           "grid": [[round(float(v), 3) for v in row] for row in risk], "metrics": metrics,
           "rain_last_day": str(rain.dropna().date.max().date())},
          open(WEB / "risk.json", "w"))
print("live risk as of", asof, "| cells >0.5:", int((risk > 0.5).sum()), "of", risk.size)
