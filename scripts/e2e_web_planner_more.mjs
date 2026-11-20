// «План»: экраны по доскам spec 041 E1 — «Расписание на неделю» (текст → повторяющиеся события, непонятое красным),
// поиск по плану с чипами, «Найти свободное время» в карточке записи, «Задачи» (по срокам, без даты, группы) и
// запланированная тренировка в «Активности» «Здоровья»; колонка разделов, задача на шкалу дня, меню записи по правой
// кнопке, образец напоминания и карточка записи строками на телефоне. Разбор, подбор окон и поиск — в движке (PLANNER-2).
// Компьютер и телефон, снимки — в PARVANE_E2E_SHOT_DIR. Запуск: scripts/run_web_planner_more_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, openHealthModule, openPlannerScreen, preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-planner-more-1';
const STEP_TIMEOUT_MS = 20000;
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 844 };
const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
// Каждый день — тренировка поздно вечером: и сегодня, и завтра она ещё впереди
const WEEK = DAYS.map((day) => `${day} 21:00-22:30 Силовая в зале`).join(' · ');
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR;

const browser = await chromium.launch();
let session;
try {
  const context = await browser.newContext({ viewport: WIDE });
  session = await preparePage(context, `plmore-${Date.now().toString(36)}@local`, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const sidePane = planner.locator('[data-planner-side]');
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не видно: ${what}`));
  const shot = async (name) => {
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  };
  const closeSide = async () => {
    await sidePane.getByRole('button', { name: 'Close' }).first().click();
    await sidePane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };
  const openImport = async () => {
    await planner.getByRole('button', { name: 'Planner settings' }).click();
    await sidePane.locator('[data-schedule-open]').click();
    await visible(planner.locator('[data-planner-import]'), 'экран «Расписание на неделю»');
    return planner.locator('[data-planner-import]');
  };

  // ── Расписание на неделю: одна строка через точки, непонятое красным ─────
  await openPlannerScreen(page, 'calendar');
  let importScreen = await openImport();
  await importScreen.locator('[data-schedule-input]').fill('пн 10-11 созвон · ср 18:30 зал · чт вечер ???');
  await visible(importScreen.locator('[data-import-summary]').filter({ hasText: 'Understood events: 2 · no end' }), 'итог разбора');
  assert.equal(await importScreen.locator('[data-import-item]').count(), 2, 'два события поняты');
  await visible(importScreen.locator('[data-import-item]').filter({ hasText: 'no end time — 1 hour assumed' }), 'подставленный час');
  await visible(importScreen.locator('[data-import-problem]').filter({ hasText: 'чт вечер ???' }), 'непонятая строка');
  await visible(importScreen.getByRole('button', { name: 'Add events: 2' }), 'кнопка с числом событий');
  await importScreen.locator('[data-until="month"]').click();
  await visible(importScreen.locator('[data-import-summary]').filter({ hasText: 'Understood events: 2 · until' }), 'срок — конец месяца');
  await shot('plan-import-wide');
  await importScreen.locator('[data-schedule-input]').fill(WEEK);
  await importScreen.locator('[data-until="none"]').click();
  await visible(importScreen.getByRole('button', { name: 'Add events: 7' }), 'неделя тренировок');
  assert.equal(await importScreen.locator('[data-import-problem]').count(), 0, 'всё понято');
  await importScreen.locator('[data-schedule-add]').click();
  await visible(planner.getByText('Schedule added: 7'), 'уведомление о добавлении');
  await importScreen.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: расписание текстом — разбор движком, непонятое красным, срок, добавление');

  // ── Поиск: чипы, «Впереди» по ряду одной строкой, стрелки и Enter ────────
  await planner.locator('[data-planner-search-open]').click();
  const search = planner.locator('[data-planner-search]');
  await search.locator('[data-planner-search-input]').fill('зале');
  const ahead = search.locator('[data-search-section="ahead"]');
  await visible(ahead.getByText('Ahead · 7'), 'впереди — по экземпляру каждого ряда');
  assert.equal(await ahead.locator('[data-key]').count(), 7, 'ряд — одной строкой');
  await search.locator('[data-filter="tasks"]').click();
  await visible(search.locator('[data-search-none]'), 'среди задач тренировок нет');
  await search.locator('[data-filter="events"]').click();
  await visible(ahead.locator('[data-key]'), 'события снова найдены');
  await shot('plan-search-wide');
  await search.locator('[data-planner-search-input]').press('ArrowDown');
  await page.keyboard.press('Enter');
  await visible(planner.locator('[data-planner-side="event"]'), 'Enter открыл событие');
  console.log('OK: поиск — чипы, ряды одной строкой, стрелки и Enter');

  // ── Найти свободное время: блок в карточке события, выбор окна ───────────
  const freeTime = sidePane.locator('[data-free-time]');
  await visible(freeTime.getByText('Find free time'), 'блок «Найти свободное время»');
  await visible(freeTime.locator('[data-free-slot]'), 'окна под событие');
  await freeTime.locator('[data-part="morning"]').click();
  await visible(freeTime.locator('[data-part="morning"][aria-pressed="true"]'), 'выбрано «Утро»');
  const slot = freeTime.locator('[data-free-slot]').first();
  await visible(slot, 'утреннее окно');
  const slotLabel = await slot.innerText();
  const startTime = slotLabel.match(/(\d\d:\d\d)–/)[1];
  assert.ok(startTime < '12:00', `утреннее окно начинается до полудня: ${startTime}`);
  await shot('plan-freetime-wide');
  await slot.getByRole('button', { name: 'Pick' }).click();
  await page.waitForFunction((time) => [...document.querySelectorAll('[data-planner-side] input[type="time"]')]
    .some((input) => input.value === time), startTime, { timeout: STEP_TIMEOUT_MS });
  await closeSide();
  await search.getByRole('button', { name: 'Back' }).click();
  await search.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: свободное время — окна движка, часть дня, выбор окна ставит время в форму');

  // ── Задачи: без даты, «На сегодня», по срокам, группы ────────────────────
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill('Купить кроссовки');
  await page.locator('#planner-quick-input').press('Enter');
  await visible(planner.getByText('Added: Купить кроссовки'), 'задача без даты');
  await planner.locator('[data-planner-tasks-open]').click();
  const tasks = planner.locator('[data-planner-tasks]');
  await visible(tasks.locator('[data-planner-undated]').getByText('Купить кроссовки'), 'задача в «Без даты»');
  await visible(tasks.locator('aside [data-planner-groups]'), 'группы справа на компьютере');
  await tasks.locator('aside [data-group-editor] input').fill('Спорт');
  await tasks.locator('aside [data-group-editor]').getByRole('radio').nth(3).click();
  await tasks.locator('aside [data-group-editor]').getByRole('button', { name: 'Create' }).click();
  await visible(tasks.locator('aside [data-group="Спорт"]'), 'новая группа');
  await shot('plan-tasks-wide');
  await tasks.getByRole('button', { name: /^Schedule Купить кроссовки for / }).click();
  await visible(planner.getByText('Moved to'), 'задача назначена на сегодня');
  await tasks.getByRole('tab', { name: 'By deadline' }).click();
  await visible(tasks.locator('[data-tasks-empty]'), 'задач со сроком нет');
  await tasks.getByRole('tab', { name: 'Groups' }).click();
  await visible(tasks.locator('[data-group="Спорт"]'), 'вкладка групп');
  await page.keyboard.press('Escape');
  await tasks.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Задачи» — без даты, «На сегодня», по срокам, группы; Escape закрывает');

  // ── Колонка разделов на компьютере (DkPlanMore), задача на шкалу (RdPlan), меню записи (ZdPlanX) ────
  await planner.locator('[data-planner-tasks-open]').click();
  const sections = planner.locator('[data-planner-sections]');
  await visible(sections, 'колонка разделов «Плана»');
  await sections.locator('[data-section="deadlines"]').click();
  await visible(planner.locator('[data-planner-tasks="deadlines"]'), 'раздел «Задачи по срокам»');
  await sections.locator('[data-section="import"]').click();
  await visible(planner.locator('[data-planner-import]'), 'раздел «Расписание на неделю»');
  await visible(sections.locator('[data-section="import"][aria-current="page"]'), 'раздел отмечен');
  await sections.locator('[data-section="today"]').click();
  await sections.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const dayAside = planner.locator('[data-planner-day-aside]');
  await visible(dayAside.locator('[data-drag-hint]'), 'подсказка «Перетащите задачу на шкалу»');
  const shoeRow = dayAside.locator('[data-today-untimed] [data-task-id]').filter({ hasText: 'Купить кроссовки' });
  const column = planner.locator('[data-grid-day]').first();
  const columnBox = await column.boundingBox();
  await shoeRow.first().dragTo(column, { targetPosition: { x: 40, y: Math.round(columnBox.height / 2) } });
  const shoeBlock = column.locator('button[data-kind="task"]').filter({ hasText: 'Купить кроссовки' });
  await visible(shoeBlock, 'задача встала на шкалу');
  assert.match(await shoeBlock.first().innerText(), /\d\d:\d[05]–/, 'время по месту броска, шаг 15 минут');
  await shot('plan-drag-wide');
  const menu = page.getByRole('menu');
  const menuItem = (name) => menu.getByRole('menuitem', { name, exact: true });
  await shoeBlock.first().click({ button: 'right' });
  for (const name of ['Open', 'Mark done', 'Move to tomorrow', 'Find free time…', 'Duplicate', 'Change layer',
    'Offer to a contact…', 'Delete']) {
    await visible(menuItem(name), `пункт меню «${name}»`);
  }
  await shot('plan-menu-wide');
  await menuItem('Duplicate').click();
  await visible(planner.getByText('Duplicated: Купить кроссовки'), 'копия записи');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-grid-day] button[data-kind="task"]')]
    .filter((el) => el.textContent.includes('Купить кроссовки')).length === 2, undefined, { timeout: STEP_TIMEOUT_MS });
  await shoeBlock.first().click({ button: 'right' });
  await menuItem('Move to tomorrow').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-grid-day] button[data-kind="task"]')]
    .filter((el) => el.textContent.includes('Купить кроссовки')).length === 1, undefined, { timeout: STEP_TIMEOUT_MS });
  const gym = column.locator('button[data-kind="event"]').filter({ hasText: 'Силовая в зале' }).first();
  await gym.click({ button: 'right' });
  await menuItem('Change layer').click();
  await menuItem('Спорт').click();
  await visible(planner.getByText('Силовая в зале · Спорт'), 'слой ряда сменён');
  await column.click({ button: 'right', position: { x: 10, y: 5 } });
  await visible(menu.getByRole('menuitem', { name: /^New entry at \d\d:\d\d$/ }), 'меню пустого места шкалы');
  await menuItem('Find free time…').click();
  await visible(page.locator('.Modal [data-free-time] [data-free-slot]'), 'окна для новой записи');
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await visible(sidePane.locator('[data-reminder-sample]'), 'образец напоминания в настройках');
  await closeSide();
  console.log('OK: колонка разделов, задача на шкалу, меню записи и пустого места шкалы, образец напоминания');

  // ── Телефон: экраны на весь экран, свободное время шторкой ───────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(600);
  const tabBar = page.getByRole('navigation', { name: 'Modules' });
  await planner.locator('[data-planner-search-open]').click();
  await search.locator('[data-planner-search-input]').fill('зале');
  await visible(ahead.locator('[data-key]'), 'поиск на телефоне');
  // Лента уходит после перерисовки раздела — ждём, а не проверяем мгновенно
  await tabBar.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('поиск закрывает ленту модулей'));
  await shot('plan-search-phone');
  await ahead.locator('[data-key]').first().click();
  // Карточка на телефоне — строки настроек, «Сохранить» в шапке вместо кнопки под формой (PhPlanMore)
  await visible(sidePane.locator('[data-side-save]').filter({ hasText: 'Save' }), '«Сохранить» в шапке карточки');
  assert.equal(await sidePane.getByRole('button', { name: 'Save', exact: true }).count(), 1, 'одна «Сохранить»');
  await shot('plan-editor-phone');
  // Строки настроек по доске: подпись «Повтор и напоминание», у выбора подпись слева и значение справа в одной строке
  await visible(sidePane.locator('[data-card-caption]'), 'подпись «Повтор и напоминание»');
  const remindRow = sidePane.locator('[data-card-row="remind"] .input-group');
  const remindLabel = await remindRow.locator('label').boundingBox();
  const remindValue = await remindRow.locator('select').boundingBox();
  const middleOf = (box) => box.y + box.height / 2;
  assert.ok(
    remindLabel.x < remindValue.x && Math.abs(middleOf(remindLabel) - middleOf(remindValue)) < 8,
    `«Напомнить» строкой: ${JSON.stringify({ remindLabel, remindValue })}`,
  );
  await sidePane.locator('[data-free-time-open]').click();
  const sheet = page.locator('.Modal [data-free-time]');
  await visible(sheet.locator('[data-free-slot]'), 'окна в шторке');
  await page.waitForTimeout(500);
  await shot('plan-freetime-phone');
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await sheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  // Карточка задачи на телефоне: «Статус» строкой, «Шаги · N» подписью, «Добавить шаг» — строка ввода
  await search.locator('[data-filter="all"]').click();
  await search.locator('[data-planner-search-input]').fill('кроссовки');
  await search.locator('[data-key]').filter({ hasText: 'Купить кроссовки' }).first().click();
  await visible(sidePane.locator('[data-card-row="status"] select'), 'статус задачи строкой');
  const stepsRow = sidePane.locator('[data-card-row="steps"]');
  await stepsRow.getByPlaceholder('Add step').fill('Взять форму');
  await stepsRow.getByPlaceholder('Add step').press('Enter');
  await visible(stepsRow.locator('label').filter({ hasText: 'Взять форму' }), 'шаг строкой');
  await visible(stepsRow.getByText('Steps · 0/1'), 'подпись «Шаги · N»');
  await shot('plan-task-phone');
  await closeSide();
  await search.getByRole('button', { name: 'Back' }).click();
  await planner.locator('[data-planner-tasks-open]').click();
  await tasks.getByRole('tab', { name: /^No date/ }).click();
  await visible(tasks.locator('[data-planner-groups]'), 'группы под задачами на телефоне');
  await shot('plan-tasks-phone');
  await tasks.getByRole('button', { name: 'Back' }).click();
  importScreen = await openImport();
  await importScreen.locator('[data-schedule-input]').fill('пн 10-11 созвон · вт 14-16 сервер · чт вечер ???');
  await visible(importScreen.locator('[data-import-problem]'), 'непонятое на телефоне');
  await shot('plan-import-phone');
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(pageWidth <= PHONE.width, `нет прокрутки вбок: ${pageWidth}`);
  await importScreen.getByRole('button', { name: 'Close' }).click();
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.setViewportSize(WIDE);
  await visible(page.locator('#FoldersSidebar'), 'панель модулей на компьютере');
  console.log('OK: телефон — поиск, задачи и расписание на весь экран, свободное время шторкой');

  // ── «Здоровье»: тренировка из «Плана» в «Активности» как запланированная ─
  const health = await openHealthModule(page);
  await health.locator('[data-health-first] [data-block="workouts"]').click();
  await health.locator('[data-health-first-done]').click();
  await health.locator('[data-health-card="workout"]').getByRole('button').first().click();
  const planned = health.locator('[data-health-detail="workout"] [data-health-workout-planned="strength"]');
  await visible(planned.filter({ hasText: 'planned for 21:00' }), 'запланированная тренировка');
  await shot('health-planned-wide');
  console.log('OK: «Здоровье» — тренировка «Плана» в активности как запланированная');

  assert.deepEqual(session.errors, [], `ошибки страницы: ${session.errors.join('; ')}`);
  console.log('e2e_web_planner_more: OK');
} catch (error) {
  if (session && SHOT_DIR) await session.page.screenshot({ path: `${SHOT_DIR}/planner-more-fail.png` }).catch(() => {});
  if (session) console.log(session.logs.slice(-40).join('\n'));
  throw error;
} finally {
  await browser.close();
}
