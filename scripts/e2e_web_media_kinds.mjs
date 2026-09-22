// Двухбраузерный сценарий видов медиа: кругляш (запись fake-камерой,
// wire kind=video_note), обычное видео с подписью (kind=video, VP9-in-MP4),
// аудиофайл (kind=file + нативный плеер). Приём — нативные баблы, playback
// после E2E-расшифровки, персист после reload.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dumpDiagJournal,
  relogin,
  LOGIN_TIMEOUT_MS,
  findMessageContainers,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-media-kinds-e2e-password';
const RECORD_MS = 2000;

// id видео из состояния страницы: миниатюр на проводе нет, пузырь просит их
// отдельным запросом document<id>?size=x
async function videoFileIds(page, isRound) {
  return page.evaluate((round) => {
    const global = window.__parvaneGetGlobal?.();
    const messages = Object.values(global?.messages.byChatId || {})
      .flatMap((chat) => Object.values(chat.byId || {}));
    return messages
      .filter((message) => message.content?.video && Boolean(message.content.video.isRound) === round)
      .map((message) => message.content.video.id);
  }, isRound);
}

// Те же запросы миниатюр, что делают пузыри, — разом, через diag-callApi
// страницы. Возвращает на каждый файл размер кадра, разброс яркости (заглушка
// однотонная) и время ответа от общего старта
async function measureThumbnails(page, fileIds) {
  return page.evaluate(async (ids) => {
    const started = performance.now();
    const measure = async (id) => {
      const result = await window.__parvaneDiagCallApi?.('downloadMedia', {
        url: `document${id}?size=x`, mediaFormat: 0,
      });
      const ms = Math.round(performance.now() - started);
      const blob = result?.dataBlob;
      if (!blob) return { id, ms, error: `no blob: ${JSON.stringify(result)}` };
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, 32, 24);
      const { data } = ctx.getImageData(0, 0, 32, 24);
      const values = [];
      for (let i = 0; i < data.length; i += 4) values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      return {
        id, ms, width: bitmap.width, height: bitmap.height, mimeType: blob.type, variance,
      };
    };
    return Promise.all(ids.map(measure));
  }, fileIds);
}

function isFrame(stats) {
  return !stats.error && stats.width > 1 && stats.height > 1 && stats.variance > 5;
}

// Миниатюра кружка: кадр самого видео, не 1×1 и не однотонная серая заглушка
// (spec 002 FR-020). Мелкий кружок автозагружается и начинает играть раньше,
// чем миниатюра успевает показаться, поэтому проверяем тот же запрос, что
// делает RoundVideo (document<id>?size=x)
async function expectRoundThumbnail(page, label) {
  const [id] = await videoFileIds(page, true);
  assert(id, `${label}: no round message`);
  const [stats] = await measureThumbnails(page, [id]);
  assert(isFrame(stats), `${label}: round video thumbnail ${JSON.stringify(stats)}`);
  console.log(`${label}: round thumbnail ${stats.width}x${stats.height}, variance ${Math.round(stats.variance)}, ${stats.ms} ms`);
}

// SC-004 на нескольких пузырях: миниатюры запрашиваются разом, и очередь
// (THUMB_CONCURRENCY = 2) не должна отодвинуть k-ю за бюджет. Уложиться в
// бюджет разрешено заглушкой — кадр приходит позже и заменяет её, поэтому
// вторым шагом ждём настоящий кадр у каждого видео
async function expectThumbnailQueue(page, label, count, budgetMs = 4000, frameMs = 20000) {
  const ids = (await videoFileIds(page, false)).slice(-count);
  assert.equal(ids.length, count, `${label}: expected ${count} video messages, got ${ids.length}`);
  const first = await measureThumbnails(page, ids);
  first.forEach((stats) => {
    assert(!stats.error, `${label}: thumbnail ${stats.id} — ${stats.error}`);
    assert(stats.ms <= budgetMs,
      `${label}: thumbnail ${stats.id} answered in ${stats.ms} ms (budget ${budgetMs} ms)`);
  });
  console.log(`${label}: ${count} thumbnails answered in ${first.map((stats) => stats.ms).join('/')} ms`);
  let latest = first;
  const deadline = Date.now() + frameMs;
  while (Date.now() < deadline && !latest.every(isFrame)) {
    await page.waitForTimeout(500);
    latest = await measureThumbnails(page, ids);
  }
  latest.forEach((stats) => {
    assert(isFrame(stats), `${label}: thumbnail ${stats.id} stayed a placeholder ${JSON.stringify(stats)}`);
  });
  console.log(`${label}: ${count} thumbnails are real frames`);
}

function makeWav(seconds = 2, rate = 8000) {
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

// Playwright-Chromium без H.264 — генерируем VP9-in-MP4
function makeMp4(dir) {
  const path = join(dir, 'e2e-video.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', path,
  ], { stdio: 'ignore' });
  return readFileSync(path);
}

async function trackAudioInstances(context) {
  await context.addInitScript(() => {
    const NativeAudio = window.Audio;
    globalThis.__parvaneE2eAudios = [];
    window.Audio = class TrackedAudio extends NativeAudio {
      constructor(...args) {
        super(...args);
        globalThis.__parvaneE2eAudios.push(this);
      }
    };
  });
}


async function attachFile(page, menuItemName, file, caption) {
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

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['camera', 'microphone'] });
const bobContext = await browser.newContext();
const fixtureDir = mkdtempSync(join(tmpdir(), 'parvane-media-kinds-'));

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `mk-alice-${suffix}@local`;
  const bob = `mk-bob-${suffix}@local`;
  const videoCaption = `mk-video-${suffix}`;

  await trackAudioInstances(bobContext);
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Обычное видео с подписью ────────────────────────────────────────────────
  const videoBuffer = makeMp4(fixtureDir);
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'e2e-video.mp4', mimeType: 'video/mp4', buffer: videoBuffer,
  }, videoCaption);
  const bobVideoMessage = findMessageContainers(bobSession.page, videoCaption).first();
  await bobVideoMessage.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const durationBadge = await bobVideoMessage.locator('.message-media-duration').innerText();
  assert.match(durationBadge, /0:0[1-9]/, `video duration badge (${durationBadge})`);
  // Прямой play() на элементе: проверяем, что расшифрованные байты декодируются
  await bobVideoMessage.locator('video.full-media').evaluate((video) => video.play());
  await bobVideoMessage.locator('video.full-media').evaluate(
    (video) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`video stuck at ${video.currentTime}`)), 30000);
      const timer = setInterval(() => {
        if (video.currentTime > 0.3) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve(undefined);
        }
      }, 200);
    }),
  );

  // ── Несколько видео разом: миниатюры в бюджете SC-004 ──────────────────────
  // Очередь миниатюр (два слота) раньше выстраивала остальные пузыри за собой,
  // и k-й ждал освобождения слота — до восьми секунд на каждое зависшее видео
  for (const index of [2, 3]) {
    const caption = `${videoCaption}-${index}`;
    await attachFile(aliceSession.page, 'Photo or Video', {
      name: `e2e-video-${index}.mp4`, mimeType: 'video/mp4', buffer: videoBuffer,
    }, caption);
    await findMessageContainers(bobSession.page, caption).first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  await expectThumbnailQueue(bobSession.page, 'bob', 3);

  // ── Аудиофайл: нативный плеер с title и playback ───────────────────────────
  await attachFile(aliceSession.page, 'Document', {
    name: 'e2e-audio.wav', mimeType: 'audio/wav', buffer: makeWav(),
  });
  const bobAudio = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .Audio')
    .filter({ hasText: 'e2e-audio.wav' }).first();
  await bobAudio.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobAudio.locator('.toggle-play').click();
  await bobSession.page.waitForFunction(
    () => (globalThis.__parvaneE2eAudios || []).some((audio) => audio.currentTime > 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );

  // ── Кругляш: переключение режима через контекстное меню, запись, отправка ──
  const recordVoiceButton = aliceSession.page.getByRole('button', { name: 'Record voice message' });
  await recordVoiceButton.click({ button: 'right' });
  const videoModeItem = aliceSession.page.getByRole('menuitem', { name: 'Video Message' });
  await videoModeItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await videoModeItem.click();
  await aliceSession.page.getByRole('button', { name: 'Record video message' })
    .click();
  const sendButton = aliceSession.page.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // MediaRecorder стартует после стабилизации кадра fake-камеры — ждём таймер
  // записи, а не фиксированную паузу, иначе запись короче минимума отбросится
  await aliceSession.page.waitForFunction(() => {
    const bar = document.querySelector('.voice-record-bar');
    return bar && /0:0[2-9]/.test(bar.textContent || '');
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });
  await sendButton.click();

  // Local echo у отправителя — запись реально состоялась и ушла в отправку
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message .RoundVideo')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const bobRound = bobSession.page.locator('.Transition_slide-active > .MessageList .Message .RoundVideo');
  await bobRound.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectRoundThumbnail(bobSession.page, 'bob');
  // Клик включает загрузку (клик по свежему баблу может потеряться —
  // ретраим, пока не появится видео-элемент); play — следующий клик
  const bobRoundVideo = bobRound.locator('video.full-media');
  for (let attempt = 0; attempt < 10 && !(await bobRoundVideo.isVisible()); attempt++) {
    await bobRound.click();
    await bobSession.page.waitForTimeout(1500);
  }
  await bobRoundVideo.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.waitForTimeout(500);
  if (await bobRoundVideo.evaluate((video) => video.paused)) {
    await bobRound.click();
  }
  await bobSession.page.waitForFunction(() => {
    const video = document.querySelector('.RoundVideo video');
    return video && video.currentTime > 0.3;
  }, undefined, { timeout: LOGIN_TIMEOUT_MS });

  // ── Персист: reload получателя, все три бабла рендерятся нативно ───────────
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await bobRound.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectRoundThumbnail(bobSession.page, 'bob after reload');
  await findMessageContainers(bobSession.page, videoCaption).first()
    .locator('video.full-media, .media-inner').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.locator('.Transition_slide-active > .MessageList .Message .Audio')
    .filter({ hasText: 'e2e-audio.wav' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  console.log('OK: кругляш, видео с подписью и аудиофайл — нативные баблы, playback и reload');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await aliceContext.pages()[0]?.screenshot({ path: `${dir}media-kinds-alice.png` }).catch(() => {});
  await bobContext.pages()[0]?.screenshot({ path: `${dir}media-kinds-bob.png` }).catch(() => {});
  const roundHtml = await bobContext.pages()[0]
    ?.locator('.RoundVideo').first().evaluate((el) => el.outerHTML).catch(() => 'no .RoundVideo');
  console.error('Bob RoundVideo DOM:', roundHtml);
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await dumpDiagJournal(page, name, 60);
  }
  throw err;
} finally {
  await browser.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}
