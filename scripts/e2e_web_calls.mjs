// Двухбраузерный звонок 1-на-1: вызов из шапки чата, входящий оверлей,
// принятие с fake-микрофоном, совпадение SAS-эмодзи, mute, видеозвонок с
// рендером потоков, завершение/отклонение и история звонков в чате
// (включая персист после reload).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  openPrivateChat,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-calls-e2e-password';

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // С выданным mic-разрешением Chromium иначе фильтрует loopback-кандидаты —
    // relay-тест против TURN на 127.0.0.1 без флага не соединяется
    '--allow-loopback-in-peer-connection',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
const bobContext = await browser.newContext({ permissions: ['microphone', 'camera'] });

async function relogin(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function findHistoryEntry(page, text) {
  return page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text }).first();
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `call-alice-${suffix}@local`;
  const bob = `call-bob-${suffix}@local`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(bobSession.page, alice);

  // ── Исходящий вызов и входящий оверлей ─────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('ringing...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Принятие: активный звонок с таймером и совпадающим SAS ─────────────────
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  const aliceSas = aliceSession.page.locator('[title*="fully secure"]');
  const bobSas = bobSession.page.locator('[title*="fully secure"]');
  await aliceSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Таймер длительности: формат 0:SS появляется только в состоянии active
  await aliceSession.page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const aliceSasText = (await aliceSas.innerText()).trim();
  const bobSasText = (await bobSas.innerText()).trim();
  assert(aliceSasText.length > 0, 'SAS is empty on the caller side');
  assert.equal(aliceSasText, bobSasText, 'SAS emoji differ between the two peers');

  // ── Busy: третий пользователь звонит занятой стороне и видит «занято» ──────
  const carolContext = await browser.newContext({ permissions: ['microphone'] });
  const carolSession = await preparePage(carolContext, `call-carol-${suffix}@local`, PASSWORD);
  await openPrivateChat(carolSession.page, alice);
  await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await carolSession.page.getByText('Line busy', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Оверлей закрывается сам через пару секунд
  await carolSession.page.getByText('Line busy', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await carolContext.close();

  // ── Mute: кнопка переключается и меняет aria ───────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Завершение звонка ──────────────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Видеозвонок: рендер удалённого потока и локального превью ──────────────
  await aliceSession.page.getByRole('button', { name: 'More actions' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Video Call' }).click();
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  // Удалённое видео (плюс локальное превью у обеих сторон)
  await aliceSession.page.locator('video').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.locator('video').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Камера: переключение и обратно
  await aliceSession.page.getByRole('button', { name: 'Turn camera off' }).click();
  await aliceSession.page.getByRole('button', { name: 'Turn camera on' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.getByRole('button', { name: 'Turn camera on' }).click();
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение повторного вызова ───────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── История звонков в чате: статусы у обеих сторон ─────────────────────────
  await findHistoryEntry(aliceSession.page, 'Outgoing Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(aliceSession.page, 'Outgoing Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(aliceSession.page, 'Declined Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(bobSession.page, 'Incoming Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(bobSession.page, 'Incoming Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Персист истории: reload, источник — call-шард ──────────────────────────
  await relogin(aliceSession.page);
  await openPrivateChat(aliceSession.page, bob);
  await findHistoryEntry(aliceSession.page, 'Outgoing Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── TURN fallback: relay-only звонок соединяется ТОЛЬКО через TURN ─────────
  if (process.env.PARVANE_E2E_TURN) {
    const forceRelaySeed = { 'parvane:e2e:forceRelay': '1' };
    const carolContext = await browser.newContext({ permissions: ['microphone'] });
    const daveContext = await browser.newContext({ permissions: ['microphone'] });
    try {
      const carol = `call-carol-${suffix}@local`;
      const dave = `call-dave-${suffix}@local`;
      const carolSession = await preparePage(carolContext, carol, PASSWORD, {
        seedLocalStorage: forceRelaySeed,
      });
      const daveSession = await preparePage(daveContext, dave, PASSWORD, {
        seedLocalStorage: forceRelaySeed,
      });
      await openPrivateChat(carolSession.page, dave);
      await openPrivateChat(daveSession.page, carol);
      await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
      await daveSession.page.getByRole('button', { name: 'Accept' })
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await daveSession.page.getByRole('button', { name: 'Accept' }).click();
      // active достижим только если relay-кандидаты через TURN сработали
      await carolSession.page.getByText(/^\d+:\d{2}$/).first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await daveSession.page.getByText(/^\d+:\d{2}$/).first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await carolSession.page.getByRole('button', { name: 'End Call' }).click();
      console.log('OK: relay-only звонок через TURN с ephemeral-кредами');
    } finally {
      await carolContext.close();
      await daveContext.close();
    }
  } else {
    console.log('SKIP: TURN не поднят в стеке (нет go) — relay-тест пропущен');
  }

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: звонки — SAS, mute, видео с рендером, decline, история и TURN relay');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}calls-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
