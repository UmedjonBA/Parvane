// Кросс-клиентский обмен кастом-эмодзи-паками Web <-> desktop (spec 002 US3):
// desktop → web (эмодзи инлайн, пак в панели), web → desktop (материализация
// пака, в т.ч. встроенного ParvaneEmoji), второй получатель того же пака
// (PACK-1), docId после перезагрузки веба для нормализуемого имени (EMOJI-1),
// пересылка эмодзи из неустановленного пака.
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildLibraryShim,
  DESKTOP_READY_PATTERN,
  escapeRegExp,
  readDesktopLog,
  requireGatewayTcpUrl,
  skipWithoutDesktop,
  spawnDesktop,
  stopDesktop,
  waitDesktopLog,
} from './e2e_desktop_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS,
  clickUntil,
  dumpDiagJournal,
  findMessageContainers,
  openPrivateChatStrict,
  pickForwardRecipientAndSend,
  preparePage,
  relogin,
  selectMessageActionOn,
  sendText,
} from './e2e_web_helpers.mjs';

requireGatewayTcpUrl();
skipWithoutDesktop('cross-client custom emoji');

const PASSWORD = 'Parvane-xemoji-e2e-password';
const EMOJI_FILE = '01-1f600.png';

// Эталон docId (conformance EMOJI-1): FNV-1a-64 с начальным значением
// 1469598103934665603 (как у desktop/android) от UTF-8
// `pvemoji:<имя из ссылки>|<файл>`, знаковый int64 десятичной строкой
function fnv1a64Signed(value) {
  let hash = 1469598103934665603n;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return BigInt.asIntN(64, hash).toString();
}

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Цветной градиент 100×100 (не однотонный — чтобы отличать от заглушки)
function makePng(size, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = (x * 2 + seed) & 0xff;
      row[2 + x * 3] = (y * 2 + seed * 3) & 0xff;
      row[3 + x * 3] = ((x + y) + seed * 7) & 0xff;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function makeEmojiPack(root, packName, seed) {
  const dir = join(root, packName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, EMOJI_FILE), makePng(100, seed));
}

// Эмодзи отрисован: документ резолвлен (data-alt) и картинка из blob загружена
async function waitRenderedEmoji(page, docId, timeoutMs = LOGIN_TIMEOUT_MS) {
  const selector = docId
    ? `.Transition_slide-active > .MessageList .custom-emoji[data-document-id="${docId}"][data-alt]`
    : '.Transition_slide-active > .MessageList .custom-emoji[data-alt]';
  const emoji = page.locator(selector).last();
  await emoji.waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForFunction((sel) => {
    const nodes = document.querySelectorAll(sel);
    const node = nodes[nodes.length - 1];
    const images = node ? Array.from(node.querySelectorAll('img')) : [];
    return images.some((img) => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0);
  }, selector, { timeout: timeoutMs });
  return emoji.getAttribute('data-document-id');
}

// Закрыть панель символов и дождаться конца анимации: во время закрытия
// панель ещё «видима», и клик по вкладке перехватывает футер
async function closeSymbolMenu(page) {
  await page.keyboard.press('Escape');
  await page.locator('.SymbolMenu').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

// SC-007: эмодзи у получателя не позже 10 с после отправки
function assertWithin(startedAt, label, limitMs = 10000) {
  const elapsed = Date.now() - startedAt;
  console.log(`${label} in ${elapsed} ms`);
  assert(elapsed <= limitMs, `${label} took ${elapsed} ms (limit ${limitMs} ms)`);
}

async function openSymbolTab(page, tabName) {
  const menu = page.locator('.SymbolMenu');
  await menu.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  if (!await menu.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Choose emoji, sticker or GIF' }).first().click();
  }
  await menu.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(400); // анимация открытия
  // Панель на десктопе открывается и наведением: вкладка может быть уже
  // активна, а футер во время перестройки перехватывает клик
  const tab = menu.getByRole('button', { name: tabName, exact: true });
  if (await tab.evaluate((element) => element.classList.contains('activated')).catch(() => false)) return;
  await tab.click({ timeout: 5000 }).catch(() => tab.click({ force: true }));
}

// Вставить эмодзи набора в композер и отправить; вернуть docId вставленного
async function sendCustomEmojiFromSet(page, setTitle) {
  await openSymbolTab(page, 'Custom Emoji');
  const set = page.locator('.SymbolMenu .symbol-set').filter({ hasText: setTitle }).first();
  await set.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Кнопки набора рисуются, только когда набор в зоне видимости панели
  await set.scrollIntoViewIfNeeded();
  await set.locator('.StickerButton').first().click();
  await closeSymbolMenu(page);
  const composer = page.locator('#editable-message-text');
  const docId = await composer.locator('[data-document-id]').first().getAttribute('data-document-id');
  await composer.press('Enter');
  return docId;
}

async function installPackFromMessage(page, container) {
  const box = await container.boundingBox();
  await container.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } });
  const item = page.locator('.menu-custom-emoji-sets').first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
  // Корень модалки — портал нулевого размера; ждём кнопку «Add N Emoji»
  const addButton = page.locator('.StickerSetModal button').filter({ hasText: /^Add \d+ Emoji$/ }).first();
  await addButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addButton.click();
  // Модалка после установки закрывается сама или остаётся с «Remove» — закрываем
  // кнопкой, а не Escape (Escape после закрытия модалки закрыл бы чат)
  const closeButton = page.locator('.StickerSetModal').getByRole('button', { name: 'Close' }).first();
  if (await closeButton.isVisible().catch(() => false)) await closeButton.click().catch(() => {});
}

const browser = await chromium.launch();
const contexts = {
  alice: await browser.newContext(),
  carol: await browser.newContext(),
  dave: await browser.newContext(),
};
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-xemoji-desktop-'));
const emojiDir = join(bobWorkdir, 'emoji');
const stickersDir = join(bobWorkdir, 'stickers');
mkdirSync(emojiDir, { recursive: true });
mkdirSync(stickersDir, { recursive: true });
const libraryShim = buildLibraryShim(bobWorkdir);
const sessions = {};
let desktop;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `xe-alice-${suffix}@local`;
  const carol = `xe-carol-${suffix}@local`;
  const dave = `xe-dave-${suffix}@local`;
  const bob = `xe-desktop-bob-${suffix}@local`;
  const desktopEnv = {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_EMOJI_DIR: emojiDir,
    PARVANE_STICKERS_DIR: stickersDir,
    PARVANE_NO_LINK_OFFER: '1',
  };

  // ── Регистрация десктопа без хуков ─────────────────────────────────────────
  desktop = spawnDesktop(bobWorkdir, libraryShim, desktopEnv);
  await waitDesktopLog(bobWorkdir, DESKTOP_READY_PATTERN, 90000, desktop);

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD);
  sessions.carol = await preparePage(contexts.carol, carol, PASSWORD);
  sessions.dave = await preparePage(contexts.dave, dave, PASSWORD);
  const alicePage = sessions.alice.page;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, `hi-desktop-${suffix}`);
  await waitDesktopLog(bobWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${escapeRegExp(alice)}\\)`), 90000, desktop);
  await openPrivateChatStrict(alicePage, carol);
  await sendText(alicePage, `hi-carol-${suffix}`);
  await openPrivateChatStrict(sessions.carol.page, alice);
  await sendText(sessions.carol.page, `hi-dave-${suffix}`);
  await openPrivateChatStrict(sessions.carol.page, dave);
  await sendText(sessions.carol.page, `hi-dave-${suffix}`);

  // ── desktop → web: эмодзи из локального пака PvEmoji123 ────────────────────
  makeEmojiPack(emojiDir, 'PvEmoji123', 11);
  await stopDesktop(desktop);
  let logOffset = readDesktopLog(bobWorkdir);
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    ...desktopEnv,
    PARVANE_AUTOSEND: `${alice}:пинг-эмодзи`,
    PARVANE_AUTOEMOJI: `${alice}:PvEmoji123:${EMOJI_FILE}`,
  });
  const autoemoji = await waitDesktopLog(bobWorkdir, /autoemoji → peer \(docId=(-?\d+)\)/, 90000, desktop, { since: logOffset });
  const desktopSentAt = Date.now();
  const desktopDocId = autoemoji[1];
  const expectedDocId = fnv1a64Signed(`pvemoji:PvEmoji123|${EMOJI_FILE}`);
  if (desktopDocId !== expectedDocId) {
    console.error('desktop autoemoji lines:', readDesktopLog(bobWorkdir).match(/.*autoemoji.*|.*эмодзи-пак.*/g));
  }
  assert.equal(desktopDocId, expectedDocId, 'desktop docId differs from EMOJI-1 formula');
  await openPrivateChatStrict(alicePage, bob);
  await waitRenderedEmoji(alicePage, desktopDocId);
  assertWithin(desktopSentAt, 'desktop → web emoji rendered');
  const emojiMessage = alicePage.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ has: alicePage.locator(`.custom-emoji[data-document-id="${desktopDocId}"]`) }).last();
  await installPackFromMessage(alicePage, emojiMessage);
  await openPrivateChatStrict(alicePage, bob);
  await openSymbolTab(alicePage, 'Custom Emoji');
  await alicePage.locator('.SymbolMenu .symbol-set').filter({ hasText: 'PvEmoji123' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeSymbolMenu(alicePage);

  // ── web → desktop: ответ эмодзи того же пака ──────────────────────────────
  logOffset = readDesktopLog(bobWorkdir);
  const replySentAt = Date.now();
  const replyDocId = await sendCustomEmojiFromSet(alicePage, 'PvEmoji123');
  assert.equal(replyDocId, desktopDocId, 'web used a different docId for the desktop pack');
  await waitDesktopLog(bobWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${escapeRegExp(alice)}\\)`), 90000, desktop, { since: logOffset });
  // Приём сообщения — ещё не отрисовка: эмодзи рендерится, только если его
  // документ скормлен из локального пака. Диаг-строка десктопа говорит именно
  // про резолв КОНКРЕТНОГО docId, а не про материализацию пака вообще
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`кастом-эмодзи ${escapeRegExp(replyDocId)} резолвится \\(набор \\d+\\)`),
    90000,
    desktop,
    { since: logOffset },
  );
  assertWithin(replySentAt, 'web → desktop emoji resolved on the desktop');

  // ── Второй получатель того же пака (PACK-1) ────────────────────────────────
  await openPrivateChatStrict(sessions.carol.page, alice);
  await openPrivateChatStrict(alicePage, carol);
  const carolSentAt = Date.now();
  const carolDocId = await sendCustomEmojiFromSet(alicePage, 'PvEmoji123');
  await waitRenderedEmoji(sessions.carol.page, carolDocId);
  assertWithin(carolSentAt, 'second web recipient emoji rendered');

  // ── web → desktop: встроенный пак ParvaneEmoji материализуется ────────────
  logOffset = readDesktopLog(bobWorkdir);
  await openPrivateChatStrict(alicePage, bob);
  await sendCustomEmojiFromSet(alicePage, 'Parvane');
  await waitDesktopLog(bobWorkdir, /эмодзи-пак «ParvaneEmoji» материализован \(\d+ шт\)/, 90000, desktop, { since: logOffset });
  assert(readdirSync(emojiDir).some((name) => name === 'ParvaneEmoji'), 'desktop did not unpack ParvaneEmoji');

  // ── Нормализуемое имя: docId стабилен до и после перезагрузки веба ─────────
  // Нормализуется в PvRaw77 — без коллизии с установленным PvEmoji123 (коллизия
  // нормализованных имён — известное ограничение формата, см. контракт)
  const rawName = 'Pv.Raw!77';
  makeEmojiPack(emojiDir, rawName, 42);
  await stopDesktop(desktop);
  logOffset = readDesktopLog(bobWorkdir);
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    ...desktopEnv,
    PARVANE_AUTOSEND: `${alice}:пинг-2`,
    PARVANE_AUTOEMOJI: `${alice}:${rawName}:${EMOJI_FILE}`,
  });
  const rawEmoji = await waitDesktopLog(bobWorkdir, /autoemoji → peer \(docId=(-?\d+)\)/, 90000, desktop, { since: logOffset });
  const rawDocId = fnv1a64Signed(`pvemoji:${rawName}|${EMOJI_FILE}`);
  assert.equal(rawEmoji[1], rawDocId, 'desktop docId for the raw pack name');
  await waitRenderedEmoji(alicePage, rawDocId);
  const rawMessage = alicePage.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ has: alicePage.locator(`.custom-emoji[data-document-id="${rawDocId}"]`) }).last();
  await installPackFromMessage(alicePage, rawMessage);
  await openPrivateChatStrict(alicePage, bob);
  await relogin(alicePage, PASSWORD);
  await openPrivateChatStrict(alicePage, carol);
  const afterReloadDocId = await sendCustomEmojiFromSet(alicePage, 'PvEmoji123');
  assert.equal(afterReloadDocId, desktopDocId, 'docId of PvEmoji123 changed after web reload');
  await openSymbolTab(alicePage, 'Custom Emoji');
  const rawSet = alicePage.locator('.SymbolMenu .symbol-set').filter({ hasText: 'PvEmoji123' });
  assert((await rawSet.count()) >= 1, 'installed packs are missing after reload');
  await closeSymbolMenu(alicePage);
  // Эмодзи пака с сырым именем после перезагрузки — тот же docId
  const composer = alicePage.locator('#editable-message-text');
  await openSymbolTab(alicePage, 'Custom Emoji');
  await alicePage.locator('.SymbolMenu .symbol-set').filter({ hasText: /PvRaw77|Pv\.Raw!77/ }).first().scrollIntoViewIfNeeded()
    .catch(() => {});
  const rawButton = alicePage.locator(`.SymbolMenu .symbol-set .StickerButton[data-sticker-id="${rawDocId}"]`).first();
  await rawButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Клик во время перестройки панели теряется — повторяем, пока эмодзи не в композере
  await clickUntil(rawButton, () => composer.locator(`[data-document-id="${rawDocId}"]`).first()
    .waitFor({ state: 'attached', timeout: 3000 }))
    .catch(async (error) => {
      const composerHtml = await composer.innerHTML().catch(() => '?');
      const buttonHtml = await rawButton.evaluate((element) => element.outerHTML.slice(0, 400)).catch(() => '?');
      throw new Error(`${error.message}\ncomposer: ${composerHtml}\nbutton: ${buttonHtml}`);
    });
  await closeSymbolMenu(alicePage);
  assert.equal(await composer.locator('[data-document-id]').last().getAttribute('data-document-id'), rawDocId);
  await composer.press('Enter');
  await waitRenderedEmoji(sessions.carol.page, rawDocId);

  // ── Пересылка эмодзи из неустановленного пака новому получателю ───────────
  const carolContainer = findMessageContainers(sessions.carol.page, '').filter({
    has: sessions.carol.page.locator(`.custom-emoji[data-document-id="${carolDocId}"]`),
  }).first();
  // Пересылаем именно этот контейнер: у эмодзи обоих паков одинаковый alt «😀»
  await selectMessageActionOn(sessions.carol.page, carolContainer, 'Forward');
  await pickForwardRecipientAndSend(sessions.carol.page, dave);
  await openPrivateChatStrict(sessions.dave.page, carol);
  await waitRenderedEmoji(sessions.dave.page, carolDocId, 90000);

  Object.entries(sessions).forEach(([name, session]) => {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  });
  console.log('OK: кастом-эмодзи web<->desktop в обе стороны, второй получатель пака, встроенный пак, '
    + 'стабильный docId после перезагрузки, пересылка из неустановленного пака');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}xemoji-${name}.png` }).catch(() => {});
    await dumpDiagJournal(session.page, name);
  }
  console.error('Desktop log tail:\n', readDesktopLog(bobWorkdir).slice(-3000));
  throw err;
} finally {
  await stopDesktop(desktop);
  await browser.close();
  rmSync(bobWorkdir, { recursive: true, force: true });
}
