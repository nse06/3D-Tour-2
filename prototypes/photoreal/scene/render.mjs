// node scene/render.mjs <port> <out-dir>: renders the synthetic capture and the held-out views.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { capturePoses, testPoses, FY, W, H } from "./poses.mjs";
const [port, out] = process.argv.slice(2);
fs.mkdirSync(path.join(out, "frames"), { recursive: true });
fs.mkdirSync(path.join(out, "test"), { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/scene/index.html`);
await page.waitForFunction(() => window.gt && window.gt.ready, null, { timeout: 120000 });
const intrinsics = [FY, 0, 0, 0, FY, 0, W / 2, H / 2, 1];
const start = Date.now();
const frames = [];
const poses = capturePoses();
for (const [i, p] of poses.entries()) {
  const url = await page.evaluate(([m, fy]) => window.gt.render(m, fy), [p.m, FY]);
  const file = `frames/${String(i).padStart(6, "0")}.png`;
  fs.writeFileSync(path.join(out, file), Buffer.from(url.split(",")[1], "base64"));
  frames.push({ file, t: i * 0.8, transform: p.m, intrinsics, width: W, height: H, imageWidth: W, imageHeight: H, angularSpeed: 0.05, exposureDuration: 1 / 60, room: p.room, spot: p.spot });
  if (i % 100 === 0) console.log(`frame ${i}/${poses.length} ${((Date.now() - start) / 1000).toFixed(0)} s`);
}
fs.writeFileSync(path.join(out, "frames.json"), JSON.stringify(frames));
const tests = [];
for (const [i, p] of testPoses().entries()) {
  const url = await page.evaluate(([m, fy]) => window.gt.render(m, fy), [p.m, FY]);
  const file = `test/${String(i).padStart(2, "0")}.png`;
  fs.writeFileSync(path.join(out, file), Buffer.from(url.split(",")[1], "base64"));
  tests.push({ name: p.name, file, transform: p.m, intrinsics, width: W, height: H });
}
fs.writeFileSync(path.join(out, "test.json"), JSON.stringify(tests, null, 1));
const tri = await page.evaluate(() => window.gt.triangles());
fs.writeFileSync(path.join(out, "gt-positions.bin"), Buffer.from(tri.positions, "base64"));
fs.writeFileSync(path.join(out, "gt-kinds.bin"), Buffer.from(tri.kinds, "base64"));
fs.writeFileSync(path.join(out, "gt-rooms.bin"), Buffer.from(tri.rooms, "base64"));
console.log(`done: ${frames.length} frames, ${tests.length} test views, ${tri.count} triangles in ${((Date.now() - start) / 1000).toFixed(0)} s`);
await browser.close();
