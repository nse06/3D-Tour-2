// node scene/render_model.mjs <port> <glb-url> <data-dir> <out-dir>: renders a .glb from the held-out views.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [port, glb, data, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const tests = JSON.parse(fs.readFileSync(path.join(data, "test.json"), "utf8"));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/scene/model.html`);
await page.waitForFunction(() => window.modelReady, null, { timeout: 60000 });
await page.evaluate((u) => window.model.load(u), glb);
for (const [i, t] of tests.entries()) {
  const url = await page.evaluate(([m, fy]) => window.model.render(m, fy), [t.transform, t.intrinsics[4]]);
  fs.writeFileSync(path.join(out, `${String(i).padStart(2, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
}
console.log("rendered", tests.length, "views of", glb);
await browser.close();
