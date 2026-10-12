// Боковая панель разделов и планировщик (spec 009). Панель видна всегда: без папок
// слева — только разделы «Чаты» и «План»; раздел «План» занимает место колонок
// мессенджера. Планировщик: задача, отмена, событие с пересечением,
// статистика, сохранение после перезагрузки, на телефоне — нижняя панель разделов.
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
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/scheme-chats-wide.png` });
  await sidebar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidebar.getByRole('tab').count(), 6, 'в панели шесть разделов: чаты, сегодня, календарь, здоровье, знания, облако');
  assert.equal(await sidebar.getByRole('button', { name: 'Search' }).count(), 1, 'внизу панели — «Поиск»');
  assert.equal(await sidebar.getByRole('button', { name: 'Profile' }).count(), 1, 'внизу панели — «Профиль»');
  assert.equal(await sidebar.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected'), 'true');
  assert.equal(await sidebar.getByRole('button', { name: 'Open menu' }).count(), 0, 'меню — не в панели');
  assert.ok(await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).count(), 'меню осталось в шапке');
  // Разделы идут сверху под знаком, «Поиск» и «Профиль» прижаты к низу панели
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('#FoldersSidebar').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('#FoldersSidebar [role="tablist"] > button')].map((el) => el.getBoundingClientRect());
    const profile = document.querySelector('#FoldersSidebar > button:last-of-type').getBoundingClientRect();
    return {
      barBottom: bar.bottom, barTop: bar.top, lastBottom: tabs.at(-1).bottom, firstTop: tabs[0].top, profileBottom: profile.bottom,
    };
  });
  assert.ok(geometry.firstTop - geometry.barTop < 80, `разделы не у верхнего края: ${JSON.stringify(geometry)}`);
  assert.ok(
    geometry.lastBottom < geometry.barTop + (geometry.barBottom - geometry.barTop) * 0.6,
    `разделы должны лежать в верхней части панели: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.barBottom - geometry.profileBottom < 24, `«Профиль» не у нижнего края: ${JSON.stringify(geometry)}`);
  // Шапка списка чатов: заголовок, «Написать» с меню из четырёх пунктов; карандаша Telegram нет
  const chatsHeader = page.locator('#LeftMainHeader');
  await chatsHeader.getByRole('heading', { name: 'Chats' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await chatsHeader.getByRole('button', { name: 'New Message' }).click();
  for (const item of ['New Message', 'New Group', 'New Channel', 'Planner entry']) {
    await chatsHeader.getByRole('menuitem', { name: item }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await page.keyboard.press('Escape');
  await chatsHeader.getByRole('menuitem', { name: 'Planner entry' }).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#LeftColumn .NewChatButton').count(), 0, 'карандаша Telegram нет и на компьютере');
  // «Поиск» панели открывает поиск по чатам; папок чатов в панели нет
  await sidebar.getByRole('button', { name: 'Search' }).click();
  await page.locator('#telegram-search-input').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.activeElement?.id === 'telegram-search-input', undefined, { timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: панель — знак, шесть разделов сверху, «Поиск» и «Профиль» внизу');

  // ── Раздел «План» вместо колонок мессенджера ──────────────────────────────
  await sidebar.getByRole('tab', { name: 'Calendar' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), false, 'список чатов должен быть скрыт');
  assert.equal(await isShown(page, '#MiddleColumn'), false, 'переписка должна быть скрыта');
  assert.match(await todayCell.innerText(), /Free/, 'пустой день помечен «Свободно»');
  console.log('OK: «План» открыт, колонки мессенджера скрыты');

  // ── Задача: создание, отмена, повтор ──────────────────────────────────────
  // «+ Запись» в шапке открывает ввод текстом; полная форма — по «Подробнее» в его окне
  async function openFullForm() {
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
    await page.locator('form[data-quick-kind]').getByRole('button', { name: 'More options' }).click();
    await page.locator('#planner-new-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  }
  async function createTask(name, minutes, start) {
    await openFullForm();
    await page.locator('#planner-new-name').fill(name);
    await planner.getByLabel('Duration, min').fill(String(minutes));
    await planner.getByLabel('Start', { exact: true }).fill(start);
    await planner.getByRole('button', { name: 'Create', exact: true }).click();
    await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  // Форма открывается колонкой слева: календарь и панель дня остаются видны (spec 013, US1)
  await openFullForm();
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
  await openFullForm();
  await page.locator('#planner-new-name').fill('Без оценки');
  await planner.getByLabel('Start', { exact: true }).fill('09:00');
  await planner.getByLabel('Duration, min').fill('');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('alert').getByText('needs a work date and a duration').waitFor({ timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Cancel' }).click();

  // ── Событие, пересекающееся с задачей ─────────────────────────────────────
  await openFullForm();
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
  // Виды календаря (spec 018): неделя, месяц, год, список; день всегда в панели справа
  const viewGroup = planner.getByRole('group', { name: 'Calendar view' });
  assert.deepEqual(await viewGroup.getByRole('button').allInnerTexts(), ['Week', 'Month', 'Year', 'List'], 'виды календаря');
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

  // ── «Сегодня»: сводка дня, задачи дня, задачи без даты (spec 018) ─────────
  assert.equal(await planner.getByText('Statistics', { exact: true }).count(), 0, 'вкладки «Статистика» больше нет');
  assert.equal(await planner.getByText('Nutrition', { exact: true }).count(), 0, 'вкладки «Питание» быть не должно');
  await sidebar.getByRole('tab', { name: 'Today' }).click();
  const todayView = planner.locator(`[data-planner-today="${today}"]`);
  await todayView.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await todayView.locator('[data-today-tasks]').getByText('Подготовить макет').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayView.locator('[data-today-card="tasks"]').innerText(), /\d+ \/ \d+/, 'карточка задач — «сделано / всего»');
  assert.match(await todayView.locator('[data-today-card="load"]').innerText(), /h \/ 10 h/, 'карточка загрузки — «занято / бюджет»');
  await dayPane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Задача без даты: строка «Без даты · N», в шторке — по спискам, кнопка назначает день
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill('Вторая задача');
  await page.locator('#planner-quick-input').press('Enter');
  await planner.getByText('Added: Вторая задача').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const undatedRow = todayView.locator('[data-today-undated]');
  await undatedRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await undatedRow.innerText(), /No date · \d+/);
  assert.equal(await todayView.locator('[data-today-tasks]').getByText('Вторая задача').count(), 0, 'без даты — не в задачах дня');
  await undatedRow.click();
  const undatedSheet = page.locator('[data-planner-undated]');
  await undatedSheet.getByText('Вторая задача').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.ok(await undatedSheet.locator('[data-project=""]').count(), 'задачи сгруппированы по спискам');
  await undatedSheet.getByRole('button', { name: /^Schedule Вторая задача for / }).click();
  await planner.getByText('Moved to').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await undatedSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await todayView.locator('[data-today-tasks]').getByText('Вторая задача').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Стрелки периода листают дни
  await planner.getByRole('button', { name: 'Next period' }).click();
  await planner.locator('[data-planner-today]').getByText('No tasks for this day').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Previous period' }).click();
  await todayView.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Сегодня» — карточки дня, задачи дня, «Без даты» с назначением дня');

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
  await sidebar.getByRole('tab', { name: 'Calendar' }).click();
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
    await sidebar.getByRole('tab', { name: 'Calendar' }).click();
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
  await sidebar.getByRole('tab', { name: 'Calendar' }).click();
  await openFullForm();
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
  await openFullForm();
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
  await openFullForm();
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
  // «Все в серии»: правка одного экземпляра меняет время у всех экземпляров его ряда
  aside = await openDay(addDays(today, 4));
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('12:00');
  for (const scope of ['Only this', 'This and following', 'All in series']) {
    await planner.getByRole('button', { name: scope, exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await planner.getByRole('button', { name: 'All in series', exact: true }).click();
  aside = await openDay(addDays(today, 3));
  await aside.getByText('12:00–12:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(addDays(today, 4));
  await aside.getByText('12:00–12:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(today);
  await aside.getByText('10:00–10:15').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToThisMonth();
  console.log('OK: задача-ряд — выполнение по дню, «только это», «это и последующие», «все в серии»');

  // Ссылка на заметку в названии записи: на экране — нажимаемая ссылка с подписью, без скобок
  await openFullForm();
  await page.locator('#planner-new-name').fill('Читать [[Конспект|конспект]]');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  const linkedTitle = sidePane.getByRole('heading', { name: 'Читать конспект' });
  await linkedTitle.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(
    await linkedTitle.getByRole('link', { name: 'конспект' }).getAttribute('data-note-link'), 'Конспект',
    'ссылка в названии ведёт на заметку',
  );
  await dayPane.locator('[data-note-link="Конспект"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await dayPane.getByText('[[').count(), 0, 'скобок ссылки в названии на экране нет');
  await sidePane.getByRole('button', { name: 'Delete task' }).click();
  await dayPane.locator('[data-note-link="Конспект"]').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: ссылка на заметку в названии записи');

  // ── Виды календаря и выбор месяца и года (spec 013, US2) ──────────────────
  const viewButton = (name) => planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name, exact: true });
  const main = planner.locator('[data-planner-view]');
  await sidebar.getByRole('tab', { name: 'Calendar' }).click();
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
  // Вид «Список» (spec 018): повестка от выбранного дня, пустые дни пропущены
  await viewButton('List').click();
  const listView = planner.locator('[data-planner-view="agenda"]');
  const listToday = listView.locator(`section[data-day="${today}"]`);
  await listToday.getByText('Подготовить макет').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const listDays = await listView.locator('section[data-day]').evaluateAll((items) => items.map((el) => el.dataset.day));
  assert.deepEqual(listDays, [...listDays].sort(), 'дни списка идут по порядку');
  // Карточка записи: блок «Повтор и детали» сворачивается, в свёрнутом виде поля скрыты
  await listToday.getByRole('button', { name: /Созвон команды/ }).first().click();
  const fold = sidePane.locator('[data-planner-details]');
  await fold.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await fold.getAttribute('data-planner-details'), 'open');
  await fold.getByRole('button', { name: /Repeat and details/ }).click();
  await sidePane.locator('[data-planner-details="closed"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidePane.getByText('Holiday', { exact: true }).count(), 0, 'в свёрнутом блоке полей нет');
  await fold.getByRole('button', { name: /Repeat and details/ }).click();
  await sidePane.getByText('Holiday', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  // Вид — настройка устройства: переживает перезагрузку (проверяется ниже)
  await viewButton('Week').click();
  await main.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: виды год, месяц, неделя, список; соседние дни; выбор месяца и года; «Повтор и детали»');

  // ── Событие на весь день и праздник; список с цветом из формы (US3, US4) ──
  await openFullForm();
  await viewButton('Month').click();
  const loadBefore = (await todayCell.innerText()).match(/[\d.]+ h/)?.[0];
  await page.locator('#planner-new-kind').selectOption('event');
  await page.locator('#planner-new-name').fill('День города');
  await sidePane.getByText('All day', { exact: true }).click();
  await sidePane.getByText('Holiday', { exact: true }).click();
  // У события свой цвет (в список его не добавить)
  await sidePane.getByRole('radio', { name: 'Color 2' }).click();
  await sidePane.getByLabel('Start', { exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: День города').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const cityDay = dayPane.locator('[data-all-day]').filter({ hasText: 'День города' });
  await cityDay.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cityDay.getAttribute('data-holiday'), '1', 'праздник отмечен в панели дня');
  // Праздник заливает клетку календаря цветом события (а не красит число), событие на весь день —
  // метка у числа
  assert.equal(await todayCell.getAttribute('data-holiday'), '1', 'клетка праздника не отмечена');
  const cellColors = await page.evaluate(([holidayDay, plainDay]) => [holidayDay, plainDay].map((day) => getComputedStyle(
    document.querySelector(`#ParvanePlanner [role="gridcell"][data-day="${day}"]`),
  ).backgroundColor), [today, tomorrowKey]);
  assert.notEqual(cellColors[0], cellColors[1], 'клетка праздника должна быть залита иначе, чем обычная');
  assert.equal(await todayCell.locator('[data-all-day-marks]').getAttribute('data-all-day-marks'), '1', 'метка события на весь день');
  const chipColor = await cityDay.evaluate((el) => getComputedStyle(el).getPropertyValue('--planner-list-color').trim());
  assert.ok(chipColor, 'у события с цветом нет цвета в панели дня');
  assert.equal((await todayCell.innerText()).match(/[\d.]+ h/)?.[0], loadBefore, 'событие на весь день не входит в загрузку дня');
  await openFullForm();
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
  await sidebar.getByRole('tab', { name: 'Calendar' }).click();
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

  // ── Телефон: боковой панели нет, разделы — в нижней панели ────────────────
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  assert.equal(await isShown(page, '#FoldersSidebar'), false, 'на телефоне боковой панели нет');
  const tabBar = page.getByRole('navigation', { name: 'Sections' });
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const barGeometry = await page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Sections"]').getBoundingClientRect();
    const list = document.querySelector('#LeftColumn').getBoundingClientRect();
    return { barTop: bar.top, barBottom: bar.bottom, listBottom: list.bottom, height: window.innerHeight };
  });
  assert.ok(Math.abs(barGeometry.barBottom - barGeometry.height) < 2, `панель должна стоять внизу: ${JSON.stringify(barGeometry)}`);
  assert.ok(barGeometry.listBottom <= barGeometry.barTop + 1, `список чатов не должен уходить под панель: ${JSON.stringify(barGeometry)}`);
  assert.equal(await tabBar.getByRole('button', { name: 'Chats' }).getAttribute('aria-current'), 'page');
  await tabBar.getByRole('button', { name: 'Planner' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tabBar.getByRole('button', { name: 'Planner' }).getAttribute('aria-current'), 'page');
  const plannerBottom = await planner.evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(plannerBottom <= barGeometry.barTop + 1, `«План» не должен уходить под панель: ${plannerBottom}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  // Телефон: заголовка и кнопки «+ Задача» нет, шестерёнка — в строке периода; расписание дня —
  // горизонтальная лента под календарём, календарь остаётся на виду
  // Переключателя вида над календарём нет — вид выбирается в настройках (шестерёнка)
  assert.equal(await planner.getByRole('group', { name: 'Calendar view' }).count(), 0, 'на телефоне переключатель вида — в настройках');
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  const viewSelect = page.locator('#planner-settings-view');
  await viewSelect.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await viewSelect.locator('option').count(), 4, 'в настройках четыре вида календаря');
  await viewSelect.selectOption('week');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await viewSelect.selectOption('month');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  assert.equal(await planner.getByRole('button', { name: '+ Entry', exact: true }).count(), 0, 'на телефоне кнопки «+ Запись» нет');
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
  // Событие на весь день — полосой во всю шкалу
  const allDayBar = timeline.locator('[data-block][data-all-day]').filter({ hasText: 'День города' });
  await allDayBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const barWidth = await allDayBar.evaluate((el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width);
  assert.ok(barWidth > 0.98, `событие на весь день должно занимать всю шкалу: ${barWidth}`);
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
  // Вид «Неделя» на телефоне: полоса из семи дней и сетка выбранного дня под ней (панели дня и широкой
  // сетки недели нет), вбок ничего не листается; нажатие на свободное время создаёт дело
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  assert.equal(await viewSelect.locator('option[value="week"]').innerText(), 'Day', 'на телефоне вид недели называется «День»');
  await viewSelect.selectOption('week');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  const phoneWeek = planner.locator('[data-planner-view="week"]');
  await phoneWeek.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await timeline.count(), 0, 'в виде «Неделя» на телефоне шкалы дня быть не должно');
  const stripDays = phoneWeek.locator('[data-day-strip] button');
  const pickedStripDay = phoneWeek.locator('[data-day-strip] button[aria-pressed="true"]');
  assert.equal(await stripDays.count(), 7, 'в полосе недели семь дней');
  assert.equal(await pickedStripDay.getAttribute('data-day'), today, 'в полосе выбран сегодняшний день');
  assert.equal(await stripDays.locator('[data-load]').count(), 7, 'у каждого дня полосы — полоска загрузки');
  const phoneDayGrid = phoneWeek.locator('[data-day-grid]');
  await phoneDayGrid.locator(`div[data-day="${today}"]`).last().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneDayGrid.getByText('С телефона').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const weekGeometry = await phoneWeek.evaluate((week) => {
    const strip = week.querySelector('[data-day-strip]').getBoundingClientRect();
    const grid = week.querySelector('[data-day-grid]');
    return {
      stripLeft: strip.left, stripRight: strip.right, stripBottom: strip.bottom, gridTop: grid.getBoundingClientRect().top,
      gridOverflow: grid.scrollWidth - grid.clientWidth, columns: grid.querySelectorAll('[style*="height"][data-day]').length,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  assert.ok(weekGeometry.stripLeft >= 0 && weekGeometry.stripRight <= 390, `полоса дней должна помещаться в экран: ${JSON.stringify(weekGeometry)}`);
  assert.ok(weekGeometry.stripBottom <= weekGeometry.gridTop + 1, `сетка дня должна стоять под полосой: ${JSON.stringify(weekGeometry)}`);
  assert.equal(weekGeometry.columns, 1, `в сетке должен быть один день: ${JSON.stringify(weekGeometry)}`);
  assert.ok(weekGeometry.gridOverflow <= 1 && weekGeometry.pageOverflow <= 0, `вбок ничего не должно листаться: ${JSON.stringify(weekGeometry)}`);
  // Нажатие на день полосы выбирает его
  const otherDay = (await stripDays.evaluateAll((items) => items.map((item) => item.dataset.day))).find((day) => day !== today);
  await phoneWeek.locator(`[data-day-strip] button[data-day="${otherDay}"]`).click();
  await phoneDayGrid.locator(`div[data-day="${otherDay}"]`).last().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await pickedStripDay.getAttribute('data-day'), otherDay, 'нажатие на день полосы выбирает его');
  await phoneWeek.locator(`[data-day-strip] button[data-day="${today}"]`).click();
  await phoneDayGrid.locator(`div[data-day="${today}"]`).last().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Горизонтальный жест по сетке дня листает дни (жест собирается из событий касания: мыши он не слушается)
  const swipe = (selector, fromX, toX) => page.evaluate(([target, from, to]) => {
    if (typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') return false;
    const element = document.querySelector(target);
    const fire = (type, x) => {
      const touch = new Touch({ identifier: 1, target: element, clientX: x, clientY: 400 });
      element.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch], changedTouches: [touch],
      }));
    };
    fire('touchstart', from);
    fire('touchend', to);
    return true;
  }, [selector, fromX, toX]);
  const canSwipe = await swipe('#ParvanePlanner [data-day-grid]', 300, 80);
  if (canSwipe) {
    await phoneDayGrid.locator(`div[data-day="${tomorrowKey}"]`).last().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await swipe('#ParvanePlanner [data-day-grid]', 80, 300);
    await phoneDayGrid.locator(`div[data-day="${today}"]`).last().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    // «Сегодня»: жест листает дни, а начатый на шкале дня (она сама листается вбок) — нет
    await planner.locator('header').getByText('Today').first().click();
    await planner.locator(`[data-planner-today="${today}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await swipe('#ParvanePlanner [data-day-timeline] [data-hour]', 300, 80);
    await page.waitForTimeout(300);
    assert.equal(await planner.locator(`[data-planner-today="${today}"]`).count(), 1, 'жест по шкале дня не должен листать дни');
    await swipe('#ParvanePlanner [data-today-tasks]', 300, 80);
    await planner.locator(`[data-planner-today="${tomorrowKey}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await swipe('#ParvanePlanner [data-today-tasks]', 80, 300);
    await planner.locator(`[data-planner-today="${today}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await planner.locator('header').getByText('Calendar').first().click();
    await phoneWeek.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    console.log('OK: телефон — жест листает дни на «Сегодня» и в сетке дня');
  } else {
    console.log('SKIP: событий касания в этом браузере нет — листание жестом не проверено');
  }
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone-week.png` });
  await phoneDayGrid.locator('div[data-day]').last().click({ position: { x: 30, y: 8 } });
  await sidePane.locator('#planner-new-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.ok(await sidePane.getByLabel('Start', { exact: true }).inputValue(), 'нажатие на свободное время недели задаёт начало');
  await planner.getByRole('button', { name: 'Cancel' }).click();
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await viewSelect.selectOption('month');
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  // Шестерёнка — в строке периода
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await sidePane.getByLabel('Day starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidePane.getByRole('button', { name: 'Close' }).first().click();
  console.log('OK: телефон — день шкалой времени над календарём, пересечения в разных строках, новое дело под шкалой');
  // «+» нижней панели открывает ввод текстом прямо в «Плане» (spec 017, сценарий quick_input)
  await tabBar.getByRole('button', { name: 'New entry' }).click();
  await page.locator('#planner-quick-input').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // «Профиль» — главный экран настроек; во вложенном экране и в открытом чате панели нет
  await tabBar.getByRole('button', { name: 'Profile' }).click();
  await planner.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tabBar.getByRole('button', { name: 'Profile' }).getAttribute('aria-current'), 'page');
  // «Профиль»: карточка аккаунта не уходит под шапку, настройки мессенджера и блок Parvane — карточками;
  // «Оформление» — окно с режимом и цветовыми схемами
  const profile = page.locator('#Settings');
  for (const row of ['General Settings', 'Chat Folders', 'Devices', 'Planner settings', 'Health goals', 'Notes storage', 'Appearance']) {
    await profile.getByRole('button', { name: row }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  const profileGeometry = await page.evaluate(() => {
    const avatar = document.querySelector('#Settings .Avatar').getBoundingClientRect();
    const header = document.querySelector('#Settings .left-header').getBoundingClientRect();
    return { avatarTop: avatar.top, headerBottom: header.bottom };
  });
  assert.ok(profileGeometry.avatarTop >= profileGeometry.headerBottom, `аватар под шапкой: ${JSON.stringify(profileGeometry)}`);
  await profile.getByRole('button', { name: 'Appearance' }).click();
  const schemes = page.getByRole('radiogroup', { name: 'Colour scheme' });
  await schemes.getByRole('radio', { name: 'Nord' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio').count(), 3, 'режим: как в системе, светлая, тёмная');
  await page.keyboard.press('Escape');
  await schemes.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await tabBar.getByRole('button', { name: 'Chats' }).click();
  assert.ok(await isShown(page, '#LeftColumn'), '«Чаты» возвращают к списку');
  await tabBar.locator('button[aria-current="page"]', { hasText: 'Chats' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // На списке чатов «+» — меню: новое сообщение, группа, канал, запись в план; карандаша Telegram нет
  await tabBar.getByRole('button', { name: 'New entry' }).click();
  const addMenu = tabBar;
  for (const item of ['New Message', 'New Group', 'New Channel', 'Planner entry']) {
    await addMenu.getByRole('menuitem', { name: item }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  assert.equal(await page.locator('#LeftColumn .NewChatButton button:visible').count(), 0, 'карандаша на телефоне нет');
  // Меню помещается в экран
  const menuBox = await addMenu.getByRole('menuitem', { name: 'Planner entry' }).boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `меню «+» выходит за экран: ${JSON.stringify(menuBox)}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/plus-menu-phone.png` });
  await addMenu.getByRole('menuitem', { name: 'Planner entry' }).click();
  await page.locator('#planner-quick-input').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await tabBar.getByRole('button', { name: 'Chats' }).click();
  console.log('OK: телефон — нижняя панель: разделы, «+» и «Профиль»');

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
