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

try {
  const user = `planner-${Date.now().toString(36)}@local`;
  const { page } = await preparePage(context, user, PASSWORD);
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

  // ── Данные переживают перезагрузку; возврат в мессенджер ──────────────────
  await page.waitForTimeout(1000);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await isShown(page, '#LeftColumn'), true, 'после перезагрузки открыт мессенджер');
  await sidebar.getByRole('tab', { name: 'Planner' }).click();
  await todayCell.getByText('14:00 Подготовить макет').waitFor({ state: 'visible', timeout: 30000 });
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
} finally {
  await browser.close();
}
