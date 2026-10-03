// Протокол v2 (spec 007, T064): смешанная пара web ↔ desktop. Пара задаётся
// PARVANE_E2E_PAIR: web2-desktop2 — оба на v2 (web: localStorage
// parvane:proto=v2, desktop: PARVANE_PROTO_V2=1); web2-desktop1 — desktop на
// v1 (web v2 обязан говорить с ним по v1). Проверяет текст в обе стороны и
// что для пары v2 отправка десктопа действительно ушла по v2 (журнал
// десктопа «v2 → …»), а приём — через движок («v2 ← …»). T139: фото и
// голосовое web → desktop (блоб расшифрован десктопом), файл desktop → web и
// группа web → desktop (для web2-desktop1 web обязан собрать группу v1 — D-13).
// Требует бинарь desktop/build-probe/bin/Telegram (-DPARVANE_DEV=ON); без
// него — SKIP.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildLibraryShim,
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
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  findMessage,
  openGroupChatByTitle,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-mixed-password';
const PAIR = process.env.PARVANE_E2E_PAIR || 'web2-desktop2';
const desktopIsV2 = PAIR === 'web2-desktop2';

requireGatewayTcpUrl();
skipWithoutDesktop(`protocol mixed ${PAIR}`);

const VOICE_RECORD_MS = 2500;

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

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const aliceContext = await browser.newContext({ permissions: ['microphone'] });
const webLogs = [];
const consoleTail = [];
aliceContext.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2')) webLogs.push(t);
    if (m.type() === 'error' || m.type() === 'warning' || t.includes('[parvane]')) {
      consoleTail.push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail.length > 60) consoleTail.shift();
    }
  });
});
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-v2mixed-desktop-'));
const libraryShim = buildLibraryShim(bobWorkdir);
let desktop;

async function waitWebLog(needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (webLogs.some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`web: нет записи «${needle}» (журнал v2: ${webLogs.join(' | ')})`);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `v2mw-${suffix}@local`;
  const bob = `v2md-${suffix}@local`;
  const webToDesktop = `v2-web-to-desktop-${suffix}`;
  const desktopToWeb = `v2-desktop-to-web-${suffix}`;
  const desktopFileName = `v2-desktop-file-${suffix}.bin`;
  const desktopFile = join(bobWorkdir, desktopFileName);
  writeFileSync(desktopFile, Buffer.from(`PARVANE MIXED ${suffix} \u0000\u0001 payload`));

  // Web alice на v2 — первой: её журнал устройств должен существовать, когда
  // десктоп выбирает формат (D-13).
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD, {
    seedLocalStorage: { 'parvane:proto': 'v2' },
  });
  await waitWebLog('v2: готов');
  await dismissRecoveryKeyDialog(aliceSession.page);

  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    ...(desktopIsV2 ? {
      PARVANE_PROTO_V2: '1',
      PARVANE_AUTOSEND_V2: `${alice}:${desktopToWeb}`,
    } : { PARVANE_PROTO_V2: '0', PARVANE_AUTOSEND: `${alice}:${desktopToWeb}` }),
    PARVANE_AUTOSENDFILE: `${alice}:${desktopFile}`,
  });
  await waitDesktopLog(bobWorkdir, desktopIsV2 ? /v2: готов/ : /E2E-устройство готово/, 90000, desktop);

  // Desktop → web.
  await openPrivateChat(aliceSession.page, bob);
  await findMessage(aliceSession.page, desktopToWeb).first().waitFor({ state: 'visible', timeout: 90000 });
  if (desktopIsV2) {
    assert.match(readDesktopLog(bobWorkdir), new RegExp(`v2 → ${escapeRegExp(alice)} msg`),
      'desktop отправил не по v2');
  }

  // Web → desktop.
  await sendText(aliceSession.page, webToDesktop);
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`входящее msg [\\w-]+ \\(${escapeRegExp(alice)}\\): ${escapeRegExp(webToDesktop)}`),
    90000,
    desktop,
  );
  if (desktopIsV2) {
    assert.match(readDesktopLog(bobWorkdir), new RegExp(`v2 ← ${escapeRegExp(alice)} msg`),
      'desktop принял не через движок v2');
  }

  // ── T139: медиа и группа ────────────────────────────────────────────────────
  // Файл desktop → web: блоб в cloud, у web — документ (хук шлёт байты без
  // имени файла, поэтому ищем пузырь документа, а не имя)
  await waitDesktopLog(bobWorkdir, /медиа отправлено msg [\w-]+ \(file /, 90000, desktop);
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .File')
    .first().waitFor({ state: 'visible', timeout: 90000 });

  // Фото web → desktop: десктоп скачал и расшифровал блоб (размер картинки в логе)
  const photoCaption = `v2-photo-${suffix}`;
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'picture.png', mimeType: 'image/png', buffer: makeSolidPng(96, [30, 120, 210]),
  }, photoCaption);
  await waitDesktopLog(bobWorkdir, new RegExp(`получено фото ${escapeRegExp(alice)}: 96x96`), 90000, desktop);

  // Голосовое web → desktop (fake-микрофон): десктоп получил медиа вида voice
  await aliceSession.page.getByRole('button', { name: 'Record voice message' }).click();
  const sendButton = aliceSession.page.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.waitForTimeout(VOICE_RECORD_MS);
  await sendButton.click();
  await waitDesktopLog(bobWorkdir, new RegExp(`(входящее|получено) медиа .*${escapeRegExp(alice)}.*voice`), 90000, desktop);

  // Группа web → desktop: для web2-desktop1 — группа v1 (участник без v2), иначе v2
  const title = `MX-${suffix.slice(-6)}`;
  await createGroupViaUi(aliceSession.page, title, [bob.split('@')[0]]);
  if (desktopIsV2) await waitWebLog('v2: группа создана');
  const groupText = `v2-group-${suffix}`;
  // Композер лички ещё в DOM, пока открывается группа: без явного открытия
  // текст уходил в личный чат (как в e2e_protocol_mixed.mjs)
  await openGroupChatByTitle(aliceSession.page, title);
  const composer = aliceSession.page
    .locator('.Transition_slide-active #editable-message-text[contenteditable="true"]').last();
  await composer.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await composer.fill(groupText);
  await composer.press('Enter');
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`групповое .* от ${escapeRegExp(alice)}: ${escapeRegExp(groupText)}`),
    90000,
    desktop,
  );
  if (!desktopIsV2) {
    assert.ok(!webLogs.some((l) => l.includes('v2: группа создана')),
      'web создал группу v2 с участником на v1 (D-13)');
  }
  assert.ok(!/блоб НЕ расшифрован/.test(readDesktopLog(bobWorkdir)), 'desktop: есть нерасшифрованные блобы');
  console.log(`e2e_protocol_mixed_desktop (${PAIR}): OK`);
} catch (error) {
  console.error(`журнал v2 web: ${webLogs.join('\n')}`);
  console.error(`консоль web:\n${consoleTail.join('\n')}`);
  console.error(`хвост лога desktop:\n${readDesktopLog(bobWorkdir).slice(-3000)}`);
  throw error;
} finally {
  await stopDesktop(desktop);
  await browser.close();
}
