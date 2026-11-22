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
import { execFileSync } from 'node:child_process';
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
    await item(name).getByRole('button', { name: 'File actions' }).click();
  };
  const menuAction = async (name, action) => {
    await openMenu(name);
    await page.getByRole('menuitem', { name: action, exact: true }).click();
  };
  // Кнопки шапки раздела: «Папка» (её название для доступности — 'New folder')
  const addAction = async (action) => {
    await cloud.getByRole('button', { name: action, exact: true }).click();
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
    await cloud.locator('[data-nav-place="drive"]').click();
    await page.locator('#ParvaneCloud[data-place="drive"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const trashRow = cloud.locator('[data-virtual="trash"]');
  const openTrash = async () => {
    await trashRow.click();
    await page.locator('#ParvaneCloud[data-place="trash"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const used = () => cloud.locator('footer[data-used]').getAttribute('data-used').then(Number);
  const openCloud = async () => {
    await sidebar.getByRole('tab', { name: 'Files' }).click();
    await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.waitForFunction(() => document.querySelector('#ParvaneCloud')?.dataset.loaded === '1', undefined, { timeout: STEP_TIMEOUT_MS });
  };

  // ── Раздел: кнопка в панели, вместо колонок мессенджера, пустое состояние ──
  assert.equal(await sidebar.getByRole('tab').count(), 7, 'в панели семь модулей');
  await openCloud();
  assert.equal(await isShown(page, '#LeftColumn'), false, 'список чатов должен быть скрыт');
  assert.equal(await isShown(page, '#MiddleColumn'), false, 'переписка должна быть скрыта');
  assert.equal(await sidebar.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected'), 'true');
  assert.equal(await sidebar.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected'), 'false', '«Знания» — заметки, не файлы');
  await cloud.getByText('No files yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByText('Drag files here or press Upload.').waitFor({ state: 'visible' });
  // Места — колонкой слева: диск, общие папки, доступные мне, ссылки, корзина; путь в корне — один шаг
  assert.deepEqual(await crumbs(), ['My drive'], 'в корне путь — один шаг');
  await cloud.locator('[data-virtual="shared"]').getByText('Shared with me', { exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(
    await cloud.locator('[data-cloud-nav] [data-nav-place]').evaluateAll((els) => els.map((el) => el.dataset.navPlace)),
    ['drive', 'owned', 'shared', 'links', 'trash'], 'места стоят в колонке слева',
  );
  assert.equal(await trashRow.getAttribute('data-count'), '0', 'корзина пуста');
  assert.equal(await trashRow.getAttribute('aria-selected'), 'false');
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
  assert.deepEqual(await crumbs(), ['My drive', SECRET_NAME, 'Внутри'], 'путь от корня');
  await toRoot();
  await item('данные.bin').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: папка в папке, путь, отказ пустого имени и имени со знаком /');

  // ── Переименование; совпавшее имя получает номер ──────────────────────────
  const rename = async (from, to) => {
    await menuAction(from, 'Rename');
    // Окно ставит прежнее имя при открытии; ввод, попавший до этого кадра, дописывался к нему
    // («дневник (2).txtотчёт.pdf») — поле сперва должно показать прежнее имя, после ввода — новое
    const nameInput = page.locator('#parvane-cloud-name');
    await page.waitForFunction((value) => document.querySelector('#parvane-cloud-name')?.value === value, from, {
      timeout: STEP_TIMEOUT_MS,
    });
    for (let attempt = 0; attempt < 3 && (await nameInput.inputValue()) !== to; attempt++) await nameInput.fill(to);
    assert.equal(await nameInput.inputValue(), to, `имя в окне переименования: ${await nameInput.inputValue()}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  };
  await rename('заметка.txt', 'дневник.txt');
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await item('заметка.txt').count(), 0);
  // Совпавшее имя (доска `ZdFilesX`): ошибка в поле, без номера; окно остаётся открытым
  await rename('отчёт.pdf', 'дневник.txt');
  await page.getByText('A file “дневник.txt” is already here. Choose another name.')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('.Modal.open').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#parvane-cloud-name').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item('отчёт.pdf').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Новая папка с занятым именем — так же ошибкой в поле; в окне — где появится папка
  await addAction('New folder');
  await page.locator('[data-sheet-subtitle]').getByText('in “My drive”').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('#parvane-cloud-name').fill(SECRET_NAME);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText(`A folder “${SECRET_NAME}” is already here. Choose another name.`)
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.locator('.Modal.open').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('#parvane-cloud-name').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Загрузка файла с занятым именем прежний не затирает
  await upload([{ name: 'дневник.txt', mimeType: 'text/plain', buffer: Buffer.from('второй') }]);
  await item('дневник (2).txt').waitFor({ state: 'visible', timeout: 60000 });
  await waitUploadsDone();
  console.log('OK: переименование; совпавшее имя — ошибка в поле, у загрузки — номер');

  // ── Перемещение двух выделенных ───────────────────────────────────────────
  for (const name of ['дневник.txt', 'дневник (2).txt']) {
    await item(name).hover();
    await item(name).getByRole('checkbox').click();
  }
  await cloud.getByText('Selected: 2').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByRole('toolbar').getByRole('button', { name: 'Move', exact: true }).click();
  const moveDialog = page.locator('.Modal').filter({ has: page.locator('[data-move-list]') });
  await moveDialog.getByRole('listitem').filter({ hasText: SECRET_NAME }).click();
  await moveDialog.getByRole('button', { name: 'Move here', exact: true }).click();
  await item('дневник.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).click();
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('дневник (2).txt').waitFor({ state: 'visible' });
  // Папку нельзя переместить в саму себя и во вложенную: кнопка недоступна
  await toRoot();
  await menuAction(SECRET_NAME, 'Move…');
  const folderMove = page.locator('.Modal').filter({ has: page.locator('[data-move-list]') });
  assert.ok(await folderMove.getByRole('listitem').filter({ hasText: SECRET_NAME }).isDisabled(), 'папка не может быть целью самой себя');
  // Окно переноса на компьютере (доска `ZdFilesX`): откуда переносят, пометка «здесь сейчас», подсказка про мышь
  await folderMove.locator('[data-move-subtitle]').getByText('now in “My drive”').waitFor({ state: 'visible' });
  await folderMove.getByText('You can also drag files with the mouse', { exact: false }).waitFor({ state: 'visible' });
  await folderMove.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('OK: два выделенных элемента перемещены; папку нельзя переместить в саму себя');

  // ── Дерево папок в колонке мест (доска `XdFiles`): папки корня, путь к открытой раскрыт ──
  const navTree = cloud.locator('[data-cloud-nav-tree]');
  const navFolder = (name) => navTree.locator('[data-nav-folder]').filter({ hasText: name });
  await navFolder(SECRET_NAME).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await navFolder('Внутри').count(), 0, 'вложенная папка закрытой ветки не показана');
  await navFolder(SECRET_NAME).click();
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await navFolder(SECRET_NAME).getAttribute('aria-current'), 'true', 'открытая папка подсвечена в дереве');
  await navFolder('Внутри').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.ok(
    (await navFolder('Внутри').boundingBox()).x >= (await navFolder(SECRET_NAME).boundingBox()).x,
    'вложенная папка — под своей, с отступом',
  );
  await toRoot();
  console.log('OK: дерево папок в колонке мест открывает папку и раскрывает путь');

  // ── Корзина: удалить папку с содержимым, восстановить, стереть файл навсегда ──
  await menuAction(SECRET_NAME, 'Move to trash');
  await item(SECRET_NAME).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Корзина — место в колонке слева: счётчик, под названием — срок хранения
  await cloud.locator('[data-virtual="trash"][data-count="1"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await openTrash();
  await cloud.locator('header').getByText(/^1 file · .+ · kept for 30 days$/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await names(), [SECRET_NAME], 'в корзине — папка целиком, а не её содержимое по одному');
  assert.deepEqual(await crumbs(), ['Trash'], 'путь корзины — одно место');
  // Колонка «Удалится» (доска `RdFiles`): «через 30 дней · была в «…»»; «⋯» у строки корзины нет
  await item(SECRET_NAME).getByText('in 30 days', { exact: false }).waitFor({ state: 'visible' });
  assert.equal(await item(SECRET_NAME).getByRole('button', { name: 'File actions' }).count(), 0);
  // Откуда удалено (доска `RdFiles`): «Восстановить» вернёт туда же
  await item(SECRET_NAME).getByText('was in “My drive”', { exact: false }).waitFor({ state: 'visible' });
  assert.equal(await item(SECRET_NAME).getAttribute('data-days-left'), '30', 'срок корзины — 30 дней');
  assert.equal(await cloud.getByRole('button', { name: 'Upload', exact: true }).count(), 0, 'в корзину не загружают');
  const usedInTrash = await used();
  await item(SECRET_NAME).getByRole('button', { name: 'Restore', exact: true }).click();
  await item(SECRET_NAME).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await cloud.getByText('Trash is empty').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await cloud.locator('[data-virtual="trash"][data-count="0"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
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
  await item('данные.bin').locator('[data-purge]').click();
  await page.getByText('The selected items will be deleted forever. This cannot be undone.').waitFor({ state: 'visible' });
  await page.locator('.Modal').getByRole('button', { name: 'Delete forever', exact: true }).click();
  await item('данные.bin').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  const freed = await pollUntil(() => Promise.resolve(counts()), (c) => c.driveBytes <= before.driveBytes - 1_300_000, 'блоб стёртого файла остался на сервере', 30000);
  assert.equal(freed.driveFiles, before.driveFiles - 1);
  await pollUntil(used, (n) => n <= usedInTrash - 1_300_000, 'показатель места не уменьшился', 30000);
  await toRoot();
  console.log('OK: корзина — папка с содержимым туда и обратно; окончательное удаление освобождает место');

  // ── Поиск по всем папкам (и корзине, доска `ZpFilesX`) и сортировка ────────
  const search = cloud.getByRole('searchbox');
  // Файл в корзине поиск находит строкой «Trash · deleted in N days»
  await menuAction('отчёт.pdf', 'Move to trash');
  await item('отчёт.pdf').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await search.fill('отчёт');
  await item('отчёт.pdf').getByText(/^Trash · deleted in 30 days$/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.locator('[data-search-note]').getByText('The search goes by names.', { exact: false }).waitFor({ state: 'visible' });
  await search.fill('');
  await openTrash();
  await item('отчёт.pdf').getByRole('button', { name: 'Restore', exact: true }).click();
  await item('отчёт.pdf').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await item('отчёт.pdf').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await search.fill('ДНЕВ');
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual((await names()).sort(), ['дневник (2).txt', 'дневник.txt']);
  await item('дневник.txt').getByText(`My drive / ${SECRET_NAME}`).waitFor({ state: 'visible' });
  await cloud.getByText('Found: 2 · in all folders').waitFor({ state: 'visible' });
  assert.equal(await path.count(), 0, 'пока идёт поиск, вместо пути — сколько найдено');
  await search.fill('нет такого');
  await cloud.getByText('Nothing found').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await search.fill('');
  await item('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const sortBy = async (title) => {
    // Сортировка — заголовки колонок
    await cloud.getByRole('button', { name: title, exact: true }).click();
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

  // ── Вид один — список; у картинки вместо значка миниатюра; сортировка запоминается ──
  assert.equal(await cloud.getByRole('button', { name: 'Tiles' }).count(), 0, 'переключателя на плитку нет');
  assert.equal(await cloud.getByRole('button', { name: 'List' }).count(), 0, 'переключателя вида нет');
  await item('снимок.png').locator('img[data-thumb]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Строка, смонтированная заново (смена списка), берёт адрес миниатюры у провайдера снова — счёт ждём, а не снимаем разом
  await page.waitForFunction(
    () => document.querySelectorAll('#ParvaneCloud [data-node-id] img').length === 1, undefined, { timeout: STEP_TIMEOUT_MS },
  ).catch(() => assert.fail('миниатюра — только у картинки'));
  await sortBy('By size');
  await reloadPage(page);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await openCloud();
  await expectOrder([SECRET_NAME, 'отчёт.pdf', 'снимок.png'], 'сортировка запомнена устройством');
  await sortBy('By name');
  console.log('OK: только список, сортировка запоминается');

  // ── Просмотр: фото и PDF открываются в разделе ────────────────────────────
  // Нажатие выбирает файл: его сведения и действия — в панели справа; просмотр — двойным нажатием
  await item('снимок.png').click();
  const detail = cloud.locator('[data-cloud-detail]');
  await detail.getByText('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await item('снимок.png').getAttribute('aria-current'), 'true', 'выбранная строка отмечена');
  assert.equal(await page.locator('.Modal.open').count(), 0, 'одно нажатие просмотр не открывает');
  for (const title of ['Download', 'Send to chat', 'Rename', 'Move to trash', 'Copy link']) {
    await detail.getByRole('button', { name: title, exact: true }).waitFor({ state: 'visible' });
  }
  // Меню у курсора по правой кнопке; Escape закрывает его сразу после появления
  await item('отчёт.pdf').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await cloud.waitFor({ state: 'visible' });
  console.log('OK: панель выбранного файла, меню по правой кнопке закрывается клавишей Escape');
  await item('снимок.png').dblclick();
  const preview = page.locator('.Modal').filter({ hasText: 'снимок.png' });
  await preview.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Строка клавиш (доска `XdFiles`); пробел закрывает просмотр
  await preview.getByText('Space — open and close', { exact: false }).waitFor({ state: 'visible' });
  await page.keyboard.press('Space');
  await preview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // Пробел на выбранной строке открывает просмотр
  await item('снимок.png').focus();
  await page.keyboard.press('Space');
  await preview.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await preview.getByRole('button', { name: 'Close preview', exact: true }).last().click();
  await preview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item('отчёт.pdf').dblclick();
  const pdfPreview = page.locator('.Modal').filter({ hasText: 'отчёт.pdf' });
  await pdfPreview.locator('[data-preview-kind="pdf"] iframe').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await pdfPreview.getByRole('button', { name: 'Close preview', exact: true }).last().click();
  await pdfPreview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: фото и PDF открываются встроенным просмотром');

  // ── Просмотр: текстовый файл читается на месте; для прочего — тип файла и «Скачать» ──
  await item(SECRET_NAME).click();
  await item('дневник.txt').dblclick();
  const textPreview = page.locator('.Modal').filter({ hasText: 'дневник.txt' });
  await textPreview.locator('[data-preview-kind="text"] [data-preview-text]').filter({ hasText: SECRET_TEXT })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await textPreview.locator('[data-preview-stub]').count(), 0, 'у текстового файла заглушки нет');
  await textPreview.getByRole('button', { name: 'Close preview', exact: true }).last().click();
  await textPreview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  console.log('OK: текстовый файл открывается встроенным просмотром');

  // ── Файл больше предела: отказ до начала, на сервере ничего не остаётся ───
  const beforeBig = counts();
  await upload([{ name: 'большой.bin', mimeType: 'application/octet-stream', buffer: randomBytes(3_200_000, 3) }]);
  const failed = cloud.locator('[data-transfer-kind="upload"][data-transfer-state="failed"][data-name="большой.bin"]');
  await failed.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Сбой по причине (доска `ZpFilesX`): «not uploaded: file is larger than …», без «Повторить»
  await failed.getByText(/^not uploaded: file is larger than /).waitFor({ state: 'visible' });
  // Кадр строки «файл больше предела» для сверки с досками `ZdFilesX-02`, `ZpFilesX-03`
  if (process.env.PARVANE_E2E_SHOT_DIR) {
    await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR}/cloud-too-large.png` });
  }
  assert.equal(await failed.getByRole('button', { name: 'Retry', exact: true }).count(), 0, 'большой файл не повторяют');
  assert.equal(await item('большой.bin').count(), 0, 'отказанный файл в списке не появился');
  assert.deepEqual(counts(), beforeBig, 'отказ до начала: на сервере ничего не изменилось');
  await failed.getByRole('button', { name: 'Remove', exact: true }).click();
  await failed.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: файл больше предела отклонён до начала загрузки');

  // ── Сервер не видит ни имён, ни содержимого ───────────────────────────────
  const leaks = plaintextLeaks([SECRET_TEXT, SECRET_NAME, 'дневник', 'снимок.png', 'отчёт.pdf', '%PDF-1.4']);
  assert.deepEqual(leaks, [], 'в базах сервера найден открытый текст');
  console.log('OK: в базах сервера нет имён файлов и содержимого открытым текстом');

  // ── Видео: миниатюра из кадра при загрузке (4 ноя 2026 — у видео превью не было) ─
  // Playwright-Chromium без H.264 — VP9-in-MP4, как e2e_web_media_kinds
  const videoPath = `${BACKEND_DIR}/e2e-cloud-video.mp4`;
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', videoPath,
  ], { stdio: 'ignore' });
  await upload([{ name: 'ролик.mp4', mimeType: 'video/mp4', buffer: readFileSync(videoPath) }]);
  await item('ролик.mp4').waitFor({ state: 'visible', timeout: 60000 });
  await item('ролик.mp4').locator('img[data-thumb]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: у загруженного видео — миниатюра из кадра');

  // ── Перетаскивание (spec 041 E2, доски `ZdMisc`, `XdFiles`) ────────────────
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  // Файл с компьютера: поверх раздела — «Отпустите, чтобы загрузить в …», отпущенный ложится в открытую папку
  const dropData = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['перетащено мышью'], 'перетащенный.txt', { type: 'text/plain' }));
    return data;
  });
  await cloud.dispatchEvent('dragenter', { dataTransfer: dropData });
  const zone = cloud.locator('[data-cloud-drop-zone]');
  await zone.getByText('Release to upload to “My drive”').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await zone.getByText('1 file · encrypted on this device').waitFor({ state: 'visible' });
  if (shotDir) await page.screenshot({ path: `${shotDir}/files-drop-zone.png` });
  await cloud.dispatchEvent('drop', { dataTransfer: dropData });
  // Размер браузер даёт только при отпускании: зона ещё мгновение стоит с ним
  await zone.getByText(/^1 file · .+ · encrypted on this device$/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await zone.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: 60000 });
  await waitUploadsDone();
  // Строка на папку списка: перенос, подсказка называет папку; ступень пути принимает обратно. События HTML5 —
  // своими `dispatchEvent`: при перетаскивании мышью Playwright-Chromium не рисует кадры до отпускания
  const dragTo = async (name, target, hint) => {
    const data = await page.evaluateHandle(() => new DataTransfer());
    await item(name).dispatchEvent('dragstart', { dataTransfer: data });
    await target.dispatchEvent('dragover', { dataTransfer: data });
    await cloud.locator('[data-cloud-drag-hint]').getByText(hint).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    if (shotDir && name === 'перетащенный.txt') await page.screenshot({ path: `${shotDir}/files-drag-row.png` });
    await target.dispatchEvent('drop', { dataTransfer: data });
    await item(name).dispatchEvent('dragend', { dataTransfer: data }).catch(() => undefined);
  };
  await dragTo('перетащенный.txt', item(SECRET_NAME), `Drag onto a folder — “${SECRET_NAME}”`);
  await item('перетащенный.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await cloud.locator('[data-cloud-drag-hint]').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).click();
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dragTo('перетащенный.txt', path.getByRole('button', { name: 'My drive' }), 'Drag onto a folder — “My drive”');
  await item('перетащенный.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // На любую папку дерева слева (доска `XdFiles`), не только на «Мой диск»
  await dragTo('перетащенный.txt', navFolder(SECRET_NAME), `Drag onto a folder on the left — “${SECRET_NAME}”`);
  await item('перетащенный.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await navFolder(SECRET_NAME).click();
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: файл с компьютера загружен перетаскиванием; строка перенесена на папку списка, путь и дерево');

  // ── «Новая папка» прямо в окне переноса: создаётся и сразу выбрана ──────────
  await menuAction('перетащенный.txt', 'Move…');
  const newFolderMove = page.locator('.Modal').filter({ has: page.locator('[data-move-list]') });
  await newFolderMove.locator('[data-move-new-folder]').click();
  await newFolderMove.locator('[data-move-name-form] input').fill('Из окна');
  await newFolderMove.locator('[data-move-name-form]').getByRole('button', { name: 'Create', exact: true }).click();
  const madeRow = newFolderMove.getByRole('listitem').filter({ hasText: 'Из окна' });
  await madeRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await madeRow.getAttribute('aria-current'), 'true', 'новая папка сразу выбрана');
  await newFolderMove.getByRole('button', { name: 'Move here', exact: true }).click();
  await item('перетащенный.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await item('Из окна').click();
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Обратно в корень — дальше сценарий берёт файл оттуда
  await menuAction('перетащенный.txt', 'Move…');
  await newFolderMove.getByRole('listitem').filter({ hasText: 'My drive' }).click();
  await newFolderMove.getByRole('button', { name: 'Move here', exact: true }).click();
  await item('перетащенный.txt').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await toRoot();
  await item('перетащенный.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: новая папка из окна переноса — в корне диска, файл в ней');
  if (shotDir) {
    await item('перетащенный.txt').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Make a copy', exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await page.screenshot({ path: `${shotDir}/files-menu.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem').first().waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  }

  // ── «Сделать копию»: файл и папка рядом с собой, имя с номером ────────────
  await menuAction('перетащенный.txt', 'Make a copy');
  await item('перетащенный (2).txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  assert.equal((await downloadOf('перетащенный (2).txt')).toString(), 'перетащено мышью', 'копия совпадает с файлом');
  await menuAction(SECRET_NAME, 'Make a copy');
  await item(`${SECRET_NAME} (2)`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await item(`${SECRET_NAME} (2)`).click();
  await item('дневник.txt').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('Внутри').waitFor({ state: 'visible' });
  await toRoot();
  await item(SECRET_NAME).waitFor({ state: 'visible' });
  console.log('OK: копия файла и папки с содержимым');

  // ── «Вложить в заметку…»: файл встаёт в конец заметки вложением ───────────
  const knowledge = page.locator('#ParvaneKnowledge');
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  // Хранилище со справкой создаётся при первом открытии «Заметок»
  // Заметки справки пишутся по одной — вложение ждёт, пока их запишут все двенадцать
  await page.waitForFunction(() => document.querySelectorAll('#ParvaneKnowledge [data-note-row]').length === 12,
    undefined, { timeout: 60000 });
  await openCloud();
  await menuAction('перетащенный.txt', 'Attach to a note…');
  const notePick = page.locator('[data-cloud-note-list]');
  const noteTitle = 'Overview';
  await notePick.locator(`[data-cloud-note="${noteTitle}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (shotDir) await page.screenshot({ path: `${shotDir}/files-attach-note.png` });
  await page.locator('[data-cloud-note-search]').fill('overview');
  // Совпавшая названием заметка — первой (остальные справки упоминают «Overview» в тексте)
  await page.waitForFunction(() => document.querySelector('[data-cloud-note-list] [data-cloud-note]')
    ?.getAttribute('data-cloud-note') === 'Overview', undefined, { timeout: STEP_TIMEOUT_MS });
  await notePick.locator(`[data-cloud-note="${noteTitle}"]`).click();
  await page.getByText(`Attached to “${noteTitle}”`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await notePick.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await sidebar.getByRole('tab', { name: 'Notes' }).click();
  await knowledge.locator(`[data-note-row="${noteTitle}"]`).click();
  const openedNote = knowledge.locator('[data-note-id]');
  await openedNote.getByRole('button', { name: 'Edit' }).first().click();
  await page.waitForFunction(() => document.querySelector('#knowledge-note-editor')?.value
    .trimEnd().endsWith('![[перетащенный.txt]]'), undefined, { timeout: STEP_TIMEOUT_MS });
  await openedNote.getByRole('button', { name: 'Save' }).first().click();
  await openCloud();
  console.log('OK: файл вложен в заметку');

  // ── Телефон: вход и возврат нижней панелью, без горизонтальной прокрутки ─
  await sidebar.getByRole('tab', { name: 'Chats' }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  assert.equal(await isShown(page, '#FoldersSidebar'), false, 'на телефоне боковой панели нет');
  const tabBar = page.getByRole('navigation', { name: 'Modules' });
  await tabBar.getByRole('button', { name: 'Files' }).click();
  await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на телефоне: ${overflow}`);
  const box = await cloud.boundingBox();
  assert.ok(box.width >= 389 && box.x <= 1, `раздел должен занимать экран: ${JSON.stringify(box)}`);
  // Места — чипами под шапкой; панели выбранного файла нет: нажатие сразу открывает тёмный просмотр на весь экран
  // Корзина на телефоне — свой экран: «‹ Корзина» без чипов, «Очистить» в шапке (доска `PhFilesMore`)
  await cloud.locator('[data-virtual="trash"]').click();
  await page.locator('#ParvaneCloud[data-place="trash"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cloud.locator('[data-cloud-nav]').count(), 0, 'у корзины телефона чипов мест нет');
  await cloud.locator('[data-cloud-back]').click();
  await page.locator('#ParvaneCloud[data-place="drive"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Поиск на телефоне — экран «‹ Файлы / поиск» с полем и «Порядок» (доска `ZpFilesX`)
  await cloud.locator('[data-section-search-open]').click();
  await cloud.getByText('search', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByText('Order', { exact: true }).waitFor({ state: 'visible' });
  await cloud.getByRole('button', { name: 'By date', exact: true }).getByText('Date', { exact: true }).waitFor({ state: 'visible' });
  await cloud.getByRole('searchbox').fill('снимок');
  await item('снимок.png').getByText(/^My drive · /).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.locator('[data-cloud-back]').click();
  await cloud.locator('[data-cloud-nav]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await item('снимок.png').click();
  const phonePreview = page.locator('.Modal').filter({ hasText: 'снимок.png' });
  await phonePreview.locator('[data-preview-kind="photo"] img').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cloud.locator('[data-cloud-detail]').count(), 0, 'на телефоне панели файла нет');
  const previewBox = await phonePreview.locator('.modal-dialog').boundingBox();
  assert.ok(previewBox.width >= 389 && previewBox.height >= 799, `просмотр на весь экран: ${JSON.stringify(previewBox)}`);
  await phonePreview.getByRole('button', { name: 'To chat', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await phonePreview.getByText('Space — open and close', { exact: false }).count(), 0, 'подсказки клавиш на телефоне нет');
  await phonePreview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await phonePreview.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  // «⋯» — шторка во всю ширину с названием файла
  await item('снимок.png').getByRole('button', { name: 'File actions' }).click();
  const sheetBox = await page.locator('.Modal.open .modal-dialog').boundingBox();
  assert.ok(sheetBox.width >= 389, `шторка действий во всю ширину: ${JSON.stringify(sheetBox)}`);
  await page.keyboard.press('Escape');
  await page.locator('.Modal.open').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: телефон — места чипами, просмотр на весь экран, шторка действий');
  // Перенос на телефоне — папка за папкой (доска `XpFiles`): путь сверху, стрелка — внутрь, «Новая папка» внизу
  await item('снимок.png').getByRole('button', { name: 'File actions' }).click();
  await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
  const stepMove = page.locator('.Modal').filter({ has: page.locator('[data-move-path]') });
  await stepMove.locator('[data-move-path]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  if (shotDir) await page.screenshot({ path: `${shotDir}/files-move-steps.png` });
  // Файл уже здесь — переносить некуда (кнопка недоступна, когда окно дочитало место переносимого)
  await stepMove.locator('button[aria-label="Move here"][disabled]').waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS });
  await stepMove.locator('[data-sheet-subtitle]').getByText('снимок.png').waitFor({ state: 'visible' });
  await stepMove.getByRole('button', { name: 'Cancel', exact: true }).first().waitFor({ state: 'visible' });
  assert.deepEqual(await stepMove.locator('[data-move-path] button').allInnerTexts(), ['My drive']);
  assert.ok(await stepMove.locator('[data-move-open]').count() > 0, 'на телефоне — шаги со стрелкой внутрь');
  await stepMove.locator(`[data-move-open="${SECRET_NAME}"]`).click();
  await stepMove.locator('[data-move-path] button').filter({ hasText: SECRET_NAME }).waitFor({ state: 'visible' });
  assert.deepEqual(await stepMove.locator('[data-move-path] button').allInnerTexts(), ['My drive', SECRET_NAME]);
  await stepMove.getByRole('listitem').filter({ hasText: 'Внутри' }).waitFor({ state: 'visible' });
  await stepMove.locator('[data-move-new-folder]').click();
  await stepMove.locator('[data-move-name-form] input').fill('С телефона');
  await stepMove.locator('[data-move-name-form]').getByRole('button', { name: 'Create', exact: true }).click();
  await stepMove.getByRole('button', { name: 'Move here', exact: true }).getByText('“С телефона”', { exact: false })
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await stepMove.getByRole('button', { name: 'Move here', exact: true }).click();
  await item('снимок.png').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await item(SECRET_NAME).click();
  await item('С телефона').click();
  await item('снимок.png').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.locator('[data-nav-place="drive"]').click();
  console.log('OK: телефон — перенос папка за папкой, новая папка из окна');
  await tabBar.getByRole('button', { name: 'Chats' }).click();
  // Раздел после первого показа остаётся смонтированным и скрывается (E1): ждём `hidden`, не `detached`
  await cloud.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
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
    const tail = (session.logs || []).slice(-100);
    console.log(tail.join('\n'));
  }
  throw err;
} finally {
  await browser.close();
}
