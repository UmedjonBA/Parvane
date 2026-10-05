// Потолок вызовов одному адресату (шард call, P-35; по умолчанию 10 за 60 с, в этом
// сценарии — 2): звонок сверх потолка не уходит, а звонящий видит причину и совет
// подождать, а не молчаливый сбой. Звонки в пределах потолка проходят.
// Запуск: scripts/run_web_call_limit_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  exchangeMessages,
  expectToast,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-calls-e2e-password';
const RING_MAX = Number(process.env.PARVANE_E2E_RINGING_MAX);
assert(RING_MAX > 0, 'PARVANE_E2E_RINGING_MAX is required');
// Вызов на одно анонимное соединение — не чаще раза в 5 с (gateway)
const RING_COOLDOWN_MS = 5500;
const LIMIT_TOAST = 'Too many calls to this person in the last minute. Wait a minute and try again';

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const media = { permissions: ['microphone', 'camera'] };
const aliceContext = await browser.newContext(media);
const bobContext = await browser.newContext(media);

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `cl-alice-${suffix}@local`;
  const bob = `cl-bob-${suffix}@local`;
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await exchangeMessages(aliceSession.page, alice, bobSession.page, bob, `limit-${suffix}`);
  await openPrivateChatStrict(aliceSession.page, bob);

  const callButton = aliceSession.page.getByRole('button', { name: 'Call', exact: true });
  // ── Звонки в пределах потолка доходят до адресата ──────────────────────────
  for (let round = 1; round <= RING_MAX; round++) {
    await callButton.click();
    await bobSession.page.getByText('is calling you...', { exact: true })
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await bobSession.page.getByRole('button', { name: 'End Call' }).click();
    await aliceSession.page.getByRole('button', { name: 'End Call' })
      .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
    await aliceSession.page.waitForTimeout(RING_COOLDOWN_MS);
  }
  console.log(`OK: ${RING_MAX} вызова в пределах потолка дошли`);

  // ── Вызов сверх потолка: причина тостом, звонок не висит, адресат не звонит ─
  await callButton.click();
  await expectToast(aliceSession.page, LIMIT_TOAST);
  await aliceSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobSession.page.getByText('is calling you...', { exact: true }).count(), 0,
    'вызов сверх потолка дошёл до адресата');

  for (const [name, session] of [['alice', aliceSession], ['bob', bobSession]]) {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  }
  console.log('OK: вызов сверх потолка не ушёл, звонящий видит причину и совет подождать');
} finally {
  await browser.close();
}
