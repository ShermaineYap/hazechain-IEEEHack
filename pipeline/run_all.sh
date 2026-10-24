#!/usr/bin/env bash
# Rebuild everything from public data. No API keys needed.
set -euo pipefail
cd "$(dirname "$0")"
RAW=../data/raw; mkdir -p $RAW
echo "1/8 live fires (NASA FIRMS, last 7 days, 3 satellites)"
for s in suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_SouthEast_Asia_7d.csv noaa-20-viirs-c2/csv/J1_VIIRS_C2_SouthEast_Asia_7d.csv noaa-21-viirs-c2/csv/J2_VIIRS_C2_SouthEast_Asia_7d.csv; do
  curl -sfL -o $RAW/$(basename $s) https://firms.modaps.eosdis.nasa.gov/data/active_fire/$s; done
echo "2/8 fire history 2019-2025 (FIRMS yearly archive, Indonesia)"
for y in 2019 2020 2021 2022 2023 2024 2025; do [ -s $RAW/snpp_$y.csv ] || curl -sfL -o $RAW/snpp_$y.csv "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/$y/viirs-snpp_${y}_Indonesia.csv"; done
echo "3/8 sub-districts (GADM 4.1)"
[ -s $RAW/gadm/gadm41_IDN_3.json ] || { curl -sfL -o $RAW/gadm_idn3.zip https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_IDN_3.json.zip && mkdir -p $RAW/gadm && unzip -oq $RAW/gadm_idn3.zip -d $RAW/gadm; }
echo "4/8 concessions + peat (Global Forest Watch tiles)"
python3 fetch_concessions.py 10; python3 fetch_peat.py
echo "5/8 ingest + rainfall (NASA POWER)"; python3 ingest.py
python3 - <<'PY'
import geopandas as gpd, glob
from shapely.geometry import box
from common import AOI, OUT
g = gpd.read_file(glob.glob('../data/raw/gadm/*.json')[0]); g = g[g.intersects(box(*AOI))].copy()
g['polygon_id'] = 'KEC-' + g.GID_3.str.replace('IDN.', '', regex=False).str.replace('_1', '', regex=False)
g[['polygon_id', 'NAME_1', 'NAME_2', 'NAME_3', 'geometry']].to_file(OUT / 'districts.geojson', driver='GeoJSON')
PY
echo "6/8 fire events + attribution"; python3 events.py
echo "7/8 risk model"; python3 risk.py
echo "8/8 evidence bundles + dashboard data"; python3 bundle.py; python3 export_web.py
echo "done: web/data is ready; next: npx hardhat run scripts/deploy.js --network sepolia"
