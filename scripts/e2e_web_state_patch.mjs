// spec 035 T110 (US2, STATE-1 v2): два web-устройства одного аккаунта без связи правят РАЗНЫЕ поля одной папки и
// одного контакта — после восстановления связи оба изменения есть на обоих устройствах и на третьем, привязанном
// позже. Прежний журнал (LWW по объекту целиком, `state.append`) терял правку устройства, записавшего первым.
// Данные — выдуманные. Запуск: scripts/run_web_state_patch_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  disconnectWhileOffline,
  exchangeMessages,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  preparePage,
  waitForSocketCount,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'State-patch-e2e-2026';
const SUFFIX = Date.now().toString(36);
const ALICE = `sp-alice-${SUFFIX}@local`;
const CAROL = `sp-carol-${SUFFIX}@local`;
const FOLDER_ID = 2;
const SYNC_TIMEOUT_MS = 90000;
const WIDE = { width: 1400, height: 900 };

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
  assert.ok(id, 'нет пользователя carol на устройстве');
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

/** Что видит устройство: папка из полосы папок, своё имя контакта и заметка (профиль) — нативные объекты Web A. */
async function readShown(page) {
  const id = await carolId(page);
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
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

/** Ждать, пока устройство не покажет ожидаемое. */
async function waitState(page, label, expect) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    last = await readShown(page).catch((e) => ({ error: String(e) }));
    if (last.title === expect.title && last.emoticon === expect.emoticon
      && last.firstName === expect.firstName && (last.note || '') === expect.note) {
      return;
    }
    // Журнал догоняется по уведомлению сервера; страховка — свой опрос
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: не сошлось: ${JSON.stringify(last)}, ждали ${JSON.stringify(expect)}`);
}

const browser = await chromium.launch();
const sessions = {};
try {
  const ctxA1 = await browser.newContext({ viewport: WIDE });
  const ctxCarol = await browser.newContext({ viewport: WIDE });
  sessions.a1 = await preparePage(ctxA1, ALICE, PASSWORD);
  sessions.carol = await preparePage(ctxCarol, CAROL, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.a1.page).catch(() => undefined);
  await dismissRecoveryKeyDialog(sessions.carol.page).catch(() => undefined);
  const a1 = sessions.a1.page;
  await exchangeMessages(a1, ALICE, sessions.carol.page, CAROL, `sp-${SUFFIX}`);

  // Исходное: папка «Работа» 💼 с carol и контакт carol с именем «Кэрол», без заметки
  await editFolder(a1, 'Работа', '💼');
  await editContact(a1, { firstName: 'Кэрол', note: '' });
  await waitState(a1, 'alice1 исходное', { title: 'Работа', emoticon: '💼', firstName: 'Кэрол', note: '' });

  const ctxA2 = await browser.newContext({ viewport: WIDE });
  sessions.a2 = await preparePage(ctxA2, ALICE, PASSWORD);
  const a2 = sessions.a2.page;
  await linkSecondDevice(a1, a2);
  await waitState(a2, 'alice2 после привязки', { title: 'Работа', emoticon: '💼', firstName: 'Кэрол', note: '' });
  console.log('alice2 видит папку и контакт');

  // Оба устройства без связи правят разные поля
  await disconnectWhileOffline(ctxA1, a1);
  await disconnectWhileOffline(ctxA2, a2);
  await editFolder(a1, 'Работа и учёба', '💼');
  await editContact(a1, { firstName: 'Кэрол Р.' });
  await editFolder(a2, 'Работа', '🏠');
  await editContact(a2, { note: 'Соседка, любит вымышленные головоломки' });
  // Дать записям «уйти» в пустоту (без связи) и правкам осесть локально
  await a1.waitForTimeout(3000);
  await a2.waitForTimeout(3000);

  // Связь вернулась
  await ctxA1.setOffline(false);
  await ctxA2.setOffline(false);
  await waitForSocketCount(a1, 'opened', 2).catch(() => undefined);
  await waitForSocketCount(a2, 'opened', 2).catch(() => undefined);
  const merged = {
    title: 'Работа и учёба', emoticon: '🏠', firstName: 'Кэрол Р.', note: 'Соседка, любит вымышленные головоломки',
  };
  await waitState(a1, 'alice1 после связи', merged);
  await waitState(a2, 'alice2 после связи', merged);
  console.log('оба изменения на обоих устройствах');

  // Третье устройство — из журнала
  const ctxA3 = await browser.newContext({ viewport: WIDE });
  sessions.a3 = await preparePage(ctxA3, ALICE, PASSWORD);
  await linkSecondDevice(a1, sessions.a3.page);
  await waitState(sessions.a3.page, 'alice3', merged);
  console.log('третье устройство видит оба изменения');
  console.log('E2E_WEB_STATE_PATCH_OK');
} catch (e) {
  Object.entries(sessions).forEach(([name, s]) => {
    console.log(`--- журнал ${name}:\n${(s.logs || []).slice(-60).join('\n')}`);
  });
  throw e;
} finally {
  await browser.close();
}
