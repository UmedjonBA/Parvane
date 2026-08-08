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
  LOGIN_TIMEOUT_MS,
  findMessageContainers,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-media-kinds-e2e-password';
const RECORD_MS = 2000;

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

async function relogin(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
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
  await attachFile(aliceSession.page, 'Photo or Video', {
    name: 'e2e-video.mp4', mimeType: 'video/mp4', buffer: makeMp4(fixtureDir),
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
  await relogin(bobSession.page);
  await openPrivateChat(bobSession.page, alice);
  await bobRound.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
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
  throw err;
} finally {
  await browser.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}
