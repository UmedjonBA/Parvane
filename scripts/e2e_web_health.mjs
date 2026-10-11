// «Здоровье» в «Плане» (spec 020): еда, вода, вес, давление, сон, тренировки и цели вводятся текстом,
// видны на экране «Здоровье» и на карточках «Сегодня», переживают перезагрузку (проходят через движок).
// Запуск: scripts/run_web_health_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  relogin,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-health-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 15000;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
let session;

try {
  const user = `health-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const planner = page.locator('#ParvanePlanner');
  const sidebar = page.locator('#FoldersSidebar');
  const health = planner.locator('[data-planner-health]');
  const card = (name) => health.locator(`[data-health="${name}"]`);
  const input = page.locator('#planner-quick-input');
  const form = page.locator('form[data-quick-kind]');
  const expectKind = (kind) => page.waitForFunction(
    (expected) => document.querySelector('form[data-quick-kind]')?.dataset.quickKind === expected,
    kind,
    { timeout: STEP_TIMEOUT_MS },
  );
  const enter = async (line, kind) => {
    await planner.getByRole('button', { name: 'Quick entry' }).click();
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await input.fill(line);
    await expectKind(kind);
    await input.press('Enter');
    await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  };
  const expectText = (locator, pattern, what) => locator.filter({ hasText: pattern }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`${what}: нет текста ${pattern}`));

  // ── Раздел «Здоровье» в боковой панели; пример открывает ввод с готовой строкой ──
  await sidebar.getByRole('tab', { name: 'Health' }).click();
  await health.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  for (const name of ['hint', 'nutrition', 'water', 'body', 'sleep', 'activity', 'goals']) {
    assert.equal(await card(name).count(), 1, `нет блока ${name}`);
  }
  await card('hint').getByRole('button', { name: 'weight 72.4' }).click();
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('#planner-quick-input')?.value === 'weight 72.4', undefined, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => assert.fail('пример не подставился в строку ввода'));
  await expectKind('metric');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expectText(card('body'), /72\.4/, 'вес');
  console.log('OK: «Здоровье» открыто, пример записал вес');

  // ── Еда с КБЖУ, сахар сверх предела, вода кнопкой и текстом ───────────────
  await enter('обед гречка 150г б30 ж10 у60 кл6 сахар 60 13:30 520 ккал', 'food');
  await expectText(card('nutrition'), /520/, 'калории');
  await expectText(card('nutrition'), /Lunch: гречка/, 'приём пищи');
  await expectText(card('nutrition'), /P30 F10 C60/, 'БЖУ приёма');
  await expectText(card('nutrition'), /30 \/ 120 g/, 'белки к цели');
  await expectText(card('nutrition'), /60 ≤ 50 g/, 'сахар к пределу');
  await card('water').getByRole('button', { name: '+ glass 250' }).click();
  await expectText(card('water'), /0\.25/, 'вода кнопкой');
  await enter('вода 500 мл', 'water');
  await expectText(card('water'), /0\.75/, 'вода текстом');
  console.log('OK: еда с КБЖУ и пределом сахара, вода');

  // ── Давление, пульс, шаги, сон, тренировки ────────────────────────────────
  await enter('давление 120/80', 'metric');
  await enter('пульс 64', 'metric');
  await enter('шаги 9500', 'metric');
  await expectText(card('body'), /120\/80/, 'давление');
  await expectText(card('body'), /64 bpm/, 'пульс');
  await expectText(card('activity'), /9,500 \/ 8,000/, 'шаги к цели');
  await enter('сон 01:00-06:00', 'sleep');
  await expectText(card('sleep'), /5:00/, 'длительность сна');
  await expectText(card('sleep'), /01:00 → 06:00/, 'время сна');
  await enter('бег 5 км 28 мин', 'workout');
  await enter('зал присед 4x8x80, жим 3x10x60', 'workout');
  await expectText(card('activity'), /28 min · 5 km · 5:36\/km/, 'кардио');
  await expectText(card('activity'), /присед 4×8×80, жим 3×10×60/, 'силовая');
  await expectText(card('activity'), /2 \/ 3/, 'тренировок за неделю');
  await expectText(card('water'), /0\.75/, 'вода после показателей и тренировок');
  console.log('OK: показатели, сон, кардио и силовая тренировка');

  // ── Цели текстом на экране «Здоровье» ─────────────────────────────────────
  await page.locator('#planner-health-goals').fill('белок 140 вода 2,5л шаги 10000');
  await card('goals').getByRole('button', { name: 'Apply' }).click();
  await planner.getByText('Goals updated').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectText(card('nutrition'), /30 \/ 140 g/, 'новая цель белка');
  await expectText(card('activity'), /9,500 \/ 10,000/, 'новая цель шагов');
  await expectText(card('water'), /0\.75/, 'вода после смены целей');
  await expectText(card('water'), /goal 2\.5 L/, 'цель воды');
  await page.locator('#planner-health-goals').fill('ничего');
  await card('goals').getByRole('button', { name: 'Apply' }).click();
  await planner.getByText('Nothing recognised').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: цели меняются текстом, негодная строка объясняется');

  // ── «Сегодня»: карточки сна и еды; короткий сон снижает бюджет дня ────────
  await sidebar.getByRole('tab', { name: 'Today' }).click();
  const today = planner.locator('[data-planner-today]');
  await expectText(today.locator('[data-today-card="sleep"]'), /5:00/, 'карточка сна');
  await expectText(today.locator('[data-today-card="food"]'), /520 kcal/, 'карточка еды');
  await expectText(today.locator('[data-today-card="load"]'), /\/ 8 h/, 'бюджет снижен до 8 часов');
  await expectText(today.locator('[data-today-card="load"]'), /Short sleep/, 'пояснение про сон');
  await today.locator('[data-today-card="food"]').click();
  await health.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/health-wide.png` });
  console.log('OK: карточки «Сон» и «Еда» на «Сегодня», бюджет дня при коротком сне');

  // ── Данные переживают перезагрузку (прошли через движок и сервер) ─────────
  await page.waitForTimeout(1500);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Health' }).click();
  await health.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectText(card('nutrition'), /Lunch: гречка/, 'еда после перезагрузки');
  await expectText(card('nutrition'), /60 ≤ 50 g/, 'сахар после перезагрузки');
  await expectText(card('body'), /72\.4/, 'вес после перезагрузки');
  await expectText(card('water'), /0\.75/, 'вода после перезагрузки');
  await expectText(card('sleep'), /01:00 → 06:00/, 'сон после перезагрузки');
  await expectText(card('activity'), /присед 4×8×80/, 'упражнения после перезагрузки');
  await expectText(card('activity'), /9,500 \/ 10,000/, 'цель шагов после перезагрузки');
  // Удаление приёма пищи и тренировки
  await card('nutrition').getByRole('button', { name: 'Delete entry: гречка' }).click();
  await card('nutrition').getByText('No meals yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card('activity').getByRole('button', { name: 'Delete entry: бег' }).click();
  await expectText(card('activity'), /1 \/ 3/, 'тренировок после удаления');
  console.log('OK: данные здоровья пережили перезагрузку; записи удаляются');

  // ── Телефон: «Здоровье» — третья вкладка «Плана», одной колонкой ──────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await planner.locator('header').getByText('Health', { exact: true }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `экран шире телефона на ${overflow}px`);
  const columns = await health.evaluate((el) => new Set([...el.children].map((child) => Math.round(child.getBoundingClientRect().left))).size);
  assert.equal(columns, 1, 'на телефоне блоки стоят одной колонкой');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/health-phone.png` });
  console.log('OK: «Здоровье» на телефоне');

  console.log('e2e_web_health: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${dir}/health-failure.png` }).catch(() => {});
    console.log(`--- планировщик при сбое ---\n${await page?.locator('#ParvanePlanner').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
