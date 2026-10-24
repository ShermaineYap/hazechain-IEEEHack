/*
 Deploy HazeChain to a testnet and run the live demo end to end:
   1. deploy EvidenceRegistry + FireFreeEscrow
   2. anchor every daily evidence bundle (web/data/bundles/index.json)
   3. fund four pay-for-no-fire pledges on real polygons
   4. after the (short, demo) season, report each with cited evidence
   5. the beneficiary of one pledge disputes; the others settle after the dispute window
   6. write web/data/deployment.json for the dashboard
 Usage: npx hardhat run scripts/deploy.js --network sepolia
 Env:   DISPUTE_WINDOW (s, default 120), SEASON (s, default 90), PLEDGE_ETH (default 0.001)
*/
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const WEB = path.join(__dirname, "..", "web", "data");
const OUT = path.join(WEB, "deployment.json");
const DISPUTE_WINDOW = Number(process.env.DISPUTE_WINDOW || 120);
const SEASON = Number(process.env.SEASON || 90);
const PLEDGE = ethers.parseEther(process.env.PLEDGE_ETH || "0.001");
const EXPLORERS = { sepolia: "https://sepolia.etherscan.io", baseSepolia: "https://sepolia.basescan.org", hardhat: "", localhost: "" };
const RPCS = { sepolia: "https://ethereum-sepolia-rpc.publicnode.com", baseSepolia: "https://sepolia.base.org" };
const NAMES = { sepolia: "Ethereum Sepolia", baseSepolia: "Base Sepolia" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (d) => fs.writeFileSync(OUT, JSON.stringify(d, null, 1));
async function waitUntil(provider, ts) {
  for (;;) {
    const b = await provider.getBlock("latest");
    if (b.timestamp >= ts) return;
    process.stdout.write(`  waiting ${ts - b.timestamp}s for chain time…\r`);
    if (network.name === "hardhat") { await provider.send("evm_increaseTime", [ts - b.timestamp]); await provider.send("evm_mine", []); }
    else await sleep(Math.min(15000, (ts - b.timestamp + 2) * 1000));
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  console.log(`network ${network.name}, deployer ${deployer.address}, balance ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`);

  // demo wallets (kept locally, never committed)
  const wpath = path.join(__dirname, "..", ".demo-wallets.json");
  let W = fs.existsSync(wpath) ? JSON.parse(fs.readFileSync(wpath)) : null;
  if (!W) {
    const mk = () => { const w = ethers.Wallet.createRandom(); return { address: w.address, privateKey: w.privateKey }; };
    W = { village: mk(), concessionA: mk(), concessionB: mk(), concessionC: mk(), suppressionPool: mk() };
    fs.writeFileSync(wpath, JSON.stringify(W, null, 1), { mode: 0o600 });
  }

  const dep = { network: network.name, networkName: NAMES[network.name] || network.name, chainId: Number(network.config.chainId || 31337),
    rpc: RPCS[network.name] || "http://127.0.0.1:8545", explorer: EXPLORERS[network.name] || "", deployer: deployer.address,
    disputeWindowSeconds: DISPUTE_WINDOW, confidenceThresholdBps: 7000, anchors: {}, pledges: [], deployedAt: new Date().toISOString() };

  // 1. deploy
  const reg = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(deployer.address);
  await reg.waitForDeployment(); dep.registry = await reg.getAddress(); dep.registryTx = reg.deploymentTransaction().hash;
  console.log("EvidenceRegistry", dep.registry);
  const esc = await (await ethers.getContractFactory("FireFreeEscrow")).deploy(dep.registry, DISPUTE_WINDOW, 86400, 7000);
  await esc.waitForDeployment(); dep.escrow = await esc.getAddress(); dep.escrowTx = esc.deploymentTransaction().hash;
  console.log("FireFreeEscrow  ", dep.escrow);
  save(dep);

  // 2. anchor evidence
  const index = JSON.parse(fs.readFileSync(path.join(WEB, "bundles", "index.json")));
  for (const b of index) {
    const tx = await reg.anchor(b.day, b.root, b.rowCount, b.dataset, b.modelVersion, b.uri);
    await tx.wait(); dep.anchors[b.day] = tx.hash;
    console.log(`anchored ${b.day} ${b.root} (${b.rowCount} rows) tx ${tx.hash}`);
    save(dep);
  }

  // 3. pick evidence days for reports from the attribution data
  const events = JSON.parse(fs.readFileSync(path.join(WEB, "events.geojson"))).features.map((f) => f.properties);
  const bestDay = (pid) => {
    const e = events.filter((x) => x.concession === pid).sort((a, b) => b.conc_conf - a.conc_conf)[0];
    return e ? Number(e.day) : index.at(-2).day;
  };
  const evDay = index.at(-2).day; // last complete day
  const PLAN = [
    { polygonId: "KEC-14.1.6", label: "Karau Kuala sub-district (village pledge)", ben: W.village, ignitions: 0, conf: 9500, day: evDay, expect: "Paid" },
    { polygonId: "GFW-OP-817", label: "Fire-free oil-palm concession on deep peat", ben: W.concessionA, ignitions: 0, conf: 9500, day: evDay, expect: "Paid" },
    { polygonId: "GFW-OP-877", label: "Concession with 5 confident ignitions", ben: W.concessionB, ignitions: 5, conf: 10000, day: bestDay("GFW-OP-877"), expect: "Slashed" },
    { polygonId: "GFW-OP-799", label: "Concession with one borderline ignition (0.71)", ben: W.concessionC, ignitions: 1, conf: 7130, day: bestDay("GFW-OP-799"), expect: "Disputed" },
  ];

  // gas money for the beneficiary who will dispute
  await (await deployer.sendTransaction({ to: W.concessionC.address, value: ethers.parseEther("0.0005") })).wait();

  // 4. fund pledges with a short demo season
  const t0 = (await provider.getBlock("latest")).timestamp;
  for (const [i, p] of PLAN.entries()) {
    const tx = await esc.fund(p.polygonId, p.ben.address, W.suppressionPool.address, t0, t0 + SEASON, { value: PLEDGE });
    await tx.wait();
    dep.pledges.push({ id: i, polygonId: p.polygonId, label: p.label, beneficiary: p.ben.address, slashPool: W.suppressionPool.address,
      expect: p.expect, evidenceDay: p.day, txs: { fund: tx.hash } });
    console.log(`pledge ${i} funded on ${p.polygonId} tx ${tx.hash}`);
    save(dep);
  }

  // 5. season ends -> oracle reports
  await waitUntil(provider, t0 + SEASON + 1);
  for (const [i, p] of PLAN.entries()) {
    const tx = await esc.report(i, p.ignitions, p.conf, p.day); await tx.wait();
    dep.pledges[i].txs.report = tx.hash; console.log(`pledge ${i} reported ${p.ignitions} ignitions @ ${p.conf / 100}% (evidence ${p.day}) tx ${tx.hash}`);
    save(dep);
  }

  // 6. the borderline concession disputes with ground evidence
  const benC = new ethers.Wallet(W.concessionC.privateKey, provider);
  const dtx = await esc.connect(benC).dispute(3, "ipfs://demo-ground-patrol-log-and-photos (fire entered from the river corridor)");
  await dtx.wait(); dep.pledges[3].txs.dispute = dtx.hash; console.log(`pledge 3 disputed tx ${dtx.hash}`);
  save(dep);

  // 7. settle the rest after the dispute window
  const p0 = await esc.getPledge(0);
  await waitUntil(provider, Number(p0.disputeDeadline) + 1);
  for (const i of [0, 1, 2]) {
    const tx = await esc.settle(i); await tx.wait();
    const st = ["None", "Active", "Reported", "Disputed", "Paid", "Slashed", "Refunded"][Number((await esc.getPledge(i)).status)];
    dep.pledges[i].txs.settle = tx.hash; dep.pledges[i].outcome = st;
    console.log(`pledge ${i} settled -> ${st} tx ${tx.hash}`);
    save(dep);
  }
  dep.pledges[3].outcome = "Disputed";
  save(dep);
  console.log(`done. balance left ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH; wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
