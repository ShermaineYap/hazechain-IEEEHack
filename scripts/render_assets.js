// Render docs/img/architecture.png, docs/img/dashboard.png and submission/HazeChain_onepager.pdf
const { chromium } = require("playwright");
const path = require("path");
const root = path.join(__dirname, "..");
(async () => {
  const b = await chromium.launch();
  let p = await b.newPage({ viewport: { width: 1200, height: 520 }, deviceScaleFactor: 2 });
  await p.goto("file://" + path.join(root, "docs/architecture.svg"));
  await p.screenshot({ path: path.join(root, "docs/img/architecture.png") });
  p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
  await p.goto(process.env.SITE || "http://localhost:8765/", { waitUntil: "networkidle", timeout: 90000 });
  await p.waitForTimeout(3000);
  await p.screenshot({ path: path.join(root, "docs/img/dashboard.png") });
  p = await b.newPage();
  await p.goto("file://" + path.join(root, "submission/onepager.html"), { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  await p.pdf({ path: path.join(root, "submission/HazeChain_onepager.pdf"), format: "A4", printBackground: true, pageRanges: "1" });
  await p.setViewportSize({ width: 794, height: 1123 });
  await p.screenshot({ path: path.join(root, "submission/onepager_preview.png"), fullPage: false });
  await b.close();
})();
