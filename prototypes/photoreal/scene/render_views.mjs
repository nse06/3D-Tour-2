// node scene/render_views.mjs <port> <views.json> <out-dir>: renders the real apartment from each
// view in views.json (tools/eval_views.py: [{ kind, name, m }]) as <out-dir>/NNN.png, and writes
// <out-dir>/views.json with each view's file and intrinsics (the capture's photos' camera).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { FY, W, H } from "./poses.mjs";
const [port, list, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const views = JSON.parse(fs.readFileSync(list, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/scene/index.html`);
await page.waitForFunction(() => window.gt && window.gt.ready, null, { timeout: 120000 });
const written = [];
for (const [i, v] of views.entries()) {
  const url = await page.evaluate(([m, fy]) => window.gt.render(m, fy), [v.m, FY]);
  const file = `${String(i).padStart(3, "0")}.png`;
  fs.writeFileSync(path.join(out, file), Buffer.from(url.split(",")[1], "base64"));
  written.push({ ...v, file, fx: FY, fy: FY, cx: W / 2, cy: H / 2, width: W, height: H });
}
fs.writeFileSync(path.join(out, "views.json"), JSON.stringify(written, null, 1));
console.log(`rendered ${written.length} views into ${out}`);
await browser.close();
