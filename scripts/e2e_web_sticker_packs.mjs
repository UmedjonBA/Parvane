// Двухбраузерный сценарий кастомных стикер-паков: Алиса создаёт пак из файлов
// (Настройки → Стикеры), шлёт стикер из него; Боб по клику на стикер получает
// модалку набора, устанавливает пак (pack_ref → PVPK1-архив из cloud), шлёт
// стикер из установленного пака обратно; пак Боба переживает reload.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-packs-e2e-password';

// 1x1 непрозрачный PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Минимальный валидный lottie: один слой-заливка не обязателен, пустых layers
// достаточно для rlottie
const TGS_BYTES = gzipSync(JSON.stringify({
  v: '5.5.2', fr: 30, ip: 0, op: 30, w: 512, h: 512, layers: [],
}));

async function relogin(page, password) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function openStickerTab(page) {
  const menu = page.locator('.SymbolMenu');
  if (!(await menu.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Choose emoji, sticker or GIF' }).first().click();
    await menu.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  // force: кнопка таба «нестабильна» из-за пульсирующих анимаций панели
  await menu.getByRole('button', { name: 'Stickers', exact: true }).click({ force: true });
}

// Стикеры кастомного пака в панели: секция с заголовком packName
function packSection(page, packName) {
  return page.locator('.SymbolMenu .symbol-set').filter({ hasText: packName });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `packs-alice-${suffix}@local`;
  const bob = `packs-bob-${suffix}@local`;
  const packName = `Pack${suffix.slice(-6)}`;

  // Фикстуры пака: два PNG (alt-эмодзи из hex-суффикса имени) и один TGS
  const fixturesDir = await mkdtemp(join(tmpdir(), 'parvane-packs-'));
  const pngA = join(fixturesDir, '01-1f600.png');
  const pngB = join(fixturesDir, '02-1f602.png');
  const tgs = join(fixturesDir, '03-1f60e.tgs');
  await writeFile(pngA, PNG_BYTES);
  await writeFile(pngB, PNG_BYTES);
  await writeFile(tgs, TGS_BYTES);

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Алиса создаёт пак из файлов ────────────────────────────────────────────
  aliceSession.page.on('dialog', (dialog) => dialog.accept(packName));
  await aliceSession.page.getByRole('button', { name: 'Open menu' }).first().click();
  await aliceSession.page.getByRole('menuitem', { name: 'Settings' }).click();
  await aliceSession.page.getByRole('button', { name: 'Stickers and Emoji' }).click();
  const fileChooserPromise = aliceSession.page.waitForEvent('filechooser');
  await aliceSession.page.getByRole('button', { name: 'Create Sticker Pack' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([pngA, pngB, tgs]);
  await aliceSession.page.locator('.Notification').filter({ hasText: 'Sticker pack created' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Выходим из настроек в чат
  for (let i = 0; i < 3; i++) {
    await aliceSession.page.keyboard.press('Escape');
    await aliceSession.page.waitForTimeout(400);
  }
  await openPrivateChat(aliceSession.page, bob);

  // ── Стикер из пака: отправка Бобу ──────────────────────────────────────────
  await openStickerTab(aliceSession.page);
  const aliceSetStickers = packSection(aliceSession.page, packName).locator('.StickerButton');
  await aliceSetStickers.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await aliceSetStickers.count(), 3, 'pack in picker must contain all 3 stickers');
  await aliceSetStickers.first().click();

  const bobSticker = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner');
  await bobSticker.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Боб устанавливает пак по клику на стикер (модалка набора) ──────────────
  await bobSticker.first().click();
  const modal = bobSession.page.locator('.StickerSetModal .modal-dialog');
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByText(packName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const addButton = modal.getByRole('button', { name: /Add \d+ Sticker/ });
  await addButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addButton.click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // ── Боб шлёт стикер из установленного пака обратно ─────────────────────────
  await openStickerTab(bobSession.page);
  const bobSetStickers = packSection(bobSession.page, packName).locator('.StickerButton');
  await bobSetStickers.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobSetStickers.count(), 3, 'installed pack must contain all 3 stickers');
  await bobSetStickers.first().click();
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Установленный пак переживает reload ────────────────────────────────────
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await openStickerTab(bobSession.page);
  await packSection(bobSession.page, packName).locator('.StickerButton')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Удаление пака: модалка набора → Remove, секция уходит из панели ────────
  await bobSession.page.keyboard.press('Escape');
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner')
    .first().click();
  const removeModal = bobSession.page.locator('.StickerSetModal .modal-dialog');
  await removeModal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const removeButton = removeModal.getByRole('button', { name: /Remove \d+ Sticker/ });
  await removeButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await removeButton.click();
  await removeModal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await openStickerTab(bobSession.page);
  await packSection(bobSession.page, packName)
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: пак создан из файлов, стикер с pack_ref доставлен, установка/удаление у получателя, отправка из установленного пака, персист после reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}packs-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
