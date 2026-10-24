# Climate impact, adoption and scalability

## Why peat fires

Southeast Asia holds about 60% of the world's tropical peatland. Drained peat burns underground for weeks, releases far more carbon per hectare than a forest fire on mineral soil, and produces the transboundary haze that has hit Indonesia, Malaysia and Singapore again in 2026.

## Emissions per hectare (IPCC Tier 1)

| Quantity | Value | Source |
| --- | --- | --- |
| Fuel consumed, tropical drained peat wildfire | 353 t dry matter / ha (95% CI 170–536) | IPCC 2013 Wetlands Supplement, Table 2.6 |
| CO₂-C emission factor | 464 g / kg dry matter → 1.70 t CO₂ per t | Table 2.7 |
| CH₄ emission factor | 21 g / kg dry matter; GWP100 = 27 (AR6, non-fossil) | Table 2.7 |
| **Total** | **≈ 800 tCO₂e / ha** (range 386–1,216) | computed in `pipeline/export_web.py` |

## This week in the study area (17–24 Oct 2026)

- 58,466 detections; 79% on peat; 25% inside concessions.
- 14,424 distinct 375 m pixels on peat had fire: **202,838 ha** of peat under fire pixels. This is an upper bound on burned area, because one hot spot does not mean the whole 14 ha pixel burned.
- 152 of 260 concessions and 31 of 189 sub-districts had no fire at all. These are the land managers a pay-for-no-fire scheme would reward.

## Impact model for a HazeChain deployment

Avoided emissions = hectares of peat kept from burning × ~800 tCO₂e.

| Scenario | Peat kept from burning | Avoided emissions |
| --- | --- | --- |
| One district pilot | 1,000 ha | ≈ 0.8 MtCO₂e |
| One province, one season | 10,000 ha | ≈ 8 MtCO₂e |

The key unknown, how much burning the incentive prevents, has one reference point: APRIL's Fire Free Village Programme reported a 90% fall in burnt area across its 9 pilot villages from 2014 to 2015, at about US$30,000 per village ([APRIL, 2016](https://www.rgei.com/attachments/article/565/20160102-april-group-builds-on-successful-fire-free-village-programme.pdf); company-reported). A US$30,000 pledge that keeps 1,000 ha of peat from burning pays about **US$0.04 per tCO₂e avoided**, which is cheaper than almost any carbon credit on the market. HazeChain's contribution is to make that kind of scheme **verifiable by outsiders**, so governments, commodity buyers and climate funds can pay into it without trusting one company's report.

HazeChain does not claim avoided emissions on its own. The pilot's first job is to measure the counterfactual: burned area in pledged polygons against matched unpledged polygons with the same peat share and fire history, using the same anchored satellite record.

## Who uses it

| User | What they do with HazeChain |
| --- | --- |
| Village / sub-district fire-care groups (Masyarakat Peduli Api) | Receive pledges; dispute wrong reports with patrol logs |
| Plantation and pulpwood companies | Prove fire-free management to buyers; earn performance payments |
| Commodity buyers, RSPO members, EUDR due diligence | Fund pledges for supply-shed villages; cite anchored evidence in sustainability reports |
| Indonesian Ministry of Environment, BRGM (peat restoration agency) | Use anchored attribution in investigations (the ministry is examining 57 concessions this season) |
| Malaysia and Singapore regulators | Evidence that meets "credible evidence" tests under transboundary haze law |
| Climate funds and results-based finance (Article 6, REDD+) | Pay for outcomes with transparent MRV instead of promises |

## Adoption plan

1. **Now (hackathon):** open-source pipeline, contracts on Sepolia, live dashboard for one Central Kalimantan study area.
2. **Pilot, 2027 dry season:** one regency (for example Pulang Pisau), 10–20 village pledges funded by one buyer or NGO; oracle set of three independent operators; field patrol logs used to calibrate attribution confidence.
3. **Scale:** all peat provinces in Indonesia and Malaysia; stablecoin pledges on a low-fee L2; integration with the ASEAN haze coordinating centre and RSPO grievance processes.

## Scalability and sustainability

- **Data scales for free:** NASA FIRMS is global and near-real-time. The same pipeline runs for Sumatra, Sarawak, the Amazon, Australian savanna or the Canadian boreal by changing one bounding box.
- **On-chain cost is constant per day,** not per fire: one 32-byte root per day per region, whatever the number of detections. At this week's Sepolia gas price, anchoring a day costs a fraction of a US cent; on an L2 it stays negligible at global scale.
- **Compute is small:** the full week's pipeline, including model training, runs in about 2 minutes on a laptop.
- **Running costs** (oracle operators, hosting) can be covered by a small fee on pledges, so the scheme does not depend on grants.
