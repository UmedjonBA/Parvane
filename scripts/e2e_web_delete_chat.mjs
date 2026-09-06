// «Удалить чат» в личке: очистка «для меня» уходит на сервер (msg.chat.clear),
// переживает reload (кэш истории вычищен, sync скрытое не отдаёт), у
// собеседника ничего не пропадает; новое сообщение возвращает чат только с
// новой историей; «удалить для меня и X» дополнительно удаляет свои сообщения
// у собеседника.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  clickUntil,
  dumpDiagJournal,
  findMessage,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  relogin,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-delete-chat-e2e-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
let aliceSession;
let bobSession;

const chatItem = (page, address) => page.locator('#LeftColumn .ListItem')
  .filter({ hasText: address.split('@')[0] }).first();

async function deleteChatFromList(page, address, buttonName) {
  const menuItem = page.getByRole('menuitem', { name: /Delete/ }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await chatItem(page, address).scrollIntoViewIfNeeded();
    await chatItem(page, address).click({ button: 'right' });
    const isMenuOpen = await menuItem.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (isMenuOpen) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  await menuItem.click();
  const modal = page.locator('.Modal.DeleteChatModal, .Modal').filter({ hasText: /delete/i }).first();
  const button = modal.getByRole('button', { name: buttonName });
  await button.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Под нагрузкой клик по кнопке модалки мог не дойти — повторяем, пока чат
  // не исчезнет из списка
  await clickUntil(
    button,
    () => chatItem(page, address).waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 8000 },
  );
}

async function expectVisible(page, text) {
  await findMessage(page, text).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `delchat-alice-${suffix}@local`;
  const bob = `delchat-bob-${suffix}@local`;
  const m1 = `first-from-alice-${suffix}`;
  const m2 = `second-from-bob-${suffix}`;
  const m3 = `third-from-alice-${suffix}`;
  const m4 = `fourth-from-bob-${suffix}`;
  const m5 = `fifth-from-alice-${suffix}`;

  aliceSession = await preparePage(aliceContext, alice);
  bobSession = await preparePage(bobContext, bob);

  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, m1);
  await openPrivateChatStrict(bobSession.page, alice);
  await expectVisible(bobSession.page, m1);
  await sendText(bobSession.page, m2);
  await expectVisible(aliceSession.page, m2);
  await sendText(aliceSession.page, m3);
  await expectVisible(bobSession.page, m3);

  // ── «Delete just for me»: чат исчезает из списка и не возвращается после reload
  await deleteChatFromList(aliceSession.page, bob, 'Delete just for me');
  if (process.env.PARVANE_E2E_DEBUG) {
    aliceSession.page.on('console', (msg) => {
      if (msg.text().includes('[parvane]')) console.error(`[alice console] ${msg.text().slice(0, 200)}`);
    });
    console.error('[debug] before reload deletedchats =', await aliceSession.page.evaluate(
      (self) => localStorage.getItem(`parvane:deletedchats:${self}`), alice));
  }
  await relogin(aliceSession.page, PASSWORD);
  await aliceSession.page.waitForTimeout(3000);
  if (process.env.PARVANE_E2E_DEBUG) {
    console.error('[debug] after reload deletedchats =', await aliceSession.page.evaluate(
      (self) => localStorage.getItem(`parvane:deletedchats:${self}`), alice));
    console.error('[debug] chat list =', await aliceSession.page.locator('#LeftColumn .ListItem').allInnerTexts());
  }
  assert.equal(await chatItem(aliceSession.page, bob).count(), 0, 'удалённый чат вернулся после reload');

  // Собеседник ничего не потерял
  for (const text of [m1, m2, m3]) {
    assert.equal(await findMessage(bobSession.page, text).count(), 1, `у Боба пропало ${text}`);
  }

  // ── Новое сообщение возвращает чат, но без старой истории ──────────────────
  await sendText(bobSession.page, m4);
  await chatItem(aliceSession.page, bob).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(aliceSession.page, bob);
  await expectVisible(aliceSession.page, m4);
  for (const text of [m1, m2, m3]) {
    assert.equal(await findMessage(aliceSession.page, text).count(), 0, `после очистки всплыло ${text}`);
  }
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChatStrict(aliceSession.page, bob);
  await expectVisible(aliceSession.page, m4);
  assert.equal(await findMessage(aliceSession.page, m1).count(), 0, 'после reload всплыла старая история');

  // ── «Delete for me and Bob»: свои сообщения стираются и у собеседника ──────
  await sendText(aliceSession.page, m5);
  await expectVisible(bobSession.page, m5);
  await deleteChatFromList(aliceSession.page, bob, /Delete for me and/);
  await findMessage(bobSession.page, m5).waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await findMessage(bobSession.page, m4).count(), 1, 'у Боба пропало его собственное сообщение');
  await relogin(aliceSession.page, PASSWORD);
  await aliceSession.page.waitForTimeout(3000);
  assert.equal(await chatItem(aliceSession.page, bob).count(), 0, 'чат вернулся после «удалить для обоих» и reload');

  assertNoPageErrors({ alice: aliceSession, bob: bobSession });
  console.log('web delete-chat e2e: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir && aliceSession) await aliceSession.page.screenshot({ path: `${shotDir}/delchat-alice.png` }).catch(() => {});
  if (aliceSession) await dumpDiagJournal(aliceSession.page, 'alice', 160).catch(() => {});
  if (bobSession) await dumpDiagJournal(bobSession.page, 'bob').catch(() => {});
  throw error;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
