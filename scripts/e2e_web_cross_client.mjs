// Кросс-клиентская приёмка: Web (Chromium через gateway WS) <-> desktop-форк
// tdesktop (через gateway TCP) на одном production-like стеке.
// Проверяет: текст Web -> desktop, зашифрованное фото Web -> desktop,
// текст desktop -> Web. Требует локально собранный бинарь
// desktop/build-probe/bin/Telegram; без него сценарий помечается SKIP.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildLibraryShim,
  DESKTOP_READY_PATTERN,
  readDesktopLog,
  requireGatewayTcpUrl,
  skipWithoutDesktop,
  spawnDesktop,
  stopDesktop,
  waitDesktopLog,
} from './e2e_desktop_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS,
  callProviderForChat,
  findMessage,
  findMessageContainers,
  openPrivateChat,
  preparePage,
  relogin,
  sendText,
  sha256OfDownload,
  thumbnailStats,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-xclient-e2e-password';

requireGatewayTcpUrl();
skipWithoutDesktop('cross-client parity');

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

async function attachMedia(page, menuItemName, file, caption) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: menuItemName }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
  const captionInput = page.locator('#editable-message-text-modal');
  await captionInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (caption) await captionInput.fill(caption);
  await captionInput.press('Enter');
  await captionInput.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

function attachPhoto(page, caption) {
  return attachMedia(page, 'Photo or Video', {
    name: 'xclient-photo.png',
    mimeType: 'image/png',
    buffer: makeSolidPng(96, [40, 160, 90]),
  }, caption);
}

// Playwright-Chromium без H.264 — VP9-in-MP4 (desktop декодирует через ffmpeg)
// Миниатюра видео с десктопа — кадр самого видео (не 1×1, не однотонная)
async function expectDesktopVideoThumbnail(bubble, label) {
  const started = Date.now();
  let stats;
  for (;;) {
    stats = await thumbnailStats(bubble).catch(() => undefined);
    if (stats && stats.width > 1 && stats.variance > 50) break;
    assert(Date.now() - started < 15000, `${label}: thumbnail ${JSON.stringify(stats)}`);
    await bubble.page().waitForTimeout(300);
  }
  console.log(`${label}: thumbnail ${stats.width}x${stats.height}`);
}

function makeMp4(dir) {
  const path = join(dir, 'xclient-video.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', path,
  ], { stdio: 'ignore' });
  return readFileSync(path);
}

function makeWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  }
  return data;
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

  // ── Видео Web -> desktop (kind=video) и аудиофайл (kind=file) ─────────────
  await attachMedia(aliceSession.page, 'Photo or Video', {
    name: 'xclient-video.mp4', mimeType: 'video/mp4', buffer: makeMp4(bobWorkdir),
  });
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`входящее медиа [\\w-]+ \\(${escapedAlice}, kind=video\\)`),
    90000,
    desktop,
  );
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`получено медиа ${escapedAlice}: video_[0-9a-f]{8}`),
    90000,
    desktop,
  );
  await attachMedia(aliceSession.page, 'Document', {
    name: 'xclient-audio.wav', mimeType: 'audio/wav', buffer: makeWav(),
  });
  await waitDesktopLog(
    bobWorkdir,
    new RegExp(`получено медиа ${escapedAlice}: xclient-audio\\.wav`),
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

  // ── Медиа desktop -> Web: по одному файлу на запуск десктопа ───────────────
  const messages = () => aliceSession.page.locator('.Transition_slide-active > .MessageList .Message');
  const mediaDir = join(bobWorkdir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const pngBytes = makeSolidPng(64, [200, 40, 120]);
  const pdfBytes = Buffer.from(`%PDF-1.4\n% parvane ${suffix}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`);
  const mp4Bytes = makeMp4(mediaDir);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const files = [
    { name: 'desk.png', bytes: pngBytes },
    { name: 'desk.mp4', bytes: mp4Bytes },
    { name: 'desk.pdf', bytes: pdfBytes },
  ];
  for (const file of files) {
    const path = join(mediaDir, file.name);
    writeFileSync(path, file.bytes);
    await stopDesktop(desktop);
    const before = readDesktopLog(bobWorkdir);
    const countBefore = await messages().count();
    desktop = spawnDesktop(bobWorkdir, libraryShim, {
      PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
      PARVANE_AUTOSENDFILE: `${alice}:${path}`,
    });
    await waitDesktopLog(bobWorkdir, /медиа отправлено msg /, 90000, desktop, { since: before });
    await aliceSession.page.waitForFunction(
      (count) => document.querySelectorAll('.Transition_slide-active > .MessageList .Message').length > count,
      countBefore,
      { timeout: 90000 },
    );
    const bubble = messages().last();
    if (file.name.endsWith('.mp4')) {
      // Видео — нативный плеер, воспроизводится
      const video = bubble.locator('video.full-media');
      await video.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
      await bubble.locator('.message-media-duration').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await video.evaluate((element) => element.play());
      await video.evaluate((element) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`desktop video stuck at ${element.currentTime}`)), 30000);
        const timer = setInterval(() => {
          if (element.currentTime > 0.3) {
            clearTimeout(deadline);
            clearInterval(timer);
            resolve(undefined);
          }
        }, 200);
      }));
      // Перемотка на середину и продолжение воспроизведения, миниатюра-кадр (FR-025)
      await video.evaluate((element) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`desktop video did not resume after seek at ${element.currentTime}`)), 10000);
        element.addEventListener('seeked', () => {
          const from = element.currentTime;
          const timer = setInterval(() => {
            if (element.currentTime !== from && !element.paused) {
              clearTimeout(deadline);
              clearInterval(timer);
              resolve(undefined);
            }
          }, 100);
        }, { once: true });
        element.currentTime = element.duration / 2;
      }));
      await expectDesktopVideoThumbnail(bubble, 'desktop video');
    } else {
      // Картинка хуком десктопа понижается до документа image/* — побайтно
      const fileRow = bubble.locator('.File .file-icon-container');
      await fileRow.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      const downloaded = await sha256OfDownload(aliceSession.page, fileRow);
      assert.equal(downloaded.sha256, sha(file.bytes), `${file.name}: downloaded bytes differ`);
      assert.match(downloaded.name, file.name.endsWith('.png') ? /^image_.*\.png$/ : /^file_.*\.pdf$/,
        `${file.name}: unexpected file name ${downloaded.name}`);
    }
  }

  // ── Стикер desktop -> Web из локального пака (pack_ref) ───────────────────
  const stickersDir = join(bobWorkdir, 'stickers');
  const emojiDir = join(bobWorkdir, 'emoji-empty');
  mkdirSync(join(stickersDir, 'PvStickers'), { recursive: true });
  mkdirSync(emojiDir, { recursive: true });
  writeFileSync(join(stickersDir, 'PvStickers', '01-1f600.png'), makeSolidPng(128, [30, 90, 200]));
  await stopDesktop(desktop);
  const beforeSticker = readDesktopLog(bobWorkdir);
  const countBeforeSticker = await messages().count();
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_STICKERS_DIR: stickersDir,
    PARVANE_EMOJI_DIR: emojiDir,
    PARVANE_AUTOSTICKER: alice,
  });
  await waitDesktopLog(bobWorkdir, /sticker отправлен → /, 90000, desktop, { since: beforeSticker });
  await aliceSession.page.waitForFunction(
    (count) => document.querySelectorAll('.Transition_slide-active > .MessageList .Message').length > count,
    countBeforeSticker,
    { timeout: 90000 },
  );
  await messages().last().locator('.media-inner').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const stickerSetId = await aliceSession.page.evaluate(() => {
    const global = window.__parvaneGetGlobal();
    const stickers = Object.values(global.messages.byChatId)
      .flatMap((chat) => Object.values(chat.byId || {}))
      .filter((message) => message.content?.sticker);
    return stickers.pop()?.content?.sticker?.stickerSetInfo?.id;
  });
  assert.match(String(stickerSetId), /^pvpk-/, `desktop sticker has no pack_ref set id: ${stickerSetId}`);
  // SC-008 «стикер — стикером с паком»: пузырь несёт настоящую картинку, а
  // клик открывает модалку пака с предложением установить его
  const stickerBubble = messages().last();
  const stickerImage = stickerBubble.locator('.media-inner img, .media-inner canvas, .media-inner video').first();
  await stickerImage.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const stickerBox = await stickerImage.boundingBox();
  assert(stickerBox && stickerBox.width > 1 && stickerBox.height > 1,
    `desktop sticker rendered empty: ${JSON.stringify(stickerBox)}`);
  // Стикер рисуется двумя слоями (миниатюра под полной картинкой `.full-media`),
  // клик по нижнему перехватывает верхний — кликаем по контейнеру
  await stickerBubble.locator('.media-inner').first().click();
  // Ждём именно кнопку установки: заголовок при неудачной загрузке набора —
  // сырой ключ `AccDescrStickerSet`, он содержит «Sticker» и прошёл бы проверку
  // Корневой `.Modal` Playwright считает скрытым (контейнер без размера) — ждём
  // саму кнопку установки внутри диалога
  const packModal = aliceSession.page.locator('.StickerSetModal').first();
  await packModal.getByRole('button', { name: /Add \d+ Sticker/i })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.keyboard.press('Escape');
  await packModal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});

  // ── Всё на месте после перезагрузки веба ──────────────────────────────────
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await findMessage(aliceSession.page, desktopToWebText).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message video').first()
    .waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  await expectDesktopVideoThumbnail(aliceSession.page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ has: aliceSession.page.locator('.message-media-duration') }).last(), 'desktop video after reload');
  assert((await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .File').count()) >= 2,
    'desktop documents are missing after reload');
  // FR-040 требует «все четыре вида, в том числе после перезагрузки» — стикер
  // после relogin раньше не проверялся вовсе
  const stickerAfterReload = await aliceSession.page.evaluate(() => {
    const global = window.__parvaneGetGlobal();
    const stickers = Object.values(global.messages.byChatId)
      .flatMap((chat) => Object.values(chat.byId || {}))
      .filter((message) => message.content?.sticker);
    return stickers.pop()?.content?.sticker?.stickerSetInfo?.id;
  });
  assert.match(String(stickerAfterReload), /^pvpk-/,
    `desktop sticker lost its pack after reload: ${stickerAfterReload}`);
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .media-inner img')
    .last().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Группа web → desktop (spec 003, GROUP-1): описание и фото группы,
  // заданные в вебе, доходят до десктопа нотисом и видны в логе ────────────
  const groupTitle = `XC-${suffix.slice(-6)}`;
  const groupCreated = await aliceSession.page.evaluate(async ({ title, name }) => {
    const global = window.__parvaneGetGlobal();
    const user = Object.values(global.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name));
    if (!user) return { error: 'desktop user unknown' };
    const result = await window.__parvaneDiagCallApi('createGroupChat', { title, users: [user] });
    return { chatId: result?.chat?.id };
  }, { title: groupTitle, name: bob.split('@')[0] });
  assert(groupCreated.chatId, `group not created: ${JSON.stringify(groupCreated)}`);
  const beforeGroup = readDesktopLog(bobWorkdir).length;
  await waitDesktopLog(bobWorkdir, /группа [0-9a-f-]{36} обновлена \(v0, список\)/, 90000, desktop, { since: beforeGroup });
  const aboutText = `about-${suffix.slice(-6)}`;
  const aboutResult = await callProviderForChat(aliceSession.page, 'updateChatAbout', groupTitle, undefined, ['$chat', aboutText]);
  assert.equal(aboutResult.result, true, `updateChatAbout failed: ${JSON.stringify(aboutResult)}`);
  await waitDesktopLog(bobWorkdir, new RegExp(`группа [0-9a-f-]{36} обновлена \\(v1, нотис\\) about=${aboutText} avatar=-`), 30000, desktop, { since: beforeGroup });
  await aliceSession.page.evaluate(async ({ title }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === title);
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2aabee';
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const file = new File([blob], 'group.png', { type: 'image/png' });
    return window.__parvaneDiagCallApi('editChatPhoto', { chatId: chat.id, photo: file });
  }, { title: groupTitle });
  await waitDesktopLog(bobWorkdir, /группа [0-9a-f-]{36} обновлена \(v2, нотис\) about=about-[0-9]+ avatar=[0-9a-f-]{36}/, 30000, desktop, { since: beforeGroup });
  await waitDesktopLog(bobWorkdir, /аватар применён для [0-9a-f-]{36}/, 30000, desktop, { since: beforeGroup });

  // ── Группа desktop → web (spec 004, US6): описание, права и ссылка, заданные
  // на десктопе штатными функциями экранов (хуки), доходят до web нотисом ────
  // bob (десктоп) — админ с change_info + invite_users: назначаем из web
  const promote = await callProviderForChat(aliceSession.page, 'updateChatAdmin', groupTitle, bob.split('@')[0], {
    chat: '$chat', user: '$user', adminRights: { changeInfo: true, inviteUsers: true },
  });
  assert.equal(promote.result, true, `updateChatAdmin failed: ${JSON.stringify(promote)}`);
  await stopDesktop(desktop);
  const beforeManage = readDesktopLog(bobWorkdir).length;
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_AUTOGROUPINFO: `${groupTitle}:about=from-desktop`,
    PARVANE_AUTOGROUPPERMS: `${groupTitle}:send_polls=0`,
    PARVANE_AUTOGROUPINVITE: `${groupTitle}:create;title=from-desktop;max=3`,
  });
  await waitDesktopLog(bobWorkdir, /AUTOGROUPINFO .* about → ok/, 60000, desktop, { since: beforeManage });
  await waitDesktopLog(bobWorkdir, /AUTOGROUPPERMS .* → ok/, 60000, desktop, { since: beforeManage });
  await waitDesktopLog(bobWorkdir, /AUTOGROUPINVITE .* create → ok [0-9a-f]{32}/, 60000, desktop, { since: beforeManage });
  const desktopToken = readDesktopLog(bobWorkdir).match(/AUTOGROUPINVITE .* create → ok ([0-9a-f]{32})/)?.[1];
  assert(desktopToken, 'desktop did not report the created invite token');
  // web видит описание и права без reload (нотис GROUP-1)
  await aliceSession.page.waitForFunction(({ title }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === title);
    const full = chat && global.chats.fullInfoById?.[chat.id];
    return Boolean(chat && full && full.about === 'from-desktop' && chat.defaultBannedRights?.sendPolls === true);
  }, { title: groupTitle }, { timeout: 30000 });
  // web видит ссылку, созданную на десктопе, в списке ссылок группы
  const invites = await callProviderForChat(aliceSession.page, 'fetchExportedChatInvites', groupTitle, undefined, {
    chat: '$chat', isRevoked: false,
  });
  const desktopLink = invites.result?.invites?.find((invite) => invite.link.includes(desktopToken));
  assert(desktopLink, `web does not list the desktop-created link: ${JSON.stringify(invites).slice(0, 300)}`);
  assert.equal(desktopLink.title, 'from-desktop');
  assert.equal(desktopLink.usageLimit, 3);
  // web → desktop: права, изменённые в web, перерисовывают сведения на десктопе
  const revert = await callProviderForChat(aliceSession.page, 'updateChatDefaultBannedRights', groupTitle, undefined, {
    chat: '$chat', bannedRights: { sendPolls: false },
  });
  assert.equal(revert.result, true, `updateChatDefaultBannedRights failed: ${JSON.stringify(revert)}`);
  await waitDesktopLog(bobWorkdir, /группа [0-9a-f-]{36} обновлена \(v[0-9]+, нотис\) .*"send_polls":true/, 30000, desktop, { since: beforeManage });

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);

  console.log('OK: web<->desktop text both ways; encrypted photo, voice, video and audio web->desktop; '
    + 'image (as document), video with seek and frame thumbnail, pdf and pack sticker desktop->web, all after web reload; '
    + 'group description and photo web->desktop by notice (GROUP-1); '
    + 'description, permissions and invite link desktop->web and permissions web->desktop (spec 004)');
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
