// Протокол v2 (spec 007, T128/T130, FR-066; D-11, D-12, D-16): отзыв своего
// устройства и обновление ключа подписи устройств ключом восстановления.
// alice — web v2; bob1 — первое v2-устройство bob (ключ восстановления показан
// ему), bob2 — второе, привязано грантом LINK-1.
// (1) bob1 завершает сеанс bob2 в Settings → Devices: кроме v1-отзыва, в журнал
//     устройств v2 уходит запись отзыва, меняются ключ доступа к доставке и
//     ключ личного состояния;
// (2) отозванное устройство новых сообщений не получает, живое — получает;
// (3) bob2 держал SSK → на экране Devices появляется блок «Device signing key»;
//     неверный ключ восстановления отклоняется, верный — меняет SSK корнем;
// (4) после смены SSK переписка продолжается (alice принимает новый журнал
//     bob без предупреждения о смене корня), а личное состояние bob1 живо.
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
  terminateSessionWithPassword,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-revoke-password';
const V2_SEED = { 'parvane:proto': 'v2' };
const LINK_TIMEOUT_MS = 90000;
// Журнал устройств собеседника отправитель перечитывает раз в 15 с
const PEER_LOG_REFRESH_MS = 20000;
// Сколько ждать, чтобы убедиться, что отозванное устройство НЕ получило сообщение
const REVOKED_SETTLE_MS = 8000;

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2'];
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

// Ввести ключ восстановления в диалоге «Renew key» экрана Devices
async function submitRecoveryKey(page, screen, key) {
  await screen.locator('.ListItem').filter({ hasText: 'Renew key' }).locator('.ListItem-button').click();
  const input = page.locator('.Modal input[aria-label="Recovery key"]');
  await input.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await input.fill(key);
  await page.locator('.Modal').getByRole('button', { name: 'Renew key' }).click();
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `rva-${suffix}@local`;
  const bob = `rvb-${suffix}@local`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(['alice', 'bob1'].map((who) => waitLog(who, 'v2: готов')));
  assert.ok(await dismissRecoveryKeyDialog(sessions.alice.page), 'alice: не показан ключ восстановления v2');
  const recoveryText = await dismissRecoveryKeyDialog(sessions.bob1.page);
  const recoveryKey = recoveryText?.match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/)?.[0];
  assert.ok(recoveryKey, `bob1: ключ восстановления не найден в диалоге: ${recoveryText}`);
  await waitLog('bob1', 'v2: журнал состояния подключён');
  const alicePage = sessions.alice.page;
  const bob1Page = sessions.bob1.page;

  const before = `rv-before-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, before);
  await openPrivateChatStrict(bob1Page, alice);
  await findMessage(bob1Page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const answer = `rv-answer-${suffix}`;
  await sendText(bob1Page, answer);
  await findMessage(alicePage, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Второе устройство bob: линковка грантом (как state-sync) ───────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'нужна линковка этого устройства');
  const dev2Screen = await openDevicesScreen(bob2Page);
  await dev2Screen.getByText(/Waiting for your other device/)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  let dev1Screen = await openDevicesScreen(bob1Page);
  const pendingText = dev2Screen.getByText(/confirm code \d{4} \d{4} \d{4}/);
  await pendingText.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const offerItem = dev1Screen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await offerItem.locator('.ListItem-button').click();
  const transferButton = bob1Page.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await bob1Page.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitLog('bob2', 'v2: устройство привязано грантом линковки', LINK_TIMEOUT_MS);
  await waitLog('bob2', 'v2: готов');
  await closeSettings(bob2Page);

  // Сообщение после линковки видят оба устройства bob
  const linked = `rv-linked-${suffix}`;
  await sendText(alicePage, linked);
  await closeSettings(bob1Page);
  await openPrivateChatStrict(bob1Page, alice);
  await findMessage(bob1Page, linked).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(bob2Page, alice);
  await findMessage(bob2Page, linked).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── (1) bob1 завершает сеанс bob2 ───────────────────────────────────────────
  dev1Screen = await openDevicesScreen(bob1Page);
  const otherSession = dev1Screen.locator('.ListItem:has(.title-with-date)').first();
  await otherSession.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await terminateSessionWithPassword(bob1Page, otherSession, PASSWORD);
  await waitLog('bob1', 'v2: устройство отозвано');
  assert.ok(!logs.bob1.some((l) => l.includes('отзыв устройства в журнале не выполнен')), logs.bob1.join(' | '));

  // ── (3) bob2 держал SSK: блок обновления ключа, неверный и верный ключ ─────
  await dev1Screen.getByText('Device signing key').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const wrongKey = recoveryKey.replace(/.$/, (c) => (c === '2' ? '3' : '2'));
  await submitRecoveryKey(bob1Page, dev1Screen, wrongKey);
  await expectToast(bob1Page, 'This recovery key does not match');
  await dev1Screen.getByText('Device signing key').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await submitRecoveryKey(bob1Page, dev1Screen, recoveryKey);
  await expectToast(bob1Page, 'Device signing key renewed');
  await waitLog('bob1', 'v2: SSK сменён корнем');
  await dev1Screen.getByText('Device signing key').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(bob1Page);

  // ── (2)+(4) После отзыва и смены SSK: живое устройство читает, отозванное — нет
  await alicePage.waitForTimeout(PEER_LOG_REFRESH_MS);
  const after = `rv-after-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, after);
  await openPrivateChatStrict(bob1Page, alice);
  await findMessage(bob1Page, after).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const reply = `rv-reply-${suffix}`;
  await sendText(bob1Page, reply);
  await findMessage(alicePage, reply).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bob2Page.waitForTimeout(REVOKED_SETTLE_MS);
  assert.equal(await findMessage(bob2Page, after).count(), 0, 'отозванное устройство получило новое сообщение');
  assert.equal(await findMessage(bob2Page, reply).count(), 0, 'отозванное устройство получило исходящее живого');

  // Смена SSK — не смена корня: предупреждения о смене ключа у alice нет
  assert.ok(!logs.alice.some((l) => /смен[аы] корня|rootChanged/i.test(l)), logs.alice.slice(-20).join(' | '));
  for (const who of ['alice', 'bob1']) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_revoke: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-revoke-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    // eslint-disable-next-line no-await-in-loop
    const devices = await session.page.evaluate(async () => {
      const result = await window.__parvaneDiagCallApi?.('fetchAuthorizations');
      return result ? Object.values(result.authorizations).map((a) => `${a.deviceModel}${a.isCurrent ? '*' : ''}`) : result;
    }).catch((e) => `ошибка: ${String(e)}`);
    console.error(`устройства ${who}: ${JSON.stringify(devices)}`);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`журнал ${who}: ${logs[who].slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
