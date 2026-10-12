// Двухбраузерный сценарий кастомных стикер-паков: Алиса создаёт пак из файлов
// (Настройки → Стикеры), шлёт стикер из него; Боб по клику на стикер получает
// модалку набора, устанавливает пак (pack_ref → PVPK1-архив из cloud), шлёт
// стикер из установленного пака обратно; пак Боба переживает reload.
// Картинки: каждая плитка пака в панели и в окне набора показывает сам стикер
// (не серую заглушку) — у автора пака (окно из панели и из пузыря), у
// получателя до установки и после перезагрузки; значков Premium (звезда,
// замок) нет нигде.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildPngBuffer,
  relogin,
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
  openProfile,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-packs-e2e-password';

// Статичные стикеры — сплошной цвет 64×64: заглушка миниатюры (серый PNG 1×1,
// `media.ts`) от настоящей картинки отличается и размером, и цветом
const STICKER_SIDE = 64;
const STICKER_COLORS = [[0xe5, 0x39, 0x35], [0x1e, 0x88, 0xe5]];
const COLOR_TOLERANCE = 8;

// Минимальный валидный lottie: один слой-заливка не обязателен, пустых layers
// достаточно для rlottie
const TGS_BYTES = gzipSync(JSON.stringify({
  v: '5.5.2', fr: 30, ip: 0, op: 30, w: 512, h: 512, layers: [],
}));


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

async function closeStickerMenu(page) {
  const menu = page.locator('.SymbolMenu');
  if (await menu.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
  }
}

// Что показывает каждая плитка: самая крупная загруженная картинка, её
// натуральный размер и цвет точки, значки Premium
function readTiles(scope) {
  return scope.locator('.StickerButton').evaluateAll((tiles) => tiles.map((tile) => {
    const img = Array.from(tile.querySelectorAll('img.sticker-media'))
      .filter((candidate) => candidate.complete && candidate.naturalWidth)
      .sort((a, b) => b.naturalWidth - a.naturalWidth)[0];
    let pixel;
    if (img) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      pixel = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    }
    return {
      id: tile.dataset.stickerId,
      width: img ? img.naturalWidth : 0,
      height: img ? img.naturalHeight : 0,
      pixel,
      hasPremiumBadge: Boolean(tile.querySelector('.sticker-premium, .sticker-locked')),
    };
  }));
}

function isStickerPicture(tile, color) {
  return tile.width === STICKER_SIDE && tile.height === STICKER_SIDE && tile.pixel && tile.pixel[3] === 255
    && color.every((value, channel) => Math.abs(tile.pixel[channel] - value) <= COLOR_TOLERANCE);
}

// Плитки пака (порядок файлов: два PNG, TGS): статичные показывают свою
// картинку; у анимированного под плеером нет непрозрачной заглушки; значков
// Premium нет
async function assertPackTiles(scope, label) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let tiles = [];
  for (;;) {
    tiles = await readTiles(scope);
    if (tiles.length === 3 && STICKER_COLORS.every((color, index) => isStickerPicture(tiles[index], color))) break;
    assert.ok(
      Date.now() < deadline,
      `${label}: плитки не показывают картинки стикеров: ${JSON.stringify(tiles)}`,
    );
    await scope.page().waitForTimeout(250);
  }
  const animated = tiles[2];
  assert.ok(
    !(animated.pixel && animated.pixel[3] === 255 && animated.width <= 1),
    `${label}: под анимированным стикером непрозрачная заглушка: ${JSON.stringify(animated)}`,
  );
  assert.deepEqual(
    tiles.filter((tile) => tile.hasPremiumBadge).map((tile) => tile.id),
    [],
    `${label}: на плитках значок Premium`,
  );
  assert.equal(
    await scope.locator('.sticker-premium, .sticker-locked, .symbol-set-locked-icon').count(),
    0,
    `${label}: значок Premium или замок`,
  );
}

// Окно набора: заголовок — имя пака, все плитки с картинками. Возвращает окно
async function assertSetWindow(page, packName, label) {
  const modal = page.locator('.StickerSetModal .modal-dialog');
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.getByText(packName).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await modal.locator('.StickerButton').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await assertPackTiles(modal, label);
  return modal;
}

async function closeSetWindow(modal) {
  await modal.locator('.modal-header button').first().click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

function firstStickerBubble(page) {
  return page.locator('.Transition_slide-active > .MessageList .Message .media-inner').first();
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
  await writeFile(pngA, buildPngBuffer(STICKER_SIDE, STICKER_COLORS[0]));
  await writeFile(pngB, buildPngBuffer(STICKER_SIDE, STICKER_COLORS[1]));
  await writeFile(tgs, TGS_BYTES);

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Алиса создаёт пак из файлов ────────────────────────────────────────────
  aliceSession.page.on('dialog', (dialog) => dialog.accept(packName));
  await openProfile(aliceSession.page);
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
  await packSection(aliceSession.page, packName).scrollIntoViewIfNeeded();
  await assertPackTiles(packSection(aliceSession.page, packName), 'панель автора пака');

  // ── Окно своего набора из панели (меню стикера → «Показать набор») ─────────
  await aliceSetStickers.first().click({ button: 'right' });
  await aliceSession.page.locator('.sticker-context-menu .MenuItem').filter({
    has: aliceSession.page.locator('.icon-stickers'),
  }).first().click();
  const alicePanelModal = await assertSetWindow(aliceSession.page, packName, 'окно своего набора из панели');
  await closeSetWindow(alicePanelModal);

  await openStickerTab(aliceSession.page);
  await aliceSetStickers.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSetStickers.first().click();

  // ── Окно своего набора из пузыря отправленного стикера ─────────────────────
  await firstStickerBubble(aliceSession.page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeStickerMenu(aliceSession.page);
  await firstStickerBubble(aliceSession.page).click();
  const aliceBubbleModal = await assertSetWindow(aliceSession.page, packName, 'окно своего набора из пузыря');
  await closeSetWindow(aliceBubbleModal);

  const bobSticker = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner');
  await bobSticker.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Боб устанавливает пак по клику на стикер (модалка набора) ──────────────
  await bobSticker.first().click();
  // Набор ещё не установлен: архив пака тянется из cloud по pack_ref
  const modal = await assertSetWindow(bobSession.page, packName, 'окно неустановленного набора у получателя');
  const addButton = modal.getByRole('button', { name: /Add \d+ Sticker/ });
  await addButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addButton.click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });

  // ── Боб шлёт стикер из установленного пака обратно ─────────────────────────
  await openStickerTab(bobSession.page);
  const bobSetStickers = packSection(bobSession.page, packName).locator('.StickerButton');
  await bobSetStickers.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await bobSetStickers.count(), 3, 'installed pack must contain all 3 stickers');
  await packSection(bobSession.page, packName).scrollIntoViewIfNeeded();
  await assertPackTiles(packSection(bobSession.page, packName), 'панель получателя после установки');
  await bobSetStickers.first().click();
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Установленный пак переживает reload ────────────────────────────────────
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await openStickerTab(bobSession.page);
  await packSection(bobSession.page, packName).locator('.StickerButton')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await packSection(bobSession.page, packName).scrollIntoViewIfNeeded();
  await assertPackTiles(packSection(bobSession.page, packName), 'панель получателя после перезагрузки');

  // ── Удаление пака: модалка набора → Remove, секция уходит из панели ────────
  await bobSession.page.keyboard.press('Escape');
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner')
    .first().click();
  const removeModal = await assertSetWindow(
    bobSession.page,
    packName,
    'окно установленного набора у получателя после перезагрузки',
  );
  const removeButton = removeModal.getByRole('button', { name: /Remove \d+ Sticker/ });
  await removeButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await removeButton.click();
  await removeModal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await openStickerTab(bobSession.page);
  await packSection(bobSession.page, packName)
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Получатель удалил пак и перезагрузился: окно набора из пузыря ──────────
  // Набор не установлен, реестр сессии пуст — картинки снова из архива в cloud
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await firstStickerBubble(bobSession.page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await firstStickerBubble(bobSession.page).click();
  await closeSetWindow(await assertSetWindow(
    bobSession.page,
    packName,
    'окно неустановленного набора у получателя после перезагрузки',
  ));

  // ── Автор пака после перезагрузки: окно из пузыря и панель ─────────────────
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await firstStickerBubble(aliceSession.page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await firstStickerBubble(aliceSession.page).click();
  await closeSetWindow(await assertSetWindow(
    aliceSession.page,
    packName,
    'окно своего набора из пузыря после перезагрузки',
  ));
  await openStickerTab(aliceSession.page);
  await packSection(aliceSession.page, packName).locator('.StickerButton')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await packSection(aliceSession.page, packName).scrollIntoViewIfNeeded();
  await assertPackTiles(packSection(aliceSession.page, packName), 'панель автора пака после перезагрузки');

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: пак создан из файлов, стикер с pack_ref доставлен, установка/удаление у получателя, отправка из установленного пака, персист после reload; плитки панели и окна набора показывают картинки, значков Premium нет');
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
