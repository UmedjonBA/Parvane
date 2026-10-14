// Ссылка на файлы облака для людей без аккаунта (spec 022). Владелец создаёт
// ссылку на файл и на папку с вложенными; посетитель в НОВОМ контексте браузера
// без входа открывает публичную страницу `/s/<id>#k=<ключ>`: название, дерево,
// просмотр текста, скачивание байт в байт. Ссылка без `#k` и с чужим ключом
// ничего не показывает; исходники переименованы и стёрты — по ссылке прежнее
// (снимок); «Мои ссылки» — строки, размер, продление; отзыв — страница «не
// найдена», место вернулось; на сервере нет ни названий, ни ключа ссылки.
// Запуск: scripts/run_web_cloud_links_e2e.sh
import assert from 'node:assert/strict';
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import { buildPngBuffer, dismissRecoveryKeyDialog, preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-links-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
const LINK_TIMEOUT_MS = 60000;
const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
// Снимки для проверки вида глазами
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR;
assert.ok(BASE_URL && GATEWAY_URL, 'нужны PARVANE_E2E_BASE_URL и PARVANE_E2E_GATEWAY_URL');
assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (каталог баз стенда)');

const FILE_NAME = 'Секретный снимок 4c1e.bin';
const NOTE_NAME = 'записка.txt';
const FOLDER_NAME = 'Альбом 9d2f';
const INNER_NAME = 'внутри.txt';
const SUB_NAME = 'Вложенная';
const DEEP_NAME = 'глубоко.txt';
const PHOTO_NAME = 'фото 2b7c.png';
const NOTE_TEXT = 'Текст записки для ссылки 5a7b';
const INNER_TEXT = 'Содержимое файла в папке 3e8d';
const DEEP_TEXT = 'Содержимое вложенного файла 6f0a';
const URL_RE = /\/s\/([A-Za-z0-9_-]{16,32})#k=([A-Za-z0-9_-]{43})$/;

function pseudoRandom(length, seed) {
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

/** Места в базах шарда cloud, где встречается одно из слов (все таблицы и столбцы). */
function serverLeaks(words) {
  const found = [];
  for (const file of readdirSync(BACKEND_DIR).filter((name) => /^cloud.*\.db$/.test(name))) {
    const db = new DatabaseSync(`${BACKEND_DIR}/${file}`, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      for (const table of tables) {
        for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
          for (const value of Object.values(row)) {
            if (value === null || typeof value === 'number' || typeof value === 'bigint') continue;
            const bytes = Buffer.from(value);
            const texts = [bytes.toString('latin1'), bytes.toString('utf8')];
            for (const word of words) {
              if (texts.some((text) => text.includes(word))) found.push(`${file}/${table}: ${word}`);
            }
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return found;
}

/** Файлы архива «Скачать всё» по оглавлению (ZIP без сжатия): имя → байты. */
function readStoredZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'конец архива');
  const files = new Map();
  let at = bytes.readUInt32LE(end + 16);
  for (let i = bytes.readUInt16LE(end + 10); i > 0; i--) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50, 'запись оглавления');
    assert.equal(bytes.readUInt16LE(at + 10), 0, 'без сжатия');
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.set(name, bytes.subarray(data, data + size));
    at += 46 + nameLength;
  }
  return files;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE, acceptDownloads: true });
let session;
let visitorPage;

/** Посетитель без аккаунта: новый контекст браузера, ни входа, ни хранилищ приложения. */
async function openAsVisitor(url) {
  const visitor = await browser.newContext({ viewport: WIDE, acceptDownloads: true, locale: 'en-US' });
  // Адрес gateway стенда: публичная страница читает его только в диагностической сборке
  await visitor.addInitScript((gatewayUrl) => {
    localStorage.setItem('parvane:gateway', gatewayUrl);
  }, GATEWAY_URL);
  const page = await visitor.newPage();
  const sockets = [];
  const errors = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url);
  visitorPage = page;
  const root = page.locator('[data-link-page]');
  const waitState = async (state) => {
    await page.locator(`[data-link-page][data-state="${state}"]`).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const fileRow = (path) => page.locator(`[data-file-path="${path}"]`);
  const download = async (path) => {
    const [got] = await Promise.all([
      page.waitForEvent('download', { timeout: LINK_TIMEOUT_MS }),
      fileRow(path).locator('[data-download]').click(),
    ]);
    return { name: got.suggestedFilename(), bytes: readFileSync(await got.path()) };
  };
  return {
    page, root, sockets, errors, waitState, fileRow, download, close: () => visitor.close(),
  };
}

try {
  const user = `links-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const drive = cloudDriver(page);
  const { cloud } = drive;
  const sheet = page.locator('[data-cloud-link-sheet]');
  const usage = cloud.locator('footer[data-used]');
  const used = () => usage.getAttribute('data-used').then(Number);
  const linksBytes = () => usage.getAttribute('data-links-bytes').then(Number);
  const createFolder = async (name) => {
    await drive.add('New folder');
    await page.locator('#parvane-cloud-name').fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await drive.item(name).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  };
  const closeSheet = async () => {
    await page.locator('.Modal.open').getByRole('button', { name: 'Close', exact: true }).click();
    await sheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  };
  /** Создать ссылку из меню узла; возвращает полный адрес. */
  const createLink = async (name, ttlDays) => {
    await drive.menu(name, 'Link…');
    await sheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await sheet.locator('[data-link-create]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    assert.equal(
      await sheet.locator('[data-link-ttl="7"]').getAttribute('aria-pressed'), 'true', 'срок по умолчанию — 7 дней',
    );
    assert.deepEqual(
      await sheet.locator('[data-link-ttl]').evaluateAll((els) => els.map((el) => el.dataset.linkTtl)),
      ['1', '7', '30', '0'], 'сроки: 1 / 7 / 30 дней / без срока',
    );
    if (ttlDays !== 7) await sheet.locator(`[data-link-ttl="${ttlDays}"]`).click();
    await sheet.locator('[data-link-create]').click();
    await sheet.locator('[data-link-url]').waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await sheet.locator('[data-link-block][data-link-state="active"]').waitFor({ state: 'visible' });
    return (await sheet.locator('[data-link-url]').innerText()).trim();
  };

  // ── Исходники: файл, текст, папка с файлом и вложенной папкой ─────────────
  await drive.open();
  const fileBytes = pseudoRandom(700 * 1024, 20221013);
  await cloud.locator('input[type="file"]').setInputFiles([
    { name: FILE_NAME, mimeType: 'application/octet-stream', buffer: fileBytes },
    { name: NOTE_NAME, mimeType: 'text/plain', buffer: Buffer.from(NOTE_TEXT) },
  ]);
  await drive.item(FILE_NAME).waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await drive.item(NOTE_NAME).waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await createFolder(FOLDER_NAME);
  await drive.item(FOLDER_NAME).click();
  await drive.upload(INNER_NAME, INNER_TEXT);
  const photoBytes = buildPngBuffer(96, [0x30, 0x80, 0xc0]);
  await cloud.locator('input[type="file"]').setInputFiles([
    { name: PHOTO_NAME, mimeType: 'image/png', buffer: photoBytes },
  ]);
  await drive.item(PHOTO_NAME).locator('img[data-thumb]').waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await createFolder(SUB_NAME);
  await drive.item(SUB_NAME).click();
  await drive.upload(DEEP_NAME, DEEP_TEXT);
  await drive.root();
  await cloud.locator('[data-virtual="links"]').getByText('No links yet').waitFor({ state: 'visible' });
  const usedBefore = await pollUntil(used, (n) => n > fileBytes.length, 'занятое место после загрузок');
  assert.equal(await linksBytes(), 0, 'ссылок ещё нет');
  console.log('OK: исходники загружены');

  // ── Ссылка на файл: срок, подготовка, адрес с ключом во фрагменте ─────────
  const fileUrl = await createLink(FILE_NAME, 1);
  assert.ok(fileUrl.startsWith(`${BASE_URL}/s/`), `адрес ссылки: ${fileUrl}`);
  const [, fileLinkId, fileLinkKey] = fileUrl.match(URL_RE) || [];
  assert.ok(fileLinkId && fileLinkKey, `адрес ссылки не по контракту: ${fileUrl}`);
  await sheet.locator('[data-link-copy]').click();
  await sheet.locator('[data-link-copy]').getByText('Copied').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sheet.getByText(/^Valid until /).waitFor({ state: 'visible' });
  await closeSheet();
  // Шторка того же файла снова показывает готовую ссылку, а не предлагает создать вторую
  await drive.menu(FILE_NAME, 'Link…');
  assert.equal((await sheet.locator('[data-link-url]').innerText()).trim(), fileUrl);
  assert.equal(await sheet.locator('[data-link-create]').count(), 0);
  await closeSheet();
  const fileCopyBytes = await pollUntil(linksBytes, (n) => n > fileBytes.length, 'место копий ссылки');
  const usedWithLink = await pollUntil(used, (n) => n >= usedBefore + fileCopyBytes, 'копия занимает место владельца');
  await usage.getByText(/Links: /).waitFor({ state: 'visible' });
  if (SHOT_DIR) await session.page.screenshot({ path: `${SHOT_DIR}/links-sheet.png` });
  console.log('OK: ссылка на файл создана, копия учтена в занятом месте');

  // ── Посетитель без аккаунта: название, скачивание байт в байт ─────────────
  let visitor = await openAsVisitor(fileUrl);
  await visitor.waitState('ready');
  assert.ok(visitor.page.url().includes(`/s.html?id=${fileLinkId}#k=${fileLinkKey}`), 'адрес переведён на страницу, ключ остался');
  assert.equal(await visitor.page.locator('[data-link-name]').innerText(), FILE_NAME);
  await visitor.page.getByText('parvane', { exact: true }).waitFor({ state: 'visible' });
  await visitor.page.getByText(/link valid until /).waitFor({ state: 'visible' });
  assert.equal(await visitor.page.locator('[data-file-path]').count(), 1);
  // Картинка и текст смотрятся на странице, остальное — только скачивается
  assert.equal(await visitor.fileRow(FILE_NAME).locator('[data-view]').count(), 0);
  const fromLink = await visitor.download(FILE_NAME);
  assert.equal(fromLink.name, FILE_NAME);
  assert.equal(sha256(fromLink.bytes), sha256(fileBytes), 'скачанное по ссылке отличается от исходного');
  // Ключ ссылки серверу не уходит: в адресах соединений его нет; в хранилища страница не пишет
  assert.ok(visitor.sockets.length > 0 && visitor.sockets.every((url) => !url.includes(fileLinkKey)));
  assert.deepEqual(
    await visitor.page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage))),
    ['parvane:gateway'], 'страница ничего не пишет в хранилища (адрес gateway положил сценарий)',
  );
  assert.equal(await visitor.page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), 0);
  assert.equal(await visitor.page.evaluate(() => document.querySelector('meta[name="referrer"]')?.content), 'no-referrer');
  assert.deepEqual(visitor.errors, [], `ошибки публичной страницы: ${visitor.errors.join('; ')}`);
  await visitor.close();
  console.log('OK: посетитель без аккаунта видит название и скачивает файл байт в байт');

  // ── Без ключа и с чужим ключом — ничего ───────────────────────────────────
  visitor = await openAsVisitor(`${BASE_URL}/s/${fileLinkId}`);
  await visitor.waitState('incomplete');
  await visitor.page.getByText('The link is incomplete').waitFor({ state: 'visible' });
  assert.equal(visitor.sockets.length, 0, 'без ключа страница к серверу не обращается');
  assert.ok(!(await visitor.root.innerText()).includes(FILE_NAME));
  await visitor.close();
  const strangerKey = cryptoRandomBytes(32).toString('base64url');
  visitor = await openAsVisitor(`${BASE_URL}/s/${fileLinkId}#k=${strangerKey}`);
  await visitor.waitState('incomplete');
  assert.ok(!(await visitor.root.innerText()).includes(FILE_NAME), 'с чужим ключом названий нет');
  assert.equal(await visitor.page.locator('[data-file-path]').count(), 0);
  await visitor.close();
  visitor = await openAsVisitor(`${BASE_URL}/s/${'A'.repeat(22)}#k=${strangerKey}`);
  await visitor.waitState('not-found');
  await visitor.page.getByText('The link is not found or has been revoked').waitFor({ state: 'visible' });
  await visitor.close();
  console.log('OK: без ключа и с чужим ключом страница ничего не показывает');

  // ── Снимок: исходник переименован и стёрт — по ссылке прежнее ─────────────
  await drive.menu(FILE_NAME, 'Rename');
  await page.locator('#parvane-cloud-name').fill('другое имя.bin');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await drive.item('другое имя.bin').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await drive.menu('другое имя.bin', 'Move to trash');
  await drive.item('другое имя.bin').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await drive.openTrash();
  await drive.menu('другое имя.bin', 'Delete forever');
  await page.locator('.Modal').getByRole('button', { name: 'Delete forever', exact: true }).click();
  await drive.item('другое имя.bin').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await drive.root();
  // Блоб исходника стёрт сборкой: занятое место упало до одной копии ссылки (и мелких файлов)
  await pollUntil(used, (n) => n < usedWithLink, 'место исходника освобождено', LINK_TIMEOUT_MS);
  visitor = await openAsVisitor(fileUrl);
  await visitor.waitState('ready');
  assert.equal(await visitor.page.locator('[data-link-name]').innerText(), FILE_NAME, 'название — как в момент создания');
  assert.equal(sha256((await visitor.download(FILE_NAME)).bytes), sha256(fileBytes), 'снимок не зависит от исходника');
  await visitor.close();
  console.log('OK: после переименования и удаления исходника по ссылке прежнее');

  // ── Ссылка на папку: структура, сворачивание, просмотр текста ─────────────
  const folderUrl = await createLink(FOLDER_NAME, 7);
  const [, folderLinkId] = folderUrl.match(URL_RE) || [];
  assert.ok(folderLinkId && folderLinkId !== fileLinkId);
  await closeSheet();
  visitor = await openAsVisitor(folderUrl);
  await visitor.waitState('ready');
  assert.equal(await visitor.page.locator('[data-link-name]').innerText(), FOLDER_NAME);
  assert.equal(await visitor.page.locator('#content').getAttribute('data-link-kind'), 'folder');
  assert.equal(await visitor.page.locator('#content').getAttribute('data-link-files'), '3');
  assert.deepEqual(
    await visitor.page.locator('[data-dir-path]').evaluateAll((els) => els.map((el) => el.dataset.dirPath)),
    [SUB_NAME], 'вложенная папка на месте',
  );
  assert.deepEqual(
    await visitor.page.locator('[data-file-path]').evaluateAll((els) => els.map((el) => el.dataset.filePath).sort()),
    [`${SUB_NAME}/${DEEP_NAME}`, INNER_NAME, PHOTO_NAME].sort(), 'файлы — с путями относительно корня ссылки',
  );
  const deepRow = visitor.fileRow(`${SUB_NAME}/${DEEP_NAME}`);
  const dirToggle = visitor.page.locator(`[data-dir-path="${SUB_NAME}"] > button`);
  await dirToggle.click();
  await deepRow.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await dirToggle.click();
  await deepRow.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await deepRow.locator('[data-view]').click();
  await deepRow.locator('[data-preview] pre').waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  assert.equal(await deepRow.locator('[data-preview] pre').innerText(), DEEP_TEXT);
  assert.equal((await visitor.download(INNER_NAME)).bytes.toString(), INNER_TEXT);
  // Миниатюра картинки — копией в ссылке, расшифрована на странице
  await visitor.fileRow(PHOTO_NAME).locator('.tile.has-thumb img.thumb')
    .waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  assert.ok(
    await visitor.fileRow(PHOTO_NAME).locator('img.thumb').evaluate((img) => img.naturalWidth > 0),
    'миниатюра открылась картинкой',
  );
  assert.equal(await visitor.fileRow(INNER_NAME).locator('img.thumb').count(), 0, 'у текста миниатюры нет');
  // «Скачать всё» — один ZIP со всеми файлами по путям и пустыми папками
  const [archive] = await Promise.all([
    visitor.page.waitForEvent('download', { timeout: LINK_TIMEOUT_MS }),
    visitor.page.locator('[data-download-all]').click(),
  ]);
  assert.equal(archive.suggestedFilename(), `${FOLDER_NAME}.zip`);
  const zipped = readStoredZip(readFileSync(await archive.path()));
  assert.equal(zipped.get(INNER_NAME)?.toString(), INNER_TEXT);
  assert.equal(zipped.get(`${SUB_NAME}/${DEEP_NAME}`)?.toString(), DEEP_TEXT);
  assert.ok(zipped.get(PHOTO_NAME)?.equals(photoBytes), 'картинка в архиве байт в байт');
  assert.ok(zipped.has(`${SUB_NAME}/`), 'папка в архиве');
  await visitor.page.locator('.download-all[data-download-state="done"]').waitFor({ state: 'attached' });
  assert.deepEqual(visitor.errors, [], `ошибки публичной страницы: ${visitor.errors.join('; ')}`);
  await visitor.close();
  if (SHOT_DIR && visitorPage && !visitorPage.isClosed()) await visitorPage.screenshot({ path: `${SHOT_DIR}/links-page.png` });
  console.log('OK: ссылка на папку — структура, сворачивание, просмотр, миниатюра, скачивание файла и всей папки ZIP');

  // ── «Мои ссылки»: строки, размер, полный адрес, продление ─────────────────
  await cloud.locator('[data-virtual="links"]').getByText('Links: 2').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await drive.virtual('links').click();
  await page.locator('#ParvaneCloud[data-place="links"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.deepEqual(await drive.crumbs(), ['Cloud', 'My links']);
  const row = (id) => cloud.locator(`[data-link-row="${id}"]`);
  await row(fileLinkId).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cloud.locator('[data-link-row]').count(), 2);
  assert.equal(await row(fileLinkId).getAttribute('data-name'), FILE_NAME, 'название — из записи владельца');
  assert.equal(await row(folderLinkId).getAttribute('data-name'), FOLDER_NAME);
  assert.equal(await row(fileLinkId).getAttribute('data-link-state'), 'active');
  assert.equal(Number(await row(fileLinkId).getAttribute('data-bytes')), fileCopyBytes, 'размер строки — размер копий');
  assert.ok(Number(await row(folderLinkId).getAttribute('data-bytes')) > 0);
  await row(fileLinkId).getByText(/File · created .+ · until .+/).waitFor({ state: 'visible' });
  await row(folderLinkId).getByText(/Folder · created /).waitFor({ state: 'visible' });
  await row(fileLinkId).click();
  await sheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal((await sheet.locator('[data-link-url]').innerText()).trim(), fileUrl, 'полный адрес собирается заново');
  const termBefore = Number(await sheet.locator('[data-link-term]').getAttribute('data-link-term'));
  await sheet.locator('[data-link-extend]').click();
  await sheet.locator('[data-link-ttl="30"]').click();
  await pollUntil(
    () => sheet.locator('[data-link-term]').getAttribute('data-link-term').then(Number),
    (n) => n > termBefore + 20 * 24 * 3600, 'срок продлён на 30 дней',
  );
  await sheet.locator('[data-link-extend]').click();
  await sheet.locator('[data-link-ttl="0"]').click();
  await sheet.getByText(/^Valid with no expiry/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Как увидит получатель» открывает тот же адрес в новой вкладке
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: STEP_TIMEOUT_MS }),
    sheet.locator('[data-link-preview]').click(),
  ]);
  await popup.locator('[data-link-page][data-state="ready"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(await popup.locator('[data-link-name]').innerText(), FILE_NAME);
  await popup.close();
  if (SHOT_DIR) await session.page.screenshot({ path: `${SHOT_DIR}/links-list.png` });
  console.log('OK: «Мои ссылки» — строки, размер, адрес, продление, «Как увидит получатель»');

  // ── На сервере нет ни названий, ни ключа ссылки ───────────────────────────
  assert.deepEqual(
    serverLeaks([FILE_NAME, FOLDER_NAME, INNER_NAME, DEEP_NAME, DEEP_TEXT, fileLinkKey]), [],
    'названия и ключ ссылки не должны лежать на сервере открытым текстом',
  );

  // ── Отзыв: страница «не найдена», место вернулось ─────────────────────────
  const usedBeforeRevoke = await used();
  await sheet.locator('[data-link-revoke]').click();
  await page.locator('.Modal.confirm').getByRole('button', { name: 'Revoke', exact: true }).click();
  await sheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  await row(fileLinkId).waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  assert.equal(await cloud.locator('[data-link-row]').count(), 1);
  await pollUntil(used, (n) => n <= usedBeforeRevoke - fileCopyBytes, 'место копий возвращено', LINK_TIMEOUT_MS);
  await pollUntil(linksBytes, (n) => n > 0 && n < fileCopyBytes, 'в ссылках осталась только папка');
  visitor = await openAsVisitor(fileUrl);
  await visitor.waitState('not-found');
  assert.ok(!(await visitor.root.innerText()).includes(FILE_NAME), 'после отзыва названия нет');
  await visitor.close();
  // Вторая ссылка жива
  visitor = await openAsVisitor(folderUrl);
  await visitor.waitState('ready');
  await visitor.close();
  console.log('OK: отзыв — страница «не найдена», место вернулось, другая ссылка работает');

  // ── Последняя ссылка отозвана — список пуст ───────────────────────────────
  await row(folderLinkId).click();
  await sheet.locator('[data-link-revoke]').click();
  await page.locator('.Modal.confirm').getByRole('button', { name: 'Revoke', exact: true }).click();
  await cloud.getByText('You have not created any links yet').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pollUntil(linksBytes, (n) => n === 0, 'копий ссылок не осталось', LINK_TIMEOUT_MS);

  const errors = session.errors.filter((e) => !e.includes("Failed to read the 'localStorage' property"));
  assert.deepEqual(errors, [], `ошибки страницы: ${errors.join('; ')}`);
  console.log('OK: ссылки облака для людей без аккаунта — создание, публичная страница, снимок, список, отзыв');
} catch (err) {
  if (session?.page) {
    await session.page.screenshot({ path: `${BACKEND_DIR}/cloud-links-failure.png` }).catch(() => undefined);
    const tail = (session.logs || []).filter((l) => l.includes('облако') || l.includes('v2:')).slice(-40);
    console.log(tail.join('\n'));
  }
  if (visitorPage && !visitorPage.isClosed()) {
    await visitorPage.screenshot({ path: `${BACKEND_DIR}/cloud-links-visitor-failure.png` }).catch(() => undefined);
  }
  throw err;
} finally {
  await browser.close();
}
