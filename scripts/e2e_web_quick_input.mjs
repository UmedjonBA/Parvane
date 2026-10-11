// Ввод текстом в «Плане» (spec 017): на телефоне «+» нижней панели открывает строку ввода,
// распознанное видно чипами, запись создаётся одной строкой и переживает перезагрузку.
// Запуск: scripts/run_web_quick_input_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  relogin,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-quick-e2e-1';
const PHONE = { width: 390, height: 800 };
const WIDE = { width: 1600, height: 900 };
const STEP_TIMEOUT_MS = 15000;

function dayKey(delta = 0) {
  const date = new Date();
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: PHONE });
let session;

try {
  const user = `quick-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const tabBar = page.getByRole('navigation', { name: 'Sections' });
  const input = page.locator('#planner-quick-input');
  const form = page.locator('form[data-quick-kind]');
  const chip = (field) => form.locator(`[data-quick-chip="${field}"]`);
  const addButton = form.getByRole('button', { name: 'Add', exact: true });

  const openQuick = async () => {
    await tabBar.getByRole('button', { name: 'New entry' }).click();
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const expectKind = async (kind) => {
    await page.waitForFunction(
      (expected) => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === expected,
      kind,
      { timeout: STEP_TIMEOUT_MS },
    );
  };
  const submit = async (name) => {
    await addButton.click();
    await planner.getByText(`Added: ${name}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  };

  // ── «+» из списка чатов открывает «План» и строку ввода ───────────────────
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await openQuick();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await addButton.isDisabled(), true, 'пустую строку добавить нельзя');
  console.log('OK: «+» нижней панели открывает ввод текстом в «Плане»');

  // ── Событие: дата, время и длительность видны чипами ──────────────────────
  await input.fill('Быстрый созвон завтра 16:00 45 мин');
  await expectKind('event');
  assert.equal((await chip('time').innerText()).trim(), '16:00–16:45');
  assert.equal(await chip('day').count(), 1, 'дата распознана');
  assert.equal((await form.locator('[dir="auto"]').first().innerText()).trim(), 'Быстрый созвон');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/quick-input-phone.png` });
  await submit('Быстрый созвон');
  console.log('OK: событие одной строкой — время и длительность распознаны');

  // ── «Сегодня» на телефоне: карточки, расписание дня, задачи — одной колонкой (spec 018) ──
  await planner.locator('header').getByText('Today', { exact: true }).first().click();
  const todayView = planner.locator('[data-planner-today]');
  await todayView.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const order = await todayView.evaluate((el) => {
    const top = (selector) => el.querySelector(selector)?.getBoundingClientRect().top;
    return { cards: top('[data-today-card]'), tasks: top('[data-today-tasks]'), width: el.scrollWidth - el.clientWidth };
  });
  assert.ok(order.cards < order.tasks, `карточки стоят выше задач: ${JSON.stringify(order)}`);
  assert.ok(order.tasks - order.cards > 150, `между карточками и задачами — расписание дня: ${JSON.stringify(order)}`);
  assert.ok(order.width <= 1, `экран не шире телефона: ${JSON.stringify(order)}`);
  assert.equal(await planner.locator('[data-planner-day]').count(), 0, 'отдельной панели дня на телефоне нет');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/today-phone.png` });
  console.log('OK: «Сегодня» на телефоне — карточки, расписание, задачи');

  // ── Снятый чип возвращает слова в название; ошибка не даёт добавить ───────
  await openQuick();
  await input.fill('звонок завтра');
  await expectKind('task');
  await chip('day').getByRole('button').click();
  await chip('day').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal((await form.locator('[dir="auto"]').first().innerText()).trim(), 'звонок завтра');
  await input.fill('завтра 15:00');
  await expectKind('event');
  await form.getByRole('alert').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await addButton.isDisabled(), true, 'запись без названия добавить нельзя');
  // Выбор типа сильнее слов: время становится началом задачи
  await input.fill('разбор почты 18:00');
  await expectKind('event');
  await form.getByRole('radio', { name: 'Task' }).click();
  await expectKind('task');
  await form.getByRole('radio', { name: 'Auto' }).click();
  console.log('OK: чип снимается, ошибка блокирует добавление, тип выбирается вручную');

  // ── Задача со сроком и задача без даты; Enter добавляет ───────────────────
  await input.fill('задача сдать отчёт до пт');
  await expectKind('task');
  assert.match((await chip('due').innerText()).trim(), /^due /);
  await submit('сдать отчёт');
  await openQuick();
  await input.fill('купить кабель');
  await expectKind('task');
  assert.equal(await form.locator('[data-quick-chip]').count(), 0, 'у задачи без даты нет чипов');
  await input.press('Enter');
  await planner.getByText('Added: купить кабель').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: задача со сроком и задача без даты');

  // ── Повтор; «Подробнее» ведёт в полную форму ──────────────────────────────
  await openQuick();
  await input.fill('урок вт 15:00 каждую неделю 5 мес');
  await expectKind('event');
  assert.match((await chip('repeat').innerText()).trim(), /Tue/);
  assert.equal((await chip('time').innerText()).trim(), '15:00–16:00');
  await submit('урок');
  await openQuick();
  await form.getByRole('button', { name: 'More options' }).click();
  await planner.locator('#planner-new-name').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: событие с повтором; «Подробнее» открывает полную форму');

  // ── Записи пережили перезагрузку ──────────────────────────────────────────
  await page.waitForTimeout(1000);
  await page.setViewportSize(WIDE);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  const sidebar = page.locator('#FoldersSidebar');
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Planner' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «План» помнит вкладку, на которой пользователь был в последний раз
  await planner.locator('[data-planner-today]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('header').getByText('Calendar', { exact: true }).first().click();
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Month', exact: true }).click();
  await planner.locator(`[role="gridcell"][data-day="${dayKey(1)}"]`).click({ position: { x: 10, y: 10 } });
  await planner.locator('[data-planner-day]').getByText('Быстрый созвон').first()
    .waitFor({ state: 'visible', timeout: 30000 });
  // Задачи без даты — в шторке «Без даты» экрана «Сегодня»
  await planner.locator('header').getByText('Today', { exact: true }).first().click();
  await planner.locator('[data-today-undated]').click();
  const undatedSheet = page.locator('[data-planner-undated]');
  await undatedSheet.getByText('сдать отчёт').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await undatedSheet.getByText('купить кабель').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await undatedSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // На компьютере ввод открывается кнопкой в шапке
  await planner.getByRole('button', { name: 'Quick entry' }).click();
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  console.log('OK: записи пережили перезагрузку; на компьютере есть «Быстрый ввод»');

  console.log('e2e_web_quick_input: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${dir}/quick-input-failure.png` }).catch(() => {});
    console.log(`--- планировщик при сбое ---\n${await page?.locator('#ParvanePlanner').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
