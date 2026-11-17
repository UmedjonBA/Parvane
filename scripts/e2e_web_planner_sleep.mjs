// «План»: сон в календаре — из модуля «Здоровье» (spec 041 B4). «вчера спал с 5:00 до 15:00» в строке «Плана» —
// запись сна в «Здоровье» (а не событие), значок сна появляется в календаре и ведёт в модуль; удаление записи в
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
    await page.waitForFunction(() => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === 'sleep',
      undefined, { timeout: STEP_TIMEOUT_MS });
    await input.press('Enter');
    await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  };
  await enterQuick('вчера спал с 14 до 15');
  await enterQuick('вчера спал с 0:00 до 8:00');
  await page.waitForFunction((day) => /9:00/.test(document.querySelector(`[data-sleep-open="${day}"]`)?.textContent || ''),
    yesterday, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: два сна за день складываются (9:00)');

  // Телефон: недосып сегодня — красная плашка сна в одной строке со слоями «Сон / Еда / Дела» и сводкой плана,
  // отдельной плашки-предупреждения нет; нажатие на плашку сна показывает подсказку о сниженном бюджете дня
  await enterQuick('спал с 3:00 до 6:00');
  await page.setViewportSize({ width: 360, height: 800 });
  await openPlannerScreen(page, 'calendar');
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Day', exact: true }).click();
  const today = dayKey(0);
  const summary = planner.locator(`[data-planner-view="week"] [data-day-summary="${today}"]`);
  const shortTag = summary.locator(`[data-sleep-short="${today}"]`);
  await shortTag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await shortTag.innerText(), /3:00/, 'красная плашка сна — 3:00');
  assert.equal(await planner.getByText(/budget reduced/).count(), 0, 'предупреждения плашкой нет');
  const line = await summary.evaluate((node) => {
    const center = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
    const chip = node.querySelector('[data-layer="sleep"]');
    const sleepTag = node.querySelector('[data-sleep-short]');
    const row = sleepTag.parentElement;
    return {
      chip: chip && center(chip), sleep: center(sleepTag), sameRow: Boolean(chip) && chip.parentElement.parentElement === row,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      rowOverflow: row.scrollWidth - row.clientWidth,
      chipLeft: chip && Math.round(chip.getBoundingClientRect().left - row.getBoundingClientRect().left),
    };
  });
  assert.ok(line.sameRow && Math.abs(line.chip - line.sleep) <= 2 && line.pageOverflow <= 0
    && line.rowOverflow <= 0 && line.chipLeft >= 0,
    `слои и сводка — одной строкой: ${JSON.stringify(line)}`);
  await shortTag.click();
  const hint = summary.locator('[data-sleep-hint]');
  await hint.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await hint.innerText(), /3:00.*budget reduced/, 'подсказка о сниженном бюджете');
  if (process.env.PARVANE_SLEEP_SHOT) await page.screenshot({ path: process.env.PARVANE_SLEEP_SHOT });
  await summary.locator('[data-day-plan]').click();
  await hint.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — недосып красной плашкой в строке слоёв, подсказка по нажатию');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_sleep: OK');
} finally {
  await browser.close();
}
