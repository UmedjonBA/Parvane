import { chromium } from "playwright";

const tabs = [
  ["calendar", "1"], ["diary", "2"], ["home", "3"], ["system", "4"],
  ["messenger", "5"], ["notes", "6"], ["cloud", "7"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push("PAGEERROR: " + e.message));
page.on("console", m => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

await page.goto("http://127.0.0.1:8099/index.html", { waitUntil: "networkidle" });
// wait for React to mount
await page.waitForSelector(".app", { timeout: 15000 });
await page.waitForTimeout(1500);

import { mkdirSync } from "fs";
mkdirSync("/tmp/shots", { recursive: true });

for (const [name, key] of tabs) {
  await page.keyboard.press(key);
  await page.waitForTimeout(700);
  const screenName = await page.evaluate(() => document.querySelector(".tab.active span:last-child")?.textContent || "?");
  await page.screenshot({ path: `/tmp/shots/${key}-${name}.png` });
  console.log(`  [${key}] ${name} -> active tab: ${screenName}`);
}

console.log("\n=== JS errors ===");
if (errors.length === 0) console.log("  none ✓");
else errors.slice(0, 20).forEach(e => console.log("  " + e));

await browser.close();
process.exit(errors.length ? 1 : 0);
