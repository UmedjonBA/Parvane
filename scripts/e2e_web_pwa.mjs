// PWA: манифест (цвета заставки, значки maskable, ярлыки, «Поделиться», без чужого снимка), ярлык `?open=` открывает
// раздел и убирается из адреса, запуск без сети — оболочка из кэша service worker, в том числе по ярлыку.
// spec 041 F2: ярлыки «Новое сообщение» / «План на сегодня» / «Новая заметка» / «Музыка», POST «Поделиться» доходит
// до экрана выбора и сохраняется в «Файлы», нажатие на уведомление (событие `notificationclick` в service worker)
// открывает нужное место.
// Установка, оболочка в кэше целиком и обновление после выкладки — `e2e_web_pwa_offline.mjs`.
// Запуск: scripts/run_web_pwa_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { dismissRecoveryKeyDialog, preparePage, waitForChatList } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-pwa-e2e-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 30000;
const OFFLINE_TASK = 'Полить цветы';
const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
assert.ok(BASE_URL, 'нужен PARVANE_E2E_BASE_URL');

// Полный Chromium в новом безголовом режиме: в `chrome-headless-shell` разрешение на уведомления у service worker
// всегда «denied» — показать уведомление, чтобы нажать на него, было бы нельзя
const browser = await chromium.launch({ channel: 'chromium' });
// Разрешение на уведомления: service worker показывает уведомление, на которое сценарий нажимает
const context = await browser.newContext({ viewport: WIDE, permissions: ['notifications'] });
const SHARED_TEXT = `Поделились ${Date.now().toString(36)}`;
const SHARED_FILE = 'shared-report.txt';
let session;

try {
  // ── Манифест ──────────────────────────────────────────────────────────────
  const manifestPath = await (async () => {
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    await page.close();
    return href;
  })();
  const manifest = await (await fetch(new URL(manifestPath, `${BASE_URL}/`))).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.background_color, '#1d2021', 'заставка тёмная, как фон значка');
  assert.equal(manifest.screenshots, undefined, 'чужого снимка в манифесте нет');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'есть значок maskable');
  assert.deepEqual(
    manifest.shortcuts.map(({ url }) => url),
    ['./?open=compose', './?open=today', './?open=new-note', './?open=music'],
    'ярлыки приложения',
  );
  assert.equal(manifest.share_target?.action, './share/');
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.enctype, 'multipart/form-data');
  assert.equal(manifest.share_target.params.files[0].name, 'files');
  assert.equal(manifest.share_target.params.text, 'text');
  console.log('OK: манифест — цвета, значки maskable, ярлыки, «Поделиться»');

  // ── Ярлык открывает раздел и убирается из адреса ─────────────────────────
  const user = `pwa-${Date.now().toString(36)}@local`;
  session = await preparePage(context, user, PASSWORD);
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await page.goto(`${BASE_URL}/?open=notes`);
  await page.locator('#ParvaneKnowledge').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(new URL(page.url()).searchParams.get('open'), null, 'параметр ярлыка остался в адресе');
  await page.goto(`${BASE_URL}/?open=entry`);
  const quickInput = page.locator('#planner-quick-input');
  await quickInput.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  // Запись — для проверки «Плана» без сети ниже
  await quickInput.fill(`${OFFLINE_TASK} сегодня`);
  await page.waitForTimeout(500);
  await quickInput.press('Enter');
  await quickInput.waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  // Снимок «Плана» на устройстве пишется, когда правка дошла до движка (через ~2 с после этого)
  await page.goto(`${BASE_URL}/?open=today`);
  await page.locator('#ParvanePlanner').getByText(OFFLINE_TASK).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.waitForTimeout(4000);
  console.log('OK: ярлыки «Заметки» и «Новая запись» открывают своё, адрес чистый');

  // ── Ярлыки манифеста (spec 041 F2) ───────────────────────────────────────
  await page.goto(`${BASE_URL}/?open=music`);
  await page.locator('#ParvaneMusic').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.goto(`${BASE_URL}/?open=compose`);
  await page.getByPlaceholder('Search contacts').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.goto(`${BASE_URL}/?open=new-note`);
  await page.locator('#ParvaneKnowledge').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  assert.equal(new URL(page.url()).searchParams.get('open'), null, 'параметр ярлыка остался в адресе');
  console.log('OK: ярлыки «Музыка», «Новое сообщение», «Новая заметка»');

  // Личный диск уже есть на сервере: «Поделиться → Файлы» ниже открывает приложение заново, и запись журнала
  // состояния о диске дочитывается позже, чем доступна кнопка. Прежде правка корня в это время отвергалась («Could
  // not save what was shared» — плавающий шаг: диск успевала создать справка «Заметок», а могла и не успеть); теперь
  // сохранение ждёт сверки диска. Диск создаётся здесь явно — первой папкой
  await page.goto(`${BASE_URL}/?open=files`);
  const cloud = page.locator('#ParvaneCloud[data-sync-status="ready"]');
  await cloud.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await cloud.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.locator('#parvane-cloud-name').fill('Архив');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await cloud.locator('[data-kind="folder"][data-name="Архив"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

  // ── Без сети: оболочка из кэша service worker ────────────────────────────
  // Раздел помнится во вкладке (после ярлыка — «План»): к чатам — своим ярлыком
  await page.goto(`${BASE_URL}/?open=chats`);
  await waitForChatList(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: STEP_TIMEOUT_MS })
    .catch(async () => {
      // Первый показ страницы service worker ставит, но ещё не управляет ею — управляет со следующей загрузки
      await page.reload();
      await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), undefined, { timeout: STEP_TIMEOUT_MS });
    });
  await waitForChatList(page);

  // ── «Поделиться в Parvane»: POST `share/` (как от системы) → экран выбора → «В „Файлы“» ─────────
  // Форма — со страницы без политики безопасности приложения (у него `form-action 'none'`), как POST от системы
  await page.goto('about:blank');
  await page.evaluate(({ action, text, fileName }) => {
    const form = document.createElement('form');
    form.method = 'post';
    form.enctype = 'multipart/form-data';
    form.action = action;
    const textInput = document.createElement('input');
    textInput.name = 'text';
    textInput.value = text;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.name = 'files';
    const transfer = new DataTransfer();
    transfer.items.add(new File([`${text}\n`], fileName, { type: 'text/plain' }));
    fileInput.files = transfer.files;
    form.append(textInput, fileInput);
    document.body.append(form);
    form.submit();
  }, { action: `${BASE_URL}/share/`, text: SHARED_TEXT, fileName: SHARED_FILE });
  const shareSheet = page.locator('[data-share-sheet]');
  await shareSheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await shareSheet.locator('[data-share-content]').getByText(SHARED_FILE).waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).searchParams.get('open'), null, 'параметр «Поделиться» остался в адресе');
  for (const destination of ['chat', 'files', 'note']) {
    assert.equal(await shareSheet.locator(`[data-share-to="${destination}"]`).count(), 1, `нет пункта ${destination}`);
  }
  await shareSheet.locator('[data-share-to="files"]').click();
  await page.locator('.Notification').getByText('Saved to Files').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 2 });
  await shareSheet.waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Поделиться» — экран выбора, файл сохранён в «Файлы» (Мой диск / Входящие)');

  // ── Нажатие на уведомление открывает нужное место ─────────────────────────
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const clickNotification = (data, action) => worker.evaluate(async ({ notifyData, notifyAction }) => {
    await self.registration.showNotification('e2e', { data: notifyData, tag: 'e2e-click' });
    const [notification] = await self.registration.getNotifications({ tag: 'e2e-click' });
    self.dispatchEvent(new NotificationEvent('notificationclick', { notification, action: notifyAction }));
  }, { notifyData: data, notifyAction: action });
  await clickNotification({ kind: 'reminder', reminderKey: 'e2e@2026-01-01@5', reminderTitle: 'e2e' }, '');
  await page.locator('#ParvanePlanner').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const selfId = await page.evaluate(() => window.__parvaneGetGlobal?.().currentUserId);
  assert.ok(selfId, 'нет id своего аккаунта (диагностическая сборка?)');
  await clickNotification({ kind: 'message', chatId: selfId }, '');
  await page.locator('#ParvanePlanner').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
  await page.locator('#MiddleColumn').getByText('Saved Messages').first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: нажатие на уведомление — напоминание открывает «План», сообщение — свой чат');
  await page.goto(`${BASE_URL}/?open=chats`);
  await waitForChatList(page);

  await context.setOffline(true);
  for (const url of [BASE_URL, `${BASE_URL}/?open=today`]) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#root, #UiLoader, #Main').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT_MS })
      .catch(() => assert.fail(`без сети оболочка не открылась: ${url}`));
    assert.ok(!(await page.content()).includes('ERR_INTERNET_DISCONNECTED'), `страница ошибки браузера: ${url}`);
  }
  console.log('OK: без сети оболочка открывается из кэша, и по ярлыку тоже');
  // Без сети приложение запускается целиком (16 окт 2026: `compatTest.js` не был в кэше — белый экран), а «План»
  // показывает снимок с устройства, а не вечную загрузку
  await page.goto(`${BASE_URL}/?open=chats`, { waitUntil: 'domcontentloaded' });
  await waitForChatList(page, STEP_TIMEOUT_MS);
  await page.goto(`${BASE_URL}/?open=today`, { waitUntil: 'domcontentloaded' });
  await page.locator('#ParvanePlanner').getByText(OFFLINE_TASK).first()
    .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.getByText('No connection yet').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await context.setOffline(false);
  await page.getByText('No connection yet').first().waitFor({ state: 'detached', timeout: 60000 });
  console.log('OK: без сети — список чатов и сохранённый «План», после подключения план снова правится');
  // Push при свёрнутом приложении: service worker спрашивает окно, живо ли оно; живая страница отвечает
  const isAlive = await page.evaluate(() => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve(true);
    setTimeout(() => resolve(false), 2000);
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'parvanePing' }, ports: [channel.port2] }));
  }));
  assert.equal(isAlive, true, 'живая страница отвечает service worker');
  console.log('OK: страница отвечает на вопрос service worker перед показом push');
  console.log('e2e_web_pwa: OK');
} finally {
  await browser.close();
}
