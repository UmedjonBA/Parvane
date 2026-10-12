// Раздел «Знания»: заметки `.md` в папке облака, ссылки и обратные ссылки, пункты-задачи в обе стороны,
// «Запланировано», поиск, граф, холст; всё переживает перезагрузку. Запуск: scripts/run_web_notes_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  relogin,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const NOTE = 'Сервер X99';
const OTHER = 'Курс ОГЭ';

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
  await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
  await visible(cloud, 'вкладка «Файлы»');
  await openTab('Notes');
  await visible(knowledge, 'раздел заметок');
  await visible(knowledge.getByText('No notes yet'), 'пустое состояние');
  console.log('OK: «Знания» открыты, «Файлы» — одна из вкладок');

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
  await note.getByRole('button', { name: 'Done', exact: true }).click();
  await visible(body.getByRole('button', { name: OTHER }), 'ссылка в тексте');
  await visible(body.getByText('#проект'), 'тег');
  assert.equal(await body.locator('input[type="checkbox"]').count(), 2, 'два пункта с галочками');
  assert.equal(await body.getByText('^t').count(), 0, 'метка пункта в чтении скрыта');
  await visible(row(NOTE).getByText('Бюджетный сервер под LLM'), 'первая строка в списке');
  console.log('OK: заметка создана, переименована, текст со ссылкой, тегом и пунктами');

  // ── Пункт со сроком стал задачей «Плана»; галочка ходит в обе стороны ─────
  await sidebar.getByRole('tab', { name: 'Today' }).click();
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
  await sidebar.getByRole('tab', { name: 'Today' }).click();
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
  await sidebar.getByRole('tab', { name: 'Today' }).click();
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
  await graph.getByText('Events and tasks', { exact: true }).click();
  await visible(graph.locator('[data-node][data-kind="record"]'), 'узел записи «Плана»');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-graph.png` });
  console.log('OK: граф — заметки, по фильтру записи «Плана»');

  // ── Холст: текст, карточка заметки, связь ─────────────────────────────────
  await openTab('Canvas');
  await knowledge.getByRole('button', { name: 'New canvas' }).click();
  const board = knowledge.locator('[data-canvas-board]');
  await visible(board, 'поле холста');
  await knowledge.getByRole('button', { name: 'Text', exact: true }).click();
  await visible(board.locator('[data-canvas-type="text"]'), 'текстовая карточка');
  await knowledge.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: NOTE }).click();
  await visible(board.locator('[data-canvas-type="file"]').getByText('Бюджетный сервер под LLM'), 'карточка заметки с началом текста');
  await knowledge.getByRole('button', { name: 'Connect' }).click();
  await board.locator('[data-canvas-type="text"]').click({ position: { x: 5, y: 5 } });
  await board.locator('[data-canvas-type="file"]').click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(() => document.querySelectorAll('[data-canvas-edge]').length === 1, undefined, {
    timeout: STEP_TIMEOUT_MS,
  }).catch(() => assert.fail('связь на холсте не создана'));
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
  await openTab('Notes');
  await visible(row(NOTE), 'заметка после перезагрузки');
  await row(NOTE).click();
  await visible(body.getByText('проверить обе GPU'), 'текст заметки после перезагрузки');
  await visible(note.locator('[data-note-planned]').getByText('созвон'), '«Запланировано» после перезагрузки');
  await openTab('Canvas');
  await visible(board.locator('[data-canvas-type="file"]'), 'карточка холста после перезагрузки');
  assert.equal(await knowledge.locator('[data-canvas-edge]').count(), 1, 'связь холста после перезагрузки');
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
