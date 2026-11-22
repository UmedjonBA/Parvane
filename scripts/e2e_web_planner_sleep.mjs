// «План»: сон в календаре — из модуля «Здоровье» (spec 041 B4). «вчера спал с 5:00 до 15:00» в строке «Плана»
// целиком понимает разбор «Здоровья» (окно показывает `data-quick-kind="health"`) — это запись сна в «Здоровье»
// (а не событие), значок сна появляется в календаре и ведёт в модуль; удаление записи в
// модуле убирает значок; два сна дня складываются; недосып — красной плашкой.
// Запуск: scripts/run_web_planner_sleep_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closePlannerSettings, dismissRecoveryKeyDialog, openPlannerScreen, openPlannerSettings, openSettingsScreen,
  preparePage, waitPastMidnight,
} from './e2e_web_helpers.mjs';

// Сценарий считает «сегодня» один раз: прогон не должен переходить через полночь
await waitPastMidnight();

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
  // Удаление — из окна правки записи (крестиков в строках нет, доски `HealthSleep`, `DeskHealth`)
  await health.locator('[data-health-entries] [data-kind="sleep"] [data-health-entry-edit]').first().click();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
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
  // Компьютер (доска `RdPlan`): внизу колонки дня — строка «Сон прошлой ночью: 3:00 — бюджет дня снижен до …»,
  // метки сна вверху колонки нет
  await openPlannerScreen(page, 'today');
  const sleepLine = planner.locator(`[data-planner-day-aside] [data-sleep-line="${dayKey(0)}"]`);
  await sleepLine.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await sleepLine.innerText(), /^Sleep last night: 3:00 — day budget reduced to /, 'строка сна в колонке дня');
  assert.equal(await planner.locator('[data-planner-day-aside] [data-sleep-short]').count(), 0, 'метки сна в колонке нет');
  await page.setViewportSize({ width: 360, height: 800 });
  // Боковая панель уходит перерисовкой после смены размера: пока она видна, openPlannerScreen идёт путём компьютера
  await page.locator('#FoldersSidebar').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
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
  // Слой «Сон» выключается на странице «Модули / План» (телефон, доска `RpPlan`): метка пропадает
  const settingsPage = await openPlannerSettings(page);
  await settingsPage.locator('[data-layer="sleep"]').click();
  // Выключатель перерисовывается от сигнала слоёв — не в тот же кадр, что нажатие
  await settingsPage.locator('[data-layer="sleep"][aria-checked="false"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closePlannerSettings(page);
  await shortTag.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await (await openPlannerSettings(page)).locator('[data-layer="sleep"]').click();
  await closePlannerSettings(page);
  await shortTag.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — недосып красной меткой дня, подсказка по нажатию, слой «Сон» в настройках');
  // ── «Профиль → Модули / Здоровье — Цели здоровья» (доски `RdPlanSet`, `PhModSettings`) ──
  await openSettingsScreen(page, 'Modules');
  await page.locator('[data-module-settings="health"]').click();
  const goalsPage = page.locator('[data-settings-page="health"] [data-health-goals]');
  await goalsPage.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Цели строкой: разбор движка «Здоровья», Enter применяет
  const goalsLine = goalsPage.locator('[data-health-goals-line]');
  await goalsLine.fill('вес 70 шаги 10000');
  const understood = goalsPage.locator('[data-health-goals-understood]');
  await understood.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('строка целей не разобрана: нет «Понято: …»'));
  await page.waitForFunction(() => /weight · steps per day/.test(
    document.querySelector('[data-health-goals-understood]')?.textContent || '',
  ), undefined, { timeout: STEP_TIMEOUT_MS }).catch(async () => {
    assert.fail(`разбор целей: «${await understood.innerText()}»`);
  });
  await goalsLine.press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('[data-health-goals] input[data-goal="weight"]')?.value === '70'
    && document.querySelector('[data-health-goals] input[data-goal="steps"]')?.value === '10000'
  ), undefined, { timeout: STEP_TIMEOUT_MS });
  // Слова «отбой» и «подъём» в строке целей — цели времени сна
  await goalsLine.fill('отбой 23:15 подъём 6:45');
  await page.waitForFunction(() => /bedtime · wake-up/i.test(
    document.querySelector('[data-health-goals-understood]')?.textContent || '',
  ), undefined, { timeout: STEP_TIMEOUT_MS }).catch(async () => {
    assert.fail(`разбор целей сна: «${await understood.innerText().catch(() => '')}»`);
  });
  await goalsLine.press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('[data-health-goals] input[data-goal="sleep_bed"]')?.value === '23:15'
    && document.querySelector('[data-health-goals] input[data-goal="sleep_wake"]')?.value === '06:45'
  ), undefined, { timeout: STEP_TIMEOUT_MS });
  // Цели питания без названия блюда: калории и белки; калории, посчитанные из одних белков, целью не становятся.
  // Блок питания пока выключен, поля скрыты: принятая строка очищается, значения сверяются после «Включить блоки»
  await goalsLine.fill('ккал 2200 белки 140');
  await page.waitForFunction(() => /calories · protein/i.test(
    document.querySelector('[data-health-goals-understood]')?.textContent || '',
  ), undefined, { timeout: STEP_TIMEOUT_MS }).catch(async () => {
    assert.fail(`разбор целей питания: «${await understood.innerText().catch(() => '')}»`);
  });
  await goalsLine.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-health-goals-line]')?.value === '',
    undefined, { timeout: STEP_TIMEOUT_MS });
  await goalsLine.fill('белки 150');
  await page.waitForFunction(() => /^[^·]*protein[^·]*$/i.test(
    document.querySelector('[data-health-goals-understood]')?.textContent || '',
  ), undefined, { timeout: STEP_TIMEOUT_MS }).catch(async () => {
    assert.fail(`разбор одной цели белков: «${await understood.innerText().catch(() => '')}»`);
  });
  await goalsLine.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-health-goals-line]')?.value === '',
    undefined, { timeout: STEP_TIMEOUT_MS });
  // Сон: отбой и подъём, длительность считается, «Напоминать об отбое» — настройка устройства
  await goalsPage.locator('input[data-goal="sleep_bed"]').fill('23:30');
  await goalsPage.locator('input[data-goal="sleep_wake"]').fill('07:00');
  await goalsPage.locator('[data-health-goals-duration]').filter({ hasText: '7 h 30 min' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await goalsPage.locator('[data-health-bedtime]').click();
  await goalsPage.locator('[data-health-bedtime][aria-checked="true"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('parvane:bedtime-remind') || '{}').bedMin),
    23 * 60 + 30, 'напоминание об отбое — по цели отбоя',
  );
  // Питание, вода и тренировки по умолчанию выключены: полоса «… выключены, цели сохранены» и «Включить блоки»
  await goalsPage.locator('[data-health-goals-off]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await goalsPage.locator('input[data-goal="kcal"]').count(), 0, 'цели выключенного блока скрыты');
  await goalsPage.locator('[data-health-goals-blocks]').click();
  await page.locator('button[data-block="food"]').click();
  await page.locator('[data-module-settings="health"]').click();
  await goalsPage.locator('input[data-goal="kcal"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await goalsPage.locator('input[data-goal="kcal"]').inputValue(), '2200', 'цель калорий из строки');
  assert.equal(await goalsPage.locator('input[data-goal="protein"]').inputValue(), '150', 'цель белков из строки');
  console.log('OK: «Цели здоровья» — цели строкой, сон с длительностью, «Напоминать об отбое», «Включить блоки»');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_sleep: OK');
} finally {
  await browser.close();
}
