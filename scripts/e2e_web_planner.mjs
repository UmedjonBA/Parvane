// Боковая панель разделов и планировщик (spec 009). Панель видна всегда: без папок
// слева — только разделы «Чаты» и «План»; раздел «План» занимает место колонок
// мессенджера. Планировщик: задача, отмена, событие с пересечением,
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
  await planner.getByText('Added: Созвон команды').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayCell.innerText(), /! 2 h/, 'в ячейке дня — отметка пересечения и 2 часа');
  // Панель дня — сетка по часам; пересекающиеся дела не закрывают названия друг друга
  const dayGrid = dayPane.locator('[data-day-grid]');
  const gridColumn = dayGrid.locator(`div[data-day="${today}"]`).last();
  const cascade = await gridColumn.locator('[data-block]').evaluateAll((items) => items.map((el) => {
    const box = el.getBoundingClientRect();
    return { text: el.textContent, left: box.left, right: box.right, z: Number(getComputedStyle(el).zIndex) };
  }));
  assert.equal(cascade.length, 2, `в сетке дня должны быть задача и событие: ${JSON.stringify(cascade)}`);
  const [lower, upper] = cascade[0].z < cascade[1].z ? cascade : [cascade[1], cascade[0]];
  // Начинаются с разницей в полчаса — стоят рядом, названия обоих видны целиком
  assert.ok(upper.left - lower.left > 10, `второе дело должно быть сдвинуто вправо: ${JSON.stringify(cascade)}`);
  assert.ok(upper.left >= lower.right - 1, `дела с близким началом должны стоять рядом: ${JSON.stringify(cascade)}`);
  assert.match(lower.text, /14:00–15:30/, 'в блоке — время дела');
  // Вкладок «День» и «Расписание» нет: день всегда в панели справа
  const viewGroup = planner.getByRole('group', { name: 'Calendar view' });
  assert.deepEqual(await viewGroup.getByRole('button').allInnerTexts(), ['Year', 'Month', 'Week'], 'виды календаря');
  // «+» рядом с днём открывает форму на этот день; надписи «+ Задача на этот день» нет
  assert.equal(await dayPane.getByText('+ Task for this day').count(), 0, 'лишняя надпись в панели дня');
  await dayPane.getByRole('button', { name: '+ Task for this day' }).click();
  assert.equal(await sidePane.getByLabel('Work date').inputValue(), today, '«+» создаёт дело на выбранный день');
  await planner.getByRole('button', { name: 'Cancel' }).click();
  // Нажатие на свободное время в сетке: форма с этим временем; пересекаться с другими делами можно
  await gridColumn.click({ position: { x: 20, y: 6 } });
  assert.equal(await sidePane.getByLabel('Start', { exact: true }).inputValue(), '09:00', 'начало — по месту нажатия');
  assert.equal(await sidePane.getByLabel('Duration, min').inputValue(), '30', 'длительность по умолчанию — полчаса');
  await page.locator('#planner-new-name').fill('Внахлёст');
  await sidePane.getByLabel('Start', { exact: true }).fill('14:10');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Внахлёст').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByRole('alert').count(), 0, 'пересечение не должно быть ошибкой');
  assert.equal(await gridColumn.locator('[data-block]').count(), 3, 'третье дело встало внахлёст');
  // Дело, начавшееся заметно позже (через час), ложится поверх раннего со сдвигом: раннее идёт до
  // правого края, позднее начинается правее и ниже его названия
  await page.evaluate(async (day) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [
        {
          task: {
            id: 'layer-long', name: 'Долгое', description: '', steps: [], status: 'queue', listId: '', rank: 50,
            day, start: '17:00', due: '', minutes: 180,
          },
        },
        {
          task: {
            id: 'layer-late', name: 'Позднее', description: '', steps: [], status: 'queue', listId: '', rank: 51,
            day, start: '18:00', due: '', minutes: 60,
          },
        },
      ],
    });
  }, today);
  const layered = async () => gridColumn.locator('[data-block]').evaluateAll((items) => items
    .filter((el) => /Долгое|Позднее/.test(el.textContent))
    .map((el) => {
      const box = el.getBoundingClientRect();
      return { text: el.textContent, left: box.left, right: box.right, top: box.top };
    }));
  for (let attempt = 0; attempt < 25 && (await layered()).length < 2; attempt++) await page.waitForTimeout(200);
  const pair = await layered();
  const longBlock = pair.find((block) => block.text.includes('Долгое'));
  const lateBlock = pair.find((block) => block.text.includes('Позднее'));
  assert.ok(longBlock && lateBlock, `в сетке нет дел для проверки наслоения: ${JSON.stringify(pair)}`);
  assert.ok(lateBlock.left > longBlock.left + 10 && lateBlock.left < longBlock.right - 10 && lateBlock.top > longBlock.top + 10,
    `позднее дело должно лежать поверх раннего со сдвигом: ${JSON.stringify(pair)}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-day-panel.png` });
  await planner.getByRole('button', { name: 'Undo' }).click();
  await gridColumn.locator('[data-block]').filter({ hasText: 'Внахлёст' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.evaluate(async () => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ task: { id: 'layer-long', deleted: true } }, { task: { id: 'layer-late', deleted: true } }],
    });
  });
  await gridColumn.locator('[data-block]').filter({ hasText: 'Долгое' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  if (await sidePane.count()) await sidePane.getByRole('button', { name: 'Close' }).first().click();
  console.log('OK: событие; пересечения разрешены и лежат каскадом; «+» и нажатие на свободное время');

  // ── Статистика; питания в «Плане» нет (убрано 10 окт 2026, будет сделано заново) ──
  assert.equal(await planner.getByText('Nutrition', { exact: true }).count(), 0, 'вкладки «Питание» быть не должно');
  await planner.getByText('Statistics', { exact: true }).first().click();
  await planner.getByRole('img', { name: 'Planned: 2 h' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByText('Nutrition', { exact: true }).count(), 0, 'в статистике питания быть не должно');
  console.log('OK: статистика времени; питания в «Плане» нет');

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
  await dayPane.locator('[data-day-grid]').getByText('08:00', { exact: true })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: настройки дня применяются к сетке дня');

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
    const cell = planner.locator(`[role="gridcell"][data-day="${day}"]`);
    if (!(await cell.count())) {
      // День в соседнем месяце — листаем вперёд
      await planner.getByRole('button', { name: 'Next month' }).click();
      await cell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    }
    await cell.click({ position: { x: 10, y: 10 } });
    // Панель дня перерисовывается после клика — читать её текст можно, когда она показывает этот день
    await planner.locator(`[data-planner-day="${day}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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

  // ── Виды календаря и выбор месяца и года (spec 013, US2) ──────────────────
  const viewButton = (name) => planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name, exact: true });
  const main = planner.locator('[data-planner-view]');
  await planner.getByText('Calendar', { exact: true }).first().click();
  await viewButton('Week').click();
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const weekColumn = planner.locator(`[data-planner-view="week"] div[data-day="${today}"]`).last();
  await weekColumn.getByText('Подготовить макет').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Пересекающиеся задача (14:00–15:30) и событие (14:30–15:00) — каскадом: сдвиг есть, названия видны
  const blocks = await weekColumn.locator('[data-block]').evaluateAll((items) => items
    .filter((el) => /Подготовить макет|Созвон команды/.test(el.textContent))
    .map((el) => el.getBoundingClientRect().left));
  assert.equal(blocks.length, 2, 'в неделе должны быть видны и задача, и событие');
  assert.ok(Math.abs(blocks[0] - blocks[1]) > 4, `пересекающиеся дела лежат одно под другим без сдвига: ${blocks}`);
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
  console.log('OK: виды год, месяц, неделя; соседние дни; выбор месяца и года');

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
  const cityDay = dayPane.locator('[data-all-day]').filter({ hasText: 'День города' });
  await cityDay.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cityDay.getAttribute('data-holiday'), '1', 'праздник отмечен в панели дня');
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
  // Задача без времени — плашкой над сеткой дня, окрашена цветом списка
  const colorRow = dayPane.locator('button[data-kind="task"]').filter({ hasText: 'Цветная задача' });
  await colorRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const stripe = await colorRow.evaluate((el) => getComputedStyle(el).getPropertyValue('--planner-list-color').trim());
  assert.ok(stripe, 'у задачи списка с цветом нет цвета списка');
  // Статусов три
  assert.deepEqual(
    await (async () => {
      await colorRow.click();
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
  // В клетке месяца только два превью, а порядок задач дня после перезагрузки не закреплён — смотрим панель дня
  await todayCell.click({ position: { x: 10, y: 10 } });
  await dayPane.getByText('Подготовить макет').first().waitFor({ state: 'visible', timeout: 30000 });
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
  // Телефон: заголовка и кнопки «+ Задача» нет, шестерёнка — в строке периода; расписание дня —
  // горизонтальная лента под календарём, календарь остаётся на виду
  // Переключателя вида над календарём нет — вид выбирается в настройках (шестерёнка)
  assert.equal(await planner.getByRole('group', { name: 'Calendar view' }).count(), 0, 'на телефоне переключатель вида — в настройках');
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  const viewSelect = page.locator('#planner-settings-view');
  await viewSelect.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await viewSelect.locator('option').count(), 3, 'в настройках три вида календаря');
  await viewSelect.selectOption('week');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await viewSelect.selectOption('month');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  assert.equal(await planner.getByRole('button', { name: '+ Task', exact: true }).count(), 0, 'на телефоне кнопки «+ Задача» нет');
  assert.equal(await planner.locator('header h1').count(), 0, 'на телефоне заголовка раздела нет');
  await todayCell.click({ position: { x: 10, y: 10 } });
  // День — горизонтальной шкалой времени НАД календарём: часы по оси X, шкала листается вбок
  const timeline = dayPane.locator('[data-day-timeline]');
  await timeline.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const layout = await page.evaluate(() => {
    const cell = document.querySelector('#ParvanePlanner [role="gridcell"]').getBoundingClientRect();
    const root = document.querySelector('#ParvanePlanner [data-day-timeline]');
    const hours = [...root.querySelectorAll('[data-hour]')].map((el) => el.getBoundingClientRect());
    const scroller = root.querySelector('[data-hour]').parentElement.parentElement;
    const blocks = [...root.querySelectorAll('[data-block]')].map((el) => {
      const box = el.getBoundingClientRect();
      return { text: el.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    });
    return {
      cellTop: cell.top,
      timelineBottom: root.getBoundingClientRect().bottom,
      isHorizontal: hours.length > 1 && Math.abs(hours[0].top - hours[1].top) < 2 && hours[1].left > hours[0].left,
      canScroll: scroller.scrollWidth > scroller.clientWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      blocks,
    };
  });
  assert.ok(layout.timelineBottom <= layout.cellTop + 1, `день должен стоять над календарём: ${JSON.stringify(layout)}`);
  assert.ok(layout.isHorizontal, `часы должны идти по оси X: ${JSON.stringify(layout)}`);
  assert.ok(layout.canScroll, `шкала должна листаться вбок: ${JSON.stringify(layout)}`);
  assert.ok(layout.overflow <= 0, `страница не должна листаться вбок: ${JSON.stringify(layout)}`);
  // Пересекающиеся задача и событие — в разных строках, друг друга не закрывают
  const taskBlock = layout.blocks.find((block) => block.text.includes('Подготовить макет'));
  const eventBlock = layout.blocks.find((block) => block.text.includes('Созвон команды'));
  assert.ok(taskBlock && eventBlock, `на шкале должны быть задача и событие: ${JSON.stringify(layout.blocks)}`);
  assert.ok(
    eventBlock.top >= taskBlock.bottom - 1 || taskBlock.top >= eventBlock.bottom - 1,
    `пересекающиеся дела должны стоять в разных строках: ${JSON.stringify(layout.blocks)}`,
  );
  assert.ok(await todayCell.isVisible(), 'календарь остаётся на виду');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone.png` });
  // Новое дело: «+» раскрывает форму под шкалой, без отдельного экрана
  await timeline.getByRole('button', { name: '+ Task for this day' }).click();
  const inlineForm = dayPane.locator('[data-inline-form]');
  await inlineForm.locator('#planner-new-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidePane.count(), 0, 'на телефоне форма задачи не должна открываться отдельным экраном');
  await inlineForm.locator('#planner-new-name').fill('С телефона');
  await inlineForm.getByRole('button', { name: 'Create', exact: true }).click();
  await inlineForm.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await timeline.getByText('С телефона').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  // Шестерёнка — в строке периода
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await sidePane.getByLabel('Day starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  console.log('OK: телефон — день шкалой времени над календарём, пересечения в разных строках, новое дело под шкалой');
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
