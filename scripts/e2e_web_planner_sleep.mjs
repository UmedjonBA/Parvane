// «План»: сон в календаре — из модуля «Здоровье» (spec 041 B4). «вчера спал с 5:00 до 15:00» в строке «Плана»
// целиком понимает разбор «Здоровья» (окно показывает `data-quick-kind="health"`) — это запись сна в «Здоровье»
// (а не событие), значок сна появляется в календаре и ведёт в модуль; удаление записи в
// модуле убирает значок; два сна дня складываются; недосып — красной плашкой.
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
  const input = page.locator('#planner-quick-input');
  const yesterday = dayKey(-1);

  await openPlannerScreen(page, 'calendar');
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Week', exact: true }).click();
  // Вчера может быть на прошлой неделе (понедельник)
  if (new Date().getDay() === 1) await planner.getByRole('button', { name: 'Previous period' }).click();
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.fill('вчера спал с 5:00 до 15:00');
  await page.waitForFunction(() => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === 'health', undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await input.press('Enter');
  await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  const tag = planner.locator(`[data-sleep-open="${yesterday}"]`);
  await tag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await tag.innerText(), /10:00/, 'сон 10 часов на вчера');
  assert.equal(await planner.locator('[data-planner-view="week"]').getByText('спал', { exact: true }).count(), 0, 'не событие');
  console.log('OK: «вчера спал с 5:00 до 15:00» — сон на вчера');

  // Значок сна ведёт в модуль «Здоровье»; запись удаляется там — значок в календаре пропадает
  await tag.click();
  const health = page.locator('#ParvaneHealth');
  await health.locator('[data-health-entries] [data-kind="sleep"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-entries] [data-kind="sleep"]').getByRole('button', { name: /^Delete entry/ }).click();
  await health.locator('[data-health-entries] [data-kind="sleep"]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await openPlannerScreen(page, 'calendar');
  if (new Date().getDay() === 1) await planner.getByRole('button', { name: 'Previous period' }).click();
  await tag.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: значок сна открывает «Здоровье»; удалённый там сон пропал из календаря');

  // Два сна за день складываются: ночь 8 часов и дневной час
  const enterQuick = async (line) => {
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await input.fill(line);
    await page.waitForFunction(() => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === 'health',
      undefined, { timeout: STEP_TIMEOUT_MS });
    await input.press('Enter');
    await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  };
  await enterQuick('вчера спал с 14 до 15');
  await enterQuick('вчера спал с 0:00 до 8:00');
  await page.waitForFunction((day) => /9:00/.test(document.querySelector(`[data-sleep-open="${day}"]`)?.textContent || ''),
    yesterday, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: два сна за день складываются (9:00)');

  // Телефон: недосып сегодня — красная метка сна под полосой загрузки дня, отдельной плашки-предупреждения
  // нет; нажатие на метку показывает подсказку о сниженном бюджете дня. Сон задан длительностью: промежуток
  // «с 3:00 до 6:00» до шести утра лежит в будущем, и разбор относит его на вчера
  await enterQuick('спал 3 часа');
  await page.setViewportSize({ width: 360, height: 800 });
  await openPlannerScreen(page, 'today');
  const today = dayKey(0);
  const dayView = planner.locator(`[data-planner-today="${today}"]`);
  const shortTag = dayView.locator(`[data-day-summary="${today}"] [data-sleep-short="${today}"]`);
  await shortTag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await shortTag.innerText(), /3:00/, 'красная метка сна — 3:00');
  assert.equal(await planner.getByText(/budget reduced/).count(), 0, 'предупреждения плашкой нет');
  const line = await dayView.evaluate((node) => {
    const row = node.querySelector('[data-day-summary]');
    return {
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      rowOverflow: row.scrollWidth - row.clientWidth,
    };
  });
  assert.ok(line.pageOverflow <= 0 && line.rowOverflow <= 0, `метки дня помещаются в экран: ${JSON.stringify(line)}`);
  await shortTag.click();
  const hint = dayView.locator('[data-sleep-hint]');
  await hint.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await hint.innerText(), /3:00.*budget reduced/, 'подсказка о сниженном бюджете');
  if (process.env.PARVANE_SLEEP_SHOT) await page.screenshot({ path: process.env.PARVANE_SLEEP_SHOT });
  await dayView.locator('[data-day-plan]').click();
  await hint.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Слой «Сон» выключается в настройках «Плана»: метка пропадает
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await planner.locator('[data-planner-side="settings"] [data-layer="sleep"]').click();
  await shortTag.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-planner-side="settings"] [data-layer="sleep"]').click();
  await shortTag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — недосып красной меткой дня, подсказка по нажатию, слой «Сон» в настройках');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_sleep: OK');
} finally {
  await browser.close();
}
