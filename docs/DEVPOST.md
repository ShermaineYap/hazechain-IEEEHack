# Devpost submission text (paste-ready)

**Project name:** HazeChain

**Tagline (max ~200 chars):** Satellite-verified peat fire evidence anchored on Ethereum, and a smart contract that pays communities only when the satellites confirm their land stayed fire-free.

**Built with:** python, scikit-learn, lightgbm, geopandas, solidity, hardhat, openzeppelin, ethereum-sepolia, ethers.js, leaflet, nasa-firms, global-forest-watch, nasa-power

**Links:** live dashboard https://shermaineyap.github.io/hazechain-IEEEHack/ · GitHub https://github.com/ShermaineYap/hazechain-IEEEHack · video https://youtu.be/beg2q_ye9bQ · EvidenceRegistry https://sepolia.etherscan.io/address/0xAE2a5A8554FC34BB2d45437Ca87A63aFe04Ed6b6 · FireFreeEscrow https://sepolia.etherscan.io/address/0x08d0fc52f066212ACA78D2681aA13805229CBA2a (verified source: https://repo.sourcify.dev/11155111/0xAE2a5A8554FC34BB2d45437Ca87A63aFe04Ed6b6, https://repo.sourcify.dev/11155111/0x08d0fc52f066212ACA78D2681aA13805229CBA2a)

**File upload:** `submission/HazeChain_onepager.pdf`

---

## Track

**Climate Data & Environmental Monitoring.** HazeChain is a climate data verification platform: it turns satellite fire data into evidence anyone can verify, and makes that verified data move money.

## Inspiration

I study in Malaysia, and every dry season the haze comes back. In September 2026 Indonesia recorded 1,437 hotspots in a single day, and air quality was unhealthy in 38 areas of Malaysia and across Singapore. Satellites already see every one of these fires. What is missing is evidence nobody can deny, and a reason for the people on the land to keep it from burning.

## What it does

1. **Ingests** live NASA FIRMS VIIRS detections from three satellites, seven years of fire history, concession and peat maps from Global Forest Watch, sub-district boundaries and NASA POWER rainfall.
2. **AI** clusters pixels into fire events, finds each ignition point and decides, for every concession or sub-district a fire touches, whether the fire **started** there or **spread in**. A LightGBM model forecasts each 5 km cell's fire risk for the next 7 days.
3. **Anchors** every detection, event and attribution as a SHA-256 Merkle leaf; each day's root is written once to the `EvidenceRegistry` contract and can never be overwritten.
4. **Pays or slashes:** the `FireFreeEscrow` contract holds a funder's money against a polygon for a fire season. The oracle reports ignitions, citing an anchored evidence day. After a dispute window, no confident ignition pays the community or company; a confident ignition sends the money to a fire-suppression pool. Fires that spread in never count, attributions below 0.70 never slash, and the beneficiary can dispute.
5. **Lets anyone verify:** the dashboard rebuilds a day's Merkle root in the browser and asks the contract whether a single row belongs, with no wallet. A tamper button shows the contract rejecting an edited row.

## Results on this week's real data (17–24 Oct 2026, Central Kalimantan)

- 58,466 detections → 2,318 fire events; 79% on drained peat; only 25% inside licensed concessions.
- 152 of 260 concessions stayed fire-free; 46 had a confident ignition inside; 3 were only hit by fires spreading in.
- Fire-risk model on held-out seasons: ROC-AUC **0.826** vs 0.680 baseline (2025); **0.872** vs 0.833 (2023, El Niño). The riskiest 5% of cells caught 41% of the next week's fires.
- Four live pledges on Sepolia: a village and a fire-free concession **paid**, a concession with five confident ignitions **slashed**, and a borderline case **disputed**.

## How I built it

Python (GeoPandas, scikit-learn DBSCAN, LightGBM) for the pipeline; Solidity 0.8.24 with OpenZeppelin, Hardhat and 14 tests for the contracts; a static Leaflet + ethers.js dashboard with no build step. The same SHA-256 sorted-pair Merkle algorithm runs in Python, Node, the browser and Solidity, and I check that all four produce identical roots. Every data source is public and needs no API key.

## Why blockchain

Three parties who don't trust each other need one record: the community being paid, the funder paying, and the regulator or court that may act. A database run by any one of them can be edited by that one. A write-once registry makes the evidence permanent, and a conditional escrow makes payment automatic, with no intermediary deciding who gets paid.

## Climate impact

Drained tropical peat emits about 800 tCO₂e per hectare burned (IPCC 2013 Wetlands Supplement, Tables 2.6–2.7). Keeping 1,000 ha from burning avoids about 0.8 MtCO₂e. APRIL's Fire Free Village Programme reported a 90% fall in burnt area across 9 pilot villages for about US$30,000 per village; at that cost, 1,000 ha saved is under US$0.04 per tonne. HazeChain makes such schemes verifiable by outsiders, so governments, commodity buyers and climate funds can pay for outcomes.

## Target users and adoption

Village fire-care groups, plantation companies, commodity buyers doing EUDR/RSPO due diligence, Indonesia's environment ministry and peat agency, haze regulators in Malaysia and Singapore, and results-based climate finance. Plan: a 2027 pilot in one regency with 10–20 village pledges and a three-party oracle set, then all peat provinces in Indonesia and Malaysia. The pipeline is global because NASA FIRMS is global.

## Challenges

- Peat fires burn for days, so a 7-day record cannot see where the biggest fires started. I flag these "censored" fires and halve their confidence instead of inventing an ignition point.
- Fair attribution: fires cross boundaries, so I record started vs spread-in for every polygon a fire touches.
- Keeping the AI honest: there is no labelled data for who lit a fire, so the attribution is a transparent, published formula, and the risk model is always compared with a naive baseline on seasons it never saw.

## What's next

A multi-party oracle with staking, Sentinel-2 burned-area checks after each season, current licence maps, IPFS-pinned bundles, and a field pilot that measures how much burning the incentive actually prevents.

## Security and data integrity

Write-once roots, oracle allow-list, reentrancy guard, no double settlement, funder refund if the oracle disappears, dispute window, and a published threat model with the production hardening plan (`docs/SECURITY.md`).
