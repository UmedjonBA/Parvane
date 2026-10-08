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
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const sidebar = page.locator('#FoldersSidebar');
  const today = todayKey();
  const todayCell = planner.locator(`[data-day="${today}"]`);

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
    await planner.getByRole('button', { name: 'Create' }).click();
    await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await createTask('Подготовить макет', 90, '14:00');
  await todayCell.getByText('14:00 Подготовить макет').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayCell.innerText(), /1\.5 h/, 'загрузка дня — полтора часа');
  await planner.getByRole('button', { name: 'Undo' }).click();
  await todayCell.getByText('Подготовить макет').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await createTask('Подготовить макет', 90, '14:00');
  console.log('OK: задача создаётся, отменяется и создаётся снова');

  // Ошибка ввода: время без длительности
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill('Без оценки');
  await planner.getByLabel('Start', { exact: true }).fill('09:00');
  await planner.getByLabel('Duration, min').fill('');
  await planner.getByRole('button', { name: 'Create' }).click();
  await planner.getByRole('alert').getByText('needs a work date and a duration').waitFor({ timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Cancel' }).click();

  // ── Событие, пересекающееся с задачей ─────────────────────────────────────
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await planner.locator('select').first().selectOption('event');
  await page.locator('#planner-new-name').fill('Созвон команды');
  await planner.getByLabel('Start', { exact: true }).fill('14:30');
  await planner.getByLabel('End', { exact: true }).fill('15:00');
  await planner.getByRole('button', { name: 'Create' }).click();
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
  await planner.getByRole('button', { name: 'Create' }).click();
  await planner.getByRole('heading', { name: 'Вторая задача' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'To tasks' }).first().click();
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
  await planner.getByLabel('Day ends').fill('07:00');
  await planner.getByText('The day must end after it starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByLabel('Day ends').inputValue(), '21:00', 'негодное значение не применяется');
  await planner.getByRole('button', { name: 'Back', exact: true }).click();
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
    return planner.locator('aside');
  };
  const backToThisMonth = async () => {
    await planner.getByRole('button', { name: 'Today' }).click();
  };
  // Еженедельное событие по сегодняшнему дню недели — стоит и через неделю
  await planner.getByText('Calendar', { exact: true }).first().click();
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await planner.locator('select').first().selectOption('event');
  await page.locator('#planner-new-name').fill('Йога');
  await planner.getByLabel('Start', { exact: true }).fill('18:00');
  await planner.getByLabel('End', { exact: true }).fill('19:00');
  await repeatSelect().selectOption('weekly');
  // Чекбокс форка перехватывает клик своей подписью — кликаем по подписи
  await planner.getByText(weekdayShort, { exact: true }).click();
  await planner.getByRole('button', { name: 'Create' }).click();
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
  await planner.locator('select').first().selectOption('event');
  await page.locator('#planner-new-name').fill('Аренда');
  await planner.getByLabel('Start', { exact: true }).fill('12:00');
  await planner.getByLabel('End', { exact: true }).fill('12:30');
  await repeatSelect().selectOption('monthly');
  await planner.getByLabel('Day of month').fill('31');
  await planner.getByLabel('Starts on').fill(`${today.slice(0, 7)}-01`);
  await planner.getByRole('button', { name: 'Create' }).click();
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
  await planner.getByRole('button', { name: 'Create' }).click();
  await planner.getByRole('heading', { name: 'Зарядка' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'To the day' }).first().click();
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
  await planner.locator('form select').first().selectOption('single');
  await planner.getByLabel('Calories, kcal').fill('1500');
  await planner.getByLabel('Tolerance ±').first().fill('100');
  await planner.getByLabel('Water, ml').fill('2000');
  await planner.getByRole('button', { name: 'Save', exact: true }).click();
  await planner.getByText('Applies to the selected day').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Calendar', { exact: true }).first().click();
  await todayCell.click({ position: { x: 10, y: 10 } });
  await planner.getByText('Nutrition', { exact: true }).first().click();
  const metric = (name) => planner.locator(`[data-metric="${name}"]`);
  await metric('kcal').getByText('/ 1,500 kcal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await metric('fiber').getByText('No goal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('details > summary').first().click();
  // Числовые поля планировщика применяются по Enter или уходу фокуса
  await planner.getByLabel('Water for the day, ml').fill('1500');
  await planner.getByLabel('Water for the day, ml').press('Enter');
  await planner.getByText('Water updated').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Day is filled in', { exact: true }).click();
  await planner.getByText('Nutrition day completed').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await metric('water').getAttribute('data-status'), 'below', 'вода ниже цели дня');
  assert.equal(await metric('kcal').getAttribute('data-status'), 'below', '390 ккал ниже цели 1500');
  // Смена цели задним числом не переоценивает завершённый день (SC-005)
  await planner.getByText('Statistics', { exact: true }).first().click();
  await planner.getByText('Nutrition', { exact: true }).first().click();
  await planner.locator('button').filter({ hasText: 'Applies to the selected day' }).first().click();
  await planner.getByLabel('Calories, kcal').fill('400');
  await planner.getByRole('button', { name: 'Save', exact: true }).click();
  await planner.getByText('Nutrition goals updated').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Calendar', { exact: true }).first().click();
  await todayCell.click({ position: { x: 10, y: 10 } });
  await planner.getByText('Nutrition', { exact: true }).first().click();
  assert.equal(await metric('kcal').getAttribute('data-status'), 'below', 'оценка завершённого дня не изменилась');
  await metric('kcal').getByText('/ 1,500 kcal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Schedule', { exact: true }).first().click();
  console.log('OK: цель на день, статусы воды и клетчатки, завершённый день не переоценивается');

  // ── Данные переживают перезагрузку; возврат в мессенджер ──────────────────
  await page.waitForTimeout(1000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await isShown(page, '#LeftColumn'), true, 'после перезагрузки открыт мессенджер');
  await sidebar.getByRole('tab', { name: 'Planner' }).click();
  await todayCell.getByText('14:00 Подготовить макет').waitFor({ state: 'visible', timeout: 30000 });
  // Настройки тоже сохранены
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  assert.equal(await planner.getByLabel('Day starts').inputValue(), '08:00', 'начало дня после перезагрузки');
  await planner.getByRole('button', { name: 'Back', exact: true }).click();
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
