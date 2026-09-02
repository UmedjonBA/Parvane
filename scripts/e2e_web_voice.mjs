// Двухбраузерный сценарий голосовых сообщений: запись через fake-микрофон,
// E2E-загрузка блоба в cloud, нативный voice-бабл с waveform и playback у
// получателя, персист после reload (ключи из sync-пути).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  relogin,
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-voice-e2e-password';
const RECORD_MS = 2500;

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone'] });
const bobContext = await browser.newContext();

// tt-плеер создаёт `new Audio()` вне DOM — отслеживаем экземпляры, чтобы
// проверить реальное воспроизведение, а не только состояние UI
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


function findVoiceBubble(page) {
  return page.locator('.Transition_slide-active > .MessageList .Message .Audio').last();
}

async function assertVoicePlays(page, label) {
  const bubble = findVoiceBubble(page);
  await bubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const durationText = await bubble.locator('.voice-duration').innerText();
  assert.match(durationText, /0:0[1-9]/, `${label}: duration отображается (${durationText})`);
  await bubble.locator('.toggle-play').click();
  await page.waitForFunction(
    () => (globalThis.__parvaneE2eAudios || []).some((audio) => audio.currentTime > 0.5),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `voice-alice-${suffix}@local`;
  const bob = `voice-bob-${suffix}@local`;

  await trackAudioInstances(aliceContext);
  await trackAudioInstances(bobContext);
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Запись и отправка: кнопка записи → пауза RECORD_MS → главная кнопка ────
  await aliceSession.page.getByRole('button', { name: 'Record voice message' }).click();
  const sendButton = aliceSession.page.getByRole('button', { name: 'Send Message', exact: true });
  await sendButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.waitForTimeout(RECORD_MS);
  await sendButton.click();

  // ── Отправитель: нативный voice-бабл, playback из локального кэша ──────────
  await assertVoicePlays(aliceSession.page, 'alice');

  // ── Получатель: voice-бабл с waveform-канвой, playback после расшифровки ───
  const bobBubble = findVoiceBubble(bobSession.page);
  await bobBubble.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobBubble.locator('canvas').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await assertVoicePlays(bobSession.page, 'bob');

  // ── Персист: reload получателя, ключи приходят через sync ──────────────────
  await relogin(bobSession.page, PASSWORD);
  await openPrivateChat(bobSession.page, alice);
  await assertVoicePlays(bobSession.page, 'bob after reload');

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  console.log('OK: голосовое записано, отправлено E2E, воспроизведено у обеих сторон и пережило reload');
} finally {
  await browser.close();
}
