// Headless UX check for the NOTES/JOURNAL workspace.
// Serves client/ on a free port, loads uxcheck/harness.html in real Chromium
// (so layout actually happens), and asserts UX invariants that unit tests can't
// see — e.g. the editor isn't collapsed to a tiny box, journal entries don't
// overwrite each other, drag-to-folder works.
//
//   node uxcheck/run.mjs
//
// One-time setup (needs network):  npx playwright install chromium

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("✗ playwright is not installed.");
  console.error("  Run once (needs network):  cd client && npx playwright install chromium && npm i -D playwright");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".jsx":  "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(CLIENT_ROOT, safe);
      if (!filePath.startsWith(CLIENT_ROOT)) { res.writeHead(403); res.end(); return; }
      const buf = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(404); res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ── tiny assertion harness ─────────────────────────────────────────────────
const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message || String(e) });
    console.log(`  ✗ ${name}\n      ${e.message || e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── run ─────────────────────────────────────────────────────────────────────
const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

const modeBtn = (label) => page.locator(".ws-mode", { hasText: label });

try {
  console.log(`\nUX harness @ ${base}/uxcheck/harness.html\n`);
  await page.goto(`${base}/uxcheck/harness.html`);
  await page.waitForFunction(() => window.__ux && window.__ux.ready, null, { timeout: 20000 });
  await page.waitForSelector(".ws-modebar", { timeout: 20000 });

  // 1 ── editor is not collapsed to a "tiny white box"
  await scenario("notes editor renders at a usable height (>120px)", async () => {
    await modeBtn("NOTES").click();
    await page.locator("button.primary", { hasText: "new note" }).click();
    const ta = page.locator("textarea.note-editor");
    await ta.waitFor({ state: "visible", timeout: 10000 });
    const h = await ta.evaluate((el) => el.offsetHeight);
    assert(h > 120, `editor offsetHeight was ${h}px (expected > 120)`);
  });

  // 2 ── "[+] folder" button actually creates a folder
  await scenario("[+] folder button creates a new folder", async () => {
    await page.locator("button", { hasText: "[+] folder" }).click();
    await page.locator('.inline-create input').fill("research");
    await page.locator('.inline-create button.btn', { hasText: "add" }).click();
    // default folders only hit localStorage after the first createFolder, so
    // assert the new folder by name rather than by a count delta.
    await page.waitForFunction(() =>
      window.__ux.folders().some((f) => f.name === "research"), null, { timeout: 5000 });
    const hasRow = await page.locator(".vault-row", { hasText: "research" }).count();
    assert(hasRow > 0, "new folder row 'research' did not appear in the tree");
  });

  // 3 ── journal: two entries on the SAME date create two distinct notes
  await scenario("journal does not overwrite same-date entries", async () => {
    await modeBtn("JOURNAL").click();
    const DATE = "2026-06-20";
    const before = await page.evaluate(() => window.__ux.liveCount());
    for (const txt of ["first entry of the day", "second entry of the day"]) {
      await page.locator("button.primary", { hasText: "new entry" }).click();
      await page.locator('input[type="date"]').fill(DATE);
      await page.locator("textarea.journal-editor").fill(txt);
      await page.locator("button.primary", { hasText: "save" }).click();
      await page.waitForTimeout(150);
    }
    await page.waitForFunction((n) => window.__ux.liveCount() >= n + 2, before, { timeout: 5000 });
    const sameDate = await page.evaluate((d) =>
      window.__ux.liveNotes().filter((n) => n.title.startsWith(d)).length, DATE);
    assert(sameDate === 2, `expected 2 entries dated ${DATE}, found ${sameDate}`);
    const cards = await page.locator(".entry-card").count();
    assert(cards >= 2, `expected >= 2 entry cards, found ${cards}`);
  });

  // 4 ── drag a note from inbox into another folder
  await scenario("drag-and-drop moves a note into a folder", async () => {
    await modeBtn("NOTES").click();
    // create a uniquely-named note inside inbox via the folder's ＋
    const inboxRow = page.locator(".vault-row", { hasText: "inbox" }).first();
    await inboxRow.locator(".row-add").click();
    await page.locator('.inline-create input').fill("dragme");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      window.__ux.liveNotes().some((n) => n.title === "dragme"), null, { timeout: 5000 });

    const res = await page.evaluate(() => window.__ux.dragNoteToFolder("dragme", "research"));
    assert(res.ok, `could not locate rows (note:${res.note}, folder:${res.folder})`);

    const moved = await page.evaluate(() => {
      const note = window.__ux.liveNotes().find((n) => n.title === "dragme");
      const folder = window.__ux.folders().find((f) => f.name === "research");
      return note && folder && window.__ux.noteFolders()[note.note_id] === folder.id;
    });
    assert(moved, "note was not reassigned to the 'research' folder after drop");
  });

  // 5 ── inline rename + add tag both mutate state
  await scenario("rename note and add #tag work", async () => {
    await page.locator(".vault-row", { hasText: "dragme" }).first().click();
    await page.waitForSelector(".note-toolbar", { timeout: 5000 });
    // rename via double-click on the title
    await page.locator(".note-title-block .strong").dblclick();
    const renameInput = page.locator("input.inline-rename");
    await renameInput.fill("renamed-note");
    await renameInput.press("Enter");
    await page.waitForFunction(() =>
      window.__ux.liveNotes().some((n) => n.title === "renamed-note"), null, { timeout: 5000 });

    // add a tag
    await page.locator("button.tag-add-btn", { hasText: "tag" }).click();
    const tagInput = page.locator(".tag-add-input input");
    await tagInput.fill("demo");
    await tagInput.press("Enter");
    await page.locator(".tag-pill", { hasText: "#demo" }).first().waitFor({ timeout: 5000 });
  });

} catch (e) {
  console.error("\nFATAL:", e);
  results.push({ name: "harness bootstrap", ok: false, err: String(e) });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
if (failed.length) {
  console.log("\nFAILURES:");
  failed.forEach((f) => console.log(`  ✗ ${f.name}: ${f.err}`));
  process.exit(1);
}
console.log("All UX scenarios passed. ✓\n");
process.exit(0);
