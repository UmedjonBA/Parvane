// Замеры производительности web-клиента на собранном dist (не проверка, а измерение):
// старт и перезагрузка, переключение разделов, открытие окон, набор текста, граф и холст,
// простой (трафик WebSocket), всё то же при замедлении CPU ×4 («как на телефоне»).
// Итог — таблица в stdout и JSON в PARVANE_E2E_SHOT_DIR (или в каталог журналов стенда).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  openPlannerScreen,
  openSavedMessages,
  preparePage,
  reloadPage,
  sendText,
  waitForChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-perf-e2e-1';
const STEP_TIMEOUT_MS = 30000;
const NOTES = 24;
const ENTRIES = 30;
const MESSAGES = 25;
const OUT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '.';

const results = [];
const record = (name, data) => {
  results.push({ name, ...data });
  const parts = Object.entries(data).map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`);
  console.log(`[perf] ${name}: ${parts.join(' ')}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Долгие задачи главного потока и трафик WebSocket считаются с первого кадра страницы
await context.addInitScript(() => {
  const perf = {
    longTasks: [], wsSent: 0, wsReceived: 0, wsSentBytes: 0, wsReceivedBytes: 0, wsOpened: 0,
  };
  globalThis.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => perf.longTasks.push({ start: entry.startTime, duration: entry.duration }));
    }).observe({ type: 'longtask', buffered: true });
  } catch (err) { /* нет PerformanceObserver — замер без долгих задач */ }
  const Native = window.WebSocket;
  window.WebSocket = class CountedWebSocket extends Native {
    constructor(...args) {
      super(...args);
      perf.wsOpened += 1;
      this.addEventListener('message', (e) => {
        perf.wsReceived += 1;
        perf.wsReceivedBytes += typeof e.data === 'string' ? e.data.length : (e.data.byteLength ?? e.data.size ?? 0);
      });
    }

    send(data) {
      perf.wsSent += 1;
      perf.wsSentBytes += typeof data === 'string' ? data.length : (data.byteLength ?? data.size ?? 0);
      return super.send(data);
    }
  };
});

let page;
let cdp;
let marks = { longTasks: 0, wsSent: 0, wsReceived: 0 };

// Снимок счётчиков с момента прошлого снимка
async function snap() {
  const data = await page.evaluate(() => {
    const p = globalThis.__perf;
    return {
      longTasks: p.longTasks, wsSent: p.wsSent, wsReceived: p.wsReceived,
      wsSentBytes: p.wsSentBytes, wsReceivedBytes: p.wsReceivedBytes, wsOpened: p.wsOpened,
      domNodes: document.getElementsByTagName('*').length,
    };
  });
  // Куча и работа главного потока — от браузера (performance.memory без флага обновляется раз в минуты)
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name) => metrics.find((m) => m.name === name)?.value || 0;
  data.heapMb = metric('JSHeapUsedSize') / 1048576;
  const work = {
    scriptMs: metric('ScriptDuration') * 1000, layoutMs: metric('LayoutDuration') * 1000,
    styleMs: metric('RecalcStyleDuration') * 1000, taskMs: metric('TaskDuration') * 1000, layouts: metric('LayoutCount'),
  };
  // После перезагрузки массив долгих задач новый — индекс прошлого снимка не годится
  if (data.longTasks.length < marks.longTasks) marks.longTasks = 0;
  const fresh = data.longTasks.slice(marks.longTasks);
  const out = {
    longTasks: fresh.length,
    longTasksMs: fresh.reduce((sum, t) => sum + t.duration, 0),
    longestMs: fresh.reduce((max, t) => Math.max(max, t.duration), 0),
    wsSent: data.wsSent - marks.wsSent,
    wsReceived: data.wsReceived - marks.wsReceived,
    heapMb: data.heapMb,
    domNodes: data.domNodes,
    scriptMs: work.scriptMs - (marks.scriptMs || 0),
    layoutMs: work.layoutMs - (marks.layoutMs || 0),
    styleMs: work.styleMs - (marks.styleMs || 0),
    taskMs: work.taskMs - (marks.taskMs || 0),
    layouts: work.layouts - (marks.layouts || 0),
  };
  marks = { longTasks: data.longTasks.length, wsSent: data.wsSent, wsReceived: data.wsReceived, ...work };
  return out;
}

async function resetMarks() {
  await snap();
}

// Время шага по часам сценария + долгие задачи за него
async function timed(name, action) {
  await resetMarks();
  const startedAt = Date.now();
  await action();
  const ms = Date.now() - startedAt;
  const s = await snap();
  record(name, {
    ms, scriptMs: s.scriptMs, layoutMs: s.layoutMs, styleMs: s.styleMs, layouts: s.layouts,
    longTasks: s.longTasks, longestMs: s.longestMs, domNodes: s.domNodes, heapMb: s.heapMb,
  });
  return ms;
}

const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
  .catch(() => assert.fail(`не появилось: ${what}`));

async function startupStats(label) {
  const stats = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const bytes = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
    const decoded = resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0);
    const byExt = {};
    resources.forEach((r) => {
      const ext = (r.name.split('?')[0].match(/\.(\w+)$/) || [])[1] || 'other';
      byExt[ext] = (byExt[ext] || 0) + (r.decodedBodySize || 0);
    });
    const top = resources.slice().sort((a, b) => (b.decodedBodySize || 0) - (a.decodedBodySize || 0)).slice(0, 8)
      .map((r) => `${r.name.split('/').pop().slice(0, 40)}:${Math.round((r.decodedBodySize || 0) / 1024)}K/${Math.round(r.duration)}ms@${Math.round(r.startTime)}`);
    const wasm = resources.filter((r) => r.name.endsWith('.wasm'))
      .map((r) => `${r.name.split('/').pop().slice(0, 30)} ${Math.round(r.startTime)}→${Math.round(r.responseEnd)}`);
    return {
      domContentLoaded: nav?.domContentLoadedEventEnd, loadEvent: nav?.loadEventEnd,
      resources: resources.length, transferKb: bytes / 1024, decodedKb: decoded / 1024,
      byExtKb: Object.fromEntries(Object.entries(byExt).map(([k, v]) => [k, Math.round(v / 1024)])),
      top, wasm,
    };
  });
  record(label, {
    domContentLoadedMs: stats.domContentLoaded, loadEventMs: stats.loadEvent, resources: stats.resources,
    transferKb: stats.transferKb, decodedKb: stats.decodedKb, byExtKb: JSON.stringify(stats.byExtKb),
  });
  console.log(`[perf]   top: ${stats.top.join(' | ')}`);
  console.log(`[perf]   wasm: ${stats.wasm.join(' | ')}`);
}

async function measureReload(label) {
  await resetMarks();
  await reloadPage(page);
  await waitForChatList(page);
  const sinceNav = await page.evaluate(() => performance.now());
  const s = await snap();
  record(label, { chatListMs: sinceNav, scriptMs: s.scriptMs, layoutMs: s.layoutMs, styleMs: s.styleMs, longTasks: s.longTasks, longestMs: s.longestMs, heapMb: s.heapMb, domNodes: s.domNodes });
  await startupStats(`${label}: ресурсы`);
}

// Кадров в секунду за время жеста: счётчик requestAnimationFrame
async function framed(name, action) {
  await page.evaluate(() => {
    const p = globalThis.__perf;
    p.frames = 0; p.framing = true; p.frameGaps = []; let last = performance.now();
    const tick = (now) => { p.frames += 1; p.frameGaps.push(now - last); last = now; if (p.framing) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const startedAt = Date.now();
  await resetMarks();
  await action();
  const ms = Date.now() - startedAt;
  const f = await page.evaluate(() => {
    const p = globalThis.__perf; p.framing = false;
    const gaps = p.frameGaps.slice(1).sort((a, b) => a - b);
    return { frames: p.frames, worstGapMs: gaps[gaps.length - 1] || 0, p95GapMs: gaps[Math.floor(gaps.length * 0.95)] || 0 };
  });
  const s = await snap();
  record(name, {
    ms, fps: f.frames / (ms / 1000), worstGapMs: f.worstGapMs, p95GapMs: f.p95GapMs,
    scriptMs: s.scriptMs, layoutMs: s.layoutMs, styleMs: s.styleMs, layouts: s.layouts, longTasks: s.longTasks, longestMs: s.longestMs,
  });
}

async function idle(label, seconds) {
  await resetMarks();
  await page.waitForTimeout(seconds * 1000);
  const s = await snap();
  record(label, { seconds, wsSent: s.wsSent, wsReceived: s.wsReceived, scriptMs: s.scriptMs, layouts: s.layouts, longTasks: s.longTasks });
}

async function setCpuThrottle(rate) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

try {
  const suffix = Date.now().toString(36);
  const session = await preparePage(context, `perf-${suffix}@local`, PASSWORD);
  page = session.page;
  cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const planner = page.locator('#ParvanePlanner');
  const cloud = page.locator('#ParvaneCloud');
  const openSection = (name) => sidebar.getByRole('tab', { name, exact: true }).click();
  const openTab = async (name) => {
    // Раздел появляется после переключения не сразу — шапка берётся у того, что показан
    await page.locator('#ParvaneKnowledge, #ParvaneCloud').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    const header = (await knowledge.count()) ? knowledge : cloud;
    await header.locator('header').getByText(name, { exact: true }).first().click();
  };

  // ── Старт ──────────────────────────────────────────────────────────────────
  await startupStats('первый вход: ресурсы');
  await measureReload('перезагрузка (пусто) 1');
  await measureReload('перезагрузка (пусто) 2');

  // Разделы пустого аккаунта — первое и второе открытие
  for (const round of [1, 2]) {
    await timed(`пусто ${round}: Календарь`, async () => { await openPlannerScreen(page, 'calendar'); await visible(planner, 'план'); });
    await timed(`пусто ${round}: Сегодня`, () => openPlannerScreen(page, 'today'));
    await timed(`пусто ${round}: Здоровье`, async () => { await openPlannerScreen(page, 'health'); await visible(planner.locator('[data-planner-health]'), 'здоровье'); });
    await timed(`пусто ${round}: Знания`, async () => { await openSection('Knowledge'); await visible(knowledge, 'знания'); });
    await timed(`пусто ${round}: Файлы`, async () => { await openSection('Cloud'); await visible(cloud, 'файлы'); });
    await timed(`пусто ${round}: Чаты`, async () => { await openSection('Chats'); await waitForChatList(page); });
  }
  await idle('простой в Чатах (пусто)', 20);

  // ── Данные: заметки со ссылками, записи плана, сообщения ───────────────────
  await openSection('Knowledge');
  await visible(knowledge.locator('[data-note-row="Overview"]'), 'справка создана');
  const note = knowledge.locator('[data-note-id]');
  const noteTitle = (i) => `Заметка ${i}`;
  const seedNotesMs = await timed(`создание ${NOTES} заметок`, async () => {
    for (let i = 1; i <= NOTES; i++) {
      await knowledge.getByRole('button', { name: 'New note' }).click();
      await visible(note, 'открытая заметка');
      await page.waitForTimeout(300);
      const title = note.getByLabel('Note title');
      await title.fill(noteTitle(i));
      await title.blur();
      await visible(knowledge.locator(`[data-note-row="${noteTitle(i)}"]`), 'строка заметки');
      await note.getByRole('button', { name: 'Edit' }).click();
      const links = [1, 2, 3].map((d) => `[[${noteTitle(((i + d - 1) % NOTES) + 1)}]]`).join(', ');
      await page.locator('#knowledge-note-editor').fill(
        `# ${noteTitle(i)}\n\nТекст заметки номер ${i} про сервер и кабель.\n\nСвязи: ${links}\n\n- [ ] пункт ${i}\n#тег${i % 5}`,
      );
      await note.getByRole('button', { name: 'Save' }).click();
      await visible(note.locator('[data-note-body]').getByText(`номер ${i} `), 'текст заметки');
    }
  });
  record('заметка: средняя стоимость создания', { ms: seedNotesMs / NOTES });

  await openPlannerScreen(page, 'today');
  const quick = page.locator('#planner-quick-input');
  const seedEntriesMs = await timed(`создание ${ENTRIES} записей плана`, async () => {
    for (let i = 1; i <= ENTRIES; i++) {
      await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
      await visible(quick, 'окно ввода записи');
      const day = (i % 14) + 1;
      const text = i % 3 === 0 ? `встреча ${i} через ${day} дней в ${9 + (i % 9)}:00 1 ч` : `задача ${i} через ${day} дней`;
      await quick.fill(text);
      await quick.press('Enter');
      await planner.getByText(/^Added: /).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
        .catch(() => assert.fail(`запись ${i} не добавлена`));
      await page.waitForTimeout(150);
    }
  });
  record('запись плана: средняя стоимость создания', { ms: seedEntriesMs / ENTRIES });

  await openSection('Chats');
  await waitForChatList(page);
  await openSavedMessages(page);
  const seedMessagesMs = await timed(`отправка ${MESSAGES} сообщений в Избранное`, async () => {
    for (let i = 1; i <= MESSAGES; i++) await sendText(page, `сообщение ${i} для замера длины списка`);
  });
  record('сообщение: средняя стоимость отправки', { ms: seedMessagesMs / MESSAGES });

  // ── С данными: перезагрузка и разделы ──────────────────────────────────────
  await measureReload('перезагрузка (с данными) 1');
  await measureReload('перезагрузка (с данными) 2');
  await timed('открыть Избранное с историей', async () => {
    await openSavedMessages(page);
    await page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: `сообщение ${MESSAGES} ` }).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  for (const round of [1, 2]) {
    await timed(`данные ${round}: Календарь`, async () => { await openPlannerScreen(page, 'calendar'); await visible(planner, 'план'); });
    await timed(`данные ${round}: Сегодня`, () => openPlannerScreen(page, 'today'));
    await timed(`данные ${round}: Здоровье`, async () => { await openPlannerScreen(page, 'health'); await visible(planner.locator('[data-planner-health]'), 'здоровье'); });
    await timed(`данные ${round}: Знания (заметки)`, async () => {
      await openSection('Knowledge');
      await visible(knowledge.locator(`[data-note-row="${noteTitle(NOTES)}"]`), 'список заметок');
    });
    await timed(`данные ${round}: Граф`, async () => {
      await openTab('Graph');
      await page.waitForFunction((count) => document.querySelectorAll('[data-notes-graph] [data-node]').length >= count, NOTES, { timeout: STEP_TIMEOUT_MS });
    });
    await timed(`данные ${round}: Файлы`, async () => { await openSection('Cloud'); await visible(cloud, 'файлы'); });
    await timed(`данные ${round}: Чаты`, async () => { await openSection('Chats'); await waitForChatList(page); });
  }

  // ── Окна и набор текста ────────────────────────────────────────────────────
  const paletteInput = page.locator('#parvane-palette-search');
  for (const round of [1, 2]) {
    await timed(`палитра ${round}: открыть`, async () => { await page.keyboard.press('Control+k'); await visible(paletteInput, 'палитра'); });
    await framed(`палитра ${round}: набор «заметка 1»`, async () => {
      await paletteInput.pressSequentially('заметка 1', { delay: 40 });
      await page.locator('[data-palette-group="note"] [data-palette-item]').filter({ hasText: noteTitle(1) }).first()
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    });
    await page.keyboard.press('Escape');
    await paletteInput.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  }

  await openPlannerScreen(page, 'today');
  await timed('ввод текстом: открыть', async () => {
    await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
    await visible(quick, 'окно ввода');
  });
  await framed('ввод текстом: набор 60 знаков', async () => {
    await quick.pressSequentially('встреча с командой по серверу завтра в 15:30 на полтора часа #работа', { delay: 30 });
  });
  await page.keyboard.press('Escape');

  await openSection('Knowledge');
  await openTab('Notes');
  await knowledge.locator(`[data-note-row="${noteTitle(3)}"]`).click();
  await visible(note.locator('[data-note-body]'), 'заметка');
  await note.getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('#knowledge-note-editor');
  await visible(editor, 'редактор');
  await editor.press('End');
  await framed('редактор заметки: набор 200 знаков', async () => {
    await editor.pressSequentially(` ${'слово '.repeat(33)}`, { delay: 15 });
  });
  await timed('редактор заметки: сохранить', async () => {
    await note.getByRole('button', { name: 'Save' }).click();
    await visible(note.locator('[data-note-body]').getByText('слово слово'), 'сохранённый текст');
  });

  // ── Граф и холст ───────────────────────────────────────────────────────────
  await openTab('Graph');
  await page.waitForFunction((count) => document.querySelectorAll('[data-notes-graph] [data-node]').length >= count, NOTES, { timeout: STEP_TIMEOUT_MS });
  const graphNode = knowledge.locator('[data-notes-graph] [data-node]').first();
  const centre = async (locator) => {
    const box = await locator.boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await framed('граф: перетащить точку (40 шагов)', async () => {
    const from = await centre(graphNode);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(from.x + i * 4, from.y + i * 2);
    await page.mouse.up();
  });
  await framed('граф: колесо масштаба (20 шагов)', async () => {
    const box = await knowledge.locator('[data-notes-graph]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, i < 10 ? -100 : 100);
  });
  await timed('граф: выбрать точку → панель', async () => {
    await graphNode.click();
    await visible(knowledge.locator('[data-note-id]'), 'панель заметки');
  });
  await page.keyboard.press('Escape');

  await timed('холст: создать из графа', async () => {
    await knowledge.locator('[data-graph-to-canvas]').click();
    await page.waitForFunction((count) => document.querySelectorAll('[data-canvas-node][data-canvas-type="file"]').length >= count, NOTES, { timeout: STEP_TIMEOUT_MS });
  });
  const card = knowledge.locator('[data-canvas-node][data-canvas-type="file"]').first();
  await framed('холст: перетащить карточку (40 шагов)', async () => {
    const box = await card.boundingBox();
    const from = { x: box.x + 20, y: box.y + 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(from.x + i * 5, from.y + i * 3);
    await page.mouse.up();
  });
  await framed('холст: сдвиг поля (40 шагов)', async () => {
    const box = await knowledge.locator('[data-canvas-board]').boundingBox();
    const from = { x: box.x + box.width - 40, y: box.y + box.height - 40 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(from.x - i * 6, from.y - i * 4);
    await page.mouse.up();
  });
  await idle('простой на холсте', 10);
  await openSection('Chats');
  await waitForChatList(page);
  await idle('простой в Чатах (с данными)', 20);

  // ── Замедленный CPU ×4 ─────────────────────────────────────────────────────
  await setCpuThrottle(4);
  await measureReload('CPU×4: перезагрузка (с данными)');
  await timed('CPU×4: Календарь', async () => { await openPlannerScreen(page, 'calendar'); await visible(planner, 'план'); });
  await timed('CPU×4: Сегодня', () => openPlannerScreen(page, 'today'));
  await timed('CPU×4: Знания (заметки)', async () => {
    await openSection('Knowledge');
    await visible(knowledge.locator(`[data-note-row="${noteTitle(NOTES)}"]`), 'список заметок');
  });
  await timed('CPU×4: Граф', async () => {
    await openTab('Graph');
    await page.waitForFunction((count) => document.querySelectorAll('[data-notes-graph] [data-node]').length >= count, NOTES, { timeout: STEP_TIMEOUT_MS });
  });
  await timed('CPU×4: Чаты', async () => { await openSection('Chats'); await waitForChatList(page); });
  await timed('CPU×4: палитра открыть', async () => { await page.keyboard.press('Control+k'); await visible(paletteInput, 'палитра'); });
  await timed('CPU×4: палитра набор', async () => {
    await paletteInput.pressSequentially('заметка 1', { delay: 40 });
    await page.locator('[data-palette-group="note"] [data-palette-item]').filter({ hasText: noteTitle(1) }).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await page.keyboard.press('Escape');
  await timed('CPU×4: открыть Избранное с историей', async () => {
    await openSavedMessages(page);
    await page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: `сообщение ${MESSAGES} ` }).first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await openSection('Knowledge');
  await openTab('Canvas');
  await visible(card, 'карточка холста');
  await framed('CPU×4: холст: перетащить карточку (40 шагов)', async () => {
    const box = await card.boundingBox();
    const from = { x: box.x + 20, y: box.y + 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(from.x + i * 5, from.y + i * 3);
    await page.mouse.up();
  });
  await openTab('Graph');
  await visible(graphNode, 'точка графа');
  await framed('CPU×4: граф: перетащить точку (40 шагов)', async () => {
    const from = await centre(graphNode);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 40; i++) await page.mouse.move(from.x + i * 4, from.y + i * 2);
    await page.mouse.up();
  });
  await openSection('Chats');
  await waitForChatList(page);
  await openSavedMessages(page);
  await framed('CPU×4: композер: набор 60 знаков', async () => {
    await page.locator('#editable-message-text').pressSequentially('проверка скорости набора в поле сообщения на медленном процессоре', { delay: 30 });
  });
  await setCpuThrottle(1);

  writeFileSync(`${OUT_DIR}/perf.json`, JSON.stringify(results, undefined, 2));
  console.log(`e2e_web_perf: OK (${results.length} замеров, ${OUT_DIR}/perf.json)`);
} catch (err) {
  writeFileSync(`${OUT_DIR}/perf.json`, JSON.stringify(results, undefined, 2));
  if (page) await page.screenshot({ path: `${OUT_DIR}/perf-failure.png` }).catch(() => undefined);
  throw err;
} finally {
  await context.close();
  await browser.close();
}
