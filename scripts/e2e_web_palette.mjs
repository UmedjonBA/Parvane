// Общий поиск (палитра Ctrl+K; доски `DeskOverlays`, `XpStart`): команды-переходы, заметки (по названию и тексту),
// файлы «Файлов», записи «Плана» (задача, событие), чаты, треки «Музыки»; стрелки и Enter, Escape, кнопка боковой
// панели; команды с запросом («Новая заметка «…»» и Ctrl+Enter, «Найти и скачать трек «…»»), Tab «только в этом
// модуле», подвал клавиш; заметки догружаются, пока «Заметки» не открывались; Ctrl+K с выделенным текстом в поле
// сообщения остаётся редактору («вставить ссылку»). Телефон: значок поиска в шапке «Чатов» открывает экран поиска
// с «Назад», «Очистить», чипами модулей и подсказкой; «Искать в сообщениях» ведёт в поиск по чатам; лупы «Плана»
// и «Файлов» ищут по своему модулю.
// Запуск: scripts/run_web_palette_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  openPlannerHeader,
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
const FILE = 'wg0-palette.conf';
const NEW_NOTE = 'Палитра заметка';

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
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await visible(knowledge, 'раздел заметок');
  // Справка нового хранилища пишется по одной заметке: дождаться её, чтобы не спорить с её записью
  await visible(knowledge.locator('[data-note-row="Overview"]'), '«Обзор» справки нового хранилища');
  await sidebar.locator('[data-add-for="notes"]').click();
  const note = knowledge.locator('[data-note-id]');
  // «Обзор» справки открывается сам: ждём именно новую заметку, иначе название достаётся «Обзору»
  await visible(knowledge.locator('[data-note-title="New note"]'), 'новая заметка открыта');
  const title = note.getByLabel('Note title');
  await title.fill(NOTE);
  await title.blur();
  await visible(knowledge.locator(`[data-note-row="${NOTE}"]`), 'строка заметки');
  await note.getByRole('button', { name: 'Edit' }).first().click();
  await page.locator('#knowledge-note-editor').fill(
    [`# ${NOTE}`, '', 'Стоит в шкафу.', `Заменить ${NOTE_WORD} до зимы`].join('\n'),
  );
  await note.getByRole('button', { name: 'Save' }).first().click();
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
  await sidebar.getByRole('button', { name: /^Global search/ }).click();
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
  // Команды при запросе — последней группой (доска `DeskOverlays`): выше — заметки справки со словом
  const groups = await list.locator('[data-palette-group]').evaluateAll((els) => els.map((el) => el.dataset.paletteGroup));
  assert.equal(groups[groups.length - 1], 'command', `команды не последние: ${groups.join(',')}`);
  await found('command', 'Health').first().click();
  await hidden(input, 'Enter не закрыл палитру');
  await visible(page.locator('#ParvaneHealth'), 'модуль «Здоровье» по команде');
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
  // Шаг события ищется так же, как шаг задачи
  const eventSteps = side.locator('[data-card-row="steps"]');
  await eventSteps.getByPlaceholder('Add step').fill('Взять зарядку палитры');
  await eventSteps.getByPlaceholder('Add step').press('Enter');
  await visible(eventSteps.getByText('Steps · 0/1'), 'шаг события в карточке');
  await side.getByRole('button', { name: 'Close' }).first().click();
  await openByKeys();
  await input.fill('зарядку палитры');
  await visible(found('record', EVENT), 'событие по тексту шага');
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл палитру после поиска шага');
  console.log('OK: задача и событие открываются карточкой в «Плане», шаг события находится');

  // ── Чат; сочетание в поле сообщения ───────────────────────────────────────
  await openByKeys();
  await input.fill('saved mess');
  await visible(found('chat', 'Saved Messages'), '«Избранное» в палитре');
  // Заметки стоят выше чатов (доска): в справке слово тоже встречается — выбираем строку чата
  await found('chat', 'Saved Messages').first().click();
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
  // «/» в поле сообщения печатается, вне поля — открывает палитру (как в прототипе)
  await composer.click();
  await page.keyboard.type('/');
  await page.waitForTimeout(500);
  assert.equal(await input.isVisible(), false, '«/» в поле сообщения открыл палитру');
  assert.ok((await composer.innerText()).includes('/'), '«/» не напечатался в поле сообщения');
  await page.keyboard.press('Backspace');
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  await page.keyboard.press('/');
  await visible(input, 'палитра по «/» вне поля ввода');
  assert.equal(await input.inputValue(), '', '«/» попал в поле палитры');
  await page.keyboard.press('Escape');
  await hidden(input, 'Escape не закрыл палитру, открытую «/»');
  console.log('OK: «/» открывает палитру вне поля ввода и печатается в поле сообщения');

  // ── Файлы, треки, команды с запросом, Ctrl+Enter, Tab, подвал (доска `DeskOverlays`) ──
  const cloud = page.locator('#ParvaneCloud');
  await sidebar.getByRole('tab', { name: 'Files' }).click();
  await visible(cloud, '«Файлы»');
  await page.waitForFunction(() => document.querySelector('#ParvaneCloud')?.dataset.loaded === '1', undefined, {
    timeout: NOTES_TIMEOUT_MS,
  }).catch(() => assert.fail('«Файлы» не загрузились'));
  await cloud.locator('input[type="file"]').setInputFiles([
    { name: FILE, mimeType: 'text/plain', buffer: Buffer.from('[Interface]\nAddress = 10.0.0.2/24\n') },
  ]);
  await visible(cloud.locator(`[data-node-id][data-name="${FILE}"]`), 'загруженный файл');
  await sidebar.getByRole('tab', { name: /^Chats/ }).click();
  await openByKeys();
  await visible(page.locator('[data-palette-footer]'), 'подвал клавиш');
  assert.match(await page.locator('[data-palette-footer]').innerText(), /Enter open.*Tab only in this module/s, 'подвал не по доске');
  assert.equal(await input.getAttribute('placeholder'), 'Chat, note, event, file or command', 'подсказка поля не по доске');
  await input.fill('wg0-pal');
  await visible(found('file', FILE), 'файл «Файлов» в выдаче');
  assert.match(await found('file', FILE).innerText(), /My drive · \d/, 'у файла нет места и размера');
  await selectedIs(/^file:/, 'найденный файл не выбран');
  await visible(selected.locator('kbd').getByText('Enter', { exact: true }), '«Enter» у выбранной строки');
  await page.keyboard.press('Enter');
  await visible(cloud.locator(`[data-node-id][data-name="${FILE}"][aria-current="true"]`), 'файл открыт в «Файлах»');
  console.log('OK: файл находится по имени, Enter открывает его в «Файлах»; подвал и «Enter» у строки');

  // Tab — только в открытом модуле («Файлы»), повторный Tab — снова везде
  await openByKeys();
  await input.fill('палитр');
  await visible(found('note', NOTE).or(found('record', TASK)), 'выдача по всем модулям');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await page.locator('[data-palette-scope="files"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('Tab не сузил выдачу до «Файлов»'));
  await page.waitForTimeout(400);
  assert.equal(await group('record').count(), 0, 'в выдаче «Файлов» остались записи «Плана»');
  assert.equal(await group('note').count(), 0, 'в выдаче «Файлов» остались заметки');
  assert.equal(await input.getAttribute('placeholder'), 'Search: Files', 'подсказка не говорит о модуле');
  await page.keyboard.press('Tab');
  await page.locator('[data-palette-scope="all"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('повторный Tab не вернул выдачу по всему'));
  await visible(found('record', TASK), 'после повторного Tab — снова записи «Плана»');
  console.log('OK: Tab сужает выдачу до открытого модуля и возвращает обратно');

  // Команды с запросом: «Новая заметка «…»» (Ctrl+Enter — без выбора строки), «Искать в сообщениях»
  await input.fill(NEW_NOTE);
  const newNoteRow = list.locator('[data-palette-item="newnote:query"]');
  await visible(newNoteRow, 'команда «Новая заметка «…»»');
  assert.equal(await newNoteRow.locator('kbd').innerText(), 'Ctrl+Enter', 'у новой заметки нет «Ctrl+Enter»');
  await visible(list.locator('[data-palette-item="chat-search"]'), '«Искать в сообщениях»');
  await page.keyboard.press('Control+Enter');
  await hidden(input, 'Ctrl+Enter не закрыл палитру');
  await visible(knowledge.locator(`[data-note-title="${NEW_NOTE}"]`), 'заметка с названием из запроса');
  console.log('OK: Ctrl+Enter создаёт заметку с набранным названием');

  // «Музыка» (библиотека поддельного сервера): трек в выдаче с исполнителем, «Найти и скачать трек «…»»
  await openByKeys();
  await input.fill('harbor');
  await visible(found('music', 'Harbor Lights'), 'трек «Музыки» в выдаче');
  assert.match(await found('music', 'Harbor Lights').innerText(), /Тихий порт · on the server/, 'у трека нет исполнителя');
  assert.match(await found('music', 'Harbor Lights').innerText(), /0:30/, 'у трека нет длительности');
  // Раздел «Музыка» (доска `MusicChat-03`): трек каталога, которого нет на сервере
  await input.fill('автобус');
  await visible(group('music').locator('[data-palette-item^="catalog:"]').filter({ hasText: 'Ночной автобус' }),
    'трек каталога в разделе «Музыка»');
  await input.fill('harbor');
  await visible(found('music', 'Harbor Lights'), 'трек «Музыки» в выдаче');
  const fetchRow = list.locator('[data-palette-item="fetch:query"]');
  await visible(fetchRow, 'команда «Найти и скачать трек «…»»');
  await fetchRow.click();
  await visible(page.locator('#ParvaneMusic'), '«Музыка» по команде «Найти и скачать»');
  await page.waitForFunction(() => [...document.querySelectorAll('#ParvaneMusic input[type="search"]')]
    .some((field) => field.value === 'harbor'), undefined, { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('поиск «Музыки» без запроса из палитры'));
  await openByKeys();
  await input.fill('harbor');
  await found('music', 'Glass Harbor').click();
  // В «Музыке» что играет — плеер внизу модуля, в другом разделе — виджет панели
  await visible(page.locator('[data-music-desk-player]').or(page.locator('[data-music-widget]')).first(), 'трек из палитры играет');
  console.log('OK: треки «Музыки» в выдаче, «Найти и скачать» открывает поиск с запросом, трек играет');
  await sidebar.getByRole('tab', { name: /^Chats/ }).click();

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
  // Заметка на телефоне занимает весь экран, ленты модулей под ней нет — сначала назад к списку
  await knowledge.getByRole('button', { name: 'Back to notes' }).click();
  await openPlannerScreen(page, 'calendar');
  // Лупа «Плана» открывает поиск по плану (экран с чипами, spec 041 E1), а не палитру: команд и чатов в нём нет
  await openPlannerHeader(page, 'search');
  const planSearch = planner.locator('[data-planner-search]');
  await visible(planSearch.locator('[data-planner-search-input]'), 'поиск по плану по лупе «Плана» на телефоне');
  await planSearch.locator('[data-planner-search-input]').fill('files');
  await page.waitForTimeout(400);
  assert.equal(await group('command').count(), 0, 'в поиске по плану есть команды');
  await page.keyboard.press('Escape');
  await hidden(planSearch, 'Escape не закрыл поиск по плану');
  // Ctrl+K — по-прежнему общий поиск
  await page.keyboard.press('Control+k');
  await page.locator('[data-palette-scope="all"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await input.fill('files');
  await list.locator('[data-palette-item="nav:cloud"]').click();
  // Команда «Файлы» открывает модуль «Файлы»; лупа в шапке ищет по файлам
  await visible(cloud, '«Файлы» по команде на телефоне');
  const cloudHeader = cloud.locator('header');
  await cloudHeader.locator('[data-section-search-open]').click();
  // Поиск «Файлов» на телефоне — свой экран с полем (доска `ZpFilesX`, исполнитель files)
  await visible(cloud.getByPlaceholder('Search files'), 'поле поиска по файлам');
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/palette-phone.png` });
  }
  // Экран поиска «Файлов» закрывается своей стрелкой «Назад»
  await cloudHeader.getByRole('button', { name: 'Back' }).first().click();
  await hidden(cloud.getByPlaceholder('Search files'), 'экран поиска «Файлов» не закрылся');
  console.log('OK: на телефоне лупа «Плана» ищет по плану, лупа «Файлов» — по файлам, Ctrl+K — везде');

  // ── Телефон: значок поиска в шапке «Чатов» — экран общего поиска (доска `XpStart`) ──
  await page.locator('[data-module="chats"]').first().click();
  // На телефоне открытый раньше чат («Избранное» из палитры) закрывает список — к списку стрелкой чата
  const chatBack = page.locator('#MiddleColumn .MiddleHeader').getByRole('button', { name: 'Back' });
  // Чат выезжает переходом: стрелку ждать, а не читать сразу (заголовок списка под чатом остаётся «видимым»)
  if (await chatBack.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await chatBack.click();
  await waitForChatList(page, STEP_TIMEOUT_MS);
  await page.locator('#LeftMainHeader #telegram-search-input').click();
  await visible(input, 'общий поиск по значку шапки «Чатов» на телефоне');
  assert.equal(await input.getAttribute('placeholder'), 'Chat, note, event, file or track', 'подсказка поля телефона');
  const back = page.locator('[data-palette-back]');
  await visible(back, '«Назад» в шапке поиска');
  await visible(page.locator('[data-palette-hint]'), 'подсказка под выдачей');
  const chips = await page.locator('[data-palette-filter]').evaluateAll((els) => els.map((el) => el.dataset.paletteFilter));
  assert.deepEqual(chips, ['all', 'chats', 'plan', 'notes', 'files', 'music'], `чипы не по доске: ${chips}`);
  // Экран во весь рост
  const box = await page.locator('[data-palette]').boundingBox();
  assert.ok(box && box.height >= PHONE.height - 2 && box.width >= PHONE.width - 2, `поиск не во весь экран: ${JSON.stringify(box)}`);
  await input.fill('палитр');
  await visible(found('record', TASK), 'запись «Плана» на телефоне');
  await page.locator('[data-palette-filter="notes"]').click();
  await page.locator('[data-palette-scope="notes"]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await visible(found('note', NEW_NOTE), 'заметка под чипом «Заметки»');
  await page.waitForTimeout(400);
  assert.equal(await group('record').count(), 0, 'чип «Заметки» оставил записи «Плана»');
  await page.locator('[data-palette-filter="all"]').click();
  await input.fill('wg0-pal');
  await visible(found('file', FILE), 'файл на телефоне');
  await page.locator('[data-palette-clear]').click();
  // Поле очищается кадром позже нажатия — ждём, а не читаем сразу
  await page.waitForFunction((el) => el.value === '', await input.elementHandle(), { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('«Очистить» не стёр запрос'));
  await visible(group('command'), 'после «Очистить» — команды');
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await input.fill('палитр');
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/palette-phone-screen.png` });
  }
  await back.click();
  await hidden(input, '«Назад» не закрыл поиск');
  // «Искать в сообщениях» — прежний поиск по чатам с этим запросом
  await page.locator('#LeftMainHeader #telegram-search-input').click();
  await visible(input, 'общий поиск второй раз');
  await input.fill('saved');
  await list.locator('[data-palette-item="chat-search"]').click();
  await hidden(input, 'поиск в сообщениях не закрыл палитру');
  await visible(page.locator('.LeftSearch'), 'поиск по чатам с запросом');
  assert.equal(await page.locator('#telegram-search-input').inputValue(), 'saved', 'запрос не перешёл в поиск по чатам');
  console.log('OK: телефон — экран поиска значком шапки, чипы, «Очистить», «Назад», поиск в сообщениях');

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
