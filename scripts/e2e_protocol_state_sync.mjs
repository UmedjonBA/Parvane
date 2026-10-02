// Протокол v2 (spec 007, T039, US5/SC-009): второе устройство аккаунта и журнал
// личного состояния. bob на двух web-устройствах (оба v2):
// (1) второе устройство не создаёт свой корень: у аккаунта уже есть журнал
//     устройств → оффер LINK-1, первое устройство подтверждает по коду;
// (2) грант несёт материал движка (SSK, журнал, ключ доставки, ключ личного
//     состояния) — второе устройство записывает себя в журнал и поднимает v2;
// (3) сообщение Алисы после линковки приходит на оба устройства bob, своё
//     исходящее первого устройства — на второе;
// (4) папка и блокировка, сделанные на первом устройстве, видны на втором
//     ≤ 10 с (SC-009); в БД сервера названия папки нет (только шифртекст).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-state-password';
const V2_SEED = { 'parvane:proto': 'v2' };
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
// Грант опрашивается новым устройством каждые 5 с + вступление в журнал
const LINK_TIMEOUT_MS = 90000;
// SC-009: правка видна на другом устройстве ≤ 10 с
const STATE_SYNC_BUDGET_MS = 10000;

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const consoleTail = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane] v2') || t.includes('линковк')) logs[who].push(t);
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
  });
});

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].join(' | ')})`);
}

async function openDevicesScreen(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

async function closeSettings(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await page.locator('#telegram-search-input').isVisible()) return;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  throw new Error('не удалось вернуться из настроек к списку чатов');
}

// Папка через нативный экран Settings → Chat Folders (как e2e_web_content_features)
async function createFolder(page, folderName, chatName) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Chat Folders' }).click();
  await page.getByRole('button', { name: 'Create New Folder' }).click();
  const nameInput = page.getByRole('textbox', { name: 'Folder name' });
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(folderName);
  await page.getByRole('button', { name: 'Add Chats' }).first().click();
  const search = page.locator('#new-group-picker-search');
  await search.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await search.fill(chatName);
  const row = page.locator('#LeftColumn').getByRole('button').filter({ hasText: chatName }).first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await page.locator('#LeftColumn input[type="checkbox"]:checked').count()) break;
    // eslint-disable-next-line no-await-in-loop
    await row.click({ force: true });
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Create folder' }).click();
}

function isBlocked(page, userName) {
  return page.evaluate((name) => {
    const g = globalThis.__parvaneGetGlobal?.();
    if (!g) return false;
    const user = Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    return Boolean(user && g.blocked.ids.includes(user.id));
  }, userName);
}

// Имя папки не должно лежать открытым ни в одной БД сервера
function serverFilesContaining(needle) {
  return readdirSync(BACKEND_DIR)
    .filter((file) => /\.db(-wal|-shm)?$/.test(file))
    .filter((file) => {
      try {
        execFileSync('grep', ['-a', '-q', '-F', needle, join(BACKEND_DIR, file)]);
        return true;
      } catch {
        return false;
      }
    });
}

try {
  assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `sta-${suffix}@local`;
  const bob = `stb-${suffix}@local`;
  const aliceName = alice.split('@')[0];

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(['alice', 'bob1'].map((who) => waitLog(who, 'v2: готов')));
  assert.ok(await dismissRecoveryKeyDialog(sessions.alice.page), 'alice: не показан ключ восстановления v2');
  assert.ok(await dismissRecoveryKeyDialog(sessions.bob1.page), 'bob1: не показан ключ восстановления v2');
  await waitLog('bob1', 'v2: журнал состояния подключён');
  const alicePage = sessions.alice.page;
  const bob1Page = sessions.bob1.page;

  // Переписка до второго устройства (по v2)
  const before = `st-before-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, before);
  await openPrivateChatStrict(bob1Page, alice);
  await findMessage(bob1Page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Второе устройство: своего корня не создаёт, просит линковку ────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'нужна линковка этого устройства');
  assert.equal(await dismissRecoveryKeyDialog(bob2Page, 3000), undefined,
    'bob2: второе устройство показало ключ восстановления — создан второй корень');

  const dev2Screen = await openDevicesScreen(bob2Page);
  await dev2Screen.getByText(/Waiting for your other device/)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const dev1Screen = await openDevicesScreen(bob1Page);
  const pendingText = dev2Screen.getByText(/confirm code \d{4} \d{4} \d{4}/);
  await pendingText.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const dev2Code = (await pendingText.textContent()).match(/(\d{4} \d{4} \d{4})/)[1];
  const offerItem = dev1Screen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const dev1Code = (await offerItem.textContent()).match(/Code: (\d{4} \d{4} \d{4})/)[1];
  assert.equal(dev1Code, dev2Code, 'коды сверки на устройствах не совпали');
  await offerItem.locator('.ListItem-button').click();
  const transferButton = bob1Page.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await bob1Page.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Грант → запись в журнале устройств → v2 и журнал состояния на bob2 ─────
  await waitLog('bob2', 'v2: устройство привязано грантом линковки', LINK_TIMEOUT_MS);
  await waitLog('bob2', 'v2: готов');
  await waitLog('bob2', 'v2: журнал состояния подключён');
  assert.equal(await dismissRecoveryKeyDialog(bob2Page, 3000), undefined,
    'bob2: после линковки показан ключ восстановления');
  await closeSettings(bob2Page);
  await closeSettings(bob1Page);

  // ── Сообщения после линковки: оба устройства bob ────────────────────────────
  const after = `st-after-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, after);
  await openPrivateChatStrict(bob1Page, alice);
  await findMessage(bob1Page, after).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob2Page, alice);
  await findMessage(bob2Page, after).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const own = `st-own-${suffix}`;
  await sendText(bob1Page, own);
  await findMessage(alicePage, own).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bob2Page, own).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Журнал личного состояния: папка и блок-лист ≤ 10 с (SC-009) ────────────
  const folderName = `F-${suffix.slice(-6)}`;
  await createFolder(bob1Page, folderName, aliceName);
  const folderStarted = Date.now();
  await bob2Page.locator('#LeftColumn').getByText(folderName, { exact: true }).first()
    .waitFor({ state: 'visible', timeout: STATE_SYNC_BUDGET_MS });
  console.log(`папка на втором устройстве через ${Date.now() - folderStarted} мс`);
  await closeSettings(bob1Page);

  await openPrivateChatStrict(bob1Page, alice);
  assert.equal(await isBlocked(bob2Page, aliceName), false, 'bob2: alice заблокирована до блокировки');
  await bob1Page.getByRole('button', { name: 'More actions' }).click();
  await bob1Page.getByRole('menuitem', { name: 'Block user' }).click();
  const blockStarted = Date.now();
  await bob2Page.waitForFunction((name) => {
    const g = globalThis.__parvaneGetGlobal?.();
    const user = g && Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    return Boolean(user && g.blocked.ids.includes(user.id));
  }, aliceName, { timeout: STATE_SYNC_BUDGET_MS });
  console.log(`блокировка на втором устройстве через ${Date.now() - blockStarted} мс`);

  // Сервер хранит только шифртекст журнала состояния
  assert.deepEqual(serverFilesContaining(folderName), [], 'название папки лежит в БД сервера открытым');

  for (const who of names) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_state_sync: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-state-sync-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`журнал ${who}: ${logs[who].join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
