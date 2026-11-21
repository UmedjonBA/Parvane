// Граф и холст модуля «Заметки» по макету (spec 041 D2, spec 040; доски `Notes`, `XpNotes`, `XdNotes`, `DeskNotes`):
// точки, подписи и связи стоят там, где их поставил движок (NOTES-1), область графа — все / метка / вокруг
// заметки, точку можно переставить руками (место переживает перезагрузку, «Разложить заново» возвращает),
// панель выбранной заметки правит связи, «Связи» заметки — карточки с малым графом, холст из графа — уровнями,
// «Обновить из графа» есть только у него, колесо двигает поле холста. Снимки телефон/компьютер ×
// светлая/тёмная — в PARVANE_E2E_SHOT_DIR / PARVANE_E2E_BACKEND_LOG_DIR.
// Запуск: scripts/run_web_notes_graph_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, openNotesView, preparePage, reloadPage, relogin,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-notes-graph-1';
// Размеры досок макета: окно компьютера и телефон
const DESK = { width: 1120, height: 700 };
const PHONE = { width: 360, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '';
// Выдуманные заметки: маяк ссылается на причал (отдельной строкой) и склад (внутри текста), причал — на маяк
const HUB = 'Маяк у мыса';
const PIER = 'Причал';
const STORE = 'Склад снастей';
const LONE = 'Одинокая лодка';
const NEW_LINKED = 'Буй';
const GUIDE_NOTES = 12;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: DESK });
let session;

try {
  const user = `ngraph-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const note = knowledge.locator('[data-note-id]');
  const editor = page.locator('#knowledge-note-editor');
  const graph = knowledge.locator('[data-notes-graph]');
  const panel = page.locator('[data-graph-panel]');
  const board = knowledge.locator('[data-canvas-board]');
  const row = (title) => knowledge.locator(`[data-note-row="${title}"]`);
  const gnode = (title) => graph.locator(`[data-node][data-title="${title}"]`);
  const gedge = (from, to) => graph.locator(`[data-graph-edge][data-from-title="${from}"][data-to-title="${to}"]`);
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не появилось: ${what}`));
  const gone = (locator, what) => locator.first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(what));
  const count = (selector, wanted, what) => page.waitForFunction(
    ([query, number]) => document.querySelectorAll(query).length === number, [selector, wanted],
    { timeout: STEP_TIMEOUT_MS },
  ).catch(async () => assert.fail(`${what}: ${await page.locator(selector).count()} вместо ${wanted}`));
  // Компьютер: «Граф» — кнопка шапки, «Холсты» — колонка (`ZdNotesX`); телефон — вкладки (общий помощник)
  const openTab = (name) => openNotesView(knowledge, name);
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/d2-${name}.png` }).catch(() => undefined);
  };
  // Снимок в светлой и тёмной теме: клиент следует теме системы
  const shotBoth = async (name) => {
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(`${name}-${scheme}`);
    }
    await page.emulateMedia({ colorScheme: 'light' });
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
  const createNote = async (title, text) => {
    await sidebar.locator('[data-add-for="notes"]').click();
    await visible(knowledge.locator('[data-note-title="New note"]'), `новая заметка для «${title}»`);
    // Поле названия подхватывает название открытой заметки эффектом — набор раньше него был бы стёрт
    await page.waitForTimeout(400);
    await note.getByLabel('Note title').fill(title);
    await note.getByLabel('Note title').blur();
    await visible(row(title), `строка заметки «${title}»`);
    if (!text) return;
    await note.locator('[data-note-bar]').getByRole('button', { name: 'Edit', exact: true }).click();
    await visible(editor, 'редактор');
    await fillEditor(text);
    await note.getByRole('button', { name: 'Save' }).first().click();
    await editor.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('правка не сохранилась'));
  };
  // Точка — её кружок; место берётся, когда оно устоялось (граф вписывается после смены того, что показано)
  const centreOf = async (title) => {
    const circle = gnode(title).locator('[data-graph-dot]');
    await circle.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    let box = await circle.boundingBox();
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(150);
      const next = await circle.boundingBox();
      const isStill = box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5;
      box = next;
      if (isStill) break;
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const clickNode = async (title) => {
    const at = await centreOf(title);
    await page.mouse.click(at.x, at.y);
  };
  const graphBusyDone = () => page.waitForFunction(
    () => !document.querySelector('#ParvaneKnowledge [data-notes-graph]')?.hasAttribute('data-graph-busy'),
    undefined, { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('раскладка графа не закончилась'));
  await page.emulateMedia({ colorScheme: 'light' });

  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await visible(knowledge, 'модуль «Заметки»');
  await visible(row('Overview'), 'справка нового хранилища');
  await createNote(STORE, 'Сети и канаты. #порт/склад\n');
  await createNote(PIER, `Отсюда виден [[${HUB}]] в ясную погоду. #порт\n`);
  await createNote(HUB, `Светит всю ночь, рядом лежит [[${STORE}]] под навесом.\n\n[[${PIER}]]\n`);
  await createNote(LONE, 'Ни с чем не связана.\n');

  // ── «Связи» заметки: малый граф от движка и карточки ─────────────────────
  await row(HUB).click();
  await visible(knowledge.locator(`[data-note-title="${HUB}"]`), 'заметка-узел открыта');
  const links = knowledge.locator('[data-note-links]');
  await visible(links, '«Связи» заметки');
  assert.equal(await links.getAttribute('data-note-links'), '2', 'у заметки не две связи');
  await visible(links.locator(`[data-link-way="both"][data-title="${PIER}"]`), 'взаимная связь карточкой');
  await visible(links.locator(`[data-link-way="out"][data-title="${STORE}"]`), 'упомянутая заметка карточкой');
  const mini = links.locator('[data-note-graph]');
  await visible(mini, 'малый граф «Связей»');
  assert.equal(await mini.getAttribute('data-note-graph'), '3', 'на малом графе не заметка и две соседки');
  const miniBoxes = await mini.locator('circle').evaluateAll((dots) => dots.map((dot) => {
    const box = dot.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2, box.width / 2];
  }));
  miniBoxes.forEach((a, i) => miniBoxes.slice(i + 1).forEach((b) => {
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= a[2] + b[2], 'точки малого графа накладываются');
  }));
  await shotBoth('desk-links');
  // Точка малого графа и карточка открывают заметку
  await mini.locator(`[data-title="${PIER}"] circle`).click();
  await visible(knowledge.locator(`[data-note-title="${PIER}"]`), 'заметка по точке малого графа');
  await visible(knowledge.locator(`[data-note-links] [data-link-way="both"][data-title="${HUB}"]`), 'обратная связь карточкой');
  await knowledge.locator(`[data-note-links] button[data-title="${HUB}"]`).click();
  await visible(knowledge.locator(`[data-note-title="${HUB}"]`), 'заметка по карточке связи');
  console.log('OK: «Связи» заметки — карточки и малый граф от движка, точка и карточка открывают заметку');

  // ── Граф: точки и подписи стоят по раскладке движка ──────────────────────
  await openTab('Graph');
  await visible(graph, 'граф');
  await graphBusyDone();
  const NOTES_ON_GRAPH = '#ParvaneKnowledge [data-notes-graph] [data-node][data-kind="note"]';
  await count(NOTES_ON_GRAPH, GUIDE_NOTES + 4, 'на графе не все заметки');
  await visible(gedge(HUB, STORE), 'связь маяк → склад');
  assert.equal(await graph.locator(`[data-graph-edge][data-mutual="true"]`).filter({ has: page.locator('path') }).count() >= 1, true, 'взаимная связь не отмечена');
  await centreOf(HUB);
  const circles = await graph.locator('[data-graph-dot]').evaluateAll((dots) => dots.map((dot) => {
    const box = dot.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2, box.width / 2];
  }));
  circles.forEach((a, i) => circles.slice(i + 1).forEach((b) => {
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= a[2] + b[2] - 1, 'кружки графа накладываются');
  }));
  // Граф вписан: все кружки внутри поля
  const field = await graph.boundingBox();
  circles.forEach(([x, y]) => assert.ok(
    x >= field.x && x <= field.x + field.width && y >= field.y && y <= field.y + field.height, 'точка за краем поля после вписывания',
  ));
  assert.ok(await graph.locator('[data-graph-label="shown"]').count() >= 4, 'подписей на графе почти нет');
  // Наконечник стрелки — у каждой связи
  const headless = await graph.locator('[data-graph-edge]').evaluateAll((edges) => (
    edges.filter((edge) => !edge.querySelector('[data-edge-head]')).length
  ));
  assert.equal(headless, 0, 'у связей нет наконечников');
  await shotBoth('desk-graph');
  console.log('OK: граф — точки без наложений, подписи, наконечники, вписан в поле');

  // ── Область графа: метка с вложенными, скрытие одиночных ─────────────────
  const scopeChip = graph.locator('[data-graph-scope]');
  const scopeMenu = graph.locator('[data-graph-scope-menu]');
  await scopeChip.click();
  await visible(scopeMenu.locator('[data-graph-scope-tag="порт"]'), 'метка в списке областей');
  await shot('desk-graph-scope-light');
  await scopeMenu.locator('[data-graph-scope-tag="порт"]').click();
  await count(NOTES_ON_GRAPH, 2, 'по метке с вложенными — не две заметки');
  await visible(gnode(PIER), 'заметка с меткой');
  await visible(gnode(STORE), 'заметка с вложенной меткой');
  assert.equal(await scopeChip.getAttribute('data-graph-scope'), 'tag', 'чип не показывает метку');
  await scopeChip.click();
  await scopeMenu.locator('[data-graph-scope-all]').click();
  await count(NOTES_ON_GRAPH, GUIDE_NOTES + 4, '«Все заметки» не вернули заметки');
  await scopeChip.click();
  await scopeMenu.locator('[data-graph-hide-orphans]').click();
  await gone(gnode(LONE), 'одиночная заметка не скрыта');
  await count(NOTES_ON_GRAPH, GUIDE_NOTES + 3, 'скрытие одиночных убрало не одну заметку');
  await scopeMenu.locator('[data-graph-hide-orphans]').click();
  await visible(gnode(LONE), 'одиночная заметка после снятия скрытия');
  await page.keyboard.press('Escape');
  await gone(scopeMenu, 'Escape не закрыл список областей');
  console.log('OK: область графа — метка с вложенными, скрытие одиночных');

  // ── Ручная расстановка: место точки запоминается, «Вписать» её не трогает, «Разложить заново» возвращает ──
  await graphBusyDone();
  const before = await centreOf(LONE);
  const anchorBefore = await centreOf(HUB);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 40, before.y - 30, { steps: 4 });
  await page.mouse.move(before.x + 90, before.y - 70, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#ParvaneKnowledge [data-notes-graph]').dataset.graphPlaced === '1',
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('место переставленной точки не запомнено'));
  const moved = await centreOf(LONE);
  assert.ok(Math.abs(moved.x - before.x - 90) < 3 && Math.abs(moved.y - before.y + 70) < 3, `точка встала не туда: ${JSON.stringify([before, moved])}`);
  const anchorAfter = await centreOf(HUB);
  assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1 && Math.abs(anchorAfter.y - anchorBefore.y) < 1, 'перестановка одной точки сдвинула другую');
  // Расстояние между точками в единицах поля от вида не зависит: по нему сверяется место после перезагрузки
  const apartOf = async () => {
    const scale = Number(await graph.getAttribute('data-graph-scale'));
    const a = await centreOf(LONE);
    const b = await centreOf(HUB);
    return [Math.round((a.x - b.x) / scale), Math.round((a.y - b.y) / scale)];
  };
  const apart = await apartOf();
  await graph.locator('[data-graph-fit]').click();
  assert.equal(await graph.getAttribute('data-graph-placed'), '1', '«Вписать» стёрло ручную расстановку');
  await page.waitForTimeout(1500);
  await reloadPage(page);
  await relogin(page, PASSWORD).catch(() => undefined);
  await sidebar.waitFor({ state: 'visible', timeout: 60000 });
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await openTab('Graph');
  await visible(gnode(LONE), 'граф после перезагрузки');
  await graphBusyDone();
  assert.equal(await graph.getAttribute('data-graph-placed'), '1', 'ручная расстановка не пережила перезагрузку');
  const apartReloaded = await apartOf();
  assert.ok(Math.abs(apartReloaded[0] - apart[0]) <= 2 && Math.abs(apartReloaded[1] - apart[1]) <= 2,
    `после перезагрузки точка стоит иначе: ${apart} → ${apartReloaded}`);
  await graph.locator('[data-graph-relayout]').click();
  await page.waitForFunction(() => document.querySelector('#ParvaneKnowledge [data-notes-graph]').dataset.graphPlaced === '0',
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«Разложить заново» не сняло ручную расстановку'));
  const apartReset = await apartOf();
  assert.ok(Math.abs(apartReset[0] - apart[0]) > 20 || Math.abs(apartReset[1] - apart[1]) > 20, 'точка не вернулась на место раскладки');
  assert.equal(await graph.locator('[data-graph-relayout]').isDisabled(), true, '«Разложить заново» доступно без ручной расстановки');
  console.log('OK: ручная расстановка — место запомнено, пережило перезагрузку, «Вписать» отдельно от «Разложить заново»');

  // ── Связь ведут настоящей мышью от кольца вокруг заметки ────────────────
  const ringOf = async (title) => {
    const at = await centreOf(title);
    await page.mouse.move(at.x, at.y);
    const radius = Number(await gnode(title).locator('[data-graph-handle]').getAttribute('r'));
    const scale = Number(await graph.getAttribute('data-graph-scale'));
    return { x: at.x, y: at.y - (radius - 1) * scale };
  };
  const ring = await ringOf(STORE);
  const target = await centreOf(LONE);
  await page.mouse.move(ring.x, ring.y);
  await page.mouse.down();
  await page.mouse.move((ring.x + target.x) / 2, (ring.y + target.y) / 2, { steps: 5 });
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await graph.locator('[data-graph-draft]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS }).catch(async () => {
    const state = await graph.evaluate((element) => ({
      classes: element.className, world: element.firstElementChild.getAttribute('style'), picked: element.dataset.graphPicked,
      drafts: element.querySelectorAll('line').length,
    }));
    assert.fail(`линия связи под указателем не появилась: ${JSON.stringify(state)}`);
  });
  await page.mouse.up();
  await visible(gedge(STORE, LONE), 'связь, проведённая мышью');
  await visible(knowledge.locator('[data-graph-notice]').getByText('Link added'), 'сообщение о новой связи');
  await knowledge.locator('[data-graph-undo]').click();
  await gone(gedge(STORE, LONE), 'отмена не убрала проведённую связь');
  console.log('OK: связь ведётся мышью от кольца заметки, «Отменить» её снимает');

  // ── Панель выбранной заметки: связи карточкой, «Убрать связь», «Связать с заметкой» ──
  await clickNode(HUB);
  const panelLinks = panel.locator('[data-graph-panel-links]');
  await visible(panelLinks, 'связи в панели графа');
  await visible(panel.locator('[data-graph-panel-open]'), '«Открыть в заметках»');
  await visible(panelLinks.locator(`[data-graph-panel-unlink="${PIER}"]`), '«Убрать связь» у ссылки отдельной строкой');
  assert.equal(await panelLinks.locator(`[data-graph-panel-unlink="${STORE}"]`).count(), 0, 'у ссылки внутри текста есть «Убрать связь»');
  await visible(panelLinks.locator('[data-link-way="out"]').filter({ hasText: 'from the text' }), 'пометка «из текста»');
  await shotBoth('desk-graph-panel');
  await panelLinks.locator(`[data-graph-panel-unlink="${PIER}"]`).click();
  await gone(panelLinks.locator(`[data-graph-panel-unlink="${PIER}"]`), 'связь не убрана из панели');
  // Причал по-прежнему ссылается на маяк: связь осталась, но уже в одну сторону
  await visible(gedge(PIER, HUB), 'обратная ссылка после снятия прямой');
  await visible(panelLinks.locator(`[data-link-way="in"]`).filter({ hasText: PIER }), 'связь стала входящей');
  // «Связать с заметкой»: существующая заметка и новая
  await panelLinks.locator('[data-graph-panel-link-input]').fill(LONE);
  await panelLinks.locator('[data-graph-panel-link-input]').press('Enter');
  await visible(gedge(HUB, LONE), 'связь с существующей заметкой из поля панели');
  await panelLinks.locator('[data-graph-panel-link-input]').fill(NEW_LINKED);
  await panelLinks.locator('[data-graph-panel-link-input]').press('Enter');
  await visible(gnode(NEW_LINKED), 'новая заметка из поля панели');
  await visible(gedge(HUB, NEW_LINKED), 'связь с новой заметкой');
  assert.equal(await gnode(NEW_LINKED).getAttribute('data-kind'), 'note', 'новая заметка — не настоящая');
  // Область «вокруг заметки» из панели: маяк и его соседи
  await scopeChip.click();
  await scopeMenu.locator('[data-graph-scope-around]').click();
  await count(NOTES_ON_GRAPH, 5, 'вокруг маяка на один шаг — не пять заметок');
  await scopeMenu.locator('[data-graph-scope-all]').click();
  console.log('OK: панель графа — связи карточкой, «Убрать связь», «Связать с заметкой», область вокруг заметки');

  // ── Холст из графа: уровнями, «Обновить из графа» только у него ───────────
  // Пока фокус в поле панели, Escape — дело поля: панель закрывает её крестик
  await panel.locator('[data-graph-panel-close]').click();
  await gone(panel, 'панель графа не закрылась');
  await scopeChip.click();
  await scopeMenu.locator('[data-graph-hide-orphans]').click();
  await page.keyboard.press('Escape');
  await graph.locator('[data-graph-to-canvas]').click();
  await visible(board, 'холст, созданный с графа');
  const FILE_CARDS = '#ParvaneKnowledge [data-canvas-node][data-canvas-type="file"]';
  // Без одиночных: справка (12) и пять связанных заметок
  await count(FILE_CARDS, GUIDE_NOTES + 5, 'на холсте из графа не все связанные заметки');
  const cards = await board.locator('[data-canvas-type="file"]').evaluateAll((nodes) => nodes.map((node) => (
    [parseFloat(node.style.left), parseFloat(node.style.top), parseFloat(node.style.width), parseFloat(node.style.height)]
  )));
  cards.forEach((a, i) => cards.slice(i + 1).forEach((b) => {
    assert.ok(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1], 'карточки холста из графа накладываются');
  }));
  assert.ok(cards.every(([x, y]) => x % 10 === 0 && y % 10 === 0), 'карточки холста стоят не по сетке');
  assert.ok(new Set(cards.map(([, y]) => y)).size >= 2, 'холст из графа не разложен уровнями');
  await visible(knowledge.locator('[data-canvas-refresh]'), '«Обновить из графа» у холста из графа');
  await knowledge.locator('[data-canvas-refresh]').click();
  await visible(page.getByText('Nothing to update'), 'обновление без новых заметок');
  await shotBoth('desk-canvas-graph');

  // Колесо двигает поле, Ctrl + колесо меняет масштаб
  const world = knowledge.locator('[data-canvas-world]');
  const zoomChip = knowledge.locator('[data-canvas-zoom]');
  const viewOf = async () => {
    const [x, y, scale] = (await world.getAttribute('style')).match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/).slice(1).map(Number);
    return { x, y, scale };
  };
  const boardBox = await board.boundingBox();
  await page.mouse.move(boardBox.x + boardBox.width / 2, boardBox.y + boardBox.height / 2);
  const viewBefore = await viewOf();
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(400);
  const viewPanned = await viewOf();
  assert.ok(Math.abs(viewPanned.y - viewBefore.y + 120) < 1 && viewPanned.scale === viewBefore.scale, `колесо не сдвинуло поле: ${JSON.stringify([viewBefore, viewPanned])}`);
  await page.mouse.wheel(60, 0);
  await page.waitForTimeout(400);
  assert.ok(Math.abs((await viewOf()).x - viewPanned.x + 60) < 1, 'колесо вбок не сдвинуло поле');
  const zoomBefore = await zoomChip.innerText();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForFunction((text) => document.querySelector('#ParvaneKnowledge [data-canvas-zoom]').textContent !== text,
    zoomBefore, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('Ctrl + колесо не изменило масштаб'));
  assert.ok((await viewOf()).scale > viewPanned.scale, 'Ctrl + колесо вверх не приблизило');
  assert.match(await zoomChip.innerText(), /^\d+% · /, 'масштаб холста не показан процентами');

  // Холст, сделанный руками: подсказка пустого поля, «Обновить из графа» нет. Новый холст — из списка холстов
  await knowledge.locator('[data-canvas-back]').click();
  await visible(knowledge.locator('[data-canvas-list] [data-canvas-tile]'), 'список холстов строками');
  await shotBoth('desk-canvas-list');
  await knowledge.getByRole('button', { name: 'New canvas' }).click();
  await visible(knowledge.locator('[data-canvas-blank]'), 'подсказка пустого холста');
  assert.equal(await knowledge.locator('[data-canvas-refresh]').count(), 0, '«Обновить из графа» стоит на холсте, сделанном руками');
  await visible(knowledge.locator('[data-canvas-tool="text"]').getByText('Text'), 'подпись у кнопки инструмента');
  await shotBoth('desk-canvas-blank');
  await knowledge.locator('[data-canvas-tool="text"]').click();
  await gone(knowledge.locator('[data-canvas-blank]'), 'подсказка осталась на холсте с карточкой');
  await page.keyboard.press('Escape');
  console.log('OK: холст — из графа уровнями по сетке, «Обновить» только у него, колесо двигает поле, подсказка пустого холста');

  // ── Холст по макету: перетаскивание заметок, панель выделенного, стрелка, перецепление, мини-карта, картинка ──
  const noteCard = (title) => board.locator('[data-canvas-type="file"]')
    .filter({ has: page.locator('[data-canvas-note-head]').getByText(title, { exact: true }) });
  const sidePanel = knowledge.locator('[data-canvas-selection-bar]');
  const boardBox2 = await board.boundingBox();
  // Ссылки на заметки, брошенные на поле, — карточки этих заметок
  const dropText = (text, x, y) => board.evaluate((element, [value, px, py]) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', value);
    const box = element.getBoundingClientRect();
    const init = {
      dataTransfer: transfer, clientX: box.left + px, clientY: box.top + py, bubbles: true, cancelable: true,
    };
    element.dispatchEvent(new DragEvent('dragover', init));
    element.dispatchEvent(new DragEvent('drop', init));
  }, [text, x, y]);
  await dropText(`[[${HUB}]]\n[[${PIER}]]`, boardBox2.width * 0.15, boardBox2.height * 0.2);
  await visible(noteCard(HUB), 'карточка заметки, брошенной на холст');
  await visible(noteCard(PIER), 'вторая брошенная заметка — карточкой ниже');
  await dropText(`[[${STORE}]]`, boardBox2.width * 0.55, boardBox2.height * 0.2);
  await visible(noteCard(STORE), 'третья брошенная заметка');
  // Панель выделенного сбоку поля: «Выделено: 1», «Связать стрелкой» — от карточки к следующей нажатой
  await noteCard(HUB).click({ position: { x: 20, y: 10 } });
  await visible(sidePanel.getByText('Selected: 1'), 'панель выделенного');
  // Кружки цвета подписаны названиями (доска `XdNotes`), карточка заметки — «заметка · #метка» (доска `XpNotes`)
  await visible(sidePanel.locator('[aria-label="Color: Turquoise"]'), 'кружок цвета с названием');
  await visible(sidePanel.locator('[aria-label="Color: No color"]'), 'кружок «без цвета» с названием');
  assert.equal(await noteCard(HUB).locator('[data-canvas-note-kind]').innerText(), 'note', 'подпись карточки без метки');
  assert.equal(await noteCard(STORE).locator('[data-canvas-note-kind]').innerText(), 'note · #порт/склад', 'подпись карточки с меткой');
  assert.equal(await knowledge.locator('[data-canvas-head-sub]').innerText(), 'canvas · selected: 1', 'подзаголовок шапки при выделенной карточке');
  await visible(knowledge.locator('[data-canvas-minimap] [data-canvas-minimap-view]'), 'мини-карта с видимой частью');
  await shotBoth('desk-canvas-panel');
  await sidePanel.locator('[data-canvas-action="connect"]').click();
  await noteCard(PIER).click({ position: { x: 20, y: 10 } });
  await count('#ParvaneKnowledge [data-canvas-edge]', 1, 'стрелка «Связать стрелкой» не появилась');
  // Стрелка выбирается нажатием по линии — панель стрелки
  const edgePoint = await board.locator('[data-canvas-edge] path').first().evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
  await page.mouse.click(edgePoint.x, edgePoint.y);
  const edgePanel = knowledge.locator('[data-canvas-edge-panel]');
  await visible(edgePanel, 'панель стрелки');
  assert.equal(await edgePanel.locator('[data-canvas-edge-from]').innerText(), HUB, 'начало стрелки в панели');
  assert.equal(await edgePanel.locator('[data-canvas-edge-to]').innerText(), PIER, 'конец стрелки в панели');
  // Выбранная стрелка (доска `ZdNotesX`): подзаголовок шапки, подсказка у поля, «Карточка · Стрелка · Готово»
  assert.equal(await knowledge.locator('[data-canvas-head-sub]').innerText(), 'canvas · arrow selected', 'подзаголовок «выбрана стрелка»');
  await visible(knowledge.locator('[data-canvas-edge-hint]').getByText('Double-click an arrow'), 'подсказка выбранной стрелки');
  await knowledge.locator('[data-canvas-panel="card"]').click();
  await visible(sidePanel.getByText('Selected: 1'), '«Карточка» — панель карточки стрелки');
  await gone(knowledge.locator('[data-canvas-edge-hint]'), 'подсказка стрелки осталась при выбранной карточке');
  await knowledge.locator('[data-canvas-panel="edge"]').click();
  await visible(edgePanel, '«Стрелка» — снова панель стрелки');
  await edgePanel.locator('[data-canvas-edge-label]').fill('ведёт к');
  await edgePanel.locator('[data-canvas-edge-label]').press('Enter');
  await visible(board.locator('[data-canvas-edge] text').filter({ hasText: 'ведёт к' }), 'подпись стрелки из панели');
  await edgePanel.locator('[data-direction="both"]').click();
  await page.waitForFunction(() => document.querySelector('#ParvaneKnowledge [data-canvas-edge]')?.dataset.canvasEnds === 'arrow-arrow',
    undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«↔» не поставило стрелки на оба конца'));
  await edgePanel.locator('[data-line="dashed"]').click();
  await page.waitForFunction(() => {
    const lines = document.querySelectorAll('#ParvaneKnowledge [data-canvas-edge] path');
    return Array.from(lines).some((line) => getComputedStyle(line).strokeDasharray !== 'none');
  }, undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«Пунктир» не сделал линию пунктирной'));
  await shotBoth('desk-canvas-edge');
  await edgePanel.locator('[data-canvas-action="swap"]').click();
  await page.waitForFunction((title) => document.querySelector('#ParvaneKnowledge [data-canvas-edge-from]')?.textContent === title,
    PIER, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«Поменять концы» не поменяло начало и конец'));
  // Конец стрелки перецепляется на другую карточку: ручку конца тянут на неё
  const endHandle = board.locator('[data-canvas-edge-end="to"]');
  await visible(endHandle, 'ручка конца выбранной стрелки');
  const handleBox = await endHandle.boundingBox();
  const storeBox = await noteCard(STORE).boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(storeBox.x + storeBox.width / 2, storeBox.y + storeBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((title) => document.querySelector('#ParvaneKnowledge [data-canvas-edge-to]')?.textContent === title,
    STORE, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('конец стрелки не перецепился на другую карточку'));
  // Две выделенные карточки (доска `XdNotes`): «Связать стрелкой» сразу ставит стрелку между ними, «По верху»
  // выравнивает, «Распределить» действует от трёх; «Готово» в шапке снимает выделение
  const edgesBefore = await board.locator('[data-canvas-edge]').count();
  await noteCard(HUB).click({ position: { x: 20, y: 10 } });
  await noteCard(STORE).click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
  await visible(sidePanel.getByText('Selected: 2'), 'панель двух выделенных');
  assert.equal(await sidePanel.locator('[data-canvas-action="distribute"]').isDisabled(), true, '«Распределить» действует при двух');
  await sidePanel.locator('[data-canvas-action="connect"]').click();
  await count('#ParvaneKnowledge [data-canvas-edge]', edgesBefore + 1, '«Связать стрелкой» при двух выделенных не поставило стрелку');
  await sidePanel.locator('[data-canvas-align="top"]').click();
  await page.waitForFunction(([a, b]) => {
    const tops = [a, b].map((title) => Array.from(document.querySelectorAll('#ParvaneKnowledge [data-canvas-type="file"]'))
      .find((card) => card.querySelector('[data-canvas-note-title]')?.textContent === title)?.style.top);
    return tops[0] && tops[0] === tops[1];
  }, [HUB, STORE], { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('«По верху» не выровняло карточки'));
  await noteCard(PIER).click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
  await visible(sidePanel.getByText('Selected: 3'), 'панель трёх выделенных');
  assert.equal(await sidePanel.locator('[data-canvas-action="distribute"]').isDisabled(), false, '«Распределить» не действует при трёх');
  await sidePanel.locator('[data-canvas-action="distribute"]').click();
  await knowledge.locator('[data-canvas-done]').click();
  await gone(sidePanel, '«Готово» не сняло выделение');
  assert.equal(await knowledge.locator('[data-canvas-head-sub]').innerText(), 'canvas', 'подзаголовок шапки без выделения');
  // Картинка из буфера обмена — файлом в облако и карточкой на холсте
  const filesBefore = await board.locator('[data-canvas-type="file"]').count();
  await page.mouse.move(boardBox2.x + boardBox2.width * 0.3, boardBox2.y + boardBox2.height * 0.7);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'buoy.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await count('#ParvaneKnowledge [data-canvas-node][data-canvas-type="file"]', filesBefore + 1, 'вставленная картинка не встала карточкой');
  await visible(board.locator('[data-canvas-type="file"]').filter({ hasText: 'buoy' }), 'карточка вставленной картинки');
  console.log('OK: холст по макету — заметки перетаскиванием, панель выделенного и стрелки, перецепление, мини-карта, картинка из буфера');

  // ── Список холстов (доски `RpNotes`, `ZdNotesX`): поиск по холстам, «···» у строки, дата днём ──
  // Холст из графа уже был — новый получил номер 2
  const MANUAL = 'Canvas 2';
  const RENAMED = 'Причалы и маяки';
  const GRAPH_CANVAS = 'Link graph';
  const canvasRow = (title) => knowledge.locator(`[data-canvas-list] [data-canvas-tile="${title}"]`);
  await knowledge.locator('[data-canvas-back]').click();
  await visible(canvasRow(MANUAL), 'строка холста, сделанного руками');
  await visible(canvasRow(GRAPH_CANVAS), 'строка холста из графа');
  await visible(canvasRow(MANUAL).getByText('today', { exact: true }), 'дата правки холста — «сегодня»');
  await visible(knowledge.locator('[data-canvas-from-graph]').getByText('Build canvas from graph'), '«Собрать холст из графа»');
  // Поиск ищет и по карточкам холста: «buoy» есть только на холсте, сделанном руками
  const canvasSearch = knowledge.locator('[data-section-search]');
  if (!(await canvasSearch.isVisible())) await knowledge.locator('[data-section-search-open]').click();
  await canvasSearch.fill('buoy');
  await gone(canvasRow(GRAPH_CANVAS), 'поиск по холстам не скрыл холст без находки');
  await visible(canvasRow(MANUAL), 'поиск по карточке не нашёл холст');
  await canvasSearch.fill('нет такого');
  await visible(knowledge.locator('[data-canvas-nothing-found]'), '«Холстов по запросу нет»');
  await canvasSearch.fill('');
  await visible(canvasRow(GRAPH_CANVAS), 'очищенный поиск не вернул холсты');
  // «···» у строки: переименовать и в корзину — без открытия холста
  await canvasRow(MANUAL).locator('[data-canvas-row-more]').click();
  await page.locator('[data-canvas-row-menu] [data-canvas-row-rename]').click();
  await page.locator('#knowledge-canvas-name').fill(RENAMED);
  await page.locator('[data-canvas-rename]').click();
  await visible(canvasRow(RENAMED), 'холст переименован из меню строки');
  await canvasRow(GRAPH_CANVAS).locator('[data-canvas-row-more]').click();
  await page.locator('[data-canvas-row-menu] [data-canvas-row-delete]').click();
  await page.locator('.Modal').getByRole('button', { name: 'Move to trash', exact: true }).click();
  await gone(canvasRow(GRAPH_CANVAS), 'холст из графа не ушёл в корзину из меню строки');
  await canvasRow(RENAMED).locator('[data-canvas-id]').first().click();
  await visible(board, 'холст открыт снова после переименования');
  console.log('OK: список холстов — поиск по карточкам, «···» с переименованием и корзиной, дата днём');

  // ── Телефон ───────────────────────────────────────────────────────────────
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(800);
  // Открытый холст на телефоне: инструменты нижней панелью вместо ленты модулей; «назад» — к плиткам холстов
  await visible(knowledge.locator('[data-canvas-bottom-tools] [data-canvas-tool="text"]'), 'инструменты внизу холста');
  // Шапки модуля над холстом нет — холст во весь экран; поиск по холсту открывается из меню холста
  assert.equal(await knowledge.locator('[data-section-search-open], [data-section-search]').count(), 0, 'шапка модуля осталась над холстом телефона');
  // Масштаб на телефоне — только процент, кнопок масштаба нет; нижняя панель листается, а не ломает экран
  assert.match(await zoomChip.innerText(), /^\d+%$/, 'на телефоне в чипе масштаба не только процент');
  assert.equal(await board.getByRole('button', { name: 'Zoom in' }).count(), 0, 'кнопки масштаба на холсте телефона');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1, 'холст телефона шире экрана');
  // Полоса выделенного (доска `XpNotes`): «N шт.», цвет, «Связать стрелкой», «На передний план», «Дублировать»,
  // «Удалить с холста», «Ещё»; «Выровнять» — от двух
  await noteCard(HUB).click({ position: { x: 20, y: 10 } });
  const phoneBar = board.locator('[data-canvas-selection-bar]');
  await visible(phoneBar.locator('[data-canvas-selection-count]').getByText('1 sel.'), 'счётчик полосы выделенного');
  const barActions = await phoneBar.locator('[data-canvas-action]').evaluateAll((buttons) => buttons.map((button) => button.dataset.canvasAction));
  assert.deepEqual(barActions, ['color', 'connect', 'front', 'duplicate', 'remove', 'more'], `состав полосы телефона: ${barActions}`);
  assert.equal(await phoneBar.locator('[data-canvas-action="remove"]').getAttribute('aria-label'), 'Delete from canvas', 'подпись удаления на телефоне');
  await noteCard(PIER).click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
  await visible(phoneBar.locator('[data-canvas-action="align"]'), '«Выровнять» при двух выделенных');
  await phoneBar.locator('[data-canvas-action="align"]').click();
  await visible(board.locator('[data-canvas-context] [data-canvas-align="top"]'), 'выравнивание из «Выровнять»');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await gone(phoneBar, 'полоса выделенного не ушла по Escape');
  await shotBoth('phone-canvas');
  await knowledge.locator('[data-canvas-menu]').click();
  await page.locator('[data-canvas-search]').click();
  const phoneCanvasSearch = knowledge.locator('[data-canvas-search-row] [data-section-search]');
  await visible(phoneCanvasSearch, 'строка поиска по холсту на телефоне');
  await phoneCanvasSearch.fill('buoy');
  await visible(board.locator('[data-search="found"]').filter({ hasText: 'buoy' }), 'поиск на телефоне подсветил карточку');
  await page.evaluate(() => window.history.back());
  await knowledge.locator('[data-canvas-search-row]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('«назад» не закрыло поиск по холсту'));
  await visible(knowledge.locator('[data-canvas-bottom-tools] [data-canvas-tool="text"]'), 'холст после закрытия поиска');
  // Запись раздела в истории ставится заново следующей отрисовкой — второе «назад» не раньше неё
  await page.waitForTimeout(400);
  await page.evaluate(() => window.history.back());
  await visible(knowledge.locator('[data-canvas-list] [data-canvas-new]'), '«назад» с холста — к плиткам холстов');
  // Плитка телефона — «N карточек · сегодня», без стрелок (доска `RpNotes`)
  assert.match(await canvasRow(RENAMED).innerText(), /\d+ cards? · today$/, 'подпись плитки телефона');
  await shotBoth('phone-canvas-list');
  await openTab('Graph');
  await visible(graph, 'граф на телефоне');
  await graphBusyDone();
  await centreOf(HUB);
  const zoomButton = await graph.getByRole('button', { name: 'Zoom in' }).boundingBox();
  assert.ok(zoomButton.width >= 44 && zoomButton.height >= 44, `цель нажатия кнопки масштаба ${zoomButton.width}×${zoomButton.height}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `экран шире телефона на ${overflow}px`);
  await visible(graph.getByRole('button', { name: 'Fit to screen' }), '«Вписать в экран» на телефоне');
  // «Холст из графа» на телефоне — широкой кнопкой внизу поля, не чипом в строке сверху (доска `XpNotes`)
  assert.equal(await graph.locator('[data-graph-tool-row] [data-graph-to-canvas]').count(), 0, 'чип «Холст из графа» в строке сверху');
  await visible(graph.locator('[data-graph-to-canvas]').getByText('Canvas from graph'), 'широкая «Холст из графа»');
  await shotBoth('phone-graph');
  // Нажатая линия на телефоне — строка «выбрана связь с …» и «Убрать» (доска `XpNotes`)
  const lonePath = gedge(HUB, LONE).locator('[data-edge-line]').last();
  const loneMid = await lonePath.evaluate((path) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f };
  });
  await page.mouse.click(loneMid.x, loneMid.y);
  const edgeStrip = graph.locator('[data-graph-edge-picked]');
  await visible(edgeStrip.getByText(`link with “${LONE}” selected`), 'строка выбранной связи на телефоне');
  await shotBoth('phone-graph-edge');
  await edgeStrip.getByRole('button', { name: 'Remove', exact: true }).click();
  await gone(gedge(HUB, LONE), '«Убрать» не убрало связь на телефоне');
  // Выбранная точка — лист снизу со связями
  for (let attempt = 0; attempt < 4; attempt++) {
    await clickNode(HUB);
    const isOpen = await panel.locator('[data-graph-panel-links]')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    if (isOpen) break;
    await page.waitForTimeout(600);
  }
  await visible(panel.locator('[data-graph-panel-links]'), 'связи в листе графа на телефоне');
  await shotBoth('phone-graph-sheet');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
  await panel.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('лист графа не закрылся'));
  console.log('OK: телефон — граф с кнопками масштаба, лист выбранной заметки со связями');

  console.log('e2e_web_notes_graph: OK');
} catch (error) {
  if (SHOT_DIR) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${SHOT_DIR}/notes-graph-failure.png` }).catch(() => {});
    console.log(`--- раздел при сбое ---\n${await page?.locator('#ParvaneKnowledge').innerText().catch(() => '')}`);
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
