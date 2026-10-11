// Раздел «Облако» (spec 016): личное файловое хранилище. Вход в раздел с
// панели, загрузка нескольких файлов, перезагрузка, скачивание байт в байт,
// папки и путь, переименование, перемещение выделенного, корзина строкой-папкой
// в конце корня со сроком хранения и окончательное удаление с освобождением
// места, поиск по всем папкам, сортировка, один вид — список (плитки нет),
// просмотр, отказ файла больше предела, телефон; на сервере нет имён и
// содержимого открытым текстом.
// Запуск: scripts/run_web_cloud_e2e.sh
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer,
  dismissRecoveryKeyDialog,
  preparePage,
  reloadPage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cloud-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (каталог баз стенда)');

const SECRET_TEXT = 'Секретное содержимое заметки облака 7f3a';
const SECRET_NAME = 'Тайные заметки';
// Минимальный PDF: браузер узнаёт его по заголовку
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n');

function randomBytes(length, seed) {
  const out = Buffer.alloc(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function isShown(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return Boolean(el) && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
  }, selector);
}

/** Строки баз шардов, где встречается одно из слов (и latin1, и utf8). */
function plaintextLeaks(words) {
  const found = [];
  for (const [file, queries] of [
    ['domains.db-v2.db', ['SELECT op AS b FROM container_log', 'SELECT snapshot AS b FROM container_snapshots']],
    ['cloud.db', ['SELECT data AS b FROM chunks', 'SELECT filename AS b FROM files']],
  ]) {
    const db = new DatabaseSync(`${BACKEND_DIR}/${file}`, { readOnly: true });
    try {
      for (const sql of queries) {
        for (const row of db.prepare(sql).all()) {
          const bytes = Buffer.from(row.b || '');
          const texts = [bytes.toString('latin1'), bytes.toString('utf8')];
          for (const word of words) {
            if (texts.some((t) => t.includes(word))) found.push(`${file}: ${word}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return found;
}

function counts() {
  const domains = new DatabaseSync(`${BACKEND_DIR}/domains.db-v2.db`, { readOnly: true });
  const cloudDb = new DatabaseSync(`${BACKEND_DIR}/cloud.db`, { readOnly: true });
  try {
    return {
      ops: domains.prepare('SELECT COUNT(*) AS n FROM container_log').get().n,
      driveFiles: cloudDb.prepare('SELECT COUNT(*) AS n FROM files WHERE bucket = 1').get().n,
      driveBytes: cloudDb.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE bucket = 1').get().n,
      pending: cloudDb.prepare('SELECT COUNT(*) AS n FROM uploads').get().n,
    };
  } finally {
    domains.close();
    cloudDb.close();
  }
}

async function pollUntil(read, isDone, message, timeout = STEP_TIMEOUT_MS) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await read();
    if (isDone(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE, acceptDownloads: true });
let session;

try {
  const user = `cloud-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const cloud = page.locator('#ParvaneCloud');
  const sidebar = page.locator('#FoldersSidebar');
  const item = (name) => cloud.locator(`[data-node-id][data-name="${name}"]`);
  const names = () => cloud.locator('[role="listitem"][data-node-id]').evaluateAll((els) => els.map((el) => el.dataset.name));
  const openMenu = async (name) => {
    await item(name).hover();
    await item(name).getByRole('button', { name: 'Actions' }).click();
  };
  const menuAction = async (name, action) => {
    await openMenu(name);
    await page.getByRole('menuitem', { name: action, exact: true }).click();
  };
  const addAction = async (action) => {
    await cloud.getByRole('button', { name: 'Upload', exact: true }).click();
    await page.getByRole('menuitem', { name: action, exact: true }).click();
  };
  const upload = async (files) => {
    await cloud.locator('input[type="file"]').setInputFiles(files);
  };
  const waitUploadsDone = async () => {
    await cloud.locator('[data-transfer-kind="upload"][data-transfer-state="active"]').first()
      .waitFor({ state: 'detached', timeout: 60000 });
  };
  const path = cloud.locator('nav');
  const crumbs = () => path.locator('span > button').allInnerTexts();
  const toRoot = async () => {
    await path.getByRole('button', { name: 'Cloud', exact: true }).click();
    await cloud.locator('[data-virtual="trash"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const trashRow = cloud.locator('[data-virtual="trash"]');
  const openTrash = async () => {
    await trashRow.click();
    await page.locator('#ParvaneCloud[data-place="trash"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const used = () => cloud.locator('footer[data-used]').getAttribute('data-used').then(Number);
  const openCloud = async () => {
    await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
    await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.waitForFunction(() => document.querySelector('#ParvaneCloud')?.dataset.loaded === '1', undefined, { timeout: STEP_TIMEOUT_MS });
  };

  // ── Раздел: кнопка в панели, вместо колонок мессенджера, пустое состояние ──
  assert.equal(await sidebar.getByRole('tab').count(), 5, 'в панели пять разделов');
  await openCloud();
  assert.equal(await isShown(page, '#LeftColumn'), false, 'список чатов должен быть скрыт');
  assert.equal(await isShown(page, '#MiddleColumn'), false, 'переписка должна быть скрыта');
  assert.equal(await sidebar.getByRole('tab', { name: 'Knowledge' }).getAttribute('aria-selected'), 'true');
  await cloud.getByText('No files yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByText('Drag files here or press Upload.').waitFor({ state: 'visible' });
  // Один список без вкладок: путь из одного шага, в конце корня — «Доступные мне» и «Корзина»
  assert.deepEqual(await crumbs(), ['Cloud'], 'в корне путь — один шаг');
  assert.equal(await cloud.locator('header').getByText('Trash', { exact: true }).count(), 0, 'вкладок в шапке нет');
  await cloud.locator('[data-virtual="shared"]').getByText('Shared with me', { exact: true }).waitFor({ state: 'visible' });
  await trashRow.getByText('Trash is empty').waitFor({ state: 'visible' });
  assert.deepEqual(
    await cloud.locator('[role="list"] > [role="listitem"]').evaluateAll((els) => els.map((el) => el.dataset.virtual)),
    ['shared', 'trash'], 'строки-папки стоят в конце корня',
  );
  assert.equal(await cloud.getByRole('button', { name: 'Tiles' }).count(), 0, 'переключателя вида нет');
  assert.equal(counts().ops, 0, 'пустой раздел диск на сервере не создаёт');
  console.log('OK: раздел открывается с панели, пустое состояние вместо бесконечной загрузки');

  // ── Загрузка нескольких файлов: ход, файлы в списке, после перезагрузки на месте ──
  const big = randomBytes(1_300_000, 7);
  const png = buildPngBuffer(96, [0x20, 0x90, 0x40]);
  await upload([
    { name: 'заметка.txt', mimeType: 'text/plain', buffer: Buffer.from(SECRET_TEXT) },
    { name: 'снимок.png', mimeType: 'image/png', buffer: png },
    { name: 'отчёт.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'данные.bin', mimeType: 'application/octet-stream', buffer: big },
  ]);
  await cloud.locator('[data-transfer-kind="upload"]').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  for (const name of ['заметка.txt', 'снимок.png', 'отчёт.pdf', 'данные.bin']) {
    await item(name).waitFor({ state: 'visible', timeout: 60000 });
  }
  await waitUploadsDone();
  await pollUntil(used, (n) => n > 1_300_000, 'занятое место не выросло');
  // Содержимое идёт несколькими чанками облака; незавершённых загрузок не осталось
  const afterUpload = await pollUntil(() => Promise.resolve(counts()), (c) => c.driveFiles >= 5 && c.pending === 0, 'блобы не завершены');
  assert.ok(afterUpload.ops >= 1, 'операции дерева записаны');
  await reloadPage(page);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await openCloud();
  for (const name of ['заметка.txt', 'снимок.png', 'отчёт.pdf', 'данные.bin']) {
    await item(name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }
  console.log('OK: четыре файла загружены, после перезагрузки на месте');

  // ── Скачивание: содержимое совпадает байт в байт ──────────────────────────
  const downloadOf = async (name) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
      menuAction(name, 'Download'),
    ]);
    assert.equal(download.suggestedFilename(), name);
    return readFileSync(await download.path());
  };
  assert.equal(sha256(await downloadOf('данные.bin')), sha256(big), 'скачанный файл отличается от загруженного');
  assert.equal((await downloadOf('заметка.txt')).toString(), SECRET_TEXT);
  console.log('OK: скачанное совпадает с загруженным');

  // ── Папки любой вложенности и путь ────────────────────────────────────────
  const createFolder = async (name) => {
    await addAction('New folder');
    await page.locator('#parvane-cloud-name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await item(name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  await addAction('New folder');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Enter a name.').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#parvane-cloud-name').fill('плохое/имя');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText("The name can't contain / or \\.").waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#parvane-cloud-name').fill(SECRET_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await item(SECRET_NAME).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual((await names()).slice(0, 1), [SECRET_NAME], 'папки стоят выше файлов');
  await item(SECRET_NAME).click();
  await cloud.getByText('This folder is empty').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await createFolder('Внутри');
  await item('Внутри').click();
  await path.getByRole('button', { name: 'Внутри' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await crumbs(), ['Cloud', SECRET_NAME, 'Внутри'], 'путь от корня');
  assert.equal(await trashRow.count(), 0, 'строки-папки — только в корне');
  await toRoot();
  await item('данные.bin').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: папка в папке, путь, отказ пустого имени и имени со знаком /');

  // ── Переименование; совпавшее имя получает номер ──────────────────────────
  const rename = async (from, to) => {
    await menuAction(from, 'Rename');
    await page.locator('#parvane-cloud-name').fill(to);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  };
  await rename('заметка.txt', 'дневник.txt');
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await item('заметка.txt').count(), 0);
  await rename('отчёт.pdf', 'дневник.txt');
  await item('дневник (2).txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await rename('дневник (2).txt', 'отчёт.pdf');
  await item('отчёт.pdf').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Загрузка файла с занятым именем прежний не затирает
  await upload([{ name: 'дневник.txt', mimeType: 'text/plain', buffer: Buffer.from('второй') }]);
  await item('дневник (2).txt').waitFor({ state: 'visible', timeout: 60000 });
  await waitUploadsDone();
  console.log('OK: переименование, совпавшее имя получает номер');

  // ── Перемещение двух выделенных ───────────────────────────────────────────
  for (const name of ['дневник.txt', 'дневник (2).txt']) {
    await item(name).hover();
    await item(name).getByRole('checkbox').click();
  }
  await cloud.getByText('Selected: 2').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByRole('toolbar').getByRole('button', { name: 'Move', exact: true }).click();
  const moveDialog = page.locator('.Modal').filter({ hasText: 'Move to' });
  await moveDialog.getByRole('listitem').filter({ hasText: SECRET_NAME }).click();
  await moveDialog.getByRole('button', { name: 'Move here', exact: true }).click();
  await item('дневник.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).click();
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('дневник (2).txt').waitFor({ state: 'visible' });
  // Папку нельзя переместить в саму себя и во вложенную: кнопка недоступна
  await toRoot();
  await menuAction(SECRET_NAME, 'Move');
  const folderMove = page.locator('.Modal').filter({ hasText: 'Move to' });
  assert.ok(await folderMove.getByRole('listitem').filter({ hasText: SECRET_NAME }).isDisabled(), 'папка не может быть целью самой себя');
  await folderMove.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('OK: два выделенных элемента перемещены; папку нельзя переместить в саму себя');

  // ── Корзина: удалить папку с содержимым, восстановить, стереть файл навсегда ──
  await menuAction(SECRET_NAME, 'Move to trash');
  await item(SECRET_NAME).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Корзина — строка-папка в конце корня: счётчик, срок хранения, путь «Cloud / Trash»
  await trashRow.getByText('Items: 1 · kept for 30 days').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await trashRow.getAttribute('data-count'), '1');
  await openTrash();
  await item(SECRET_NAME).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await names(), [SECRET_NAME], 'в корзине — папка целиком, а не её содержимое по одному');
  assert.deepEqual(await crumbs(), ['Cloud', 'Trash'], 'корзина открывается как папка');
  await item(SECRET_NAME).getByText('Deleted in 30 days').waitFor({ state: 'visible' });
  assert.equal(await item(SECRET_NAME).getAttribute('data-days-left'), '30', 'срок корзины — 30 дней');
  assert.equal(await cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'в корзину не загружают');
  const usedInTrash = await used();
  await menuAction(SECRET_NAME, 'Restore');
  await item(SECRET_NAME).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await cloud.getByText('Trash is empty').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await trashRow.getByText('Trash is empty').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).click();
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('Внутри').waitFor({ state: 'visible' });
  await toRoot();
  // Окончательное удаление: место на сервере освобождается
  const before = counts();
  await menuAction('данные.bin', 'Move to trash');
  await openTrash();
  await item('данные.bin').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await used(), usedInTrash, 'файл в корзине продолжает занимать место');
  await menuAction('данные.bin', 'Delete forever');
  await page.getByText('The selected items will be deleted forever. This cannot be undone.').waitFor({ state: 'visible' });
  await page.locator('.Modal').getByRole('button', { name: 'Delete forever', exact: true }).click();
  await item('данные.bin').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const freed = await pollUntil(() => Promise.resolve(counts()), (c) => c.driveBytes <= before.driveBytes - 1_300_000, 'блоб стёртого файла остался на сервере', 30000);
  assert.equal(freed.driveFiles, before.driveFiles - 1);
  await pollUntil(used, (n) => n <= usedInTrash - 1_300_000, 'показатель места не уменьшился', 30000);
  await toRoot();
  console.log('OK: корзина — папка с содержимым туда и обратно; окончательное удаление освобождает место');

  // ── Поиск по всем папкам (кроме корзины) и сортировка ─────────────────────
  const search = cloud.getByRole('searchbox');
  // Файл в корзине поиск не находит
  await menuAction('отчёт.pdf', 'Move to trash');
  await item('отчёт.pdf').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await search.fill('отчёт');
  await cloud.getByText('Nothing found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await search.fill('');
  await openTrash();
  await menuAction('отчёт.pdf', 'Restore');
  await item('отчёт.pdf').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await item('отчёт.pdf').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await search.fill('ДНЕВ');
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual((await names()).sort(), ['дневник (2).txt', 'дневник.txt']);
  await item('дневник.txt').getByText(`Cloud / ${SECRET_NAME}`).waitFor({ state: 'visible' });
  await cloud.getByText('Found: 2 · in all folders except the trash').waitFor({ state: 'visible' });
  assert.equal(await path.count(), 0, 'пока идёт поиск, вместо пути — сколько найдено');
  assert.equal(await trashRow.count(), 0, 'строк-папок в найденном нет');
  await search.fill('нет такого');
  await cloud.getByText('Nothing found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await search.fill('');
  await item('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const sortBy = async (title) => {
    await cloud.getByRole('button', { name: 'Sorting' }).click();
    await page.getByRole('menuitem', { name: title, exact: true }).click();
  };
  const expectOrder = (expected, message) => pollUntil(
    names, (list) => JSON.stringify(list) === JSON.stringify(expected), message, 5000,
  );
  await sortBy('By size');
  await expectOrder([SECRET_NAME, 'отчёт.pdf', 'снимок.png'], 'по размеру, папки выше');
  await sortBy('By size');
  await expectOrder([SECRET_NAME, 'снимок.png', 'отчёт.pdf'], 'обратный порядок');
  await sortBy('By name');
  console.log('OK: поиск с путём и «ничего не найдено»; сортировка, папки выше файлов');

  // ── Вид один — список: плитки и миниатюр в строках нет; сортировка запоминается ──
  assert.equal(await cloud.getByRole('button', { name: 'Tiles' }).count(), 0, 'переключателя на плитку нет');
  assert.equal(await cloud.getByRole('button', { name: 'List' }).count(), 0, 'переключателя вида нет');
  assert.equal(await cloud.locator('[data-node-id] img').count(), 0, 'строки списка без миниатюр');
  await sortBy('By size');
  await reloadPage(page);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await openCloud();
  await expectOrder([SECRET_NAME, 'отчёт.pdf', 'снимок.png'], 'сортировка запомнена устройством');
  await sortBy('By name');
  console.log('OK: только список, сортировка запоминается');

  // ── Просмотр: фото и PDF открываются в разделе ────────────────────────────
  await item('снимок.png').click();
  const preview = page.locator('.Modal').filter({ hasText: 'снимок.png' });
  await preview.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await preview.getByRole('button', { name: 'Close', exact: true }).last().click();
  await preview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item('отчёт.pdf').click();
  const pdfPreview = page.locator('.Modal').filter({ hasText: 'отчёт.pdf' });
  await pdfPreview.locator('[data-preview-kind="pdf"] iframe').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await pdfPreview.getByRole('button', { name: 'Close', exact: true }).last().click();
  await pdfPreview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: фото и PDF открываются встроенным просмотром');

  // ── Файл больше предела: отказ до начала, на сервере ничего не остаётся ───
  const beforeBig = counts();
  await upload([{ name: 'большой.bin', mimeType: 'application/octet-stream', buffer: randomBytes(3_200_000, 3) }]);
  const failed = cloud.locator('[data-transfer-kind="upload"][data-transfer-state="failed"][data-name="большой.bin"]');
  await failed.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await failed.getByText('The file is too large.').waitFor({ state: 'visible' });
  assert.equal(await item('большой.bin').count(), 0, 'отказанный файл в списке не появился');
  assert.deepEqual(counts(), beforeBig, 'отказ до начала: на сервере ничего не изменилось');
  await failed.getByRole('button', { name: 'Cancel' }).click();
  await failed.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: файл больше предела отклонён до начала загрузки');

  // ── Сервер не видит ни имён, ни содержимого ───────────────────────────────
  const leaks = plaintextLeaks([SECRET_TEXT, SECRET_NAME, 'дневник', 'снимок.png', 'отчёт.pdf', '%PDF-1.4']);
  assert.deepEqual(leaks, [], 'в базах сервера найден открытый текст');
  console.log('OK: в базах сервера нет имён файлов и содержимого открытым текстом');

  // ── Телефон: вход и возврат нижней панелью, без горизонтальной прокрутки ─
  await sidebar.getByRole('tab', { name: 'Chats' }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  assert.equal(await isShown(page, '#FoldersSidebar'), false, 'на телефоне боковой панели нет');
  const tabBar = page.getByRole('navigation', { name: 'Sections' });
  await tabBar.getByRole('button', { name: 'Knowledge' }).click();
  await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  const box = await cloud.boundingBox();
  assert.ok(box.width >= 389 && box.x <= 1, `раздел должен занимать экран: ${JSON.stringify(box)}`);
  await tabBar.getByRole('button', { name: 'Chats' }).click();
  await cloud.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.ok(await isShown(page, '#LeftColumn'), '«Чаты» нижней панели возвращают к списку');
  console.log('OK: телефон — вход и возврат нижней панелью');

  // Встроенный просмотрщик PDF браузера живёт в своём кадре (blob:) и сам жалуется на
  // localStorage — это не код приложения
  const errors = session.errors.filter((e) => !e.includes("Failed to read the 'localStorage' property"));
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('OK: раздел «Облако» — файлы, папки, корзина, поиск, просмотр, пределы');
} catch (err) {
  if (session?.page) {
    await session.page.screenshot({ path: `${BACKEND_DIR}/cloud-failure.png` }).catch(() => undefined);
    const tail = (session.logs || []).filter((l) => l.includes('облако') || l.includes('v2:')).slice(-40);
    console.log(tail.join('\n'));
  }
  throw err;
} finally {
  await browser.close();
}
