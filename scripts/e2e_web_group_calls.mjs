// Трёхбраузерный групповой звонок: создание группы через UI, mesh-звонок
// (авто-join у приглашённых), у каждого участника два active-пира, mute,
// выход одного участника (у остальных mesh сохраняется), полный roспуск.
// Плюс: pairwise-записи mesh НЕ появляются в личной истории звонков.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-group-calls-e2e-password';

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page
      .locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
      .filter({ hasText: name })
      .first()
      .locator('input[type="checkbox"]:checked')
      .count();
    if (checked > 0) return;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected`);
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function activePeers(page) {
  return page.locator('[data-peer-state="active"]');
}

async function waitActivePeers(page, count, label) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-peer-state="active"]').length === expected,
    count,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {
    assert.fail(`${label}: не дождались ${count} активных участников`);
  });
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
  ],
});
const contexts = await Promise.all(
  Array.from({ length: 3 }, () => browser.newContext({ permissions: ['microphone'] })),
);

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `gc-alice-${suffix}@local`;
  const bob = `gc-bob-${suffix}@local`;
  const carol = `gc-carol-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const carolName = carol.split('@')[0];
  const groupTitle = `GC-${suffix.slice(-6)}`;

  const [aliceSession, bobSession, carolSession] = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
    preparePage(contexts[2], carol, PASSWORD),
  ]);

  // Знакомим пиров (имена/чаты) до группового пикера
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(aliceSession.page, carol);

  // ── Группа с тремя участниками через UI ────────────────────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await memberSearch.fill(carolName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', carolName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Групповой звонок из шапки группы ───────────────────────────────────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Приглашённые auto-join: у каждого участника по два active-пира
  await waitActivePeers(aliceSession.page, 2, 'alice');
  await waitActivePeers(bobSession.page, 2, 'bob');
  await waitActivePeers(carolSession.page, 2, 'carol');

  // ── Mute в групповом звонке ────────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Выход одного участника: mesh остальных живёт ───────────────────────────
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await waitActivePeers(bobSession.page, 1, 'bob after alice left');
  await waitActivePeers(carolSession.page, 1, 'carol after alice left');

  // ── Полный роспуск ─────────────────────────────────────────────────────────
  await bobSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Личная история НЕ засорена mesh-парами ─────────────────────────────────
  await aliceSession.page.waitForTimeout(3000);
  await openPrivateChat(aliceSession.page, bob);
  const strayCalls = await aliceSession.page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: 'Call' })
    .count();
  assert.equal(strayCalls, 0, 'mesh-пары группового звонка попали в личную историю');

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(carolSession.errors, [], `carol page errors: ${carolSession.errors.join('; ')}`);
  console.log('OK: групповой mesh-звонок трёх браузеров — auto-join, mute, выход и чистая история');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await Promise.all(contexts.map((context, index) => context.pages()[0]
    ?.screenshot({ path: `${dir}group-calls-${index}.png` }).catch(() => {})));
  throw err;
} finally {
  await browser.close();
}
