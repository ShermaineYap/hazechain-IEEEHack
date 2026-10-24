/* HazeChain dashboard. Static site: reads the pipeline's JSON and the Sepolia contracts (read-only, no wallet). */
"use strict";
const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString("en-US");
const DATA = "data/";
const STATUS_TEXT = {
  "fire-free": "Fire-free this week",
  "confident-ignition": "Fire started inside",
  "low-confidence-ignition": "Possible ignition, low confidence",
  "affected-spread-in": "Only fire spreading in",
};
const PSTATUS = ["None", "Active", "Reported", "Disputed", "Paid", "Slashed", "Refunded"];
const REG_ABI = [
  "function rootOf(uint32) view returns (bytes32)",
  "function verify(uint32,bytes32,bytes32[]) view returns (bool)",
  "function anchoredDayCount() view returns (uint256)",
];
const ESC_ABI = [
  "function pledgeCount() view returns (uint256)",
  "function getPledge(uint256) view returns (tuple(address funder,address beneficiary,address slashPool,uint64 seasonStart,uint64 seasonEnd,uint64 disputeDeadline,uint32 ignitions,uint16 confidenceBps,uint32 evidenceDay,uint8 status,uint256 amount,string polygonId,string disputeUri))",
  "function confidenceThresholdBps() view returns (uint16)",
];

const S = { dayIdx: null, polys: {}, bundle: null, levels: null, leaves: null, dep: null, reg: null, esc: null };

async function j(path) {
  const r = await fetch(DATA + path, { cache: "no-cache" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

/* ------------------------------------------------------------------ chain */
async function initChain() {
  try { S.dep = await j("deployment.json"); } catch { S.dep = null; }
  const badge = $("#chainBadge");
  if (!S.dep || !S.dep.registry) {
    badge.innerHTML = '<span class="dot off"></span>Contracts not deployed yet; roots checked locally';
    return;
  }
  const provider = new ethers.JsonRpcProvider(S.dep.rpc, S.dep.chainId, { staticNetwork: true });
  S.reg = new ethers.Contract(S.dep.registry, REG_ABI, provider);
  S.esc = new ethers.Contract(S.dep.escrow, ESC_ABI, provider);
  const ex = S.dep.explorer;
  badge.innerHTML = `<span class="dot"></span>Live on ${S.dep.networkName}: <a href="${ex}/address/${S.dep.registry}#code" target="_blank" rel="noopener">registry</a> and <a href="${ex}/address/${S.dep.escrow}#code" target="_blank" rel="noopener">escrow</a>`;
}

/* ------------------------------------------------------------------ map */
let map, detLayer, riskLayer, evLayer, concLayer, distLayer, det, risk, summary;

const CanvasPoints = L.Layer.extend({
  initialize(draw) { this._draw = draw; },
  onAdd(m) {
    this._m = m;
    this._c = L.DomUtil.create("canvas", "leaflet-zoom-hide");
    this._c.style.position = "absolute"; this._c.style.pointerEvents = "none";
    m.getPanes().overlayPane.appendChild(this._c);
    m.on("moveend zoomend resize", this.redraw, this);
    this.redraw();
  },
  onRemove(m) { this._c.remove(); m.off("moveend zoomend resize", this.redraw, this); },
  redraw() {
    const m = this._m, size = m.getSize(), dpr = window.devicePixelRatio || 1;
    const tl = m.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._c, tl);
    this._c.width = size.x * dpr; this._c.height = size.y * dpr;
    this._c.style.width = size.x + "px"; this._c.style.height = size.y + "px";
    const ctx = this._c.getContext("2d"); ctx.scale(dpr, dpr);
    this._draw(ctx, (lat, lon) => m.latLngToContainerPoint([lat, lon]), m.getZoom());
  },
});

function drawDetections(ctx, P, z) {
  const rows = det.rows, last = det.days.length - 1, sel = S.dayIdx;
  const r = Math.max(1.2, Math.min(4, (z - 7) * 0.9));
  for (const [lat, lon, d] of rows) {
    if (sel !== null && d !== sel) continue;
    const age = last - d;
    ctx.fillStyle = sel !== null ? "rgba(255,92,40,.95)" : age <= 1 ? "rgba(255,92,40,.95)" : age <= 3 ? "rgba(255,170,70,.8)" : "rgba(255,214,150,.45)";
    const p = P(lat, lon);
    ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
  }
}
function drawRisk(ctx, P) {
  const [w, s] = risk.aoi, c = risk.cell;
  for (let y = 0; y < risk.ny; y++) for (let x = 0; x < risk.nx; x++) {
    const v = risk.grid[y][x]; if (v < 0.08) continue;
    const a = P(s + (y + 1) * c, w + x * c), b = P(s + y * c, w + (x + 1) * c);
    ctx.fillStyle = `rgba(${v > .5 ? "122,30,18" : "224,80,42"},${Math.min(.65, .1 + v * .6)})`;
    ctx.fillRect(a.x, a.y, b.x - a.x + .5, b.y - a.y + .5);
  }
}
const concColor = (st) => ({ "fire-free": "#5FD38D", "confident-ignition": "#FF5C28", "low-confidence-ignition": "#F2C14E", "affected-spread-in": "#C9D6D1" }[st]);

async function initMap() {
  const [sum, conc, dist, ev, d, rk] = await Promise.all([
    j("summary.json"), j("concessions.geojson"), j("districts.geojson"), j("events.geojson"), j("detections.json"), j("risk.json")]);
  summary = sum; det = d; risk = rk;
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  map = L.map("map", { preferCanvas: true, zoomSnap: 0.5 }).fitBounds([[sum.aoi[1], sum.aoi[0]], [sum.aoi[3], sum.aoi[2]]]);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics", maxZoom: 16, className: "imagery" }).addTo(map);

  distLayer = L.geoJSON(dist, {
    style: () => ({ color: "#E8EFEA", weight: 0.9, fill: true, fillOpacity: 0, dashArray: "3 3" }),
    onEachFeature: (f, l) => { S.polys[f.properties.polygon_id] = { f, l, kind: "district" }; l.on("click", () => showPoly(f.properties.polygon_id)); },
  });
  concLayer = L.geoJSON(conc, {
    style: (f) => ({ color: concColor(f.properties.status), weight: 1.4, fillColor: concColor(f.properties.status), fillOpacity: 0.08 }),
    onEachFeature: (f, l) => { S.polys[f.properties.polygon_id] = { f, l, kind: "concession" }; l.on("click", () => showPoly(f.properties.polygon_id)); },
  }).addTo(map);
  detLayer = new CanvasPoints(drawDetections).addTo(map);
  riskLayer = new CanvasPoints(drawRisk);
  const evs = ev.features.filter((f) => f.properties.n >= 10);
  evLayer = L.layerGroup(evs.map((f) => {
    const p = f.properties, attributed = p.concession && p.conc_conf >= 0.7;
    const m = L.circleMarker([p.ign_lat, p.ign_lon], {
      radius: Math.min(6.5, 1.5 + Math.log2(p.n) / 1.6), weight: attributed ? 2 : 1,
      color: attributed ? "#FFFFFF" : "#F5E6C8", fillColor: p.censored ? "transparent" : attributed ? "#E0502A" : "#F5A142", fillOpacity: p.censored ? 0 : 0.95,
    });
    m.bindPopup(() => eventPopup(p));
    return m;
  })).addTo(map);

  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = `<div class="ramp"></div>Fire pixels, newest brightest<br>
      <i style="background:#E0502A;border:1.5px solid #fff;border-radius:50%"></i>Ignition inside a concession, confidence 0.70+<br>
      <i style="background:#F5A142;border:1px solid #F5E6C8;border-radius:50%"></i>Other ignition (hollow: already burning on 17 Oct)<br>
      <i style="border:2px solid #5FD38D"></i>Concession fire-free<br>
      <i style="border:2px solid #FF5C28"></i>Fire started inside<br>
      <i style="border:2px solid #F2C14E"></i>Low-confidence ignition`;
    return div;
  };
  legend.addTo(map);

  // facts
  const f = [
    [fmt(sum.events_multi), "fires (pixel clusters) this week"],
    [Math.round(sum.share_on_peat * 100) + "%", "of fire pixels on drained peat"],
    [Math.round(sum.share_in_concessions * 100) + "%", "inside a licensed concession"],
    [`${sum.concessions_fire_free} of ${sum.concessions_total}`, "concessions stayed fire-free"],
    [fmt(sum.peat_pixel_area_ha) + " ha", "of peat under fire pixels (upper bound)"],
    ["≈" + fmt(sum.tco2e_per_ha) + " t", "CO₂e per hectare of peat that burns (IPCC)"],
  ];
  $("#facts").innerHTML = f.map(([a, b]) => `<div><dt>${b}</dt><dd>${a}</dd></div>`).join("");
  $("#kDet").textContent = fmt(sum.detections);

  // layer toggles
  const tog = (id, layer) => $(id).addEventListener("change", (e) => (e.target.checked ? layer.addTo(map) : map.removeLayer(layer)));
  tog("#lDet", detLayer); tog("#lEv", evLayer); tog("#lConc", concLayer); tog("#lDist", distLayer); tog("#lRisk", riskLayer);
  const day = $("#day"); day.max = det.days.length;
  day.value = det.days.length;
  day.addEventListener("input", () => {
    const v = +day.value;
    S.dayIdx = v === det.days.length ? null : v;
    $("#dayOut").textContent = S.dayIdx === null ? "All week" : new Date(det.days[v] + "T00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    detLayer.redraw();
  });

  // model card
  const m = risk.metrics;
  $("#mtext").textContent = `Gradient-boosted trees on the 2019–2023 fire seasons (${fmt(m.rows_train)} cell-days), tuned on 2024 and tested on 2025, which the model never saw. Neighbouring fires, recent fires and 30-day rainfall matter most.`;
  $("#metrics").innerHTML = [
    [m.roc_auc, `vs ${m.roc_auc_persistence} for “it burned last week”`, "ROC-AUC, 2025 season"],
    [Math.round(m.capture_top5pct * 100) + "%", `vs ${Math.round(m.capture_top5pct_persistence * 100)}%`, "of next week's fires in the riskiest 5% of cells"],
    [m.pr_auc, `vs ${m.pr_auc_persistence}`, "precision-recall AUC (fires in 1% of cell-days)"],
    [`${+risk.asof.slice(8)} Oct`, "", `forecast issued, rainfall to ${+risk.rain_last_day.slice(8)} Oct`],
  ].map(([a, s, b]) => `<div><dt>${b}</dt><dd>${a} <small>${s}</small></dd></div>`).join("");
}

function eventPopup(p) {
  const when = new Date(p.first).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
  const c = p.concession ? S.polys[p.concession]?.f.properties : null;
  const d = p.district ? S.polys[p.district]?.f.properties : null;
  const started = c ? `Started inside <b>${c.name}</b> (${p.concession}), confidence ${p.conc_conf.toFixed(2)}${p.conc_conf >= 0.7 ? "" : ", below the 0.70 threshold"}.`
    : `Started outside any concession${d ? `, in ${d.name}, ${d.regency}` : ""}.`;
  const spread = p.spread_into ? `<br>Spread into ${p.spread_into.split(",").length} other concession(s), which are not held liable.` : "";
  const cens = p.censored ? `<br><em>Already burning when the 7-day record began, so the true start is unknown and confidence is halved.</em>` : "";
  const div = document.createElement("div");
  div.innerHTML = `<b>Fire ${p.event_id}</b><br>${fmt(p.n)} pixels over ${p.duration_h} h, first seen ${when} WIB. ${Math.round(p.peat_share * 100)}% on peat, moved ${p.spread_km} km.<br>${started}${spread}${cens}<br>`;
  const b = document.createElement("button"); b.className = "btn"; b.textContent = "Check this fire's evidence";
  b.onclick = () => { map.closePopup(); goVerify(p.day, p.event_id); };
  div.appendChild(b);
  return div;
}

function showPoly(id) {
  const P = S.polys[id]; if (!P) return;
  const p = P.f.properties, isC = P.kind === "concession";
  Object.values(S.polys).forEach((q) => q.l.setStyle && q.l.setStyle({ weight: q.kind === "concession" ? 1.4 : 0.8 }));
  P.l.setStyle({ weight: 3.5 }); P.l.bringToFront();
  const title = isC ? p.name : p.name;
  const sub = isC ? `${p.kind === "oil_palm" ? "Oil-palm" : "Pulpwood"} concession ${p.polygon_id}, ${fmt(p.area_ha)} ha${p.company && p.company !== p.name ? `, ${p.company}` : ""}`
    : `Sub-district ${p.polygon_id}, ${p.regency}, ${fmt(p.area_ha)} ha`;
  const since = p.days_since_fire === null ? "None in 8 days" : p.days_since_fire === 0 ? "Today" : p.days_since_fire + " days ago";
  const verdict = p.status === "confident-ignition" ? `A pledge here would be <b>slashed</b>: ${p.events_confident} fire(s) started inside with confidence of 0.70 or more.`
    : p.status === "low-confidence-ignition" ? `A pledge here would still <b>pay out</b>, but the beneficiary should expect questions: the strongest attribution is ${p.max_conf.toFixed(2)}, under the 0.70 threshold.`
    : p.status === "affected-spread-in" ? `A pledge here would <b>pay out</b>: fire reached this land only from outside.`
    : `A pledge here would <b>pay out</b>: no fire pixels this week.`;
  const pledge = (S.pledges || []).find((q) => q.polygonId === id);
  $("#card").innerHTML = `<span class="status s-${p.status}">${STATUS_TEXT[p.status]}</span>
    <h3 style="margin-top:8px">${title}</h3><p class="sub">${sub}</p>
    <table>
      <tr><td>Fire pixels this week</td><td>${fmt(p.detections_week)}</td></tr>
      <tr><td>Fires that started inside</td><td>${p.events_started}</td></tr>
      <tr><td>…with confidence of 0.70 or more</td><td>${p.events_confident}</td></tr>
      <tr><td>Fires that spread in from outside</td><td>${p.events_spread_in}</td></tr>
      <tr><td>Last fire pixel</td><td>${since}</td></tr>
      <tr><td>Peat cover</td><td>${Math.round(p.peat_share * 100)}%</td></tr>
      <tr><td>Fire pixels, Jun–Nov 2025</td><td>${fmt(p.detections_2025_season)}</td></tr>
    </table>
    <p class="verdict">${verdict}</p>
    ${pledge ? `<a class="btn" href="#pledges" style="display:inline-block;text-decoration:none">See its pledge on-chain</a>` : ""}`;
}

/* ------------------------------------------------------------------ evidence */
const enc = new TextEncoder();
const hex = (u8) => "0x" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const cmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const cat = (a, b) => { const o = new Uint8Array(64); o.set(a); o.set(b, 32); return o; };
const parent = (a, b) => (cmp(a, b) <= 0 ? sha(cat(a, b)) : sha(cat(b, a)));

async function buildLevels(leaves) {
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), nxt = [];
    for (let i = 0; i < cur.length; i += 2) nxt.push(i + 1 < cur.length ? parent(cur[i], cur[i + 1]) : Promise.resolve(cur[i]));
    levels.push(await Promise.all(nxt));
  }
  return levels;
}
function proofOf(levels, i) {
  const out = [];
  for (let l = 0; l < levels.length - 1; l++) { const s = i ^ 1; if (s < levels[l].length) out.push(levels[l][s]); i >>= 1; }
  return out;
}
function step(k, cls, text) { const li = $(`#vsteps [data-k="${k}"]`); li.className = cls || ""; li.querySelector("em").innerHTML = text; }

async function loadBundle(day) {
  ["dl", "root", "chain"].forEach((k) => step(k, "", "waiting"));
  $("#rowcheck").hidden = true; $("#vresult").textContent = "";
  const t0 = performance.now();
  const r = await fetch(`${DATA}bundles/${day}.json.gz`);
  const buf = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const b = JSON.parse(buf); S.bundle = b;
  step("dl", "ok", `${fmt(b.rows.length)} rows, ${(buf.length / 1e6).toFixed(1)} MB, model ${b.modelVersion.split(" ")[0]}`);
  S.leaves = await Promise.all(b.rows.map((row) => sha(enc.encode(row))));
  S.levels = await buildLevels(S.leaves);
  const local = hex(S.levels.at(-1)[0]);
  step("root", local === b.root ? "ok" : "bad", `${local}<br>${local === b.root ? "matches the published bundle" : "does not match the published bundle"} (${Math.round(performance.now() - t0)} ms)`);
  if (S.reg) {
    try {
      const onchain = await S.reg.rootOf(day);
      const tx = S.dep.anchors?.[day];
      const link = tx ? ` <a href="${S.dep.explorer}/tx/${tx}" target="_blank" rel="noopener">anchoring transaction</a>` : "";
      if (onchain === ethers.ZeroHash) step("chain", "bad", "Not anchored on-chain yet");
      else step("chain", onchain.toLowerCase() === local ? "ok" : "bad", `${onchain}<br>${onchain.toLowerCase() === local ? "Identical to the root your browser computed." : "Differs from your browser's root: the bundle was altered."}${link}`);
    } catch (e) { step("chain", "bad", "Could not reach the Sepolia RPC: " + e.message); }
  } else step("chain", "", "Contracts not deployed yet");
  // row picker: events + attributions, plus a few detections
  const opts = [];
  b.rows.forEach((row, i) => {
    if (row.includes('"t":"attr"')) { const o = JSON.parse(row); opts.push([i, `Attribution: ${o.event} ${o.role} ${o.polygon} (conf ${o.conf})`]); }
    else if (row.includes('"t":"event"')) { const o = JSON.parse(row); opts.push([i, `Fire event: ${o.id}, ${o.n} pixels`]); }
  });
  for (let i = 0; i < Math.min(40, b.rows.length); i++) if (b.rows[i].includes('"t":"det"')) opts.push([i, "Detection: " + JSON.parse(b.rows[i]).id]);
  $("#vrow").innerHTML = opts.map(([i, t]) => `<option value="${i}">${t}</option>`).join("");
  $("#rowcheck").hidden = false;
  pickRow();
}
function pickRow() { const i = +$("#vrow").value; $("#vtext").value = S.bundle.rows[i]; $("#vresult").textContent = ""; $("#vresult").className = "vresult"; }

async function prove() {
  const i = +$("#vrow").value, text = $("#vtext").value, day = S.bundle.day;
  const leaf = await sha(enc.encode(text));
  const proof = proofOf(S.levels, i);
  let h = leaf; for (const p of proof) h = await parent(h, p);
  const localOk = hex(h) === S.bundle.root;
  const out = $("#vresult");
  let chainOk = null;
  if (S.reg) { try { chainOk = await S.reg.verify(day, hex(leaf), proof.map(hex)); } catch (e) { chainOk = null; } }
  const ok = chainOk ?? localOk;
  out.className = "vresult " + (ok ? "ok" : "bad");
  const who = chainOk === null ? "Checked in your browser against the published root" : "The EvidenceRegistry contract on Sepolia answered verify()";
  out.innerHTML = (ok ? "Proven: this exact row is part of the anchored evidence." : "Rejected: this row is not part of the anchored evidence. Someone changed it.")
    + `<small>${who}: ${ok}. Leaf ${hex(leaf)}, proof of ${proof.length} hashes.</small>`;
}
function tamper() {
  const t = $("#vtext"), before = t.value;
  let o; try { o = JSON.parse(before); } catch { o = null; }
  if (o && "conf" in o) o.conf = typeof o.conf === "number" ? (o.conf >= 0.7 ? 0.12 : 0.95) : o.conf === "high" ? "nominal" : "high";
  else if (o && "n" in o) o.n = o.n + 100;
  const keys = o ? Object.keys(o).sort() : [];
  t.value = o ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, o[k]]))) : before + " ";
  const what = o && "conf" in o ? `confidence changed to ${o.conf}` : "row edited";
  $("#vresult").className = "vresult"; $("#vresult").textContent = `Row edited (${what}). Ask the contract again.`;
}
async function goVerify(day, eventId) {
  $("#vday").value = day;
  location.hash = "#evidence";
  await loadBundle(+day);
  const idx = S.bundle.rows.findIndex((r) => r.includes('"t":"attr"') && r.includes(`"event":"${eventId}"`) && r.includes('"role":"started"'));
  const idx2 = idx >= 0 ? idx : S.bundle.rows.findIndex((r) => r.includes(`"id":"${eventId}"`));
  if (idx2 >= 0) { $("#vrow").value = idx2; pickRow(); }
}

async function initEvidence() {
  const idx = await j("bundles/index.json");
  $("#vday").innerHTML = idx.map((b) => `<option value="${b.day}">${String(b.day).slice(6)} Oct 2026: ${fmt(b.detections)} detections, ${fmt(b.events)} new fires</option>`).join("");
  $("#vday").value = String(idx.find((b) => b.day === 20261022)?.day || idx.at(-1).day);
  $("#vload").onclick = async () => { $("#vload").disabled = true; try { await loadBundle(+$("#vday").value); } finally { $("#vload").disabled = false; } };
  $("#vrow").onchange = pickRow; $("#vprove").onclick = prove; $("#vtamper").onclick = tamper;
}

/* ------------------------------------------------------------------ pledges */
async function initPledges() {
  const tb = $("#ptable");
  if (!S.esc) {
    tb.innerHTML = `<tr><td colspan="5" class="muted">The escrow contract is not deployed yet. Run <code>npx hardhat run scripts/deploy.js --network sepolia</code>.</td></tr>`;
    return;
  }
  try {
    const n = Number(await S.esc.pledgeCount());
    const rows = [];
    S.pledges = [];
    for (let i = 0; i < n; i++) {
      const p = await S.esc.getPledge(i);
      const meta = S.dep.pledges?.find((q) => q.id === i) || {};
      const poly = S.polys[p.polygonId]?.f.properties;
      const st = PSTATUS[Number(p.status)];
      S.pledges.push({ id: i, polygonId: p.polygonId, status: st });
      const tx = (k, label) => (meta.txs?.[k] ? `<a href="${S.dep.explorer}/tx/${meta.txs[k]}" target="_blank" rel="noopener">${label}</a>` : "");
      const report = Number(p.status) >= 2 ? `${p.ignitions} ignition(s), confidence ${(Number(p.confidenceBps) / 100).toFixed(0)}%<small>evidence of ${String(p.evidenceDay).slice(6)} Oct ${tx("report", "tx")}</small>` : '<span class="muted">Season running</span>';
      const outcome = `<span class="status s-${st}">${st}</span><small>${st === "Disputed" ? "Beneficiary filed counter-evidence; awaiting arbiter." : st === "Paid" ? "Sent to the beneficiary." : st === "Slashed" ? "Sent to the suppression pool." : ""} ${tx("settle", "tx")} ${tx("dispute", "dispute tx")}</small>`;
      rows.push(`<tr><td><a href="#top" data-poly="${p.polygonId}">${poly ? poly.name : p.polygonId}</a><small>${p.polygonId}</small></td>
        <td>${poly ? STATUS_TEXT[poly.status] : ""}<small>${poly ? `${fmt(poly.detections_week)} fire pixels, ${poly.events_confident} confident ignition(s), ${poly.events_spread_in} spread in` : ""}</small></td>
        <td class="num">${ethers.formatEther(p.amount)} ETH<small>${tx("fund", "funding tx")}</small></td><td>${report}</td><td>${outcome}</td></tr>`);
    }
    tb.innerHTML = rows.join("") || `<tr><td colspan="5" class="muted">No pledges yet.</td></tr>`;
    tb.querySelectorAll("[data-poly]").forEach((a) => a.addEventListener("click", () => { const P = S.polys[a.dataset.poly]; if (P) { map.fitBounds(P.l.getBounds(), { maxZoom: 11 }); showPoly(a.dataset.poly); } }));
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="5" class="muted">Could not read pledges from Sepolia (${e.message}). Reload to try again.</td></tr>`;
  }
}

(async function main() {
  await initChain();
  await initMap();
  await initEvidence();
  await initPledges();
})().catch((e) => { console.error(e); $("#card").innerHTML = `<p class="hint">The dashboard could not load its data: ${e.message}</p>`; });
