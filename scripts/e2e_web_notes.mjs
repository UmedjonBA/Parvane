// Раздел «Знания»: папка «Справка Parvane» нового хранилища, папки заметок, заметки `.md` в папке облака,
// ссылки и обратные ссылки, пункты-задачи в обе стороны, «Запланировано», поиск, граф (заметка читается и
// правится в панели справа, связь проводят линией от кольца заметки и убирают, выбрав линию), холст (группа
// двигается за пустое место внутри, заметка правится прямо на карточке); всё переживает перезагрузку.
// Запуск: scripts/run_web_notes_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  relogin,
  reloadPage,
  openPlannerScreen,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const NOTE = 'Сервер X99';
const OTHER = 'Курс ОГЭ';
// Справка: папка связанных заметок о продукте (интерфейс сценария английский)
const GUIDE_FOLDER = 'Parvane guide';
const GUIDE_OVERVIEW = 'Overview';
const GUIDE_HUB = 'How sections connect';
const GUIDE_NOTES = 12;
// Заметка, которую создаёт связь, брошенная на пустое место графа
const GRAPH_NOTE = 'Граф-заметка';
const PANEL_EDIT = 'Правка из панели графа';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
let session;

try {
  const user = `notes-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const cloud = page.locator('#ParvaneCloud');
  const planner = page.locator('#ParvanePlanner');
  const row = (title) => knowledge.locator(`[data-note-row="${title}"]`);
  const note = knowledge.locator('[data-note-id]');
  const body = note.locator('[data-note-body]');
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не появилось: ${what}`));
  const openTab = async (name) => {
    const header = (await knowledge.count()) ? knowledge : cloud;
    await header.locator('header').getByText(name, { exact: true }).first().click();
  };

  // ── «Знания» в боковой панели; «Файлы» — вкладка, рядом заметки, граф и холст ──
  await sidebar.getByRole('tab', { name: 'Cloud' }).click();
  await visible(cloud, 'вкладка «Файлы»');
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(knowledge, 'раздел заметок');
  console.log('OK: «Знания» открыты, «Файлы» — одна из вкладок');

  // ── Новое хранилище встречает папкой «Справка Parvane»: заметки о продукте, связанные ссылками ──
  const trashOpenNote = async () => {
    await note.getByRole('button', { name: 'Move to trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
  };
  const folderOf = (name) => knowledge.locator(`[data-folder="${name}"]`);
  const rowsIn = (name) => folderOf(name).locator('[data-note-row]');
  const guide = folderOf(GUIDE_FOLDER);
  const guideRows = rowsIn(GUIDE_FOLDER);
  // Число строк по селектору — с ожиданием: список следует за облаком не мгновенно
  const waitRows = (selector, count, what) => page.waitForFunction(
    ([query, wanted]) => document.querySelectorAll(query).length === wanted, [selector, count], { timeout: 60000 },
  ).catch(() => assert.fail(what));
  const GUIDE_ROWS = `#ParvaneKnowledge [data-folder="${GUIDE_FOLDER}"] [data-note-row]`;
  const ALL_ROWS = '#ParvaneKnowledge [data-note-row]';

  await visible(row(GUIDE_OVERVIEW), '«Обзор» справки нового хранилища');
  await visible(knowledge.locator(`[data-note-title="${GUIDE_OVERVIEW}"]`), '«Обзор» открыт сам');
  // Заметки справки пишутся по одной — дождаться всех
  await waitRows(GUIDE_ROWS, GUIDE_NOTES, `в папке справки не ${GUIDE_NOTES} заметок`);
  await waitRows(ALL_ROWS, GUIDE_NOTES, 'кроме справки в новом хранилище есть другие заметки');
  assert.equal(await knowledge.locator('[data-notes-guide-notice]').count(), 0, 'открытая сама справка не сопровождается сообщением');
  await visible(body.getByText('#guide'), 'тег в заметке справки');
  assert.equal(await body.locator('input[type="checkbox"]').count(), 3, 'три пункта в «Обзоре»');
  // Каждая ссылка «Обзора» ведёт на существующую заметку справки
  await page.waitForFunction(() => {
    const links = [...document.querySelectorAll('[data-note-body] button[data-title]')];
    return links.length >= 11 && links.every((link) => !link.title);
  }, undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('в «Обзоре» есть ссылки на несуществующие заметки'));
  await body.getByRole('button', { name: GUIDE_HUB }).click();
  await visible(knowledge.locator(`[data-note-title="${GUIDE_HUB}"]`), 'заметка о связях разделов по ссылке');
  assert.equal(await body.locator('button[data-title][title]').count(), 0, 'в заметке о связях есть ссылки на несуществующие заметки');
  await visible(knowledge.locator('[data-note-backlinks]').getByRole('button', { name: GUIDE_OVERVIEW }), 'обратная ссылка на «Обзор»');
  // Пункты справки без дат: задач в «Плане» они не заводят
  await openPlannerScreen(page, 'today');
  await visible(planner, 'экран «Сегодня»');
  await page.waitForTimeout(1500);
  assert.equal(await planner.locator('[data-task-id]').count(), 0, 'справка завела задачи в «Плане»');
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(guide, 'папка справки после возврата в раздел');
  console.log(`OK: новое хранилище — папка «${GUIDE_FOLDER}» из ${GUIDE_NOTES} заметок, ссылки ведут на заметки справки`);

  // ── Граф показывает справку связной картой ────────────────────────────────
  await openTab('Graph');
  const guideGraph = knowledge.locator('[data-notes-graph]');
  await visible(guideGraph.locator('[data-node][data-kind="note"]'), 'узлы справки на графе');
  assert.equal(await guideGraph.locator('[data-node][data-kind="note"]').count(), GUIDE_NOTES, 'на графе не все заметки справки');
  assert.equal(await guideGraph.locator('[data-node][data-kind="missing"]').count(), 0, 'на графе справки есть несуществующие заметки');
  assert.ok(await guideGraph.locator('[data-graph-edge]').count() >= GUIDE_NOTES - 1, 'заметки справки на графе не связаны');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-guide-graph.png` });
  await openTab('Notes');
  console.log('OK: граф — справка одной связной картой');

  // ── Папки: свернуть, создать, заметка в папке, перенос, переименование, удаление ──
  const FOLDER = 'Проекты';
  const FOLDER_NEW = 'Архив';
  const FOLDER_RENAMED = 'Архив 2026';
  const DRAFT = 'Черновик';
  const folderName = page.locator('#knowledge-folder-name');
  const picker = page.locator('[data-folder-picker]');
  const chipOf = (name) => note.locator(`[data-note-folder="${name}"]`);
  const gone = (locator, what) => locator.first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(what));
  // Заголовок папки сворачивает её; состояние хранится на устройстве
  await guide.locator('[data-folder-toggle]').click();
  await gone(guideRows, 'свёрнутая папка показывает заметки');
  assert.equal(await guide.getAttribute('data-collapsed'), 'true', 'папка не помечена свёрнутой');
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('parvane:knowledge-collapsed') || '[]')),
    [GUIDE_FOLDER], 'свёрнутая папка не запомнена на устройстве',
  );
  await guide.locator('[data-folder-toggle]').click();
  await waitRows(GUIDE_ROWS, GUIDE_NOTES, 'развёрнутая папка не показала заметки');
  // Новая папка: пустая видна в списке и предлагает добавить заметку
  await knowledge.locator('[data-notes-new-folder]').click();
  await visible(folderName, 'поле названия новой папки');
  await folderName.fill('а/б');
  await folderName.press('Enter');
  await visible(page.locator('[data-folder-error="bad-name"]'), 'отказ негодному названию папки');
  await folderName.fill(FOLDER);
  await folderName.press('Enter');
  await visible(folderOf(FOLDER).locator('[data-folder-empty]'), 'пустая папка в списке');
  await visible(folderOf(''), '«Без папки» рядом с папками');
  // «+» в заголовке папки создаёт заметку в ней
  await folderOf(FOLDER).locator('[data-folder-add]').click();
  await visible(chipOf(FOLDER), 'папка новой заметки');
  await note.getByLabel('Note title').fill(DRAFT);
  await note.getByLabel('Note title').blur();
  await visible(rowsIn(FOLDER).and(row(DRAFT)), 'заметка в своей папке');
  const draftId = await note.getAttribute('data-note-id');
  // Новая заметка при открытой заметке папки ложится в ту же папку
  await knowledge.locator('[data-notes-new]').click();
  await waitRows(`#ParvaneKnowledge [data-folder="${FOLDER}"] [data-note-row]`, 2, 'новая заметка не легла в папку открытой заметки');
  await visible(chipOf(FOLDER), 'папка второй заметки');
  await trashOpenNote();
  await waitRows(`#ParvaneKnowledge [data-folder="${FOLDER}"] [data-note-row]`, 1, 'вторая заметка папки не удалена');
  // Перенос: кнопка с названием папки под заголовком заметки → выбор папки
  await row(DRAFT).click();
  await chipOf(FOLDER).click();
  await visible(picker, 'выбор папки для заметки');
  assert.equal(await picker.locator(`[data-folder-option="${FOLDER}"]`).getAttribute('aria-current'), 'true', 'текущая папка в выборе не отмечена');
  await picker.locator('[data-folder-option=""]').click();
  await visible(rowsIn('').and(row(DRAFT)), 'заметка перенесена в «Без папки»');
  await visible(chipOf(''), 'у заметки нет папки');
  await visible(folderOf(FOLDER).locator('[data-folder-empty]'), 'папка после переноса пуста');
  // «Новая папка…» в выборе создаёт папку и переносит заметку в неё
  await chipOf('').click();
  await picker.locator('[data-folder-option-new]').click();
  await page.locator('#knowledge-move-folder-name').fill(FOLDER_NEW);
  await picker.locator('[data-folder-option-create]').click();
  await visible(rowsIn(FOLDER_NEW).and(row(DRAFT)), 'заметка перенесена в новую папку');
  await visible(chipOf(FOLDER_NEW), 'новая папка у заметки');
  assert.equal(await note.getAttribute('data-note-id'), draftId, 'перенос заменил заметку другой');
  // Переименование папки: заметка остаётся в ней
  await folderOf(FOLDER_NEW).locator('[data-folder-menu]').click();
  await visible(page.locator('[data-folder-sheet="edit"]'), 'шторка папки');
  await folderName.fill(FOLDER);
  await folderName.press('Enter');
  await visible(page.locator('[data-folder-error="taken"]'), 'отказ занятому названию папки');
  await folderName.fill(FOLDER_RENAMED);
  await folderName.press('Enter');
  await visible(rowsIn(FOLDER_RENAMED).and(row(DRAFT)), 'заметка в переименованной папке');
  await gone(folderOf(FOLDER_NEW), 'прежнее название папки осталось в списке');
  // Удаление папки с заметкой: после вопроса заметка переезжает в «Без папки»
  await folderOf(FOLDER_RENAMED).locator('[data-folder-menu]').click();
  await page.locator('[data-folder-delete]').click();
  await page.locator('.confirm-dialog-button').filter({ hasText: 'Move and delete' }).click();
  await gone(folderOf(FOLDER_RENAMED), 'удалённая папка осталась в списке');
  await visible(rowsIn('').and(row(DRAFT)), 'заметка удалённой папки — в «Без папки»');
  // Пустая папка удаляется без вопроса
  await folderOf(FOLDER).locator('[data-folder-menu]').click();
  await page.locator('[data-folder-delete]').click();
  await gone(folderOf(FOLDER), 'пустая папка не удалена');
  await row(DRAFT).click();
  await visible(knowledge.locator(`[data-note-title="${DRAFT}"]`), 'перенесённая заметка открыта');
  await trashOpenNote();
  await gone(row(DRAFT), 'заметка-черновик не удалена');
  console.log('OK: папки — сворачивание, создание, заметка в папке, перенос, переименование, удаление');

  // ── Справка по кнопке: удалённая заметка создаётся заново, остальные не трогаются ──
  await row(GUIDE_OVERVIEW).click();
  await visible(knowledge.locator(`[data-note-title="${GUIDE_OVERVIEW}"]`), '«Обзор» перед удалением');
  await trashOpenNote();
  await waitRows(GUIDE_ROWS, GUIDE_NOTES - 1, '«Обзор» не удалён');
  await knowledge.locator('[data-notes-guide]').click();
  await page.locator('.confirm-dialog-button').filter({ hasText: 'Create' }).click();
  await visible(knowledge.locator(`[data-note-title="${GUIDE_OVERVIEW}"]`), '«Обзор» создан заново и открыт');
  await waitRows(GUIDE_ROWS, GUIDE_NOTES, 'восстановление справки изменило число заметок');
  await knowledge.locator('[data-notes-guide]').click();
  await visible(knowledge.locator(`[data-note-title="${GUIDE_OVERVIEW}"]`), '«Обзор» по кнопке справки');
  assert.equal(await page.locator('.confirm-dialog-button').filter({ hasText: 'Create' }).count(), 0, 'кнопка справки спросила о создании при живой справке');
  console.log('OK: кнопка «Справка Parvane» открывает «Обзор», удалённый — создаёт заново');

  // ── Удалённая справка сама не возвращается ────────────────────────────────
  for (let left = GUIDE_NOTES; left > 0; left--) {
    const guideTitle = await guideRows.first().getAttribute('data-note-row');
    await guideRows.first().click();
    await visible(knowledge.locator(`[data-note-title="${guideTitle}"]`), `заметка справки «${guideTitle}» перед удалением`);
    await trashOpenNote();
    await waitRows(GUIDE_ROWS, left - 1, `заметка справки не удалена (осталось ${left})`);
  }
  await guide.locator('[data-folder-menu]').click();
  await page.locator('[data-folder-delete]').click();
  await gone(guide, 'пустая папка справки не удалена');
  await visible(knowledge.getByText('No notes yet'), 'пустое состояние после удаления справки');
  // Следующие обновления облака (опрос, эхо своей правки) справку не возвращают
  await page.waitForTimeout(4000);
  assert.equal(await knowledge.locator('[data-note-row]').count(), 0, 'удалённая справка создана заново');
  assert.equal(await guide.count(), 0, 'папка удалённой справки создана заново');
  console.log('OK: справка создаётся один раз, после удаления сама не возвращается');

  // ── Новая заметка, название, текст со ссылкой, тегом и пунктами ───────────
  await knowledge.getByRole('button', { name: 'New note' }).click();
  await visible(note, 'открытая заметка');
  const title = note.getByLabel('Note title');
  await title.fill(NOTE);
  await title.blur();
  await visible(row(NOTE), 'строка переименованной заметки');
  await note.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#knowledge-note-editor').fill([
    `# ${NOTE}`, '', `Бюджетный сервер под LLM. См. [[${OTHER}]] #проект`, '',
    '- [ ] заказать блок питания до пт', '- [ ] проверить обе GPU',
  ].join('\n'));
  await note.getByRole('button', { name: 'Save' }).click();
  await visible(body.getByRole('button', { name: OTHER }), 'ссылка в тексте');
  await visible(body.getByText('#проект'), 'тег');
  assert.equal(await body.locator('input[type="checkbox"]').count(), 2, 'два пункта с галочками');
  assert.equal(await body.getByText('^t').count(), 0, 'метка пункта в чтении скрыта');
  await visible(row(NOTE).getByText('Бюджетный сервер под LLM'), 'первая строка в списке');
  console.log('OK: заметка создана, переименована, текст со ссылкой, тегом и пунктами');

  // ── Пункт со сроком стал задачей «Плана»; галочка ходит в обе стороны ─────
  await openPlannerScreen(page, 'today');
  await planner.locator('[data-today-undated]').click();
  const sheet = page.locator('[data-planner-undated]');
  const sheetTask = sheet.locator('[data-task-id]').filter({ hasText: 'заказать блок питания' });
  await visible(sheetTask, 'задача из пункта заметки');
  assert.equal(await sheet.locator('[data-task-id]').filter({ hasText: 'проверить обе GPU' }).count(), 0, 'пункт без даты — не задача');
  await sheetTask.locator('input[type="checkbox"]').check();
  await page.keyboard.press('Escape');
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await row(NOTE).click();
  await page.waitForFunction(() => document.querySelector('[data-note-body] input[type="checkbox"]')?.checked === true, undefined, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => assert.fail('галочка из «Плана» не дошла до пункта заметки'));
  await body.locator('input[type="checkbox"]').first().uncheck();
  await openPlannerScreen(page, 'today');
  await planner.locator('[data-today-undated]').click();
  await visible(sheetTask, 'задача снова не выполнена');
  assert.equal(await sheetTask.locator('input[type="checkbox"]').isChecked(), false, 'снятая в заметке галочка дошла до «Плана»');
  await page.keyboard.press('Escape');
  console.log('OK: пункт со сроком — задача «Плана», галочка ходит в обе стороны');

  // ── Заметка дня: кнопка на «Сегодня» создаёт её по шаблону в папке «Ежедневные» ──
  await planner.locator('[data-today-daily]').click();
  const dayKey = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  await visible(knowledge.locator(`[data-note-title="${dayKey}"]`), 'заметка дня');
  await visible(knowledge.locator('[data-folder="Daily"]'), 'папка ежедневных заметок');
  await openPlannerScreen(page, 'today');
  console.log('OK: заметка дня создаётся с экрана «Сегодня»');

  // ── «Запланировано»: событие со ссылкой на заметку ────────────────────────
  await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
  await page.locator('#planner-quick-input').fill(`созвон завтра 16:00 [[${NOTE}]]`);
  await page.locator('#planner-quick-input').press('Enter');
  await planner.getByText('Added:').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await row(NOTE).click();
  await visible(note.locator('[data-note-planned]').getByText('созвон'), 'событие в «Запланировано»');
  await visible(note.locator('[data-note-planned]').getByText('заказать блок питания'), 'задача из пункта в «Запланировано»');
  console.log('OK: «Запланировано» показывает событие со ссылкой и задачу из пункта');

  // ── Ссылка на несуществующую заметку создаёт её; обратные ссылки; поиск ───
  await body.getByRole('button', { name: OTHER }).click();
  await visible(knowledge.locator(`[data-note-title="${OTHER}"]`), 'созданная по ссылке заметка');
  // На широком экране «Связи» — отдельный остров справа от заметки, на узком — под её текстом
  await visible(knowledge.locator('[data-note-backlinks]').getByRole('button', { name: NOTE }), 'обратная ссылка');
  await knowledge.locator('#knowledge-search').fill('gpu');
  await visible(row(NOTE), 'найденная заметка');
  await row(OTHER).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('лишняя заметка в поиске'));
  await knowledge.locator('#knowledge-search').fill('');
  console.log('OK: заметка по ссылке, обратные ссылки, поиск по тексту');

  // ── Граф: заметки и записи «Плана» ────────────────────────────────────────
  await openTab('Graph');
  const graph = knowledge.locator('[data-notes-graph]');
  await visible(graph.locator('[data-node][data-kind="note"]'), 'узлы заметок');
  assert.equal(await graph.locator('[data-node][data-kind="note"]').count(), 2, 'две заметки на графе (заметка дня скрыта фильтром)');
  assert.equal(await graph.locator('[data-node][data-kind="record"]').count(), 0, 'записи «Плана» скрыты по умолчанию');

  // ── Граф: выбранная заметка открывается в панели справа, читается и правится на месте ──
  const panel = knowledge.locator('[data-graph-panel]');
  const panelBody = panel.locator('[data-note-body]');
  const graphNotice = knowledge.locator('[data-graph-notice]');
  const gnode = (title) => graph.locator(`[data-node][data-title="${title}"]`);
  const gedge = (from, to) => graph.locator(`[data-graph-edge][data-from-title="${from}"][data-to-title="${to}"]`);
  // Точка — её кружок: подпись под ним нажатий не принимает
  const centreOf = async (title) => {
    const box = await gnode(title).locator('circle').first().boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const clickNode = async (title) => {
    const at = await centreOf(title);
    await page.mouse.click(at.x, at.y);
  };
  const clickEdge = async (from, to) => {
    const a = await centreOf(from);
    const b = await centreOf(to);
    await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2);
  };
  // Связь ведут настоящей мышью: от кольца вокруг заметки (оно видно под указателем) до цели
  const dragLink = async (fromTitle, to) => {
    const from = await centreOf(fromTitle);
    await page.mouse.move(from.x, from.y);
    const radius = Number(await gnode(fromTitle).locator('[data-graph-handle]').getAttribute('r'));
    const scale = Number(await graph.getAttribute('data-graph-scale'));
    await page.mouse.move(from.x, from.y - radius * scale);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await visible(graph.locator('[data-graph-draft]'), 'линия связи под указателем');
    await page.mouse.up();
  };
  const linksTo = (title) => panelBody.locator(`button[data-title="${title}"]`);

  assert.equal(await knowledge.locator('[data-graph-card]').count(), 0, 'карточки выбранной точки в углу графа больше нет');
  assert.equal(await panel.count(), 0, 'пока ничего не выбрано, панели нет — граф во всю ширину');
  const wideBoard = (await graph.boundingBox()).width;
  await clickNode(OTHER);
  await visible(panel.locator(`[data-note-title="${OTHER}"]`), 'заметка выбранной точки в панели справа');
  assert.ok((await graph.boundingBox()).width < wideBoard, 'панель не встала рядом с графом');
  assert.ok((await panel.boundingBox()).width >= 340, 'панель графа слишком узкая для чтения');
  await clickNode(NOTE);
  await visible(panelBody.getByText('Бюджетный сервер под LLM'), 'текст заметки в панели графа');
  assert.equal(await graph.getAttribute('data-graph-picked'), await gnode(NOTE).getAttribute('data-node'), 'выбранная точка не отмечена');
  await visible(panel.locator('[data-note-planned]').getByText('созвон'), '«Запланировано» в панели графа');
  // Ссылка в панели выбирает точку на графе, обратная ссылка возвращает
  await linksTo(OTHER).click();
  await visible(panel.locator(`[data-note-title="${OTHER}"]`), 'заметка по ссылке в панели графа');
  await panel.locator('[data-note-backlinks]').getByRole('button', { name: NOTE }).click();
  await visible(panel.locator(`[data-note-title="${NOTE}"]`), 'заметка по обратной ссылке в панели графа');
  // Правка прямо в панели
  await panel.getByRole('button', { name: 'Edit' }).click();
  const panelEditor = page.locator('#knowledge-note-editor');
  await panelEditor.fill(`${await panelEditor.inputValue()}\n\n${PANEL_EDIT}`);
  await panel.getByRole('button', { name: 'Save' }).click();
  await visible(panelBody.getByText(PANEL_EDIT), 'правка заметки в панели графа');
  console.log('OK: граф — заметка открывается в панели справа, ссылки в ней выбирают точки, правка на месте');

  // ── Граф: связь — это ссылка в тексте. Связь на пустое место создаёт заметку ──
  const noteAt = await centreOf(NOTE);
  const otherAt = await centreOf(OTHER);
  const graphBox = await graph.boundingBox();
  // Место новой заметки — в стороне от линии между двумя прежними, чтобы связи не легли друг на друга
  const apart = Math.hypot(otherAt.x - noteAt.x, otherAt.y - noteAt.y) || 1;
  const side = [1, -1].map((sign) => ({
    x: (noteAt.x + otherAt.x) / 2 + sign * ((otherAt.y - noteAt.y) / apart) * 200,
    y: (noteAt.y + otherAt.y) / 2 - sign * ((otherAt.x - noteAt.x) / apart) * 200,
  })).find((point) => point.x > graphBox.x + 140 && point.x < graphBox.x + graphBox.width - 140
    && point.y > graphBox.y + 100 && point.y < graphBox.y + graphBox.height - 100);
  assert.ok(side, 'на поле графа нет места в стороне от заметок');
  await dragLink(OTHER, side);
  const newTitle = graph.locator('[data-graph-new]');
  await visible(newTitle, 'поле названия новой заметки там, где бросили связь');
  await newTitle.fill(GRAPH_NOTE);
  await newTitle.press('Enter');
  await visible(gnode(GRAPH_NOTE), 'новая заметка на графе');
  await visible(gedge(OTHER, GRAPH_NOTE), 'связь с новой заметкой');
  assert.equal(await gnode(GRAPH_NOTE).getAttribute('data-kind'), 'note', 'новая заметка — настоящая, а не «ещё нет»');

  // Связь между существующими заметками — перетаскиванием от кольца
  await dragLink(NOTE, await centreOf(GRAPH_NOTE));
  await visible(gedge(NOTE, GRAPH_NOTE), 'связь, проведённая на графе');
  await visible(graphNotice.getByText('Link added'), 'сообщение о новой связи');
  await visible(linksTo(GRAPH_NOTE), 'ссылка в тексте заметки-источника');
  await visible(panelBody.getByText(PANEL_EDIT), 'текст заметки после новой связи на месте');
  await clickNode(GRAPH_NOTE);
  const backlinks = panel.locator('[data-note-backlinks]');
  await visible(backlinks.getByRole('button', { name: NOTE }), 'источник в обратных ссылках цели');
  await visible(backlinks.getByRole('button', { name: OTHER }), 'второй источник в обратных ссылках цели');
  // Та же связь второй раз ссылку не дублирует
  await dragLink(NOTE, await centreOf(GRAPH_NOTE));
  await visible(graphNotice.getByText('already links'), 'сообщение о существующей связи');
  await clickNode(NOTE);
  await visible(linksTo(GRAPH_NOTE), 'ссылка в тексте после повторной связи');
  assert.equal(await linksTo(GRAPH_NOTE).count(), 1, 'повторная связь продублировала ссылку');
  assert.equal(await graph.locator('[data-graph-edge]').count(), 3, 'на графе не три связи');
  console.log('OK: граф — связь линией пишет ссылку в текст, на пустом месте создаёт заметку, дважды не дублирует');

  // Связи пережили перезагрузку
  await page.waitForTimeout(1500);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(graph, 'вкладка графа после перезагрузки');
  await visible(gedge(NOTE, GRAPH_NOTE), 'связь, проведённая на графе, после перезагрузки');
  await visible(gedge(OTHER, GRAPH_NOTE), 'связь с новой заметкой после перезагрузки');
  await clickNode(NOTE);
  await visible(linksTo(GRAPH_NOTE), 'ссылка в тексте после перезагрузки');
  console.log('OK: граф — связи пережили перезагрузку');

  // ── Граф: связь убирают, выбрав линию. Ссылка отдельной строкой уходит из текста ──
  await clickEdge(NOTE, GRAPH_NOTE);
  await graph.locator('[data-graph-edge-remove]').click();
  await gone(gedge(NOTE, GRAPH_NOTE), 'убранная связь');
  await visible(graphNotice.getByText('Link removed'), 'сообщение об убранной связи');
  await gone(linksTo(GRAPH_NOTE), 'ссылка в тексте после удаления связи');
  await visible(panelBody.getByText(PANEL_EDIT), 'остальной текст заметки после удаления связи');
  // «Отменить» возвращает ссылку, Delete убирает выбранную связь снова
  await knowledge.locator('[data-graph-undo]').click();
  await visible(gedge(NOTE, GRAPH_NOTE), 'связь после отмены удаления');
  await visible(linksTo(GRAPH_NOTE), 'ссылка в тексте после отмены удаления');
  await clickEdge(NOTE, GRAPH_NOTE);
  await visible(graph.locator('[data-graph-edge-remove]'), 'крестик выбранной связи');
  await page.keyboard.press('Delete');
  await gone(gedge(NOTE, GRAPH_NOTE), 'связь, убранная клавишей');
  await gone(linksTo(GRAPH_NOTE), 'ссылка в тексте после удаления клавишей');
  // Ссылку внутри предложения граф не переписывает: заметка открывается в правке, ссылка выделена
  await clickEdge(NOTE, OTHER);
  await graph.locator('[data-graph-edge-remove]').click();
  await visible(panelEditor, 'правка заметки со ссылкой внутри текста');
  await visible(graphNotice.getByText('inside the text'), 'сообщение о ссылке внутри текста');
  await page.waitForFunction((wanted) => {
    const editor = document.querySelector('#knowledge-note-editor');
    return editor && editor.value.slice(editor.selectionStart, editor.selectionEnd) === wanted;
  }, `[[${OTHER}]]`, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('ссылка внутри текста не выделена в правке'));
  await panel.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await gedge(NOTE, OTHER).count(), 1, 'связь со ссылкой внутри текста осталась');
  await visible(linksTo(OTHER), 'ссылка внутри текста на месте');
  // Вернуть хранилище к двум заметкам с одной связью: дальше по ним строится холст
  await clickEdge(OTHER, GRAPH_NOTE);
  await graph.locator('[data-graph-edge-remove]').click();
  await gone(gedge(OTHER, GRAPH_NOTE), 'связь с новой заметкой');
  await clickNode(GRAPH_NOTE);
  await visible(panel.locator(`[data-note-title="${GRAPH_NOTE}"]`), 'новая заметка в панели');
  await panel.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
  await gone(gnode(GRAPH_NOTE), 'удалённая заметка на графе');
  await gone(panel, 'панель удалённой заметки');
  assert.equal(await graph.locator('[data-node][data-kind="note"]').count(), 2, 'на графе снова две заметки');
  assert.equal(await graph.locator('[data-graph-edge]').count(), 1, 'на графе снова одна связь');
  console.log('OK: граф — отдельная ссылка убирается линией (крестик, Delete, отмена), ссылка внутри текста — только в правке');

  await graph.getByText('Events and tasks', { exact: true }).click();
  await visible(graph.locator('[data-node][data-kind="record"]'), 'узел записи «Плана»');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-graph.png` });
  // Запись «Плана» в панели: день и время, переход в «План» есть
  const recordNode = graph.locator('[data-node][data-kind="record"]').locator('circle').first();
  const recordBox = await recordNode.boundingBox();
  await page.mouse.click(recordBox.x + recordBox.width / 2, recordBox.y + recordBox.height / 2);
  await visible(panel.locator('[data-graph-panel-record]').getByText('созвон'), 'запись «Плана» в панели графа');
  await visible(panel.locator('[data-graph-panel-plan]'), 'переход к записи в «План»');
  await panel.locator('[data-graph-panel-close]').click();
  await gone(panel, 'закрытая панель графа');
  console.log('OK: граф — заметки, по фильтру записи «Плана»');

  // Правка из панели графа видна на вкладке «Заметки»
  await openTab('Notes');
  await row(NOTE).click();
  await visible(body.getByText(PANEL_EDIT), 'правка из панели графа на вкладке «Заметки»');
  assert.equal(await body.locator(`button[data-title="${GRAPH_NOTE}"]`).count(), 0, 'убранная на графе ссылка осталась в тексте');

  // ── Холст из графа: карточка на каждую заметку, стрелка на каждую ссылку ──
  await openTab('Canvas');
  const canvasCount = (selector, count, what) => page.waitForFunction(
    ([query, wanted]) => document.querySelectorAll(query).length === wanted, [selector, count], { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail(what));
  const chip = (name) => knowledge.locator(`[data-canvas-chip="${name}"]`);
  await knowledge.locator('[data-notes-canvas="empty"] [data-canvas-from-graph]').click();
  const board = knowledge.locator('[data-canvas-board]');
  await visible(board, 'поле холста');
  await visible(chip('Link graph'), 'холст из графа назван «Link graph»');
  // Заметки: NOTE, OTHER и заметка дня; ссылка одна — из NOTE в OTHER
  await canvasCount('[data-canvas-node][data-canvas-type="file"]', 3, 'на холсте из графа не по карточке на заметку');
  await canvasCount('[data-canvas-edge]', 1, 'на холсте из графа не по стрелке на ссылку');
  const boxes = await board.locator('[data-canvas-node]').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return [box.left, box.top, box.right, box.bottom];
  }));
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => {
    assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], 'карточки холста из графа накладываются');
  }));
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-canvas-graph.png` });
  // Ещё раз — новый холст со следующим свободным названием
  await knowledge.locator('[data-board-tools] [data-canvas-from-graph]').click();
  await visible(chip('Link graph 2'), 'второй холст из графа');
  console.log('OK: холст из графа — карточки заметок и стрелки ссылок');

  // ── Холст можно переименовать и отправить в корзину ───────────────────────
  await knowledge.locator('[data-canvas-menu]').click();
  await page.locator('#knowledge-canvas-name').fill('Карта проекта');
  await page.locator('#knowledge-canvas-name').press('Enter');
  await visible(chip('Карта проекта'), 'переименованный холст');
  await chip('Link graph 2').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('прежнее название холста осталось'));
  await knowledge.locator('[data-canvas-menu]').click();
  await page.locator('[data-canvas-delete]').click();
  await page.locator('.confirm-dialog-button').filter({ hasText: 'Move to trash' }).click();
  await chip('Карта проекта').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('удалённый холст остался в списке'));
  // После удаления открыт оставшийся холст
  await visible(chip('Link graph'), 'оставшийся холст');
  assert.equal(await chip('Link graph').getAttribute('aria-pressed'), 'true', 'после удаления открыт другой холст');
  await canvasCount('[data-canvas-node][data-canvas-type="file"]', 3, 'оставшийся холст не показан');
  assert.equal(await knowledge.locator('[data-canvas-chip]').count(), 1, 'холст остался один');
  console.log('OK: холст переименован и удалён, открыт оставшийся');

  // ── «Обновить из графа»: новое из заметок появляется, сделанное руками остаётся на месте ──
  const CASE = 'Корпус';
  const HAND_TEXT = 'Своя пометка';
  const fileCards = '[data-canvas-node][data-canvas-type="file"]';
  const handCard = board.locator('[data-canvas-type="text"]').filter({ hasText: HAND_TEXT });
  const refresh = knowledge.locator('[data-canvas-refresh]');
  // Место и ширина каждого узла — из его стиля (координаты холста, от вида не зависят)
  const places = async () => {
    await page.waitForTimeout(300);
    return board.locator('[data-canvas-node]').evaluateAll((nodes) => Object.fromEntries(
      nodes.map((node) => [node.dataset.canvasNode, [node.style.left, node.style.top, node.style.width]]),
    ));
  };
  const samePlaces = (before, after, what) => Object.keys(before).forEach((id) => {
    assert.deepEqual(after[id], before[id], `${what}: узел ${id} сдвинут или пропал`);
  });
  // Правка текста заметки NOTE; возвращает текст, который был до правки
  const rewriteNote = async (change) => {
    await openTab('Notes');
    await row(NOTE).click();
    await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка для правки');
    await note.getByRole('button', { name: 'Edit' }).click();
    const editor = page.locator('#knowledge-note-editor');
    const before = await editor.inputValue();
    await editor.fill(change(before));
    await note.getByRole('button', { name: 'Save' }).click();
    return before;
  };
  const backToCanvas = async () => {
    await openTab('Canvas');
    await visible(board, 'поле холста после возврата');
    await visible(handCard, 'своя текстовая карточка после возврата на холст');
  };

  await knowledge.getByRole('button', { name: 'Text', exact: true }).click();
  await visible(board.locator('textarea[data-canvas-inline]'), 'поле текста своей карточки');
  await board.locator('[data-canvas-inline]').fill(HAND_TEXT);
  await board.locator('[data-canvas-inline]').press('Enter');
  await visible(handCard, 'своя текстовая карточка');
  // Обновление без перемен в заметках ничего не меняет
  await refresh.click();
  await visible(page.getByText('Nothing to update'), 'сообщение «обновлять нечего»');
  await canvasCount(fileCards, 3, 'обновление без перемен добавило карточки');
  await canvasCount('[data-canvas-edge]', 1, 'обновление без перемен изменило стрелки');
  const placesBefore = await places();
  // Правка холста пишется с задержкой — дождаться записи перед уходом с вкладки
  await page.waitForTimeout(2000);

  // Новая заметка, на которую ссылается прежняя
  const noteText = await rewriteNote((text) => `${text}\n\nКуда ставить: [[${CASE}]]`);
  await body.getByRole('button', { name: CASE }).click();
  await visible(knowledge.locator(`[data-note-title="${CASE}"]`), 'новая заметка по ссылке');
  await backToCanvas();
  await canvasCount(fileCards, 3, 'карточка новой заметки появилась без обновления');
  await refresh.click();
  await canvasCount(fileCards, 4, 'обновление не добавило карточку новой заметки');
  await canvasCount('[data-canvas-edge]', 2, 'обновление не добавило стрелку новой ссылки');
  await visible(page.getByText('Added notes: 1, links: 1. Removed links: 0'), 'итог обновления');
  await visible(board.locator(fileCards).filter({ hasText: CASE }), 'карточка новой заметки');
  await visible(handCard, 'своя текстовая карточка после обновления');
  const placesAdded = await places();
  samePlaces(placesBefore, placesAdded, 'после обновления');
  assert.equal(Object.keys(placesAdded).length, Object.keys(placesBefore).length + 1, 'после обновления узлов не на один больше');
  const refreshed = await board.locator('[data-canvas-node]').evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return [box.left, box.top, box.right, box.bottom];
  }));
  refreshed.forEach((a, i) => refreshed.slice(i + 1).forEach((b) => {
    assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], 'новая карточка легла на другой узел');
  }));
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-canvas-refresh.png` });
  await page.waitForTimeout(2000);

  // Ссылку убрали из заметки: своя стрелка уходит, карточка остаётся; отмена возвращает стрелку
  await rewriteNote(() => noteText);
  await body.getByRole('button', { name: CASE }).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('ссылка осталась в заметке'));
  await backToCanvas();
  await canvasCount('[data-canvas-edge]', 2, 'стрелка пропала без обновления');
  await refresh.click();
  await canvasCount('[data-canvas-edge]', 1, 'обновление не убрало стрелку исчезнувшей ссылки');
  await canvasCount(fileCards, 4, 'обновление убрало карточку');
  await visible(page.getByText('Added notes: 0, links: 0. Removed links: 1'), 'итог обновления после удаления ссылки');
  samePlaces(placesAdded, await places(), 'после второго обновления');
  await knowledge.locator('[data-canvas-undo]').click();
  await canvasCount('[data-canvas-edge]', 2, 'отмена не вернула стрелку');
  await canvasCount(fileCards, 4, 'отмена обновления тронула карточки');
  await knowledge.locator('[data-canvas-redo]').click();
  await canvasCount('[data-canvas-edge]', 1, 'возврат не убрал стрелку снова');
  // То же действие — в меню пустого места поля
  const freePoints = await board.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const points = [];
    for (let y = box.bottom - 30; y > box.top + 140; y -= 60) {
      for (let x = box.left + 30; x < box.right - 90; x += 60) {
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && !hit.closest('[data-canvas-node], [data-board-tools]')) points.push([x, y]);
      }
    }
    return points;
  });
  let hasRefreshItem = false;
  for (const [x, y] of freePoints.slice(0, 12)) {
    await page.mouse.click(x, y, { button: 'right' });
    await page.locator('[data-canvas-context]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    hasRefreshItem = (await page.locator('[data-canvas-command="refreshGraph"]').count()) > 0;
    await page.keyboard.press('Escape');
    await page.locator('[data-canvas-context]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
    // Точка у самой стрелки открывает меню стрелки — берётся следующая
    if (hasRefreshItem) break;
  }
  assert.ok(hasRefreshItem, 'в меню пустого места поля нет «Обновить из графа»');
  console.log('OK: «Обновить из графа» — новая карточка и стрелка, своё на месте, исчезнувшая ссылка убрана, отмена');

  // ── Холст: текст, карточка заметки, связь ─────────────────────────────────
  await knowledge.getByRole('button', { name: 'New canvas' }).click();
  await visible(chip('Canvas 2'), 'новый пустой холст');
  await canvasCount('[data-canvas-node]', 0, 'новый холст не пуст');
  // Новая текстовая карточка сразу открыта для ввода; Enter сохраняет
  const inlineField = board.locator('[data-canvas-inline]');
  const textCard = board.locator('[data-canvas-type="text"]');
  await knowledge.getByRole('button', { name: 'Text', exact: true }).click();
  await visible(textCard.locator('textarea[data-canvas-inline]'), 'поле текста новой карточки');
  await inlineField.fill('Идея');
  await inlineField.press('Enter');
  await visible(textCard.getByText('Идея', { exact: true }), 'текст новой карточки');
  // Двойной клик правит текст на месте: Escape отменяет, уход фокуса сохраняет
  await textCard.dblclick();
  await visible(inlineField, 'поле правки текста по двойному клику');
  await inlineField.fill('Не сохранится');
  await inlineField.press('Escape');
  await visible(textCard.getByText('Идея', { exact: true }), 'текст после отмены правки');
  await textCard.dblclick();
  await inlineField.fill('Идея 2');
  await board.click({ position: { x: 20, y: 300 } });
  await visible(textCard.getByText('Идея 2', { exact: true }), 'текст после правки на месте');
  await knowledge.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: NOTE }).click();
  await visible(board.locator('[data-canvas-type="file"]').getByText('Бюджетный сервер под LLM'), 'карточка заметки с началом текста');
  await knowledge.getByRole('button', { name: 'Connect' }).click();
  await board.locator('[data-canvas-type="text"]').click({ position: { x: 5, y: 5 } });
  await board.locator('[data-canvas-type="file"]').click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-edge]').length === 1, undefined, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => assert.fail('связь на холсте не создана'));
  // Группа: новая сразу просит название; двойной клик по подписи его меняет
  const groupCard = board.locator('[data-canvas-type="group"]');
  await knowledge.getByRole('button', { name: 'Group', exact: true }).click();
  await visible(groupCard.locator('input[data-canvas-inline]'), 'поле названия новой группы');
  await inlineField.fill('Железо');
  await inlineField.press('Enter');
  await visible(groupCard.locator('[data-canvas-group-label]').filter({ hasText: 'Железо' }), 'название группы');
  await groupCard.locator('[data-canvas-group-label]').dblclick();
  await visible(groupCard.locator('input[data-canvas-inline]'), 'поле названия группы по двойному клику');
  await inlineField.fill('Сервер');
  await inlineField.press('Enter');
  await visible(groupCard.locator('[data-canvas-group-label]').filter({ hasText: 'Сервер' }), 'новое название группы');
  assert.equal(await board.getByText('Group', { exact: true }).count(), 0, 'слова-заглушки на холсте нет');
  console.log('OK: текст карточки и название группы правятся двойным кликом на месте');

  // ── Холст как редактор: размер, группы, отмена, клавиши, стрелки — настоящими движениями мыши ──
  // Кадр на перерисовку: положение и размер читаются из стиля узла
  const settle = () => page.waitForTimeout(200);
  const rectOf = async (locator) => {
    await settle();
    return locator.evaluate((element) => ({
      x: parseFloat(element.style.left),
      y: parseFloat(element.style.top),
      width: parseFloat(element.style.width),
      height: parseFloat(element.style.height || element.style.minHeight),
    }));
  };
  const centerOf = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    await settle();
  };
  // Новая текстовая карточка двойным кликом по пустому месту поля
  const addCardAt = async (x, y, text) => {
    await page.mouse.dblclick(x, y);
    await visible(inlineField, `поле новой карточки «${text}»`);
    await settle();
    await inlineField.fill(text);
    await inlineField.press('Enter');
    await visible(textCard.getByText(text, { exact: true }), `карточка «${text}»`);
    await settle();
  };
  const isInside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  const groupNamed = (name) => groupCard.filter({ hasText: name });
  const cardNamed = (name) => textCard.filter({ hasText: name });
  const bar = board.locator('[data-canvas-selection-bar]');
  const boardBox = await board.boundingBox();
  const left = boardBox.x + 200;
  const bottom = boardBox.y + boardBox.height;

  // Группа меняет размер за угловую ручку; содержимое остаётся на месте
  const serverGroup = groupNamed('Сервер');
  await serverGroup.locator('[data-canvas-group-label]').click();
  const serverBefore = await rectOf(serverGroup);
  const fileBefore = await rectOf(board.locator('[data-canvas-type="file"]'));
  const serverCorner = await centerOf(serverGroup.locator('[data-canvas-handle="se"]'));
  await drag(serverCorner, { x: serverCorner.x + 130, y: serverCorner.y + 90 });
  const serverSize = await rectOf(serverGroup);
  assert.ok(
    serverSize.width >= serverBefore.width + 120 && serverSize.height >= serverBefore.height + 80,
    `группа не выросла за ручку: ${JSON.stringify(serverBefore)} → ${JSON.stringify(serverSize)}`,
  );
  assert.deepEqual(await rectOf(board.locator('[data-canvas-type="file"]')), fileBefore, 'содержимое группы сдвинулось при смене размера');
  console.log('OK: группа меняет размер за угловую ручку');

  // Две выделенные карточки оборачиваются в группу
  await addCardAt(left, bottom - 260, 'Альфа');
  await addCardAt(left + 320, bottom - 260, 'Бета');
  await cardNamed('Альфа').click();
  await cardNamed('Бета').click({ modifiers: ['Shift'] });
  await visible(bar, 'панель выделенного');
  await bar.locator('[data-canvas-action="wrap"]').click();
  await visible(groupCard.locator('input[data-canvas-inline]'), 'поле названия группы из выделенного');
  await settle();
  await inlineField.fill('Пара');
  await inlineField.press('Enter');
  const pairGroup = groupNamed('Пара');
  await visible(pairGroup.locator('[data-canvas-group-label]'), 'группа из двух карточек');
  const pairFrame = await rectOf(pairGroup);
  assert.ok(isInside(await rectOf(cardNamed('Альфа')), pairFrame), 'группа не охватила первую карточку');
  assert.ok(isInside(await rectOf(cardNamed('Бета')), pairFrame), 'группа не охватила вторую карточку');
  console.log('OK: две выделенные карточки обёрнуты в группу');

  // «По содержимому» возвращает растянутую рамку к содержимому
  await pairGroup.locator('[data-canvas-group-label]').click();
  const pairCorner = await centerOf(pairGroup.locator('[data-canvas-handle="se"]'));
  await drag(pairCorner, { x: pairCorner.x + 140, y: pairCorner.y + 60 });
  assert.ok((await rectOf(pairGroup)).width >= pairFrame.width + 130, 'рамка не растянулась перед «по содержимому»');
  await bar.locator('[data-canvas-action="fit"]').click();
  assert.deepEqual(await rectOf(pairGroup), pairFrame, '«по содержимому» не вернуло рамку к содержимому');
  console.log('OK: «по содержимому» подгоняет рамку группы');

  // Сдвиг карточки отменяется и возвращается
  await addCardAt(left, bottom - 110, 'Гамма');
  const gamma = cardNamed('Гамма');
  const gammaBefore = await rectOf(gamma);
  const gammaCenter = await centerOf(gamma);
  await drag(gammaCenter, { x: gammaCenter.x + 400, y: gammaCenter.y + 20 });
  const gammaMoved = await rectOf(gamma);
  assert.ok(gammaMoved.x >= gammaBefore.x + 380, 'карточка не сдвинулась');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await rectOf(gamma), gammaBefore, 'отмена не вернула карточку на место');
  await page.keyboard.press('Control+Shift+z');
  assert.deepEqual(await rectOf(gamma), gammaMoved, 'возврат не повторил сдвиг');
  await knowledge.locator('[data-canvas-undo]').click();
  assert.deepEqual(await rectOf(gamma), gammaBefore, 'кнопка отмены не вернула карточку');
  await knowledge.locator('[data-canvas-redo]').click();
  assert.deepEqual(await rectOf(gamma), gammaMoved, 'кнопка возврата не повторила сдвиг');
  console.log('OK: сдвиг отменяется и возвращается клавишами и кнопками');

  // Delete удаляет выделенную карточку
  await gamma.click();
  await page.keyboard.press('Delete');
  await gamma.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('Delete не удалил выделенную карточку'));
  console.log('OK: Delete удаляет выделенную карточку');

  // Стрелка тянется от точки на стороне карточки к другой карточке
  await cardNamed('Альфа').hover();
  const port = await centerOf(cardNamed('Альфа').locator('[data-canvas-port="right"]'));
  await drag(port, await centerOf(cardNamed('Бета')));
  await canvasCount('[data-canvas-edge]', 2, 'стрелка от точки на стороне карточки не создана');
  console.log('OK: стрелка от точки на стороне карточки');

  // Подпись стрелки правится на месте двойным кликом
  const edgeMiddle = await board.locator('[data-canvas-edge]').nth(1).locator('path').first().evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
  await page.mouse.dblclick(edgeMiddle.x, edgeMiddle.y);
  await visible(board.locator('input[data-canvas-inline]'), 'поле подписи стрелки');
  await settle();
  await inlineField.fill('ведёт');
  await inlineField.press('Enter');
  await visible(board.locator('[data-canvas-edge] text').filter({ hasText: 'ведёт' }), 'подпись стрелки');
  await page.keyboard.press('Escape');
  console.log('OK: подпись стрелки правится на месте');

  // ── Группа двигается за пустое место внутри; поле двигается только вне групп ──
  const world = board.locator('[data-canvas-world]');
  // Вид поля числами: сдвиг и масштаб из преобразования слоя с узлами
  const viewOf = () => world.evaluate((element) => (
    element.style.transform.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number)
  ));
  const sameView = (a, b) => a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 0.01);
  const deltaOf = (before, after) => [after.x - before.x, after.y - before.y];
  // Пустая точка поля: внутри рамки группы `inside` либо (без неё) вне всех групп; не у карточки и не у стрелки
  const emptyPoint = (inside) => board.evaluate((element, groupName) => {
    const groups = Array.from(element.querySelectorAll('[data-canvas-type="group"]'));
    const target = groupName ? groups.find((group) => group.textContent.includes(groupName)) : undefined;
    const box = (target || element).getBoundingClientRect();
    const near = (rect, x, y, by) => x >= rect.left - by && x <= rect.right + by && y >= rect.top - by && y <= rect.bottom + by;
    const edges = Array.from(element.querySelectorAll('[data-canvas-edge]')).map((edge) => edge.getBoundingClientRect());
    const frames = groups.map((group) => group.getBoundingClientRect());
    const from = target ? 10 : 160;
    for (let y = box.top + from; y < box.bottom - 10; y += 8) {
      for (let x = box.left + 10; x < box.right - (target ? 10 : 120); x += 8) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !element.contains(hit) || hit.closest('[data-canvas-node], [data-board-tools]')) continue;
        if (edges.some((rect) => near(rect, x, y, 24))) continue;
        if (!target && frames.some((rect) => near(rect, x, y, 48))) continue;
        return { x, y };
      }
    }
    return undefined;
  }, inside);
  await page.keyboard.press('Escape');
  await settle();
  const pairBefore = await rectOf(pairGroup);
  const alphaBefore = await rectOf(cardNamed('Альфа'));
  const betaBefore = await rectOf(cardNamed('Бета'));
  const viewBefore = await viewOf();
  const insidePair = await emptyPoint('Пара');
  assert.ok(insidePair, 'внутри группы нет пустого места для перетаскивания');
  await drag(insidePair, { x: insidePair.x + 130, y: insidePair.y - 90 });
  const pairDelta = deltaOf(pairBefore, await rectOf(pairGroup));
  assert.ok(
    Math.abs(pairDelta[0]) >= 100 && Math.abs(pairDelta[1]) >= 60,
    `группа не сдвинулась за пустое место внутри: ${JSON.stringify(pairDelta)}`,
  );
  assert.deepEqual(deltaOf(alphaBefore, await rectOf(cardNamed('Альфа'))), pairDelta, 'первая карточка не поехала вместе с группой');
  assert.deepEqual(deltaOf(betaBefore, await rectOf(cardNamed('Бета'))), pairDelta, 'вторая карточка не поехала вместе с группой');
  assert.deepEqual(await viewOf(), viewBefore, 'вместо группы сдвинулось поле');
  await visible(bar.locator('[data-canvas-action="fit"]'), 'группа выделена после перетаскивания');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await rectOf(pairGroup), pairBefore, 'отмена не вернула группу на место');
  assert.deepEqual(await rectOf(cardNamed('Альфа')), alphaBefore, 'отмена не вернула карточку группы на место');
  // Нажатие без сдвига внутри группы её выделяет
  await page.keyboard.press('Escape');
  await bar.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('выделение не снято'));
  await page.mouse.click(insidePair.x, insidePair.y);
  await visible(bar.locator('[data-canvas-action="fit"]'), 'группа выделена нажатием внутри неё');
  await page.keyboard.press('Escape');
  console.log('OK: группа двигается за пустое место внутри вместе с карточками, поле стоит');

  const outside = await emptyPoint();
  assert.ok(outside, 'на поле нет пустого места вне групп');
  const placesBeforePan = await places();
  await drag(outside, { x: outside.x + 70, y: outside.y + 50 });
  const viewPanned = await viewOf();
  assert.ok(
    Math.abs(viewPanned[0] - viewBefore[0] - 70) < 1 && Math.abs(viewPanned[1] - viewBefore[1] - 50) < 1,
    `перетаскивание пустого места вне групп не сдвинуло поле: ${viewBefore} → ${viewPanned}`,
  );
  samePlaces(placesBeforePan, await places(), 'после сдвига поля');
  await drag({ x: outside.x + 70, y: outside.y + 50 }, outside);
  assert.ok(sameView(await viewOf(), viewBefore), 'поле не вернулось обратным перетаскиванием');
  console.log('OK: поле двигается перетаскиванием пустого места вне групп');

  // ── Заметка правится прямо на карточке: текст, название; заметку открывает кнопка в шапке ──
  const RENAMED = `${NOTE} новый`;
  const noteCardOf = (title) => board.locator('[data-canvas-type="file"]')
    .filter({ has: page.locator(`[data-canvas-note-title="${title}"]`) });
  const noteCard = noteCardOf(NOTE);
  const noteEditor = board.locator('[data-canvas-note-editor]');
  const titleField = board.locator('[data-canvas-note-title-input]');
  await visible(noteCard.locator('[data-canvas-open-note]'), 'кнопка «открыть заметку» в шапке карточки');
  // Двойной клик по тексту карточки открывает исходник заметки целиком; Escape отменяет
  await noteCard.locator('[data-canvas-note-body]').dblclick();
  await visible(noteEditor, 'поле текста заметки на карточке');
  const noteSource = await noteEditor.inputValue();
  assert.ok(
    noteSource.startsWith(`# ${NOTE}`) && noteSource.includes('- [ ] проверить обе GPU'),
    `в поле не исходник заметки целиком: ${noteSource}`,
  );
  await noteEditor.fill(`${noteSource}\nНе сохранится`);
  await noteEditor.press('Escape');
  await gone(noteEditor, 'поле текста заметки после Escape');
  // Enter — новая строка, Ctrl+Z — отмена ввода в поле (а не правок холста); уход фокуса сохраняет
  const placesBeforeEdit = await places();
  await noteCard.locator('[data-canvas-note-body]').dblclick();
  await visible(noteEditor, 'поле текста заметки по второму двойному клику');
  assert.equal(await noteEditor.inputValue(), noteSource, 'отменённая правка попала в заметку');
  await noteEditor.fill(`${noteSource}\nСтрока с холста`);
  await noteEditor.press('Enter');
  await page.keyboard.type('вторая строка');
  assert.equal(await noteEditor.inputValue(), `${noteSource}\nСтрока с холста\nвторая строка`, 'Enter не дал новую строку');
  await page.keyboard.type(' лишнее');
  await page.keyboard.press('Control+z');
  await settle();
  assert.equal(await noteEditor.count(), 1, 'Ctrl+Z в поле заметки закрыл поле (сработала отмена холста)');
  samePlaces(placesBeforeEdit, await places(), 'Ctrl+Z в поле заметки');
  await noteEditor.fill(`${noteSource}\nСтрока с холста\nвторая строка`);
  // Карточка на время правки выросла — пустое место ищется заново
  const blurAt = await emptyPoint();
  await page.mouse.click(blurAt.x, blurAt.y);
  await gone(noteEditor, 'поле текста заметки после ухода фокуса');
  await visible(noteCard.getByText('вторая строка'), 'сохранённый текст на карточке');
  samePlaces(placesBeforeEdit, await places(), 'после правки заметки на карточке');
  // Enter на выделенной карточке тоже открывает правку; Ctrl+Enter сохраняет
  await noteCard.locator('[data-canvas-note-body]').click();
  await page.keyboard.press('Enter');
  await visible(noteEditor, 'поле текста заметки по Enter');
  await page.waitForFunction((want) => document.querySelector('[data-canvas-note-editor]')?.value === want,
    `${noteSource}\nСтрока с холста\nвторая строка`, { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('сохранённая с холста правка не вернулась в поле'));
  await noteEditor.fill(`${noteSource}\nСтрока с холста`);
  await noteEditor.press('Control+Enter');
  await gone(noteEditor, 'поле текста заметки после Ctrl+Enter');
  await page.keyboard.press('Escape');
  // Холст пишется с задержкой — дождаться записи перед уходом с вкладки
  await page.waitForTimeout(2000);
  await noteCard.locator('[data-canvas-open-note]').click();
  await visible(knowledge.locator(`[data-note-title="${NOTE}"]`), 'заметка, открытая кнопкой на карточке');
  await visible(body.getByText('Строка с холста'), 'правка с холста на экране заметки');
  assert.equal(await body.getByText('вторая строка').count(), 0, 'убранная на холсте строка осталась в заметке');
  assert.equal(await body.getByText('Не сохранится').count(), 0, 'отменённая правка попала в заметку');
  console.log('OK: текст заметки правится на карточке холста: Escape, новая строка, уход фокуса, Ctrl+Enter');

  // Название с карточки: Escape и пустое название ничего не меняют; новое доходит до списка и ссылок
  await row(OTHER).click();
  await visible(knowledge.locator(`[data-note-title="${OTHER}"]`), 'заметка для ссылки');
  await note.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#knowledge-note-editor').fill(`# ${OTHER}\n\nСм. [[${NOTE}]]`);
  await note.getByRole('button', { name: 'Save' }).click();
  await visible(body.getByRole('button', { name: NOTE, exact: true }), 'ссылка на заметку в другой заметке');
  const toCanvasCard = async (title) => {
    await openTab('Canvas');
    await visible(noteCardOf(title), `карточка заметки «${title}» на холсте`);
  };
  const retitle = async (from, value, key) => {
    await noteCardOf(from).locator('[data-canvas-note-title]').dblclick();
    await visible(titleField, 'поле названия заметки на карточке');
    await settle();
    await titleField.fill(value);
    await titleField.press(key);
    await gone(titleField, 'поле названия заметки');
  };
  await toCanvasCard(NOTE);
  await retitle(NOTE, 'Не то', 'Escape');
  await visible(noteCardOf(NOTE), 'название после отмены');
  await retitle(NOTE, '', 'Enter');
  await visible(noteCardOf(NOTE), 'название после пустого ввода');
  await retitle(NOTE, RENAMED, 'Enter');
  await visible(noteCardOf(RENAMED), 'новое название на карточке');
  await visible(board.locator('[data-canvas-note="found"]').filter({ hasText: RENAMED }), 'карточка нашла переименованную заметку');
  await page.waitForTimeout(2500);
  assert.equal(await board.locator('[data-canvas-note="missing"]').count(), 0, 'после переименования карточка потеряла заметку');
  await openTab('Notes');
  await visible(row(RENAMED), 'переименованная с холста заметка в списке');
  assert.equal(await row(NOTE).count(), 0, 'прежнее название осталось в списке');
  await row(OTHER).click();
  await visible(body.getByRole('button', { name: RENAMED, exact: true }), 'ссылка с новым названием в другой заметке');
  // Обратно тем же путём: дальше сценарий ищет заметку под прежним названием
  await toCanvasCard(RENAMED);
  await retitle(RENAMED, NOTE, 'Enter');
  await visible(noteCardOf(NOTE), 'прежнее название на карточке');
  await page.waitForTimeout(2500);
  await openTab('Notes');
  await visible(row(NOTE), 'заметка под прежним названием в списке');
  await row(OTHER).click();
  await visible(body.getByRole('button', { name: NOTE, exact: true }), 'ссылка с прежним названием');
  console.log('OK: название заметки правится на карточке: список и ссылки следуют за ним');

  // Карточка заметки, которой нет, не правится; «Изменить» предлагает её создать
  await toCanvasCard(NOTE);
  await knowledge.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: CASE }).click();
  await visible(noteCardOf(CASE), 'карточка второй заметки');
  await page.waitForTimeout(2000);
  await openTab('Notes');
  await row(CASE).click();
  await visible(knowledge.locator(`[data-note-title="${CASE}"]`), 'заметка перед удалением');
  await trashOpenNote();
  await gone(row(CASE), 'удалённая заметка в списке');
  await openTab('Canvas');
  const missingCard = board.locator('[data-canvas-note="missing"]');
  await visible(missingCard.getByText('Note not found'), 'карточка заметки, которой нет');
  assert.equal(await missingCard.locator('[data-canvas-open-note]').count(), 0, 'у карточки без заметки есть «открыть заметку»');
  await missingCard.locator('[data-canvas-note-body]').dblclick();
  await missingCard.locator('[data-canvas-note-title]').dblclick();
  await settle();
  assert.equal(await board.locator('[data-canvas-inline]').count(), 0, 'карточка заметки, которой нет, открыла правку');
  await visible(bar.locator('[data-canvas-action="edit"][title="Create note"]'), '«Создать заметку» у карточки без заметки');
  await page.keyboard.press('Delete');
  await gone(missingCard, 'карточка заметки, которой нет, после удаления');
  await page.waitForTimeout(2000);
  await openTab('Notes');
  await visible(row(NOTE), 'список заметок');
  assert.equal(await row(CASE).count(), 0, 'двойной клик по карточке создал заметку');
  await toCanvasCard(NOTE);
  console.log('OK: карточка заметки, которой нет, не правится');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-canvas.png` });
  await page.waitForTimeout(2500);
  console.log('OK: холст — текст, карточка заметки, связь');

  // ── «Файлы»: хранилище — обычная папка облака с файлами .md ───────────────
  await openTab('Files');
  await visible(cloud.getByText('Knowledge', { exact: true }), 'папка хранилища в облаке');
  console.log('OK: хранилище заметок — папка «Знания» в облаке');

  // ── Всё пережило перезагрузку ─────────────────────────────────────────────
  await page.waitForTimeout(1500);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(knowledge, 'раздел заметок после перезагрузки');
  await visible(row(NOTE), 'заметка после перезагрузки');
  assert.equal(await row(GUIDE_OVERVIEW).count(), 0, 'удалённая справка не вернулась после перезагрузки');
  assert.equal(await knowledge.locator(`[data-folder="${GUIDE_FOLDER}"]`).count(), 0, 'папка справки не вернулась после перезагрузки');
  assert.equal(await knowledge.locator('[data-notes-guide-notice]').count(), 0, 'сообщения о справке после перезагрузки нет');
  await row(NOTE).click();
  await visible(body.getByText('проверить обе GPU'), 'текст заметки после перезагрузки');
  await visible(body.getByText('Строка с холста'), 'правка заметки с холста после перезагрузки');
  await visible(note.locator('[data-note-planned]').getByText('созвон'), '«Запланировано» после перезагрузки');
  await openTab('Canvas');
  await visible(board.locator('[data-canvas-type="file"]'), 'карточка холста после перезагрузки');
  await visible(
    board.locator('[data-canvas-note="found"]').filter({ hasText: 'Строка с холста' }),
    'карточка заметки с правкой после перезагрузки',
  );
  assert.equal(await knowledge.locator('[data-canvas-edge]').count(), 2, 'связи холста после перезагрузки');
  await visible(board.locator('[data-canvas-edge] text').filter({ hasText: 'ведёт' }), 'подпись стрелки после перезагрузки');
  const serverAfter = await rectOf(groupNamed('Сервер'));
  assert.deepEqual(
    [serverAfter.width, serverAfter.height], [serverSize.width, serverSize.height], 'размер группы после перезагрузки',
  );
  await visible(groupNamed('Пара').locator('[data-canvas-group-label]'), 'группа из выделенного после перезагрузки');
  assert.equal(await cardNamed('Гамма').count(), 0, 'удалённая карточка не вернулась после перезагрузки');
  assert.equal(await chip('Canvas 2').getAttribute('aria-pressed'), 'true', 'после перезагрузки открыт первый по названию холст');
  await visible(board.locator('[data-canvas-type="text"]').getByText('Идея 2', { exact: true }), 'текст карточки после перезагрузки');
  await visible(board.locator('[data-canvas-group-label]').filter({ hasText: 'Сервер' }), 'название группы после перезагрузки');
  assert.equal(await chip('Карта проекта').count(), 0, 'удалённый холст не вернулся после перезагрузки');
  console.log('OK: заметки и холст пережили перезагрузку');

  // ── Телефон: список либо заметка, со стрелкой назад ───────────────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  await openTab('Notes');
  // Заметка осталась открытой с широкого экрана: на телефоне виден либо список, либо она
  await visible(note.getByRole('button', { name: 'Back to notes' }), 'стрелка назад на телефоне');
  assert.equal(await row(NOTE).isVisible(), false, 'на телефоне список скрыт, пока открыта заметка');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `экран шире телефона на ${overflow}px`);
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-phone.png` });
  await note.getByRole('button', { name: 'Back to notes' }).click();
  await visible(row(NOTE), 'список после возврата');
  console.log('OK: заметки на телефоне');

  // ── Телефон: выбранная точка графа — лист снизу, после закрытия граф работает ──
  await openTab('Graph');
  const phoneGraph = knowledge.locator('[data-notes-graph]');
  const phoneNode = phoneGraph.locator(`[data-node][data-title="${NOTE}"]`).locator('circle').first();
  await visible(phoneNode, 'заметка на графе телефона');
  const phoneBox = await phoneNode.boundingBox();
  await page.mouse.click(phoneBox.x + phoneBox.width / 2, phoneBox.y + phoneBox.height / 2);
  const phoneSheet = page.locator('[data-graph-panel]');
  await visible(phoneSheet.locator(`[data-note-title="${NOTE}"]`), 'заметка в листе графа на телефоне');
  await visible(page.locator('[data-graph-link-start]'), 'кнопка «Связать» в листе');
  await page.locator('[data-graph-link-start]').click();
  await visible(phoneGraph.locator('[data-graph-link-mode]'), 'режим «Связать» на телефоне');
  await phoneSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('лист заметки закрывает граф в режиме «Связать»'));
  await phoneGraph.locator('[data-graph-link-mode]').getByRole('button', { name: 'Cancel' }).click();
  await visible(phoneSheet.locator(`[data-note-title="${NOTE}"]`), 'лист после выхода из режима «Связать»');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await phoneSheet.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('лист графа не закрылся'));
  await phoneGraph.getByText('Days', { exact: true }).click();
  await visible(phoneGraph.locator('[data-node][data-kind="day"]'), 'граф после закрытия листа отвечает на нажатия');
  console.log('OK: граф на телефоне — лист заметки, режим «Связать»');

  console.log('e2e_web_notes: OK');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  if (dir) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${dir}/notes-failure.png` }).catch(() => {});
    console.log(`--- раздел при сбое ---\n${await page?.locator('#ParvaneKnowledge').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
