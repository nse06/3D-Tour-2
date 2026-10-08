// node tools/capture.mjs <port> <out-dir> [methods]: screenshots every viewpoint of site/local.html for each method.
import { chromium } from "playwright-core";
import fs from "node:fs";
const [port, out, list = "today,lidar,splat"] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 532, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("console:", m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/site/local.html`);
await page.waitForFunction(() => window.__viewer && window.__viewer.ready(), null, { timeout: 600000 });
await page.addStyleTag({ content: ".badge,.status{display:none!important}" });
const stage = await page.$("#stage");
const box = await stage.boundingBox();
console.log("stage", box.width, "x", box.height, "backend:", await page.evaluate(() => (window.__viewer.renderer.backend.isWebGLBackend ? "WebGL2" : "WebGPU")));
const count = await page.evaluate(() => document.querySelectorAll("#views button").length);
for (const method of list.split(",")) {
  for (let i = 0; i < count; i++) {
    await page.evaluate(([m, i]) => { window.__viewer.goTo(i); window.__viewer.show(m); }, [method, i]);
    await page.waitForTimeout(method === "splat" ? 900 : 300);
    await stage.screenshot({ path: `${out}/${method}-${String(i).padStart(2, "0")}.png` });
  }
  console.log("captured", method);
}
if (errors.length) console.log("page errors:", errors.join(" | "));
await browser.close();
