# Security and data-integrity assessment

## What must be protected

| Asset | Threat | Why it matters |
| --- | --- | --- |
| Evidence record | Someone edits or deletes detections after a fire (operator, concession holder, agency) | Evidence used by regulators or courts must be the same evidence that existed on the day |
| Escrowed funds | Theft, double payment, funds stuck forever | Funders will not lock money in a contract that can lose it |
| Fair outcomes | A community loses money for a fire it did not start, or a liable party gets paid | Wrong payouts destroy trust faster than no scheme at all |
| Model integrity | The model is quietly changed to favour someone | An attribution is only meaningful if everyone knows which model produced it |

## Controls in the current build

**Evidence (EvidenceRegistry.sol)**
- Write-once per day: `anchor()` reverts with `AlreadyAnchored` if a root exists. Tested.
- Only allow-listed oracles can anchor; only the owner manages oracles. Tested.
- Each leaf is SHA-256 of a canonical JSON row (sorted keys, no whitespace). Internal nodes are SHA-256 of the sorted pair. The same algorithm runs in Python (`pipeline/merkle.py`), Node (`lib/merkle.js`), the browser (`web/app.js`) and Solidity (`processProof`), and the roots match across all four.
- Tamper test: changing one value in one row makes `verify()` and `verifyRow()` return false. Tested, and demonstrable in the dashboard.
- Each anchor stores the dataset description and the **model version**, so an attribution can always be traced to the code that made it.
- Empty roots and malformed day keys are rejected.

**Funds (FireFreeEscrow.sol)**
- Checks-effects-interactions: status is set before any transfer; `ReentrancyGuard` on every function that sends ETH.
- A pledge can only settle once (`BadStatus` on a second attempt). Tested.
- The oracle cannot report before the season ends, and must cite an evidence day that is already anchored (`EvidenceNotAnchored`). Tested.
- If the oracle never reports, the funder can `reclaim()` after a grace period, so funds can't get stuck. Tested.
- Funding parameters are validated (non-zero amount and addresses, season end after season start).

**Fairness**
- Only fires that **start** inside a polygon count. Fires that spread in are recorded but never slash.
- Attributions below 0.70 confidence never slash (`confidenceThresholdBps`).
- Fires already burning when the record starts have their confidence halved.
- Every report opens a dispute window. The beneficiary can file counter-evidence (a URI to patrol logs or photos), which freezes settlement until the arbiter rules. Tested.

## Known risks and how production hardens them

| Risk | Current state | Production design |
| --- | --- | --- |
| Single oracle key compromised or bribed | One key reports outcomes | 2-of-3 oracle set run by independent parties (for example an agency, an NGO and a university), each re-running the open pipeline from public satellite data; oracles stake a bond that is slashed when a dispute is upheld |
| Arbiter is the contract owner | Owner resolves disputes | Multisig of named institutions, or an optimistic-oracle style escalation |
| Satellite blind spots (cloud, smouldering peat, small fires) | "Fire-free" means not detected | Add Sentinel-2 / Landsat burned-area checks after the season; disputes allowed both ways |
| Outdated concession boundaries | 2012 Ministry of Forestry maps | Use current licences from the ministry's One Map, anchored with a version hash like the model |
| Data availability | Bundles hosted with the site | Pin bundles to IPFS / Filecoin and store the CID in `uri` |
| Privacy | Only public satellite data and public licence maps | Field evidence uploaded in disputes is stored off-chain with only its hash on-chain |
| Key management | Throwaway testnet keys | Hardware or multisig wallets; no private keys in the repository (`.deployer.json` and `.demo-wallets.json` are git-ignored) |

## Responsible-AI notes

- The attribution confidence formula is published in full and has four terms that anyone can recompute.
- Model metrics are reported against a naive baseline on held-out seasons, including an El Niño year.
- The dashboard states, next to every attribution, that a detection inside a boundary is evidence for investigation and not proof of responsibility.
