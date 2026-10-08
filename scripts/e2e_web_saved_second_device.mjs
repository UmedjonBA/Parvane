// «Избранное» и второе устройство (по картине с прода 8 окт 2026, аккаунт
// ub_test): первое устройство без переписки v2 выдаёт грант второму, затем
// пишет себе в «Избранное» — на втором устройстве чат появляется в списке с
// превью, а открывался пустым. Проверяем: (1) заметка, отправленная с первого
// устройства ПОСЛЕ линковки, читается на втором при открытии чата из списка и
// после reload; (2) заметка со второго устройства видна на первом; (3) заметка,
// написанная ДО линковки, приезжает в экспорте линковки (вторая пара устройств).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  findMessage,
  linkSecondDevice,
  preparePage,
  relogin,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-saved-second-device-e2e-password';
// Доставка соседнему устройству аккаунта — инбокс v2 + запас
const SIBLING_SYNC_TIMEOUT_MS = 45000;

async function openSavedMessagesFromMenu(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Saved Messages' }).click();
  await page.locator('#MiddleColumn').getByText('Saved Messages').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function savedListItem(page) {
  return page.locator('#LeftColumn .ListItem').filter({ hasText: 'Saved Messages' }).first();
}

async function openSavedMessagesFromList(page) {
  const item = savedListItem(page);
  await item.waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('#MiddleColumn').getByText('Saved Messages').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function expectVisible(page, text, label, timeout = SIBLING_SYNC_TIMEOUT_MS) {
  await findMessage(page, text).first().waitFor({ state: 'visible', timeout }).catch(() => {
    assert.fail(`${label}: сообщение «${text}» не показано`);
  });
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;

  // ── Пара 1: как на проде — до линковки переписки v2 нет ───────────────────
  const bob = `s2d-bob-${suffix}@local`;
  const noteAfterLink = `s2d-after-${suffix}`;
  const noteFromSecond = `s2d-second-${suffix}`;

  sessions.bob1 = await preparePage(await browser.newContext(), bob, PASSWORD);
  sessions.bob2 = await preparePage(await browser.newContext(), bob, PASSWORD);
  await linkSecondDevice(sessions.bob1.page, sessions.bob2.page);

  // Первое устройство пишет себе; на втором чат открыт не был — только список
  await openSavedMessagesFromMenu(sessions.bob1.page);
  await sendText(sessions.bob1.page, noteAfterLink);
  await expectVisible(sessions.bob1.page, noteAfterLink, 'bob1', LOGIN_TIMEOUT_MS);

  const previewOnSecond = savedListItem(sessions.bob2.page).filter({ hasText: noteAfterLink });
  await previewOnSecond.waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS }).catch(() => {
    assert.fail('bob2: «Избранное» с превью заметки не появилось в списке чатов');
  });
  await openSavedMessagesFromList(sessions.bob2.page);
  await expectVisible(sessions.bob2.page, noteAfterLink, 'bob2 (открыто из списка)');
  console.log('OK: заметка с первого устройства читается на втором');

  // Reload второго устройства: заметка — из кэша истории
  await sessions.bob2.page.waitForTimeout(1500);
  await relogin(sessions.bob2.page, PASSWORD);
  await openSavedMessagesFromList(sessions.bob2.page);
  await expectVisible(sessions.bob2.page, noteAfterLink, 'bob2 после reload');
  console.log('OK: заметка пережила reload второго устройства');

  // Со второго — на первое
  await sendText(sessions.bob2.page, noteFromSecond);
  await expectVisible(sessions.bob1.page, noteFromSecond, 'bob1 (заметка со второго устройства)');
  console.log('OK: заметка со второго устройства видна на первом');

  // ── Пара 2: заметка ДО линковки приезжает в экспорте линковки ─────────────
  const carol = `s2d-carol-${suffix}@local`;
  const noteBeforeLink = `s2d-before-${suffix}`;
  sessions.carol1 = await preparePage(await browser.newContext(), carol, PASSWORD);
  await openSavedMessagesFromMenu(sessions.carol1.page);
  await sendText(sessions.carol1.page, noteBeforeLink);
  await expectVisible(sessions.carol1.page, noteBeforeLink, 'carol1', LOGIN_TIMEOUT_MS);
  // Журнал исходящих пишется в IDB с задержкой — даём записаться до экспорта
  await sessions.carol1.page.waitForTimeout(1500);

  sessions.carol2 = await preparePage(await browser.newContext(), carol, PASSWORD);
  await linkSecondDevice(sessions.carol1.page, sessions.carol2.page);
  await openSavedMessagesFromList(sessions.carol2.page);
  await expectVisible(sessions.carol2.page, noteBeforeLink, 'carol2 (история линковки)');
  console.log('OK: заметка до линковки перенесена на второе устройство');

  assertNoPageErrors(sessions);
  console.log('OK: «Избранное» на втором устройстве');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  const dir = shotDir ? `${shotDir}/` : '';
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}saved2-${name}.png` }).catch(() => {});
    console.log(`--- журнал ${name} ---\n${(session.logs || []).slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
