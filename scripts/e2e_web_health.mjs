// Модуль «Здоровье» (spec 038, 041; правила HEALTH-1…3). Запись одной строкой: под полем видно, как понял
// движок, до сохранения; непонятое остаётся в поле. Сводка (сон, показатели, цель) приходит из движка.
// Записи лежат в своём контейнере на сервере: переживают перезагрузку и видны второму устройству аккаунта.
// Запуск: scripts/run_web_health_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  openHealthModule,
  preparePage,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-health-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;

const browser = await chromium.launch();
const sessions = {};

const card = (health, kind) => health.locator(`[data-health-card="${kind}"]`);
const quickInput = (health) => health.locator('[data-health-quick] input');

async function expectValue(health, kind, text) {
  await card(health, kind).locator('[data-health-value]').filter({ hasText: text })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

// Ввести строку, дождаться разбора нужного вида и сохранить клавишей Enter
async function addLine(health, text, kind) {
  const input = quickInput(health);
  await input.fill(text);
  await health.locator(`[data-health-preview] [data-kind="${kind}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.press('Enter');
}

try {
  const user = `health-${Date.now().toString(36)}@local`;
  const context = await browser.newContext({ viewport: WIDE });
  sessions.first = await preparePage(context, user, PASSWORD);
  const { page } = sessions.first;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // ── Первое открытие: подсказка и примеры; пример подставляется в строку ───
  const health = await openHealthModule(page);
  await health.locator('[data-health-status="ready"]').or(page.locator('#ParvaneHealth[data-health-status="ready"]'))
    .first().waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await health.locator('[data-health-first]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Блок «Вода» включается прямо с первого экрана — плитка появляется сразу
  await health.locator('[data-health-first] [data-block="water"]').click();
  await card(health, 'water').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-first]').getByRole('button', { name: '72 kg' }).click();
  await page.waitForFunction(() => document.querySelector('[data-health-quick] input')?.value === '72 kg', undefined, { timeout: STEP_TIMEOUT_MS });
  const preview = health.locator('[data-health-preview]');
  await preview.locator('[data-kind="weight"]').filter({ hasText: '72.0' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: первое открытие — пример подставлен, под полем видно, как понято');

  // ── Запись: Enter сохраняет понятое, плитка показывает значение ───────────
  await quickInput(health).press('Enter');
  await expectValue(health, 'weight', '72.0');
  await health.locator('[data-health-first]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('[data-health-quick] input')?.value === '', undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: запись сохранена, плитка веса показывает значение');

  // ── Вода: прибавки кнопками складываются за день ─────────────────────────
  await card(health, 'water').locator('[data-health-action="glass"]').click();
  await expectValue(health, 'water', '250');
  await card(health, 'water').locator('[data-health-action="bottle"]').click();
  await expectValue(health, 'water', '750');
  console.log('OK: вода — стакан и бутылка сложены за день');

  // ── Непонятое остаётся в поле, понятое записывается ───────────────────────
  await quickInput(health).fill('давление 125 на 82 абракадабра');
  await preview.locator('[data-kind="pressure"]').filter({ hasText: '125/82' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await preview.locator('[data-unparsed]').filter({ hasText: 'абракадабра' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickInput(health).press('Enter');
  await expectValue(health, 'pressure', '125/82');
  await page.waitForFunction(() => document.querySelector('[data-health-quick] input')?.value === 'абракадабра', undefined, { timeout: STEP_TIMEOUT_MS });
  await quickInput(health).fill('');
  console.log('OK: непонятое осталось в поле, давление записано');

  // ── Несколько фактов в одной строке; шаги суммируются за день ─────────────
  await addLine(health, 'прошёл 3000 шагов, пульс 64', 'steps');
  await expectValue(health, 'pulse', '64');
  await addLine(health, '5400 шагов', 'steps');
  await expectValue(health, 'steps', '8,400');
  console.log('OK: несколько записей одной строкой, шаги сложены за день');

  // ── Сон: «лёг вчера, встал сегодня» — одна ночь, день пробуждения ─────────
  await addLine(health, 'позавчера лёг в 23:30, вчера встал в 7', 'sleep');
  await card(health, 'sleep').locator('[data-health-sleep-total]').filter({ hasText: '7 h 30 min' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card(health, 'sleep').getByText('23:30 → 07:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Кнопка «Ложусь»: отметка без пары, повторно лечь нельзя, пока не встал
  const bed = card(health, 'sleep').locator('[data-health-action="bed"]');
  await bed.click();
  await page.waitForFunction(() => document.querySelector('[data-health-action="bed"]')?.disabled === true, undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: сон записан одной ночью; «Ложусь» ждёт «Встал»');

  // ── Подробный экран: цель веса и отклонение от неё ────────────────────────
  await card(health, 'weight').click();
  const detail = health.locator('[data-health-detail="weight"]');
  await detail.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const goal = detail.locator('[data-health-goal="weight"]');
  await goal.fill('70');
  await goal.blur();
  await detail.locator('[data-health-to-goal]').filter({ hasText: '+2' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Режим сна: цель «лечь / встать» даёт отклонение последней ночи
  await health.getByRole('button', { name: 'Back' }).click();
  await card(health, 'sleep').getByRole('button', { name: 'Open sleep' }).click();
  const sleepDetail = health.locator('[data-health-detail="sleep"]');
  await sleepDetail.locator('[data-health-goal="sleep_bed"]').fill('23:00');
  await sleepDetail.locator('[data-health-goal="sleep_bed"]').blur();
  await sleepDetail.locator('[data-health-goal="sleep_wake"]').fill('07:00');
  await sleepDetail.locator('[data-health-goal="sleep_wake"]').blur();
  await sleepDetail.getByText('30 min less than the goal').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.getByRole('button', { name: 'Back' }).click();
  console.log('OK: цель веса и цель режима сна считаются движком');

  // ── Правка записи: значение вне диапазона не принимается, верное — сохраняется ─
  const entries = health.locator('[data-health-entries]');
  await entries.locator('[data-kind="pulse"] [data-health-entry-edit]').click();
  const sheet = page.locator('[data-health-sheet="pulse"]');
  await sheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const valueField = sheet.locator('[data-health-field="value"]');
  await page.waitForFunction(() => document.querySelector('[data-health-field="value"]')?.value === '64', undefined, { timeout: STEP_TIMEOUT_MS });
  await valueField.fill('900');
  await page.locator('[data-health-save]').click();
  await page.locator('[data-health-problem="value"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await valueField.fill('66');
  await sheet.locator('[data-health-field="note"]').fill('после прогулки');
  await page.locator('[data-health-save]').click();
  await sheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await expectValue(health, 'pulse', '66');
  await entries.locator('[data-kind="pulse"]').getByText('после прогулки').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: запись правится в окне, значение вне диапазона отклонено');

  // ── Самочувствие шкалой из пяти точек ─────────────────────────────────────
  await card(health, 'mood').click();
  const scale = health.locator('[data-health-mood-scale]');
  await scale.locator('[data-score="4"]').click();
  await scale.locator('[data-health-mood-save]').click();
  await health.locator('[data-health-detail="mood"] [data-health-entries] [data-kind="mood"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.getByRole('button', { name: 'Back' }).click();
  await card(health, 'mood').getByText('4 of 5').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: самочувствие записано шкалой');

  // ── Дневной сон формой: позавчера, час — в неделе сна у этого дня 1:00 ────
  const napDay = await page.evaluate(() => {
    const date = new Date(Date.now() - 2 * 86400000);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });
  await card(health, 'sleep').getByRole('button', { name: 'Open sleep' }).click();
  await health.locator('[data-health-action="nap"]').click();
  const napSheet = page.locator('[data-health-sheet="sleep"]');
  await napSheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await napSheet.locator('[data-health-field="day"]').fill(napDay);
  await napSheet.locator('[data-health-span]').filter({ hasText: '1 h 0 min' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-health-save]').click();
  await napSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await health.locator(`[data-health-card="sleep"] [data-day="${napDay}"]`).filter({ hasText: '1:00' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.getByRole('button', { name: 'Back' }).click();
  console.log('OK: дневной сон добавлен формой');

  // ── Удаление записи: сумма шагов пересчитана ──────────────────────────────
  await entries.locator('[data-kind="steps"]').filter({ hasText: '5,400' }).getByRole('button', { name: /^Delete entry/ }).click();
  await expectValue(health, 'steps', '3,000');
  console.log('OK: запись удалена, сумма дня пересчитана');

  // ── Строка ввода «Плана»: показатель тела уходит в «Здоровье», а не в «План» ─
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Planner', exact: true }).click();
  await page.locator('#FoldersSidebar').getByRole('button', { name: 'New entry' }).click();
  const plannerInput = page.locator('#planner-quick-input');
  await plannerInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await plannerInput.fill('вес 73,5');
  await plannerInput.press('Enter');
  await plannerInput.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await expectValue(await openHealthModule(page), 'weight', '73.5');
  console.log('OK: вес из строки ввода «Плана» записан в «Здоровье»');

  // ── Перезагрузка: данные на сервере, а не во вкладке ──────────────────────
  await reloadPage(page);
  const reloaded = await openHealthModule(page);
  await expectValue(reloaded, 'weight', '73.5');
  await expectValue(reloaded, 'steps', '3,000');
  await card(reloaded, 'sleep').locator('[data-health-sleep-total]').filter({ hasText: '7 h 30 min' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: записи пережили перезагрузку');

  // ── Второе устройство аккаунта: после привязки видит те же записи ─────────
  const secondContext = await browser.newContext({ viewport: WIDE });
  sessions.second = await preparePage(secondContext, user, PASSWORD);
  await linkSecondDevice(page, sessions.second.page);
  const other = await openHealthModule(sessions.second.page);
  await expectValue(other, 'weight', '73.5');
  await expectValue(other, 'pressure', '125/82');
  // Запись со второго устройства доезжает до первого
  await addLine(other, 'вес 71,6', 'weight');
  await expectValue(other, 'weight', '71.6');
  await openHealthModule(page);
  await expectValue(page.locator('#ParvaneHealth'), 'weight', '71.6');
  console.log('OK: второе устройство видит записи и пишет свои');

  // ── Телефон: модуль в ленте, «+» ставит курсор в строку ввода ─────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Chats' }).click();
  const phoneHealth = await openHealthModule(page);
  await page.locator('[data-add-for="health"]').click();
  await page.waitForFunction(() => document.activeElement?.closest('[data-health-quick]'), undefined, { timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  await expectValue(phoneHealth, 'weight', '71.6');
  console.log('OK: телефон — модуль в ленте, «+» открывает строку ввода');

  assertNoPageErrors(sessions);
  console.log('OK: модуль «Здоровье»');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  for (const [name, session] of Object.entries(sessions)) {
    if (shotDir) await session.page.screenshot({ path: `${shotDir}/health-${name}.png` }).catch(() => {});
    console.error(`--- ${name} ---\n${session.logs.slice(-50).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
