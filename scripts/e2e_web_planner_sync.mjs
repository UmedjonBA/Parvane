// Планировщик на сервере и синхронизация устройств (spec 010). Два устройства
// одного аккаунта: непривязанное видит «данные появятся после привязки»,
// после привязки — весь планировщик; правки онлайн сходятся; правки без сети
// на обоих устройствах сливаются (разные объекты сохраняются, удалённое не
// воскресает); очередь переживает перезагрузку; данные этапа 1 переносятся
// один раз; словарь правок ввода текстом едет с данными «Плана» (выученное на
// одном устройстве подставляется на другом, сброс действует на оба); история
// строк ввода текстом — тоже (строка первого устройства — подсказка на втором,
// «Забыть» действует на оба, история переживает перезагрузку); в базе
// шарда domains нет названий открытым текстом.
// Запуск: scripts/run_web_planner_sync_e2e.sh
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  linkSecondDevice,
  preparePage,
  reloadPage,
  relogin,
  openPlannerScreen,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-planner-sync-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
// Опрос журнала контейнера раз в 8 с + отправка по тишине 1,5 с + запас
const SYNC_TIMEOUT_MS = 45000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function openPlanner(page) {
  const planner = page.locator('#ParvanePlanner');
  // «План» после первого показа остаётся в DOM скрытым (E1) — решаем по видимости, не по наличию
  if (!(await planner.isVisible().catch(() => false))) {
    await openPlannerScreen(page, 'calendar');
  }
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return planner;
}

async function closePlanner(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  // «План» после первого показа остаётся смонтированным и скрывается (E1), поэтому ждём `hidden`, не `detached`
  await page.locator('#ParvanePlanner').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
}

async function createTask(page, name, start) {
  const planner = await openPlanner(page);
  await openPlannerScreen(planner.page(), 'calendar');
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.getByRole('button', { name: 'More options' }).click();
  await page.locator('#planner-new-name').fill(name);
  if (start) {
    await planner.getByLabel('Duration, min').fill('30');
    await planner.getByLabel('Start', { exact: true }).fill(start);
  }
  await planner.getByRole('button', { name: 'Create' }).click();
  await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
}

async function deleteTask(page, name) {
  const planner = await openPlanner(page);
  await openPlannerScreen(planner.page(), 'calendar');
  await planner.locator(`[role="gridcell"][data-day="${todayKey()}"]`).click({ position: { x: 10, y: 10 } });
  await planner.getByRole('button', { name }).first().click();
  await planner.getByRole('button', { name: 'Delete task' }).click();
  await planner.getByRole('heading', { name }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

/** Задача с таким названием есть в расписании сегодняшнего дня (или нет).
 * Смотрим панель дня, а не ячейку месяца: в ячейке только два превью и «+N». */
async function expectTaskInDay(page, name, isPresent, timeout = SYNC_TIMEOUT_MS) {
  const planner = await openPlanner(page);
  await openPlannerScreen(planner.page(), 'calendar');
  await planner.locator(`[role="gridcell"][data-day="${todayKey()}"]`).click({ position: { x: 10, y: 10 } });
  await planner.locator('[data-planner-day]').getByRole('button', { name, exact: false }).first()
    .waitFor({ state: isPresent ? 'visible' : 'detached', timeout })
    .catch(() => {
      assert.fail(`${name}: ожидалось ${isPresent ? 'видно' : 'нет'} в расписании дня`);
    });
}

// ── ввод текстом (шаги — как в e2e_web_quick_input.mjs) ───────────────────────

async function openQuick(page) {
  const planner = await openPlanner(page);
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  const input = page.locator('#planner-quick-input');
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return input;
}

// Окно ловит Escape со следующего кадра после появления — нажатие повторяется, пока окно не закрылось
async function closeQuick(page) {
  const input = page.locator('#planner-quick-input');
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.keyboard.press('Escape');
    if (await input.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
  }
  assert.fail('окно ввода не закрылось по Escape');
}

async function expectQuickTime(page, expected) {
  await page.waitForFunction(
    (value) => document.querySelector('form[data-quick-kind="event"] [data-quick-chip="time"]')?.innerText.trim() === value,
    expected,
    { timeout: STEP_TIMEOUT_MS },
  ).catch(() => {
    assert.fail(`ввод текстом: ожидалось время ${expected}`);
  });
}

/** Добавить событие строкой; `name` — название, которое покажет уведомление. */
async function quickAdd(page, text, name, time) {
  const input = await openQuick(page);
  await input.fill(text);
  await expectQuickTime(page, time);
  await page.locator('form[data-quick-kind]').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#ParvanePlanner').getByText(`Added: ${name}`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await input.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
}

/** Слово словаря правок в состоянии движка устройства (или его отсутствие). */
async function learnedWordOf(page, id) {
  const state = await page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
  return state?.state?.learned?.find((word) => word.id === id);
}

/** История ввода текстом в состоянии движка устройства: строки и забытые шаблоны (`hidden`). */
async function quickLinesOf(page) {
  const state = await page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
  return state?.state?.quickLines || [];
}

/** Подсказка окна ввода, взятая из истории набранных строк (а не собранная из записей «Плана»). */
function historySuggestion(page, text) {
  return page.locator(`[data-quick-suggestion][data-source="history"][data-text="${text}"]`);
}

/** Сид журнала: по одной правке в операции (движок пакетирует только из UI).
 * Класс запросов gateway для `domain.op.append` — MSG (3/с, всплеск 30), поэтому с паузой. */
async function seedOps(page, count, prefix) {
  await page.evaluate(async ({ count: n, prefix: pre }) => {
    for (let i = 0; i < n; i++) {
      await window.__parvaneDiagCallApi('parvanePlannerApply', {
        changes: [{
          task: {
            id: `${pre}-${i}`, name: `${pre} ${i}`, description: '', steps: [], status: 'queue', listId: '',
            rank: 1000 + i, day: '', start: '', due: '', minutes: null,
          },
        }],
      });
      await window.__parvaneDiagCallApi('parvanePlannerFlush');
      await new Promise((resolve) => { setTimeout(resolve, 350); });
    }
  }, { count, prefix });
}

function domainsCounts() {
  const db = new DatabaseSync(`${BACKEND_DIR}/domains.db-v2.db`, { readOnly: true });
  try {
    return {
      ops: db.prepare('SELECT count(*) AS n FROM container_log').get().n,
      snapshots: db.prepare('SELECT count(*) AS n FROM container_snapshots').get().n,
    };
  } finally {
    db.close();
  }
}

async function waitFor(check, timeout, what) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  assert.fail(`не дождались: ${what}`);
}

function plaintextLeaks(words) {
  const db = new DatabaseSync(`${BACKEND_DIR}/domains.db-v2.db`, { readOnly: true });
  try {
    const rows = db.prepare('SELECT op FROM container_log').all();
    const snaps = db.prepare('SELECT snapshot FROM container_snapshots').all().map((r) => r.snapshot);
    const blobs = [...rows.map((r) => r.op), ...snaps];
    const text = blobs.map((b) => Buffer.from(b).toString('latin1')).join('\n');
    const utf = blobs.map((b) => Buffer.from(b).toString('utf8')).join('\n');
    return { ops: rows.length, leaks: words.filter((w) => text.includes(w) || utf.includes(w)) };
  } finally {
    db.close();
  }
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = `${Date.now().toString(36)}`;
  const bob = `psync-bob-${suffix}@local`;
  const taskA = `Задача-А-${suffix}`;
  const taskB = `Задача-Б-${suffix}`;
  const taskC = `Задача-В-${suffix}`;
  const taskD = `Задача-Г-${suffix}`;
  const taskE = `Задача-Д-${suffix}`;

  // ── US1: первое устройство наполняет планировщик ──────────────────────────
  const bob1Context = await browser.newContext({ viewport: WIDE });
  sessions.bob1 = await preparePage(bob1Context, bob, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.bob1.page).catch(() => undefined);
  await createTask(sessions.bob1.page, taskA, '10:00');
  const planner1 = sessions.bob1.page.locator('#ParvanePlanner');
  await planner1.getByRole('button', { name: 'Planner settings' }).click();
  await planner1.getByLabel('Day starts').fill('08:00');
  await planner1.getByText('Settings saved').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner1.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await closePlanner(sessions.bob1.page);
  console.log('OK: планировщик первого устройства заполнен');

  // ── Непривязанное второе устройство: без контейнера и без данных ──────────
  const bob2Context = await browser.newContext({ viewport: WIDE });
  sessions.bob2 = await preparePage(bob2Context, bob, PASSWORD);
  await sessions.bob2.page.waitForTimeout(3000);
  const planner2 = await openPlanner(sessions.bob2.page);
  await planner2.getByText(/will appear after this device is linked/).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  assert.equal(await planner2.getByText(taskA).count(), 0, 'непривязанное устройство не видит данных');
  await closePlanner(sessions.bob2.page);
  console.log('OK: непривязанное устройство ждёт привязки');

  // ── Привязка: второе устройство получает ключ контейнера и всё содержимое ──
  await linkSecondDevice(sessions.bob1.page, sessions.bob2.page);
  await expectTaskInDay(sessions.bob2.page, taskA, true);
  const planner2b = sessions.bob2.page.locator('#ParvanePlanner');
  await planner2b.getByRole('button', { name: 'Planner settings' }).click();
  await planner2b.getByLabel('Day starts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sessions.bob2.page.waitForFunction(
    () => document.querySelector('#ParvanePlanner input[type="time"]')?.value === '08:00',
    undefined, { timeout: SYNC_TIMEOUT_MS },
  );
  await planner2b.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await closePlanner(sessions.bob2.page);
  console.log('OK: после привязки второе устройство видит планировщик и настройки');

  // ── US2: правки онлайн сходятся в обе стороны ─────────────────────────────
  await createTask(sessions.bob2.page, taskB, '11:00');
  await closePlanner(sessions.bob2.page);
  await expectTaskInDay(sessions.bob1.page, taskB, true);
  await closePlanner(sessions.bob1.page);
  console.log('OK: правка со второго устройства видна первому');

  // ── US2: правки без сети на обоих устройствах, затем слияние ──────────────
  await bob2Context.setOffline(true);
  await createTask(sessions.bob2.page, taskC, '12:00');
  await sessions.bob2.page.waitForTimeout(3000);
  await planner2b.getByText(/sync is unavailable/).waitFor({ state: 'visible', timeout: SYNC_TIMEOUT_MS });
  await closePlanner(sessions.bob2.page);
  await deleteTask(sessions.bob1.page, taskA);
  await createTask(sessions.bob1.page, taskD, '13:00');
  await closePlanner(sessions.bob1.page);
  await bob2Context.setOffline(false);
  await expectTaskInDay(sessions.bob2.page, taskD, true);
  await expectTaskInDay(sessions.bob2.page, taskA, false, STEP_TIMEOUT_MS);
  await expectTaskInDay(sessions.bob2.page, taskC, true, STEP_TIMEOUT_MS);
  await closePlanner(sessions.bob2.page);
  await expectTaskInDay(sessions.bob1.page, taskC, true);
  await expectTaskInDay(sessions.bob1.page, taskB, true, STEP_TIMEOUT_MS);
  await closePlanner(sessions.bob1.page);
  console.log('OK: офлайн-правки обоих устройств слились, удалённая задача не воскресла');

  // ── spec 011 (SC-002): ряд с A, отметка экземпляра с B, правка ряда с A ───
  const seriesName = `Ряд-${suffix}`;
  await sessions.bob1.page.evaluate(async ({ name, day }) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{
        task: {
          id: `series-${day}`, name, description: '', steps: [], status: 'queue', listId: '', rank: 5,
          day: '', start: '16:00', due: '', minutes: 20,
          repeat: { kind: 'daily', interval: 1, weekdays: [], monthDay: 0, startDay: day, endDay: '', count: 0 },
        },
      }],
    });
    await window.__parvaneDiagCallApi('parvanePlannerFlush');
  }, { name: seriesName, day: todayKey() });
  await expectTaskInDay(sessions.bob2.page, seriesName, true);
  const planner2s = await openPlanner(sessions.bob2.page);
  await planner2s.locator('[data-planner-day]').getByLabel(`Done: ${seriesName}`).check();
  await planner2s.getByText(`${seriesName} · Done`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await closePlanner(sessions.bob2.page);
  await sessions.bob1.page.evaluate(async ({ day }) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ task: { id: `series-${day}`, start: '17:00' } }],
    });
    await window.__parvaneDiagCallApi('parvanePlannerFlush');
  }, { day: todayKey() });
  await waitFor(async () => {
    const state = await sessions.bob1.page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
    const task = state?.state?.tasks?.find((t) => t.name === seriesName);
    return task?.start === '17:00' && task?.occurrences?.some((o) => o.day === todayKey() && o.done);
  }, SYNC_TIMEOUT_MS, 'на A — новое время ряда и отметка экземпляра с B');
  await waitFor(async () => {
    const state = await sessions.bob2.page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
    const task = state?.state?.tasks?.find((t) => t.name === seriesName);
    return task?.start === '17:00' && task?.occurrences?.some((o) => o.day === todayKey() && o.done);
  }, SYNC_TIMEOUT_MS, 'на B — новое время ряда и своя отметка');
  // spec 013: цвет списка, «весь день» и «праздник» с A видны на B
  await sessions.bob1.page.evaluate(async ({ day }) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [
        { list: { id: `list-${day}`, name: 'Цветной', order: 9, color: 5 } },
        {
          event: {
            id: `holiday-${day}`, name: 'Праздник двора', start: '00:00', end: '23:59', weekdays: null, day,
            allDay: true, isHoliday: true, description: 'Столы во дворе',
          },
        },
      ],
    });
    await window.__parvaneDiagCallApi('parvanePlannerFlush');
  }, { day: todayKey() });
  await waitFor(async () => {
    const state = await sessions.bob2.page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
    const list = state?.state?.lists?.find((l) => l.name === 'Цветной');
    const event = state?.state?.events?.find((e) => e.name === 'Праздник двора');
    return list?.color === 5 && event?.allDay === true && event?.isHoliday === true
      && event?.description === 'Столы во дворе';
  }, SYNC_TIMEOUT_MS, 'на B — цвет списка и событие-праздник на весь день с описанием');
  // Описание события — отдельное поле: правка одного описания с B не трогает остальное
  await sessions.bob2.page.evaluate(async ({ day }) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ event: { id: `holiday-${day}`, description: 'Столы во дворе\nпринести пирог' } }],
    });
    await window.__parvaneDiagCallApi('parvanePlannerFlush');
  }, { day: todayKey() });
  await waitFor(async () => {
    const state = await sessions.bob1.page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
    const event = state?.state?.events?.find((e) => e.name === 'Праздник двора');
    return event?.description === 'Столы во дворе\nпринести пирог' && event?.allDay === true && event?.isHoliday === true;
  }, SYNC_TIMEOUT_MS, 'на A — описание события, поправленное на B; остальные поля прежние');
  // Запись цели с A видна на B
  await sessions.bob1.page.evaluate(async ({ day }) => {
    await window.__parvaneDiagCallApi('parvanePlannerApply', {
      changes: [{ goalPeriod: { id: `goal-${day}`, startDay: day, endDay: day, kcal: { target: 1500, tolerance: 100 }, water: { target: 2000, tolerance: 300 } } }],
    });
    await window.__parvaneDiagCallApi('parvanePlannerFlush');
  }, { day: todayKey() });
  await waitFor(async () => {
    const state = await sessions.bob2.page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));
    return state?.state?.goalPeriods?.some((g) => g.id === `goal-${todayKey()}` && g.water?.target === 2000);
  }, SYNC_TIMEOUT_MS, 'запись цели с A на B');
  console.log('OK: ряд, отметка экземпляра и правка ряда сходятся; запись цели синхронизируется');

  // ── Словарь правок ввода текстом: выученное на A подставляется на B, сброс на B действует на A ──
  const learnedHead = 'летучка';
  const learnedChip = (page) => page.locator('form[data-quick-kind] [data-quick-chip="minutes"][data-learned="1"]');
  // Одна и та же длительность трижды — правка становится значением по умолчанию
  for (const hour of ['10', '11', '12']) {
    await quickAdd(sessions.bob1.page, `${learnedHead} завтра ${hour}:00 20 мин`, learnedHead, `${hour}:00–${hour}:20`);
  }
  await openQuick(sessions.bob1.page);
  await sessions.bob1.page.locator('#planner-quick-input').fill(`${learnedHead} завтра 13:00`);
  await learnedChip(sessions.bob1.page).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectQuickTime(sessions.bob1.page, '13:00–13:20');
  await closeQuick(sessions.bob1.page);
  await closePlanner(sessions.bob1.page);
  // На устройстве словаря больше нет: он в данных «Плана»
  assert.deepEqual(
    await sessions.bob1.page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('parvane:quick-learned:'))),
    [], 'словарь правок не должен оставаться в localStorage',
  );
  await waitFor(async () => {
    const word = await learnedWordOf(sessions.bob2.page, learnedHead);
    return word?.minutes === 20 && word?.minutesCount === 3;
  }, SYNC_TIMEOUT_MS, 'на B — слово словаря правок, выученное на A');
  await openQuick(sessions.bob2.page);
  await sessions.bob2.page.locator('#planner-quick-input').fill(`${learnedHead} завтра 13:00`);
  await learnedChip(sessions.bob2.page).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await expectQuickTime(sessions.bob2.page, '13:00–13:20');
  await closeQuick(sessions.bob2.page);
  console.log('OK: длительность, выученная на первом устройстве, подставлена на втором');

  // ── История ввода текстом: строки, набранные на A, — подсказки на B; «Забыть» на B действует на A ──
  const historyHead = 'планёрка';
  const lineKept = `${learnedHead} завтра 11:00 20 мин`;
  const lineForgotten = `${learnedHead} завтра 12:00 20 мин`;
  const quickInput2 = sessions.bob2.page.locator('#planner-quick-input');
  // На устройстве истории нет: она в данных «Плана»
  assert.deepEqual(
    await sessions.bob1.page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('parvane:quick-history:'))),
    [], 'история ввода текстом не должна оставаться в localStorage',
  );
  await waitFor(async () => {
    const lines = (await quickLinesOf(sessions.bob2.page)).map((line) => line.text);
    return lines.includes(lineKept) && lines.includes(lineForgotten);
  }, SYNC_TIMEOUT_MS, 'на B — строки истории, набранные на A');
  await openQuick(sessions.bob2.page);
  await quickInput2.fill('лету');
  // Подсказка — строка первого устройства дословно (с датой), а не шаблон, собранный из записей «Плана»
  await historySuggestion(sessions.bob2.page, lineKept).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('на B нет подсказки из строки, набранной на A'));
  await historySuggestion(sessions.bob2.page, lineForgotten).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sessions.bob2.page.locator(`[data-quick-suggestion-forget][data-text="${lineForgotten}"]`).click();
  await historySuggestion(sessions.bob2.page, lineForgotten).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('забытая подсказка осталась на B'));
  assert.equal(
    await sessions.bob2.page.locator('[data-quick-suggestion][data-text*="12:00"]').count(), 0,
    'забытая строка вернулась на B подсказкой из записей «Плана»',
  );
  await closeQuick(sessions.bob2.page);
  // Забытое не воскресает на A: строки нет, её шаблон помечен забытым
  await waitFor(async () => {
    const lines = await quickLinesOf(sessions.bob1.page);
    return !lines.some((line) => line.text === lineForgotten) && lines.some((line) => line.hidden);
  }, SYNC_TIMEOUT_MS, 'на A — строка истории, забытая на B');
  await openQuick(sessions.bob1.page);
  await sessions.bob1.page.locator('#planner-quick-input').fill('лету');
  await historySuggestion(sessions.bob1.page, lineKept).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(
    await sessions.bob1.page.locator('[data-quick-suggestion][data-text*="12:00"]').count(), 0,
    'строка, забытая на B, предлагается на A',
  );
  await closeQuick(sessions.bob1.page);
  await closePlanner(sessions.bob1.page);
  console.log('OK: история ввода текстом — подсказки первого устройства на втором, «Забыть» действует на оба');

  // Сброс на B: словарь очищен на обоих устройствах
  await planner2b.getByRole('button', { name: 'Planner settings' }).click();
  await planner2b.locator('[data-quick-learned-reset]').click();
  await planner2b.getByText('Learned defaults reset').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner2b.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await closePlanner(sessions.bob2.page);
  await waitFor(async () => !(await learnedWordOf(sessions.bob1.page, learnedHead)), SYNC_TIMEOUT_MS, 'на A — словарь правок сброшен с B');
  await openQuick(sessions.bob1.page);
  await sessions.bob1.page.locator('#planner-quick-input').fill(`${learnedHead} завтра 13:00`);
  await expectQuickTime(sessions.bob1.page, '13:00–14:00');
  assert.equal(await learnedChip(sessions.bob1.page).count(), 0, 'после сброса на B выученного на A нет');
  // Вместе со словарём сброшена история строк — на обоих устройствах
  assert.deepEqual(await quickLinesOf(sessions.bob1.page), [], 'после сброса на B история ввода на A осталась');
  assert.equal(
    await sessions.bob1.page.locator('[data-quick-suggestion][data-source="history"]').count(), 0,
    'после сброса на B на A остались подсказки из истории',
  );
  await closeQuick(sessions.bob1.page);
  // Строка, набранная после сброса: её второе устройство покажет после своей перезагрузки
  const lineAfterReset = `${historyHead} завтра 9:00 15 мин`;
  await quickAdd(sessions.bob1.page, lineAfterReset, historyHead, '09:00–09:15');
  await closePlanner(sessions.bob1.page);
  console.log('OK: сброс выученного на втором устройстве очистил словарь и историю первого');

  // ── FR-006: очередь переживает перезагрузку ───────────────────────────────
  await bob2Context.setOffline(true);
  await createTask(sessions.bob2.page, taskE, '14:00');
  await sessions.bob2.page.waitForTimeout(3000);
  await bob2Context.setOffline(false);
  await reloadPage(sessions.bob2.page);
  await relogin(sessions.bob2.page, PASSWORD).catch(() => undefined);
  await sessions.bob2.page.locator('#FoldersSidebar').waitFor({ state: 'visible', timeout: 60000 });
  await expectTaskInDay(sessions.bob2.page, taskE, true);
  // История ввода текстом после перезагрузки второго устройства: строка первого — по-прежнему подсказка
  await waitFor(
    async () => (await quickLinesOf(sessions.bob2.page)).some((line) => line.text === lineAfterReset),
    SYNC_TIMEOUT_MS, 'на B после перезагрузки — строка истории, набранная на A',
  );
  await openQuick(sessions.bob2.page);
  await sessions.bob2.page.locator('#planner-quick-input').fill('план');
  await historySuggestion(sessions.bob2.page, lineAfterReset).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('после перезагрузки B нет подсказки из строки, набранной на A'));
  await closeQuick(sessions.bob2.page);
  await closePlanner(sessions.bob2.page);
  await expectTaskInDay(sessions.bob1.page, taskE, true);
  await closePlanner(sessions.bob1.page);
  console.log('OK: правка без сети ушла после перезагрузки; история ввода текстом на месте');

  // ── US3: перенос данных этапа 1 ───────────────────────────────────────────
  const carol = `psync-carol-${suffix}@local`;
  const legacyTask = `Старая-${suffix}`;
  const carolContext = await browser.newContext({ viewport: WIDE });
  sessions.carol = await preparePage(carolContext, carol, PASSWORD);
  await dismissRecoveryKeyDialog(sessions.carol.page).catch(() => undefined);
  await sessions.carol.page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, { timeout: STEP_TIMEOUT_MS });
  const legacy = {
    version: 1,
    nextId: 3,
    projects: ['', 'Дом'],
    budget: 600,
    tasks: [
      { id: 1, name: legacyTask, description: '', steps: [], status: 'queue', project: 'Дом', rank: 0, day: todayKey(), start: '15:00', minutes: 30 },
      { id: 2, name: `Вторая-${suffix}`, description: '', steps: [], status: 'queue', project: '', rank: 1 },
    ],
    events: [],
    nutrition: {},
    calorieGoal: { target: 2000, tolerance: 100 },
    macroGoals: { protein: { target: 120, tolerance: 20 }, fat: { target: 70, tolerance: 15 }, carbs: { target: 230, tolerance: 30 } },
  };
  await sessions.carol.page.evaluate((state) => window.__parvaneDiagCallApi('parvaneSavePlanner', { state }), legacy);
  await expectTaskInDay(sessions.carol.page, legacyTask, true);
  await sessions.carol.page.waitForFunction(async () => {
    const r = await window.__parvaneDiagCallApi('parvaneLoadPlanner');
    return Boolean(r?.state?.migrated);
  }, undefined, { timeout: SYNC_TIMEOUT_MS });
  await closePlanner(sessions.carol.page);
  await reloadPage(sessions.carol.page);
  await relogin(sessions.carol.page, PASSWORD).catch(() => undefined);
  await sessions.carol.page.locator('#FoldersSidebar').waitFor({ state: 'visible', timeout: 60000 });
  await expectTaskInDay(sessions.carol.page, legacyTask, true);
  // Панель дня тоже показывает задачу — считаем в заново открытом разделе
  await closePlanner(sessions.carol.page);
  const planner3 = await openPlanner(sessions.carol.page);
  await openPlannerScreen(planner3.page(), 'today');
  const todayTasks = planner3.locator('[data-today-tasks]');
  await todayTasks.getByText(legacyTask).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await todayTasks.getByText(legacyTask).count(), 1, 'после перезагрузки задача не продублирована');
  await closePlanner(sessions.carol.page);
  console.log('OK: данные этапа 1 перенесены один раз');

  // ── US4: третье устройство стартует со снимка ─────────────────────────────
  // Порог снимка — 200 операций: bob1 и bob2 параллельно пишут по 105 правок,
  // снимок кладёт тот, у кого журнал дошёл до порога
  await closePlanner(sessions.bob1.page).catch(() => undefined);
  await closePlanner(sessions.bob2.page).catch(() => undefined);
  await Promise.all([seedOps(sessions.bob1.page, 105, `сид1-${suffix}`), seedOps(sessions.bob2.page, 105, `сид2-${suffix}`)]);
  await waitFor(() => domainsCounts().ops >= 210, 90000, 'операции сида в журнале контейнера');
  await waitFor(() => domainsCounts().snapshots >= 1, 60000, 'снимок контейнера');
  const bob3Context = await browser.newContext({ viewport: WIDE });
  sessions.bob3 = await preparePage(bob3Context, bob, PASSWORD);
  await sessions.bob3.page.waitForTimeout(2000);
  await linkSecondDevice(sessions.bob1.page, sessions.bob3.page);
  const startedAt = Date.now();
  await expectTaskInDay(sessions.bob3.page, taskD, true, 15000);
  const firstDataMs = Date.now() - startedAt;
  await closePlanner(sessions.bob3.page);
  assert.ok(sessions.bob3.logs.some((l) => l.includes('планировщик: снимок применён')), 'третье устройство стартовало не со снимка');
  assert.ok(firstDataMs <= 5000, `данные на третьем устройстве появились за ${firstDataMs} мс (> 5 с)`);
  console.log(`OK: третье устройство стартовало со снимка, данные за ${firstDataMs} мс`);

  // ── SC-003: сервер хранит только шифртекст ────────────────────────────────
  const check = plaintextLeaks([
    taskA, taskB, taskC, taskD, taskE, legacyTask, `сид1-${suffix} 7`, learnedHead, historyHead,
  ]);
  assert.ok(check.ops >= 5, `в журнале контейнеров мало операций: ${check.ops}`);
  assert.deepEqual(check.leaks, [], `названия в базе открытым текстом: ${check.leaks}`);
  console.log(`OK: в базе шарда domains ${check.ops} операций, названий открытым текстом нет`);

  console.log('e2e_web_planner_sync: OK');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${BACKEND_DIR}/planner-sync-${name}.png` }).catch(() => {});
    console.log(`--- журнал ${name} ---\n${(session.logs || []).filter((l) => l.includes('планировщик') || l.includes('v2:')).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
