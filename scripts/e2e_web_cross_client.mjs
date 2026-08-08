// Кросс-клиентская приёмка: Web (Chromium через gateway WS) <-> desktop-форк
// tdesktop (через gateway TCP) на одном production-like стеке.
// Проверяет: текст Web -> desktop, зашифрованное фото Web -> desktop,
// текст desktop -> Web. Требует локально собранный бинарь
// desktop/build-probe/bin/Telegram; без него сценарий помечается SKIP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-xclient-e2e-password';
const DESKTOP_BIN = process.env.PARVANE_E2E_DESKTOP_BIN
  || new URL('../desktop/build-probe/bin/Telegram', import.meta.url).pathname;
const GATEWAY_TCP_URL = process.env.PARVANE_E2E_GATEWAY_TCP_URL;
const DESKTOP_READY_PATTERN = /E2E-устройство готово/;

assert(GATEWAY_TCP_URL, 'PARVANE_E2E_GATEWAY_TCP_URL is required');

if (!existsSync(DESKTOP_BIN)) {
  console.log(`SKIP: desktop binary is not built (${DESKTOP_BIN}); cross-client parity needs a local build`);
  process.exit(0);
}

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

// Rolling-release окружение может обновить soname системных библиотек после
// сборки бинаря (libjxl 0.11 -> 0.12); подставляем совместимые симлинки
function buildLibraryShim(shimDir) {
  const aliases = [
    ['libjxl.so.0.11', 'libjxl.so.0.12'],
    ['libjxl_threads.so.0.11', 'libjxl_threads.so.0.12'],
  ];
  let hasShim = false;
  for (const [wanted, actual] of aliases) {
    if (!existsSync(`/usr/lib/${wanted}`) && existsSync(`/usr/lib/${actual}`)) {
      symlinkSync(`/usr/lib/${actual}`, join(shimDir, wanted));
      hasShim = true;
    }
  }
  return hasShim ? shimDir : undefined;
}

function spawnDesktop(workdir, shimDir, env) {
  return spawn(DESKTOP_BIN, ['-workdir', join(workdir, 'td')], {
    env: {
      ...process.env,
      QT_QPA_PLATFORM: 'offscreen',
      PARVANE_GATEWAY_URL: GATEWAY_TCP_URL,
      ...(shimDir ? { LD_LIBRARY_PATH: shimDir } : {}),
      ...env,
    },
    stdio: 'ignore',
  });
}

function readDesktopLog(workdir) {
  try {
    return readFileSync(join(workdir, 'td', 'log.txt'), 'utf8');
  } catch {
    return '';
  }
}

async function waitDesktopLog(workdir, pattern, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = readDesktopLog(workdir);
    if (pattern.test(log)) return;
    if (child.exitCode !== null) {
      throw new Error(`desktop exited with code ${child.exitCode} while waiting for ${pattern}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  throw new Error(`Timed out waiting desktop log ${pattern}; tail:\n${readDesktopLog(workdir).slice(-2000)}`);
}

async function stopDesktop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function attachPhoto(page, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Photo or Video' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'xclient-photo.png',
    mimeType: 'image/png',
    buffer: makeSolidPng(96, [40, 160, 90]),
  });
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone'] });
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-xclient-desktop-'));
const libraryShim = buildLibraryShim(bobWorkdir);
let desktop;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `xc-web-alice-${suffix}@local`;
  const bob = `xc-desktop-bob-${suffix}@local`;
  const webToDesktopText = `web-to-desktop-${suffix}`;
  const desktopToWebText = `desktop-to-web-${suffix}`;
  const photoCaption = `xc-photo-${suffix}`;

  // Desktop bob: авто-регистрация и публикация E2E-устройства через gateway
  desktop = spawnDesktop(bobWorkdir, libraryShim, { PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}` });
  await waitDesktopLog(bobWorkdir, DESKTOP_READY_PATTERN, 90000, desktop);

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);

  // ── Текст Web -> desktop ───────────────────────────────────────────────────
  await sendText(aliceSession.page, webToDesktopText);
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`входящее msg [\\w-]+ \\(${alice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): ${webToDesktopText}`),
    90000,
    desktop,
  );

  // ── Зашифрованное фото Web -> desktop ──────────────────────────────────────
  await attachPhoto(aliceSession.page, photoCaption);
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`входящее медиа [\\w-]+ \\(${alice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, kind=photo\\)`),
    90000,
    desktop,
  );

  // ── Голосовое Web -> desktop (wire kind=voice, E2E-блоб) ──────────────────
  const escapedAlice = alice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await aliceSession.page.getByRole('button', { name: 'Record voice message' }).click();
  const voiceSendButton = aliceSession.page.getByRole('button', { name: 'Send Message', exact: true });
  await voiceSendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.waitForTimeout(2000);
  await voiceSendButton.click();
  // Сначала парсинг wire-контента, затем успешная расшифровка блоба и инъекция
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`входящее медиа [\\w-]+ \\(${escapedAlice}, kind=voice\\)`),
    90000,
    desktop,
  );
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`получено медиа ${escapedAlice}: voice_[0-9a-f]{8}`),
    90000,
    desktop,
  );

  // ── Текст desktop -> Web: перезапуск в том же workdir с autosend ───────────
  await stopDesktop(desktop);
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_AUTOSEND: `${alice}:${desktopToWebText}`,
  });
  await findMessage(aliceSession.page, desktopToWebText).first()
    .waitFor({ state: 'visible', timeout: 90000 });

  // Фото-сообщение видно на веб-стороне как отправленное (с blob-превью)
  await findMessageContainers(aliceSession.page, photoCaption).first()
    .locator('img[src^="blob:"]').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);

  console.log('OK: web<->desktop text both ways, encrypted photo and voice web->desktop');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  const page = aliceContext.pages()[0];
  if (page) await page.screenshot({ path: `${dir}xclient-alice.png` }).catch(() => {});
  console.error('Desktop log tail:\n', readDesktopLog(bobWorkdir).slice(-3000));
  throw err;
} finally {
  if (desktop) await stopDesktop(desktop);
  await aliceContext.close();
  await browser.close();
  rmSync(bobWorkdir, { recursive: true, force: true });
}
