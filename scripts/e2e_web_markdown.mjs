// Markdown заметки (MD-1, 6 ноя 2026): тестовый файл пользователя со всеми конструкциями (`conformance/markdown/`)
// показывается целиком — H1–H6, вложенные цитаты, callouts (сворачиваемый закрыт), подсветка кода, таблицы, задачи
// (и в нумерованном списке — галочка сохраняется), нумерация с 7, якорь `#раздел` прокручивает к заголовку,
// HTML не исполняется, комментарии скрыты. Правка на широком экране — редактор и живой просмотр рядом, список
// заметок и «Связи» убраны; на телефоне — одно окно и кнопка «правка ↔ просмотр», которая остаётся на экране
// при прокрутке. Снимки — в PARVANE_E2E_SHOT_DIR / PARVANE_E2E_BACKEND_LOG_DIR.
// Запуск: scripts/run_web_markdown_e2e.sh
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { dismissRecoveryKeyDialog, preparePage } from './e2e_web_helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = readFileSync(path.join(ROOT, 'conformance/markdown/all-constructs.md'), 'utf8');
const PASSWORD = 'Parvane-markdown-e2e-1';
const WIDE = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 800 };
const STEP_TIMEOUT_MS = 20000;
const TITLE = 'Тест';
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR || '';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
let session;

try {
  const user = `md-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs += 1;
    await dialog.dismiss().catch(() => undefined);
  });
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const knowledge = page.locator('#ParvaneKnowledge');
  const note = knowledge.locator('[data-note-id]');
  const body = note.locator('[data-note-body]');
  const visible = (locator, what) => locator.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail(`не появилось: ${what}`));
  const shot = async (name) => {
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/markdown-${name}.png` }).catch(() => undefined);
  };
  // Прокрутка ближайшей прокручиваемой области заметки
  const scrollNote = (where) => note.evaluate((element, to) => {
    let node = element;
    while (node && !(node.scrollHeight > node.clientHeight + 4
      && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))) node = node.parentElement;
    if (node) node.scrollTop = to === 'end' ? node.scrollHeight : to;
  }, where);
  // Правый нижний угол экрана (над нижней панелью разделов телефона)
  const inCorner = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.right > window.innerWidth - 96 && rect.right <= window.innerWidth
      && rect.bottom > window.innerHeight - 200 && rect.bottom <= window.innerHeight;
  });
  const inViewport = (locator) => locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 && rect.right <= window.innerWidth
      && rect.width > 0;
  });

  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Knowledge' }).click();
  await visible(knowledge, 'раздел заметок');
  await knowledge.getByRole('button', { name: 'New note' }).click();
  await visible(note, 'открытая заметка');
  const title = note.getByLabel('Note title');
  await title.fill(TITLE);
  await title.blur();

  // ── Правка на широком экране: редактор и просмотр рядом, без списка и «Связей» ──
  const editor = page.locator('#knowledge-note-editor');
  // Переименование перерисовывает заметку — нажатие сразу после него может потеряться: повторить
  for (let attempt = 0; attempt < 5 && !await editor.isVisible(); attempt++) {
    await note.getByRole('button', { name: 'Edit' }).first().click().catch(() => undefined);
    await editor.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
  }
  // Редактор после открытия правки ещё раз перерисовывается — заполнение может попасть в отцепленный узел
  for (let attempt = 0; ; attempt++) {
    try { await editor.fill(FIXTURE, { timeout: 5000 }); break; } catch (error) {
      if (attempt >= 4) throw error;
      await page.waitForTimeout(500);
    }
  }
  const split = note.locator('[data-note-edit="split"]');
  await visible(split, 'правка с просмотром рядом');
  const preview = note.locator('[data-note-preview]');
  await visible(preview.locator('[role="heading"][aria-level="4"]'), 'H4 в живом просмотре');
  assert.equal(await knowledge.locator('[data-notes-list]').count(), 0, 'список заметок убран на время правки');
  const editorBox = await editor.boundingBox();
  const previewBox = await preview.boundingBox();
  assert.ok(editorBox && previewBox && previewBox.x > editorBox.x + editorBox.width - 1, 'просмотр справа от редактора');
  assert.ok(previewBox.width > 450, `просмотр шириной ${previewBox.width}: место отдано правке`);
  await editor.press('End');
  await editor.type('\n\n#### Добавлено в правке');
  await visible(preview.getByText('Добавлено в правке'), 'просмотр следует за текстом');
  await shot('edit-split');
  await editor.fill(FIXTURE);

  // Панели одной высоты; прокрутка синхронна по строкам текста в обе стороны
  await page.waitForTimeout(500);
  const [editorHeight, previewHeight] = [(await editor.boundingBox()).height, (await preview.boundingBox()).height];
  assert.ok(Math.abs(editorHeight - previewHeight) < 60 && editorHeight > 500,
    `редактор ${editorHeight} и просмотр ${previewHeight} одной высоты на весь экран`);
  // Верх строки текста в textarea — по зеркалу (как useSplitScrollSync)
  const lineTop = (needle) => editor.evaluate((element, wanted) => {
    const style = getComputedStyle(element);
    const mirror = document.createElement('div');
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
      'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'boxSizing']) {
      mirror.style[name] = style[name];
    }
    Object.assign(mirror.style, {
      position: 'absolute', visibility: 'hidden', left: '-10000px', width: `${element.clientWidth}px`,
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    });
    const lines = element.value.split('\n');
    lines.forEach((line) => { const row = document.createElement('div'); row.textContent = line || '\u200b'; mirror.appendChild(row); });
    document.body.appendChild(mirror);
    const top = mirror.children[lines.indexOf(wanted)].offsetTop;
    mirror.remove();
    return { top, lineHeight: parseFloat(style.lineHeight) || 20 };
  }, needle);
  // Просмотр → редактор
  await preview.evaluate((element) => {
    const heading = element.querySelector('[data-md-id="9-таблицы"]');
    element.scrollTop = heading.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
  });
  const tablesLine = await lineTop('## 9. Таблицы');
  await page.waitForFunction(([wanted, slack]) => {
    const element = document.querySelector('#knowledge-note-editor');
    return Math.abs(element.scrollTop - wanted) <= slack;
  }, [tablesLine.top, tablesLine.lineHeight * 2], { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('прокрутка просмотра к «9. Таблицы» не поставила эту строку вверх редактора'));
  // Редактор → просмотр
  const mathLine = await lineTop('## 17. Математика (LaTeX)');
  await editor.evaluate((element, top) => { element.scrollTop = top; }, mathLine.top);
  await page.waitForFunction(() => {
    const pane = document.querySelector('[data-note-preview]');
    const heading = pane?.querySelector('[data-md-id="17-математика-latex"]');
    if (!heading) return false;
    const offset = heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    return offset > -40 && offset < 60;
  }, undefined, { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('прокрутка редактора к «17. Математика» не поставила заголовок вверх просмотра'));
  await shot('edit-sync');
  console.log('OK: правка — панели одной высоты, прокрутка синхронна по строкам в обе стороны');
  await note.getByRole('button', { name: 'Save' }).first().click();
  await visible(body, 'текст заметки после сохранения');
  await visible(knowledge.locator('[data-notes-list]'), 'список заметок вернулся после правки');
  console.log('OK: правка — редактор и живой просмотр рядом, список и «Связи» на время правки убраны');

  // ── Показ: все конструкции ──
  for (let level = 1; level <= 6; level++) {
    assert.ok(await body.locator(`[role="heading"][aria-level="${level}"]`).count() > 0, `заголовок H${level}`);
  }
  assert.equal(await body.getByText('####### Семь решёток', { exact: false }).count(), 1, 'семь решёток — текст');
  assert.equal(await body.locator('blockquote blockquote blockquote blockquote').count(), 1, 'цитата четвёртого уровня');
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution', 'info']) {
    assert.equal(await body.locator(`[data-callout="${kind}"]`).count(), 1, `callout ${kind}`);
  }
  assert.equal(await body.locator('details[data-callout="info"]').evaluate((element) => element.open), false,
    'свёрнутый callout закрыт');
  assert.ok(await body.locator('mark').count() >= 2 && await body.locator('sub').count() >= 1
    && await body.locator('sup').count() >= 1 && await body.locator('u').count() >= 1, 'mark, sub, sup, u');
  assert.equal(await body.locator('em strong, strong em').count() >= 4, true, 'вложенные жирный и курсив');
  assert.equal(await body.getByText('2 * 3 * 4 = 24', { exact: false }).count(), 1, 'звёздочки без пары — текстом');
  assert.ok(await body.locator('table').count() >= 5, 'таблицы');
  assert.equal(await body.locator('input[type="checkbox"]').count(), 9, 'девять пунктов с галочками');
  assert.ok((await body.innerText()).includes('7.'), 'список с семи');
  assert.equal(await body.getByText('Это HTML-комментарий').count(), 0, 'HTML-комментарий скрыт');
  assert.equal(await body.getByText('этого не должно быть видно').count(), 0, 'комментарий Obsidian скрыт');
  assert.ok((await body.innerText()).includes('<script>alert('), 'script показан текстом');
  await visible(body.locator('[data-md-code="python"] .hljs-keyword'), 'подсветка python');
  await visible(body.locator('[data-md-code="rust"] .hljs-keyword'), 'подсветка rust');
  assert.equal(dialogs, 0, 'ни один alert из текста не выполнился');
  await shot('read-top');
  console.log('OK: H1–H6, цитаты, callouts, начертания, таблицы, задачи, подсветка кода; HTML не исполняется');

  // ── Текст выделяется, у кода — «Копировать», «Изменить» и «Запланировать» — в закреплённой шапке ──
  assert.equal(await body.locator('[data-md-line]').first().evaluate(
    (element) => getComputedStyle(element).userSelect), 'text', 'текст заметки выделяется');
  const pythonCode = body.locator('[data-md-code="python"]').first();
  await pythonCode.scrollIntoViewIfNeeded();
  await pythonCode.hover();
  const copyButton = pythonCode.locator('[data-md-copy]');
  await visible(copyButton, 'кнопка «Копировать» у кода при наведении');
  // Кнопка проявляется плавно (0,15 с) — ждать, а не мерить в первый же момент
  await copyButton.first().evaluate((element) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (Number(getComputedStyle(element).opacity) > 0.5) resolve(undefined);
      else if (Date.now() > deadline) reject(new Error('кнопка «Копировать» не проявилась при наведении'));
      else requestAnimationFrame(check);
    };
    check();
  }));
  await copyButton.click();
  await visible(page.getByText('Text copied to clipboard', { exact: false }).first(), 'уведомление о копировании');
  await scrollNote(0.9);
  const bar = page.locator('[data-note-bar]');
  await visible(bar.locator('[data-note-bar-edit]'), '«Изменить» в шапке');
  await visible(bar.locator('[data-note-bar-plan]'), '«Запланировать» в шапке');
  assert.ok(await inViewport(bar.locator('[data-note-bar-edit]')), '«Изменить» на экране и в конце заметки');
  await scrollNote(0);
  console.log('OK: текст выделяется, «Копировать» у кода, «Изменить»/«Запланировать» в закреплённой шапке');

  // ── Якорь `#раздел` прокручивает к заголовку ──
  await scrollNote(0);
  await body.getByRole('link', { name: 'Якорь на раздел «Таблицы»' }).click();
  const tables = body.locator('[data-md-id="9-таблицы"]');
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-md-id="9-таблицы"]');
    const rect = element?.getBoundingClientRect();
    return rect && rect.top >= 0 && rect.top < window.innerHeight / 2;
  }, undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('якорь не прокрутил к «9. Таблицы»'));
  assert.ok(await inViewport(tables), 'заголовок «9. Таблицы» на экране');
  await shot('read-tables');
  console.log('OK: якорь прокручивает к заголовку');

  // ── Галочка пункта нумерованного списка сохраняется в тексте ──
  const orderedTask = body.locator('li', { hasText: 'задача в нумерованном списке' }).locator('input[type="checkbox"]');
  await orderedTask.scrollIntoViewIfNeeded();
  await orderedTask.check();
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('#ParvaneKnowledge [data-note-body] li')];
    const item = items.find((element) => element.textContent?.includes('задача в нумерованном списке'));
    return item?.querySelector('input')?.checked;
  }, undefined, { timeout: STEP_TIMEOUT_MS }).catch(() => assert.fail('галочка нумерованного пункта не сохранилась'));
  console.log('OK: галочка в нумерованном списке отмечается');

  // ── Телефон: одно окно, кнопка «правка ↔ просмотр» на месте при прокрутке ──
  await page.setViewportSize(PHONE);
  await visible(note, 'заметка на телефоне');
  await note.getByRole('button', { name: 'Edit' }).first().click();
  const toggle = note.locator('[data-note-preview-toggle]');
  await visible(note.locator('[data-note-edit="editor"]'), 'на телефоне — только редактор');
  await visible(toggle, 'кнопка просмотра');
  assert.ok(await inCorner(toggle), 'кнопка просмотра в правом нижнем углу');
  await scrollNote('end');
  await page.waitForTimeout(300);
  assert.ok(await inCorner(toggle), 'кнопка на экране после прокрутки вниз (редактор)');
  await shot('phone-editor');
  await toggle.click();
  await visible(note.locator('[data-note-edit="preview"]'), 'на телефоне — просмотр вместо редактора');
  assert.equal(await page.locator('#knowledge-note-editor').count(), 0, 'редактор скрыт в просмотре');
  await visible(note.locator('[data-note-preview] [role="heading"][aria-level="6"]'), 'H6 в просмотре на телефоне');
  await scrollNote(4000);
  await page.waitForTimeout(300);
  assert.ok(await inCorner(toggle), 'кнопка на экране посреди прокрутки (просмотр)');
  await shot('phone-preview-mid');
  await scrollNote('end');
  await page.waitForTimeout(300);
  assert.ok(await inCorner(toggle), 'кнопка на экране в конце прокрутки (просмотр)');
  await shot('phone-preview-end');
  await toggle.click();
  await visible(note.locator('[data-note-edit="editor"]'), 'обратно к редактору');
  assert.ok((await page.locator('#knowledge-note-editor').inputValue()).includes('## 22. Граничные случаи парсинга'),
    'текст правки сохранился при переключении');
  console.log('OK: телефон — одно окно, кнопка переключения всегда на экране');

  console.log('e2e_web_markdown: OK');
} catch (error) {
  if (SHOT_DIR) {
    const [page] = context.pages();
    await page?.screenshot({ path: `${SHOT_DIR}/markdown-failure.png` }).catch(() => {});
    console.log(`--- журнал провайдера ---\n${(session?.logs || []).slice(-40).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
