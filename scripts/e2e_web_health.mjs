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
  openPlannerScreen,
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
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
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
  await openPlannerScreen(page, 'today');
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

  // ── Режим сна: одинаково ли время отхода ко сну и подъёма ─────────────────
  // Сон прошлых дней вписывается строкой блока «Сон» на экране нужного дня (ввод «+» пишет в сегодня)
  const routine = health.locator('[data-health="sleep-routine"]');
  const dayKey = (shift) => {
    const date = new Date();
    date.setDate(date.getDate() + shift);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const goToDay = async (shift) => {
    const key = dayKey(shift);
    for (let step = 0; step < 20; step++) {
      const current = await health.getAttribute('data-planner-health');
      if (current === key) return;
      await planner.getByRole('button', { name: current > key ? 'Previous period' : 'Next period' }).first().click();
      await planner.locator(`[data-planner-health]:not([data-planner-health="${current}"])`)
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    }
    assert.fail(`экран «Здоровье» не дошёл до дня ${key}`);
  };
  const saveSleep = async (shift, line, kind = 'timed') => {
    await goToDay(shift);
    await page.locator('#planner-health-sleep').fill(line);
    await card('sleep').getByRole('button', { name: 'Save', exact: true }).click();
    await routine.locator(`[data-sleep-night="${dayKey(shift)}"][data-sleep-night-kind="${kind}"]`)
      .waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS })
      .catch(() => assert.fail(`ночь ${dayKey(shift)} (${line}) не появилась на графике режима`));
  };
  const expectLevel = (level, what) => health
    .locator(`[data-health="sleep-routine"][data-sleep-routine-level="${level}"]`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(async () => assert.fail(
      `${what}: уровень режима ${await routine.getAttribute('data-sleep-routine-level')}, ожидался ${level}`,
    ));
  const nights = (kind) => routine.locator(`[data-sleep-night][data-sleep-night-kind="${kind}"]`).count();

  // Одна ночь со временем (сегодняшняя 01:00–06:00) — данных мало, подсказка называет счёт
  await goToDay(0);
  await expectLevel('none', 'одна ночь');
  await expectText(routine, /Not enough data/, 'плашка «мало данных»');
  await expectText(routine, /1 of 4 nights/, 'счёт ночей со временем');
  assert.equal(await nights('timed'), 1, 'на графике одна ночь');

  // Пять ночей подряд с малым разбросом — режим стабильный (окно кончается днём экрана: сегодняшняя
  // ночь в него ещё не входит)
  const steady = ['23:40-07:30', '23:50-07:20', '23:30-07:30', '23:45-07:40', '23:35-07:25'];
  for (const [index, line] of steady.entries()) {
    await saveSleep(index - 6, line);
    if (index < 3) await expectLevel('none', `ночей со временем ${index + 1}`);
  }
  await expectLevel('stable', 'пять ровных ночей');
  await expectText(routine, /Stable/, 'плашка «стабильный»');
  await expectText(routine, /Bed around 23:40 ± \d min · up around 07:30 ± \d min/, 'среднее и разброс');
  assert.equal(await nights('timed'), 5, 'на графике пять ночей');
  assert.equal(await routine.locator('[data-sleep-routine-outliers]').count(), 0, 'выбившихся ночей нет');
  await expectText(card('sleep'), /23:35 → 07:25/, 'сон дня экрана');

  // Цель режима текстом: отклонение среднего от цели и линии цели на графике
  await routine.locator('[data-sleep-routine-goal-example]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#planner-health-goals').fill('sleep 23:30-07:00');
  await card('goals').getByRole('button', { name: 'Apply' }).click();
  await planner.getByText('Goals updated').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectText(routine.locator('[data-sleep-routine-goal]'), /goal 23:30–07:00/, 'цель режима');
  await expectText(
    routine.locator('[data-sleep-routine-deviation]'),
    /Bedtime: on average 10 min later than the goal 23:30 · Wake-up: on average 30 min later than the goal 07:00/,
    'отклонение от цели',
  );
  assert.equal(await routine.locator('[data-sleep-routine-goal-line]').count(), 2, 'две линии цели');
  assert.equal(await routine.locator('[data-sleep-routine-goal-example]').count(), 0, 'пример цели убран');
  await expectText(card('goals'), /Routine 23:30–07:00/, 'цель режима в сводке целей');
  await expectText(card('goals'), /Sleep 8:00/, 'цель длительности сна не тронута');
  console.log('OK: режим сна — мало данных, стабильный, цель и отклонение от неё');

  // Ночь на три часа позже — режим сбит, ночь названа
  await saveSleep(-1, '02:40-10:30');
  await expectLevel('broken', 'ночь на три часа позже');
  await expectText(routine, /Off track/, 'плашка «сбит»');
  await expectText(routine.locator('[data-sleep-routine-outliers]'), /02:40 → 10:30/, 'выбившаяся ночь');
  assert.equal(await nights('timed'), 6, 'на графике шесть ночей');

  // Та же ночь одной длительностью — «без времени»: в расчёт не идёт, режим снова стабильный
  await saveSleep(-1, '7.5 h', 'untimed');
  await expectLevel('stable', 'ночь без времени в расчёт не идёт');
  await expectText(routine.locator('[data-sleep-routine-untimed]'), /Nights without times: 1/, 'ночь без времени');
  assert.equal(await nights('timed'), 5, 'ночей со временем снова пять');
  assert.equal(await nights('untimed'), 1, 'ночь без времени отмечена точкой');
  await expectText(card('sleep'), /7:30/, 'длительность ночи без времени');

  // Сегодня: в окно вошла ночь 01:00–06:00 — режим «плавает». то же говорит карточка «Сегодня»
  await goToDay(0);
  await expectLevel('drifting', 'с сегодняшней ночью');
  await expectText(routine, /Drifting/, 'плашка «плавает»');
  assert.equal(await nights('timed'), 6, 'шесть ночей со временем');
  console.log('OK: режим сна — сбит поздней ночью, ночь без времени, «плавает»');

  await page.waitForTimeout(1500);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Health' }).click();
  await health.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectLevel('drifting', 'после перезагрузки');
  assert.equal(await nights('timed'), 6, 'ночи со временем после перезагрузки');
  assert.equal(await nights('untimed'), 1, 'ночь без времени после перезагрузки');
  await expectText(routine.locator('[data-sleep-routine-goal]'), /goal 23:30–07:00/, 'цель режима после перезагрузки');
  await expectText(routine.locator('[data-sleep-routine-untimed]'), /Nights without times: 1/, 'счёт без времени');
  await openPlannerScreen(page, 'today');
  const sleepCard = planner.locator('[data-planner-today] [data-today-card="sleep"]');
  await expectText(sleepCard, /routine drifting: ±\d+ min/, 'режим на карточке сна');
  assert.equal(await sleepCard.getAttribute('data-sleep-routine-level'), 'drifting', 'уровень на карточке сна');
  // Режим только сообщается: бюджет дня по-прежнему снижает один короткий сон
  await expectText(planner.locator('[data-today-card="load"]'), /\/ 8 h/, 'бюджет дня режимом не тронут');
  await sleepCard.click();
  await health.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/health-routine.png` });
  console.log('OK: режим сна пережил перезагрузку и виден на «Сегодня»');

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
