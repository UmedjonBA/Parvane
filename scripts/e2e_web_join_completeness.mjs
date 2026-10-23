// Новое устройство аккаунта получает ВСЁ сразу после входа — не «через пару минут» (отзыв 23–24 окт 2026: после
// ответа боту ключом сначала были видны 3 чата, группы, канал и «План» приходили позже; PWA писала «привязка не
// удалась», хотя вход прошёл, а другое устройство после этого спрашивало подтверждение привязки).
// На первом устройстве Алисы: переписка с Бобом, группа и канал с сообщениями, задача «Плана», папка и файл
// «Облака». Затем новые устройства Алисы входят тремя способами:
//   1. ответом боту в Telegram, первое устройство В СЕТИ;
//   2. ответом боту, все прежние устройства ЗАКРЫТЫ, а копию ключей аккаунта последним писало устройство,
//      само вошедшее по копии (копия не должна «беднеть» от устройства к устройству);
//   3. ключом восстановления, введённым руками на экране «Устройства»;
//   4. подтверждением с другого своего устройства (код сверки).
// После каждого входа не позже FAST_MS видны: личный чат и его история, группа и её история, канал и его пост,
// задача «Плана», папка и файл «Облака». Кроме того: состояние входа «готово», а не «не удалось»; после входа
// устройство не просит привязку ещё раз (сервер не видит нового оффера), и другие устройства не показывают запрос.
// Запуск: scripts/run_web_join_completeness_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { assertNoPageErrors, findMessage, linkSecondDevice, openPrivateChatStrict, sendText } from './e2e_web_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS, WIDE, expectEverythingFast, expectJoinState, expectNoOfferAfterJoin, joinByTelegram, joinByTypedKey,
  login, pullFor, seedAccount, TG_ALICE, waitBundleWrite,
} from './e2e_web_join_lib.mjs';

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = `${Date.now().toString(36)}${process.pid}`;
  const seeded = await seedAccount(browser, suffix);
  const {
    alice1, bob, aliceNick, expected,
  } = seeded;
  Object.assign(sessions, seeded.sessions);

  // ── 1. Ответ боту, первое устройство в сети ──
  const alice2 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice2 (бот, другие в сети)');
  sessions.alice2 = alice2;
  const ready2 = await joinByTelegram(alice2, alice1.key);
  const bundleWritesAtJoin2 = alice2.logs.filter((line) => line.includes('копия ключей аккаунта обновлена')).length;
  await expectEverythingFast(alice2, expected, ready2);
  await expectJoinState(alice2, 'done');
  await expectNoOfferAfterJoin(alice2, alice1.address, [alice1]);

  // ── 2. Копию ключей последним пишет вошедшее по копии устройство; все прежние закрыты ──
  await waitBundleWrite(alice2, 150000, bundleWritesAtJoin2);
  await alice1.page.close();
  await alice2.page.close();
  const alice3 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice3 (бот, все закрыты)');
  sessions.alice3 = alice3;
  const ready3 = await joinByTelegram(alice3, alice1.key);
  await expectEverythingFast(alice3, expected, ready3);
  await expectJoinState(alice3, 'done');
  await expectNoOfferAfterJoin(alice3, alice1.address, []);
  await alice3.page.close();

  // ── 3. Ключ восстановления руками, все прежние закрыты ──
  const alice4 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice4 (ключ руками)');
  sessions.alice4 = alice4;
  const ready4 = await joinByTypedKey(alice4, alice1.key);
  await expectEverythingFast(alice4, expected, ready4);
  await expectJoinState(alice4, 'done');
  await expectNoOfferAfterJoin(alice4, alice1.address, []);

  // ── 4. Подтверждение с другого своего устройства (код сверки) ──
  const alice5 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice5 (подтверждение с alice4)');
  sessions.alice5 = alice5;
  await pullFor(TG_ALICE, 'ask');
  await linkSecondDevice(alice4.page, alice5.page);
  const ready5 = Date.now();
  await expectEverythingFast(alice5, expected, ready5);
  await expectNoOfferAfterJoin(alice5, alice1.address, [alice4]);

  // Новые устройства пишут и получают
  const late = `late-${suffix}`;
  await openPrivateChatStrict(bob.page, alice1.address);
  await sendText(bob.page, late);
  for (const session of [alice4, alice5]) {
    await openPrivateChatStrict(session.page, bob.address);
    await findMessage(session.page, late).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  console.log('OK: новые устройства получают новые сообщения');

  assertNoPageErrors(Object.values(sessions));
  console.log('JOIN COMPLETENESS: OK');
} catch (err) {
  for (const [name, session] of Object.entries(sessions)) {
    console.log(`--- ${name} (последние строки журнала) ---\n${(session.logs || []).slice(-40).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}
