// «Избранное» (чат с самим собой): текст отправляется без ошибки (раньше
// sealForAddress падал — нет Olm-сессии с собой), сообщение переживает reload
// (журнал исходящих), у второго пользователя чужое «Избранное» не появляется.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  closeRightColumn,
  findMessage,
  findMessageContainer,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-saved-messages-e2e-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
let aliceSession;
let bobSession;

async function openSavedMessages(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Saved Messages' }).click();
  await page.locator('#MiddleColumn').getByText('Saved Messages').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Порядок пузырей в ленте открытого чата (ORDER-1): первое выше второго
async function expectOrder(page, first, second, label) {
  const top = async (text) => (await findMessage(page, text).boundingBox()).y;
  assert.ok(await top(first) < await top(second), `${label}: «${second}» стоит выше «${first}»`);
}

// Профиль «Избранного» (spec 012, A2): вкладки «Чаты» нет, пустые вкладки не крутят загрузку
async function expectSavedProfileTabs(page) {
  await page.locator('.MiddleHeader .ChatInfo').first().click();
  const right = page.locator('#RightColumn');
  const tabs = right.locator('.shared-media-tabs .TabList > div:not([aria-hidden])');
  await tabs.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const titles = (await tabs.allInnerTexts()).map((text) => text.split('\n')[0].trim());
  assert.ok(!titles.includes('Chats'), `в профиле Избранного есть вкладка Chats: ${titles.join(', ')}`);
  assert.ok(titles.length >= 3, `в профиле Избранного мало вкладок: ${titles.join(', ')}`);
  for (let index = 0; index < titles.length; index++) {
    await tabs.nth(index).click();
    await page.waitForTimeout(2000);
    const busy = await right.locator('.Spinner:visible, .Loading:visible').count();
    assert.equal(busy, 0, `вкладка «${titles[index]}» Избранного всё ещё грузится через 2 с`);
  }
  await closeRightColumn(page);
}

async function expectSent(page, text) {
  await findMessage(page, text).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const container = findMessageContainer(page, text);
  // Ошибка отправки — красный значок; «pending» должен смениться на sent
  await container.locator('.MessageOutgoingStatus--failed').waitFor({ state: 'hidden', timeout: 5000 });
  const failedCount = await container.locator('.MessageOutgoingStatus--failed').count();
  assert.equal(failedCount, 0, `сообщение «${text}» в Избранном помечено как неотправленное`);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `saved-alice-${suffix}@local`;
  const m1 = `note-one-${suffix}`;
  const m2 = `note-two-${suffix}`;

  const bob = `saved-bob-${suffix}@local`;
  // Часы Боба отстают на 30 с: его ответ всё равно должен встать ниже сообщения Алисы (ORDER-1)
  await bobContext.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() - 30000;
  });
  aliceSession = await preparePage(aliceContext, alice);
  bobSession = await preparePage(bobContext, bob);
  const { page } = aliceSession;

  // История с собеседником нужна, чтобы reload шёл через локальный кэш
  // (restoreFromCache), а не через полный синк — именно там терялось Избранное
  await openPrivateChatStrict(page, bob);
  await sendText(page, `hello-${suffix}`);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, `hello-${suffix}`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobSession.page, `reply-${suffix}`);
  await findMessage(page, `reply-${suffix}`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectOrder(page, `hello-${suffix}`, `reply-${suffix}`, 'у Алисы');
  await expectOrder(bobSession.page, `hello-${suffix}`, `reply-${suffix}`, 'у Боба');
  console.log('OK: ответ собеседника с отстающими часами стоит ниже сообщения');

  await openSavedMessages(page);
  await sendText(page, m1);
  await expectSent(page, m1);
  await sendText(page, m2);
  await expectSent(page, m2);
  console.log('OK: два сообщения в Избранном отправлены без ошибки');
  await expectSavedProfileTabs(page);
  console.log('OK: профиль Избранного — без вкладки «Чаты», пустые вкладки без загрузки');

  // Журнал исходящих пишется в IDB с задержкой (localState) — даём записаться
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#LeftColumn .ListItem').filter({ hasText: 'Saved Messages' }).first()
    .click();
  await expectSent(page, m1);
  await expectSent(page, m2);
  console.log('OK: Избранное пережило reload');
  await openPrivateChatStrict(page, bob);
  await findMessage(page, `reply-${suffix}`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectOrder(page, `hello-${suffix}`, `reply-${suffix}`, 'у Алисы после reload');
  console.log('OK: порядок сообщений пережил reload');

  assertNoPageErrors({ alice: aliceSession, bob: bobSession });
  console.log('OK: Избранное — отправка и persist');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  const dir = shotDir ? `${shotDir}/` : '';
  await aliceSession?.page.screenshot({ path: `${dir}saved-alice.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
