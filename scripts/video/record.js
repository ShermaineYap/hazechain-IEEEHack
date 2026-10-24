// Record a narrated walkthrough of the live dashboard. Usage: node record.js <outdir>
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.argv[2];
const SITE = process.env.SITE || "https://shermaineyap.github.io/hazechain-IEEEHack/";
const N = JSON.parse(fs.readFileSync(__dirname + "/narration.json"));
const D = JSON.parse(fs.readFileSync(OUT + "/durations.json"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
  const p = await ctx.newPage();
  const T0 = Date.now();
  await p.goto(SITE + "?v=video", { waitUntil: "networkidle", timeout: 90000 });
  await sleep(5000);
  await p.addStyleTag({ content: `
    #cap { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 9999; max-width: 1040px;
      background: rgba(16,27,26,.88); color: #fff; font: 600 19px/1.35 Archivo, sans-serif; padding: 10px 18px; border-radius: 10px; text-align: center; }
    #card { position: fixed; inset: 0; z-index: 9998; display: grid; place-items: center; background: rgba(16,27,26,.82); color: #fff; text-align: center; font-family: Archivo, sans-serif; }
    #card h1 { font-size: 64px; font-variation-settings: "wdth" 70; margin: 0 0 12px; }
    #card p { font-size: 22px; margin: 6px 0; opacity: .92; }
    .leaflet-popup-content { font-size: 15px !important; }` });
  await p.evaluate(() => { const c = document.createElement("div"); c.id = "cap"; document.body.appendChild(c); });
  const cap = (t) => p.evaluate((t) => { document.getElementById("cap").textContent = t; }, t);
  const card = (html) => p.evaluate((h) => { let c = document.getElementById("card"); if (!h) { c && c.remove(); return; } if (!c) { c = document.createElement("div"); c.id = "card"; document.body.appendChild(c); } c.innerHTML = h; }, html);
  const scroll = (sel) => p.evaluate((s) => { const el = s === "top" ? null : document.querySelector(s); window.scrollTo({ top: el ? el.getBoundingClientRect().top + scrollY - 52 : 0, behavior: "smooth" }); }, sel);

  const marks = {};
  async function scene(id, fn) {
    const s = N.find((x) => x.id === id);
    const start = Date.now(); marks[id] = (start - T0) / 1000;
    await cap(s.caption);
    if (fn) await fn();
    const left = D[id] * 1000 + 700 - (Date.now() - start);
    if (left > 0) await sleep(left);
  }

  await scene("s0", async () => {
    await cap("");
    await card(`<div><h1>HazeChain</h1><p>Satellite-verified peat fire evidence and pay-for-no-fire escrow</p><p>IEEE ClimateChain Global Hackathon 2026 &middot; Climate Data &amp; Environmental Monitoring</p></div>`);
  });
  await card(null);
  await scene("s1");
  await scene("s2", async () => { await p.evaluate(() => { map.flyTo([-2.75, 113.95], 9.5, { duration: 4 }); }); });
  await scene("s3", async () => {
    await p.evaluate(async () => {
      const ev = await (await fetch("data/events.geojson")).json();
      const e = ev.features.map((f) => f.properties).filter((x) => x.concession === "GFW-OP-877" && x.conc_conf >= 0.7 && x.n >= 10).sort((a, b) => b.conc_conf - a.conc_conf)[0];
      map.flyTo([e.ign_lat, e.ign_lon], 11, { duration: 3 });
      await new Promise((r) => setTimeout(r, 3300));
      evLayer.eachLayer((m) => { const ll = m.getLatLng(); if (Math.abs(ll.lat - e.ign_lat) < 1e-6 && Math.abs(ll.lng - e.ign_lon) < 1e-6) m.openPopup(); });
    });
  });
  await scene("s4", async () => {
    await p.evaluate(() => { map.closePopup(); const P = S.polys["GFW-OP-817"]; map.flyToBounds(P.l.getBounds(), { maxZoom: 11, duration: 3 }); setTimeout(() => showPoly("GFW-OP-817"), 3200); });
  });
  await scene("s5", async () => {
    await p.evaluate(() => { map.flyTo([-2.65, 114.0], 9, { duration: 3 }); });
    await sleep(3200); await p.click("#lRisk"); await sleep(1500); await p.click("#lDet");
    await sleep(6000); await p.evaluate(() => document.querySelector("#method").scrollIntoView({ behavior: "smooth" }));
  });
  await scene("s6", async () => {
    await p.click("#lDet"); await p.click("#lRisk");
    await scroll("#evidence"); await sleep(2500);
    await p.evaluate(async () => { const ev = await (await fetch("data/events.geojson")).json();
      const e = ev.features.map((f) => f.properties).filter((x) => x.day === "20261022" && x.concession && x.conc_conf >= 0.7).sort((a, b) => b.n - a.n)[0];
      await goVerify(e.day, e.event_id); });
    await scroll("#evidence"); await sleep(8000);
    await p.click("#vprove");
  });
  await scene("s7", async () => { await sleep(1200); await p.click("#vtamper"); await sleep(2500); await p.click("#vprove"); });
  await scene("s8", async () => { await scroll("#pledges"); });
  await scene("s9", async () => {
    await scroll("top"); await sleep(1500);
    await p.evaluate(() => { map.flyToBounds([[-3.8, 112.5], [-1.5, 115.5]], { duration: 3 }); });
    await sleep(D.s9 * 1000 - 9000);
    await cap("");
    await card(`<div><h1>HazeChain</h1><p>shermaineyap.github.io/hazechain-IEEEHack</p><p>github.com/ShermaineYap/hazechain-IEEEHack</p><p>Contracts verified on Ethereum Sepolia</p></div>`);
  });
  await sleep(2500);
  marks.end = (Date.now() - T0) / 1000;
  fs.writeFileSync(OUT + "/marks.json", JSON.stringify(marks));
  const v = await p.video().path();
  await ctx.close(); await b.close();
  fs.renameSync(v, OUT + "/screen.webm");
  console.log(JSON.stringify(marks));
})();
