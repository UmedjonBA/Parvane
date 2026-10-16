// «План»: сон за прошедший день и его правка (16 окт 2026, жалобы пользователя). «вчера спал с 5:00 до 15:00» —
// запись сна на вчера (а не событие); значок сна в календаре открывает «Здоровье» на этом дне; «Изменить»
// подставляет записанное в поле, «Удалить» убирает сон дня.
// Запуск: scripts/run_web_planner_sleep_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, openPlannerScreen, preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-planner-sleep-1';
const STEP_TIMEOUT_MS = 15000;

function dayKey(shift) {
  const date = new Date();
  date.setDate(date.getDate() + shift);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
try {
  const user = `sleep-${Date.now().toString(36)}@local`;
  const { page, errors } = await preparePage(context, user, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const health = planner.locator('[data-planner-health]');
  const sleepCard = health.locator('[data-health="sleep"]');
  const input = page.locator('#planner-quick-input');
  const yesterday = dayKey(-1);

  await openPlannerScreen(page, 'calendar');
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Week', exact: true }).click();
  // Вчера может быть на прошлой неделе (понедельник)
  if (new Date().getDay() === 1) await planner.getByRole('button', { name: 'Previous period' }).click();
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.fill('вчера спал с 5:00 до 15:00');
  await page.waitForFunction(() => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === 'sleep', undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await input.press('Enter');
  await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  const tag = planner.locator(`[data-sleep-open="${yesterday}"]`);
  await tag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await tag.innerText(), /10:00/, 'сон 10 часов на вчера');
  assert.equal(await planner.locator('[data-planner-view="week"]').getByText('спал', { exact: true }).count(), 0, 'не событие');
  console.log('OK: «вчера спал с 5:00 до 15:00» — сон на вчера');

  // Значок сна → «Здоровье» на вчерашнем дне
  await tag.click();
  await sleepCard.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sleepCard.getByText('05:00 → 15:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Изменить» — записанное в поле; поправить
  await sleepCard.locator('[data-sleep-edit]').click();
  await page.waitForFunction(() => document.querySelector('#planner-health-sleep')?.value === '05:00–15:00', undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await page.locator('#planner-health-sleep').fill('23:30-07:00');
  await sleepCard.getByRole('button', { name: 'Save', exact: true }).click();
  await sleepCard.getByText('23:30 → 07:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: значок сна открывает «Здоровье», сон исправлен');
  // «Удалить»
  await sleepCard.locator('[data-sleep-delete]').click();
  await planner.getByText('Sleep deleted').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sleepCard.locator('[data-sleep-edit]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await openPlannerScreen(page, 'calendar');
  if (new Date().getDay() === 1) await planner.getByRole('button', { name: 'Previous period' }).click();
  await page.waitForTimeout(1000);
  assert.equal(await planner.locator(`[data-sleep-open="${yesterday}"]`).count(), 0, 'сон удалён из календаря');
  console.log('OK: сон удалён');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_sleep: OK');
} finally {
  await browser.close();
}
