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
  waitForChatList,
  closePlannerSettings,
  openPlannerHeader, openPlannerScreen,
  openPlannerSettings,
  pickPlannerDay,
  openSettingsScreen,
  waitPastMidnight,
} from './e2e_web_helpers.mjs';

// Выключатель перерисовывается от сигнала либо сохранения — не в тот же кадр, что нажатие
async function expectChecked(locator, value, what) {
  for (let attempt = 0; attempt < 50 && await locator.getAttribute('aria-checked') !== value; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  assert.equal(await locator.getAttribute('aria-checked'), value, what);
}


// Сценарий считает «сегодня» один раз: прогон не должен переходить через полночь
await waitPastMidnight();

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
  const addDaysKey = (key, delta) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d + delta);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const todayCell = planner.locator(`[role="gridcell"][data-day="${today}"]`);
  // Карточка записи (форма, редактор) и окно настроек; день календаря — остров справа, на его место
  // встаёт карточка
  const sidePane = planner.locator('[data-planner-side]');
  const dayPane = planner.locator('[data-planner-day]');
  const viewButton = (name) => planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name, exact: true });
  // Окно (`ui/Modal`) ставит слушатель Escape эффектом — со следующего кадра после появления; нажатие в тот же
  // кадр уходит мимо. Нажатие повторяется, пока окно не закрылось
  const closeByEscape = async (target, what) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.keyboard.press('Escape');
      if (await target.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
    }
    assert.fail(`${what}: Escape не закрыл окно`);
  };
  const closeSide = async () => {
    await sidePane.getByRole('button', { name: 'Close' }).first().click();
    await sidePane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };

  // ── Панель: видна без папок, в ней только разделы; меню «☰» нет ни в ней, ни в шапке списка ──
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/scheme-chats-wide.png` });
  await sidebar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidebar.getByRole('tab').count(), 7, 'в панели семь модулей: чаты, план, здоровье, заметки, файлы, музыка, профиль');
  assert.equal(await sidebar.getByRole('button', { name: /^Global search/ }).count(), 1, 'внизу панели — «Поиск»');
  assert.equal(await sidebar.locator('[data-add-for]').count(), 1, 'внизу панели — «+»');
  assert.equal(await sidebar.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).count(), 0, 'меню «☰» убрано: его пункты в «Профиле»');
  // Разделы идут сверху, «Поиск» и «+» прижаты к низу панели
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('#FoldersSidebar').getBoundingClientRect();
    const tabs = [...document.querySelectorAll('#FoldersSidebar [role="tablist"] > button')].map((el) => el.getBoundingClientRect());
    const profile = document.querySelector('#FoldersSidebar [data-add-for]').getBoundingClientRect();
    return {
      barBottom: bar.bottom, barTop: bar.top, lastBottom: tabs.at(-1).bottom, firstTop: tabs[0].top, profileBottom: profile.bottom,
    };
  });
  // Разделы начинаются от верхнего края панели
  assert.ok(geometry.firstTop - geometry.barTop < 110, `разделы не у верхнего края: ${JSON.stringify(geometry)}`);
  assert.ok(
    geometry.lastBottom < geometry.barTop + (geometry.barBottom - geometry.barTop) * 0.8,
    `модули должны лежать в верхней части панели: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.barBottom - geometry.profileBottom < 24, `«+» не у нижнего края: ${JSON.stringify(geometry)}`);
  // Шапка списка чатов — поле поиска (заголовок только для чтения с экрана); создание — «+» панели модулей
  // с меню из четырёх пунктов; карандаша Telegram нет
  const chatsHeader = page.locator('#LeftMainHeader');
  await chatsHeader.getByRole('heading', { name: 'Chats' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await chatsHeader.locator('.left-header-compose').count(), 0, '«Написать» в шапке больше нет');
  await page.locator('[data-add-for="chats"]').click();
  for (const item of ['New Message', 'New Group', 'New Channel', 'Plan entry']) {
    await page.getByRole('menuitem', { name: item }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem', { name: 'Plan entry' }).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#LeftColumn .NewChatButton').count(), 0, 'карандаша Telegram нет и на компьютере');
  // «Поиск» панели открывает общий поиск (палитру Ctrl+K, сценарий `e2e_web_palette.mjs`); папок чатов в панели нет
  await sidebar.getByRole('button', { name: /^Global search/ }).click();
  await page.locator('#parvane-palette-search').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.activeElement?.id === 'parvane-palette-search', undefined, { timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('#parvane-palette-search').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  console.log('OK: панель — знак, семь модулей сверху, «Поиск» и «+» внизу');

  // ── Раздел «План» вместо колонок мессенджера ──────────────────────────────
  await openPlannerScreen(page, 'calendar');
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), false, 'список чатов должен быть скрыт');
  assert.equal(await isShown(page, '#MiddleColumn'), false, 'переписка должна быть скрыта');
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
    // Карточка задачи на компьютере — крупно на месте вида (DkPlanMore): календарь виден после её закрытия
    await closeSide();
  }
  // Форма открывается справа на месте острова дня: календарь остаётся виден
  await openFullForm();
  await sidePane.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const boxes = { side: await sidePane.boundingBox(), cell: await todayCell.boundingBox() };
  assert.ok(boxes.side && boxes.cell, `форма и календарь должны быть видны: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.cell.x + boxes.cell.width <= boxes.side.x + 1, `форма перекрывает календарь: ${JSON.stringify(boxes)}`);
  // «Месяц» на компьютере — сетка на всю ширину, колонки с месяцем и днём нет (доска `RdPlan`); она — у недели
  assert.equal(await planner.locator('[data-planner-rail]').count(), 0, 'в «Месяце» на компьютере колонки слева нет');
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
  console.log('OK: форма справа на месте дня, календарь виден; дата формы следует за выбранным днём');

  await createTask('Подготовить макет', 90, '14:00');
  await todayCell.getByText('Подготовить макет').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Часов в клетке месяца на компьютере нет (доска `RdPlan`) — загрузка дня в подписи клетки для чтения с экрана
  assert.match(await todayCell.getAttribute('aria-label'), /1\.5 h planned/, 'загрузка дня — полтора часа');
  assert.doesNotMatch(await todayCell.innerText(), /\d h/, 'часов в клетке месяца на компьютере нет');
  await planner.getByRole('button', { name: 'Undo' }).click();
  await todayCell.getByText('Подготовить макет').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await createTask('Подготовить макет', 90, '14:00');
  console.log('OK: задача создаётся, отменяется и создаётся снова');

  // Время начала без длительности — можно (16 окт 2026): «не вписал — не знаю»
  await openFullForm();
  await page.locator('#planner-new-name').fill('Без оценки');
  await planner.getByLabel('Start', { exact: true }).fill('09:00');
  await planner.getByLabel('Duration, min').fill('');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Без оценки' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();

  // ── Событие, пересекающееся с задачей ─────────────────────────────────────
  await openFullForm();
  await sidePane.locator('[data-new-kind="event"]').click();
  await page.locator('#planner-new-name').fill('Созвон команды');
  await planner.getByLabel('Start', { exact: true }).fill('14:30');
  await planner.getByLabel('End', { exact: true }).fill('15:00');
  // Шаги — и в форме нового события (PhPlanMore): Enter в поле шага добавляет шаг, а не создаёт запись
  const newSteps = sidePane.locator('[data-card-row="steps"]');
  await newSteps.getByPlaceholder('Add step').fill('Открыть повестку');
  await newSteps.getByPlaceholder('Add step').press('Enter');
  await newSteps.locator('label').filter({ hasText: 'Открыть повестку' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await newSteps.getByText('Steps · 0/1').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#planner-new-name').inputValue(), 'Созвон команды', 'Enter в шаге создал запись');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Созвон команды').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await todayCell.getAttribute('aria-label'), /2 h planned.*conflicts: 1/, 'в дне — пересечение и 2 часа');
  // Сетка недели по часам; пересекающиеся дела не закрывают названия друг друга
  await viewButton('Week').click();
  // Колонка слева у недели (доска `DeskPlan`): шапка дня одной строкой «пн 9», дела дня одним списком,
  // под названием — «14:00 · 1 ч 30 мин»
  await dayPane.locator('[data-block]').filter({ hasText: 'Подготовить макет' }).getByText('14:00 · 1 h 30 min')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dayPane.locator('[data-block]').filter({ hasText: 'Созвон команды' }).getByText('14:30 · 30 min')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await dayPane.getByRole('button', { name: 'Add to this day' }).count(), 0, 'добавление — полем в шапке');
  assert.match(await planner.locator(`[data-planner-view="week"] button[data-day="${today}"]`).first().innerText(), /^\S+ \d+$/,
    'шапка дня недели — одной строкой «пн 9»');
  const gridColumn = planner.locator(`[data-planner-view="week"] div[data-day="${today}"]`).last();
  await gridColumn.locator('[data-block]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  // Слои календаря на компьютере — колонкой «Слои / Что показывать» вида «День» (доска `ZdPlanX`, сценарий
  // `planner_more`); выключатели слоёв на телефоне — на странице настроек (ниже, телефонная часть)
  assert.deepEqual(await viewGroup.getByRole('button').allInnerTexts(), ['Day', 'Week', 'Month', 'Year', 'List'], 'виды календаря');
  // Полная форма из окна ввода — на выбранный день
  await openFullForm();
  assert.equal(await sidePane.getByLabel('Work date').inputValue(), today, 'форма создаёт дело на выбранный день');
  await planner.getByRole('button', { name: 'Cancel' }).click();
  // Нажатие на свободное время в сетке: форма с этим временем; пересекаться с другими делами можно
  const gridBox = await gridColumn.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    first: Number(el.parentElement.dataset.firstHour),
    hours: Number(el.parentElement.dataset.hours),
  }));
  await gridColumn.click({ position: { x: 20, y: ((12 - gridBox.first) / gridBox.hours) * gridBox.height + 6 } });
  assert.equal(await sidePane.getByLabel('Start', { exact: true }).inputValue(), '12:00', 'начало — по месту нажатия');
  assert.equal(await sidePane.getByLabel('Duration, min').inputValue(), '30', 'длительность по умолчанию — полчаса');
  await page.locator('#planner-new-name').fill('Внахлёст');
  await sidePane.getByLabel('Start', { exact: true }).fill('14:10');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Внахлёст').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByRole('alert').count(), 0, 'пересечение не должно быть ошибкой');
  // После создания открывается карточка новой задачи крупно на месте вида (доска `DkPlanMore`): сетка — после неё
  await closeSide();
  await gridColumn.locator('[data-block]').nth(2).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-week.png` });
  await planner.getByRole('button', { name: 'Undo' }).click();
  await gridColumn.locator('[data-block]').filter({ hasText: 'Внахлёст' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.evaluate(async () => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ task: { id: 'layer-long', deleted: true } }, { task: { id: 'layer-late', deleted: true } }],
    });
  });
  await gridColumn.locator('[data-block]').filter({ hasText: 'Долгое' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  if (await sidePane.count()) await closeSide();
  await viewButton('Month').click();
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: событие; пересечения разрешены и лежат каскадом; слои; «Добавить на этот день» и нажатие на свободное время');

  // ── Шапка компьютера (доска `DeskPlan`): поле «Запись строкой» с разбором, мини-месяц листает неделю ──
  await viewButton('Week').click();
  const quickField = planner.locator('header [data-planner-quick-field] input');
  await quickField.fill('Ревью кода завтра в 10 на час');
  const quickSummary = planner.locator('header [data-quick-field-summary]');
  await quickSummary.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await quickSummary.innerText(), /^(Event|Task) · \w+ 10:00(–11:00)?( · 1 h)? · Enter$/, 'разбор строки в поле шапки');
  await quickField.press('Enter');
  await planner.getByText('Added: Ревью кода').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await quickField.inputValue(), '', 'поле очищено после записи');
  await planner.locator(`[data-planner-view="week"] [data-block]`).filter({ hasText: 'Ревью кода' }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Undo' }).click();
  await planner.locator(`[data-planner-view="week"] [data-block]`).filter({ hasText: 'Ревью кода' })
    .waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Мини-месяц колонки: день другой недели переключает неделю сетки и день колонки
  const nextWeekDay = addDaysKey(today, 7);
  const miniNext = planner.locator(`[data-planner-mini] [data-mini-day="${nextWeekDay}"]`);
  if (await miniNext.count()) {
    await miniNext.click();
    await planner.locator(`[data-planner-view="week"] button[data-day="${nextWeekDay}"]`).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await planner.locator(`[data-planner-day="${nextWeekDay}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await planner.locator('header').getByRole('button', { name: 'Current date', exact: true }).click();
  }
  await viewButton('Month').click();
  console.log('OK: шапка — ввод строкой с разбором, мини-месяц листает неделю');

  // ── «Сегодня»: сводка дня, задачи дня, задачи без даты (spec 018) ─────────
  assert.equal(await planner.getByText('Statistics', { exact: true }).count(), 0, 'вкладки «Статистика» больше нет');
  assert.equal(await planner.getByText('Nutrition', { exact: true }).count(), 0, 'вкладки «Питание» быть не должно');
  await openPlannerScreen(page, 'today');
  const todayView = planner.locator(`[data-planner-today="${today}"]`);
  await todayView.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await todayView.locator('[data-today-tasks]').getByText('Подготовить макет').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Загрузка дня — в шапке: «занято из бюджета»
  await planner.locator('header').getByText(/^\d+:\d\d of 10:00$/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Расписание дня — карточка-список рядом с задачами
  await todayView.locator('[data-today-schedule]').getByText('14:00–15:30').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Заметки дня у нового аккаунта нет: в колонке дня — сразу поле «Что важно сегодня» (доска `RdPlan`; текст
  // заметки — сценарий notes); внизу колонки — строка сна, когда сон записан (сценарий planner_sleep)
  await todayView.locator('[data-today-note="empty"] [data-today-note-editor]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(
    await todayView.locator('[data-today-note-editor]').getAttribute('placeholder'), 'What matters today', 'подсказка поля',
  );
  // Задача без даты: строка «Без даты» с числом, в шторке — по спискам, кнопка назначает день
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill('Вторая задача');
  await page.locator('#planner-quick-input').press('Enter');
  await planner.getByText('Added: Вторая задача').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const undatedRow = todayView.locator('[data-today-undated]');
  await undatedRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await undatedRow.innerText(), /^No date · \d+$/);
  // Задачи без даты видны прямо в карточке «Задачи» под «Без даты» (16 окт 2026)
  await todayView.locator('[data-today-tasks]').getByText('Вторая задача').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Без даты» открывает экран «Задачи» на этом разделе (spec 041 E1)
  await undatedRow.click();
  const undatedSheet = planner.locator('[data-planner-tasks="undated"]');
  await undatedSheet.getByText('Вторая задача').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await undatedSheet.getByRole('button', { name: /^Schedule Вторая задача for / }).click();
  await planner.getByText('Moved to').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeByEscape(undatedSheet, 'экран «Задачи»');
  await todayView.locator('[data-today-tasks]').getByText('Вторая задача').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «+» карточки «Задачи» — задача на этот день, а не «без даты»
  await todayView.locator('[data-today-tasks]').getByRole('button', { name: 'New task' }).click();
  await page.waitForFunction(() => document.querySelector('#planner-quick-input')?.value === 'task today ', undefined, {
    timeout: STEP_TIMEOUT_MS,
  });
  await page.locator('#planner-quick-input').press('End');
  await page.locator('#planner-quick-input').pressSequentially('Задача с плюса');
  await page.locator('#planner-quick-input').press('Enter');
  await planner.getByText('Added: Задача с плюса').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const plusTask = todayView.locator('[data-today-tasks]').getByText('Задача с плюса').first();
  await plusTask.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Стрелки периода листают дни
  await planner.getByRole('button', { name: 'Next period' }).click();
  await planner.locator('[data-planner-today]').getByText('No tasks for this day').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Previous period' }).click();
  await todayView.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Сегодня» — карточки дня, задачи дня, «Без даты» с назначением дня');

  // ── Настройки дня (T014): страница «Профиль → Модули / План» (доска `RdPlanSet`) ──
  let settingsPage = await openPlannerSettings(page);
  await settingsPage.getByLabel('Day starts').fill('08:00');
  await settingsPage.getByText('Settings saved').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Полоска уведомления уходит сама через 3 с (spec 012, A9)
  await settingsPage.getByText('Settings saved').waitFor({ state: 'hidden', timeout: 5000 });
  await settingsPage.getByLabel('Day ends').fill('07:00');
  await settingsPage.getByText('The day must end after it starts')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await settingsPage.getByLabel('Day ends').inputValue(), '21:00', 'негодное значение не применяется');
  // На компьютере слоёв и образца напоминания на странице нет (слои — колонкой в «Плане»)
  assert.equal(await settingsPage.locator('[data-layer]').count(), 0, 'слоёв на странице компьютера нет');
  // Обеденный перерыв и запас между записями (доска `RdPlanSet`)
  await settingsPage.getByLabel('Break from').fill('12:30');
  await settingsPage.getByText('Settings saved').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await settingsPage.getByLabel('Break until').inputValue(), '14:00', 'конец перерыва прежний');
  await settingsPage.getByLabel('Gap between entries').fill('20');
  await settingsPage.getByLabel('Gap between entries').press('Enter');
  await page.waitForFunction(() => (
    document.querySelector('[data-settings-page="plan"] [data-settings-margin]')?.value === '20'
  ), undefined, { timeout: STEP_TIMEOUT_MS });
  // Напоминания: для событий по умолчанию и о сроках задач; «Запоминать мои правки»
  await settingsPage.locator('[data-settings-event-remind] select').selectOption('15');
  const deadlines = settingsPage.locator('[data-settings-deadlines]');
  await expectChecked(deadlines, 'false', 'о сроках по умолчанию не напоминает');
  await deadlines.click();
  await expectChecked(deadlines, 'true', 'напоминать о сроках включено');
  const learn = settingsPage.locator('[data-settings-learn]');
  await expectChecked(learn, 'true', 'правки запоминаются по умолчанию');
  await learn.click();
  await expectChecked(learn, 'false', 'запоминание правок выключено');
  await learn.click();
  await settingsPage.locator('[data-settings-learned-count]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closePlannerSettings(page);
  // Та же страница — из «Профиля → Модули» строкой «Plan settings» под модулем
  await openSettingsScreen(page, 'Modules');
  await page.locator('[data-module-settings="plan"]').click();
  settingsPage = page.locator('[data-settings-page="plan"]');
  assert.equal(await settingsPage.locator('[data-settings-event-remind] select').inputValue(), '15',
    'напоминание событий по умолчанию сохранено');
  await expectChecked(settingsPage.locator('[data-settings-deadlines]'), 'true');
  // Вернуть по умолчанию, чтобы дальше сценарий шёл с прежними значениями
  await settingsPage.locator('[data-settings-event-remind] select').selectOption('none');
  await settingsPage.locator('[data-settings-deadlines]').click();
  await settingsPage.getByLabel('Break from').fill('13:00');
  await settingsPage.getByLabel('Gap between entries').fill('15');
  await settingsPage.getByLabel('Gap between entries').press('Enter');
  await closePlannerSettings(page);
  console.log('OK: страница «Модули / План» — перерыв, запас, напоминания, «Запоминать мои правки», вход из «Профиля»');
  await openPlannerScreen(page, 'calendar');
  await viewButton('Week').click();
  await planner.locator('[data-planner-view="week"]').getByText('08', { exact: true })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await viewButton('Month').click();
  await todayCell.click({ position: { x: 10, y: 10 } });
  console.log('OK: настройки дня применяются к сетке дня');

  // ── Повторы (spec 011, US1) ───────────────────────────────────────────────
  const addDays = (key, delta) => {
    const [y, m, d] = key.split('-').map(Number);
    const date = new Date(y, m - 1, d + delta);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const weekdayShort = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  // Вид повтора — переключатель «Нет / День / Неделя / Месяц / Год» (DkPlanMore)
  const repeatSelect = () => ({
    selectOption: (kind) => planner.locator('[data-repeat-kind]').first().locator(`button[data-value="${kind}"]`).click(),
  });
  // Повтор в карточках: на телефоне — строка-сводка, настройки раскрываются по нажатию; на компьютере раскрыт всегда
  const openRepeat = async () => {
    if (await sidePane.locator('[data-repeat-kind]').count()) return;
    await sidePane.locator('[data-repeat-toggle]').first().click();
    await sidePane.locator('[data-repeat-kind]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  // День — в колонке слева у недели (у «Месяца» на компьютере её нет, доска `RdPlan`)
  const openDay = async (day) => {
    await pickPlannerDay(page, day);
    return dayPane;
  };
  // «Текущая дата» — кнопка шапки календаря; «Сегодня» (`Today`) — пункт переключателя вида
  const backToThisMonth = async () => {
    // Кнопки нет, когда выбран сегодняшний день
    const toToday = planner.getByRole('button', { name: 'Current date' });
    // Кнопка пропадает, как только выбранным становится сегодняшний день, — в том числе посреди нажатия
    if (await toToday.isVisible().catch(() => false)) await toToday.click({ timeout: 3000 }).catch(() => undefined);
  };
  // Еженедельное событие по сегодняшнему дню недели — стоит и через неделю
  await openPlannerScreen(page, 'calendar');
  await openFullForm();
  await sidePane.locator('[data-new-kind="event"]').click();
  // Форма перестраивается под событие: поля времени заполняются уже в новой раскладке
  await sidePane.getByText('All day', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#planner-new-name').fill('Йога');
  // Конец не задаётся: по умолчанию — через час после начала (spec 013, B6)
  await planner.getByLabel('Start', { exact: true }).fill('18:00');
  const endField = planner.getByLabel('End', { exact: true });
  for (let attempt = 0; attempt < 15 && await endField.inputValue() !== '19:00'; attempt++) await page.waitForTimeout(200);
  assert.equal(await endField.inputValue(), '19:00', 'конец события по умолчанию');
  // У селектов есть подписи (B7)
  await openRepeat();
  assert.ok(await sidePane.getByLabel('Repeat', { exact: true }).count(), 'у выбора повтора нет подписи');
  await repeatSelect().selectOption('weekly');
  // Чекбокс форка перехватывает клик своей подписью — кликаем по подписи
  await sidePane.getByText(weekdayShort, { exact: true }).click();
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: Йога').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  let aside = await openDay(addDays(today, 7));
  await aside.getByText('18:00 · 1 h').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await aside.innerText(), /Йога/, 'еженедельное событие стоит через неделю');
  await backToThisMonth();
  aside = await openDay(addDays(today, 1));
  assert.doesNotMatch(await aside.innerText(), /Йога/, 'завтра еженедельного события нет');
  // Ежемесячно 31-го — в коротком месяце последний день
  const [year, month] = today.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  const lastKey = `${today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
  await openFullForm();
  await sidePane.locator('[data-new-kind="event"]').click();
  await page.locator('#planner-new-name').fill('Аренда');
  await planner.getByLabel('Start', { exact: true }).fill('12:00');
  await planner.getByLabel('End', { exact: true }).fill('12:30');
  await openRepeat();
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
  await openRepeat();
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
  // Карточка отделённой записи осталась открытой на месте острова дня
  await closeSide();
  aside = await openDay(addDays(today, 1));
  await aside.getByText('10:30 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await aside.getByRole('button', { name: /Зарядка/ }).count(), 1, 'отделённый экземпляр — один');
  aside = await openDay(today);
  await aside.getByText('10:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Это и последующие»: с послезавтра — 09:00
  aside = await openDay(addDays(today, 2));
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('11:00');
  await planner.getByRole('button', { name: 'This and following' }).click();
  await planner.getByRole('button', { name: 'This and following' }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  aside = await openDay(addDays(today, 3));
  await aside.getByText('11:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Все в серии»: правка одного экземпляра меняет время у всех экземпляров его ряда
  aside = await openDay(addDays(today, 4));
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('12:00');
  // Выбор объёма (XpPlan): «Только это · <день>», «Это и последующие», «Все в серии», «Не повторять с этого дня»;
  // пояснение называет запись и новое время
  for (const scope of [/^Only this · /, 'This and following', 'All in series', 'Do not repeat from this day']) {
    await planner.getByRole('button', { name: scope, exact: typeof scope === 'string' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  assert.match(
    await planner.locator('[data-series-ask]').innerText(), /«Зарядка» repeats every day\. What should the new time 12:00 apply to\?/,
    'пояснение выбора объёма правки ряда',
  );
  await planner.getByRole('button', { name: 'All in series', exact: true }).click();
  await planner.getByRole('button', { name: 'All in series', exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  aside = await openDay(addDays(today, 3));
  await aside.getByText('12:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(addDays(today, 4));
  await aside.getByText('12:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(today);
  await aside.getByText('10:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Отделённый день (завтра, 10:30) правится «для всех»: меняется и ряд, от которого он отделён (сегодня)
  aside = await openDay(addDays(today, 1));
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByText('Detached from a series').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByLabel('Start', { exact: true }).fill('09:30');
  const copyPrompt = planner.locator('[data-series-prompt="copy"]');
  await copyPrompt.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(
    await copyPrompt.locator('[data-series-scope]').evaluateAll((items) => items.map((el) => el.dataset.seriesScope)),
    ['one', 'all'], 'у отделённого дня выбор — только он либо весь ряд',
  );
  await copyPrompt.getByRole('button', { name: 'All in series', exact: true }).click();
  await copyPrompt.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  aside = await openDay(addDays(today, 1));
  await aside.getByText('09:30 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  aside = await openDay(today);
  await aside.getByText('09:30 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Другой ряд (с послезавтра) правка не задела
  aside = await openDay(addDays(today, 3));
  await aside.getByText('12:00 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Правка ряда «все в серии» доходит и до отделённого дня
  aside = await openDay(today);
  await aside.getByRole('button', { name: /Зарядка/ }).first().click();
  await planner.getByLabel('Start', { exact: true }).fill('08:30');
  await planner.getByRole('button', { name: 'All in series', exact: true }).click();
  await planner.getByRole('button', { name: 'All in series', exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  aside = await openDay(addDays(today, 1));
  await aside.getByText('08:30 · 15 min').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await aside.getByRole('button', { name: /Зарядка/ }).count(), 1, 'отделённый день остался один');
  await backToThisMonth();
  console.log('OK: задача-ряд — выполнение по дню, «только это», «это и последующие», «все в серии», '
    + 'правка отделённого дня «для всех» и правка ряда до отделённых дней');

  // ── Описание ряда: всех повторов или только первого дня ───────────────────
  const scopeBox = sidePane.locator('[data-description-scope]');
  const createWeeklyEvent = async (name, text, start, isForAll) => {
    // Дата начала ряда берётся из выбранного дня
    await backToThisMonth();
    await openFullForm();
    await sidePane.locator('[data-new-kind="event"]').click();
    await sidePane.getByText('All day', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.locator('#planner-new-name').fill(name);
    await page.locator('#planner-new-description').fill(text);
    await planner.getByLabel('Start', { exact: true }).fill(start);
    // Галочки нет, пока запись не повторяется
    assert.equal(await scopeBox.count(), 0, 'у разовой записи галочки описания нет');
    await openRepeat();
  await repeatSelect().selectOption('weekly');
    await sidePane.getByText(weekdayShort, { exact: true }).click();
    await scopeBox.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    assert.equal(await scopeBox.getAttribute('data-description-scope'), 'all', 'по умолчанию описание — всех повторов');
    if (!isForAll) {
      await scopeBox.getByText('Description for every repetition', { exact: true }).click();
      await sidePane.locator('[data-description-scope="one"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    }
    await planner.getByRole('button', { name: 'Create', exact: true }).click();
    await planner.getByText(`Added: ${name}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  // Описание и состояние галочки в карточке события дня
  const readEventCard = async (day, name) => {
    const pane = await openDay(day);
    await pane.locator('button[data-kind="event"]').filter({ hasText: name }).first().click();
    const field = page.locator('#planner-event-description');
    await field.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    const card = {
      description: await field.inputValue(),
      scope: await scopeBox.count() ? await scopeBox.getAttribute('data-description-scope') : undefined,
      isDetached: Boolean(await sidePane.getByText('Detached from a series').count()),
    };
    await closeSide();
    await backToThisMonth();
    return card;
  };
  await createWeeklyEvent('Семинар', 'Принести ноутбук', '16:00', false);
  assert.deepEqual(
    await readEventCard(today, 'Семинар'), { description: 'Принести ноутбук', scope: 'one', isDetached: true },
    'описание «только этого дня» — у первого дня, отделённого от ряда',
  );
  assert.deepEqual(
    await readEventCard(addDays(today, 7), 'Семинар'), { description: '', scope: 'all', isDetached: false },
    'через неделю у повтора описания нет',
  );
  await createWeeklyEvent('Кружок', 'Взять тетрадь', '17:00', true);
  for (const day of [today, addDays(today, 7)]) {
    assert.deepEqual(
      await readEventCard(day, 'Кружок'), { description: 'Взять тетрадь', scope: 'all', isDetached: false },
      `описание «для всех повторов» видно в день ${day}`,
    );
  }
  aside = await openDay(today);
  assert.equal(
    await aside.locator('button[data-kind="event"]').filter({ hasText: 'Семинар' }).count(), 1,
    'в первый день ряда — одна запись, а не ряд и его копия',
  );
  await backToThisMonth();
  console.log('OK: описание ряда — «для всех повторов» и «только этого дня»');

  // ── Правило повтора правится из карточки экземпляра задачи ────────────────
  const shortWeekday = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
  };
  const repeatBox = sidePane.locator('[data-repeat-kind]');
  const openDetails = openRepeat;
  const countTasksOn = async (day, name) => {
    await backToThisMonth();
    const pane = await openDay(day);
    return pane.locator('button[data-kind="task"]').filter({ hasText: name }).count();
  };
  const openTaskOn = async (day, name) => {
    await backToThisMonth();
    const pane = await openDay(day);
    await pane.locator('button[data-kind="task"]').filter({ hasText: name }).first().click();
    await sidePane.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await openDetails();
  };
  const scopesOf = (prompt) => prompt.locator('[data-series-scope]')
    .evaluateAll((items) => items.map((el) => el.dataset.seriesScope));
  // Еженедельная задача по сегодняшнему дню недели
  await backToThisMonth();
  await openFullForm();
  await page.locator('#planner-new-name').fill('Бассейн');
  await planner.getByLabel('Duration, min').fill('20');
  await planner.getByLabel('Start', { exact: true }).fill('13:00');
  await openRepeat();
  await repeatSelect().selectOption('weekly');
  await sidePane.getByText(weekdayShort, { exact: true }).click();
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Бассейн' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  // У экземпляра выбор повтора на месте; другой день недели — «это и последующие» либо «все в серии»
  await openTaskOn(addDays(today, 7), 'Бассейн');
  await repeatBox.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await repeatBox.getAttribute('data-repeat-kind'), 'weekly', 'у экземпляра показано правило его ряда');
  const nextWeekdayShort = shortWeekday(addDays(today, 1));
  // Правило без дней недели словами не описывается — подпись под полями пропадает и возвращается с новым днём
  await repeatBox.getByText(weekdayShort, { exact: true }).click();
  await repeatBox.locator('[data-repeat-summary]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await repeatBox.getByText(nextWeekdayShort, { exact: true }).click();
  await repeatBox.locator('[data-repeat-summary]').getByText(`Every week: ${nextWeekdayShort}`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidePane.locator('[data-repeat-save]').click();
  const rulePrompt = planner.locator('[data-series-prompt="rule"]');
  await rulePrompt.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await scopesOf(rulePrompt), ['following', 'all'], 'одному дню своё правило не предлагается');
  await rulePrompt.getByRole('button', { name: 'This and following', exact: true }).click();
  await rulePrompt.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Сводка повтора сразу называет новое правило
  await sidePane.locator('[data-repeat-summary]').getByText(`Every week: ${nextWeekdayShort}`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  assert.equal(await countTasksOn(today, 'Бассейн'), 1, 'прежний экземпляр остался на месте');
  assert.equal(await countTasksOn(addDays(today, 1), 'Бассейн'), 0, 'до дня правки новое правило не действует');
  assert.equal(await countTasksOn(addDays(today, 7), 'Бассейн'), 0, 'с дня правки прежнего дня недели нет');
  assert.equal(await countTasksOn(addDays(today, 8), 'Бассейн'), 1, 'последующие идут по новому правилу');
  // «Не повторяется» у экземпляра: ряд кончается этим днём, сам день остаётся разовой задачей
  await openTaskOn(addDays(today, 15), 'Бассейн');
  await openRepeat();
  await repeatSelect().selectOption('none');
  await sidePane.locator('[data-repeat-save]').click();
  const stopPrompt = planner.locator('[data-series-prompt="stop"]');
  await stopPrompt.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await scopesOf(stopPrompt), ['stop', 'one']);
  await stopPrompt.getByRole('button', { name: 'Do not repeat from this day', exact: true }).click();
  await stopPrompt.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.getByText('Detached from a series').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  assert.equal(await countTasksOn(addDays(today, 8), 'Бассейн'), 1, 'дни до остановки остались');
  assert.equal(await countTasksOn(addDays(today, 15), 'Бассейн'), 1, 'день остановки — разовая задача');
  assert.equal(await countTasksOn(addDays(today, 22), 'Бассейн'), 0, 'после остановки ряда нет');
  await backToThisMonth();
  console.log('OK: правило повтора у экземпляра — «это и последующие», «не повторять с этого дня»');

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
  await closeSide();
  await dayPane.locator('[data-note-link="Конспект"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await dayPane.getByText('[[').count(), 0, 'скобок ссылки в названии на экране нет');
  await dayPane.locator('button[data-kind="task"]').filter({ hasText: 'Читать' }).click({ position: { x: 4, y: 4 } });
  await sidePane.getByRole('button', { name: 'Delete', exact: true }).click();
  await dayPane.locator('[data-note-link="Конспект"]').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: ссылка на заметку в названии записи');

  // ── Виды календаря и выбор месяца и года (spec 013, US2) ──────────────────
  const main = planner.locator('[data-planner-view]');
  await openPlannerScreen(page, 'calendar');
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
  // Доска `XdPlan`: легенда «меньше … больше» — в шапке справа; день с делами — ступень загрузки выше нуля,
  // наведение на клетку показывает записи дня
  await planner.locator('header [data-year-legend]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const yearToday = yearView.locator(`button[data-day="${today}"][data-level]`);
  assert.ok(Number(await yearToday.getAttribute('data-level')) > 0, 'у дня с делами ступень загрузки выше нуля');
  // Подсказка — записи дня (не больше шести) и «+N»
  assert.match(await yearToday.getAttribute('title'), /14:30 Созвон команды/, 'подсказка клетки года — записи дня');
  await yearView.getByText('Hover a day to see its entries', { exact: false })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Нажатие на день года открывает месяц этого дня
  const januaryDay = `${today.slice(0, 4)}-01-15`;
  await yearView.locator(`button[data-day="${januaryDay}"]`).click();
  await planner.locator(`[role="gridcell"][data-day="${januaryDay}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Дни соседних месяцев на компьютере — пустые клетки (доска `RdPlan`); сетка — полными неделями
  const gridDays = await planner.locator('[role="gridcell"]').evaluateAll((cells) => cells.map((cell) => cell.dataset.day));
  assert.ok(gridDays.every((day) => day.startsWith(januaryDay.slice(0, 7))), 'дни соседних месяцев с числами');
  const gridCells = await planner.locator('[role="grid"]').evaluate((grid) => grid.querySelectorAll('[data-day], [aria-hidden]').length);
  assert.equal(gridCells % 7, 0, 'сетка месяца — полными неделями');
  // Заголовок периода — выбор месяца и года
  await planner.locator('button[aria-haspopup="dialog"]').click();
  const picker = planner.getByRole('dialog', { name: 'Choose month and year' });
  await picker.getByRole('button', { name: 'Next year' }).click();
  await picker.locator('button[data-month="2"]').click();
  const nextMarch = `${Number(today.slice(0, 4)) + 1}-03-15`;
  await planner.locator(`[role="gridcell"][data-day="${nextMarch}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Current date' }).click();
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Вид «Список» (spec 018): повестка от выбранного дня, пустые дни пропущены
  await viewButton('List').click();
  const listView = planner.locator('[data-planner-view="agenda"]');
  const listToday = listView.locator(`section[data-day="${today}"]`);
  await listToday.getByText('Подготовить макет').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const listDays = await listView.locator('section[data-day]').evaluateAll((items) => items.map((el) => el.dataset.day));
  assert.deepEqual(listDays, [...listDays].sort(), 'дни списка идут по порядку');
  // Карточка события (DkPlanMore): крупно на месте вида, слева дела дня; поля сеткой «День / Начало / Длительность»,
  // «Напомнить / Группа», «Весь день» и «Праздник» переключателями; повтор раскрыт; правится по месту
  await listToday.getByRole('button', { name: /Созвон команды/ }).first().click();
  await sidePane.locator('[data-repeat-kind]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidePane.locator('[data-repeat-toggle]').count(), 0, 'на компьютере повтор раскрыт без строки-сводки');
  await planner.locator('[data-editor-day] [aria-current="true"]').filter({ hasText: 'Созвон команды' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(
    await planner.locator('[data-editor-day] [aria-current="true"]').innerText(), /14:30[\s\S]*Event · 30 min/,
    'строка дня слева: время, название, «Событие · длительность»',
  );
  await sidePane.getByText('Changes are saved as you type').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await sidePane.getByLabel('Duration', { exact: true }).inputValue(), '30 min', 'длительность события словами');
  for (const row of ['when', 'repeat', 'group', 'remind', 'description']) {
    assert.equal(await sidePane.locator(`[data-card-row="${row}"]`).count(), 1, `строка карточки ${row}`);
  }
  await sidePane.getByText('Holiday', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Шаг из формы нового события сохранился вместе с событием
  await sidePane.locator('[data-card-row="steps"]').getByText('Steps · 0/1')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidePane.locator('[data-card-row="steps"] label').filter({ hasText: 'Открыть повестку' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Событие правится без «Сохранить»: новая длительность пишется по уходу из поля
  assert.equal(await sidePane.getByRole('button', { name: 'Save', exact: true }).count(), 0, 'у события нет «Сохранить»');
  await sidePane.getByLabel('Duration', { exact: true }).fill('45 мин');
  await sidePane.getByLabel('Duration', { exact: true }).press('Enter');
  await planner.getByText('Event updated: Созвон команды').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-editor-day] [aria-current="true"]').getByText('Event · 45 min')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidePane.getByLabel('Duration', { exact: true }).fill('30');
  await sidePane.getByLabel('Duration', { exact: true }).press('Enter');
  await planner.locator('[data-editor-day] [aria-current="true"]').getByText('Event · 30 min')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  // Вид — настройка устройства: переживает перезагрузку (проверяется ниже)
  await viewButton('Week').click();
  await main.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: виды год, месяц, неделя, список; соседние дни; выбор месяца и года; «Повтор и детали»');

  // ── Событие на весь день и праздник; список с цветом из формы (US3, US4) ──
  await openFullForm();
  await viewButton('Month').click();
  const loadOf = async () => (await todayCell.getAttribute('aria-label')).match(/[\d.]+ h planned/)?.[0];
  const loadBefore = await loadOf();
  await sidePane.locator('[data-new-kind="event"]').click();
  await page.locator('#planner-new-name').fill('День города');
  await sidePane.getByText('All day', { exact: true }).click();
  await sidePane.getByText('Holiday', { exact: true }).click();
  // У события свой цвет (в список его не добавить)
  await sidePane.getByRole('radio', { name: 'Color 2' }).click();
  await sidePane.getByLabel('Start', { exact: true }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByText('Added: День города').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Колонка дня — у недели; клетки месяца — ниже
  await viewButton('Week').click();
  const cityDay = dayPane.locator('[data-all-day]').filter({ hasText: 'День города' });
  await cityDay.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cityDay.getAttribute('data-holiday'), '1', 'праздник отмечен в панели дня');
  const chipColor = await cityDay.evaluate((el) => getComputedStyle(el).getPropertyValue('--planner-list-color').trim());
  assert.ok(chipColor, 'у события с цветом нет цвета в панели дня');
  await viewButton('Month').click();
  // Праздник заливает клетку календаря цветом события (а не красит число), событие на весь день —
  // метка у числа
  assert.equal(await todayCell.getAttribute('data-holiday'), '1', 'клетка праздника не отмечена');
  const cellColors = await page.evaluate(([holidayDay, plainDay]) => [holidayDay, plainDay].map((day) => getComputedStyle(
    document.querySelector(`#ParvanePlanner [role="gridcell"][data-day="${day}"]`),
  ).backgroundColor), [today, tomorrowKey]);
  assert.notEqual(cellColors[0], cellColors[1], 'клетка праздника должна быть залита иначе, чем обычная');
  assert.equal(await todayCell.locator('[data-all-day-marks]').getAttribute('data-all-day-marks'), '1', 'метка события на весь день');
  assert.equal(await loadOf(), loadBefore, 'событие на весь день не входит в загрузку дня');
  await openFullForm();
  await page.locator('#planner-new-name').fill('Цветная задача');
  await page.locator('#planner-new-list').selectOption({ label: 'Create a group…' });
  await sidePane.getByLabel('New group').fill('Дом');
  await sidePane.getByRole('radio', { name: 'Color 3' }).click();
  await sidePane.getByRole('button', { name: 'Create group' }).click();
  await page.locator('#planner-new-list').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#planner-new-list')?.value === 'Дом', undefined, { timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.locator('#planner-new-list option').filter({ hasText: 'No group' }).count(), 1, '«Без списка» — один');
  await planner.getByRole('button', { name: 'Create', exact: true }).click();
  await planner.getByRole('heading', { name: 'Цветная задача' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeSide();
  await viewButton('Week').click();
  // Задача без времени — строкой в острове дня, несёт цвет списка
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
  await planner.locator('[data-all-day-fill]').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-week-allday.png` });
  console.log('OK: событие на весь день и праздник, список с цветом из формы, три статуса');

  // ── Данные переживают перезагрузку; возврат в мессенджер ──────────────────
  await page.waitForTimeout(1000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  // Раздел запоминается на вкладку: после перезагрузки открыт тот же «План», а не мессенджер
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), false, 'после перезагрузки открыт тот же раздел');
  await openPlannerScreen(page, 'calendar');
  // Вид «Неделя» запомнен устройством
  await planner.locator('[data-planner-view="week"]').waitFor({ state: 'visible', timeout: 30000 });
  // В клетке месяца только два превью, а порядок задач дня после перезагрузки не закреплён — смотрим панель дня
  await pickPlannerDay(page, today);
  await dayPane.getByText('Подготовить макет').first().waitFor({ state: 'visible', timeout: 30000 });
  await viewButton('Month').click();
  // Настройки тоже сохранены
  settingsPage = await openPlannerSettings(page);
  assert.equal(await settingsPage.getByLabel('Day starts').inputValue(), '08:00', 'начало дня после перезагрузки');
  await closePlannerSettings(page);
  await sidebar.getByRole('tab', { name: 'Chats' }).click();
  // Раздел после первого показа остаётся смонтированным и скрывается (E1): ждём `hidden`, не `detached`
  await planner.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await isShown(page, '#LeftColumn'), true, 'список чатов вернулся');
  console.log('OK: данные планировщика пережили перезагрузку, мессенджер возвращается');

  // ── Телефон: боковой панели нет, разделы — в нижней панели ────────────────
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  assert.equal(await isShown(page, '#FoldersSidebar'), false, 'на телефоне боковой панели нет');
  const tabBar = page.getByRole('navigation', { name: 'Modules' });
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const barGeometry = await page.evaluate(() => {
    const bar = document.querySelector('nav[aria-label="Modules"]').getBoundingClientRect();
    const list = document.querySelector('#LeftColumn').getBoundingClientRect();
    return { barTop: bar.top, barBottom: bar.bottom, listBottom: list.bottom, height: window.innerHeight };
  });
  assert.ok(Math.abs(barGeometry.barBottom - barGeometry.height) < 2, `панель должна стоять внизу: ${JSON.stringify(barGeometry)}`);
  assert.ok(barGeometry.listBottom <= barGeometry.barTop + 1, `список чатов не должен уходить под панель: ${JSON.stringify(barGeometry)}`);
  assert.equal(await tabBar.getByRole('button', { name: 'Chats' }).getAttribute('aria-current'), 'page');
  await tabBar.getByRole('button', { name: 'Plan', exact: true }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tabBar.getByRole('button', { name: 'Plan', exact: true }).getAttribute('aria-current'), 'page');
  const plannerBottom = await planner.evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(plannerBottom <= barGeometry.barTop + 1, `«План» не должен уходить под панель: ${plannerBottom}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  // Телефон: название модуля и виды чипами в шапке (доска `PhonePlan`); кнопки «+ Запись» нет — «+» над лентой
  const phoneViews = planner.getByRole('group', { name: 'Calendar view' });
  // В шапке помещаются три вида; «Год» и «Список» — в меню «⋯» рядом с поиском, «Задачами» и настройками
  assert.deepEqual(await phoneViews.getByRole('button').allInnerTexts(), ['Day', 'Week', 'Month'], 'виды календаря на телефоне');
  await planner.locator('[data-planner-more]').click();
  await page.locator('[role="menuitem"][data-action="year"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(
    await page.locator('[role="menuitem"][data-action]').evaluateAll((items) => items.map((item) => item.dataset.action)),
    ['agenda', 'year', 'search', 'tasks', 'settings'], 'меню «⋯» шапки телефона',
  );
  await page.keyboard.press('Escape');
  await page.locator('[role="menuitem"][data-action="year"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await planner.getByRole('button', { name: '+ Entry', exact: true }).count(), 0, 'на телефоне кнопки «+ Запись» нет');
  assert.equal(await planner.locator('header h1').innerText(), 'Plan', 'в шапке телефона — название модуля');
  // Месяц: день — карточкой ПОД сеткой месяца (расписание списком), вбок ничего не листается
  await todayCell.click({ position: { x: 10, y: 10 } });
  await planner.locator(`[data-planner-day="${today}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const layout = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#ParvanePlanner [role="gridcell"]')].map((el) => el.getBoundingClientRect());
    const card = document.querySelector('#ParvanePlanner [data-planner-day]');
    return {
      gridBottom: Math.max(...cells.map((cell) => cell.bottom)),
      cardTop: card.getBoundingClientRect().top,
      blocks: [...card.querySelectorAll('[data-block]')].map((el) => el.textContent),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  assert.ok(layout.cardTop >= layout.gridBottom - 1, `день должен стоять под месяцем: ${JSON.stringify(layout)}`);
  assert.ok(layout.overflow <= 0, `страница не должна листаться вбок: ${JSON.stringify(layout)}`);
  assert.ok(layout.blocks.some((text) => text.includes('Подготовить макет')) && layout.blocks.some((text) => text.includes('Созвон команды')),
    `в расписании дня должны быть задача и событие: ${JSON.stringify(layout.blocks)}`);
  assert.equal(await planner.locator('[data-day-timeline]').count(), 0, 'горизонтальной шкалы дня больше нет');
  // Событие на весь день — строкой расписания
  await dayPane.locator('[data-all-day]').filter({ hasText: 'День города' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone.png` });
  // День под месяцем (доска `PhPlanMore`): подпись «Воскресенье, 15 ноября» и плотные строки «время · название ·
  // длительность»; задача без времени — «—»; кнопки «Добавить на этот день» нет — запись создаёт «+»
  assert.match(await dayPane.locator('[data-block]').filter({ hasText: 'Подготовить макет' }).innerText(),
    /14:00\s+Подготовить макет\s+1 h 30 min/, 'строка дня под месяцем — время, название, длительность');
  assert.equal(await dayPane.getByRole('button', { name: 'Add to this day' }).count(), 0, 'кнопки «Добавить на этот день» нет');
  // Новое дело: «+» над лентой → «Подробнее» в окне ввода; форма — на весь экран
  await page.getByRole('button', { name: 'New entry in the plan' }).click();
  await page.locator('form[data-quick-kind]').getByRole('button', { name: 'More options' }).click();
  await sidePane.locator('#planner-new-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const sheet = await page.evaluate(() => {
    const pane = document.querySelector('#ParvanePlanner [data-planner-side]').getBoundingClientRect();
    const root = document.querySelector('#ParvanePlanner').getBoundingClientRect();
    return {
      paneBottom: pane.bottom, rootBottom: root.bottom, viewBottom: window.innerHeight, paneWidth: pane.width, rootWidth: root.width,
    };
  });
  assert.ok(sheet.paneBottom >= sheet.rootBottom - 2 && sheet.paneBottom <= sheet.viewBottom + 2
    && Math.abs(sheet.paneWidth - sheet.rootWidth) < 2,
    `форма на телефоне — на весь экран: ${JSON.stringify(sheet)}`);
  await sidePane.locator('#planner-new-name').fill('С телефона');
  await sidePane.getByRole('button', { name: 'Create', exact: true }).click();
  await sidePane.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await dayPane.getByText('С телефона').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Вид «День» на телефоне (доска `PhonePlan`): полоса дней, под ней день списком — дела по времени и задачи
  // без времени; вбок ничего не листается
  await phoneViews.getByRole('button', { name: 'Day', exact: true }).click();
  const phoneDay = (day) => planner.locator(`[data-planner-today="${day}"]`);
  await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await dayPane.count(), 0, 'в виде «День» отдельной панели дня нет');
  const strip = planner.locator('[data-day-strip]');
  const stripDays = strip.locator('button');
  const pickedStripDay = strip.locator('button[aria-pressed="true"]');
  // Лента дней: несколько недель, на экране — семь дней
  const stripCount = await stripDays.count();
  assert.ok(stripCount > 7, `в ленте больше недели: ${stripCount}`);
  assert.equal(await pickedStripDay.getAttribute('data-day'), today, 'в полосе выбран сегодняшний день');
  assert.equal(await stripDays.locator('[data-load]').count(), stripCount, 'у каждого дня ленты — отметка загрузки');
  const visibleStripDays = () => strip.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return [...node.querySelectorAll('button')].filter((item) => {
      const rect = item.getBoundingClientRect();
      return rect.left >= box.left - 1 && rect.right <= box.right + 1;
    }).map((item) => item.dataset.day);
  });
  const shownDays = await visibleStripDays();
  assert.equal(shownDays.length, 7, `на экране семь дней ленты: ${shownDays}`);
  assert.ok(shownDays.includes(today), 'выбранный день виден в ленте');
  // Задача без времени — в «Без времени», дела со временем — строками «По времени»
  await phoneDay(today).locator('[data-today-untimed]').getByText('С телефона').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneDay(today).locator('[data-today-schedule] [data-block]').filter({ hasText: 'Подготовить макет' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Подпись строки «По времени» (доска `PhonePlan`): «Задача · 1 ч 30 мин», не интервал; заголовок дня — «Сегодня, вс 15 ноября»
  assert.match(
    await phoneDay(today).locator('[data-today-schedule] [data-block]').filter({ hasText: 'Подготовить макет' })
      .locator('[data-block-caption]').innerText(),
    /^Task · 1 h 30 min/, 'подпись строки дня — вид и длительность',
  );
  assert.match(await phoneDay(today).innerText(), /Today, \w{3} /, 'заголовок дня — «Сегодня, вс 15 ноября»');
  const dayGeometry = await page.evaluate(() => {
    const stripBox = document.querySelector('#ParvanePlanner [data-day-strip]').getBoundingClientRect();
    const list = document.querySelector('#ParvanePlanner [data-planner-today]');
    return {
      stripLeft: stripBox.left, stripRight: stripBox.right, stripBottom: stripBox.bottom,
      listTop: list.getBoundingClientRect().top, listOverflow: list.scrollWidth - list.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  assert.ok(dayGeometry.stripLeft >= 0 && dayGeometry.stripRight <= 390, `полоса дней должна помещаться в экран: ${JSON.stringify(dayGeometry)}`);
  assert.ok(dayGeometry.stripBottom <= dayGeometry.listTop + 1, `день должен стоять под полосой: ${JSON.stringify(dayGeometry)}`);
  assert.ok(dayGeometry.listOverflow <= 1 && dayGeometry.pageOverflow <= 0, `вбок ничего не должно листаться: ${JSON.stringify(dayGeometry)}`);
  // Нажатие на день полосы выбирает его
  const otherDay = shownDays.find((day) => day !== today);
  await strip.locator(`button[data-day="${otherDay}"]`).click();
  await phoneDay(otherDay).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await pickedStripDay.getAttribute('data-day'), otherDay, 'нажатие на день полосы выбирает его');
  await strip.locator(`button[data-day="${today}"]`).click();
  await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Прокрутка ленты листает дни, но выбранный день не меняет
  await strip.evaluate((node) => { node.scrollLeft += node.clientWidth; });
  await page.waitForTimeout(500);
  const scrolledDays = await visibleStripDays();
  assert.ok(!scrolledDays.includes(today), `лента пролистана на неделю: ${scrolledDays}`);
  assert.equal(await pickedStripDay.getAttribute('data-day'), today, 'прокрутка ленты не меняет выбранный день');
  await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Горизонтальный жест по дню листает дни (жест собирается из событий касания: мыши он не слушается)
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
  const canSwipe = await swipe('#ParvanePlanner [data-today-tasks]', 300, 80);
  if (canSwipe) {
    await phoneDay(tomorrowKey).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await swipe('#ParvanePlanner [data-today-tasks]', 80, 300);
    await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    console.log('OK: телефон — жест листает дни');
  } else {
    console.log('SKIP: событий касания в этом браузере нет — листание жестом не проверено');
  }
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone-day.png` });
  // Вид «Неделя» на телефоне (доска `XpPlan`): семь дней строками с делами; число открывает день
  await phoneViews.getByRole('button', { name: 'Week', exact: true }).click();
  const phoneWeek = planner.locator('[data-planner-view="week"]');
  await phoneWeek.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await phoneWeek.locator('[data-week-day]').count(), 7, 'в неделе семь дней');
  await phoneWeek.locator(`[data-week-day="${today}"]`).getByText('Подготовить макет').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone-week.png` });
  await phoneWeek.locator(`[data-week-day="${today}"] button[data-day="${today}"]`).first().click();
  await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Год на телефоне (доска `XpPlan`): подпись и легенда под сеткой; нажатие на месяц открывает «Месяц»
  await openPlannerHeader(page, 'year');
  const phoneYear = planner.locator('[data-planner-view="year"]');
  await phoneYear.locator('[data-year-legend]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneYear.getByText('Tap a month to open it', { exact: false }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneYear.locator(`section[data-month="${today.slice(0, 7)}"] > button`).click();
  await planner.locator(`[role="gridcell"][data-day="${today}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await phoneViews.locator('button[aria-pressed="true"]').innerText(), 'Month', 'месяц года открыл «Месяц»');
  // «Список» на телефоне (доска `RpPlan`): от сегодня, заголовки «Today, Sun 15 November», подписи «Task · 30 min»,
  // подсказка о 30 днях; панели групп нет
  await openPlannerHeader(page, 'agenda');
  const phoneList = planner.locator('[data-planner-view="agenda"]');
  await phoneList.locator(`section[data-day="${today}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.match(await phoneList.locator(`section[data-day="${today}"] > button`).innerText(), /^Today, /i, 'заголовок дня списка (прописными, как .cap доски)');
  assert.match(
    await phoneList.locator('[data-block-caption]').filter({ hasText: /^Task/ }).first().innerText(), /^Task( · |$)/,
    'подпись задачи в списке — «Задача · …»',
  );
  await phoneList.locator('[data-agenda-hint]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await phoneList.locator('[data-group-bar]').count(), 0, 'панели групп над списком на телефоне нет');
  await phoneViews.getByRole('button', { name: 'Day', exact: true }).click();
  await phoneDay(today).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Название задачи правится нажатием на него (17 окт 2026: на телефоне нажатие ничего не делало)
  await phoneDay(today).locator('[data-today-untimed]').getByText('С телефона').first().click();
  await sidePane.locator('[data-task-name]').click();
  const renameInput = sidePane.locator('#planner-task-name');
  await renameInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await renameInput.inputValue(), 'С телефона', 'в поле — прежнее название');
  await renameInput.fill('Позвонить с телефона');
  await renameInput.press('Enter');
  await sidePane.getByRole('heading', { name: 'Позвонить с телефона' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Карточка записи на телефоне закрывает ленту модулей
  assert.equal(await tabBar.isVisible(), false, 'под карточкой записи ленты модулей нет');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/planner-phone-rename.png` });
  await closeSide();
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneDay(today).locator('[data-today-untimed]').getByText('Позвонить с телефона').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — название задачи меняется нажатием на него');
  await phoneViews.getByRole('button', { name: 'Month', exact: true }).click();
  await todayCell.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Настройки — страница «Модули / План»; на телефоне сверху слои календаря (доска `RpPlan`): «События» заблокированы
  // включёнными, «Задачи» прячут задачи дня; слои «Здоровья» — из модуля
  settingsPage = await openPlannerSettings(page);
  await settingsPage.getByLabel('Day starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const eventsLayer = settingsPage.locator('[data-layer="events"]');
  await expectChecked(eventsLayer, 'true', 'события на телефоне видны всегда');
  assert.equal(await eventsLayer.isDisabled(), true, 'выключатель событий заблокирован');
  const tasksLayer = settingsPage.locator('[data-layer="tasks"]');
  await tasksLayer.click();
  await expectChecked(tasksLayer, 'false', 'слой задач выключен');
  await closePlannerSettings(page);
  await phoneViews.getByRole('button', { name: 'Day', exact: true }).click();
  await phoneDay(today).locator('[data-today-untimed]').getByText('Позвонить с телефона')
    .waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  settingsPage = await openPlannerSettings(page);
  await settingsPage.locator('[data-layer="tasks"]').click();
  await closePlannerSettings(page);
  await phoneDay(today).locator('[data-today-untimed]').getByText('Позвонить с телефона').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneViews.getByRole('button', { name: 'Month', exact: true }).click();
  console.log('OK: телефон — виды в шапке, день под месяцем, форма на весь экран, «День» с полосой дней, неделя списком');
  // «+» нижней панели открывает ввод текстом прямо в «Плане» (spec 017, сценарий quick_input)
  await page.locator('[data-add-for]').click();
  await page.locator('#planner-quick-input').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closeByEscape(page.locator('#planner-quick-input'), 'окно ввода');
  // «Профиль» — главный экран настроек; во вложенном экране и в открытом чате панели нет
  await tabBar.getByRole('button', { name: 'Profile' }).click();
  // Раздел после первого показа остаётся смонтированным и скрывается (E1): ждём `hidden`, не `detached`
  await planner.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await tabBar.getByRole('button', { name: 'Profile' }).getAttribute('aria-current'), 'page');
  // «Профиль» (spec 041 E3): аккаунт первым блоком, разделы списком; «Оформление» — экран с цветовыми
  // схемами и режимом, «назад» возвращает к списку разделов
  const profile = page.locator('[data-profile-menu="list"]');
  await profile.locator('[data-profile-head="phone"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const id of ['modules', 'appearance', 'devices', 'privacy', 'data', 'messenger', 'about']) {
    await profile.locator(`[data-profile-item="${id}"]`).waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  }
  await profile.locator('[data-profile-item="appearance"]').click();
  const schemes = page.getByRole('radiogroup', { name: 'Color scheme' });
  await schemes.getByRole('radio', { name: 'Nord' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await page.getByRole('group', { name: 'Mode' }).getByRole('button').count(), 3, 'режим: как в системе, светлая, тёмная');
  await page.keyboard.press('Escape');
  await schemes.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await profile.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await tabBar.getByRole('button', { name: 'Chats' }).click();
  assert.ok(await isShown(page, '#LeftColumn'), '«Чаты» возвращают к списку');
  await tabBar.locator('button[aria-current="page"]', { hasText: 'Chats' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // На списке чатов «+» — меню: новое сообщение, группа, канал, запись в план; карандаша Telegram нет
  await page.locator('[data-add-for]').click();
  // Меню «+» раскрывается у плавающей кнопки, вне ленты
  const addMenu = page;
  for (const item of ['New Message', 'New Group', 'New Channel', 'Plan entry']) {
    await addMenu.getByRole('menuitem', { name: item }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  assert.equal(await page.locator('#LeftColumn .NewChatButton button:visible').count(), 0, 'карандаша на телефоне нет');
  // Меню помещается в экран
  const menuBox = await addMenu.getByRole('menuitem', { name: 'Plan entry' }).boundingBox();
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `меню «+» выходит за экран: ${JSON.stringify(menuBox)}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/plus-menu-phone.png` });
  await addMenu.getByRole('menuitem', { name: 'Plan entry' }).click();
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
