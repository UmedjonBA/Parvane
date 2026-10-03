// Протокол v2 (spec 007, T139): личное состояние web → desktop на одном
// аккаунте. bob1 — web, первое v2-устройство (корень, журнал устройств, ключ
// личного состояния); bob2 — desktop на v2: журнал у аккаунта есть → корня не
// создаёт, публикует оффер; bob1 подтверждает в Settings → Devices, грант с
// материалом движка уходит вторым блобом (LINK-1 v2). Затем: история v2-эпохи
// на desktop (LINK-1 п. 8), папка, мьют и блокировка, сделанные в web, доходят
// до desktop через зашифрованный журнал личного состояния ≤ 10 с (SC-009,
// STATE-1/STATE-2). Пара `state-sync-desktop` в run_protocol_mixed_e2e.sh.
// Требует бинарь desktop/build-probe/bin/Telegram (-DPARVANE_DEV=ON); без него — SKIP.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildLibraryShim,
  escapeRegExp,
  readDesktopLog,
  requireGatewayTcpUrl,
  skipWithoutDesktop,
  spawnDesktop,
  stopDesktop,
  waitDesktopLog,
} from './e2e_desktop_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS,
  callProviderForChat,
  dismissRecoveryKeyDialog,
  findMessage,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-state-desktop-password';
const V2_SEED = { 'parvane:proto': 'v2' };
// SC-009: ≤ 10 с; опрос журнала состояния — 8 с, плюс запас на запись
const STATE_SYNC_BUDGET_MS = 12000;
const LINK_TIMEOUT_MS = 120000;

requireGatewayTcpUrl();
skipWithoutDesktop('protocol state-sync web → desktop');

const browser = await chromium.launch();
const names = ['alice', 'bob1'];
const contexts = Object.fromEntries(names.map((n) => [n, undefined]));
const logs = Object.fromEntries(names.map((n) => [n, []]));
for (const who of names) {
  // eslint-disable-next-line no-await-in-loop
  contexts[who] = await browser.newContext();
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane] v2') || t.includes('линковк')) logs[who].push(t);
    });
  });
}
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-v2state-desktop-'));
const libraryShim = buildLibraryShim(bobWorkdir);
let desktop;

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].join(' | ')})`);
}

async function openSettingsScreen(page, item) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: item }).click();
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

// Папка через нативный экран Settings → Chat Folders
async function createFolder(page, folderName, chatName) {
  await openSettingsScreen(page, 'Chat Folders');
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

// Строка лога desktop появилась не позже budget после старта отсчёта
async function waitDesktopWithin(re, budget, label) {
  const started = Date.now();
  await waitDesktopLog(bobWorkdir, re, budget, desktop);
  const took = Date.now() - started;
  console.log(`${label} на desktop через ${took} мс`);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `ssda-${suffix}@local`;
  const bob = `ssdb-${suffix}@local`;
  const aliceName = alice.split('@')[0];

  const aliceSession = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(names.map((who) => waitLog(who, 'v2: готов')));
  await dismissRecoveryKeyDialog(aliceSession.page);
  await dismissRecoveryKeyDialog(bob1.page);
  await waitLog('bob1', 'v2: журнал состояния подключён');

  // Переписка до второго устройства (по v2) — история v2-эпохи
  const before = `ssd-before-${suffix}`;
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, before);
  await openPrivateChatStrict(bob1.page, alice);
  await findMessage(bob1.page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── desktop bob2: корня не создаёт, просит линковку ─────────────────────────
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_PROTO_V2: '1',
  });
  await waitDesktopLog(bobWorkdir, /нужна линковка/, 90000, desktop);
  assert.ok(!/v2: устройство создано/.test(readDesktopLog(bobWorkdir)), 'desktop создал собственный корень');
  await waitDesktopLog(bobWorkdir, /линковка: оффер \(обязательство\) опубликован/, 60000, desktop);

  // bob1 подтверждает оффер в Settings → Devices
  await openSettingsScreen(bob1.page, 'Devices');
  const screen = bob1.page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const offerItem = screen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await offerItem.locator('.ListItem-button').click();
  const transferButton = bob1.page.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await bob1.page.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(bob1.page);

  await waitDesktopLog(bobWorkdir, /линковка: грант v2 получен/, LINK_TIMEOUT_MS, desktop);
  await waitDesktopLog(bobWorkdir, /v2: устройство привязано грантом линковки/, 60000, desktop);
  await waitDesktopLog(bobWorkdir, /журнал личного состояния подключён/, 90000, desktop);

  // История v2-эпохи (LINK-1 п. 8): «до» запечатано только под bob1
  await waitDesktopLog(bobWorkdir, /линковка: история v2 перенесена \([1-9]\d* сообщений\)/, 60000, desktop);
  await waitDesktopLog(
    bobWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${escapeRegExp(alice)}\\): ${escapeRegExp(before)}`), 30000, desktop,
  );

  // ── Журнал личного состояния web → desktop (SC-009) ────────────────────────
  const folderName = `F-${suffix.slice(-6)}`;
  await createFolder(bob1.page, folderName, aliceName);
  await waitDesktopWithin(/журнал состояния → папки \([1-9]\d* изменений\)/, STATE_SYNC_BUDGET_MS, 'папка');
  await closeSettings(bob1.page);
  await openPrivateChatStrict(bob1.page, alice);

  const muted = await callProviderForChat(bob1.page, 'updateChatNotifySettings', aliceName, undefined, {
    chat: '$chat', settings: { mutedUntil: 2147483647 },
  });
  assert.ok(!muted.error, `bob1: мьют не выполнен: ${muted.error}`);
  await waitDesktopWithin(/журнал состояния → уведомления \([1-9]\d* изменений\)/, STATE_SYNC_BUDGET_MS, 'мьют');

  await bob1.page.getByRole('button', { name: 'More actions' }).click();
  await bob1.page.getByRole('menuitem', { name: 'Block user' }).click();
  await waitDesktopWithin(/журнал состояния → блок-лист \([1-9]\d* изменений\)/, STATE_SYNC_BUDGET_MS, 'блокировка');

  const desktopLog = readDesktopLog(bobWorkdir);
  assert.ok(!/запись не открыта|ошибка записи|E2E не удался/.test(desktopLog), 'desktop: сбои записей v2/E2E');
  console.log('e2e_protocol_state_sync_desktop: OK');
} catch (error) {
  for (const who of names) console.error(`журнал ${who}: ${logs[who].join('\n')}`);
  console.error(`хвост лога desktop:\n${readDesktopLog(bobWorkdir).slice(-4000)}`);
  throw error;
} finally {
  await stopDesktop(desktop);
  await browser.close();
}
