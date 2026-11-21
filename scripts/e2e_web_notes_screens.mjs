// Экраны модуля «Заметки» по макету (spec 041 D1; доски `Notes`, `PhNotesMore`, `XpNotes`, `DeskNotes`, `ZdNotesX`):
// на компьютере колонка «Папки / Ещё» (холсты, справка по разметке, корзина), таблица заметок, Ctrl+N, Ctrl+B/I;
// «Заметки» и «Файлы» — отдельные модули; список — папки со счётчиком и недавние заметки, открытая папка, поиск
// одним списком; заметка на компьютере — режимы «Просмотр / Правка / Рядом» одной кнопкой (Ctrl+E), кнопки
// разметки и подсказка заметки для ссылки `[[…`, меню «Ещё»; на телефоне — шапка с названием, виды под ней,
// заметка на весь экран с «Изменить», глазком просмотра и шторкой действий. Снимки телефон/компьютер ×
// светлая/тёмная — в PARVANE_E2E_SHOT_DIR / PARVANE_E2E_BACKEND_LOG_DIR.
// Запуск: scripts/run_web_notes_screens_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import { dismissRecoveryKeyDialog, openNotesView, preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-screens-1';
// Размеры досок макета: окно компьютера и телефон
// Компьютер — с колонкой папок и «Связями» справа (доска `ZdNotesX`)
const DESK = { width: 1440, height: 800 };
const PHONE = { width: 360, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '';
const FOLDER = 'Сеть';
const NOTE = 'Настройка туннеля';
const OTHER = 'Резервные копии';
const GUIDE_OVERVIEW = 'Overview';
const WORD = 'маршрутизатор';
const CABINET = 'Шкаф';
const ARCHIVE = 'Архив';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: DESK });
let session;

try {
  const user = `nscr-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const cloud = page.locator('#ParvaneCloud');
  const note = knowledge.locator('[data-note-id]');
  const body = note.locator('[data-note-body]');
  const editor = page.locator('#knowledge-note-editor');
  const row = (title) => knowledge.locator(`[data-note-row="${title}"]`);
  const folderRow = (name) => knowledge.locator(`[data-notes-folders] [data-folder="${name}"]`);
  const menuItem = (action) => page.locator(`[data-note-menu-list] [data-note-action="${action}"]`);
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не появилось: ${what}`));
  const gone = (locator, what) => locator.first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(what));
  const mode = (wanted, what) => page.waitForFunction(
    (value) => document.querySelector('#ParvaneKnowledge [data-note-id]')?.dataset.noteMode === value, wanted,
    { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail(what));
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/notes-${name}.png` }).catch(() => undefined);
  };
  // Снимок в светлой и тёмной теме: клиент следует теме системы
  const shotBoth = async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(`${name}-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
  const setNoteTitle = async (title) => {
    // Поле названия подхватывает название открытой заметки эффектом — набор раньше него был бы стёрт
    await page.waitForTimeout(400);
    await note.getByLabel('Note title').fill(title);
    await note.getByLabel('Note title').blur();
    await visible(row(title), `строка заметки «${title}»`);
  };
  // Редактор после открытия правки ещё раз перерисовывается — заполнение может попасть в отцепленный узел
  const fillEditor = async (text) => {
    for (let attempt = 0; ; attempt++) {
      try { await editor.fill(text, { timeout: 5000 }); return; } catch (error) {
        if (attempt >= 4) throw error;
        await page.waitForTimeout(500);
      }
    }
  };
  await page.emulateMedia({ colorScheme: 'light' });

  // ── «Заметки» и «Файлы» — отдельные модули ───────────────────────────────
  await sidebar.getByRole('tab', { name: 'Files' }).click();
  await visible(cloud, 'модуль «Файлы»');
  assert.equal(await cloud.locator('[role="tab"][data-view]').count(), 0, 'в «Файлах» остались виды заметок');
  // На компьютере в шапке «Файлов» — путь от «Моего диска» (название модуля — в шапке телефона)
  await visible(cloud.locator('nav').getByRole('button', { name: 'My drive', exact: true }), 'путь в шапке «Файлов»');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await visible(knowledge, 'модуль «Заметки»');
  assert.equal(await cloud.isVisible(), false, '«Файлы» видны под «Заметками»');
  // Компьютер (`ZdNotesX`): «Список / Граф» в шапке, холсты, справка и корзина — в колонке «Ещё»
  assert.deepEqual(
    await knowledge.locator('[data-notes-desk-head] [role="tab"]').allInnerTexts(), ['List', 'Graph'],
    'виды «Заметок» в шапке — не «Список / Граф»',
  );
  assert.deepEqual(
    await knowledge.locator('[data-notes-column] [data-notes-place]').evaluateAll((items) => items.map((item) => item.dataset.notesPlace)),
    ['canvas', 'help', 'trash'], 'пункты «Ещё» колонки',
  );
  // Вид переживает уход в «Файлы» и обратно: у «Заметок» свой переключатель
  await knowledge.getByRole('tab', { name: 'Graph', exact: true }).click();
  await visible(knowledge.locator('[data-notes-graph]'), 'граф');
  await sidebar.getByRole('tab', { name: 'Files' }).click();
  await visible(cloud, '«Файлы» после графа');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  assert.equal(await knowledge.getAttribute('data-knowledge-view'), 'graph', 'возврат в «Заметки» сбросил вид');
  await openNotesView(knowledge, 'List');
  console.log('OK: «Заметки» и «Файлы» — отдельные модули, вид заметок хранится отдельно');

  // ── Список: папки со счётчиком, недавние, открытая папка ──────────────────
  await visible(row(GUIDE_OVERVIEW), '«Обзор» справки нового хранилища');
  await visible(knowledge.locator(`[data-note-title="${GUIDE_OVERVIEW}"]`), '«Обзор» открыт сам');
  await visible(knowledge.locator('[data-notes-folders] [data-folder]'), 'папки в списке');
  await visible(knowledge.locator('[data-notes-recent]'), 'недавние заметки под папками');
  await knowledge.locator('[data-notes-new-folder]').click();
  await page.locator('#knowledge-folder-name').fill(FOLDER);
  await page.locator('#knowledge-folder-name').press('Enter');
  await visible(folderRow(FOLDER), 'новая папка в списке');
  assert.equal(await folderRow(FOLDER).locator('[data-folder-count]').innerText(), '0', 'счётчик пустой папки');
  await folderRow(FOLDER).click();
  await visible(knowledge.locator(`[data-folder-open="${FOLDER}"]`), 'открытая папка');
  assert.equal(await knowledge.locator('[data-note-row]').count(), 0, 'в пустой открытой папке есть заметки');
  // «+» панели модулей при открытой папке создаёт заметку в ней
  await sidebar.locator('[data-add-for="notes"]').click();
  await visible(note.locator(`[data-note-folder="${FOLDER}"]`), 'новая заметка — в открытой папке');
  await setNoteTitle(NOTE);
  await sidebar.locator('[data-add-for="notes"]').click();
  await visible(knowledge.locator('[data-note-title="New note"]'), 'вторая заметка');
  await setNoteTitle(OTHER);
  assert.equal(await knowledge.locator('[data-note-row]').count(), 2, 'в открытой папке не две заметки');
  await knowledge.locator('[data-notes-all]').click();
  await visible(folderRow(FOLDER), 'папки после возврата');
  assert.equal(await folderRow(FOLDER).locator('[data-folder-count]').innerText(), '2', 'счётчик папки с заметками');
  console.log('OK: список — папки со счётчиком, недавние, открытая папка, «+» кладёт заметку в открытую папку');

  // ── Режимы заметки: «Просмотр / Правка / Рядом» ───────────────────────────
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка открыта');
  const bar = note.locator('[data-note-bar]');
  assert.match(await bar.innerText(), new RegExp(`${FOLDER} / ${NOTE}`), 'в шапке заметки нет пути «папка / название»');
  await mode('view', 'заметка открылась не в просмотре');
  await bar.getByRole('button', { name: 'Edit', exact: true }).click();
  await mode('edit', '«Правка» не включила правку');
  await visible(editor, 'редактор');
  assert.equal(await note.locator('[data-note-preview]').count(), 0, 'в «Правке» есть просмотр');
  await visible(knowledge.locator('[data-notes-list]'), 'список остаётся при правке');
  await fillEditor(`# ${NOTE}\n\nСтоит ${WORD} в шкафу. #сеть\n`);
  // Кнопки разметки: задача в начало строки, жирный вокруг выделения
  await editor.press('Control+End');
  await editor.pressSequentially('проверить связь');
  await note.locator('[data-tool="task"]').click();
  await page.waitForFunction(() => document.querySelector('#knowledge-note-editor').value.endsWith('- [ ] проверить связь'),
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('кнопка «Задача» не поставила пункт'));
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true, 'кнопка разметки увела фокус');
  // Ctrl+B и Ctrl+I — жирный и курсив вокруг выделения (`ZdNotesX`, справка по разметке)
  await editor.pressSequentially('\nважно');
  for (let i = 0; i < 5; i++) await editor.press('Shift+ArrowLeft');
  await editor.press('Control+b');
  await editor.press('Control+i');
  await page.waitForFunction(() => document.querySelector('#knowledge-note-editor').value.endsWith('***важно***'),
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('Ctrl+B / Ctrl+I не обернули выделение'));
  // Справка по разметке из редактора — шторкой
  await note.locator('[data-note-md-help]').click();
  const helpSheet = page.getByRole('dialog').locator('[data-notes-md-help]');
  await visible(helpSheet, 'справка по разметке из редактора');
  assert.equal(await helpSheet.locator('[data-md-help-row]').count(), 10, 'строк справки не десять');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await gone(page.locator('[data-notes-md-help]'), 'справка из редактора не закрылась');
  await editor.press('Control+End');
  // Подсказка заметки для незакрытой ссылки
  await editor.pressSequentially('\nсм. [[Резерв');
  const suggest = note.locator('[data-note-link-suggest]');
  await visible(suggest.getByRole('button', { name: OTHER }), 'подсказка заметки для ссылки');
  await visible(suggest.locator('[data-note-link-new]'), 'предложение новой заметки по набранному');
  await suggest.getByRole('button', { name: OTHER }).click();
  await page.waitForFunction((title) => document.querySelector('#knowledge-note-editor').value.endsWith(`см. [[${title}]]`),
    OTHER, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('подсказка не дописала ссылку'));
  await gone(suggest, 'подсказка осталась после закрытой ссылки');
  await shotBoth('desk-edit');
  // Ctrl+E — следующий режим: «Рядом»
  await page.keyboard.press('Control+e');
  await mode('split', 'Ctrl+E из правки не включил «Рядом»');
  const preview = note.locator('[data-note-preview]');
  await visible(preview.getByRole('button', { name: OTHER }), 'ссылка в живом просмотре');
  const [editorBox, previewBox] = [await editor.boundingBox(), await preview.boundingBox()];
  assert.ok(previewBox.x >= editorBox.x + editorBox.width - 1, 'просмотр не справа от редактора');
  assert.equal(await knowledge.getByRole('complementary', { name: 'Links' }).count(), 0, 'колонка «Связи» видна при правке');
  await shotBoth('desk-split');
  // Ctrl+E из «Рядом» — «Просмотр»: набранное сохраняется
  await page.keyboard.press('Control+e');
  await mode('view', 'Ctrl+E из «Рядом» не вернул просмотр');
  await visible(body.getByRole('button', { name: OTHER }), 'ссылка в сохранённой заметке');
  await visible(body.locator('input[type="checkbox"]'), 'пункт из кнопки разметки');
  // «Отмена» бросает набранное
  await bar.getByRole('button', { name: 'Split', exact: true }).click();
  await mode('split', '«Рядом» не открылось из просмотра');
  await editor.press('Control+End');
  await editor.pressSequentially('\nлишняя строка');
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await mode('view', '«Отмена» не закрыла правку');
  assert.equal(await body.getByText('лишняя строка').count(), 0, '«Отмена» сохранила набранное');
  console.log('OK: режимы «Просмотр / Правка / Рядом», Ctrl+E, кнопки разметки, подсказка ссылки, «Отмена»');

  // ── Строка списка, колонка «Связи», поиск ─────────────────────────────────
  const noteRow = await row(NOTE).innerText();
  assert.match(noteRow, new RegExp(WORD), 'в строке нет начала текста');
  assert.match(noteRow, new RegExp(`${FOLDER} · #сеть · 1 link`), 'в строке нет папки, тега и связей');
  const links = knowledge.getByRole('complementary', { name: 'Links' });
  await visible(links, 'колонка «Связи»');
  assert.match(await links.innerText(), /edited today/, 'под «Связями» нет времени правки');
  await shotBoth('desk-view');
  await knowledge.locator('#knowledge-search').fill(WORD);
  await visible(knowledge.locator('[data-notes-found]'), 'найденное одним списком');
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneKnowledge [data-note-row]').length === 1,
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('поиск показал лишние заметки'));
  await shot('desk-search-light');
  await knowledge.locator('#knowledge-search').fill('');
  await visible(knowledge.locator('[data-notes-recent]'), 'все заметки после очистки поиска');
  // Щелчок по `#тегу` в заметке — поиск по нему (`ZdNotesX`: «тег, ищется по щелчку»)
  await body.locator('[data-md-tag="сеть"]').click();
  await page.waitForFunction(() => document.querySelector('#knowledge-search')?.value === '#сеть', undefined,
    { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('щелчок по тегу не начал поиск'));
  await visible(knowledge.locator('[data-notes-found]').locator(`[data-note-row="${NOTE}"]`), 'заметка с тегом найдена');
  await knowledge.locator('#knowledge-search').fill('');
  await visible(knowledge.locator('[data-notes-recent]'), 'все заметки после поиска по тегу');
  console.log('OK: строка списка, колонка «Связи», поиск одним списком, поиск по щелчку на теге');

  // ── Меню заметки ──────────────────────────────────────────────────────────
  await bar.locator('[data-note-menu]').click();
  await visible(menuItem('rename'), 'меню заметки');
  assert.deepEqual(
    await page.locator('[data-note-menu-list] [data-note-action]').evaluateAll((items) => items.map((item) => item.dataset.noteAction)),
    ['rename', 'move', 'plan', 'pin', 'article', 'canvas', 'copy', 'versions', 'delete'], 'состав меню заметки',
  );
  await shotBoth('desk-menu');
  await menuItem('rename').click();
  await gone(page.locator('[data-note-menu-list]'), 'меню не закрылось после выбора');
  assert.equal(
    await note.getByLabel('Note title').evaluate((element) => document.activeElement === element), true,
    '«Переименовать» не поставило курсор в название',
  );
  await bar.locator('[data-note-menu]').click();
  await menuItem('move').click();
  await visible(page.locator('[data-folder-picker]'), 'выбор папки из меню');
  await page.keyboard.press('Escape');
  await page.locator('[data-folder-picker]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await bar.locator('[data-note-menu]').click();
  await menuItem('copy').click();
  await visible(page.getByText('Link copied').first(), 'уведомление о скопированной ссылке');
  console.log('OK: меню заметки — переименовать, перенести, скопировать ссылку');

  // ── История версий заметки (CLOUD-3): создание и правки одного устройства подряд — две версии ─────────
  const versions = page.locator('[data-cloud-versions]');
  const versionRows = versions.locator('[data-version]');
  const versionCount = (count, what) => page.waitForFunction(
    (wanted) => document.querySelectorAll('[data-cloud-versions] [data-version]').length === wanted, count,
    { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail(what));
  await bar.locator('[data-note-menu]').click();
  await menuItem('versions').click();
  await visible(versions, 'окно истории версий');
  // Правки в окне черновика (10 минут одного устройства) — одна версия поверх созданной
  await versionCount(2, 'в истории не текущая и созданная версии');
  assert.equal(await versionRows.first().getAttribute('data-version-current'), 'true', 'первая строка — не текущая');
  await shotBoth('desk-versions');
  await versionRows.nth(1).locator('[data-version-open]').click();
  await visible(versions.locator('[data-version-text]'), 'текст прежней версии');
  await page.waitForFunction(
    () => !/Загрузка|Loading/.test(document.querySelector('[data-cloud-versions] [data-version-text]')?.textContent || 'Loading'),
    undefined, { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('текст прежней версии не загрузился'));
  assert.ok(!(await versions.locator('[data-version-text]').innerText()).includes(WORD), 'в прежней версии уже есть правка');
  // Вернуть прежнюю: правка уходит из заметки, она сама — в историю
  await versionRows.nth(1).locator('[data-version-restore]').click();
  await gone(body.getByText(WORD, { exact: false }), 'возврат версии не сменил текст заметки');
  await versionCount(2, 'после возврата в истории не две версии');
  // И обратно — правленную
  await versionRows.nth(1).locator('[data-version-restore]').click();
  await visible(body.getByText(WORD, { exact: false }), 'возврат правленной версии');
  await page.keyboard.press('Escape');
  await gone(versions, 'окно истории не закрылось');
  // Та же история — у файла заметки в «Файлах»
  await sidebar.getByRole('tab', { name: 'Files' }).click();
  const files = cloudDriver(page);
  await files.open();
  await files.root();
  const vault = (await files.names()).find((name) => ['Заметки', 'Notes', 'Знания', 'Knowledge'].includes(name));
  assert.equal(vault, 'Notes', 'папка хранилища нового аккаунта — не «Notes»');
  assert.ok(vault, 'нет папки хранилища заметок в «Файлах»');
  await files.item(vault).click();
  await files.item(FOLDER).click();
  await files.menu(`${NOTE}.md`, 'Version history');
  await versionCount(2, 'история файла заметки в «Файлах»');
  await page.keyboard.press('Escape');
  await gone(versions, 'окно истории «Файлов» не закрылось');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await visible(knowledge, '«Заметки» после «Файлов»');
  console.log('OK: история версий заметки — открыть прежнюю, вернуть и обратно; та же история в «Файлах»');

  // ── «Отправить статьёй в чат» и «Добавить на холст» из меню ───────────────
  // Нарочно до шагов телефона: шторка холста, снятая вместе с заметкой при выборе, оставляла запись в истории, и
  // системное «назад» в открытой папке телефона уходило на неё впустую (`useHistoryBack`, снятие при размонтировании)
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка для меню');
  await bar.locator('[data-note-menu]').click();
  await menuItem('article').click();
  const recipients = page.locator('.Modal .modal-dialog').filter({ hasText: 'Send to chat as article' });
  await visible(recipients, 'выбор чата для статьи');
  await page.keyboard.press('Escape');
  await recipients.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await bar.locator('[data-note-menu]').click();
  await menuItem('canvas').click();
  await visible(page.locator('[data-note-canvas-sheet]'), 'выбор холста');
  await shotBoth('desk-canvas-pick');
  await page.locator('[data-note-canvas-sheet] [data-canvas-option-new]').click();
  await page.waitForFunction(
    () => document.querySelector('#ParvaneKnowledge')?.getAttribute('data-knowledge-view') === 'canvas', undefined,
    { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('после «Добавить на холст» не открылся холст'));
  await visible(knowledge.locator('[data-canvas-note="found"]').filter({ hasText: NOTE }), 'карточка заметки на холсте');
  await openNotesView(knowledge, 'List');
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка после холста');
  // Меню строки списка по правой кнопке (`ZdNotesX`): список и холст рядом не стоят — на холст кладут отсюда
  await row(NOTE).click({ button: 'right' });
  await visible(menuItem('canvas'), 'меню строки');
  assert.deepEqual(
    await page.locator('[data-note-menu-list] [data-note-action]').evaluateAll((items) => items.map((item) => item.dataset.noteAction)),
    ['open', 'rename', 'move', 'pin', 'copy', 'article', 'canvas', 'versions', 'delete'], 'состав меню строки',
  );
  // Меню выпадает у самой строки (не шторкой), у пунктов — сочетания клавиш, как на доске
  assert.equal(await page.getByRole('dialog').locator('[data-note-menu-list]').count(), 0, 'меню строки — шторкой');
  const rowBox = await row(NOTE).boundingBox();
  const popBox = await page.locator('[data-note-menu-pop]').boundingBox();
  assert.ok(
    popBox.y >= rowBox.y - 1 && popBox.y <= rowBox.y + rowBox.height + 1 && popBox.x >= rowBox.x,
    `меню не у строки: ${JSON.stringify({ rowBox, popBox })}`,
  );
  const hints = await page.locator('[data-note-menu-pop] [data-note-action]').evaluateAll((items) => Object.fromEntries(
    items.map((item) => [item.dataset.noteAction, item.querySelector('kbd')?.textContent || '']),
  ));
  assert.deepEqual([hints.open, hints.rename, hints.delete, hints.move], ['Enter', 'F2', 'Del', ''], 'подсказки клавиш');
  await shotBoth('desk-row-menu');
  await page.keyboard.press('Escape');
  await page.locator('[data-note-menu-list]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // «Переименовать» из строки — шторкой, заметка не открывается; потом назад
  const renameSheet = page.locator('[data-note-rename]');
  const renameRow = async (from, to) => {
    await row(from).click({ button: 'right' });
    await menuItem('rename').click();
    await visible(renameSheet, 'шторка названия из строки');
    await renameSheet.locator('input').fill(to);
    await renameSheet.locator('input').press('Enter');
    await gone(renameSheet, 'шторка названия не закрылась');
    await visible(row(to), `строка после переименования в «${to}»`);
  };
  await renameRow(NOTE, `${NOTE} 2`);
  // F2 по строке под указателем — то же окно названия, без меню
  await row(`${NOTE} 2`).hover();
  await page.keyboard.press('F2');
  await visible(renameSheet, 'шторка названия по F2');
  assert.equal(await page.locator('[data-note-menu-pop]').count(), 0, 'F2 открыл меню');
  await renameSheet.locator('input').fill(NOTE);
  await renameSheet.locator('input').press('Enter');
  await gone(renameSheet, 'шторка названия после F2 не закрылась');
  await visible(row(NOTE), 'строка после переименования по F2');
  // Del по строке в фокусе — вопрос «В корзину», отмена оставляет заметку
  await row(NOTE).focus();
  await page.keyboard.press('Delete');
  const keyDelete = page.locator('.confirm-dialog-button').filter({ hasText: 'Cancel' });
  await visible(keyDelete, 'вопрос перед удалением по Del');
  await keyDelete.click();
  await visible(row(NOTE), 'заметка на месте после отмены Del');
  // «Перенести», «Скопировать ссылку», «История версий», «В корзину» (с отменой) — из строки
  await row(NOTE).click({ button: 'right' });
  await menuItem('move').click();
  await visible(page.locator('[data-folder-picker]'), 'выбор папки из меню строки');
  await page.keyboard.press('Escape');
  await page.locator('[data-folder-picker]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await row(NOTE).click({ button: 'right' });
  await menuItem('copy').click();
  await visible(page.getByText('Link copied').first(), 'ссылка скопирована из меню строки');
  await row(NOTE).click({ button: 'right' });
  await menuItem('versions').click();
  await visible(page.locator('[data-cloud-versions] [data-version]'), 'история версий из меню строки');
  await page.keyboard.press('Escape');
  await gone(page.locator('[data-cloud-versions]'), 'окно истории из строки не закрылось');
  await row(NOTE).click({ button: 'right' });
  await menuItem('delete').click();
  const rowDelete = page.locator('.confirm-dialog-button').filter({ hasText: 'Cancel' });
  await visible(rowDelete, 'вопрос перед удалением из строки');
  await rowDelete.click();
  await visible(row(NOTE), 'заметка на месте после отмены удаления');
  await row(NOTE).click({ button: 'right' });
  await menuItem('canvas').click();
  await page.locator('[data-note-canvas-sheet] [data-canvas-option-new]').click();
  await page.waitForFunction(
    () => document.querySelector('#ParvaneKnowledge')?.getAttribute('data-knowledge-view') === 'canvas', undefined,
    { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('после «Добавить на холст» из строки не открылся холст'));
  await visible(knowledge.locator('[data-canvas-note="found"]').filter({ hasText: NOTE }), 'карточка заметки из строки');
  await openNotesView(knowledge, 'List');
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка после холста из строки');
  console.log('OK: из меню заметки — выбор чата для статьи, карточка на новом холсте; из меню строки — на холст');

  // ── Телефон: шапка, виды, папки, заметка на весь экран ───────────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await visible(note.getByRole('button', { name: 'Back to notes' }), 'заметка на весь экран телефона');
  assert.equal(await knowledge.locator('[role="tablist"]').count(), 0, 'над заметкой на телефоне видны виды');
  await visible(note.locator('[data-note-bar]').getByRole('heading', { name: NOTE }), 'название заметки в шапке');
  // Телефон (`PhNotesMore`): «Ссылаются сюда · N» списком без малого графа
  await visible(note.locator('[data-note-links]').getByText(/Linked here · \d/), '«Ссылаются сюда» на телефоне');
  assert.equal(await note.locator('[data-note-links] svg').count(), 0, 'малый граф на телефоне');
  await shotBoth('phone-view');
  // Действия — шторкой снизу
  await note.locator('[data-note-menu]').click();
  await visible(page.getByRole('dialog').locator('[data-note-action="delete"]'), 'шторка действий');
  assert.match(await page.getByRole('dialog').locator('[data-sheet-subtitle]').innerText(), new RegExp(`${FOLDER} · \\d+ link`),
    'подзаголовок шторки «папка · N связей»');
  await shotBoth('phone-menu');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await page.locator('[data-note-menu-list]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // Правка: редактор на весь экран, кнопки разметки внизу, глазок просмотра и «Готово» в шапке
  await note.getByRole('button', { name: 'Edit' }).first().click();
  await visible(editor, 'редактор на телефоне');
  await visible(note.locator('[data-tool="heading"]'), 'кнопки разметки');
  const toolBox = await note.locator('[data-tool="heading"]').boundingBox();
  assert.ok(toolBox.height >= 44 && toolBox.width >= 44, `цель нажатия кнопки разметки ${toolBox.width}×${toolBox.height}`);
  await shotBoth('phone-edit');
  await note.locator('[data-note-preview-toggle]').click();
  await visible(note.locator('[data-note-edit="preview"]'), 'просмотр вместо редактора');
  await note.locator('[data-note-preview-toggle]').click();
  await visible(editor, 'обратно к редактору');
  await note.getByRole('button', { name: 'Cancel' }).click();
  await visible(body, 'заметка после отмены правки');
  await note.getByRole('button', { name: 'Back to notes' }).click();
  const head = knowledge.locator('header').first();
  await visible(head.getByRole('heading', { name: 'Notes' }), 'название модуля в шапке телефона');
  await visible(head.locator('[role="tablist"]'), 'виды под шапкой');
  await visible(folderRow(FOLDER), 'папки на телефоне');
  // Строка «Недавних» (`PhNotesMore`): название и «папка · когда», без начала текста
  assert.match(await knowledge.locator(`[data-notes-recent] [data-note-row="${NOTE}"] [data-row-sub]`).innerText(),
    new RegExp(`^(Pinned · )?${FOLDER} · `), 'строка недавних — не «папка · когда»');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `экран шире телефона на ${overflow}px`);
  await shotBoth('phone-list');
  // «Новая папка» — кнопкой шапки
  await head.locator('[data-notes-new-folder]').click();
  await visible(page.locator('[data-folder-sheet="create"]'), 'шторка новой папки');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await page.locator('[data-folder-sheet]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // Папка открывается, системное «назад» возвращает к папкам
  await folderRow(FOLDER).click();
  await visible(knowledge.locator(`[data-folder-open="${FOLDER}"]`), 'открытая папка на телефоне');
  await shotBoth('phone-folder');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.history.back());
  await visible(folderRow(FOLDER), '«назад» из папки — к папкам');
  await visible(knowledge, '«назад» из папки увёл из модуля');
  // Статья в чат из заметки в папке: окно выбора чата закрыто — «назад» ведёт к папке, затем к папкам
  // (дефект 20 ноя: запись окна оставалась в истории, и «назад» в папке тратилось на неё впустую)
  const historyDump = () => page.evaluate(() => JSON.stringify({
    cursor: window.TEST_getHistoryCursor?.(),
    state: window.TEST_getHistoryState?.()?.map(({ index, isClosed, shouldBeReplaced }) => ({ index, isClosed, shouldBeReplaced })),
    real: window.history.state,
  }));
  // Окно выбора чата — с полем поиска (шторка меню заметки тоже несёт пункт «Send to chat as article»)
  const phoneRecipients = page.locator('.Modal .modal-dialog').filter({ hasText: 'Send to chat as article' })
    .filter({ has: page.getByPlaceholder('Search') });
  // Окно закрывают крестиком, Escape и системным «назад» — после каждого «назад» ведёт к папке, затем к папкам
  const closeWays = {
    cross: () => phoneRecipients.getByRole('button', { name: 'Close' }).first().click(),
    escape: () => page.keyboard.press('Escape'),
    back: () => page.evaluate(() => window.history.back()),
  };
  for (const [way, closePicker] of Object.entries(closeWays)) {
    await folderRow(FOLDER).click();
    await visible(knowledge.locator(`[data-folder-open="${FOLDER}"]`), `папка для статьи на телефоне (${way})`);
    await row(NOTE).click();
    await visible(note.getByRole('button', { name: 'Back to notes' }), `заметка из папки на весь экран (${way})`);
    await note.locator('[data-note-menu]').click();
    await page.getByRole('dialog').locator('[data-note-action="article"]').click();
    await visible(phoneRecipients, `выбор чата для статьи на телефоне (${way})`);
    await page.waitForTimeout(300);
    await closePicker();
    await phoneRecipients.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
    await visible(note.getByRole('button', { name: 'Back to notes' }), `заметка осталась после окна (${way})`);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.history.back());
    await note.getByRole('button', { name: 'Back to notes' }).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
      .catch(async () => assert.fail(`«назад» не закрыл заметку после окна (${way}): ${await historyDump()}`));
    await visible(knowledge.locator(`[data-folder-open="${FOLDER}"]`), `«назад» после выбора чата — к папке (${way})`);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.history.back());
    await knowledge.locator(`[data-folder-open="${FOLDER}"]`).waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
      .catch(async () => assert.fail(`«назад» не закрыл папку после выбора чата (${way}): ${await historyDump()}`));
    await visible(folderRow(FOLDER), `папки после «назад» из папки (${way})`);
  }
  // Поиск — лупой в шапке, на месте названия
  await head.locator('[data-section-search-open]').click();
  await head.locator('[data-section-search]').fill(WORD);
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneKnowledge [data-note-row]').length === 1,
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('поиск на телефоне показал лишние заметки'));
  await shot('phone-search-light');
  await head.locator('[data-section-search-close]').click();
  await visible(folderRow(FOLDER), 'папки после закрытия поиска');
  console.log('OK: телефон — шапка, виды, папки, заметка на весь экран, шторка действий, правка');

  // ── Ссылка на заметку, которой ещё нет: сначала вопрос ────────────────────
  await page.setViewportSize(DESK);
  await page.waitForTimeout(800);
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка для ссылки');
  await bar.getByRole('button', { name: 'Edit', exact: true }).click();
  await visible(editor, 'редактор для ссылки');
  await editor.press('Control+End');
  await editor.pressSequentially(`\nрядом [[${CABINET}]]`);
  await note.locator('[data-note-bar] [data-note-bar-edit]').click();
  await mode('view', '«Готово» не закрыло правку');
  await body.getByRole('button', { name: CABINET }).click();
  const missingSheet = page.locator('[data-note-missing-sheet]');
  await visible(missingSheet, 'вопрос о заметке, которой нет');
  assert.match(await missingSheet.innerText(), new RegExp(`Linked from 1 note: «${NOTE}»`), 'кто ссылается');
  await page.waitForFunction((wanted) => (
    document.querySelector('[data-note-missing-sheet] [data-missing-name]')?.value === wanted
  ), CABINET, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('в шторке нет названия из ссылки'));
  assert.match(await missingSheet.locator('[data-missing-folder]').innerText(), new RegExp(FOLDER), 'папка заметки со ссылкой');
  await shotBoth('desk-missing');
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await shotBoth('phone-missing');
  await page.setViewportSize(DESK);
  await page.waitForTimeout(800);
  await missingSheet.locator('[data-missing-later]').click();
  await missingSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  assert.equal(await row(CABINET).count(), 0, '«Не сейчас» создало заметку');
  await body.getByRole('button', { name: CABINET }).click();
  await visible(missingSheet, 'вопрос второй раз');
  await missingSheet.locator('[data-missing-create]').click();
  await visible(knowledge.locator(`[data-note-title="${CABINET}"]`), 'новая заметка по ссылке открыта');
  await visible(note.locator(`[data-note-folder="${FOLDER}"]`), 'заметка по ссылке — в папке заметки со ссылкой');
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка со ссылкой');
  console.log('OK: ссылка на несуществующую заметку — вопрос «Создать и открыть / Не сейчас»');

  // ── Удаление из меню ──────────────────────────────────────────────────────
  await page.setViewportSize(DESK);
  await page.waitForTimeout(800);
  await row(OTHER).click();
  await visible(knowledge.locator(`[data-note-title="${OTHER}"]`), 'вторая заметка открыта');
  await note.locator('[data-note-menu]').click();
  await menuItem('delete').click();
  await page.locator('.confirm-dialog-button').filter({ hasText: 'Move to trash' }).click();
  await gone(row(OTHER), 'заметка не удалена из меню');
  // Заметка не открыта — список таблицей во всю ширину: «название · папка · #тег · дата» (`ZdNotesX`)
  await visible(knowledge.locator('[data-notes-list][data-notes-layout="table"]'), 'таблица заметок без открытой');
  assert.match(await row(NOTE).innerText(), new RegExp(`${NOTE}[\\s\\S]*${FOLDER}[\\s\\S]*#сеть`), 'строка таблицы');
  await shotBoth('desk-table');
  // «Корзина» колонки: удалённая заметка лежит там, «Восстановить» возвращает её
  await knowledge.locator('[data-notes-place="trash"]').click();
  const trashItem = knowledge.locator(`[data-notes-trash-item="${OTHER}"]`);
  await visible(trashItem, 'удалённая заметка в корзине «Заметок»');
  await shotBoth('desk-trash');
  await trashItem.locator('[data-notes-trash-restore]').click();
  await gone(trashItem, 'заметка не ушла из корзины');
  // «Справка по разметке» колонки — экран шпаргалки
  await knowledge.locator('[data-notes-place="help"]').click();
  await visible(knowledge.locator('[data-notes-md-help] [data-md-help-key]'), 'экран справки по разметке');
  assert.equal(await knowledge.locator('[data-notes-md-help] [data-md-help-row]').count(), 10, 'строки справки');
  await shotBoth('desk-md-help');
  // «Холсты» колонки — список холстов
  // «Холсты» из другого места возвращают открытый там холст, ещё раз — список холстов
  await knowledge.locator('[data-notes-place="canvas"]').click();
  await page.waitForFunction(() => document.querySelector('#ParvaneKnowledge')?.getAttribute('data-knowledge-view') === 'canvas',
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«Холсты» не открыли холсты'));
  if (!(await knowledge.locator('[data-canvas-list]').isVisible())) await knowledge.locator('[data-notes-place="canvas"]').click();
  await visible(knowledge.locator('[data-canvas-list]'), 'список холстов из колонки');
  await knowledge.locator('[data-notes-all]').click();
  await visible(row(OTHER), 'восстановленная заметка в списке');
  console.log('OK: удаление заметки из меню, таблица, корзина с восстановлением, справка по разметке, холсты');

  // ── Закрепить вверху, цвет папки, «Вложить в другую папку» ────────────────
  await row(NOTE).click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка для закрепления');
  await note.locator('[data-note-menu]').click();
  await menuItem('pin').click();
  await visible(knowledge.locator(`[data-note-row="${NOTE}"][data-pinned]`), 'закреплённая заметка в списке');
  await note.locator('[data-note-menu]').click();
  await visible(menuItem('pin').filter({ hasText: 'Unpin' }), '«Открепить» в меню закреплённой');
  await page.keyboard.press('Escape');
  await knowledge.locator('[data-notes-new-folder]').first().click();
  await page.locator('#knowledge-folder-name').fill(ARCHIVE);
  await page.locator('#knowledge-folder-name').press('Enter');
  await visible(folderRow(ARCHIVE), 'вторая папка');
  await folderRow(FOLDER).click();
  await visible(knowledge.locator(`[data-folder-open="${FOLDER}"]`), 'папка открыта для действий');
  await knowledge.locator('[data-folder-menu]').first().click();
  const actions = page.locator('[data-folder-actions]');
  await visible(actions, 'другие действия с папкой');
  // «Цвет папки» строкой со значением словом (доска `ZpNotesX`): по умолчанию свои папки синие, кружки — в раскрытии
  await visible(actions.locator('[data-folder-color="blue"]').filter({ hasText: 'blue' }), 'цвет папки словом');
  await actions.locator('[data-folder-color]').click();
  await actions.locator('[data-tone="red"]').click();
  await visible(actions.locator('[data-folder-color="red"]').filter({ hasText: 'red' }), 'выбранный цвет словом');
  await page.waitForFunction(
    () => document.querySelector('[data-folder-actions] [data-tone="red"]')?.getAttribute('aria-pressed') === 'true',
    undefined, { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('цвет папки не выбрался'));
  await shotBoth('desk-folder-actions');
  await actions.locator('[data-folder-nest]').click();
  await actions.locator(`[data-folder-nest-target="${ARCHIVE}"]`).click();
  await page.locator('[data-folder-sheet]').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await knowledge.locator('[data-folder-back]').click().catch(() => undefined);
  await knowledge.locator('#knowledge-search').fill(NOTE);
  await row(NOTE).first().click();
  await visible(note.locator(`[data-note-folder="${ARCHIVE}/${FOLDER}"]`), 'папка вложена в другую — путь заметки');
  await knowledge.locator('#knowledge-search').fill('');
  console.log('OK: закрепление, цвет папки, вложение папки в другую');

  // ── «Новая заметка» там, где стоит человек: в графе — точка в панели, на холсте — карточка, Ctrl+N ────────
  await openNotesView(knowledge, 'Graph');
  await knowledge.locator('[data-notes-new]').click();
  await visible(knowledge.locator('[data-graph-panel] [data-note-title^="New note"]'), 'новая заметка выбрана в графе');
  assert.equal(await knowledge.getAttribute('data-knowledge-view'), 'graph', '«Новая заметка» увела из графа');
  await openNotesView(knowledge, 'Canvas');
  await knowledge.locator('[data-canvas-tile] [data-canvas-id]').first().click();
  await visible(knowledge.locator('[data-canvas-note]'), 'открытый холст');
  const cardsBefore = await knowledge.locator('[data-canvas-note]').count();
  await sidebar.locator('[data-add-for="notes"]').click();
  await page.waitForFunction((count) => document.querySelectorAll('#ParvaneKnowledge [data-canvas-note]').length > count,
    cardsBefore, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«+» на холсте не поставил карточку'));
  assert.equal(await knowledge.getAttribute('data-knowledge-view'), 'canvas', '«+» увёл с холста');
  await openNotesView(knowledge, 'List');
  await knowledge.locator('[data-notes-all]').click();
  await visible(knowledge.locator('[data-notes-all][aria-current="true"]'), '«Все заметки» выбраны');
  const notesBefore = await knowledge.locator('[data-note-row^="New note"]').count();
  await page.keyboard.press('Control+n');
  await visible(knowledge.locator('[data-note-id][data-note-title^="New note"]'), 'Ctrl+N открыл новую заметку');
  await page.waitForFunction(
    (count) => document.querySelectorAll('#ParvaneKnowledge [data-note-row^="New note"]').length > count,
    notesBefore, { timeout: STEP_TIMEOUT_MS },
  ).catch(async () => assert.fail(`Ctrl+N не добавил заметку: ${await page.evaluate(() => JSON.stringify({
    body: document.body.className,
    active: document.activeElement?.outerHTML.slice(0, 120),
    rows: [...document.querySelectorAll('#ParvaneKnowledge [data-note-row]')].map((el) => el.dataset.noteRow),
  }))}`));
  console.log('OK: «Новая заметка» в графе и на холсте, Ctrl+N');

  console.log('e2e_web_notes_screens: OK');
} catch (error) {
  if (SHOT_DIR) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${SHOT_DIR}/notes-screens-failure.png` }).catch(() => {});
    console.log(`--- раздел при сбое ---\n${await page?.locator('#ParvaneKnowledge').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
