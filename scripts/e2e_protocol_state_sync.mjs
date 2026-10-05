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
  callProviderForChat,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openGroupChatByTitle,
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

// Текст подтверждения выхода (диалог закрывается без выхода)
async function readLogoutWarning(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  // «More actions» есть и в шапке чата — ждём сам экран настроек
  await page.getByRole('button', { name: 'Edit profile' }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#LeftColumn').getByRole('button', { name: 'More actions' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#LeftColumn').getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Log Out' }).click();
  const dialog = page.locator('.Modal .modal-dialog').filter({ has: page.getByRole('button', { name: 'Log Out' }) }).first();
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(1500); // признак «единственное устройство» приходит ответом провайдера
  const text = (await dialog.textContent()) || '';
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  await closeSettings(page);
  return text;
}

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

async function sendInActiveChat(page, text) {
  const composer = page.locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(text);
  await composer.press('Enter');
}

async function openDevicesScreen(page) {
  // Непривязанное устройство web само открывает экран «Устройства» — тогда он уже на месте
  if (await page.locator('.SettingsActiveSessions').waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true, () => false)) {
    return page.locator('.SettingsActiveSessions');
  }
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

// Сколько записей сервер принял в журналы инбокса v2 за всё время (счётчики
// seq монотонны, подтверждение их не уменьшает)
function sealedInboxCount() {
  return Number(execFileSync('sqlite3', [
    join(BACKEND_DIR, 'messenger.db-v2.db'), 'SELECT COALESCE(SUM(next_seq), 0) FROM inbox_device',
  ]).toString().trim());
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
  // Свой ответ по v2 — тоже история v2-эпохи (LINK-1 п. 8)
  const beforeOwn = `st-before-own-${suffix}`;
  await sendText(bob1Page, beforeOwn);
  await findMessage(alicePage, beforeOwn).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Группа v2 до второго устройства (T142): её и её историю bob2 должен получить
  const groupTitle = `SG-${suffix.slice(-6)}`;
  const groupBefore = `st-group-before-${suffix}`;
  await createGroupViaUi(alicePage, groupTitle, [bob.split('@')[0]]);
  await waitLog('alice', 'v2: группа создана');
  await openGroupChatByTitle(alicePage, groupTitle);
  await sendInActiveChat(alicePage, groupBefore);
  await openGroupChatByTitle(bob1Page, groupTitle);
  await findMessage(bob1Page, groupBefore).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob1Page, alice);

  // ── Второе устройство: своего корня не создаёт, просит линковку ────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'нужна линковка этого устройства');
  assert.equal(await dismissRecoveryKeyDialog(bob2Page, 3000), undefined,
    'bob2: второе устройство показало ключ восстановления — создан второй корень');

  // Непривязанное устройство само ведёт на экран «Устройства» и объясняет, что делать
  await bob2Page.locator('.SettingsActiveSessions').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
    .catch(() => assert.fail('bob2: непривязанное устройство не открыло экран «Устройства»'));
  await bob2Page.locator('.Notification-container').getByText(/not linked to your account yet/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
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
  // ── T138 (SC-002, LINK-1 п. 8): история v2-эпохи на новом устройстве ────────
  // Сообщения до линковки запечатаны под одно устройство bob1 — сервер их bob2
  // не отдаст; они приезжают в экспорте линковки.
  await waitLog('bob2', 'линковка: история v2 перенесена');
  await findMessage(bob2Page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bob2Page, beforeOwn).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await findMessage(bob2Page, before).count(), 1, 'bob2: сообщение истории v2 задвоилось');
  // ── T142: группы v2 на привязанном устройстве — bob1 пересылает bob2 ключи
  // эпохи и сессии Megolm; группа появляется, история до линковки на месте,
  // новое сообщение участника читается, bob2 пишет сам
  await waitLog('bob1', 'v2: группы пересланы новому своему устройству');
  await openGroupChatByTitle(bob2Page, groupTitle);
  await findMessage(bob2Page, groupBefore).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const groupAfter = `st-group-after-${suffix}`;
  await openGroupChatByTitle(alicePage, groupTitle);
  await sendInActiveChat(alicePage, groupAfter);
  await findMessage(bob2Page, groupAfter).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const groupFromBob2 = `st-group-bob2-${suffix}`;
  await sendInActiveChat(bob2Page, groupFromBob2);
  await findMessage(alicePage, groupFromBob2).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob2Page, alice);
  await openPrivateChatStrict(alicePage, bob);
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

  // ── Настройки уведомлений — тоже в журнале (T132, FR-039): мьют ≤ 10 с, а в
  // открытом v1-блобе настроек списка заглушённых больше нет
  const MUTE_FOREVER = 2147483647;
  const muted = await callProviderForChat(bob1Page, 'updateChatNotifySettings', aliceName, undefined, {
    chat: '$chat', settings: { mutedUntil: MUTE_FOREVER },
  });
  assert.ok(!muted.error, `bob1: мьют не выполнен: ${muted.error}`);
  const muteStarted = Date.now();
  await bob2Page.waitForFunction(({ name, until }) => {
    const g = globalThis.__parvaneGetGlobal?.();
    const user = g && Object.values(g.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    return Boolean(user && g.chats.notifyExceptionById?.[user.id]?.mutedUntil === until);
  }, { name: aliceName, until: MUTE_FOREVER }, { timeout: STATE_SYNC_BUDGET_MS });
  console.log(`мьют на втором устройстве через ${Date.now() - muteStarted} мс`);
  const notifyBlobs = execFileSync('sqlite3', [join(BACKEND_DIR, 'messenger.db'), 'SELECT notify_json FROM user_settings'])
    .toString();
  assert.ok(!notifyBlobs.includes(alice) && !notifyBlobs.includes('exceptions'),
    `v1-блоб настроек на сервере несёт список заглушённых: ${notifyBlobs.slice(0, 200)}`);

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

  // ── T133 (FR-033): блокировка отзывает у собеседника ключ доступа к доставке —
  // новый ключ уходит на сервер и своему второму устройству
  await waitLog('bob1', 'доступ собеседника отозван');

  // ── FR-040: приватность хранит сервер — второе устройство читает её оттуда ──
  await bob1Page.evaluate(() => window.__parvaneDiagCallApi('parvaneSetStrangersPolicy', { isAllowed: false }));
  const privacyStarted = Date.now();
  await bob2Page.waitForFunction(async () => {
    const policy = await window.__parvaneDiagCallApi('parvaneGetStrangersPolicy');
    return policy?.isAvailable && policy.isAllowed === false;
  }, undefined, { timeout: STATE_SYNC_BUDGET_MS, polling: 1000 });
  console.log(`приватность на втором устройстве через ${Date.now() - privacyStarted} мс`);

  // Заблокированная пишет по прежнему ключу — сервер его не принимает; как
  // незнакомая тоже не может (запрещено настройкой): сообщение не уходит
  const sealedBefore = sealedInboxCount();
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, `st-blocked-${suffix}`);
  await waitLog('alice', 'ключ доступа собеседника отвергнут');
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  assert.equal(sealedInboxCount(), sealedBefore, 'сообщение заблокированной принято сервером в инбокс получателя');
  // FR-033 у отправителя: отказ виден — сообщение помечено «не отправлено»,
  // а не висит отправленным
  await findMessageContainer(alicePage, `st-blocked-${suffix}`).locator('.MessageOutgoingStatus--failed')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── T145: «удалить чат у себя» на bob1 → чат очищен и на bob2 ≤ 10 с ────────
  // Граница очистки едет журналом личного состояния. Нотис `cleared` v1-шарда
  // обычно успевает раньше (сервер записывает скрытие и для неизвестных ему id
  // сообщений v2), поэтому путь журнала сверяется по самой границе на bob2,
  // а не по записи «скрыто N сообщений». У alice переписка остаётся
  const chatMessageCount = (page, peerNick) => page.evaluate((nick) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
    return user ? Object.keys(g.messages.byChatId[user.id]?.byId || {}).length : -1;
  }, peerNick);
  const aliceNick = alice.split('@')[0];
  assert.ok(await chatMessageCount(bob2Page, aliceNick) > 0, 'bob2: перед очисткой в чате с alice нет сообщений');
  const aliceBefore = await chatMessageCount(alicePage, bob.split('@')[0]);
  await bob1Page.evaluate(async (nick) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
    await window.__parvaneDiagCallApi('deleteHistory', { chat: g.chats.byId[user.id], shouldDeleteForAll: false });
  }, aliceNick);
  const clearStarted = Date.now();
  await bob2Page.waitForFunction((nick) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
    return user && !Object.keys(g.messages.byChatId[user.id]?.byId || {}).length;
  }, aliceNick, { timeout: STATE_SYNC_BUDGET_MS, polling: 500 });
  console.log(`очистка чата на втором устройстве через ${Date.now() - clearStarted} мс`);
  await bob2Page.waitForFunction(({ self, peer }) => {
    const map = JSON.parse(localStorage.getItem(`parvane:cleareduntil:${self}`) || '{}');
    return map[peer] > 0;
  }, { self: bob, peer: alice }, { timeout: STATE_SYNC_BUDGET_MS * 2, polling: 500 });
  console.log(`граница очистки на втором устройстве через ${Date.now() - clearStarted} мс`);
  assert.equal(await chatMessageCount(alicePage, bob.split('@')[0]), aliceBefore, 'у alice пропали сообщения после очистки у bob');

  // ── T160: ссылка-приглашение группы одна на всех своих устройствах ─────────
  // Секрет ссылки знает только создавшее её устройство — запись едет журналом
  // личного состояния; основная ссылка на bob2 сходится к ссылке bob1
  const ownGroup = `BG-${suffix.slice(-6)}`;
  await createGroupViaUi(bob1Page, ownGroup, [alice.split('@')[0]]);
  await waitLog('bob1', 'v2: группа создана');
  const primaryOf = async (page) => {
    const got = await callProviderForChat(page, 'exportChatInvite', ownGroup, undefined, { peer: '$chat' }).catch(() => undefined);
    return got?.result?.link;
  };
  const bob1Link = await primaryOf(bob1Page);
  assert.ok(bob1Link, 'bob1: основная ссылка группы не создана');
  await bob2Page.locator('#LeftColumn .ListItem').filter({ hasText: ownGroup }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const inviteStarted = Date.now();
  // bob2 мог успеть создать свою ссылку до прихода ссылки bob1 (журнал состояния
  // опрашивается раз в 8 с) — тогда оба устройства сходятся к той, что раньше по
  // общему порядку (дата, затем link_id), и это может быть ссылка bob2
  let bob2Link;
  let bob1Now = bob1Link;
  while (Date.now() - inviteStarted < STATE_SYNC_BUDGET_MS * 3) {
    // eslint-disable-next-line no-await-in-loop
    bob2Link = await primaryOf(bob2Page);
    // eslint-disable-next-line no-await-in-loop
    bob1Now = await primaryOf(bob1Page);
    if (bob2Link && bob2Link === bob1Now) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  assert.equal(bob2Link, bob1Now, 'основные ссылки группы на устройствах bob не сошлись');
  console.log(`ссылка-приглашение на втором устройстве через ${Date.now() - inviteStarted} мс`);

  // Сервер хранит только шифртекст журнала состояния
  assert.deepEqual(serverFilesContaining(folderName), [], 'название папки лежит в БД сервера открытым');

  for (const who of names) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  // ── Выход: единственное устройство предупреждают про ключ восстановления ──
  // (у alice устройство одно, у bob — два: ему обычный вопрос)
  assert.match(await readLogoutWarning(alicePage), /only device.*recovery key/s,
    'alice: выход с единственного устройства без предупреждения о ключе восстановления');
  assert.doesNotMatch(await readLogoutWarning(bob1Page), /only device/,
    'bob1: предупреждение о единственном устройстве при двух устройствах');

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
    // eslint-disable-next-line no-await-in-loop
    const state = await session.page.evaluate(() => {
      const g = window.__parvaneGetGlobal();
      const texts = Object.entries(g.messages.byChatId).map(([chatId, chat]) => (
        `${chatId}: ${Object.values(chat.byId || {}).map((m) => `${m.id}${m.isOutgoing ? '>' : '<'}${(m.content?.text?.text || '').slice(0, 24)}`).join(', ')}`
      ));
      const local = Object.keys(localStorage).filter((k) => /cleareduntil|deletedchats/.test(k))
        .map((k) => `${k}=${localStorage.getItem(k)}`);
      return [...texts, ...local].join('\n');
    }).catch((e) => `state unavailable: ${e.message}`);
    console.error(`состояние ${who}:\n${state}`);
    console.error(`журнал ${who}: ${logs[who].join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
