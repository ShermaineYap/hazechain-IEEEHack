const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const M = require("../lib/merkle");

const DAY = 20261022;
const rows = [
  '{"t":"det","lat":-2.79512,"lon":113.91541,"date":"2026-10-22","time":"0542","sat":"N20","frp":12.4}',
  '{"t":"det","lat":-2.80101,"lon":113.92011,"date":"2026-10-22","time":"0542","sat":"N20","frp":7.9}',
  '{"t":"event","id":"E-20261022-0007","ign_lat":-2.795,"ign_lon":113.915,"n":2}',
  '{"t":"attr","event":"E-20261022-0007","polygon":"GFW-OP-743","inside":1.0,"conf":0.91}',
  '{"t":"det","lat":-3.11,"lon":114.2,"date":"2026-10-22","time":"1802","sat":"N","frp":3.1}',
];

async function deploy(window = 7 * 86400) {
  const [owner, oracle, funder, village, pool, stranger] = await ethers.getSigners();
  const reg = await (await ethers.getContractFactory("EvidenceRegistry")).deploy(oracle.address);
  const esc = await (await ethers.getContractFactory("FireFreeEscrow")).deploy(await reg.getAddress(), window, 30 * 86400, 7000);
  return { reg, esc, owner, oracle, funder, village, pool, stranger };
}
async function anchored() {
  const ctx = await deploy();
  const leaves = rows.map(M.leafOf), levels = M.build(leaves), root = levels.at(-1)[0];
  await ctx.reg.connect(ctx.oracle).anchor(DAY, M.hex(root), rows.length, "FIRMS test", "test-0", "ipfs://x");
  return { ...ctx, leaves, levels, root };
}
async function funded(ctx, seasonLen = 100) {
  const now = await time.latest();
  await ctx.esc.connect(ctx.funder).fund("GFW-OP-743", ctx.village.address, ctx.pool.address, now, now + seasonLen, { value: ethers.parseEther("1") });
  await time.increase(seasonLen + 1);
  return 0;
}

describe("EvidenceRegistry", () => {
  it("anchors a day once and verifies every row", async () => {
    const { reg, leaves, levels } = await anchored();
    for (let i = 0; i < rows.length; i++) {
      expect(await reg.verify(DAY, M.hex(leaves[i]), M.proof(levels, i).map(M.hex))).to.equal(true);
      expect(await reg.verifyRow(DAY, ethers.toUtf8Bytes(rows[i]), M.proof(levels, i).map(M.hex))).to.equal(true);
    }
    expect(await reg.anchoredDayCount()).to.equal(1n);
  });
  it("rejects a tampered row", async () => {
    const { reg, levels } = await anchored();
    const forged = rows[3].replace("0.91", "0.10");
    expect(await reg.verifyRow(DAY, ethers.toUtf8Bytes(forged), M.proof(levels, 3).map(M.hex))).to.equal(false);
  });
  it("is write-once: a day can never be overwritten", async () => {
    const { reg, oracle } = await anchored();
    await expect(reg.connect(oracle).anchor(DAY, ethers.id("other"), 1, "", "", "")).to.be.revertedWithCustomError(reg, "AlreadyAnchored");
  });
  it("only oracles can anchor; owner manages oracles", async () => {
    const { reg, stranger, owner } = await deploy();
    await expect(reg.connect(stranger).anchor(DAY, ethers.id("r"), 1, "", "", "")).to.be.revertedWithCustomError(reg, "NotOracle");
    await expect(reg.connect(stranger).setOracle(stranger.address, true)).to.be.revertedWithCustomError(reg, "OwnableUnauthorizedAccount");
    await reg.connect(owner).setOracle(stranger.address, true);
    await reg.connect(stranger).anchor(DAY, ethers.id("r"), 1, "", "", "");
  });
  it("rejects empty roots and bad day keys", async () => {
    const { reg, oracle } = await deploy();
    await expect(reg.connect(oracle).anchor(DAY, ethers.ZeroHash, 1, "", "", "")).to.be.revertedWithCustomError(reg, "EmptyRoot");
    await expect(reg.connect(oracle).anchor(1999, ethers.id("r"), 1, "", "", "")).to.be.revertedWithCustomError(reg, "BadDay");
  });
});

describe("FireFreeEscrow", () => {
  it("pays the beneficiary when the season is fire-free", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 0, 9500, DAY);
    await expect(ctx.esc.settle(id)).to.be.revertedWithCustomError(ctx.esc, "WindowOpen");
    await time.increase(7 * 86400);
    await expect(ctx.esc.connect(ctx.stranger).settle(id)).to.changeEtherBalances([ctx.village, ctx.esc], [ethers.parseEther("1"), ethers.parseEther("-1")]);
    expect((await ctx.esc.getPledge(id)).status).to.equal(4); // Paid
  });
  it("slashes to the suppression pool on a confident attributed fire", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 3, 9100, DAY);
    await time.increase(7 * 86400);
    await expect(ctx.esc.settle(id)).to.changeEtherBalance(ctx.pool, ethers.parseEther("1"));
    expect((await ctx.esc.getPledge(id)).status).to.equal(5); // Slashed
  });
  it("does not slash on a low-confidence attribution", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 1, 5000, DAY);
    await time.increase(7 * 86400);
    await expect(ctx.esc.settle(id)).to.changeEtherBalance(ctx.village, ethers.parseEther("1"));
  });
  it("lets the beneficiary dispute, and the arbiter overturns a false fire", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 1, 8000, DAY);
    await expect(ctx.esc.connect(ctx.stranger).dispute(id, "x")).to.be.revertedWithCustomError(ctx.esc, "NotBeneficiary");
    await ctx.esc.connect(ctx.village).dispute(id, "ipfs://ground-photos-and-patrol-log");
    await time.increase(7 * 86400);
    await expect(ctx.esc.settle(id)).to.be.revertedWithCustomError(ctx.esc, "BadStatus");
    await expect(ctx.esc.connect(ctx.owner).resolveDispute(id, 0, 9900)).to.changeEtherBalance(ctx.village, ethers.parseEther("1"));
  });
  it("closes disputes after the window", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 1, 9000, DAY);
    await time.increase(7 * 86400);
    await expect(ctx.esc.connect(ctx.village).dispute(id, "late")).to.be.revertedWithCustomError(ctx.esc, "WindowClosed");
  });
  it("refuses reports before season end, without anchored evidence, or from non-oracles", async () => {
    const ctx = await anchored();
    const now = await time.latest();
    await ctx.esc.connect(ctx.funder).fund("V-1", ctx.village.address, ctx.pool.address, now, now + 1000, { value: 1n });
    await expect(ctx.esc.connect(ctx.oracle).report(0, 0, 9000, DAY)).to.be.revertedWithCustomError(ctx.esc, "SeasonNotOver");
    await time.increase(1001);
    await expect(ctx.esc.connect(ctx.oracle).report(0, 0, 9000, 20261023)).to.be.revertedWithCustomError(ctx.esc, "EvidenceNotAnchored");
    await expect(ctx.esc.connect(ctx.stranger).report(0, 0, 9000, DAY)).to.be.revertedWithCustomError(ctx.esc, "NotOracle");
  });
  it("refunds the funder if the oracle never reports", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await expect(ctx.esc.connect(ctx.funder).reclaim(id)).to.be.revertedWithCustomError(ctx.esc, "WindowOpen");
    await time.increase(30 * 86400);
    await expect(ctx.esc.connect(ctx.village).reclaim(id)).to.be.revertedWithCustomError(ctx.esc, "NotFunder");
    await expect(ctx.esc.connect(ctx.funder).reclaim(id)).to.changeEtherBalance(ctx.funder, ethers.parseEther("1"));
  });
  it("cannot be settled twice", async () => {
    const ctx = await anchored(); const id = await funded(ctx);
    await ctx.esc.connect(ctx.oracle).report(id, 0, 9000, DAY);
    await time.increase(7 * 86400);
    await ctx.esc.settle(id);
    await expect(ctx.esc.settle(id)).to.be.revertedWithCustomError(ctx.esc, "BadStatus");
  });
  it("validates funding params", async () => {
    const { esc, funder, village, pool } = await deploy();
    await expect(esc.connect(funder).fund("X", village.address, pool.address, 10, 5, { value: 1n })).to.be.revertedWithCustomError(esc, "BadParams");
    await expect(esc.connect(funder).fund("X", village.address, pool.address, 1, 5)).to.be.revertedWithCustomError(esc, "BadParams");
  });
});
