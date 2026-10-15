// «План»: группы (16 окт 2026, просьба пользователя). Вид «Список» — без панели дня, сверху ряд групп: создание с
// цветом, «Добавить в группу» с галочками, предварительным списком и «вместе с повторами»; цвет записи — цвет группы;
// группа видна в карточке события; переименование и удаление; всё переживает перезагрузку.
// Запуск: scripts/run_web_planner_groups_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, openPlannerScreen, preparePage, reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-planner-groups-1';
const STEP_TIMEOUT_MS = 15000;

const until = new Date();
until.setDate(until.getDate() + 40);
const untilText = `${String(until.getDate()).padStart(2, '0')}.${String(until.getMonth() + 1).padStart(2, '0')}.${until.getFullYear()}`;
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
// Оба занятия — в ближайшие дни (повтор с сегодняшнего дня), чтобы список их показал
const SCHEDULE = `${WEEKDAYS[new Date().getDay()]}\n23:00–23:30 Лекция, ауд. 1\n\n${WEEKDAYS[tomorrow.getDay()]}\n`
  + `22:00–22:30 Спортзал\n\nдо ${untilText}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
try {
  const user = `groups-${Date.now().toString(36)}@local`;
  const { page, errors } = await preparePage(context, user, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const sidePane = planner.locator('[data-planner-side]');
  const agenda = planner.locator('[data-planner-view="agenda"]');
  const groupBar = agenda.locator('[data-group-bar]');
  const closeSide = async () => {
    await sidePane.getByRole('button', { name: 'Close' }).first().click();
    await sidePane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };
  const openList = async () => {
    await openPlannerScreen(page, 'calendar');
    await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'List', exact: true })
      .click();
    await agenda.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const rowsOf = (name) => agenda.locator('button[data-event-id]').filter({ hasText: name });
  const colorOf = (row) => row.evaluate((el) => getComputedStyle(el).getPropertyValue('--planner-list-color').trim());

  // Расписание без группы
  await openPlannerScreen(page, 'calendar');
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await sidePane.locator('[data-schedule-input]').fill(SCHEDULE);
  await sidePane.locator('[data-schedule-add]').click();
  await planner.getByText('Schedule added: 2').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();

  // Вид «Список»: панели дня нет, ряд групп есть
  await openList();
  assert.equal(await planner.locator('[data-planner-day]').count(), 0, 'в виде «Список» панели дня нет');
  await rowsOf('Лекция').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await colorOf(rowsOf('Лекция').first()), '', 'без группы цвета нет');

  // Новая группа с цветом
  await groupBar.locator('[data-group-new]').click();
  const editor = groupBar.locator('[data-group-editor]');
  await editor.getByLabel('New group').fill('Учёба');
  await editor.getByRole('radio', { name: 'Color 5' }).click();
  await editor.getByRole('button', { name: 'Create group' }).click();
  await groupBar.locator('[data-group="Учёба"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: группа создана');

  // «Добавить в группу»: отметить лекцию, вместе с повторами
  await groupBar.locator('[data-group-pick]').click();
  const picking = agenda.locator('[data-group-picking]');
  await picking.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await rowsOf('Лекция').first().click();
  assert.equal(await sidePane.count(), 0, 'в режиме выбора карточка не открывается');
  await picking.locator('[data-group-preview]').getByText('Лекция · repeats').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await picking.getByRole('checkbox', { name: 'Together with repeats' }).isChecked(), true, 'повторы — по умолчанию да');
  assert.equal(await page.locator('#planner-group-target').inputValue(), 'Учёба');
  await picking.locator('[data-group-apply]').click();
  await planner.getByText('Added to «Учёба»: 1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await picking.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const lectureColors = await Promise.all((await rowsOf('Лекция').all()).map(colorOf));
  assert(lectureColors.length > 1, 'у лекции несколько повторов в списке');
  assert(lectureColors.every((c) => c && c === lectureColors[0]), `все повторы цвета группы: ${lectureColors}`);
  assert.equal(await colorOf(rowsOf('Спортзал').first()), '', 'не отмеченное — без группы');
  console.log('OK: ряд добавлен в группу вместе с повторами, цвет группы');

  // Группа — в карточке события
  await rowsOf('Лекция').first().click();
  await page.locator('#planner-event-list').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#planner-event-list').inputValue(), 'Учёба', 'группа в карточке события');
  await closeSide();

  // Переименование и цвет — у всех записей; после перезагрузки на месте
  await groupBar.locator('[data-group="Учёба"]').click();
  await editor.getByLabel('Group name').fill('Универ');
  await editor.getByRole('radio', { name: 'Color 2' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await groupBar.locator('[data-group="Универ"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const renamedColor = await colorOf(rowsOf('Лекция').first());
  assert(renamedColor && renamedColor !== lectureColors[0], 'цвет группы сменился у записей');
  await reloadPage(page);
  await planner.waitFor({ state: 'visible', timeout: 60000 });
  await openList();
  await groupBar.locator('[data-group="Универ"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await rowsOf('Лекция').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await colorOf(rowsOf('Лекция').first()), renamedColor, 'группа события пережила перезагрузку');
  console.log('OK: переименование и цвет группы, перезагрузка');

  // Удаление группы: записи остаются без группы
  await groupBar.locator('[data-group="Универ"]').click();
  await editor.getByRole('button', { name: 'Delete group' }).click();
  await page.locator('.Modal').getByRole('button', { name: 'Delete group' }).click();
  await groupBar.locator('[data-group="Универ"]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await rowsOf('Лекция').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await colorOf(rowsOf('Лекция').first()), '', 'после удаления группы записи без цвета');
  console.log('OK: группа удалена, записи остались');
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('e2e_web_planner_groups: OK');
} finally {
  await browser.close();
}
