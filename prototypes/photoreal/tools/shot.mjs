// node tools/shot.mjs <port> <out.png> <width> [dark]: full-page screenshot of site/local.html.
import { chromium } from "playwright-core";
const [port, out, width, dark] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, colorScheme: dark ? "dark" : "light" });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(`http://127.0.0.1:${port}/site/local.html`);
await page.waitForFunction(() => window.__viewer && window.__viewer.models.lidar, null, { timeout: 300000 });
await page.waitForTimeout(1500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("horizontal overflow px:", overflow);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
