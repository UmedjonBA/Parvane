// Двухбраузерный сценарий медиа и TTL: фото и файл через UI (E2E-шифрование
// блоба, cloud-загрузка, расшифровка получателем), скачивание файла байт-в-байт
// и самоуничтожение сообщения по TTL с проверкой после reload.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-media-e2e-password';
const TTL_SECS = 6;

function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
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

function makeSolidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

async function attachFile(page, menuItemName, file, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: menuItemName }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `media-alice-${suffix}@local`;
  const bob = `media-bob-${suffix}@local`;
  const photoCaption = `photo-${suffix}`;
  const fileCaption = `file-${suffix}`;
  const fileName = `payload-${suffix}.bin`;
  const ttlMessage = `ttl-${suffix}`;

  const fileBytes = Buffer.concat([
    Buffer.from(`parvane-media-e2e-${suffix}:`),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256)),
  ]);
  const fileSha = createHash('sha256').update(fileBytes).digest('hex');

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  // TTL задан заранее в persist-настройке Bob: его сообщения к Alice живут TTL_SECS
  const bobSession = await preparePage(bobContext, bob, PASSWORD, {
    seedLocalStorage: {
      [`parvane:ttl:${bob}`]: JSON.stringify({ [alice]: TTL_SECS }),
    },
  });
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Фото через UI: E2E-шифрование, cloud, расшифровка у получателя ─────────
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'picture.png',
    mimeType: 'image/png',
    buffer: makeSolidPng(128, [30, 120, 210]),
  }, photoCaption);

  const alicePhoto = findMessageContainers(aliceSession.page, photoCaption).first();
  await alicePhoto.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const bobPhoto = findMessageContainers(bobSession.page, photoCaption).first();
  await bobPhoto.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobPhoto.locator('img[src^="blob:"]').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Файл через UI + скачивание байт-в-байт ─────────────────────────────────
  await attachFile(aliceSession.page, 'Document', {
    name: fileName,
    mimeType: 'application/octet-stream',
    buffer: fileBytes,
  }, fileCaption);

  const bobFile = findMessageContainers(bobSession.page, fileCaption).first();
  await bobFile.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.match(await bobFile.innerText(), new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'file name is not shown to the recipient');

  // Документы могут сохраняться напрямую (anchor) или через service-worker
  // попап — download-событие приходит либо на исходной странице, либо на
  // открывшейся; ждём оба пути
  const downloadFromPopup = bobContext.waitForEvent('page', { timeout: LOGIN_TIMEOUT_MS })
    .then((popup) => popup.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS }));
  const downloadFromPage = bobSession.page.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS });
  downloadFromPopup.catch(() => {});
  downloadFromPage.catch(() => {});
  const consoleLines = [];
  bobSession.page.on('console', (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  await bobFile.locator('.File .file-icon-container').click();
  let download;
  try {
    download = await Promise.race([downloadFromPage, downloadFromPopup]);
  } catch (err) {
    console.error('Bob console after file click:\n', consoleLines.join('\n'));
    throw err;
  }
  assert.equal(download.suggestedFilename(), fileName, 'downloaded file name mismatch');
  const downloadedPath = await download.path();
  const downloadedBytes = await readFile(downloadedPath);
  assert.equal(
    createHash('sha256').update(downloadedBytes).digest('hex'),
    fileSha,
    'downloaded bytes differ from the uploaded original',
  );

  // ── TTL: сообщение Bob → Alice исчезает у обоих и не возвращается ──────────
  await sendText(bobSession.page, ttlMessage);
  await findMessageContainers(aliceSession.page, ttlMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await findMessageContainers(bobSession.page, ttlMessage).first()
    .waitFor({ state: 'detached', timeout: (TTL_SECS + 25) * 1000 });
  await findMessageContainers(aliceSession.page, ttlMessage).first()
    .waitFor({ state: 'detached', timeout: (TTL_SECS + 25) * 1000 });

  // Reload Alice: истёкшее сообщение не должно вернуться из sync
  await aliceSession.page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = aliceSession.page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await aliceSession.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(aliceSession.page, bob);
  // Фото и файл пережили reload, TTL-сообщение — нет
  await findMessageContainers(aliceSession.page, photoCaption).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessageContainers(aliceSession.page, fileCaption).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.waitForTimeout(2000);
  assert.equal(
    await findMessageContainers(aliceSession.page, ttlMessage).count(),
    0,
    'expired TTL message reappeared after reload',
  );

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: encrypted photo/file round-trip, byte-exact download and TTL expiry with reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}media-ttl-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
