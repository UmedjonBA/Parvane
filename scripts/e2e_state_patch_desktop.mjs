// spec 035 T124 (US2, STATE-1 на state.v2): web и desktop — два устройства одного аккаунта — без связи правят
// РАЗНЫЕ поля одной папки и одного контакта; после возвращения связи оба изменения на обоих (пара с web сценария
// desktop/verify_state_patch.sh; android — scripts/e2e_state_patch_android.mjs). Пара `state-patch-desktop` в
// scripts/run_protocol_mixed_e2e.sh (свой стек, vite preview), бинарь desktop/build-probe/bin/Telegram с
// -DPARVANE_DEV=ON (хук PARVANE_AUTOPATCH); без бинаря — SKIP.
//  1. web: alice (новый аккаунт) переписывается с carol и bob; у alice папка «Работа» с carol, своё имя carol «Кэрол»;
//  2. desktop входит alice, web подтверждает привязку; desktop видит папку и контакт;
//  3. без связи: desktop — bob в папку и заметка carol, затем desktop останавливается (правка «не дослана»); web —
//     название «Работа+учёба» и имя «Кэрол Р.», затем связь web возвращается (записи web — в журнале);
//  4. desktop запускается со связью и досылает свою правку при подключении. Оба устройства показывают
//     «Работа+учёба» с bob и carol, «Кэрол Р.», заметку desktop. Без сведения по полям одна из правок теряется.
// Данные — выдуманные.
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
  closeSettings,
  disconnectWhileOffline,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  openDevicesScreen,
  preparePage,
  waitForSocketCount,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'State-patch-desktop-2026';
const SUFFIX = Date.now().toString(36);
const ALICE = `spd-alice-${SUFFIX}@local`;
const BOB = `spd-bob-${SUFFIX}@local`;
const CAROL = `spd-carol-${SUFFIX}@local`;
const FOLDER_ID = 2;
const SYNC_TIMEOUT_MS = 120000;
const LINK_TIMEOUT_MS = 150000;
// Без запятой: хук PARVANE_AUTOPATCH делит список правок по ','
const NOTE = 'Соседка и любит вымышленные головоломки';
const OFFLINE_GATEWAY = '127.0.0.1:9';

requireGatewayTcpUrl();
skipWithoutDesktop('state-patch web ↔ desktop');

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

const workdir = mkdtempSync(join(tmpdir(), 'parvane-state-patch-desktop-'));
const shim = buildLibraryShim(workdir);
let desktop;

async function startDesktop(env) {
  await stopDesktop(desktop);
  desktop = spawnDesktop(workdir, shim, { PARVANE_AUTOLOGIN: `${ALICE}:${PASSWORD}`, ...env });
  return readDesktopLog(workdir);
}

/** Что показывает desktop: строка хука `autopatch dump` (папка с чатами, своё имя и заметка контакта). */
async function desktopShows(expect, since, timeout = SYNC_TIMEOUT_MS) {
  const chats = [...expect.chats].sort().join(' ');
  const re = new RegExp(`autopatch dump папка «${escapeRegExp(expect.title)}» чаты \\[${escapeRegExp(chats)}\\]; `
    + `контакт ${escapeRegExp(CAROL)} имя «${escapeRegExp(expect.firstName)}» заметка «${escapeRegExp(expect.note)}»`);
  try {
    await waitDesktopLog(workdir, re, timeout, desktop, { since });
  } catch (error) {
    const last = readDesktopLog(workdir).split('\n').filter((l) => l.includes('autopatch dump')).pop() || 'ничего';
    throw new Error(`desktop показывает ${last.replace(/.*autopatch dump /, '')}, ждали ${JSON.stringify(expect)}`);
  }
}

async function diag(page, method, ...args) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  return page.evaluate(({ fn, params }) => window.__parvaneDiagCallApi(fn, ...params)
    .then((r) => (r === undefined ? null : JSON.parse(JSON.stringify(r)))), { fn: method, params: args });
}
function userId(page, address) {
  return page.evaluate((nick) => Object.values(window.__parvaneGetGlobal().users.byId)
    .find((u) => u.usernames?.some(({ username }) => username === nick))?.id, address.split('@')[0]);
}
async function editFolder(page, title, addresses) {
  const ids = [];
  for (const address of addresses) {
    // eslint-disable-next-line no-await-in-loop
    const id = await userId(page, address);
    if (!id) throw new Error(`нет пользователя ${address} на web`);
    ids.push(id);
  }
  return diag(page, 'editChatFolder', {
    id: FOLDER_ID,
    folderUpdate: {
      title: { text: title, entities: [] },
      includedChatIds: ids,
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
  const id = await userId(page, CAROL);
  if (firstName !== undefined) await diag(page, 'updateContact', { id, firstName, lastName: '' });
  if (note !== undefined) {
    const user = await page.evaluate((uid) => window.__parvaneGetGlobal().users.byId[uid], id);
    await diag(page, 'updateContactNote', user, { text: note, entities: [] });
  }
}
async function readShown(page) {
  const carol = await userId(page, CAROL);
  const bob = await userId(page, BOB);
  return page.evaluate(async ({ folderId, carolId, bobId }) => {
    const g = window.__parvaneGetGlobal();
    const folder = g.chatFolders.byId[folderId];
    const full = carolId ? await window.__parvaneDiagCallApi('fetchFullUser', { id: carolId }) : undefined;
    const included = folder?.includedChatIds || [];
    return {
      title: folder ? (folder.title?.text ?? folder.title) : undefined,
      chats: [carolId && included.includes(carolId) ? 'carol' : '', bobId && included.includes(bobId) ? 'bob' : '']
        .filter(Boolean).sort(),
      firstName: carolId ? g.users.byId[carolId]?.firstName : undefined,
      note: full?.fullInfo?.note?.text || '',
    };
  }, { folderId: FOLDER_ID, carolId: carol, bobId: bob });
}
async function webShows(page, expect) {
  const want = expect.chats.map((a) => a.split('-')[1]).sort();
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    last = await readShown(page).catch((e) => ({ error: String(e) }));
    if (last.title === expect.title && JSON.stringify(last.chats) === JSON.stringify(want)
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
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  ctxA.on('page', (p) => p.on('console', (m) => { logs.push(m.text()); if (logs.length > 400) logs.shift(); }));
  const web = await step('web: alice, bob и carol вошли, переписка есть', async () => {
    const a = await preparePage(ctxA, ALICE, PASSWORD);
    const b = await preparePage(ctxB, BOB, PASSWORD);
    const c = await preparePage(ctxC, CAROL, PASSWORD);
    await dismissRecoveryKeyDialog(a.page).catch(() => undefined);
    await dismissRecoveryKeyDialog(b.page).catch(() => undefined);
    await dismissRecoveryKeyDialog(c.page).catch(() => undefined);
    await exchangeMessages(a.page, ALICE, c.page, CAROL, `spd-c-${SUFFIX}`);
    await exchangeMessages(a.page, ALICE, b.page, BOB, `spd-b-${SUFFIX}`);
    return a.page;
  });
  const base = {
    title: 'Работа', chats: [CAROL], firstName: 'Кэрол', note: '',
  };
  await step('web: папка «Работа» с carol, своё имя «Кэрол»', async () => {
    await editFolder(web, base.title, [CAROL]);
    await editContact(web, { firstName: base.firstName, note: '' });
    await webShows(web, base);
  });

  await step('desktop: вход alice, web подтверждает привязку', async () => {
    const since = await startDesktop({ PARVANE_AUTOPATCH: `dump|Работа|${CAROL}@60,dump|Работа|${CAROL}@120` });
    await waitDesktopLog(workdir, /линковка: оффер \(обязательство\) опубликован/, 120000, desktop, { since });
    const screen = await openDevicesScreen(web);
    const offer = screen.locator('[data-link-offer]:not([data-link-code=""])').first();
    await offer.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await offer.locator('[data-link-confirm]').click();
    await web.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await closeSettings(web);
    await waitDesktopLog(workdir, /линковка: грант v2 получен/, LINK_TIMEOUT_MS, desktop, { since });
    await waitDesktopLog(workdir, /журнал личного состояния подключён/, 120000, desktop, { since });
    await desktopShows(base, since, 150000);
  });

  // ── без связи: desktop добавляет bob в папку и заметку carol, останавливается, не дослав ─────────
  await step('desktop (без связи): bob в папку «Работа», заметка carol, остановка', async () => {
    const since = await startDesktop({
      PARVANE_GATEWAY_URL: OFFLINE_GATEWAY,
      PARVANE_AUTOPATCH: `folder-add|Работа|${BOB}@10,contact-note|${CAROL}|${NOTE}@11,dump|Работа|${CAROL}@14`,
    });
    await waitDesktopLog(workdir, new RegExp(`autopatch folder-add «Работа» → ${escapeRegExp(BOB)}`), 60000, desktop,
      { since });
    await desktopShows({ ...base, chats: [CAROL, BOB], note: NOTE }, since, 30000);
    await new Promise((r) => { setTimeout(r, 2000); });
    await stopDesktop(desktop);
    desktop = undefined;
  });
  await step('web (без связи): название «Работа+учёба» и имя «Кэрол Р.», затем связь', async () => {
    await disconnectWhileOffline(ctxA, web);
    await editFolder(web, 'Работа+учёба', [CAROL]);
    await editContact(web, { firstName: 'Кэрол Р.' });
    await web.waitForTimeout(3000);
    await ctxA.setOffline(false);
    await waitForSocketCount(web, 'opened', 2).catch(() => undefined);
    await web.waitForTimeout(8000); // записи web — в журнале до подключения desktop
  });

  // ── desktop со связью: правка досылается при подключении, правки web не откатываются ──
  const merged = {
    title: 'Работа+учёба', chats: [CAROL, BOB], firstName: 'Кэрол Р.', note: NOTE,
  };
  await step('desktop со связью: название и имя web на месте, свои bob в папке и заметка тоже', async () => {
    const since = await startDesktop({
      PARVANE_AUTOPATCH: `dump|Работа|${CAROL}@40,dump|Работа|${CAROL}@80,dump|Работа|${CAROL}@120`,
    });
    await waitDesktopLog(workdir, /журнал личного состояния подключён/, 120000, desktop, { since });
    await desktopShows(merged, since, 150000);
  });
  await step('web: bob в папке и заметка desktop пришли, свои название и имя не откатились', () => webShows(web, merged));
} catch (error) {
  if (!failures) fail('сценарий', error);
  console.error(error);
} finally {
  if (failures) {
    console.error(`журнал web:\n${logs.slice(-80).join('\n')}`);
    console.error(`хвост лога desktop:\n${readDesktopLog(workdir).slice(-4000)}`);
  }
  await stopDesktop(desktop);
  await browser.close();
}
if (failures) {
  console.log(`e2e_state_patch_desktop: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e_state_patch_desktop: OK');
