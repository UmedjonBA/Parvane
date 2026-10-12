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
  openPlannerScreen,
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

// Ближайший будущий вторник («вт» в строке ввода; сегодняшний день не считается)
function nextTuesdayKey() {
  return dayKey(((2 - new Date().getDay() + 7) % 7) || 7);
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

  // ── Цветовая схема по умолчанию — Gruvbox (spec 019): панели окрашены её цветом ──
  const panelColor = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--color-background)';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  assert.ok(['rgb(251, 241, 199)', 'rgb(40, 40, 40)'].includes(panelColor), `панель не в цветах Gruvbox: ${panelColor}`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/scheme-chats-phone.png` });
  console.log('OK: цветовая схема Gruvbox применена');

  // ── «+» из списка чатов открывает «План» и строку ввода ───────────────────
  await tabBar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // На списке чатов «+» открывает меню, запись в план — его пункт
  await tabBar.getByRole('button', { name: 'New entry' }).click();
  await tabBar.getByRole('menuitem', { name: 'Planner entry' }).click();
  await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  await openPlannerScreen(page, 'today');
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
  await page.waitForTimeout(700);
  // Выделение вкладки — вырез, съезжающий на выбранную: после анимации он стоит у левого края («Сегодня»)
  const clip = await planner.locator('header [aria-hidden="true"]').first().evaluate((el) => el.style.clipPath);
  const leftInset = Number(/inset\(\S+ \S+ \S+ ([\d.]+)%/.exec(clip)?.[1]);
  assert.ok(leftInset < 10, `выделена должна быть вкладка «Сегодня»: ${clip}`);
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

  // ── Числительные словами и явные метки: #список, @место, ! ────────────────
  const namePart = form.locator('[data-quick-part="name"] [dir="auto"]');
  const LIST_NAME = 'Ремонт';
  await openQuick();
  await input.fill('планёрка завтра в пять вечера');
  await expectKind('event');
  assert.equal((await chip('time').innerText()).trim(), '17:00–18:00');
  assert.equal((await namePart.innerText()).trim(), 'планёрка');
  // Число, которое никто не забрал, остаётся словом
  await input.fill('купить пять кистей');
  await expectKind('task');
  assert.equal((await namePart.innerText()).trim(), 'купить пять кистей');
  await input.fill(`купить краску #${LIST_NAME} @Леруа !`);
  await expectKind('task');
  assert.equal((await chip('list').innerText()).trim(), `#${LIST_NAME}`);
  assert.equal((await chip('place').innerText()).trim(), '@Леруа');
  assert.equal(await chip('important').count(), 1, '«!» распознан как «важное»');
  assert.equal((await namePart.innerText()).trim(), 'купить краску');
  // Снятая метка возвращается в название
  await chip('important').getByRole('button').click();
  await chip('important').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal((await namePart.innerText()).trim(), 'купить краску !');
  await input.fill(`купить краску #${LIST_NAME} @Леруа`);
  await submit('купить краску');
  // Второе упоминание списка в другом регистре находит тот же список
  await openQuick();
  await input.fill(`купить валик #${LIST_NAME.toLowerCase()}`);
  await expectKind('task');
  await submit('купить валик');
  console.log('OK: «в пять вечера» — время, #список, @место и ! — чипами');

  // ── Словарь правок: одна и та же длительность трижды — на четвёртый раз подставляется сама ──
  const learnedChip = form.locator('[data-quick-chip="minutes"][data-learned="1"]');
  for (const hour of ['10', '11', '12']) {
    await openQuick();
    await input.fill(`летучка завтра ${hour}:00 20 мин`);
    await expectKind('event');
    assert.equal((await chip('time').innerText()).trim(), `${hour}:00–${hour}:20`);
    assert.equal(await learnedChip.count(), 0, 'названная длительность — не выученная');
    await submit('летучка');
  }
  await openQuick();
  await input.fill('летучка завтра 13:00');
  await expectKind('event');
  await learnedChip.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal((await chip('time').innerText()).trim(), '13:00–13:20');
  // Снятый чип выученного возвращает обычную длительность; правка строки возвращает выученное
  await learnedChip.getByRole('button').click();
  await learnedChip.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal((await chip('time').innerText()).trim(), '13:00–14:00');
  await input.fill('Летучка завтра 13:00');
  await learnedChip.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await submit('Летучка');
  console.log('OK: длительность, исправленная трижды, на четвёртый раз подставлена сама');

  // ── Другие чтения: «в 7» — вечер по окну дня, утро — вариантом чипа ───────
  const expectTime = async (expected) => {
    await page.waitForFunction(
      (value) => document.querySelector('form[data-quick-kind] [data-quick-chip="time"]')?.innerText.trim() === value,
      expected,
      { timeout: STEP_TIMEOUT_MS },
    );
  };
  const altToggle = chip('time').locator('[data-quick-alt-toggle]');
  const altItem = (pick) => form.locator(`[data-quick-alts="time"] [data-quick-alt="${pick}"]`);
  const altMenu = form.locator('[data-quick-alts]');
  await openQuick();
  await input.fill('планёрка завтра в 7');
  await expectKind('event');
  await expectTime('19:00–20:00');
  await altToggle.click();
  await altItem('07:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await altItem('07:00').click();
  await expectTime('07:00–08:00');
  await altMenu.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Прежнее чтение осталось вариантом
  await altToggle.click();
  await altItem('19:00').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await altToggle.click();
  await altMenu.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Правка строки сбрасывает выбранное чтение; у однозначного времени вариантов нет
  await input.fill('планёрка завтра в 7 ');
  await expectTime('19:00–20:00');
  await input.fill('планёрка завтра в 7 утра');
  await expectTime('07:00–08:00');
  assert.equal(await altToggle.count(), 0, 'у однозначного времени вариантов нет');
  // Тип записи — тоже чтение: событие со временем можно прочитать задачей
  await form.locator('[data-quick-alt-toggle="kind"]').click();
  await form.locator('[data-quick-alts="kind"] [data-quick-alt="task"]').click();
  await expectKind('task');
  await form.getByRole('radio', { name: 'Auto' }).click();
  await expectKind('event');
  await input.fill('планёрка завтра в 7');
  await expectTime('19:00–20:00');
  await altToggle.click();
  await altItem('07:00').click();
  await expectTime('07:00–08:00');
  await submit('планёрка');
  console.log('OK: другое чтение времени и типа выбирается из вариантов чипа');

  // ── Название и описание (отзыв 12 окт 2026): «пара» — 1 ч 45 мин, «будет…» — описание ──
  const OWNER_NAME = 'пара по Английскому';
  const OWNER_DESCRIPTION = 'будет тест лисининг';
  await openQuick();
  await input.fill('вт 15:00 пара по Английскому будет тест  лисининг');
  await expectKind('event');
  assert.equal((await chip('time').innerText()).trim(), '15:00–16:45');
  assert.equal((await namePart.innerText()).trim(), OWNER_NAME);
  assert.equal((await chip('description').locator('[dir="auto"]').innerText()).trim(), OWNER_DESCRIPTION);
  // Снятое описание возвращается в название; правка строки делит заново
  await chip('description').getByRole('button').click();
  await chip('description').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal((await namePart.innerText()).trim(), `${OWNER_NAME} ${OWNER_DESCRIPTION}`);
  await input.fill('вт 15:00 пара по Английскому будет тест лисининг');
  await chip('description').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/quick-input-description-phone.png` });
  await submit(OWNER_NAME);
  console.log('OK: название и описание разделены, «пара» длится 1 ч 45 мин');

  // ── Повтор; «Подробнее» ведёт в полную форму ──────────────────────────────
  await openQuick();
  await input.fill('урок вт 15:00 каждую неделю 5 мес');
  await expectKind('event');
  assert.match((await chip('repeat').innerText()).trim(), /Tue/);
  assert.equal((await chip('time').innerText()).trim(), '15:00–15:45');
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
  await openPlannerScreen(page, 'calendar');
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Month', exact: true }).click();
  await planner.locator(`[role="gridcell"][data-day="${dayKey(1)}"]`).click({ position: { x: 10, y: 10 } });
  await planner.locator('[data-planner-day]').getByText('Быстрый созвон').first()
    .waitFor({ state: 'visible', timeout: 30000 });
  // Задачи без даты — в шторке «Без даты» экрана «Сегодня»
  await openPlannerScreen(page, 'today');
  await planner.locator('[data-today-undated]').click();
  const undatedSheet = page.locator('[data-planner-undated]');
  await undatedSheet.getByText('сдать отчёт').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await undatedSheet.getByText('купить кабель').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Список из метки создан один раз, обе задачи — в нём
  const listSection = undatedSheet.locator(`[data-project="${LIST_NAME}"]`);
  await listSection.getByText('купить краску').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await listSection.getByText('купить валик').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await undatedSheet.locator('[data-project]').count(), 2, 'списки: «Без списка» и один из метки');
  await page.keyboard.press('Escape');
  await undatedSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // На компьютере ввод открывается кнопкой в шапке
  const openQuickWide = async () => {
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
    await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  // Окно ловит Escape со следующего кадра после появления — нажатие повторяется, пока окно не закрылось
  const closeQuickWide = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.keyboard.press('Escape');
      if (await input.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)) return;
    }
    assert.fail('окно ввода не закрылось по Escape');
  };
  await openQuickWide();
  await closeQuickWide();
  console.log('OK: записи пережили перезагрузку; на компьютере ввод открывает «+ Запись»');

  // ── Словарь правок хранится в данных «Плана»: пережил перезагрузку; «Сбросить выученное» его очищает ──
  assert.deepEqual(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('parvane:quick-learned:'))),
    [], 'словарь правок не должен оставаться в localStorage',
  );
  await openQuickWide();
  await input.fill('летучка завтра 15:00');
  await expectKind('event');
  await learnedChip.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal((await chip('time').innerText()).trim(), '15:00–15:20');
  await closeQuickWide();
  await planner.getByRole('button', { name: 'Planner settings' }).click();
  await planner.locator('[data-quick-learned-reset]').click();
  await planner.getByText('Learned defaults reset').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
  await openQuickWide();
  await input.fill('летучка завтра 15:00');
  await expectKind('event');
  assert.equal((await chip('time').innerText()).trim(), '15:00–16:00');
  assert.equal(await learnedChip.count(), 0, 'после сброса выученного нет');
  await closeQuickWide();
  console.log('OK: выученное пережило перезагрузку и сброшено в настройках плана');

  // ── Событие с описанием после перезагрузки: строка в расписании дня и карточка события ──
  await openPlannerScreen(page, 'calendar');
  await planner.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Month', exact: true }).click();
  await planner.locator(`[role="gridcell"][data-day="${nextTuesdayKey()}"]`).click({ position: { x: 10, y: 10 } });
  const ownerBlock = planner.locator('[data-planner-day] [data-block]', { hasText: OWNER_NAME });
  await ownerBlock.waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await ownerBlock.innerText(), /15:00–16:45/);
  assert.equal((await ownerBlock.locator('[data-block-note]').innerText()).trim(), OWNER_DESCRIPTION);
  await ownerBlock.getByRole('button').click();
  const descriptionField = planner.locator('#planner-event-description');
  await descriptionField.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await descriptionField.inputValue(), OWNER_DESCRIPTION);
  assert.equal(await planner.locator('#planner-event-name').inputValue(), OWNER_NAME);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/event-description-wide.png` });
  console.log('OK: событие «пара» 15:00–16:45 с описанием пережило перезагрузку');

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
