// «План»: экраны по доскам spec 041 E1 — «Расписание на неделю» (текст → повторяющиеся события, непонятое красным),
// поиск по плану с чипами, «Найти свободное время» в карточке записи, «Задачи» (по срокам, без даты, группы) и
// запланированная тренировка в «Активности» «Здоровья»; колонка разделов, задача на шкалу дня, меню записи по правой
// кнопке, образец напоминания и карточка записи строками на телефоне. Разбор, подбор окон и поиск — в движке (PLANNER-2).
// Компьютер и телефон, снимки — в PARVANE_E2E_SHOT_DIR. Запуск: scripts/run_web_planner_more_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closePlannerSettings, dismissRecoveryKeyDialog, openHealthModule, openPlannerHeader, openPlannerScreen, openPlannerSettings, preparePage,
} from './e2e_web_helpers.mjs';

// Выключатель перерисовывается от сигнала либо сохранения — не в тот же кадр, что нажатие
async function expectChecked(locator, value, what) {
  for (let attempt = 0; attempt < 50 && await locator.getAttribute('aria-checked') !== value; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  assert.equal(await locator.getAttribute('aria-checked'), value, what);
}


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
  // Компьютер: «Расписание на неделю» — пункт колонки разделов экрана «Задачи» (DkPlanMore); телефон — из настроек
  const openImport = async () => {
    if ((page.viewportSize()?.width || 0) > 925) {
      await planner.locator('[data-planner-tasks-open]').click();
      await planner.locator('[data-planner-sections] [data-section="import"]').click();
    } else {
      // Телефон: строка «Расписание на неделю» на странице «Модули / План»
      const settingsPage = await openPlannerSettings(page);
      await settingsPage.locator('[data-schedule-open]').click();
    }
    await visible(planner.locator('[data-planner-import]'), 'экран «Расписание на неделю»');
    return planner.locator('[data-planner-import]');
  };

  // ── Расписание на неделю: одна строка через точки, непонятое красным ─────
  await openPlannerScreen(page, 'calendar');
  let importScreen = await openImport();
  await importScreen.locator('[data-schedule-input]').fill('пн 10-11 созвон · ср 18:30 зал · чт вечер ???');
  // XdPlan: «Понято: 2 события», строки «пн | 10:00–11:00 | Созвон», непонятое — на своём месте, подсказка называет его
  await visible(importScreen.locator('[data-import-summary]').filter({ hasText: /^Understood: 2 events$/ }), 'итог разбора');
  assert.equal(await importScreen.locator('[data-import-item]').count(), 2, 'два события поняты');
  await visible(importScreen.locator('[data-import-item]').filter({ hasText: 'no end time — 1 hour assumed' }), 'подставленный час');
  await visible(importScreen.locator('[data-import-problem]').filter({ hasText: 'вечер ???' }), 'непонятая строка');
  const firstRow = await importScreen.locator('[data-import-item]').first().innerText();
  assert.ok(/^mon/i.test(firstRow) && firstRow.includes('10:00–11:00') && firstRow.includes('Созвон'),
    `строка разбора — день, время, название: ${firstRow}`);
  assert.ok(await importScreen.locator('[data-import-item], [data-import-problem]').last()
    .evaluate((el) => el.hasAttribute('data-import-problem')), 'непонятое — на своём месте в порядке текста');
  await visible(importScreen.locator('[data-import-hint]').filter({ hasText: 'Line «чт вечер ???» is not understood' }),
    'подсказка называет непонятую строку');
  assert.equal(await importScreen.locator('#planner-schedule-list').count(), 0, 'у расписания нет группы');
  assert.equal(await importScreen.getByRole('button', { name: 'Close' }).count(), 0, 'на компьютере нет «×»');
  assert.equal(await planner.locator('[data-planner-sections]').count(), 0, 'у расписания нет колонки разделов');
  await visible(importScreen.getByRole('button', { name: 'Add 2 events' }), 'кнопка с числом событий');
  await importScreen.locator('[data-until="month"]').click();
  await visible(importScreen.locator('[data-import-summary]').filter({ hasText: 'Understood: 2 events · until' }), 'срок — конец месяца');
  await shot('plan-import-wide');
  await importScreen.locator('[data-schedule-input]').fill(WEEK);
  await importScreen.locator('[data-until="none"]').click();
  await visible(importScreen.getByRole('button', { name: 'Add 7 events' }), 'неделя тренировок');
  assert.equal(await importScreen.locator('[data-import-problem]').count(), 0, 'всё понято');
  await importScreen.locator('[data-schedule-add]').click();
  await visible(planner.getByText('Schedule added: 7'), 'уведомление о добавлении');
  await importScreen.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: расписание текстом — разбор движком, непонятое красным, срок, добавление');

  // ── Поиск (ZdPlanX): колонка «Слои / Что показывать», «Впереди» по ряду одной строкой, стрелки и Enter ──
  await planner.locator('[data-planner-search-open]').click();
  const search = planner.locator('[data-planner-search]');
  await search.locator('[data-planner-search-input]').fill('зале');
  const ahead = search.locator('[data-search-section="ahead"]');
  await visible(ahead.getByText('Ahead', { exact: true }), 'впереди — без числа (число — в «найдено»)');
  assert.equal(await ahead.locator('[data-key]').count(), 7, 'ряд — одной строкой');
  // «Найдено» — впереди и прошедшее вместе: вечером сегодняшнее занятие ряда уже прошло и стоит в «Прошедшем»
  const pastCount = await search.locator('[data-search-section="past"] [data-key]').count();
  await visible(search.locator('[data-search-found]').filter({ hasText: new RegExp(`^found ${7 + pastCount}$`) }),
    `«найдено ${7 + pastCount}»`);
  await visible(ahead.locator('[data-result-meta]').filter({ hasText: /every / }), 'середина строки — группа и повтор');
  assert.equal(await search.getByRole('button', { name: 'Back' }).count(), 0, 'на компьютере нет «назад»');
  const showEvents = search.locator('[data-planner-layers="search"] [data-show="events"]');
  await showEvents.click();
  await visible(search.locator('[data-search-none]'), 'без событий тренировок нет');
  await showEvents.click();
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
  // DkPlanMore: подпись окна — «запас N мин» либо «перед работой», подсказка — «Окна в ближайшие 7 дней…»
  assert.match(slotLabel, /spare|before work/, `подпись окна по доске: ${slotLabel}`);
  await visible(freeTime.getByText('Slots in the next 7 days within the day budget.', { exact: true }), 'подсказка окон');
  await shot('plan-freetime-wide');
  await slot.getByRole('button', { name: 'Pick' }).click();
  await page.waitForFunction((time) => [...document.querySelectorAll('[data-planner-side] input[type="time"]')]
    .some((input) => input.value === time), startTime, { timeout: STEP_TIMEOUT_MS });
  // Событие ряда правится по месту: выбор окна сразу спрашивает объём (XpPlan) — «Отмена» возвращает поля
  const editPrompt = sidePane.locator('[data-series-prompt="edit"]');
  await visible(editPrompt.getByRole('button', { name: /^Only this · / }), '«Только это · <день>»');
  await visible(editPrompt.locator('[data-series-scope="stop"]'), '«Не повторять с этого дня»');
  await editPrompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await editPrompt.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: свободное время — окна движка, часть дня, выбор окна ставит время в форму');

  // ── Задачи: без даты, «На сегодня», по срокам, группы ────────────────────
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill('Купить кроссовки');
  await page.locator('#planner-quick-input').press('Enter');
  await visible(planner.getByText('Added: Купить кроссовки'), 'задача без даты');
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill('Заказать ракетку');
  await page.locator('#planner-quick-input').press('Enter');
  await visible(planner.getByText('Added: Заказать ракетку'), 'вторая задача без даты');
  await planner.locator('[data-planner-tasks-open]').click();
  const tasks = planner.locator('[data-planner-tasks]');
  await visible(tasks.locator('[data-planner-undated]').getByText('Купить кроссовки'), 'задача в «Без даты»');
  // DkPlanMore: на компьютере вкладок нет (раздел — в колонке), заголовок — раздел с числом; строка — «без оценки»
  assert.equal(await tasks.getByRole('tab').count(), 0, 'вкладок нет при колонке разделов');
  await visible(tasks.locator('[data-tasks-title]').filter({ hasText: 'No date · 2' }), 'заголовок «Без даты · 2»');
  await visible(tasks.locator('[data-planner-undated] [data-row-caption]').filter({ hasText: /^no estimate$/ }),
    'подпись «без оценки»');
  // «Выбрать день»: день по календарю, задача уходит из «Без даты»
  // «Выбрать день» — у второй задачи (первую дальше ставят «На сегодня»); порядок строк без даты — по рангу
  await tasks.locator('[data-planner-undated] [data-task-id]').filter({ hasText: 'Заказать ракетку' })
    .locator('[data-pick-day]').click();
  await page.getByRole('button', { name: 'Set the day' }).click();
  await visible(planner.getByText('Moved to'), '«Выбрать день» поставил задачу на день');
  await visible(tasks.locator('[data-tasks-title]').filter({ hasText: 'No date · 1' }), 'в «Без даты» одна задача');
  await visible(tasks.locator('aside [data-planner-groups]'), 'группы справа на компьютере');
  // Окно календаря «Выбрать день» закрывается анимацией и держит фокус: ввод в поле группы — после него
  await page.getByRole('button', { name: 'Set the day' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const groupName = tasks.locator('aside [data-group-editor] input');
  await groupName.fill('Спорт');
  assert.equal(await groupName.inputValue(), 'Спорт', 'название новой группы набрано');
  await tasks.locator('aside [data-group-editor]').getByRole('radio').nth(3).click();
  await tasks.locator('aside [data-group-editor]').getByRole('button', { name: 'Create' }).click();
  await visible(tasks.locator('aside [data-group="Спорт"]'), 'новая группа');
  await shot('plan-tasks-wide');
  await tasks.getByRole('button', { name: /^Schedule Купить кроссовки for / }).click();
  await visible(planner.getByText('Moved to'), 'задача назначена на сегодня');
  await planner.locator('[data-planner-sections] [data-section="deadlines"]').click();
  await visible(tasks.locator('[data-tasks-empty]'), 'задач со сроком нет');
  await planner.locator('[data-planner-sections] [data-section="groups"]').click();
  await visible(tasks.locator('[data-group="Спорт"]'), 'раздел групп');
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
  // «Расписание» на компьютере — без колонки разделов (доска `XdPlan`); закрывает «Отмена»
  await sections.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-planner-import]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await planner.locator('[data-planner-import]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await openPlannerScreen(page, 'today');
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
  for (const name of ['Open', 'Mark as done', 'Move to tomorrow', 'Find free time…', 'Duplicate', 'Change layer',
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
  // «Сменить слой ›» — вложенное меню справа, первое остаётся открытым
  await visible(menuItem('Спорт'), 'вложенное меню слоёв');
  await visible(menuItem('Open'), 'первое меню остаётся открытым');
  await menuItem('Спорт').click();
  await visible(planner.getByText('Силовая в зале · Спорт'), 'слой ряда сменён');
  // Клавиши меню: пробел отмечает задачу, Del удаляет, «Отменить» в уведомлении возвращает
  const copyBlock = column.locator('button[data-kind="task"]').filter({ hasText: 'Купить кроссовки' }).first();
  await copyBlock.click({ button: 'right' });
  await visible(menuItem('Open'), 'меню задачи');
  await page.keyboard.press(' ');
  await visible(planner.getByText('Купить кроссовки · Done'), 'пробел — «Отметить выполненной»');
  await copyBlock.click({ button: 'right' });
  await visible(menuItem('Open'), 'меню задачи');
  await page.keyboard.press('Delete');
  await copyBlock.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Undo' }).click();
  await visible(copyBlock, '«Отменить» вернул удалённую задачу');
  // Слой-группа выключен в колонке поиска — ряд группы «Спорт» в выдачу не попадает (ZdPlanX)
  await planner.locator('[data-planner-search-open]').click();
  await search.locator('[data-planner-search-input]').fill('Силовая');
  // Вечером сегодняшнее занятие ряда уже прошло и считается отдельно («Прошедшее»): число — семь либо восемь
  await visible(search.locator('[data-search-found]').filter({ hasText: /^found [78]$/ }), 'семь рядов найдено');
  const sportLayer = search.locator('[data-planner-layers="search"] [data-layer-group="Спорт"]');
  await sportLayer.click();
  await visible(search.locator('[data-search-found]').filter({ hasText: /^found [67] · in layers that are on$/ }),
    'ряд выключенного слоя «Спорт» в выдачу не попадает');
  await visible(search.locator('[data-search-hint]').filter({ hasText: 'The «Спорт» layer is off on the left' }),
    'подсказка называет выключенный слой');
  await sportLayer.click();
  await visible(search.locator('[data-search-found]').filter({ hasText: /^found [78]$/ }), 'слой включён — ряд снова найден');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Слои календаря вида «День» — колонка слева (ZdPlanX): «Задачи» прячет задачу шкалы, событие остаётся
  const tasksLayer = planner.locator('[data-planner-layers="day"] [data-layer="tasks"]');
  await expectChecked(tasksLayer, 'true', 'слой «Задачи» включён');
  await tasksLayer.click();
  await copyBlock.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await visible(gym, 'событие при выключенных задачах осталось');
  await tasksLayer.click();
  await visible(copyBlock, 'слой «Задачи» включён — задача снова на шкале');
  await column.click({ button: 'right', position: { x: 10, y: 5 } });
  await visible(menu.getByRole('menuitem', { name: /^New entry at \d\d:\d\d$/ }), 'меню пустого места шкалы');
  await menuItem('Find free time…').click();
  await visible(page.locator('.Modal [data-free-time] [data-free-slot]'), 'окна для новой записи');
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  console.log('OK: колонка разделов, задача на шкалу, меню записи и пустого места шкалы');

  // ── Телефон: экраны на весь экран, свободное время шторкой ───────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(600);
  const tabBar = page.getByRole('navigation', { name: 'Modules' });
  // Образец напоминания — сверху страницы настроек на телефоне (доска `RpPlan`)
  await visible((await openPlannerSettings(page)).locator('[data-reminder-sample]'), 'образец напоминания в настройках');
  await closePlannerSettings(page);
  await openPlannerHeader(page, 'search');
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
  // Правка времени дня ряда на телефоне — шторка выбора объёма (XpPlan): заголовок, пояснение, «Только это · <день>»
  const phoneStart = sidePane.getByLabel('Start', { exact: true });
  const startBefore = await phoneStart.inputValue();
  await phoneStart.fill('19:00');
  const seriesSheet = page.locator('.Modal [data-series-prompt="edit"]');
  await visible(seriesSheet.getByRole('button', { name: /^Only this · / }), 'шторка «Только это · <день>»');
  await visible(page.locator('.Modal').getByText('Change a repeating entry'), 'заголовок шторки');
  assert.match(await seriesSheet.locator('[data-series-ask]').innerText(), /What should the new time 19:00 apply to\?/);
  await shot('plan-series-phone');
  await seriesSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await seriesSheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await phoneStart.inputValue(), startBefore, '«Отмена» возвращает время');
  await visible(sidePane.getByRole('button', { name: 'Delete entry' }), '«Удалить запись» на телефоне');
  await sidePane.locator('[data-free-time-open]').click();
  const sheet = page.locator('.Modal [data-free-time]');
  await visible(sheet.locator('[data-free-slot]'), 'окна в шторке');
  await page.waitForTimeout(500);
  await shot('plan-freetime-phone');
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await sheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Шаги у события (PhPlanMore): Enter добавляет шаг, а не сохраняет карточку; отметка — сразу, у дня ряда — по дню
  const eventSteps = sidePane.locator('[data-card-row="steps"]');
  await eventSteps.getByPlaceholder('Add step').fill('Собрать сумку');
  await eventSteps.getByPlaceholder('Add step').press('Enter');
  const eventStep = eventSteps.locator('label').filter({ hasText: 'Собрать сумку' });
  await visible(eventStep, 'шаг события');
  await visible(eventSteps.getByText('Steps · 0/1'), 'подпись шагов события');
  await visible(sidePane.locator('[data-side-save]'), 'карточка события открыта после Enter в шаге');
  await eventStep.getByText('Собрать сумку').click();
  await visible(eventSteps.getByText('Steps · 1/1'), 'шаг события отмечен');
  await shot('plan-event-steps-phone');
  await closeSide();
  await ahead.locator('[data-key]').first().click();
  await visible(sidePane.locator('[data-card-row="steps"]').getByText('Steps · 1/1'), 'шаги события после повторного открытия');
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
  // Окон нет: задача длиннее бюджета дня — «В ближайшие 7 дней подходящих окон нет» и «Искать дальше» (ZpPlanX)
  // Задача стоит на шкале (перетаскивание выше): 13 ч от её начала ушли бы за полночь — время снимается
  await sidePane.getByLabel('Start', { exact: true }).fill('');
  await visible(planner.getByText('Time updated: Купить кроссовки'), 'время задачи снято');
  const taskDuration = sidePane.getByLabel('Duration', { exact: true });
  await taskDuration.fill('13 h');
  await taskDuration.press('Enter');
  await visible(planner.getByText('Estimate updated: Купить кроссовки'), 'длительность строкой');
  await sidePane.locator('[data-free-time-open]').click();
  const noneSheet = page.locator('.Modal [data-free-time]');
  await visible(noneSheet.locator('[data-free-none]').filter({ hasText: 'No suitable slots in the next 7 days' }), 'окон нет');
  await noneSheet.locator('[data-free-further]').click();
  await visible(noneSheet.locator('[data-free-none]').filter({ hasText: 'No suitable slots in the next 14 days' }), 'искать дальше');
  await page.locator('.Modal').getByRole('button', { name: 'Close' }).click();
  await noneSheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  await search.getByRole('button', { name: 'Back' }).click();
  await openPlannerHeader(page, 'tasks');
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
