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
  waitPastMidnight,
} from './e2e_web_helpers.mjs';

// Сценарий считает «сегодня» один раз: прогон не должен переходить через полночь
await waitPastMidnight();

const PASSWORD = 'Parvane-health-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;

const browser = await chromium.launch();
const sessions = {};

const card = (health, kind) => health.locator(`[data-health-card="${kind}"]`);
const quickInput = (health) => health.locator('[data-health-quick] input');

// Вода показывается литрами, число миллилитров — в атрибуте
async function expectWater(health, ml) {
  await card(health, 'water').locator(`[data-health-value="${ml}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

// Компьютер: подробный экран закрывается «‹ Сводка» левой колонки (доска `DeskHealthDetail`)
async function backToSummary(health) {
  await health.locator('[data-health-side-back]').click();
  await health.locator('[data-health-side]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

// Цель — окном по «Изменить цель» либо карандашу
async function setGoal(page, health, kind, values) {
  await health.locator(`[data-health-goal-edit="${kind}"]`).first().click();
  for (const [field, value] of Object.entries(values)) {
    await page.locator(`[data-health-sheet="goal"] [data-health-goal="${field}"]`).fill(value);
  }
  await page.locator('[data-health-goal-save]').click();
  await page.locator('[data-health-sheet="goal"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
}

async function expectTile(scope, id, text) {
  await scope.locator(`[data-health-tile="${id}"]`).filter({ hasText: text })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

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
  // Первое открытие — экран вместо сводки (ZdHealthX): блоки включаются выключателями «Что считать», плитки
  // появятся в сводке после первой записи; строка ввода — на этом же экране, в шапке её нет
  for (const block of ['water', 'food', 'workouts']) {
    await health.locator(`[data-health-first] [data-block="${block}"]`).click();
    await health.locator(`[data-health-first] [data-block="${block}"][aria-checked="true"]`)
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  assert.equal(await health.locator('[data-health-quick]').count(), 1, 'одна строка ввода — на экране первого открытия');
  await health.locator('[data-health-first]').getByRole('button', { name: '72 kg' }).click();
  await page.waitForFunction(() => document.querySelector('[data-health-quick] input')?.value === '72 kg', undefined, { timeout: STEP_TIMEOUT_MS });
  const preview = health.locator('[data-health-preview]');
  await preview.locator('[data-kind="weight"]').filter({ hasText: '72.0' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Компьютер (ZdHealthX): «Как понято» строками с «Сохранить» и «Исправить», «Ещё примеры» — под полем
  await preview.getByText('Understood as').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await preview.locator('[data-health-quick-save]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-first]').getByText('More examples').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await health.locator('[data-health-quick] input').getAttribute('placeholder'), 'e.g. 72 kg');
  console.log('OK: первое открытие — пример подставлен, под полем видно, как понято');

  // ── Запись: Enter сохраняет понятое, плитка показывает значение ───────────
  await quickInput(health).press('Enter');
  await expectValue(health, 'weight', '72.0');
  await health.locator('[data-health-first]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  for (const kind of ['water', 'food', 'workout']) {
    await card(health, kind).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  await page.waitForFunction(() => document.querySelector('[data-health-quick] input')?.value === '', undefined, { timeout: STEP_TIMEOUT_MS });
  console.log('OK: запись сохранена, плитка веса показывает значение');

  // ── Вода: прибавки кнопками складываются за день ─────────────────────────
  await card(health, 'water').locator('[data-health-action="glass"]').click();
  await expectWater(health, '250');
  await card(health, 'water').locator('[data-health-action="bottle"]').click();
  await expectWater(health, '750');
  await card(health, 'water').getByText('0.75').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  // Компьютер (DeskHealth): «отбой 23:30 · подъём 07:00», режим недели со шкалой 22…08
  await card(health, 'sleep').getByText('23:30', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await card(health, 'sleep').locator('[data-health-regime="7"]').getByText('22', { exact: true })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Одна понятая запись — плашкой с галочкой в поле справа, когда — словами («сейчас»), а не ГГГГ-ММ-ДД
  await quickInput(health).fill('пульс 70');
  await health.locator('[data-health-preview] [data-kind="pulse"] [data-health-parsed-when]').filter({ hasText: 'now' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickInput(health).fill('');
  // Кнопка «Ложусь»: отметка без пары, повторно лечь нельзя, пока не встал
  const bed = card(health, 'sleep').locator('[data-health-action="bed"]');
  await bed.click();
  await page.waitForFunction(() => document.querySelector('[data-health-action="bed"]')?.disabled === true, undefined, { timeout: STEP_TIMEOUT_MS });
  // «Встал» закрывает отметку «лёг» — «Ложусь» снова доступна
  await card(health, 'sleep').locator('[data-health-action="wake"]').click();
  await page.waitForFunction(() => document.querySelector('[data-health-action="bed"]')?.disabled === false, undefined, { timeout: STEP_TIMEOUT_MS });
  // Подсказка окна дневного сна «спал с 14 до 15:10» — движок понимает строкой
  await quickInput(health).fill('спал с 14 до 15:10');
  await health.locator('[data-health-preview] [data-kind="sleep"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickInput(health).fill('');
  console.log('OK: сон записан одной ночью; «Ложусь» ждёт «Встал», «Встал» закрывает отметку');

  // ── Подробный экран: цель веса и отклонение от неё ────────────────────────
  await card(health, 'weight').click();
  const detail = health.locator('[data-health-detail="weight"]');
  await detail.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Компьютер: колонка показателей с «‹ Сводка», четыре плитки, записи и цель рядом (DeskHealthDetail)
  await health.locator('[data-health-side] [data-health-side-item="weight"][aria-current="page"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await setGoal(page, health, 'weight', { weight: '70' });
  await expectTile(detail, 'toGoal', '2.0 kg');
  await detail.locator('[data-health-goal-text]').filter({ hasText: '70.0' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Период: чипы в шапке; ряды из движка (за год — один месяц с записью)
  await health.locator('[data-health-period="week"]').click();
  await detail.locator('[data-health-chart="week"][data-health-chart-points="1"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-period="year"]').click();
  await detail.locator('[data-health-chart="year"][data-health-chart-points="1"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-period="month"]').click();
  // Форма «Записать»: вес шагом +0,1 от последнего значения; изменение к прошлой записи — в строке записей
  await detail.locator('[data-health-record="weight"] [data-health-record-step="+"]').click();
  await page.waitForFunction(() => document.querySelector('[data-health-record-field="value"]')?.value === '72.1', undefined, { timeout: STEP_TIMEOUT_MS });
  await detail.locator('[data-health-record-save]').click();
  await expectTile(detail, 'last', '72.1 kg');
  await detail.locator('[data-health-entries] [data-kind="weight"] [data-health-entry-delta]').filter({ hasText: '+0.1' }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Давление и пульс — один экран: три поля формы, пульс той же минуты в строке записи, столбики «нижнее–верхнее»
  await health.locator('[data-health-side-item="pressure"]').click();
  const pressure = health.locator('[data-health-detail="pressure"]');
  await health.locator('[data-health-title]').filter({ hasText: 'Blood pressure and pulse' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pressure.locator('[data-health-record-field="value"]').fill('118');
  await pressure.locator('[data-health-record-field="value2"]').fill('76');
  await pressure.locator('[data-health-record-field="pulse"]').fill('70');
  await pressure.locator('[data-health-record-save]').click();
  await expectTile(pressure, 'last', '118/76');
  await pressure.locator('[data-health-entries] [data-kind="pressure"]').filter({ hasText: 'pulse 70' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectTile(pressure, 'count', '2');
  await pressure.getByText('A bar runs from the lower to the upper value of the day.').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  // Режим сна: цель «лечь / встать» даёт отклонение, средние отбой и подъём (движок)
  await card(health, 'sleep').getByRole('button', { name: 'Open sleep' }).click();
  const sleepDetail = health.locator('[data-health-detail="sleep"]');
  await setGoal(page, health, 'sleep', { sleep_bed: '23:00', sleep_wake: '07:00' });
  await expectTile(sleepDetail, 'delta', '−30 min');
  await expectTile(sleepDetail, 'bed', '23:30');
  await expectTile(sleepDetail, 'wake', '07:00');
  await sleepDetail.locator('[data-health-goal-text]').filter({ hasText: 'Bed 23:00 · wake 07:00 · 8 h' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sleepDetail.locator('[data-health-entries] [data-kind="sleep"] [data-health-entry-delta]').filter({ hasText: '−30 min' }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  console.log('OK: цели, плитки, форма «Записать», давление с пульсом и средние сна — из движка');

  // ── Правка записи: значение вне диапазона не принимается, верное — сохраняется ─
  const entries = health.locator('[data-health-entries]');
  // Правка — на экране пульса: двойной щелчок по строке (ZdHealthX)
  await card(health, 'pulse').click();
  await entries.locator('[data-kind="pulse"]').filter({ hasText: '64' }).locator('[data-health-entry-edit]').dblclick();
  const sheet = page.locator('[data-health-sheet="pulse"]');
  await sheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.getByText('Pulse entry', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const valueField = sheet.locator('[data-health-field="value"]');
  await page.waitForFunction(() => document.querySelector('[data-health-field="value"]')?.value === '64', undefined, { timeout: STEP_TIMEOUT_MS });
  await valueField.fill('900');
  await page.locator('[data-health-save]').click();
  await page.locator('[data-health-problem="value"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await valueField.fill('66');
  await sheet.locator('[data-health-field="note"]').fill('после прогулки');
  await page.locator('[data-health-save]').click();
  await sheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await entries.locator('[data-kind="pulse"]').filter({ hasText: '66' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await entries.locator('[data-kind="pulse"]').getByText('после прогулки').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  console.log('OK: запись правится в окне, значение вне диапазона отклонено');

  // ── Самочувствие шкалой из пяти точек ─────────────────────────────────────
  // Компьютер: на сводке карточки самочувствия нет (DeskHealth) — экран открывается из колонки показателей
  await card(health, 'weight').click();
  await health.locator('[data-health-side-item="mood"]').click();
  const scale = health.locator('[data-health-mood-scale]');
  await scale.locator('[data-score="4"]').click();
  await scale.locator('[data-health-mood-note]').fill('мало спал');
  await scale.locator('[data-health-mood-save]').click();
  await health.locator('[data-health-detail="mood"] [data-health-entries] [data-kind="mood"]')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-mood-grid] [data-score="4"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Режим сна недели: одна ночь — «мало данных»
  await health.locator('[data-health-regime-state="few"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  await entries.locator('[data-kind="mood"]').getByText('4 of 5').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  await page.locator('[data-health-field="day"]').fill(napDay);
  await napSheet.locator('[data-health-span]').filter({ hasText: '1 h 0 min' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-health-save]').click();
  await napSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await health.locator(`[data-health-card="sleep"] [data-day="${napDay}"]`).filter({ hasText: '1:00' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Считать в сумму сна» снята — сон остаётся в записях, но из суммы дня уходит
  // Компьютер (ZdHealthX): правка — двойным щелчком по строке
  await health.locator('[data-health-detail="sleep"] [data-health-entries] [data-kind="sleep"]').filter({ hasText: '14:00 → 15:00' })
    .locator('[data-health-entry-edit]').dblclick();
  await napSheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Выключатель `PvSwitch`: кнопка `role="switch"`, состояние — `aria-checked`
  await napSheet.locator('[role="switch"][data-health-field="countInSum"][aria-checked="true"]').click();
  await napSheet.locator('[data-health-field="countInSum"][aria-checked="false"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-health-save]').click();
  await napSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await health.locator(`[data-health-card="sleep"] [data-day="${napDay}"]`).filter({ hasText: '—' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Месяц — режим «лёг → встал» по 30 дням
  await health.locator('[data-health-period="month"]').click();
  await health.locator('[data-health-detail="sleep"] [data-health-regime="30"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await health.locator('[data-health-period="week"]').click();
  await backToSummary(health);
  console.log('OK: дневной сон добавлен формой');

  // ── Шаги — итоги дней; удаление прибавки окном правки, сумма дня пересчитана ─
  await card(health, 'steps').click();
  const steps = health.locator('[data-health-detail="steps"]');
  await health.locator('[data-health-title]').filter({ hasText: 'Steps and mood' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await steps.locator('[data-health-day-total] [data-health-value]').filter({ hasText: '8,400' }).first().click();
  await steps.locator('[data-health-entries] [data-kind="steps"]').filter({ hasText: '5,400' }).locator('[data-health-entry-edit]').dblclick();
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await steps.locator('[data-health-day-total] [data-health-value]').filter({ hasText: '3,000' }).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  await expectValue(health, 'steps', '3,000');
  console.log('OK: шаги итогами дней, прибавка удалена, сумма дня пересчитана');

  // ── Питание: еда одной строкой, приёмы и итог дня против цели ─────────────
  await addLine(health, 'завтрак овсянка 430 ккал б 22 ж 14 у 48', 'food');
  await expectValue(health, 'food', '430');
  await addLine(health, 'обед гречка с курицей 520 ккал', 'food');
  await expectValue(health, 'food', '950');
  await card(health, 'food').getByRole('button').first().click();
  const food = health.locator('[data-health-detail="food"]');
  await food.locator('[data-health-meal="breakfast"] [data-health-value]').filter({ hasText: '430' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await food.locator('[data-health-meal="breakfast"]').getByText('P 22 F 14 C 48').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await food.locator('[data-health-meal="dinner"]').getByText('not logged yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const kcalGoal = food.locator('[data-health-goal="kcal"]');
  await kcalGoal.fill('2200');
  await kcalGoal.blur();
  await food.locator('[data-health-macro="kcal"] [data-health-value]').filter({ hasText: '950 / 2,200' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: питание — приёмы пищи, БЖУ и калории против цели');

  // ── Прошлый день: вчера записей нет, сегодня — на месте ───────────────────
  await food.getByRole('button', { name: 'Previous day' }).click();
  await food.locator('[data-health-macro="kcal"] [data-health-value]').filter({ hasText: /^0 \/ 2,200/ })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await food.getByRole('button', { name: 'Next day' }).click();
  await food.locator('[data-health-macro="kcal"] [data-health-value]').filter({ hasText: '950 / 2,200' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: питание листается по дням');

  // ── Закрыть день питания: недобор виден до закрытия; день открывается снова ─
  await food.locator('[data-health-action="close-day"]').click();
  const closeSheet = page.locator('[data-health-sheet="close-day"]');
  await closeSheet.locator('[data-health-day-delta]').filter({ hasText: '1,250' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-health-action="confirm-close-day"]').click();
  await food.locator('[data-health-day-closed]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await food.locator('[data-health-action="reopen-day"]').click();
  await food.locator('[data-health-action="close-day"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: день питания закрыт и открыт снова');

  // ── Правка записи еды: калории меняют итог приёма ─────────────────────────
  await food.locator('[data-health-entries] [data-kind="food"]').filter({ hasText: 'овсянка' })
    .locator('[data-health-entry-edit]').dblclick();
  const foodSheet = page.locator('[data-health-sheet="food"]');
  await foodSheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForFunction(() => document.querySelector('[data-health-field="value"]')?.value === '430', undefined, { timeout: STEP_TIMEOUT_MS });
  await foodSheet.locator('[data-health-field="value"]').fill('400');
  await page.locator('[data-health-save]').click();
  await foodSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await food.locator('[data-health-meal="breakfast"] [data-health-value]').filter({ hasText: '400' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  await expectValue(health, 'food', '920');
  console.log('OK: запись еды правится в окне');

  // ── «Мои продукты»: еда, записанная с калориями, в следующий раз пишется одним названием ─
  await addLine(health, 'перекус творог 240 ккал б 30', 'food');
  await expectValue(health, 'food', '1,160');
  await quickInput(health).fill('творог');
  // До сохранения видно, что калории подставлены из прошлой записи
  const recalledChip = health.locator('[data-health-preview] [data-kind="food"]').filter({ hasText: '240' });
  await recalledChip.locator('[data-recalled]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickInput(health).press('Enter');
  await expectValue(health, 'food', '1,400');
  console.log('OK: еда одним названием берёт калории прошлой записи');

  // ── Активность: тренировка одной строкой, минуты, пробег и темп ───────────
  await addLine(health, 'бег 35 минут 6,2 км', 'workout');
  await expectValue(health, 'workout', '35');
  await card(health, 'workout').getByRole('button').first().click();
  const activity = health.locator('[data-health-detail="workout"]');
  await activity.locator('[data-health-tile="km"] [data-health-value]').filter({ hasText: '6.2 km' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await activity.locator('[data-health-workout="run"]').getByText('pace 5:39').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await activity.locator('[data-health-tile="steps"] [data-health-value]').filter({ hasText: '3,000' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await backToSummary(health);
  console.log('OK: активность — тренировка, пробег, темп и шаги дня');

  // ── Строка ввода «Плана»: строку, понятую «Здоровьем» целиком, окно отдаёт ему; с выбранным видом
  // «Задача» та же строка — обычная задача «Плана» ─
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Plan', exact: true }).click();
  await page.locator('#FoldersSidebar [data-add-for]').click();
  const plannerInput = page.locator('#planner-quick-input');
  await plannerInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await plannerInput.fill('вес 73,5');
  const quickForm = page.locator('form[data-quick-kind]');
  await page.locator('form[data-quick-kind="health"] [data-kind="weight"]').filter({ hasText: '73.5' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickForm.getByRole('radio', { name: 'Task' }).click();
  await page.locator('form[data-quick-kind="task"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickForm.getByRole('radio', { name: 'Auto' }).click();
  await page.locator('form[data-quick-kind="health"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await plannerInput.press('Enter');
  await plannerInput.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await expectValue(await openHealthModule(page), 'weight', '73.5');
  console.log('OK: вес из строки ввода «Плана» записан в «Здоровье»');

  // ── Перезагрузка: данные на сервере, а не во вкладке ──────────────────────
  await reloadPage(page);
  const reloaded = await openHealthModule(page);
  await expectValue(reloaded, 'weight', '73.5');
  await expectValue(reloaded, 'steps', '3,000');
  await expectValue(reloaded, 'food', '1,400');
  await expectValue(reloaded, 'workout', '35');
  await card(reloaded, 'sleep').locator('[data-health-sleep-total]').filter({ hasText: '7 h 30 min' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: записи пережили перезагрузку');

  // ── Второе устройство аккаунта: после привязки видит те же записи ─────────
  const secondContext = await browser.newContext({ viewport: WIDE });
  sessions.second = await preparePage(secondContext, user, PASSWORD);
  await linkSecondDevice(page, sessions.second.page);
  const other = await openHealthModule(sessions.second.page);
  await expectValue(other, 'weight', '73.5');
  await expectValue(other, 'pressure', '118/76');
  // Запись со второго устройства доезжает до первого
  await addLine(other, 'вес 71,6', 'weight');
  await expectValue(other, 'weight', '71.6');
  await openHealthModule(page);
  await expectValue(page.locator('#ParvaneHealth'), 'weight', '71.6');
  console.log('OK: второе устройство видит записи и пишет свои');

  // ── Без связи: запись помечена «не отправлено», после связи пометка уходит ─
  await context.setOffline(true);
  await card(page.locator('#ParvaneHealth'), 'weight').click();
  const offlineWeight = page.locator('#ParvaneHealth [data-health-detail="weight"]');
  await offlineWeight.locator('[data-health-record-field="value"]').fill('71.4');
  await offlineWeight.locator('[data-health-record-save]').click();
  await offlineWeight.locator('[data-health-entries] [data-unsent]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await context.setOffline(false);
  await offlineWeight.locator('[data-health-entries] [data-unsent]').first().waitFor({ state: 'detached', timeout: 60000 });
  await backToSummary(page.locator('#ParvaneHealth'));
  await expectValue(page.locator('#ParvaneHealth'), 'weight', '71.4');
  console.log('OK: без связи запись помечена «не отправлено», пометка ушла после связи');

  // Экран «Профиль → Модули / Здоровье — Цели здоровья» проверяет `e2e_web_planner_sleep.mjs` (исполнитель «План»)

  // ── Телефон: модуль в ленте, «+» ставит курсор в строку ввода ─────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Chats' }).click();
  const phoneHealth = await openHealthModule(page);
  // Телефон (Health): строки ввода в шапке нет, «Сегодня» с датой, сон карточкой, «+» — лист «Записать показатель»
  assert.equal(await phoneHealth.locator('header [data-health-quick]').count(), 0, 'строка ввода не в шапке телефона');
  await phoneHealth.getByText('Today', { exact: true }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «+» — шторка «Запись в здоровье» (доска `PlusModes`): поле с курсором, «Понято как», примеры, «Отмена / Сохранить»
  const quickSheet = page.locator('[data-health-quick-sheet]');
  await page.locator('[data-add-for="health"]').click();
  await page.waitForFunction(() => document.activeElement?.matches('[data-health-quick-sheet] [data-health-quick-input]'), undefined, { timeout: STEP_TIMEOUT_MS });
  await page.getByRole('heading', { name: 'Health entry' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  await quickSheet.getByText('You can also write').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickSheet.locator('[data-health-example]').filter({ hasText: 'pulse 64' }).click();
  await quickSheet.locator('[data-health-understood][data-kind="pulse"]').filter({ hasText: 'Understood as “Pulse”' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickSheet.locator('[data-health-quick-save]').click();
  await quickSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await expectValue(phoneHealth, 'pulse', '64');
  // Ночь: «Отбой / Подъём / Всего», вывод против цели; «Изменить» — полная форма с полями из разбора
  await page.locator('[data-add-for="health"]').click();
  await quickSheet.locator('[data-health-quick-input]').fill('лёг в 0:00 встал в 7');
  const nightCard = quickSheet.locator('[data-health-understood][data-kind="sleep"]');
  for (const text of ['Bedtime', 'Wake-up', 'Total', '00:00', '07:00']) {
    await nightCard.filter({ hasText: text }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  // До семи утра подъём «в 7» ещё не наступил: запись относится к предыдущей ночи
  await nightCard.locator('[data-health-verdict]').filter({ hasText: /Last night|The night before yesterday/ })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await nightCard.locator('[data-health-understood-edit]').click();
  await quickSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await page.locator('[data-health-save]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator('[data-health-save]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // «Отмена» закрывает шторку без записи
  await page.locator('[data-add-for="health"]').click();
  await quickSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await quickSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await expectValue(phoneHealth, 'weight', '71.4');
  await phoneHealth.locator('[data-health-card="mood"]').getByText('Good').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Подробный экран телефона: «‹ Вес», цель строкой с карандашом, «Записать» шагом −0,1
  await card(phoneHealth, 'weight').click();
  await phoneHealth.locator('[data-health-title]').filter({ hasText: 'Weight' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await phoneHealth.locator('[data-health-side]').count(), 0, 'на телефоне нет колонки показателей');
  await phoneHealth.locator('[data-health-record="weight"] [data-health-record-step="-"]').click();
  await page.waitForFunction(() => document.querySelector('[data-health-record-field="value"]')?.value === '71.3', undefined, { timeout: STEP_TIMEOUT_MS });
  await phoneHealth.locator('[data-health-record-save]').click();
  await phoneHealth.locator('[data-health-detail="weight"] [data-health-value]').filter({ hasText: '71.3' })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneHealth.getByRole('button', { name: 'Back' }).click();
  await card(phoneHealth, 'sleep').click();
  await phoneHealth.locator('[data-health-detail="sleep"] [data-health-sleep-insight]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await phoneHealth.getByRole('button', { name: 'Back' }).click();
  console.log('OK: телефон — сводка и подробные экраны по доскам, «+» открывает лист записи');

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
