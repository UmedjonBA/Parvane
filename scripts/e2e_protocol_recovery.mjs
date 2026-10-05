// Протокол v2 (spec 007, T129/T130, FR-019/FR-066): новое устройство, когда
// других устройств аккаунта не осталось, и смена корня у собеседника.
// alice — web v2; bob1 — первое v2-устройство bob (ключ восстановления показан
// ему), затем «потеряно».
// (1) bob2 — новое устройство: журнал устройств у аккаунта есть, других
//     устройств нет. Settings → Devices → «Use recovery key»: неверный ключ
//     отклоняется; верный — корень из копии на сервере, новый SSK, прежнее
//     устройство отозвано, bob2 в журнале. alice продолжает переписку БЕЗ
//     предупреждения (корень прежний);
// (2) bob3 — ещё одно новое устройство без ключа восстановления: «Reset secure
//     identity» (нужен пароль) — новый корень и журнал, показан новый ключ
//     восстановления. alice при следующей отправке видит служебное сообщение
//     «security key … has changed» (KEY-1 v2), сообщение доходит до bob3.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  expectToast,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-recovery-password';
const V2_SEED = { 'parvane:proto': 'v2' };
// Журнал устройств собеседника отправитель перечитывает раз в 15 с
const PEER_LOG_REFRESH_MS = 20000;
const KEY_PATTERN = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/;

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2', 'bob3'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const consoleTail = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t);
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
  });
});

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].slice(-40).join(' | ')})`);
}

async function openDevicesScreen(page) {
  // Непривязанное устройство web само открывает экран «Устройства» — тогда он уже на месте
  if (await page.locator('.SettingsActiveSessions').waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true, () => false)) {
    return page.locator('.SettingsActiveSessions');
  }
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

async function closeSettings(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await page.locator('#telegram-search-input').isVisible()) return;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  throw new Error('не удалось вернуться из настроек к списку чатов');
}

async function submitDialog(page, screen, action, inputLabel, value, confirm) {
  await screen.locator('.ListItem').filter({ hasText: action }).locator('.ListItem-button').click();
  const input = page.locator(`.Modal input[aria-label="${inputLabel}"]`);
  await input.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await input.fill(value);
  await page.locator('.Modal').getByRole('button', { name: confirm, exact: true }).click();
}

function keyChangeNotice(page) {
  return page.locator('.ActionMessage')
    .filter({ hasText: /security key of .* has changed/i });
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `rca-${suffix}@local`;
  const bob = `rcb-${suffix}@local`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(['alice', 'bob1'].map((who) => waitLog(who, 'v2: готов')));
  assert.ok(await dismissRecoveryKeyDialog(sessions.alice.page), 'alice: не показан ключ восстановления v2');
  const recoveryKey = (await dismissRecoveryKeyDialog(sessions.bob1.page))?.match(KEY_PATTERN)?.[0];
  assert.ok(recoveryKey, 'bob1: ключ восстановления не найден в диалоге');
  const alicePage = sessions.alice.page;

  const before = `rc-before-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, before);
  await openPrivateChatStrict(sessions.bob1.page, alice);
  await findMessage(sessions.bob1.page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const answer = `rc-answer-${suffix}`;
  await sendText(sessions.bob1.page, answer);
  await findMessage(alicePage, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Копия корня под ключом восстановления должна быть на сервере до потери устройства
  await sessions.bob1.page.waitForTimeout(3000);
  assert.ok(!logs.bob1.some((l) => l.includes('копия корня на сервер не ушла')), logs.bob1.slice(-20).join(' | '));

  // ── bob1 потеряно ───────────────────────────────────────────────────────────
  await contexts.bob1.close();
  delete sessions.bob1;

  // ── (1) bob2: вход по ключу восстановления ──────────────────────────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'нужна линковка этого устройства');
  const dev2 = await openDevicesScreen(bob2Page);
  await dev2.getByText('No other device?').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const wrongKey = recoveryKey.replace(/.$/, (c) => (c === '2' ? '3' : '2'));
  await submitDialog(bob2Page, dev2, 'Use recovery key', 'Recovery key', wrongKey, 'Use recovery key');
  await expectToast(bob2Page, 'This recovery key does not match');
  await submitDialog(bob2Page, dev2, 'Use recovery key', 'Recovery key', recoveryKey, 'Use recovery key');
  await waitLog('bob2', 'v2: устройство восстановлено ключом восстановления');
  await waitLog('bob2', 'v2: готов');
  await dev2.getByText('No other device?').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await dismissRecoveryKeyDialog(bob2Page, 3000), undefined,
    'bob2: при восстановлении показан новый ключ — создан новый корень');
  await closeSettings(bob2Page);

  await alicePage.waitForTimeout(PEER_LOG_REFRESH_MS);
  const afterRecovery = `rc-recovered-${suffix}`;
  await sendText(alicePage, afterRecovery);
  await openPrivateChatStrict(bob2Page, alice);
  await findMessage(bob2Page, afterRecovery).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const fromRecovered = `rc-from-recovered-${suffix}`;
  await sendText(bob2Page, fromRecovered);
  await findMessage(alicePage, fromRecovered).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await keyChangeNotice(alicePage).count(), 0,
    'alice: предупреждение о смене ключа при восстановлении (корень не менялся)');

  // ── bob2 тоже потеряно; (2) bob3: сброс личности ────────────────────────────
  await contexts.bob2.close();
  delete sessions.bob2;
  sessions.bob3 = await preparePage(contexts.bob3, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob3Page = sessions.bob3.page;
  await waitLog('bob3', 'нужна линковка этого устройства');
  const dev3 = await openDevicesScreen(bob3Page);
  await dev3.getByText('No other device?').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await submitDialog(bob3Page, dev3, 'Reset secure identity', 'Current password', `${PASSWORD}-wrong`, 'Reset');
  await expectToast(bob3Page, 'Wrong password');
  await submitDialog(bob3Page, dev3, 'Reset secure identity', 'Current password', PASSWORD, 'Reset');
  await waitLog('bob3', 'v2: личность сброшена');
  await waitLog('bob3', 'v2: готов');
  const newKey = (await dismissRecoveryKeyDialog(bob3Page))?.match(KEY_PATTERN)?.[0];
  assert.ok(newKey && newKey !== recoveryKey, 'bob3: после сброса не показан новый ключ восстановления');
  await closeSettings(bob3Page);

  await alicePage.waitForTimeout(PEER_LOG_REFRESH_MS);
  const afterReset = `rc-reset-${suffix}`;
  await sendText(alicePage, afterReset);
  await waitLog('alice', 'сменился корневой ключ');
  await keyChangeNotice(alicePage).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob3Page, alice);
  await findMessage(bob3Page, afterReset).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const fromReset = `rc-from-reset-${suffix}`;
  await sendText(bob3Page, fromReset);
  await findMessage(alicePage, fromReset).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  for (const who of Object.keys(sessions)) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_recovery: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-recovery-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`журнал ${who}: ${logs[who].slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
