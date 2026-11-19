// spec 035 T134 (US2, STATE-1 на state.v2): web и Telegram X — два устройства одного аккаунта — без связи правят
// РАЗНЫЕ поля одной папки и одного контакта; после возвращения связи оба изменения на обоих. Запускается из
// `android/tgx_state_patch_flow.sh` (свой стек, эмулятор, vite preview и logcat X в $TGX_LOG уже подняты).
//  1. web: alice (новый аккаунт) и carol переписываются; у alice папка «Работа» 💼 с carol, своё имя carol «Кэрол»;
//  2. X входит alice с чистыми данными, web подтверждает привязку; X видит папку и контакт;
//  3. без связи: X — значок папки 🏠 и заметка carol, затем X останавливается (правка «не дослана»); web —
//     название «Работа и учёба» и имя «Кэрол Р.», затем связь web возвращается (записи web — в журнале);
//  4. X запускается со связью: досылает свою правку при подключении. Оба устройства показывают
//     «Работа и учёба» 🏠, «Кэрол Р.», заметку X. Без правки досланная правка X откатывала название и имя web.
// Данные — выдуманные. Строки `ok …` / `FAIL …` в stdout разбирает раннер.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  closeSettings,
  disconnectWhileOffline,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  openDevicesScreen,
  preparePage,
  waitForSocketCount,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'State-patch-android-2026';
const OUT = process.env.PV_ANDROID_OUT;
const TGX_LOG = process.env.TGX_LOG;
const GW_PORT = process.env.PV_GW_WS_PORT || '9222';
const PKG = 'org.parvane.tgx';
const SUFFIX = Date.now().toString(36);
const ALICE = `spx-alice-${SUFFIX}@local`;
const CAROL = `spx-carol-${SUFFIX}@local`;
const FOLDER_ID = 2;
const SYNC_TIMEOUT_MS = 120000;
const LINK_TIMEOUT_MS = 150000;
const NOTE = 'Соседка, любит вымышленные головоломки';

let failures = 0;
const ok = (label) => console.log(`ok ${label}`);
function fail(label, error) {
  failures += 1;
  console.log(`FAIL ${label}${error ? `: ${String(error?.message || error).split('\n')[0]}` : ''}`);
}
async function step(label, fn) {
  try {
    const r = await fn();
    ok(label);
    return r;
  } catch (error) {
    fail(label, error);
    throw error;
  }
}

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 60000 });
}
function put(name, text) {
  const file = join(OUT, `put-${name}`);
  writeFileSync(file, text);
  adb('push', file, `/data/local/tmp/${name}`);
  adb('shell', 'chmod', '644', `/data/local/tmp/${name}`);
}
let xMark = 0;
const xLog = () => {
  try {
    return readFileSync(TGX_LOG, 'utf8');
  } catch {
    return '';
  }
};
const markX = () => {
  xMark = xLog().length;
};
async function waitFor(fn, timeout, what) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn().catch(() => false)) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  throw new Error(`не дождались: ${what}`);
}
const xWait = (re, timeout = 90000) => waitFor(() => Promise.resolve(re.test(xLog().slice(xMark))), timeout, `X: ${re.source}`);
async function xCommand(command) {
  markX();
  put('parvane-e2e-cmd', JSON.stringify(command));
  await xWait(new RegExp(`e2e-cmd ${command.op} →`), 30000);
}
/** Что показывает X: строка e2e-команды state_check (папки, своё имя и заметка контакта). */
async function xShows(expect, timeout = SYNC_TIMEOUT_MS) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`папки \\[[^\\]]*«${esc(expect.title)}» ${esc(expect.emoticon)}[^\\]]*\\]; `
    + `контакт имя «${esc(expect.firstName)}» заметка «${esc(expect.note)}»`);
  let last = '';
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await xCommand({ op: 'state_check', peer: CAROL });
    const lines = xLog().slice(xMark).split('\n').filter((l) => l.includes('состояние-проверка:'));
    last = lines[lines.length - 1] || last;
    if (lines.some((l) => re.test(l))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 3000); });
  }
  throw new Error(`X показывает ${last.replace(/.*состояние-проверка: /, '') || 'ничего'}, ждали ${JSON.stringify(expect)}`);
}

async function diag(page, method, ...args) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  return page.evaluate(({ fn, params }) => window.__parvaneDiagCallApi(fn, ...params)
    .then((r) => (r === undefined ? null : JSON.parse(JSON.stringify(r)))), { fn: method, params: args });
}
function carolId(page) {
  return page.evaluate((nick) => Object.values(window.__parvaneGetGlobal().users.byId)
    .find((u) => u.usernames?.some(({ username }) => username === nick))?.id, CAROL.split('@')[0]);
}
async function editFolder(page, title, emoticon) {
  const id = await carolId(page);
  if (!id) throw new Error('нет пользователя carol на web');
  return diag(page, 'editChatFolder', {
    id: FOLDER_ID,
    folderUpdate: {
      title: { text: title, entities: [] },
      emoticon,
      includedChatIds: [id],
      excludedChatIds: [],
      pinnedChatIds: [],
      contacts: false,
      nonContacts: false,
      groups: false,
      channels: false,
      bots: false,
    },
  });
}
async function editContact(page, { firstName, note }) {
  const id = await carolId(page);
  if (firstName !== undefined) await diag(page, 'updateContact', { id, firstName, lastName: '' });
  if (note !== undefined) {
    const user = await page.evaluate((uid) => window.__parvaneGetGlobal().users.byId[uid], id);
    await diag(page, 'updateContactNote', user, { text: note, entities: [] });
  }
}
async function readShown(page) {
  const id = await carolId(page);
  return page.evaluate(async ({ folderId, uid }) => {
    const g = window.__parvaneGetGlobal();
    const folder = g.chatFolders.byId[folderId];
    const full = uid ? await window.__parvaneDiagCallApi('fetchFullUser', { id: uid }) : undefined;
    return {
      title: folder ? (folder.title?.text ?? folder.title) : undefined,
      emoticon: folder?.emoticon,
      firstName: uid ? g.users.byId[uid]?.firstName : undefined,
      note: full?.fullInfo?.note?.text || '',
    };
  }, { folderId: FOLDER_ID, uid: id });
}
async function webShows(page, expect) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    last = await readShown(page).catch((e) => ({ error: String(e) }));
    if (last.title === expect.title && last.emoticon === expect.emoticon
      && last.firstName === expect.firstName && (last.note || '') === expect.note) return;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(1500);
  }
  throw new Error(`web показывает ${JSON.stringify(last)}, ждали ${JSON.stringify(expect)}`);
}

const browser = await chromium.launch();
const logs = [];
try {
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  ctxA.on('page', (p) => p.on('console', (m) => { logs.push(m.text()); if (logs.length > 400) logs.shift(); }));
  const web = await step('web: alice и carol вошли, переписка есть', async () => {
    const a = await preparePage(ctxA, ALICE, PASSWORD);
    const c = await preparePage(ctxC, CAROL, PASSWORD);
    await dismissRecoveryKeyDialog(a.page).catch(() => undefined);
    await dismissRecoveryKeyDialog(c.page).catch(() => undefined);
    await exchangeMessages(a.page, ALICE, c.page, CAROL, `spx-${SUFFIX}`);
    return a.page;
  });
  const base = {
    title: 'Работа', emoticon: '💼', firstName: 'Кэрол', note: '',
  };
  await step('web: папка «Работа» 💼 с carol, своё имя «Кэрол»', async () => {
    await editFolder(web, base.title, base.emoticon);
    await editContact(web, { firstName: base.firstName, note: '' });
    await webShows(web, base);
  });

  await step('X: вход alice с чистыми данными, web подтверждает привязку', async () => {
    adb('shell', 'am', 'force-stop', PKG);
    adb('shell', 'pm', 'clear', PKG);
    adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
    adb('shell', 'rm', '-f', '/data/local/tmp/parvane-e2e-cmd', '/data/local/tmp/parvane-autolink');
    adb('reverse', `tcp:${GW_PORT}`, `tcp:${GW_PORT}`);
    put('parvane-gateway', `ws://127.0.0.1:${GW_PORT}/ws`);
    put('parvane-autologin', `${ALICE}:${PASSWORD}`);
    markX();
    adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
    await xWait(/устройству нужна привязка/, 120000);
    const screen = await openDevicesScreen(web);
    const offer = screen.locator('[data-link-offer]:not([data-link-code=""])').first();
    await offer.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await offer.locator('[data-link-confirm]').click();
    await web.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await closeSettings(web);
    await xWait(/привязка: грант v2 получен/, LINK_TIMEOUT_MS);
    await xWait(/журнал личного состояния подключён/, 120000);
  });
  await step('X: папка и контакт пришли из журнала', () => xShows(base));

  // ── без связи: X правит значок и заметку и останавливается, не дослав ─────────
  await step('X (без связи): значок папки 🏠 и заметка carol, остановка', async () => {
    // Снятый adb reverse не рвёт уже открытое соединение — X перезапускается без него (на самом деле без связи)
    adb('shell', 'am', 'force-stop', PKG);
    adb('reverse', '--remove', `tcp:${GW_PORT}`);
    await new Promise((r) => { setTimeout(r, 2000); });
    markX();
    adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
    await xWait(/v2: сессия запускается/, 60000);
    await new Promise((r) => { setTimeout(r, 5000); });
    await xCommand({ op: 'folder_icon', title: base.title, icon: '🏠' });
    await xCommand({ op: 'contact_note', peer: CAROL, note: NOTE });
    await xShows({ ...base, emoticon: '🏠', note: NOTE }, 20000);
    await new Promise((r) => { setTimeout(r, 3000); });
    adb('shell', 'am', 'force-stop', PKG);
  });
  await step('web (без связи): название «Работа и учёба» и имя «Кэрол Р.», затем связь', async () => {
    await disconnectWhileOffline(ctxA, web);
    await editFolder(web, 'Работа и учёба', base.emoticon);
    await editContact(web, { firstName: 'Кэрол Р.' });
    await web.waitForTimeout(3000);
    await ctxA.setOffline(false);
    await waitForSocketCount(web, 'opened', 2).catch(() => undefined);
    await web.waitForTimeout(8000); // записи web — в журнале до подключения X
  });

  // ── X со связью: правка досылается при подключении, правки web не откатываются ──
  const merged = {
    title: 'Работа и учёба', emoticon: '🏠', firstName: 'Кэрол Р.', note: NOTE,
  };
  await step('X запущен со связью, журнал подключён', async () => {
    adb('reverse', `tcp:${GW_PORT}`, `tcp:${GW_PORT}`);
    markX();
    adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
    await xWait(/журнал личного состояния подключён/, 120000);
  });
  await step('X: название и имя web на месте, свои значок и заметка тоже', () => xShows(merged));
  await step('web: значок и заметка X пришли, свои название и имя не откатились', () => webShows(web, merged));
} catch (error) {
  if (!failures) fail('сценарий', error);
  console.error(error);
} finally {
  if (failures) console.error(`журнал web:\n${logs.slice(-80).join('\n')}`);
  await browser.close();
}
if (failures) {
  console.log(`e2e_state_patch_android: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e_state_patch_android: OK');
