// Напоминания «Плана» (этап 4 плана 15 окт 2026). Два привязанных устройства одного аккаунта: запись с
// «напомнить за 1 мин», созданная вводом текстом на первом, ставит будильник на сервере для обоих устройств
// (`push.alarm.set`; в базе шарда push только моменты), в срок оба открытых приложения показывают
// напоминание, а в «Избранное» оно попадает ровно одним сообщением (отметка «напомнено» в данных «Плана»).
// Закрытое приложение (пробуждение сервером → service worker) здесь не проверяется: в headless нет push-сервиса.
// Запуск: scripts/run_web_reminders_e2e.sh
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  openPlannerScreen,
  openSavedMessages,
  preparePage,
  relogin,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-reminders-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
// Срок напоминания — через 2–3 минуты; тик планировщика 30 с, «Избранное» пишется после паузы до 12 с и синка
const RING_TIMEOUT_MS = 5 * 60 * 1000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

function clock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function readAlarms() {
  const db = new DatabaseSync(`${BACKEND_DIR}/push.db-v2.db`, { readOnly: true });
  try {
    return db.prepare('SELECT inbox_token, at_ms FROM wake_alarms').all();
  } finally {
    db.close();
  }
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
}

async function countSaved(page, text) {
  await openSavedMessages(page);
  const bubbles = page.locator('#MiddleColumn .Message .text-content', { hasText: text });
  await bubbles.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Второе сообщение, если его кто-то пишет, приходит в пределах паузы записи и синка
  await page.waitForTimeout(15000);
  return bubbles.count();
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = Date.now().toString(36);
  const bob = `remind-bob-${suffix}@local`;
  const title = `Reminder-${suffix}`;

  sessions.bob1 = await preparePage(await browser.newContext({ viewport: WIDE }), bob, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.bob1.page).catch(() => undefined);
  sessions.bob2 = await preparePage(await browser.newContext({ viewport: WIDE }), bob, PASSWORD);
  await linkSecondDevice(sessions.bob1.page, sessions.bob2.page);
  console.log('OK: второе устройство привязано');

  // ── Запись с напоминанием вводом текстом ──
  const page = sessions.bob1.page;
  await openPlannerScreen(page, 'calendar');
  const planner = page.locator('#ParvanePlanner');
  const start = new Date(Date.now() + (new Date().getSeconds() > 40 ? 3 : 2) * 60 * 1000);
  start.setSeconds(0, 0);
  const remindAt = start.getTime() - 60 * 1000;
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  const input = page.locator('#planner-quick-input');
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.fill(`${title} today ${clock(start)} remind me 1 min before`);
  await page.locator('[data-quick-chip="remind"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.press('Enter');
  await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  console.log(`OK: запись ${title} на ${clock(start)}, напоминание в ${clock(new Date(remindAt))}`);

  // ── Будильник на сервере у обоих устройств: только моменты ──
  const alarms = await waitFor(() => {
    const rows = readAlarms().filter(({ at_ms: at }) => Number(at) === remindAt);
    return new Set(rows.map(({ inbox_token: token }) => token)).size >= 2 ? rows : undefined;
  }, 90000, 'будильник не поставлен на оба устройства');
  assert.deepEqual(Object.keys(alarms[0]).sort(), ['at_ms', 'inbox_token']);
  console.log('OK: будильник на сервере у двух устройств');

  // ── В срок оба открытых приложения показывают напоминание ──
  const toast = (session) => session.page.locator('.Notification', { hasText: title });
  await Promise.all([
    toast(sessions.bob1).first().waitFor({ state: 'visible', timeout: RING_TIMEOUT_MS }),
    toast(sessions.bob2).first().waitFor({ state: 'visible', timeout: RING_TIMEOUT_MS }),
  ]);
  const late = Date.now() - remindAt;
  assert(late < 60 * 1000, `напоминание опоздало на ${late} мс`);
  console.log(`OK: оба устройства напомнили (через ${Math.round(late / 1000)} с после срока)`);

  // ── В «Избранном» — одно сообщение, на обоих устройствах ──
  assert.equal(await countSaved(sessions.bob1.page, title), 1, '«Избранное» первого устройства');
  assert.equal(await countSaved(sessions.bob2.page, title), 1, '«Избранное» второго устройства');
  console.log('OK: в «Избранном» одно сообщение');

  // ── После перезагрузки наступившее не повторяется ──
  await relogin(sessions.bob1.page, PASSWORD);
  await sessions.bob1.page.waitForTimeout(45000);
  assert.equal(await toast(sessions.bob1).count(), 0, 'после перезагрузки напоминание не повторилось');
  assert.equal(await countSaved(sessions.bob1.page, title), 1, 'после перезагрузки дубля нет');
  console.log('e2e_web_reminders: OK');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${BACKEND_DIR}/reminders-${name}.png` }).catch(() => {});
    console.log(`--- журнал ${name} ---\n${(session.logs || [])
      .filter((line) => line.includes('напомин') || line.includes('планировщик')).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
