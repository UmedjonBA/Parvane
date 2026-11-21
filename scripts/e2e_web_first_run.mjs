// Оболочка по доскам `XpStart`, `ZdNav` (spec 041): первый запуск «Что вам нужно в Parvane?» на телефоне и
// компьютере (выбор, счётчик, «Включить всё», набор на ленте и панели), горячие клавиши (Ctrl+/ — окно, Ctrl+2 —
// модуль по порядку, Ctrl+, — «Профиль»), окно «Нужно обновить приложение» («Позже» — отправка закрыта, черновик
// цел), шторка выхода «Просто выйти / Выйти и сменить ключи» (доска `PhProfileB`). Экран «вы вышли» отозванного
// устройства — в `e2e_web_devices.mjs`, переход с экрана ключа восстановления — в `e2e_web_auth_screens.mjs`.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  logOutRow,
  openProfile,
  openSavedMessages,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-first-run-e2e-password';
const WAIT_MS = 15_000;
// Экран первого запуска проверяется здесь: отметку «показан» хелперы не ставят
const SEED = { 'parvane:modules-first-run': '' };
const PHONE = { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

const suffix = `${Date.now()}-${process.pid}`;
const browser = await chromium.launch();
const sessions = {};

async function navModules(page, root) {
  const value = await page.locator(`${root}[data-modules], ${root} [data-modules]`).first().getAttribute('data-modules');
  return value.split(' ');
}

async function waitForNav(page, root, isOk, message) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const modules = await navModules(page, root).catch(() => []);
    if (isOk(modules)) return modules;
    if (Date.now() > deadline) assert.fail(`${message}: ${modules.join(' ')}`);
    await page.waitForTimeout(200);
  }
}

async function runPhone() {
  const context = await browser.newContext(PHONE);
  const session = await preparePage(context, `first-run-ann-${suffix}@local`, PASSWORD, { seedLocalStorage: SEED });
  sessions.phone = session;
  const { page } = session;
  const screen = page.locator('[data-first-run="phone"]');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const rows = await screen.locator('[data-first-run-row]').count();
  assert.ok(rows >= 2, 'в карточке — модули, «Чаты» и «Профиль»');
  // «Чаты» и «Профиль» всегда включены — их выключатели заперты
  assert.equal(await screen.locator('[data-first-run-module="chats"]').isDisabled(), true, '«Чаты» заперты');
  await screen.locator('[data-first-run-all]').click();
  await page.waitForFunction((count) => (
    document.querySelector('[data-first-run-count]')?.getAttribute('data-first-run-count') === String(count)
  ), rows, { timeout: WAIT_MS });
  const countText = await screen.locator('[data-first-run-count]').textContent();
  assert.match(countText, new RegExp(`${rows} of ${rows}`), 'счётчик после «Включить всё»');
  assert.match(countText, rows > 5 ? /scrolls/ : /fits/, 'подпись о прокрутке ленты');
  await waitForNav(page, 'nav', (modules) => modules.length === rows, 'лента — все модули карточки');
  // Выключатель пишет набор сразу: «План» уходит с ленты
  await screen.locator('[data-first-run-module="plan"]').click();
  await waitForNav(page, 'nav', (modules) => !modules.includes('plan'), '«План» выключен на ленте');
  await screen.locator('[data-first-run-done]').click();
  await screen.waitFor({ state: 'detached', timeout: WAIT_MS });
  assert.equal(await page.evaluate(() => localStorage.getItem('parvane:modules-first-run')), 'shown',
    'отметка «показан» на устройстве');
  console.log('OK: первый запуск на телефоне — выбор, счётчик, «Включить всё», лента меняется сразу');

  // Шторка выхода: у аккаунта одно устройство — «Выйти и сменить ключи» не предлагается (менять ключи некому)
  await openProfile(page);
  await logOutRow(page).click();
  const sheet = page.locator('[data-sign-out-sheet]');
  await sheet.waitFor({ state: 'visible', timeout: WAIT_MS });
  await sheet.locator('[data-sign-out-plain]').waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.waitForTimeout(1500);
  assert.equal(await sheet.locator('[data-sign-out-rotate]').count(), 0, 'единственное устройство — без смены ключей');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await sheet.waitFor({ state: 'detached', timeout: WAIT_MS });
  console.log('OK: шторка выхода открывается и закрывается «Отменой»');
}

async function runDesktop() {
  const context = await browser.newContext(DESKTOP);
  const session = await preparePage(context, `first-run-bob-${suffix}@local`, PASSWORD, { seedLocalStorage: SEED });
  sessions.desktop = session;
  const { page } = session;
  const screen = page.locator('[data-first-run="desktop"]');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // На компьютере — только выключаемые модули, без «Чатов» и «Профиля»
  assert.equal(await screen.locator('[data-first-run-module="chats"]').count(), 0, 'без «Чатов»');
  await screen.locator('[data-first-run-all]').click();
  const all = await waitForNav(page, '#FoldersSidebar', (modules) => modules.includes('health'), 'панель — с «Здоровьем»');
  await screen.locator('[data-first-run-module="health"]').click();
  await waitForNav(page, '#FoldersSidebar', (modules) => !modules.includes('health'), '«Здоровье» пропало с панели');
  await screen.locator('[data-first-run-done]').click();
  await screen.waitFor({ state: 'detached', timeout: WAIT_MS });
  console.log('OK: первый запуск на компьютере — выбор модулей меняет панель');

  // ── Горячие клавиши (доска `ZdNav`) ──
  const modules = all.filter((id) => id !== 'health');
  await page.keyboard.press('Control+/');
  const hotkeys = page.locator('[data-hotkeys]');
  await hotkeys.waitFor({ state: 'visible', timeout: WAIT_MS });
  await hotkeys.locator('[data-hotkeys-group="everywhere"]').waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.equal(await hotkeys.locator('[data-hotkeys-group="health"]').count(), 0, 'группы выключенных модулей нет');
  await page.keyboard.press('Escape');
  await hotkeys.waitFor({ state: 'detached', timeout: WAIT_MS });
  await page.keyboard.press('Control+2');
  await page.locator(`#FoldersSidebar [data-module="${modules[1]}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.keyboard.press('Control+Comma');
  await page.locator('#FoldersSidebar [data-module="profile"][aria-selected="true"]')
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.keyboard.press('Control+1');
  await page.locator(`#FoldersSidebar [data-module="${modules[0]}"][aria-selected="true"]`)
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  console.log('OK: Ctrl+/ — окно клавиш, Ctrl+2 и Ctrl+1 — модули по порядку, Ctrl+, — «Профиль»');

  // ── «Нужно обновить приложение»: событие провайдера, «Позже» — читать можно, отправлять нельзя ──
  await openSavedMessages(page);
  const draft = `first-run-draft-${suffix}`;
  await page.locator('#editable-message-text[contenteditable="true"]').fill(draft);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('parvane-upgrade-required')));
  const upgrade = page.locator('[data-upgrade-required]');
  await upgrade.waitFor({ state: 'visible', timeout: WAIT_MS });
  await upgrade.locator('[data-upgrade-status]').waitFor({ state: 'visible', timeout: WAIT_MS });
  assert.ok((await upgrade.locator('[data-upgrade-build]').innerText()).length > 0, 'версия этой сборки');
  await upgrade.locator('[data-upgrade-later]').click();
  await upgrade.waitFor({ state: 'detached', timeout: WAIT_MS });
  await page.locator('.messaging-disabled').getByText('Sending is off until the app is updated.')
    .waitFor({ state: 'visible', timeout: WAIT_MS });
  await page.waitForFunction(() => !document.querySelector('#editable-message-text[contenteditable="true"]'),
    undefined, { timeout: WAIT_MS });
  console.log('OK: окно обновления — версии и ход, «Позже» закрывает отправку плашкой');
}

try {
  await runPhone();
  await runDesktop();
  assertNoPageErrors(sessions);
  console.log('OK: оболочка — первый запуск, горячие клавиши, окно обновления, шторка выхода');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}first-run-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
