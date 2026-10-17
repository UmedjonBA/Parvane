// Личный звонок на два устройства (spec 024 И3): оба звонят; ответ на первом сразу гасит звонок на втором
// (без «пропущенного» на нём), разговор идёт с ответившим; отказ на втором — отказ всего звонка, первое
// перестаёт звонить; сигналы второго устройства принятый звонок не роняют.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  exchangeMessages,
  expectMediaFlowing,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-call-devices-e2e-password';
// Второе устройство должно перестать звонить сигналом, а не по таймауту вызова (45 с)
const ANSWERED_ELSEWHERE_MS = 8000;
// Отправитель узнаёт о новом устройстве собеседника после истечения кэша журнала (15 с)
const DEVICE_LIST_TTL_WAIT_MS = 17000;

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
  ],
});
const contextOptions = { permissions: ['microphone', 'camera'] };
const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext(contextOptions)));
const sessions = {};

const incoming = (page) => page.getByText('is calling you...', { exact: true });
const endCall = (page) => page.getByRole('button', { name: 'End Call' });

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `cdev-alice-${suffix}@local`;
  const bob = `cdev-bob-${suffix}@local`;
  sessions.alice = await preparePage(contexts[0], alice, PASSWORD);
  sessions.bob1 = await preparePage(contexts[1], bob, PASSWORD);
  const { page: a } = sessions.alice;
  const { page: b1 } = sessions.bob1;
  await exchangeMessages(a, alice, b1, bob, suffix);
  sessions.bob2 = await preparePage(contexts[2], bob, PASSWORD);
  const { page: b2 } = sessions.bob2;
  await linkSecondDevice(b1, b2);
  await a.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);

  // ── Ответ на первом: второе молчит, разговор с первым ──────────────────────
  await openPrivateChatStrict(a, bob);
  await a.getByRole('button', { name: 'Call', exact: true }).click();
  await Promise.all([b1, b2].map((page) => incoming(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })));
  await b1.getByRole('button', { name: 'Accept' }).click();
  const acceptedAt = Date.now();
  await incoming(b2).waitFor({ state: 'hidden', timeout: ANSWERED_ELSEWHERE_MS });
  console.log(`OK: второе устройство перестало звонить через ${Date.now() - acceptedAt} мс после ответа на первом`);
  await Promise.all([a, b1].map((page) => page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })));
  await Promise.all([a, b1].map((page) => expectMediaFlowing(page, { audio: true })));
  assert.equal(await endCall(b2).count(), 0, 'второе устройство вошло в звонок');
  // Разговор не рвётся
  await a.waitForTimeout(3000);
  assert.equal(await a.getByText(/^\d+:\d{2}$/).count() > 0, true, 'звонок у звонящего оборвался');
  await endCall(a).click();
  await endCall(b1).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  // На втором — без «пропущенного»
  await openPrivateChatStrict(b2, alice);
  await b2.waitForTimeout(2000);
  assert.equal(await b2.locator('.Message').filter({ hasText: /Missed Call|Пропущенный/i }).count(), 0,
    'на втором устройстве записан пропущенный звонок');
  console.log('OK: ответ на одном устройстве гасит звонок на другом');

  // ── Отказ на втором: звонок отклонён у звонящего, первое перестаёт звонить ──
  await a.getByRole('button', { name: 'Call', exact: true }).click();
  await Promise.all([b1, b2].map((page) => incoming(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })));
  await endCall(b2).click();
  await incoming(b1).waitFor({ state: 'hidden', timeout: ANSWERED_ELSEWHERE_MS });
  await endCall(a).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: отказ на одном устройстве — отказ звонка, другое перестаёт звонить');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий звонка на два устройства пройден');
} finally {
  await browser.close();
}
