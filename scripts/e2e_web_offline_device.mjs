// Conformance SYNC-1/SYNC-2: устройство ОТСУТСТВОВАЛО, пока ему писали.
// Прежние сценарии держали оба клиента онлайн, поэтому потеря сообщений за
// курсором синка не ловилась ни разу. Здесь получатель полностью закрывается
// (контекст браузера уничтожается), отправитель шлёт несколько сообщений, и
// получатель обязан догнать ВСЁ после возвращения — включая перезагрузку.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  dumpDiagJournal,
  findMessage,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  relogin,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-offline-device-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
let aliceContext = await browser.newContext();
let bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `off-alice-${suffix}@local`;
  const bob = `off-bob-${suffix}@local`;
  const texts = [`offline-1-${suffix}`, `offline-2-${suffix}`, `offline-3-${suffix}`];

  // 1. Оба поднимаются: bob регистрирует устройство и публикует прекеи.
  const aliceSession = await preparePage(aliceContext, alice);
  const bobSession = await preparePage(bobContext, bob);
  await openPrivateChatStrict(bobSession.page, alice);
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, `warmup-${suffix}`);
  await findMessage(bobSession.page, `warmup-${suffix}`);

  // 2. bob исчезает целиком (не reload, а закрытие контекста).
  await bobContext.close();
  bobContext = undefined;

  // 3. alice пишет в его отсутствие.
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await sendText(aliceSession.page, text);
  }

  // 4. bob возвращается на чистом контексте и обязан догнать всё.
  bobContext = await browser.newContext();
  const bobBack = await preparePage(bobContext, bob);
  await openPrivateChatStrict(bobBack.page, alice);
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(bobBack.page, text);
  }

  // 5. И переживает перезагрузку: курсор не должен был уехать за пропущенное.
  await relogin(bobBack.page, bob, PASSWORD);
  await openPrivateChatStrict(bobBack.page, alice);
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(bobBack.page, text);
  }

  assertNoPageErrors({ alice: aliceSession, bob: bobBack });
  assert.ok(true, 'все сообщения, присланные в отсутствие устройства, доехали');
  // eslint-disable-next-line no-console
  console.log('offline-device: OK');
} catch (error) {
  if (bobContext) {
    const pages = bobContext.pages();
    if (pages.length) await dumpDiagJournal(pages[0]).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
}
