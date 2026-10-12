// «Облако» на двух устройствах одного аккаунта (spec 016, US3): непривязанное
// устройство диск не создаёт и ждёт привязки; после привязки видит дерево и
// скачивает файл; правки сходятся в обе стороны, в том числе сделанные без
// связи (переименование папки + перемещение в неё, взаимное перемещение папок
// без петли); на сервере нет имён и содержимого открытым текстом.
// Запуск: scripts/run_web_cloud_sync_e2e.sh
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cloud-sync-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
const SYNC_TIMEOUT_MS = 30000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (каталог баз стенда)');

const SECRET = 'Содержимое файла двух устройств 91c4';

function driver(page) {
  const cloud = page.locator('#ParvaneCloud');
  const item = (name) => cloud.locator(`[data-node-id][data-name="${name}"]`);
  const api = {
    cloud,
    item,
    open: async () => {
      if (!(await cloud.isVisible().catch(() => false))) {
        await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Cloud' }).click();
      }
      await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    },
    close: async () => {
      await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
      await cloud.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
    },
    root: async () => {
      await cloud.locator('nav').getByRole('button', { name: 'Cloud', exact: true }).click();
    },
    names: () => cloud.locator('[role="listitem"][data-node-id]')
      .evaluateAll((els) => els.map((el) => el.dataset.name).sort()),
    menu: async (name, action) => {
      await item(name).hover();
      await item(name).getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
    },
    add: async (action) => {
      await cloud.getByRole('button', { name: action, exact: true }).click();
    },
    folder: async (name) => {
      await api.add('New folder');
      await page.locator('#parvane-cloud-name').fill(name);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await item(name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    },
    rename: async (from, to) => {
      await api.menu(from, 'Rename');
      await page.locator('#parvane-cloud-name').fill(to);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await item(to).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    },
    moveInto: async (name, target) => {
      await api.menu(name, 'Move');
      const dialog = page.locator('.Modal').filter({ hasText: 'Move here' });
      await dialog.getByRole('listitem').filter({ hasText: target }).click();
      await dialog.getByRole('button', { name: 'Move here', exact: true }).click();
      await item(name).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
    },
    upload: async (name, text) => {
      await cloud.locator('input[type="file"]').setInputFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from(text) }]);
      await item(name).waitFor({ state: 'visible', timeout: 60000 });
    },
    // Всё дерево диска: «папка/…/имя» по всем узлам (обход по экрану)
    tree: async () => {
      const out = [];
      const walk = async (prefix) => {
        const rows = await cloud.locator('[role="listitem"][data-node-id]')
          .evaluateAll((els) => els.map((el) => ({ name: el.dataset.name, kind: el.dataset.kind })));
        for (const row of rows) {
          out.push(`${prefix}${row.name}`);
          if (row.kind !== 'folder') continue;
          await item(row.name).click();
          await cloud.locator('nav').getByRole('button', { name: row.name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
          await walk(`${prefix}${row.name}/`);
          const crumbs = cloud.locator('nav').getByRole('button');
          await crumbs.nth((await crumbs.count()) - 2).click();
          await item(row.name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
        }
      };
      await api.root();
      await walk('');
      return out.sort();
    },
  };
  return api;
}

function plaintextLeaks(words) {
  const found = [];
  for (const [file, queries] of [
    ['domains.db-v2.db', ['SELECT op AS b FROM container_log', 'SELECT snapshot AS b FROM container_snapshots']],
    ['cloud.db', ['SELECT data AS b FROM chunks']],
  ]) {
    const db = new DatabaseSync(`${BACKEND_DIR}/${file}`, { readOnly: true });
    try {
      for (const sql of queries) {
        for (const row of db.prepare(sql).all()) {
          const bytes = Buffer.from(row.b || '');
          const texts = [bytes.toString('latin1'), bytes.toString('utf8')];
          for (const word of words) {
            if (texts.some((t) => t.includes(word))) found.push(`${file}: ${word}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return found;
}

async function waitTree(d, expected, message, timeout = SYNC_TIMEOUT_MS) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await d.tree();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.deepEqual(last, expected, message);
}

const browser = await chromium.launch();
const sessions = {};

try {
  const user = `csync-${Date.now().toString(36)}@local`;

  // ── Первое устройство: папка и файл ───────────────────────────────────────
  const context1 = await browser.newContext({ viewport: WIDE, acceptDownloads: true });
  sessions.one = await preparePage(context1, user, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.one.page).catch(() => undefined);
  const a = driver(sessions.one.page);
  await a.open();
  await a.folder('Проект');
  await a.upload('план.txt', SECRET);
  console.log('OK: первое устройство завело папку и файл');

  // ── Непривязанное второе устройство: ждёт привязки, диск не создаёт ───────
  const context2 = await browser.newContext({ viewport: WIDE, acceptDownloads: true });
  sessions.two = await preparePage(context2, user, PASSWORD);
  await sessions.two.page.waitForTimeout(3000);
  const b = driver(sessions.two.page);
  await b.open();
  await b.cloud.getByText(/will appear after this device is linked/).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  assert.equal(await b.item('план.txt').count(), 0, 'непривязанное устройство не видит файлов');
  assert.equal(await b.cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'и не предлагает начать пустой диск');
  await b.close();
  const domains = new DatabaseSync(`${BACKEND_DIR}/domains.db-v2.db`, { readOnly: true });
  assert.equal(domains.prepare("SELECT COUNT(*) AS n FROM containers WHERE domain = 'cloud.v1'").get().n, 1, 'диск у аккаунта один');
  domains.close();
  console.log('OK: непривязанное устройство ждёт привязки и диск не создаёт');

  // ── Привязка: дерево за ≤ 10 с, файл скачивается ──────────────────────────
  // Экран устройств открывается из меню мессенджера — раздел на время привязки закрыт
  await a.close();
  await linkSecondDevice(sessions.one.page, sessions.two.page);
  const linkedAt = Date.now();
  await b.open();
  await b.item('план.txt').waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await b.item('Проект').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const took = Date.now() - linkedAt;
  assert.ok(took <= 10000, `дерево после привязки появилось за ${took} мс`);
  const [download] = await Promise.all([
    sessions.two.page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
    b.menu('план.txt', 'Download'),
  ]);
  assert.equal(readFileSync(await download.path()).toString(), SECRET, 'второе устройство скачало тот же файл');
  console.log(`OK: после привязки второе устройство видит дерево (${took} мс) и скачивает файл`);

  // ── Правки онлайн сходятся в обе стороны без перезагрузки ─────────────────
  await a.open();
  await b.folder('Со второго');
  await a.item('Со второго').waitFor({ state: 'visible', timeout: 15000 });
  await a.rename('план.txt', 'план-2.txt');
  await b.item('план-2.txt').waitFor({ state: 'visible', timeout: 15000 });
  await a.menu('Со второго', 'Move to trash');
  await b.item('Со второго').waitFor({ state: 'detached', timeout: 15000 });
  console.log('OK: правки онлайн видны на другом устройстве не позже чем через 15 с');

  // ── Без связи: переименование папки на одном, перемещение в неё на другом ──
  await context2.setOffline(true);
  await b.moveInto('план-2.txt', 'Проект');
  await a.rename('Проект', 'Проект-новый');
  await context2.setOffline(false);
  const merged = ['Проект-новый', 'Проект-новый/план-2.txt'];
  await waitTree(a, merged, 'первое устройство: слияние офлайн-правок');
  await waitTree(b, merged, 'второе устройство: слияние офлайн-правок');
  console.log('OK: переименование и перемещение без связи слились, ничего не потеряно');

  // ── Без связи: две папки перемещены друг в друга — петли нет, деревья равны ──
  await a.root();
  await a.folder('Альфа');
  await a.folder('Бета');
  await b.root();
  await b.item('Бета').waitFor({ state: 'visible', timeout: 15000 });
  await context2.setOffline(true);
  await a.moveInto('Альфа', 'Бета');
  await b.moveInto('Бета', 'Альфа');
  await context2.setOffline(false);
  let treeA;
  let treeB;
  const started = Date.now();
  while (Date.now() - started < SYNC_TIMEOUT_MS) {
    treeA = await a.tree();
    treeB = await b.tree();
    if (JSON.stringify(treeA) === JSON.stringify(treeB)) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.deepEqual(treeA, treeB, 'деревья устройств должны совпасть');
  assert.equal(treeA.length, 4, `ни один узел не потерян: ${JSON.stringify(treeA)}`);
  assert.ok(
    treeA.includes('Альфа/Бета') || treeA.includes('Бета/Альфа'),
    `одна папка внутри другой, петли нет: ${JSON.stringify(treeA)}`,
  );
  console.log(`OK: взаимное перемещение папок сошлось без петли (${JSON.stringify(treeA)})`);

  // ── Сервер не видит ни имён, ни содержимого ───────────────────────────────
  assert.deepEqual(plaintextLeaks([SECRET, 'Проект', 'план-2', 'Альфа']), [], 'в базах сервера найден открытый текст');
  console.log('OK: в базах сервера нет имён и содержимого открытым текстом');

  for (const [name, s] of Object.entries(sessions)) {
    assert.deepEqual(s.errors, [], `${name}: ошибки страницы: ${s.errors.join('; ')}`);
  }
  console.log('OK: «Облако» на двух устройствах — привязка, синхронизация, слияние офлайн-правок');
} catch (err) {
  for (const [name, s] of Object.entries(sessions)) {
    await s.page.screenshot({ path: `${BACKEND_DIR}/cloud-sync-${name}.png` }).catch(() => undefined);
    console.log(`--- ${name}`);
    console.log((s.logs || []).filter((l) => l.includes('облако') || l.includes('v2:')).slice(-30).join('\n'));
  }
  throw err;
} finally {
  await browser.close();
}
