// Протокол v2 (spec 007, T192): ключ восстановления утерян — помогает администратор.
// Сервер объявляет открытый ключ администратора (PARVANE_ESCROW_PUBLIC_KEY); клиент,
// создавая корень, кладёт на сервер его копию, запечатанную этим ключом. Закрытый
// ключ администратора — вне сервера.
// bob1 — первое устройство bob; ключ восстановления «потерян», устройство тоже.
// Администратор (scripts/admin_recover_user.sh) открывает копию своим ключом и
// выписывает новый ключ восстановления. bob2 — новое устройство: прежний ключ
// больше не подходит, новый — корень прежний, alice переписывается дальше без
// предупреждения о смене ключа. Копия для администратора после входа остаётся.
// Запуск: scripts/run_protocol_mixed_e2e.sh escrow
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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

const PASSWORD = 'Parvane-v2-escrow-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const ADMIN_KEY_FILE = process.env.PARVANE_E2E_ESCROW_KEY_FILE;
assert(BACKEND_DIR && ADMIN_KEY_FILE, 'PARVANE_E2E_BACKEND_LOG_DIR/PARVANE_E2E_ESCROW_KEY_FILE are required');
const IDENTITY_V2_DB = join(BACKEND_DIR, 'identity.db-v2.db');
const REPO = new URL('..', import.meta.url).pathname;

function escrowRow(user) {
  return execFileSync('sqlite3', [IDENTITY_V2_DB, `SELECT hex(escrow) FROM root_escrow WHERE user = '${user}'`])
    .toString().trim();
}
const V2_SEED = { 'parvane:proto': 'v2' };
// Журнал устройств собеседника отправитель перечитывает раз в 15 с
const PEER_LOG_REFRESH_MS = 20000;
const KEY_PATTERN = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/;

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
  const alice = `esa-${suffix}@local`;
  const bob = `esb-${suffix}@local`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(['alice', 'bob1'].map((who) => waitLog(who, 'v2: готов')));
  assert.ok(await dismissRecoveryKeyDialog(sessions.alice.page), 'alice: не показан ключ восстановления v2');
  // Ключ bob показан и «потерян»: дальше он нужен только чтобы убедиться, что перестал подходить
  const lostKey = (await dismissRecoveryKeyDialog(sessions.bob1.page))?.match(KEY_PATTERN)?.[0];
  assert.ok(lostKey, 'bob1: ключ восстановления не найден в диалоге');
  const alicePage = sessions.alice.page;

  const before = `es-before-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, before);
  await openPrivateChatStrict(sessions.bob1.page, alice);
  await findMessage(sessions.bob1.page, before).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const answer = `es-answer-${suffix}`;
  await sendText(sessions.bob1.page, answer);
  await findMessage(alicePage, answer).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Копия для администратора уходит на сервер вместе с копией под ключом восстановления
  await sessions.bob1.page.waitForTimeout(3000);
  assert.ok(!logs.bob1.some((l) => /копия корня (на сервер не ушла|для администратора не создана)/.test(l)),
    logs.bob1.slice(-20).join(' | '));
  const firstEscrow = escrowRow(bob);
  assert.match(firstEscrow, /^[0-9A-F]{234}$/, `на сервере нет копии корня bob для администратора: «${firstEscrow}»`);

  // ── Устройство и ключ потеряны; администратор выписывает новый ключ ─────────
  await contexts.bob1.close();
  delete sessions.bob1;
  const adminOut = execFileSync(join(REPO, 'scripts/admin_recover_user.sh'), [bob, ADMIN_KEY_FILE], {
    env: { ...process.env, PARVANE_IDENTITY_V2_DB: IDENTITY_V2_DB },
  }).toString();
  const issuedKey = adminOut.match(KEY_PATTERN)?.[0];
  assert.ok(issuedKey && issuedKey !== lostKey, `администратор не выписал новый ключ: ${adminOut}`);
  console.log('администратор выписал новый ключ восстановления');

  // ── bob2: прежний ключ не подходит, выписанный — подходит ───────────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'нужна линковка этого устройства');
  const dev2 = await openDevicesScreen(bob2Page);
  await dev2.getByText('No other device?').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await dev2.getByText(/Ask the server administrator/).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await submitDialog(bob2Page, dev2, 'Use recovery key', 'Recovery key', lostKey, 'Use recovery key');
  await expectToast(bob2Page, 'This recovery key does not match');
  await submitDialog(bob2Page, dev2, 'Use recovery key', 'Recovery key', issuedKey, 'Use recovery key');
  await waitLog('bob2', 'v2: устройство восстановлено ключом восстановления');
  await waitLog('bob2', 'v2: готов');
  await dev2.getByText('No other device?').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await dismissRecoveryKeyDialog(bob2Page, 3000), undefined,
    'bob2: при восстановлении показан новый ключ — создан новый корень');
  await closeSettings(bob2Page);

  await alicePage.waitForTimeout(PEER_LOG_REFRESH_MS);
  const afterRecovery = `es-recovered-${suffix}`;
  await sendText(alicePage, afterRecovery);
  await openPrivateChatStrict(bob2Page, alice);
  await findMessage(bob2Page, afterRecovery).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const fromRecovered = `es-from-recovered-${suffix}`;
  await sendText(bob2Page, fromRecovered);
  await findMessage(alicePage, fromRecovered).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await keyChangeNotice(alicePage).count(), 0,
    'alice: предупреждение о смене ключа (корень не менялся)');

  // Новое устройство само обновило копию для администратора: потеря ключа повторима
  assert.ok(!logs.bob2.some((l) => /копия корня (на сервер не ушла|для администратора не создана)/.test(l)),
    logs.bob2.slice(-20).join(' | '));
  const secondEscrow = escrowRow(bob);
  assert.match(secondEscrow, /^[0-9A-F]{234}$/, 'после входа по выписанному ключу копии для администратора нет');
  assert.notEqual(secondEscrow, firstEscrow, 'bob2 не обновил копию для администратора');

  for (const who of Object.keys(sessions)) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_escrow: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-escrow-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`журнал ${who}: ${logs[who].slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
