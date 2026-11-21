// PWA (spec 041 F1): установка, запуск без сети и обновление после выкладки. Сборку раздаёт свой сервер
// (`e2e_static_site.mjs` — как Caddy на проде: настоящий 404 в `/assets/`, заголовки кэша), потому что выкладка
// второй сборки поверх общей `dist` сломала бы соседние сценарии.
//   1. манифест разбирается без ошибок, браузер считает приложение устанавливаемым (CDP);
//   2. сервис-воркер управляет страницей и кладёт в кэш всю оболочку (список `precache.json`);
//   3. без сети после перезагрузки: список чатов и переписка, «План», «Заметки», ни разу не открытый модуль;
//   4. сеть вернулась — приходит написанное за это время;
//   5. выкладка второй сборки (другие имена частей кода, прежних файлов на сервере нет): открытая вкладка
//      догружает свои части из кэша, новая вкладка и перезагрузка получают новую версию, новая оболочка
//      скачивается целиком и работает без сети, устаревшее из кэша убрано.
// Запуск: scripts/run_web_pwa_offline_e2e.sh (вторая сборка — PARVANE_E2E_PWA_NEXT_DIST)
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, exchangeMessages, findMessage, preparePage, sendText, waitForChatList,
} from './e2e_web_helpers.mjs';
import { readBuild, startStaticSite } from './e2e_static_site.mjs';

const PASSWORD = 'Parvane-pwa-offline-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 30000;
const PRECACHE_TIMEOUT_MS = 120000;
const OFFLINE_TASK = 'Полить цветы';
const GUIDE_NOTE = 'Overview';
const GUIDE_NOTES = 12;
const ASSET_CACHE = 'tt-assets';
const STALE_ASSET = 'assets/stale-AAAAAAAA.js';
// Окно без сохранённых данных браузера (так Playwright открывает страницы) установить нельзя — это не про сборку
const IGNORED_INSTALL_ERRORS = ['in-incognito'];

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIST = resolve(ROOT, 'web/telegram-tt/dist');
const NEXT_DIST = process.env.PARVANE_E2E_PWA_NEXT_DIST;
assert.ok(NEXT_DIST, 'нужен PARVANE_E2E_PWA_NEXT_DIST — каталог второй сборки');

const first = readBuild(DIST);
const next = readBuild(NEXT_DIST);
assert.notEqual(first.build, next.build, 'вторая сборка — та же самая');
assert.notEqual(first.entry, next.entry, 'у второй сборки то же имя входной части кода');
const nextFiles = new Set(next.files);
const firstOnly = first.files.filter((file) => !nextFiles.has(file));
assert.ok(firstOnly.length > 0, 'у сборок нет различающихся файлов');

const site = await startStaticSite(DIST);
// Хелперы открывают страницы по этому адресу
process.env.PARVANE_E2E_BASE_URL = site.url;
const BASE_URL = site.url;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
const bobContext = await browser.newContext({ viewport: WIDE });

const readEntry = (page) => page.evaluate(() => {
  const script = document.querySelector('script[type="module"][src*="assets/index-"]');
  return script ? new URL(script.src).pathname.slice(1) : undefined;
});
const waitForShell = (page, build) => page
  .locator(`html[data-app-shell="${build}"]`).waitFor({ state: 'attached', timeout: PRECACHE_TIMEOUT_MS })
  .catch(() => assert.fail(`оболочка сборки ${build} не легла в кэш`));
// Чего из списка нет в кэше сервис-воркера
const findMissing = (page, files) => page.evaluate(async ({ cacheName, list }) => {
  const cache = await caches.open(cacheName);
  const missing = [];
  for (const file of list) {
    if (!(await cache.match(new URL(file, document.baseURI).href))) missing.push(file);
  }
  return missing;
}, { cacheName: ASSET_CACHE, list: files });
const watchChunkErrors = (page, errors) => page.on('pageerror', (err) => {
  if (/dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(err.message)) {
    errors.push(err.message);
  }
});
const openChatFromList = async (page, name, text) => {
  // Нажатие в момент перерисовки списка (история поднимается из кэша) может не открыть чат — повторяем
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('#LeftColumn .ListItem.Chat').filter({ hasText: name }).first().click();
    const isShown = await findMessage(page, text).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS / 3 })
      .then(() => true, () => false);
    if (isShown) return;
  }
  assert.fail(`в переписке нет сообщения «${text}»`);
};

try {
  // ── Манифест и установка ──────────────────────────────────────────────────
  const stamp = Date.now().toString(36);
  const alice = `pwa-a-${stamp}@local`;
  const bob = `pwa-b-${stamp}@local`;
  const session = await preparePage(context, alice, PASSWORD);
  const { page } = session;
  const chunkErrors = [];
  watchChunkErrors(page, chunkErrors);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await dismissRecoveryKeyDialog(bobSession.page).catch(() => undefined);

  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('сервис-воркер не взял страницу под управление при первом визите'));
  const cdp = await context.newCDPSession(page);
  const appManifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(appManifest.errors, [], 'манифест разобран с ошибками');
  const manifest = JSON.parse(appManifest.data);
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.name && manifest.short_name && manifest.description, 'имя, короткое имя, описание');
  for (const size of ['192x192', '512x512']) {
    for (const purpose of [undefined, 'maskable']) {
      const icon = manifest.icons.find((item) => item.sizes === size && item.purpose === purpose);
      assert.ok(icon, `нет значка ${size} ${purpose || 'any'}`);
      assert.equal((await fetch(new URL(icon.src, `${BASE_URL}/`))).status, 200, `значок ${icon.src} не отдаётся`);
    }
  }
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  const installErrors = installabilityErrors.map(({ errorId }) => errorId)
    .filter((id) => !IGNORED_INSTALL_ERRORS.includes(id));
  assert.deepEqual(installErrors, [], 'браузер не считает приложение устанавливаемым');
  const head = await page.evaluate(() => ({
    themes: [...document.querySelectorAll('meta[name="theme-color"]')].map((tag) => tag.getAttribute('content')),
    appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
    appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
    appleBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content'),
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
  }));
  assert.equal(head.themes.length, 2, 'цвет темы — для светлой и тёмной системной темы');
  assert.equal(new Set(head.themes).size, 1, 'после запуска оба цвета темы — цвет панели текущей темы приложения');
  assert.equal((await fetch(new URL(head.appleIcon, `${BASE_URL}/`))).status, 200, 'значок для iOS не отдаётся');
  assert.equal(head.appleCapable, 'yes');
  assert.ok(head.appleBar, 'нет стиля строки состояния iOS');
  assert.ok(head.viewport.includes('viewport-fit=cover'), 'страница не занимает вырез экрана');
  console.log(`OK: манифест без ошибок, приложение устанавливаемо (пропущено: ${IGNORED_INSTALL_ERRORS.join(', ')})`);

  // ── Данные на устройстве: переписка, «План» ───────────────────────────────
  await exchangeMessages(page, alice, bobSession.page, bob, stamp);
  const lastFromBob = `hello-from-b-${stamp}`;
  await page.goto(`${BASE_URL}/?open=entry`);
  const quickInput = page.locator('#planner-quick-input');
  await quickInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await quickInput.fill(`${OFFLINE_TASK} сегодня`);
  await page.waitForTimeout(500);
  await quickInput.press('Enter');
  await quickInput.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await page.goto(`${BASE_URL}/?open=today`);
  await page.locator('#ParvanePlanner').getByText(OFFLINE_TASK).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Снимок «Плана» на устройстве пишется через ~2 с после того, как правка дошла до движка
  await page.waitForTimeout(4000);
  await page.goto(`${BASE_URL}/?open=notes`);
  await page.locator(`#ParvaneKnowledge [data-note-row="${GUIDE_NOTE}"]`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Справка нового хранилища пишется по одной заметке — дождаться всех; снимок дерева облака и тексты заметок
  // ложатся на устройство в фоне (дерево — через ~2 с после последней правки)
  await page.waitForFunction(
    (wanted) => document.querySelectorAll('#ParvaneKnowledge [data-note-row]').length >= wanted, GUIDE_NOTES,
    { timeout: 60000 },
  ).catch(() => assert.fail('справка нового хранилища не создана целиком'));
  await page.waitForTimeout(5000);

  // ── Оболочка в кэше целиком ───────────────────────────────────────────────
  await waitForShell(page, first.build);
  assert.deepEqual(await findMissing(page, first.files), [], 'в кэше не вся оболочка');
  console.log(`OK: сервис-воркер управляет страницей, оболочка в кэше (${first.files.length} файлов)`);

  // ── Без сети ──────────────────────────────────────────────────────────────
  await context.setOffline(true);
  await page.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  await openChatFromList(page, bob.split('@')[0], lastFromBob);
  await page.goto(`${BASE_URL}/?open=today`, { waitUntil: 'domcontentloaded' });
  await page.locator('#ParvanePlanner').getByText(OFFLINE_TASK).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('без сети «План» не показал сохранённую запись'));
  // Полоса «нет связи» с «Повторить»: нажатие без сети ничего не ломает, полоса остаётся
  const planBar = page.locator('#ParvanePlanner [data-offline-bar]');
  await planBar.getByText('No connection yet: showing the plan saved on this device')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planBar.getByRole('button', { name: 'Retry' }).click();
  await page.waitForTimeout(1000);
  assert.equal(await planBar.count(), 1, 'полоса «нет связи» пропала без сети');
  await page.goto(`${BASE_URL}/?open=notes`, { waitUntil: 'domcontentloaded' });
  await page.locator(`#ParvaneKnowledge [data-note-row="${GUIDE_NOTE}"]`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(async () => {
      const state = await page.evaluate(async () => {
        const root = document.querySelector('#ParvaneKnowledge');
        const names = await new Promise((done) => {
          const open = indexedDB.open('parvane-e2e-v2');
          open.onsuccess = () => {
            const stores = [...open.result.objectStoreNames];
            done(stores);
          };
          open.onerror = () => done(['?']);
        });
        return {
          status: root?.getAttribute('data-status'),
          rows: root?.querySelectorAll('[data-note-row]').length,
          text: root?.textContent?.slice(0, 200),
          stores: names,
        };
      });
      console.log('--- заметки без сети ---', JSON.stringify(state), '\n', session.logs.slice(-25).join('\n'));
      assert.fail('без сети «Заметки» не показали сохранённое');
    });
  await page.locator('#ParvaneKnowledge [data-offline-bar]').getByText('showing the notes saved on this device')
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // «Файлы» без связи (доски `ZpFilesX`, `ZdFilesX`): полоса «Нет связи с сервером — показано сохранённое на
  // компьютере» с «Повторить»; загрузка без связи — строка «не загружен: нет связи» с «Повторить»
  await page.goto(`${BASE_URL}/?open=files`, { waitUntil: 'domcontentloaded' });
  const filesBar = page.locator('#ParvaneCloud [data-offline-bar]');
  await filesBar.getByText('No connection to the server').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await filesBar.getByText('showing what is saved on this computer', { exact: false }).waitFor({ state: 'visible' });
  await page.locator('#ParvaneCloud input[type="file"]').setInputFiles([
    { name: 'без-связи.txt', mimeType: 'text/plain', buffer: Buffer.from('загрузка без сети') },
  ]);
  const offlineRow = page.locator('#ParvaneCloud [data-transfer-state="failed"][data-name="без-связи.txt"]');
  await offlineRow.getByText('not uploaded: no connection').waitFor({ state: 'visible', timeout: 90000 })
    .catch(async () => {
      const rows = await page.locator('#ParvaneCloud [data-transfer-state]').evaluateAll((els) => els.map((el) => (
        `${el.dataset.transferState}/${el.dataset.transferError}: ${el.textContent}`
      )));
      const online = await page.evaluate(() => navigator.onLine);
      console.log('--- «Файлы» без сети ---', online, JSON.stringify(rows), '\n', session.logs.slice(-40).join('\n'));
      assert.fail('без сети загрузка не стала строкой «не загружен: нет связи»');
    });
  await offlineRow.getByRole('button', { name: 'Retry', exact: true }).click();
  await offlineRow.getByText('not uploaded: no connection').waitFor({ state: 'visible', timeout: 90000 });
  // Модуль, который при сети не открывали ни разу: его части кода есть только в заранее скачанной оболочке
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Health' }).click();
  await page.locator('#ParvaneHealth').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('без сети не открылся модуль, который раньше не открывали'));
  assert.deepEqual(chunkErrors, [], 'части кода не загрузились без сети');
  console.log('OK: без сети — чаты с перепиской, «План», «Заметки», «Файлы» с загрузкой «не загружен: нет связи», неоткрывавшийся модуль');

  // ── Сеть вернулась ────────────────────────────────────────────────────────
  const whileOffline = `пока-не-было-сети-${stamp}`;
  await sendText(bobSession.page, whileOffline);
  await page.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  await context.setOffline(false);
  await page.locator('#LeftColumn .ListItem.Chat').filter({ hasText: whileOffline }).first()
    .waitFor({ state: 'visible', timeout: 90000 })
    .catch(() => assert.fail('после возвращения сети написанное без неё не пришло'));
  console.log('OK: сеть вернулась — приходит написанное за это время');

  // ── Выкладка второй сборки ────────────────────────────────────────────────
  // Запись «прошлой сборки» месячной давности — чистка кэша должна её убрать
  await page.evaluate(async ({ cacheName, file }) => {
    const cache = await caches.open(cacheName);
    const date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toUTCString();
    await cache.put(new URL(file, document.baseURI).href, new Response('stale', { headers: { date } }));
  }, { cacheName: ASSET_CACHE, file: STALE_ASSET });
  // Открытая вкладка прежней сборки: свежая загрузка, модули ещё не открывались
  await page.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  assert.equal(await readEntry(page), first.entry);
  site.deploy(NEXT_DIST);
  const missingOnServer = await Promise.all(firstOnly.filter((file) => file.startsWith('assets/')).slice(0, 5)
    .map(async (file) => (await fetch(`${BASE_URL}/${file}`)).status));
  assert.ok(missingOnServer.every((status) => status === 404), 'файлы прежней сборки остались на сервере');
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Notes' }).click();
  await page.locator(`#ParvaneKnowledge [data-note-row="${GUIDE_NOTE}"]`).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
    .catch(() => assert.fail('открытая вкладка прежней сборки не открыла модуль после выкладки'));
  assert.equal(await readEntry(page), first.entry, 'открытая вкладка перезагрузилась, а не догрузила своё из кэша');
  assert.deepEqual(chunkErrors, [], 'открытая вкладка не нашла свои части кода после выкладки');
  console.log(`OK: после выкладки (${firstOnly.length} файлов прежней сборки на сервере нет) открытая вкладка работает`);

  // Новая вкладка получает новую версию
  const fresh = await context.newPage();
  watchChunkErrors(fresh, chunkErrors);
  await fresh.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(fresh, STEP_TIMEOUT_MS);
  assert.equal(await readEntry(fresh), next.entry, 'новая вкладка открыла прежнюю сборку');
  // Открытая вкладка: приложение перезагружает вкладки прежней сборки, когда открыта новая; иначе — вручную
  const isReloadedItself = await page
    .waitForFunction((entry) => document.querySelector(`script[src$="${entry.split('/')[1]}"]`), next.entry, {
      timeout: 20000,
    }).then(() => true, () => false);
  await page.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  assert.equal(await readEntry(page), next.entry, 'открытая вкладка после перезагрузки осталась на прежней сборке');
  console.log(`OK: новая вкладка и прежняя (${isReloadedItself ? 'сама' : 'перезагрузкой'}) — на новой сборке`);

  // Новая оболочка в кэше целиком, устаревшее убрано, без сети открывается новая версия
  await waitForShell(fresh, next.build);
  assert.deepEqual(await findMissing(fresh, next.files), [], 'в кэше не вся оболочка новой сборки');
  assert.deepEqual(await findMissing(fresh, [STALE_ASSET]), [STALE_ASSET], 'устаревшая запись осталась в кэше');
  // Одна вкладка, как у установленного приложения
  await page.close();
  await context.setOffline(true);
  await fresh.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(fresh, STEP_TIMEOUT_MS);
  assert.equal(await readEntry(fresh), next.entry, 'без сети открылась прежняя сборка');
  await openChatFromList(fresh, bob.split('@')[0], whileOffline);
  await context.setOffline(false);
  assert.deepEqual(chunkErrors, [], 'части кода новой сборки не загрузились');
  console.log('OK: новая оболочка в кэше, устаревшее убрано, без сети открывается новая версия');
  console.log('e2e_web_pwa_offline: OK');
} finally {
  await browser.close();
  await site.close();
}
