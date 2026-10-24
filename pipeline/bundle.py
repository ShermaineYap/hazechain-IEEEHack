"""Build one evidence bundle per acquisition day: every detection, every event first seen that day, and every
event-to-polygon attribution for those events. Each row is canonical JSON; the Merkle root goes on-chain."""
import gzip, json, pandas as pd, geopandas as gpd
from common import OUT, WEB, ROOT, MODEL_VERSION, canon
import merkle

DATASET = "NASA FIRMS VIIRS 375m NRT (S-NPP, NOAA-20, NOAA-21) | AOI Central Kalimantan 112.5,-3.8,115.5,-1.5"
live = pd.read_parquet(OUT / "fires_live_labeled.parquet")
ev = gpd.read_file(OUT / "events.geojson")
links = pd.read_csv(OUT / "event_polygon_links.csv")
summary = []
for day, g in live.groupby("acq_date"):
    dk = day.replace("-", "")
    rows = []
    for r in g.itertuples():
        rows.append(canon({"t": "det", "id": r.det_id, "lat": f"{r.latitude:.5f}", "lon": f"{r.longitude:.5f}", "date": r.acq_date,
                           "time": r.acq_time.zfill(4), "sat": r.sat, "conf": r.confidence, "frp": r.frp, "ti4": r.bright_ti4,
                           "dn": r.daynight, "event": r.event_id}))
    evd = ev[ev.day == dk]
    for e in evd.itertuples():
        rows.append(canon({"t": "event", "id": e.event_id, "n": int(e.n), "first": e.first, "last": e.last, "censored": bool(e.censored),
                           "ign": [e.ign_lat, e.ign_lon], "ign_det": e.ign_det, "spread_km": e.spread_km, "spread_deg": e.spread_deg,
                           "peat_share": e.peat_share, "model": MODEL_VERSION}))
    for l in links[links.event_id.isin(evd.event_id)].itertuples():
        rows.append(canon({"t": "attr", "event": l.event_id, "polygon": l.polygon_id, "role": l.role, "pixels": int(l.pixels),
                           "share": l.share, "first_inside": l.first_inside, "conf": l.conf, "model": MODEL_VERSION}))
    levels = merkle.build([merkle.leaf(r) for r in rows]); root = levels[-1][0]
    # self-check a few proofs
    for i in (0, len(rows) // 2, len(rows) - 1):
        assert merkle.verify(merkle.leaf(rows[i]), merkle.proof(levels, i), root)
    b = {"day": int(dk), "root": "0x" + root.hex(), "rowCount": len(rows), "dataset": DATASET, "modelVersion": MODEL_VERSION,
         "uri": f"web/data/bundles/{dk}.json.gz", "rows": rows}
    (WEB / "bundles").mkdir(parents=True, exist_ok=True)
    open(WEB / "bundles" / f"{dk}.json.gz", "wb").write(gzip.compress(json.dumps(b, separators=(",", ":")).encode(), 9))
    summary.append({k: b[k] for k in ("day", "root", "rowCount", "dataset", "modelVersion", "uri")} |
                   {"detections": int(len(g)), "events": int(len(evd))})
    print(dk, len(rows), b["root"])
json.dump(summary, open(WEB / "bundles/index.json", "w"), indent=1)
