// Общий поиск (палитра Ctrl+K): команды-переходы, заметки (по названию и тексту), записи «Плана»
// (задача, событие), чаты; стрелки и Enter, Escape, кнопка «Поиск» боковой панели и лупа в шапке раздела на
// телефоне; заметки догружаются, пока «Знания» не открывались; Ctrl+K с выделенным текстом в поле сообщения
// остаётся редактору («вставить ссылку»).
// Запуск: scripts/run_web_palette_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  openPlannerScreen,
  preparePage,
  relogin,
  waitForChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-palette-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;
// Первое чтение заметок после перезагрузки: облако, затем тексты по одному
const NOTES_TIMEOUT_MS = 60000;
const NOTE = 'Сервер X99';
const NOTE_WORD = 'вентилятор';
const TASK = 'Проверить работы палитры';
const EVENT = 'Созвон палитры';
const COMMANDS = 11;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
let session;

try {
  const user = `palette-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const planner = page.locator('#ParvanePlanner');
  const input = page.locator('#parvane-palette-search');
  const list = page.locator('[data-palette-list]');
  const items = list.locator('[data-palette-item]');
  const selected = list.locator('[data-palette-item][aria-selected="true"]');
  const group = (name) => list.locator(`[data-palette-group="${name}"]`);
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не появилось: ${what}`));
  const hidden = (locator, what) => locator.first().waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(what));
  const openByKeys = async () => {
    await page.keyboard.press('Control+k');
    await visible(input, 'палитра по Ctrl+K');
    await page.waitForFunction(() => document.activeElement?.id === 'parvane-palette-search', undefined, {
      timeout: STEP_TIMEOUT_MS,
    }).catch(() => assert.fail('курсор не в поле палитры'));
  };
  // Строка нужной группы с этим названием — выбранная либо первая в группе
  const found = (groupName, title) => group(groupName).locator('[data-palette-item]').filter({ hasText: title });
  const selectedKey = () => selected.getAttribute('data-palette-item');
  // Выбор меняется перерисовкой после нажатия — ждём, а не читаем сразу
  const selectedIs = async (expected, message) => {
    const deadline = Date.now() + 3000;
    let actual;
    while (Date.now() < deadline) {
      actual = await selectedKey().catch(() => undefined);
      if (expected instanceof RegExp ? expected.test(actual || '') : actual === expected) return;
      await page.waitForTimeout(100);
    }
    assert.fail(`${message}: ${actual}`);
  };

  // ── Данные: заметка, задача и событие ─────────────────────────────────────
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(knowledge, 'раздел заметок');
  // Справка нового хранилища пишется по одной заметке: дождаться её, чтобы не спорить с её записью
  await visible(knowledge.locator('[data-note-row="Overview"]'), '«Обзор» справки нового хранилища');
  await knowledge.getByRole('button', { name: 'New note' }).click();
  const note = knowledge.locator('[data-note-id]');
  // «Обзор» справки открывается сам: ждём именно новую заметку, иначе название достаётся «Обзору»
  await visible(knowledge.locator('[data-note-title="New note"]'), 'новая заметка открыта');
  const title = note.getByLabel('Note title');
  await title.fill(NOTE);
  await title.blur();
  await visible(knowledge.locator(`[data-note-row="${NOTE}"]`), 'строка заметки');
  await note.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#knowledge-note-editor').fill(
    [`# ${NOTE}`, '', 'Стоит в шкафу.', `Заменить ${NOTE_WORD} до зимы`].join('\n'),
  );
  await note.getByRole('button', { name: 'Save' }).click();
  await visible(note.locator('[data-note-body]').getByText(NOTE_WORD), 'текст заметки');

  await openPlannerScreen(page, 'today');
  const quick = page.locator('#planner-quick-input');
  const addEntry = async (text, name) => {
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
    await visible(quick, 'окно ввода записи');
    await quick.fill(text);
    await quick.press('Enter');
    await planner.getByText(`Added: ${name}`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
      .catch(() => assert.fail(`запись «${name}» не добавлена`));
    await hidden(quick, 'окно ввода записи не закрылось');
  };
  await addEntry(`задача ${TASK}`, TASK);
  await addEntry(`${EVENT} завтра 16:00`, EVENT);
  console.log('OK: заметка, задача и событие созданы');

  // ── Ctrl+K из «Чатов»: пустой запрос — команды; Escape закрывает ──────────
  await sidebar.getByRole('tab', { name: /^Chats/ }).click();
  await waitForChatList(page, STEP_TIMEOUT_MS);
  await openByKeys();
  await visible(group('command'), 'группа команд');
  assert.equal(await items.count(), COMMANDS, 'пустой запрос показывает не только команды');
  assert.equal(await group('note').count(), 0, 'пустой запрос показывает заметки');
  await selectedIs('nav:chats', 'первая строка не выбрана');
  assert.equal(await input.getAttribute('type'), 'search', 'поле палитры — не поле поиска');
  assert.equal(await input.getAttribute('autocomplete'), 'off', 'у поля палитры включено автозаполнение');
  assert.equal(await page.locator('form[role="search"] #parvane-palette-search').count(), 1, 'поле палитры вне формы поиска');
  // Прежнее поведение сочетания (выбор чата Telegram) и кнопки (поиск по чатам) не срабатывает
  assert.equal(await page.locator('#telegram-search-input:focus').count(), 0, 'Ctrl+K увёл курсор в поиск по чатам');
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл палитру');
  await waitForChatList(page, STEP_TIMEOUT_MS);
  console.log('OK: Ctrl+K открывает палитру с командами, Escape закрывает');

  // ── Кнопка «Поиск» боковой панели; команда-переход; стрелки ───────────────
  await sidebar.getByRole('button', { name: 'Search' }).click();
  await visible(input, 'палитра по кнопке боковой панели');
  // Перехват стрелок ставится эффектом после открытия окна
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await selectedIs('nav:today', 'стрелка вниз не выбрала вторую строку');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await selectedIs('settings', 'стрелка вверх с первой строки не ушла на последнюю');
  await input.fill('HEAL');
  await visible(found('command', 'Health'), 'команда «Здоровье» по запросу без учёта регистра');
  // В заметках справки слово тоже встречается: команды стоят первой группой, выбрана команда
  await selectedIs('nav:health', 'по запросу выбрана не команда «Здоровье»');
  await page.keyboard.press('Enter');
  await hidden(input, 'Enter не закрыл палитру');
  await visible(planner.locator('[data-health="activity"]'), 'экран «Здоровье» по команде');
  console.log('OK: кнопка боковой панели, стрелки, команда-переход');

  // ── Заметка: по названию (регистр) и по тексту (отрывок) ──────────────────
  await openByKeys();
  await input.fill('сервер x9');
  await visible(found('note', NOTE), 'заметка по названию');
  await selectedIs(/^note:/, 'найденная заметка не выбрана');
  await page.keyboard.press('Enter');
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка, открытая из палитры');
  await openByKeys();
  await page.waitForFunction(() => document.querySelector('#parvane-palette-search')?.value === '', undefined, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => assert.fail('палитра открылась с прежним запросом'));
  await input.fill(NOTE_WORD.toUpperCase());
  await visible(found('note', NOTE).getByText(`Заменить ${NOTE_WORD} до зимы`), 'отрывок текста заметки с совпадением');
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл палитру в «Знаниях»');
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка осталась открытой после Escape');
  console.log('OK: заметка находится по названию и по тексту, Enter открывает её');

  // ── Задача и событие «Плана» ──────────────────────────────────────────────
  const side = planner.locator('[data-planner-side]');
  const sideHasValue = (kind, value) => page.waitForFunction(([wantedKind, wanted]) => {
    const pane = document.querySelector(`#ParvanePlanner [data-planner-side="${wantedKind}"]`);
    if (!pane) return false;
    return [...pane.querySelectorAll('input, textarea')].some((field) => field.value === wanted)
      || pane.textContent.includes(wanted);
  }, [kind, value], { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail(`карточка «${value}» не открылась`));
  await openByKeys();
  await input.fill('проверить работы');
  await visible(found('record', TASK), 'задача в палитре');
  await page.keyboard.press('Enter');
  await visible(planner, '«План» по задаче из палитры');
  await sideHasValue('task', TASK);
  await side.getByRole('button', { name: 'Close' }).first().click();

  await sidebar.getByRole('tab', { name: /^Chats/ }).click();
  await openByKeys();
  await input.fill('созвон палитры');
  await visible(found('record', EVENT), 'событие в палитре');
  await found('record', EVENT).click();
  await hidden(input, 'нажатие на строку не закрыло палитру');
  await visible(planner, '«План» по событию из палитры');
  await sideHasValue('event', EVENT);
  assert.equal(await planner.locator('#planner-event-name').inputValue(), EVENT, 'открыто другое событие');
  await side.getByRole('button', { name: 'Close' }).first().click();
  console.log('OK: задача и событие открываются карточкой в «Плане»');

  // ── Чат; сочетание в поле сообщения ───────────────────────────────────────
  await openByKeys();
  await input.fill('saved mess');
  await visible(found('chat', 'Saved Messages'), '«Избранное» в палитре');
  await page.keyboard.press('Enter');
  await visible(page.locator('.MiddleHeader').getByText('Saved Messages'), 'чат, открытый из палитры');
  const composer = page.locator('#editable-message-text[contenteditable="true"]');
  await visible(composer, 'поле сообщения');
  await composer.click();
  await page.keyboard.type('ссылка');
  // Без выделения Ctrl+K в поле сообщения — палитра
  await openByKeys();
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл палитру над чатом');
  // С выделенным текстом сочетание остаётся редактору («вставить ссылку»)
  await composer.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  assert.equal(await input.isVisible(), false, 'Ctrl+K с выделенным текстом открыл палитру вместо ссылки редактора');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  console.log('OK: чат открывается из палитры; Ctrl+K с выделением в поле сообщения остаётся редактору');

  // ── После перезагрузки заметки догружаются палитрой, «Знания» не открывались ──
  await sidebar.getByRole('tab', { name: /^Chats/ }).click();
  await relogin(page, PASSWORD);
  await dismissRecoveryKeyDialog(page, 3000).catch(() => undefined);
  await waitForChatList(page);
  assert.equal(await knowledge.count(), 0, 'после перезагрузки открыты «Знания»');
  await openByKeys();
  await input.fill('сервер');
  // Ввод не ждёт заметок: строка появляется в списке сама, когда хранилище прочитано
  await found('note', NOTE).first().waitFor({ state: 'visible', timeout: NOTES_TIMEOUT_MS })
    .catch(() => assert.fail('палитра не догрузила заметки'));
  await hidden(list.locator('[data-palette-loading]'), 'сообщение о загрузке осталось после чтения заметок');
  await input.fill('нет такого совсем');
  await visible(list.locator('[data-palette-empty]'), '«Ничего не найдено»');
  await input.fill('сервер');
  await found('note', NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка после перезагрузки');
  console.log('OK: заметки догружаются при открытии палитры');

  // ── Телефон: лупа в шапке раздела ─────────────────────────────────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await openPlannerScreen(page, 'calendar');
  // Лупа «Плана» ищет только по записям плана: команд и чатов в ней нет
  await planner.locator('[data-palette-open]').click();
  await visible(input, 'палитра по лупе «Плана» на телефоне');
  // Пустой список без запроса места не занимает — проверяем, что он есть, а не виден
  await page.locator('[data-palette-scope="plan"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await input.getAttribute('placeholder'), 'Search the plan', 'подпись поля поиска по плану');
  await input.fill('cloud');
  await page.waitForTimeout(400);
  assert.equal(await group('command').count(), 0, 'в поиске по плану есть команды');
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл поиск по плану');
  // Ctrl+K — по-прежнему общий поиск
  await page.keyboard.press('Control+k');
  await page.locator('[data-palette-scope="all"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await input.fill('cloud');
  await found('command', 'Cloud').click();
  // Команда «Облако» — вкладка «Файлы» раздела «Знания»; лупа в шапке ищет по файлам
  const cloud = page.locator('#ParvaneCloud');
  await visible(cloud, '«Файлы» по команде на телефоне');
  const cloudHeader = cloud.locator('header');
  await cloudHeader.locator('[data-section-search-open]').click();
  await visible(cloudHeader.locator('[data-section-search]'), 'поле поиска по файлам в шапке');
  await cloudHeader.locator('[role="tablist"]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/palette-phone.png` });
  }
  await cloudHeader.locator('[data-section-search-close]').click();
  await visible(cloudHeader.locator('[role="tablist"]'), 'вкладки «Файлов» после закрытия поиска');
  console.log('OK: на телефоне лупа «Плана» ищет по плану, лупа «Файлов» — по файлам, Ctrl+K — везде');

  assert.deepEqual(session.errors, [], `ошибки страницы: ${session.errors.join('; ')}`);
  console.log('e2e_web_palette: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${dir}/palette-failure.png` }).catch(() => {});
    console.log(`--- палитра при сбое ---\n${await page?.locator('[data-palette-list]').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
