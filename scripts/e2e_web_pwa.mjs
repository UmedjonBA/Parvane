// PWA: манифест (цвета заставки, значки maskable, ярлыки, без чужого снимка), ярлык `?open=` открывает раздел и
// убирается из адреса, запуск без сети — оболочка из кэша service worker, в том числе по ярлыку.
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
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
  assert.equal(manifest.background_color, '#1d2021', 'заставка тёмная, как фон значка');
  assert.equal(manifest.screenshots, undefined, 'чужого снимка в манифесте нет');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'есть значок maskable');
  assert.deepEqual(
    manifest.shortcuts.map(({ url }) => url),
    ['./?open=chats', './?open=today', './?open=notes', './?open=entry'],
    'ярлыки приложения',
  );
  console.log('OK: манифест — цвета, значки maskable, ярлыки');

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
