// Пересылка видео, файла и голосового в другой чат. Файл в облаке доступен по
// секрету скачивания исходного сообщения (CAP-1), поэтому при пересылке блоб
// перевыгружается под новым ключом и новым секретом — у нового получателя
// видео играет, файл скачивается побайтно, голосовое воспроизводится, в том
// числе после перезагрузки. Попутно: ссылка в подписи пересланного видео —
// кликабельная (разметка ссылок на клиенте).
//
// A отправляет B видео (с подписью), файл и голосовое; B пересылает все три C.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  dumpDiagJournal,
  findMessageContainers,
  openPrivateChatStrict,
  pickForwardRecipientAndSend,
  preparePage,
  relogin,
  selectMessageActionOn,
  sendText,
  sha256OfDownload,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-forward-media-e2e-password';
const RECORD_MS = 2500;

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Playwright-Chromium без H.264 — VP9-in-MP4, как в сценарии media_kinds
function makeMp4(dir) {
  const path = join(dir, 'fwd-video.mp4');
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
    '-c:v', 'libvpx-vp9', '-b:v', '120k', '-pix_fmt', 'yuv420p', path,
  ], { stdio: 'ignore' });
  return readFileSync(path);
}

// tt-плеер создаёт `new Audio()` вне DOM — отслеживаем экземпляры, чтобы
// проверить реальное воспроизведение, а не только состояние кнопки
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

async function recordVoice(page) {
  await page.getByRole('button', { name: 'Record voice message' }).click();
  const sendButton = page.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(RECORD_MS);
  await sendButton.click();
}

function messages(page) {
  return page.locator('.Transition_slide-active > .MessageList .Message');
}

function voiceBubbles(page) {
  return messages(page).filter({ has: page.locator('.Audio .voice-duration') });
}

function fileBubbles(page, fileName) {
  return messages(page).filter({ has: page.locator('.File') }).filter({ hasText: fileName });
}

async function expectVideoPlays(page, caption, who) {
  const bubble = findMessageContainers(page, caption).last();
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const video = bubble.locator('video.full-media');
  await video.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  // Прямой play(): проверяем, что расшифрованные байты декодируются
  await video.evaluate((element) => element.play());
  await video.evaluate(
    (element) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`video stuck at ${element.currentTime}`)), 30000);
      const timer = setInterval(() => {
        if (element.currentTime > 0.3) {
          clearTimeout(deadline);
          clearInterval(timer);
          resolve(undefined);
        }
      }, 200);
    }),
  ).catch((error) => {
    throw new Error(`видео «${caption}» не играет у ${who}: ${error.message}`);
  });
}

async function expectVoicePlays(page, who) {
  const bubble = voiceBubbles(page).last();
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const durationText = await bubble.locator('.voice-duration').innerText();
  assert.match(durationText, /0:0[1-9]/, `${who}: длительность голосового (${durationText})`);
  // Плеер создаёт `Audio` ещё при отрисовке пузыря — список не чистим, а сверяем рост времени от снимка
  await page.evaluate(() => {
    (globalThis.__parvaneE2eAudios || []).forEach((audio) => {
      audio.pause();
      audio.e2eStart = audio.currentTime;
    });
  });
  await bubble.locator('.toggle-play').click();
  await page.waitForFunction(
    () => (globalThis.__parvaneE2eAudios || []).some((audio) => audio.currentTime > (audio.e2eStart || 0) + 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {
    throw new Error(`голосовое не воспроизводится у ${who}`);
  });
  await bubble.locator('.toggle-play').click().catch(() => {});
}

async function expectFileExact(page, fileName, expectedSha, who) {
  const bubble = fileBubbles(page, fileName).last();
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const downloaded = await sha256OfDownload(page, bubble.locator('.File .file-icon-container'));
  assert.equal(downloaded.sha256, expectedSha, `${who}: байты файла ${fileName} отличаются`);
}

async function forwardBubble(page, bubble, address) {
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await selectMessageActionOn(page, bubble, 'Forward');
  await pickForwardRecipientAndSend(page, address);
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const contexts = [
  await browser.newContext({ permissions: ['microphone'] }),
  await browser.newContext(),
  await browser.newContext({ acceptDownloads: true }),
];
const fixtureDir = mkdtempSync(join(tmpdir(), 'parvane-forward-media-'));
let sessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map((n) => `fwdm-${n}-${suffix}@local`);
  // Выдуманные данные: подпись со ссылкой, файл из случайных байтов
  const videoCaption = `fwdm-video-${suffix} example.org`;
  const fileName = `fwdm-notes-${suffix}.bin`;
  const fileBytes = randomBytes(96 * 1024);
  const fileSha = sha(fileBytes);

  await Promise.all(contexts.map((context) => trackAudioInstances(context)));
  sessions = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD),
    preparePage(contexts[1], bob, PASSWORD),
    preparePage(contexts[2], carol, PASSWORD),
  ]);
  const [a, b, c] = sessions;

  // ── A → B: видео с подписью, файл, голосовое ───────────────────────────────
  await openPrivateChatStrict(a.page, bob);
  await attachFile(a.page, 'Photo or Video', {
    name: 'fwd-video.mp4', mimeType: 'video/mp4', buffer: makeMp4(fixtureDir),
  }, videoCaption);
  await attachFile(a.page, 'Document', {
    name: fileName, mimeType: 'application/octet-stream', buffer: fileBytes,
  });
  await recordVoice(a.page);

  await openPrivateChatStrict(b.page, alice);
  await expectVideoPlays(b.page, videoCaption, 'Боба (исходный получатель)');
  await expectFileExact(b.page, fileName, fileSha, 'Боб');
  await expectVoicePlays(b.page, 'Боб');
  console.log('OK: видео, файл и голосовое дошли до исходного получателя');

  // Кэрол знакомится с Бобом (пикер пересылки показывает только существующие чаты)
  await openPrivateChatStrict(c.page, bob);
  await sendText(c.page, `hi-${suffix}`);
  await openPrivateChatStrict(b.page, carol);
  await findMessageContainers(b.page, `hi-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── B → C: пересылка всех трёх (Кэрол не участник исходного чата) ──────────
  await openPrivateChatStrict(b.page, alice);
  await forwardBubble(b.page, findMessageContainers(b.page, videoCaption).last(), carol);
  await openPrivateChatStrict(b.page, alice);
  await forwardBubble(b.page, fileBubbles(b.page, fileName).last(), carol);
  await openPrivateChatStrict(b.page, alice);
  await forwardBubble(b.page, voiceBubbles(b.page).last(), carol);

  await openPrivateChatStrict(c.page, bob);
  await expectVideoPlays(c.page, videoCaption, 'Кэрол (получатель пересылки)');
  // Ссылка в подписи пересланного видео кликабельна и ведёт на https://
  const forwardedVideo = findMessageContainers(c.page, videoCaption).last();
  const link = forwardedVideo.locator('a.text-entity-link').filter({ hasText: 'example.org' }).first();
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await link.getAttribute('href'), 'https://example.org', 'ссылка в подписи ведёт на https://');
  await expectFileExact(c.page, fileName, fileSha, 'Кэрол');
  await expectVoicePlays(c.page, 'Кэрол');
  console.log('OK: пересланные видео, файл и голосовое открываются у нового получателя');

  // ── После перезагрузки: ключи и секреты из истории ─────────────────────────
  await relogin(c.page, PASSWORD);
  await openPrivateChatStrict(c.page, bob);
  await expectVideoPlays(c.page, videoCaption, 'Кэрол после перезагрузки');
  await expectFileExact(c.page, fileName, fileSha, 'Кэрол после перезагрузки');
  await expectVoicePlays(c.page, 'Кэрол после перезагрузки');
  console.log('OK: пересланное медиа открывается после перезагрузки');

  assertNoPageErrors({ alice: a, bob: b, carol: c });
  console.log('OK: пересылка видео, файла и голосового');
} catch (error) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR
    || new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await Promise.all(sessions.map((session, index) => session?.page
    .screenshot({ path: `${dir}/forward-media-${index}.png` }).catch(() => {})));
  for (const [index, session] of sessions.entries()) {
    if (session) await dumpDiagJournal(session.page, `forward-media-${index}`).catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  rmSync(fixtureDir, { recursive: true, force: true });
}
