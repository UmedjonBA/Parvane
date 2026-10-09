// Боковая панель разделов и планировщик (spec 009). Панель видна всегда: без папок
// слева — только разделы «Чаты» и «План»; раздел «План» занимает место колонок
// мессенджера. Планировщик: задача, отмена, событие с пересечением, питание,
// статистика, сохранение после перезагрузки, вход с телефона из меню.
// Запуск: scripts/run_web_planner_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  relogin,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-planner-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 15000;

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function isShown(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return Boolean(el) && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  }, selector);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
let session;

try {
  const user = `planner-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  // Три колонки «Плана» рассчитаны на широкий экран (spec 013)
  await page.setViewportSize({ width: 1600, height: 900 });
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const sidebar = page.locator('#FoldersSidebar');
  const today = todayKey();
  const todayCell = planner.locator(`[role="gridcell"][data-day="${today}"]`);
  // Левая колонка (форма, редактор, настройки) и панель дня (spec 013)
  const sidePane = planner.locator('[data-planner-side]');
  const dayPane = planner.locator('[data-planner-day]');
  const closeSide = async () => {
    await sidePane.getByRole('button', { name: 'Close' }).first().click();
    await sidePane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };

  // ── Панель: видна без папок, в ней только разделы; меню — в шапке списка ──
  await sidebar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidebar.getByRole('tab').count(), 2, 'в панели должны быть два раздела');
  assert.equal(await sidebar.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected'), 'true');
  assert.equal(await sidebar.getByRole('button', { name: 'Open menu' }).count(), 0, 'без папок слева меню — не в панели');
  assert.ok(await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).count(), 'меню осталось в шапке');
  // Разделы прижаты к низу панели
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('#FoldersSidebar').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('#FoldersSidebar [role="tab"]')].map((el) => el.getBoundingClientRect());
    return { barBottom: bar.bottom, barTop: bar.top, lastBottom: tabs.at(-1).bottom, firstTop: tabs[0].top };
  });
  assert.ok(geometry.barBottom - geometry.lastBottom < 24, `разделы не у нижнего края: ${JSON.stringify(geometry)}`);
  assert.ok(
    geometry.firstTop > geometry.barTop + (geometry.barBottom - geometry.barTop) * 0.6,
    `разделы должны лежать в нижних 40% панели: ${JSON.stringify(geometry)}`,
  );
  console.log('OK: панель видна без папок, разделы в нижней части');

  // ── Раздел «План» вместо колонок мессенджера ──────────────────────────────
  await sidebar.getByRole('tab', { name: 'Planner' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), false, 'список чатов должен быть скрыт');
  assert.equal(await isShown(page, '#MiddleColumn'), false, 'переписка должна быть скрыта');
  assert.match(await todayCell.innerText(), /Free/, 'пустой день помечен «Свободно»');
  console.log('OK: «План» открыт, колонки мессенджера скрыты');

  // ── Задача: создание, отмена, повтор ──────────────────────────────────────
  async function createTask(name, minutes, start) {
    await planner.getByRole('button', { name: '+ Task', exact: true }).click();
    await page.locator('#planner-new-name').fill(name);
    await planner.getByLabel('Duration, min').fill(String(minutes));
    await planner.getByLabel('Start', { exact: true }).fill(start);
    await planner.getByRole('button', { name: 'Create', exact: true }).click();
    await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  // Форма открывается колонкой слева: календарь и панель дня остаются видны (spec 013, US1)
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await sidePane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const boxes = {
    side: await sidePane.boundingBox(), cell: await todayCell.boundingBox(), day: await dayPane.boundingBox(),
  };
  assert.ok(boxes.side && boxes.cell && boxes.day, `не все три колонки видны: ${JSON.stringify(boxes)}`);
  assert.ok(
    boxes.side.x + boxes.side.width <= boxes.cell.x + 1 && boxes.cell.x + boxes.cell.width <= boxes.day.x + 1,
    `колонки перекрываются: ${JSON.stringify(boxes)}`,
  );
  // Выбор дня в календаре меняет дату открытой формы
  const tomorrowKey = (() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  })();
  await planner.locator(`[role="gridcell"][data-day="${tomorrowKey}"]`).click({ position: { x: 10, y: 10 } });
  const expectFormDate = async (day, what) => {
    const field = sidePane.getByLabel('Work date');
    for (let attempt = 0; attempt < 15 && await field.inputValue() !== day; attempt++) await page.waitForTimeout(200);
    assert.equal(await field.inputValue(), day, what);
  };
  await expectFormDate(tomorrowKey, 'дата формы следует за выбранным днём');
  await todayCell.click({ position: { x: 10, y: 10 } });
  await expectFormDate(today, 'дата формы вернулась к сегодняшнему дню');
  await planner.getByRole('button', { name: 'Cancel' }).click();
  console.log('OK: форма слева, календарь и панель дня видны; дата формы следует за выбранным днём');

  await createTask('Подготовить макет', 90, '14:00');
  await todayCell.getByText('14:00 Подготовить макет').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayCell.innerText(), /1\.5 h/, 'загрузка дня — полтора часа');
  // Загрузка дня — только полоской: фон клетки не зависит от загрузки (spec 013, B9)
  const cellBackgrounds = await page.evaluate(([busy, free]) => [busy, free].map((day) => getComputedStyle(
    document.querySelector(`#ParvanePlanner [role="gridcell"][data-day="${day}"]`),
  ).backgroundColor), [today, tomorrowKey]);
  if (new Date().getDay() !== 5 && new Date().getDay() !== 0) {
    // Сегодня и завтра — оба будни либо оба выходные (кроме пятницы и воскресенья)
    assert.equal(cellBackgrounds[0], cellBackgrounds[1], 'клетка занятого дня залита иначе, чем свободного');
  }
  await planner.getByRole('button', { name: 'Undo' }).click();
  await todayCell.getByText('Подготовить макет').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await createTask('Подготовить макет', 90, '14:00');
  console.log('OK: задача создаётся, отменяется и создаётся снова');

  // Ошибка ввода: время без длительности
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill('Без оценки');
  await planner.getByLabel('Start', { exact: true }).fill('09:00');
  await planner.getByLabel('Duration, min').fill('');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('alert').getByText('needs a work date and a duration').waitFor({ timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Cancel' }).click();

  // ── Событие, пересекающееся с задачей ─────────────────────────────────────
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-kind').selectOption('event');
  await page.locator('#planner-new-name').fill('Созвон команды');
  await planner.getByLabel('Start', { exact: true }).fill('14:30');
  await planner.getByLabel('End', { exact: true }).fill('15:00');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Time conflict').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayCell.innerText(), /! 2 h/, 'в ячейке дня — отметка пересечения и 2 часа');
  // Свободные окна дня: до задачи и после события
  await planner.getByRole('button', { name: /free slot 09:00–14:00/ }).waitFor({ timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: /free slot 15:30–21:00/ }).waitFor({ timeout: STEP_TIMEOUT_MS });
  console.log('OK: событие, пересечение времени и свободные окна дня');

  // ── Питание и статистика ──────────────────────────────────────────────────
  await planner.getByText('Nutrition', { exact: true }).first().click();
  await planner.getByRole('button', { name: '+ Add entry' }).click();
  await page.locator('#planner-food-name').fill('Овсянка');
  await planner.getByLabel('Calories, kcal').fill('390');
  await planner.getByLabel('Protein, g').fill('20');
  await planner.getByRole('button', { name: 'Add', exact: true }).click();
  await planner.getByText('390 kcal').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('some entries have no macros').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Statistics', { exact: true }).first().click();
  await planner.getByRole('img', { name: 'Planned: 2 h' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Nutrition', { exact: true }).first().click();
  await planner.getByText('kcal logged').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: дневник питания и статистика времени и питания');

  // ── Задачи по спискам ─────────────────────────────────────────────────────
  await planner.getByText('Tasks', { exact: true }).first().click();
  await planner.getByLabel('New list').fill('Работа');
  await planner.getByRole('button', { name: 'Create list' }).click();
  await planner.getByRole('button', { name: 'Работа', exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'No list', exact: true }).click();
  await planner.getByText('Подготовить макет').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: списки задач');

  // ── Порядок в очереди стрелками (T014) ────────────────────────────────────
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill('Вторая задача');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Вторая задача' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  const queueNames = async () => planner.locator('section').first().locator('[data-task-id]').allInnerTexts();
  await planner.getByRole('button', { name: 'Move down: Вторая задача' }).waitFor({ timeout: STEP_TIMEOUT_MS });
  assert.match((await queueNames()).join('|'), /^Вторая задача.*\|Подготовить макет/s, 'новая задача — первой в очереди');
  assert.ok(await planner.getByRole('button', { name: 'Move up: Вторая задача' }).isDisabled(), 'у края стрелка вверх неактивна');
  await planner.getByRole('button', { name: 'Move down: Вторая задача' }).click();
  await planner.getByText('Order changed').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match((await queueNames()).join('|'), /^Подготовить макет.*\|Вторая задача/s, 'задача опустилась на строку ниже');
  console.log('OK: порядок задач в очереди');

  // ── Настройки дня (T014): начало дня и перерыв ────────────────────────────
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await planner.getByLabel('Day starts').fill('08:00');
  await planner.getByText('Settings saved').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Полоска уведомления уходит сама через 3 с (spec 012, A9)
  await planner.getByText('Settings saved').waitFor({ state: 'hidden', timeout: 5000 });
  await planner.getByLabel('Day ends').fill('07:00');
  await planner.getByText('The day must end after it starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByLabel('Day ends').inputValue(), '21:00', 'негодное значение не применяется');
  await planner.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await planner.getByText('Calendar', { exact: true }).first().click();
  await todayCell.click({ position: { x: 10, y: 10 } });
  // После шага питания у панели дня открыта вкладка «Питание»
  await planner.getByText('Schedule', { exact: true }).first().click();
  await planner.getByText(/free 08–21/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: /free slot 08:00–14:00/ }).waitFor({ timeout: STEP_TIMEOUT_MS });
  console.log('OK: настройки дня применяются к окнам');

  // ── Повторы (spec 011, US1) ───────────────────────────────────────────────
  const addDays = (key, delta) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d + delta);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const weekdayShort = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  const repeatSelect = () => planner.locator('[data-repeat-kind] select').first();
  const openDay = async (day) => {
    await planner.getByText('Calendar', { exact: true }).first().click();
    const cell = planner.locator(`[data-day="${day}"]`);
    if (!(await cell.count())) {
      // День в соседнем месяце — листаем вперёд
      await planner.getByRole('button', { name: 'Next month' }).click();
      await cell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    }
    await cell.click({ position: { x: 10, y: 10 } });
    await planner.getByText('Schedule', { exact: true }).first().click();
    return dayPane;
  };
  const backToThisMonth = async () => {
    await planner.getByRole('button', { name: 'Today' }).click();
  };
  // Еженедельное событие по сегодняшнему дню недели — стоит и через неделю
  await planner.getByText('Calendar', { exact: true }).first().click();
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-kind').selectOption('event');
  await page.locator('#planner-new-name').fill('Йога');
  // Конец не задаётся: по умолчанию — через час после начала (spec 013, B6)
  await planner.getByLabel('Start', { exact: true }).fill('18:00');
  const endField = planner.getByLabel('End', { exact: true });
  for (let attempt = 0; attempt < 15 && await endField.inputValue() !== '19:00'; attempt++) await page.waitForTimeout(200);
  assert.equal(await endField.inputValue(), '19:00', 'конец события по умолчанию');
  // У селектов есть подписи (B7)
  assert.ok(await sidePane.getByLabel('Repeat', { exact: true }).count(), 'у выбора повтора нет подписи');
  await repeatSelect().selectOption('weekly');
  // Чекбокс форка перехватывает клик своей подписью — кликаем по подписи
  await sidePane.getByText(weekdayShort, { exact: true }).click();
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Йога').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  let aside = await openDay(addDays(today, 7));
  await aside.getByText('18:00–19:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await aside.innerText(), /Йога/, 'еженедельное событие стоит через неделю');
  await backToThisMonth();
  aside = await openDay(addDays(today, 1));
  assert.doesNotMatch(await aside.innerText(), /Йога/, 'завтра еженедельного события нет');
  // Ежемесячно 31-го — в коротком месяце последний день
  const [year, month] = today.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const lastKey = `${today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-kind').selectOption('event');
  await page.locator('#planner-new-name').fill('Аренда');
  await planner.getByLabel('Start', { exact: true }).fill('12:00');
  await planner.getByLabel('End', { exact: true }).fill('12:30');
  await repeatSelect().selectOption('monthly');
  await planner.getByLabel('Day of month').fill('31');
  await planner.getByLabel('Starts on').fill(`${today.slice(0, 7)}-01`);
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Аренда').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(lastKey);
  assert.match(await aside.innerText(), /Аренда/, `ежемесячное событие 31-го стоит в последний день (${lastKey})`);
  console.log('OK: еженедельный и ежемесячный ряды событий');

  // Задача-ряд: выполнение одного экземпляра, «только это», «это и последующие».
  // Дата начала ряда берётся из выбранного дня — возвращаемся к сегодняшнему
  await backToThisMonth();
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill('Зарядка');
  await planner.getByLabel('Duration, min').fill('15');
  // Внутри окон дня (после шага настроек — с 08:00), иначе задача в панели дня не показывается
  await planner.getByLabel('Start', { exact: true }).fill('10:00');
  await repeatSelect().selectOption('daily');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Зарядка' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  aside = await openDay(today);
  await aside.getByLabel('Done: Зарядка').check();
  await planner.getByText('Зарядка · Done').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(addDays(today, 1));
  assert.equal(await aside.getByLabel('Done: Зарядка').isChecked(), false, 'завтрашний экземпляр не выполнен');
  // «Только это»: время завтрашнего экземпляра
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('10:30');
  await planner.getByRole('button', { name: 'Only this' }).click();
  await planner.getByText('Detached from a series').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(addDays(today, 1));
  await aside.getByText('10:30–10:45').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await aside.getByRole('button', { name: /Зарядка/ }).count(), 1, 'отделённый экземпляр — один');
  aside = await openDay(today);
  await aside.getByText('10:00–10:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Это и последующие»: с послезавтра — 09:00
  aside = await openDay(addDays(today, 2));
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('11:00');
  await planner.getByRole('button', { name: 'This and following' }).click();
  aside = await openDay(addDays(today, 3));
  await aside.getByText('11:00–11:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(today);
  await aside.getByText('10:00–10:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToThisMonth();
  // В списке задач ряд — одной строкой с пометкой повтора
  await planner.getByText('Tasks', { exact: true }).first().click();
  await planner.getByRole('button', { name: 'No list', exact: true }).click();
  const seriesRows = planner.locator('[data-task-id]').filter({ hasText: 'Зарядка' }).filter({ hasText: 'repeats' });
  await seriesRows.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await seriesRows.count(), 1, 'задача-ряд в списке — одной строкой');
  console.log('OK: задача-ряд — выполнение по дню, «только это», «это и последующие», одна строка в списке');

  // ── Цели питания по датам (spec 011, US2) ─────────────────────────────────
  await planner.getByText('Statistics', { exact: true }).first().click();
  await planner.getByText('Nutrition', { exact: true }).first().click();
  await planner.getByRole('button', { name: '+ Goal for a day or a period' }).click();
  await planner.getByLabel('From').fill(today);
  await page.locator('#planner-goal-end').selectOption('single');
  await planner.getByLabel('Calories, kcal').fill('1500');
  await planner.getByLabel('Tolerance ±').first().fill('100');
  await planner.getByLabel('Water, ml').fill('2000');
  await planner.getByRole('button', { name: 'Save', exact: true }).click();
  await planner.getByText('Applies to the selected day').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Calendar', { exact: true }).first().click();
  await todayCell.click({ position: { x: 10, y: 10 } });
  await planner.getByText('Nutrition', { exact: true }).first().click();
  const metric = (name) => planner.locator(`[data-metric="${name}"]`);
  // Статус показателя обновляется после прихода правки в экран — ждём, а не читаем сразу
  const expectStatus = async (name, status, what) => {
    for (let attempt = 0; attempt < 25 && await metric(name).getAttribute('data-status') !== status; attempt++) {
      await page.waitForTimeout(200);
    }
    assert.equal(await metric(name).getAttribute('data-status'), status, what);
  };
  await metric('kcal').getByText('/ 1,500 kcal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await metric('fiber').getByText('No goal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('details > summary').first().click();
  // Числовые поля планировщика применяются по Enter или уходу фокуса
  await planner.getByLabel('Water for the day, ml').fill('1500');
  await planner.getByLabel('Water for the day, ml').press('Enter');
  await planner.getByText('Water updated').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Кнопки завершения дня нет: сегодняшний день открыт, прошедший завершён сам (spec 013, B10)
  assert.equal(await planner.getByText('Day is filled in').count(), 0, 'кнопка «День заполнен» должна исчезнуть');
  await expectStatus('water', 'open', 'сегодняшний день ещё открыт');
  const yesterdayKey = addDays(today, -1);
  await page.evaluate(async (day) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ nutritionDay: { day, entries: [{ id: `food-${day}`, name: 'Обед', meal: 'lunch', kcal: 2000 }] } }],
    });
  }, yesterdayKey);
  const openFoodDay = async (day) => {
    await planner.getByText('Calendar', { exact: true }).first().click();
    await planner.locator(`[role="gridcell"][data-day="${day}"]`).click({ position: { x: 10, y: 10 } });
    await planner.getByText('Nutrition', { exact: true }).first().click();
  };
  await openFoodDay(yesterdayKey);
  await metric('kcal').getByText('/ 2,000 kcal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectStatus('kcal', 'ok', 'вчерашний день завершён и в норме');
  // Смена цели по умолчанию не переоценивает прошедший день (SC-005)
  await planner.getByText('Statistics', { exact: true }).first().click();
  await planner.getByText('Nutrition', { exact: true }).first().click();
  await planner.locator('button').filter({ hasText: 'Default goals' }).first().click();
  await planner.getByLabel('Calories, kcal').fill('1000');
  await planner.getByRole('button', { name: 'Save', exact: true }).click();
  await planner.getByText('Nutrition goals updated').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await openFoodDay(yesterdayKey);
  await metric('kcal').getByText('/ 2,000 kcal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectStatus('kcal', 'ok', 'оценка прошедшего дня не изменилась');
  await planner.getByRole('button', { name: 'Today' }).click();
  await planner.getByText('Schedule', { exact: true }).first().click();
  console.log('OK: цель на день, прошедший день завершён сам и не переоценивается при смене цели');

  // ── Виды календаря и выбор месяца и года (spec 013, US2) ──────────────────
  const viewButton = (name) => planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name, exact: true });
  const main = planner.locator('[data-planner-view]');
  await viewButton('Week').click();
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const weekColumn = planner.locator(`[data-planner-view="week"] div[data-day="${today}"]`).last();
  await weekColumn.getByText('Подготовить макет').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Пересекающиеся задача (14:00–15:30) и событие (14:30–15:00) стоят рядом, а не друг на друге
  const blocks = await weekColumn.locator('button[data-kind]').evaluateAll((items) => items
    .filter((el) => /Подготовить макет|Созвон команды/.test(el.textContent))
    .map((el) => el.getBoundingClientRect().left));
  assert.equal(blocks.length, 2, 'в неделе должны быть видны и задача, и событие');
  assert.ok(Math.abs(blocks[0] - blocks[1]) > 10, `пересекающиеся дела наложены: ${blocks}`);
  await viewButton('Day').click();
  await planner.locator('[data-planner-view="day"]').getByText('Созвон команды').waitFor({ timeout: STEP_TIMEOUT_MS });
  await viewButton('Agenda').click();
  const agenda = planner.locator('[data-planner-view="agenda"]');
  await agenda.getByText('Йога').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.ok(await agenda.locator('section[data-day]').count() >= 2, 'расписание показывает дела по дням');
  await viewButton('Year').click();
  const yearView = planner.locator('[data-planner-view="year"]');
  await yearView.locator('section[data-month]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await yearView.locator('section[data-month]').count(), 12, 'в году двенадцать месяцев');
  // Нажатие на день года открывает месяц этого дня
  const januaryDay = `${today.slice(0, 4)}-01-15`;
  await yearView.locator(`button[data-day="${januaryDay}"]`).click();
  await planner.locator(`[role="gridcell"][data-day="${januaryDay}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Дни соседних месяцев показаны: сетка января начинается с понедельника, и это может быть декабрь
  const gridDays = await planner.locator('[role="gridcell"]').evaluateAll((cells) => cells.map((cell) => cell.dataset.day));
  assert.equal(gridDays.length % 7, 0, 'сетка месяца — полными неделями');
  assert.ok(gridDays.some((day) => !day.startsWith(januaryDay.slice(0, 7))), 'нет дней соседних месяцев');
  // Заголовок периода — выбор месяца и года
  await planner.locator('button[aria-haspopup="dialog"]').click();
  const picker = planner.getByRole('dialog', { name: 'Choose month and year' });
  await picker.getByRole('button', { name: 'Next year' }).click();
  await picker.locator('button[data-month="2"]').click();
  const nextMarch = `${Number(today.slice(0, 4)) + 1}-03-15`;
  await planner.locator(`[role="gridcell"][data-day="${nextMarch}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Today' }).click();
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Вид — настройка устройства: переживает перезагрузку (проверяется ниже)
  await viewButton('Week').click();
  await main.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: виды год, неделя, день, расписание; соседние дни; выбор месяца и года');

  // ── Событие на весь день и праздник; список с цветом из формы (US3, US4) ──
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await viewButton('Month').click();
  const loadBefore = (await todayCell.innerText()).match(/[\d.]+ h/)?.[0];
  await page.locator('#planner-new-kind').selectOption('event');
  await page.locator('#planner-new-name').fill('День города');
  await sidePane.getByText('All day', { exact: true }).click();
  await sidePane.getByText('Holiday', { exact: true }).click();
  await sidePane.getByLabel('Start', { exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: День города').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Schedule', { exact: true }).first().click();
  await dayPane.locator('[data-all-day]').getByText('День города').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await dayPane.locator('[data-all-day]').innerText(), /Holiday/, 'праздник отмечен в панели дня');
  assert.equal((await todayCell.innerText()).match(/[\d.]+ h/)?.[0], loadBefore, 'событие на весь день не входит в загрузку дня');
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill('Цветная задача');
  await page.locator('#planner-new-list').selectOption({ label: 'Create a list…' });
  await sidePane.getByLabel('New list').fill('Дом');
  await sidePane.getByRole('radio', { name: 'Color 3' }).click();
  await sidePane.getByRole('button', { name: 'Create list' }).click();
  await page.locator('#planner-new-list').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#planner-new-list')?.value === 'Дом', undefined, { timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#planner-new-list option').filter({ hasText: 'No list' }).count(), 1, '«Без списка» — один');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Цветная задача' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  const colorRow = dayPane.locator('[data-task-id]').filter({ hasText: 'Цветная задача' });
  await colorRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.notEqual(await colorRow.evaluate((el) => getComputedStyle(el).boxShadow), 'none', 'у задачи списка с цветом нет полоски');
  // Статусов три
  assert.deepEqual(
    await (async () => {
      await colorRow.getByRole('button', { name: /Цветная задача/ }).first().click();
      await page.locator('#planner-task-status').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      const options = await page.locator('#planner-task-status option').allInnerTexts();
      await closeSide();
      return options;
    })(),
    ['Queue', 'In progress', 'Done'], 'статусов задачи должно быть три',
  );
  await viewButton('Week').click();
  console.log('OK: событие на весь день и праздник, список с цветом из формы, три статуса');

  // ── Данные переживают перезагрузку; возврат в мессенджер ──────────────────
  await page.waitForTimeout(1000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await isShown(page, '#LeftColumn'), true, 'после перезагрузки открыт мессенджер');
  await sidebar.getByRole('tab', { name: 'Planner' }).click();
  // Вид «Неделя» запомнен устройством
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: 30000 });
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Month', exact: true }).click();
  await todayCell.getByText('14:00 Подготовить макет').waitFor({ state: 'visible', timeout: 30000 });
  // Настройки тоже сохранены
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  assert.equal(await planner.getByLabel('Day starts').inputValue(), '08:00', 'начало дня после перезагрузки');
  await planner.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await sidebar.getByRole('tab', { name: 'Chats' }).click();
  await planner.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), true, 'список чатов вернулся');
  console.log('OK: данные планировщика пережили перезагрузку, мессенджер возвращается');

  // ── Телефон: панели нет, вход в «План» из меню, возврат стрелкой ──────────
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  assert.equal(await isShown(page, '#FoldersSidebar'), false, 'на телефоне панели нет');
  await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Planner' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  await planner.getByRole('button', { name: 'Chats' }).click();
  await planner.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — вход из меню и возврат');

  console.log('e2e_web_planner: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${dir}/planner-failure.png` }).catch(() => {});
    console.log(`--- планировщик при сбое ---\n${await page?.locator('#ParvanePlanner').innerText().catch(() => '')}`);
    const attrs = await page?.evaluate(() => {
      const el = document.querySelector('#ParvanePlanner');
      return el ? `sync=${el.getAttribute('data-sync-status')} loaded=${el.getAttribute('data-loaded')}` : 'нет планировщика';
    }).catch(() => '');
    console.log(`--- атрибуты: ${attrs}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
