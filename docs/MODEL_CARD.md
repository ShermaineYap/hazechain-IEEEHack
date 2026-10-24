# Model card

Model version string anchored with every evidence day: `hazechain-0.4.0 (dbscan-st 1.5km/24h; attrib-v2; risk-lgbm-2019-2024)`.

## 1. Fire-event clustering (`pipeline/events.py`)

- **Input:** VIIRS 375 m detections (S-NPP, NOAA-20, NOAA-21), low-confidence pixels removed.
- **Method:** DBSCAN on (x km, y km, t), where 24 h counts like 1.5 km; eps 1.5, min_samples 2. Singletons are kept as 1-pixel events.
- **Ignition point:** earliest overpass of the event; brightest pixel (FRP) breaks ties.
- **Censoring:** events first seen in the first 24 h of the record are flagged, because they may have started earlier.
- **Output on 17–24 Oct 2026:** 58,466 detections become 2,318 events (579 censored).

## 2. Attribution (`pipeline/events.py`)

For every polygon (concession or sub-district) an event touches, the model records whether the fire **started** there (the ignition point lies inside) or **spread in**.

```
conf = persistence x boundary x (0.5 + 0.5 x containment) x origin
persistence = 1 - exp(-pixels / 4)
boundary    = clip(distance from ignition to polygon edge / 750 m, 0.3, 1)
containment = share of the event's pixels inside the polygon
origin      = 0.5 if the event is censored, else 1
spread-in   -> conf = 0
```

This is a transparent heuristic, not a learned model: there is no labelled ground truth for who lit a fire. A field pilot with patrol logs would provide labels to calibrate it.

## 3. Seven-day fire risk (`pipeline/risk.py`)

- **Target:** at least one VIIRS S-NPP detection in a 0.05° cell (~5.5 km) in days t+1 to t+7.
- **Features (13):** fires in the cell over 1, 3 and 7 days; fires in the 3×3 and 5×5 neighbourhood over 7 days; rainfall over 7 and 30 days plus the 30-day anomaly (NASA POWER); peat share; oil-palm and pulpwood concession share; day of year (sine, cosine).
- **Data:** June–November, 2019–2025, 2,760 cells per day, 3.5 million cell-days. A single sensor (S-NPP) is used for training and live scoring, so counts are comparable.
- **Model:** LightGBM, 63 leaves, early stopping on average precision.
- **Splits by year (no leakage across seasons):** train 2019–2023, early-stop on 2024, test on 2025. A robustness run holds out 2023 (El Niño).

| Held-out season | Positives | ROC-AUC (baseline) | PR-AUC (baseline) | Fires captured by riskiest 5% of cells (baseline) |
| --- | --- | --- | --- | --- |
| 2025 | 1.1% | 0.826 (0.680) | 0.143 (0.114) | 41% (36%) |
| 2023, El Niño | 7.4% | 0.872 (0.833) | 0.457 (0.417) | 38% (36%) |

The baseline scores each cell by its fires in the last 7 days plus a tenth of its neighbours' fires.

**Feature importance (gain share):** neighbourhood fires 7 days 39%, own fires 7 days 25%, outer ring 10%, 30-day rain 6%, rain anomaly 4%, season 6%, peat 2%, concession type 2%.

**Limitations:** the live forecast only has 7 days of fire history (the training features also used 7 days at most, so this is consistent); rainfall lags 2–3 days; the model predicts *detections*, which under-count smouldering peat fires under haze.
