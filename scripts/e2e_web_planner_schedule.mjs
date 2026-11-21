// «План»: расписание на неделю текстом и «Очистить план» (16 окт 2026, просьба пользователя). Из «Настроек плана»
// открывается экран «Расписание на неделю» (spec 041 E1, разбор — движок): недельное расписание с «до <дата>» —
// строки становятся еженедельными событиями с сегодняшнего дня до
// этой даты (видны на следующей неделе и после перезагрузки); «Очистить план» с подтверждением стирает задачи и
// события. Запуск: scripts/run_web_planner_schedule_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closePlannerSettings, dismissRecoveryKeyDialog, openPlannerScreen, openPlannerSettings, preparePage, reloadPage,
  waitPastMidnight,
} from './e2e_web_helpers.mjs';

// Сценарий считает «сегодня» один раз: прогон не должен переходить через полночь
await waitPastMidnight();

const PASSWORD = 'Parvane-planner-schedule-1';
const STEP_TIMEOUT_MS = 15000;

function dotted(date) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
}

const until = new Date();
until.setDate(until.getDate() + 60);
const SCHEDULE = `Понедельник

17:00–18:30 Рисование, ауд. 12
18:30–20:00 Шахматный кружок, ауд. 12

Вторник

10:35–12:00 Алгебра (семинар), преп. Иванова А.А., 101 ГК
13:55–15:20 Основы программирования
15:30–16:55 Иностранный язык
17:30–19:00 Робототехника, группа 1, каб. 5

Среда

12:10–13:35 Алгебра (лекция), проф. Петров П.П., 202 ГК

Четверг

15:30–16:55 Иностранный язык
18:40–20:05 История (семинар), преп. Сидоров С.С., 303 ГК

Пятница

15:00–16:30 Бассейн, дорожка 3, СК

Суббота — свободна

Воскресенье

11:00–12:45 Английский клуб, группа 2, каб. 7
13:00–14:45 Робототехника, группа 2, каб. 7

до ${dotted(until)}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
try {
  const user = `sched-${Date.now().toString(36)}@local`;
  const { page, errors } = await preparePage(context, user, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const week = planner.locator('[data-planner-view="week"]');
  const importScreen = planner.locator('[data-planner-import]');
  // После перезагрузки вкладка открывается в «Плане» (раздел запомнен) — списка чатов нет
  const reload = async () => {
    await reloadPage(page);
    await planner.waitFor({ state: 'visible', timeout: 60000 });
  };
  const showNextWeek = async () => {
    await openPlannerScreen(page, 'calendar');
    await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Week', exact: true })
      .click();
    await week.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await planner.getByRole('button', { name: 'Next period' }).click();
  };

  // «Расписание на неделю» на компьютере — пункт колонки разделов экрана «Задачи» (DkPlanMore)
  await openPlannerScreen(page, 'calendar');
  await planner.locator('[data-planner-tasks-open]').click();
  await planner.locator('[data-planner-sections] [data-section="import"]').click();
  await importScreen.locator('[data-schedule-input]').fill(SCHEDULE);
  await importScreen.locator('[data-import-summary]').filter({ hasText: 'Understood: 12 events · until' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await importScreen.locator('[data-import-problem]').count(), 0, 'всё расписание понято');
  await importScreen.locator('[data-schedule-add]').click();
  await planner.getByText('Schedule added: 12').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await importScreen.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: расписание принято — 12 событий в неделю');

  // Следующая неделя: все занятия на месте (повторы с сегодняшнего дня)
  await showNextWeek();
  for (const name of ['Рисование', 'История (семинар)', 'Английский клуб', 'Алгебра (лекция)']) {
    await week.getByText(name, { exact: true }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  assert.equal(await week.getByText('Иностранный язык', { exact: true }).count(), 2, 'иностранный — вторник и четверг');
  await reload();
  await showNextWeek();
  await week.getByText('Рисование', { exact: true }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: занятия на следующей неделе и после перезагрузки');

  // «Очистить план» — страница «Модули / План», подтверждение, всё стёрто
  const settingsPage = await openPlannerSettings(page);
  await settingsPage.locator('[data-planner-clear]').click();
  await page.locator('.Modal').getByRole('button', { name: 'Clear plan' }).click();
  await settingsPage.getByText('Plan cleared').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closePlannerSettings(page);
  await showNextWeek();
  await week.getByText('Рисование', { exact: true }).first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: план очищен');
  await reload();
  await showNextWeek();
  await page.waitForTimeout(3000);
  assert.equal(await week.getByText('Рисование', { exact: true }).count(), 0, 'после перезагрузки план пуст');
  console.log('OK: очистка пережила перезагрузку');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_schedule: OK');
} finally {
  await browser.close();
}
