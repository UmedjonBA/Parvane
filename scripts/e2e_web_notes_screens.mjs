// Экраны модуля «Заметки» по макету (spec 041 D1; доски `Notes`, `PhNotesMore`, `XpNotes`, `DeskNotes`):
// «Заметки» и «Файлы» — отдельные модули; список — папки со счётчиком и недавние заметки, открытая папка, поиск
// одним списком; заметка на компьютере — режимы «Просмотр / Правка / Рядом» одной кнопкой (Ctrl+E), кнопки
// разметки и подсказка заметки для ссылки `[[…`, меню «Ещё»; на телефоне — шапка с названием, виды под ней,
// заметка на весь экран с «Изменить», глазком просмотра и шторкой действий. Снимки телефон/компьютер ×
// светлая/тёмная — в PARVANE_E2E_SHOT_DIR / PARVANE_E2E_BACKEND_LOG_DIR.
// Запуск: scripts/run_web_notes_screens_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { dismissRecoveryKeyDialog, preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-screens-1';
// Размеры досок макета: окно компьютера и телефон
const DESK = { width: 1120, height: 700 };
const PHONE = { width: 360, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '';
const FOLDER = 'Сеть';
const NOTE = 'Настройка туннеля';
const OTHER = 'Резервные копии';
const GUIDE_OVERVIEW = 'Overview';
const WORD = 'маршрутизатор';

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
  assert.equal(await cloud.locator('[role="tablist"]').count(), 0, 'в «Файлах» остались виды заметок');
  await visible(cloud.getByRole('heading', { name: 'Files' }), 'название модуля в шапке «Файлов»');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await visible(knowledge, 'модуль «Заметки»');
  assert.equal(await cloud.isVisible(), false, '«Файлы» видны под «Заметками»');
  assert.deepEqual(
    await knowledge.locator('[role="tablist"] [role="tab"]').allInnerTexts(), ['List', 'Graph', 'Canvas'],
    'виды «Заметок» — не «Список / Граф / Холст»',
  );
  // Вид переживает уход в «Файлы» и обратно: у «Заметок» свой переключатель
  await knowledge.getByRole('tab', { name: 'Graph', exact: true }).click();
  await visible(knowledge.locator('[data-notes-graph]'), 'граф');
  await sidebar.getByRole('tab', { name: 'Files' }).click();
  await visible(cloud, '«Файлы» после графа');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  assert.equal(await knowledge.getAttribute('data-knowledge-view'), 'graph', 'возврат в «Заметки» сбросил вид');
  await knowledge.getByRole('tab', { name: 'List', exact: true }).click();
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
  await knowledge.locator('[data-folder-back]').click();
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
  assert.equal(await knowledge.locator('[data-notes-folders]').count(), 0, 'при поиске видны папки');
  await shot('desk-search-light');
  await knowledge.locator('#knowledge-search').fill('');
  await visible(knowledge.locator('[data-notes-folders]'), 'папки после очистки поиска');
  console.log('OK: строка списка, колонка «Связи», поиск одним списком');

  // ── Меню заметки ──────────────────────────────────────────────────────────
  await bar.locator('[data-note-menu]').click();
  await visible(menuItem('rename'), 'меню заметки');
  assert.deepEqual(
    await page.locator('[data-note-menu-list] [data-note-action]').evaluateAll((items) => items.map((item) => item.dataset.noteAction)),
    ['rename', 'move', 'plan', 'copy', 'delete'], 'состав меню заметки',
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

  // ── Телефон: шапка, виды, папки, заметка на весь экран ───────────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await visible(note.getByRole('button', { name: 'Back to notes' }), 'заметка на весь экран телефона');
  assert.equal(await knowledge.locator('[role="tablist"]').count(), 0, 'над заметкой на телефоне видны виды');
  await visible(note.locator('[data-note-bar]').getByRole('heading', { name: NOTE }), 'название заметки в шапке');
  await shotBoth('phone-view');
  // Действия — шторкой снизу
  await note.locator('[data-note-menu]').click();
  await visible(page.getByRole('dialog').locator('[data-note-action="delete"]'), 'шторка действий');
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
  // Поиск — лупой в шапке, на месте названия
  await head.locator('[data-section-search-open]').click();
  await head.locator('[data-section-search]').fill(WORD);
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneKnowledge [data-note-row]').length === 1,
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('поиск на телефоне показал лишние заметки'));
  await shot('phone-search-light');
  await head.locator('[data-section-search-close]').click();
  await visible(folderRow(FOLDER), 'папки после закрытия поиска');
  console.log('OK: телефон — шапка, виды, папки, заметка на весь экран, шторка действий, правка');

  // ── Удаление из меню ──────────────────────────────────────────────────────
  await page.setViewportSize(DESK);
  await page.waitForTimeout(800);
  await row(OTHER).click();
  await visible(knowledge.locator(`[data-note-title="${OTHER}"]`), 'вторая заметка открыта');
  await note.locator('[data-note-menu]').click();
  await menuItem('delete').click();
  await page.locator('.confirm-dialog-button').filter({ hasText: 'Move to trash' }).click();
  await gone(row(OTHER), 'заметка не удалена из меню');
  console.log('OK: удаление заметки из меню');

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
