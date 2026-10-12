// Раздел «Знания»: заметки `.md` в папке облака, ссылки и обратные ссылки, пункты-задачи в обе стороны,
// «Запланировано», поиск, граф, холст; всё переживает перезагрузку. Запуск: scripts/run_web_notes_e2e.sh
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
const WELCOME = 'How to use Knowledge';

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

  // ── Новое хранилище встречает заметкой о разделе; удалённая, она не возвращается ──
  const trashOpenNote = async () => {
    await note.getByRole('button', { name: 'Move to trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click();
  };
  await visible(row(WELCOME), 'первая заметка нового хранилища');
  await visible(knowledge.locator(`[data-note-title="${WELCOME}"]`), 'первая заметка открыта сама');
  await visible(body.getByRole('button', { name: 'My first note' }), 'ссылка на заметку, которой ещё нет');
  await visible(body.getByText('#welcome'), 'тег в первой заметке');
  assert.equal(await body.locator('input[type="checkbox"]').count(), 2, 'два пункта в первой заметке');
  assert.equal(await knowledge.locator('[data-note-row]').count(), 1, 'первая заметка одна');
  await trashOpenNote();
  await visible(knowledge.getByText('No notes yet'), 'пустое состояние после удаления первой заметки');
  // Следующие обновления облака (опрос, эхо своей правки) заметку не возвращают
  await page.waitForTimeout(4000);
  assert.equal(await knowledge.locator('[data-note-row]').count(), 0, 'удалённая первая заметка не создана заново');
  await knowledge.locator('[data-notes-guide]').click();
  await visible(knowledge.locator(`[data-note-title="${WELCOME}"]`), 'заметка о разделе по кнопке');
  await trashOpenNote();
  await visible(knowledge.getByText('No notes yet'), 'пустое состояние');
  console.log('OK: первая заметка создаётся один раз, после удаления не возвращается');

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
  await graph.getByText('Events and tasks', { exact: true }).click();
  await visible(graph.locator('[data-node][data-kind="record"]'), 'узел записи «Плана»');
  if (process.env.PARVANE_E2E_SHOT_DIR) await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/notes-graph.png` });
  console.log('OK: граф — заметки, по фильтру записи «Плана»');

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
  assert.equal(await row(WELCOME).count(), 0, 'удалённая первая заметка не вернулась после перезагрузки');
  await row(NOTE).click();
  await visible(body.getByText('проверить обе GPU'), 'текст заметки после перезагрузки');
  await visible(note.locator('[data-note-planned]').getByText('созвон'), '«Запланировано» после перезагрузки');
  await openTab('Canvas');
  await visible(board.locator('[data-canvas-type="file"]'), 'карточка холста после перезагрузки');
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
