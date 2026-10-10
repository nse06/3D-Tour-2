// node scene/render_model_views.mjs <port> <glb-url> <views.json> <out-dir>: a painted .glb from each evaluation view
// (tools/eval_views.py), named like the ground truth, for scoring it the way tools/eval_splats.py scores splats.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [port, glb, list, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const views = JSON.parse(fs.readFileSync(list, "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/scene/model.html`);
await page.waitForFunction(() => window.modelReady, null, { timeout: 60000 });
await page.evaluate((u) => window.model.load(u), glb);
for (const v of views) {
  const url = await page.evaluate(([m, fy]) => window.model.render(m, fy), [v.m, v.fy]);
  fs.writeFileSync(path.join(out, v.file), Buffer.from(url.split(",")[1], "base64"));
}
console.log("rendered", views.length, "views");
await browser.close();
