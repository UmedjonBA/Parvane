// spec 035 T111 (US8, FR-075): «В избранное» у стикера в ленте и синхронизация избранного на второе web-устройство
// того же аккаунта (объект FAVED_STICKER личного состояния). Прежде пункт был скрыт (`canFaveSticker = undefined`),
// избранное жило только на устройстве. Данные — выдуманные. Запуск: scripts/run_web_fave_sticker_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  exchangeMessages,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  openMessageMenuOn,
  openPrivateChatStrict,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Fave-sticker-e2e-2026';
const SUFFIX = Date.now().toString(36);
const ALICE = `fs-alice-${SUFFIX}@local`;
const BOB = `fs-bob-${SUFFIX}@local`;
const SYNC_TIMEOUT_MS = 90000;
const WIDE = { width: 1400, height: 900 };
const BUILTIN_SET = 'parvane-builtin';

async function waitDiag(page) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
}

async function favedIds(page) {
  await waitDiag(page);
  return page.evaluate(async () => (await window.__parvaneDiagCallApi('fetchFavoriteStickers', {})).stickers
    .map((s) => s.id));
}

async function waitFaved(page, label, predicate) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let ids = [];
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    ids = await favedIds(page);
    if (predicate(ids)) return ids;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: избранное не сошлось: ${JSON.stringify(ids)}`);
}

const browser = await chromium.launch();
const sessions = {};
try {
  sessions.a1 = await preparePage(await browser.newContext({ viewport: WIDE }), ALICE, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext({ viewport: WIDE }), BOB, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.a1.page).catch(() => undefined);
  await dismissRecoveryKeyDialog(sessions.bob.page).catch(() => undefined);
  const a1 = sessions.a1.page;
  await exchangeMessages(a1, ALICE, sessions.bob.page, BOB, `fs-${SUFFIX}`);
  sessions.a2 = await preparePage(await browser.newContext({ viewport: WIDE }), ALICE, PASSWORD);
  const a2 = sessions.a2.page;
  await linkSecondDevice(a1, a2);

  // alice1 шлёт bob стикер встроенного набора
  await openPrivateChatStrict(a1, BOB);
  await waitDiag(a1);
  const stickerId = await a1.evaluate(async ({ setId, nick }) => {
    const g = window.__parvaneGetGlobal();
    const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
    const chat = g.chats.byId[user.id];
    const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id: setId } });
    const sticker = set.stickers[2];
    await window.__parvaneDiagCallApi('sendMessage', { chat, sticker });
    return sticker.id;
  }, { setId: BUILTIN_SET, nick: BOB.split('@')[0] });
  assert.ok(stickerId, 'нет стикера');

  // Пункт «В избранное» в меню стикера в ленте (нативное меню Web A)
  const sticker = a1.locator('.Transition_slide-active > .MessageList .Message').last();
  await sticker.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await a1.waitForFunction((id) => {
    const g = window.__parvaneGetGlobal();
    return Object.values(g.messages.byChatId).some((c) => Object.values(c.byId || {})
      .some((m) => m.content?.sticker?.id === id));
  }, stickerId, { timeout: LOGIN_TIMEOUT_MS });
  await openMessageMenuOn(sticker);
  const fave = a1.locator('.MessageContextMenu').getByRole('menuitem', { name: 'Add to Favorites', exact: true });
  await fave.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await fave.click();
  await waitFaved(a1, 'alice1', (ids) => ids.includes(stickerId));
  console.log('«В избранное» в меню стикера сработало');

  // Меню того же стикера теперь предлагает убрать
  await openMessageMenuOn(sticker);
  await a1.locator('.MessageContextMenu').getByRole('menuitem', { name: 'Remove from Favorites', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await a1.keyboard.press('Escape');

  // Второе устройство видит избранное
  await waitFaved(a2, 'alice2', (ids) => ids.includes(stickerId));
  console.log('избранное на втором устройстве');

  // Убрать на втором — уходит и с первого
  await a2.evaluate(async ({ setId, id }) => {
    const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id: setId } });
    const s = set.stickers.find((x) => x.id === id);
    await window.__parvaneDiagCallApi('faveSticker', { sticker: s, unfave: true });
  }, { setId: BUILTIN_SET, id: stickerId });
  await waitFaved(a1, 'alice1 после снятия', (ids) => !ids.includes(stickerId));
  console.log('снятие с избранного доехало до первого устройства');
  console.log('E2E_WEB_FAVE_STICKER_OK');
} catch (e) {
  Object.entries(sessions).forEach(([name, s]) => {
    console.log(`--- журнал ${name}:\n${(s.logs || []).slice(-60).join('\n')}`);
  });
  throw e;
} finally {
  await browser.close();
}
