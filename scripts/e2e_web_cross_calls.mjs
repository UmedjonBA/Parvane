// Кросс-клиентский звонок web ↔ desktop (spec 007 T089, SC-008): аудио.
// Web (alice, fake-микрофон) звонит desktop (bob, настоящий движок tg_owt,
// PARVANE_REAL_MEDIA=1, авто-приём), затем desktop звонит web (PARVANE_AUTOCALL). Проверяется: desktop доходит до
// Active (ICE/DTLS установлен), у web идёт таймер активного звонка и растёт
// принятый звук. Пара задаётся PARVANE_E2E_PAIR: call-web-desktop — оба на v1,
// call-web2-desktop2 — оба с включённым v2 (сигналинг звонка при этом v1-путём
// шарда call, запечатанного сигналинга в клиентах нет).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  buildLibraryShim,
  readDesktopLog,
  requireGatewayTcpUrl,
  skipWithoutDesktop,
  spawnDesktop,
  stopDesktop,
  waitDesktopLog,
} from './e2e_desktop_helpers.mjs';
import {
  dismissRecoveryKeyDialog,
  expectMediaFlowing,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-cross-calls-password';
const PAIR = process.env.PARVANE_E2E_PAIR || 'call-web-desktop';
const isV2 = PAIR === 'call-web2-desktop2';
const CALL_TIMEOUT_MS = 60000;

requireGatewayTcpUrl();
skipWithoutDesktop(`cross calls ${PAIR}`);

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone'] });
const consoleTail = [];
// Сигналы звонков, опубликованные web на v1-шину
const callSignalsV1 = [];
aliceContext.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('не реализован')) return;
    consoleTail.push(`${new Date().toISOString().slice(11, 23)} ${m.type()}: ${t.slice(0, 300)}`);
    if (consoleTail.length > 120) consoleTail.shift();
  });
  page.on('pageerror', (e) => consoleTail.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string') return;
    try {
      const frame = JSON.parse(payload);
      if (frame.op === 'pub' && frame.subject === 'call.signal') callSignalsV1.push(frame.subject);
    } catch {
      // двоичный кадр v2 — не наш случай
    }
  }));
});
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-cross-calls-'));
const libraryShim = buildLibraryShim(bobWorkdir);
let desktop;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `cca-${suffix}@local`;
  const bob = `ccb-${suffix}@local`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD, {
    seedLocalStorage: { 'parvane:proto': isV2 ? 'v2' : 'v1' },
  });
  if (isV2) await dismissRecoveryKeyDialog(aliceSession.page);
  const { page } = aliceSession;

  const hello = `cc-hello-${suffix}`;
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_AUTOACCEPT: '1',
    PARVANE_REAL_MEDIA: '1',
    PARVANE_NO_LINK_OFFER: '1',
    ...(isV2 ? { PARVANE_PROTO_V2: '1', PARVANE_AUTOSEND_V2: `${alice}:${hello}` }
      : { PARVANE_PROTO_V2: '0', PARVANE_AUTOSEND: `${alice}:${hello}` }),
  });
  await waitDesktopLog(bobWorkdir, isV2 ? /v2: готов/ : /E2E-устройство готово/, 90000, desktop);
  // Переписка до звонка: чат и ключи собеседника известны обеим сторонам
  await openPrivateChatStrict(page, bob);
  await findMessage(page, hello).first().waitFor({ state: 'visible', timeout: 90000 });
  await sendText(page, `cc-answer-${suffix}`);

  // ── web → desktop ───────────────────────────────────────────────────────────
  const callFrom = readDesktopLog(bobWorkdir).length;
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await waitDesktopLog(bobWorkdir, /ВХОДЯЩИЙ звонок от/, CALL_TIMEOUT_MS, desktop, { since: callFrom });
  await waitDesktopLog(bobWorkdir, /звонок → Active/, CALL_TIMEOUT_MS, desktop, { since: callFrom });
  assert.match(readDesktopLog(bobWorkdir), /медиа-движок = webrtc/, 'desktop: звонок не на настоящем webrtc-движке');
  await page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(page, { audio: true });
  await page.getByRole('button', { name: 'End Call' }).click();
  await page.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  console.log(`e2e_web_cross_calls (${PAIR}): web → desktop соединён, звук от desktop принят`);

  // ── desktop → web: десктоп перезапускается с хуком вызова, web принимает ────
  // tdesktop при перезапуске начинает лог заново — журнал первого звонка берём сейчас
  const firstCallLog = readDesktopLog(bobWorkdir);
  await stopDesktop(desktop);
  const restartFrom = readDesktopLog(bobWorkdir).length;
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_REAL_MEDIA: '1',
    PARVANE_NO_LINK_OFFER: '1',
    PARVANE_AUTOCALL: alice,
    PARVANE_PROTO_V2: isV2 ? '1' : '0',
  });
  await waitDesktopLog(bobWorkdir, /AUTOCALL → /, 90000, desktop, { since: restartFrom });
  await page.getByText('is calling you...', { exact: true }).waitFor({ state: 'visible', timeout: CALL_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Accept' }).click();
  await waitDesktopLog(bobWorkdir, /звонок → Active/, CALL_TIMEOUT_MS, desktop, { since: restartFrom });
  await page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMediaFlowing(page, { audio: true });
  await page.getByRole('button', { name: 'End Call' }).click();
  await page.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  console.log(`e2e_web_cross_calls (${PAIR}): desktop → web соединён, звук от desktop принят`);

  // Путь сигналинга: у пары v2 — запечатанные конверты (D-08), на v1-шину web не
  // публикует ни одного call.signal; у пары v1 — наоборот, v2-сигналов нет
  const desktopLog = `${firstCallLog}\n${readDesktopLog(bobWorkdir)}`;
  if (isV2) {
    assert.match(desktopLog, /v2 ← .* сигнал звонка \(invite\)/, 'desktop: вызов web пришёл не по v2');
    assert.match(desktopLog, /v2 → .* сигнал звонка \(answer\)/, 'desktop: ответ ушёл не по v2');
    assert.match(desktopLog, /v2 → .* сигнал звонка \(invite\)/, 'desktop: свой вызов ушёл не по v2');
    assert.deepEqual(callSignalsV1, [], 'web: сигналы звонка ушли v1-путём');
  } else {
    assert.doesNotMatch(desktopLog, /сигнал звонка \(/, 'desktop v1: сигнал звонка ушёл по v2');
    assert.ok(callSignalsV1.length > 0, 'web v1: сигналы звонка не публиковались');
  }
  console.log(`e2e_web_cross_calls (${PAIR}): сигналинг шёл ${isV2 ? 'запечатанными конвертами v2' : 'v1-путём шарда call'}`);
  console.log(`e2e_web_cross_calls (${PAIR}): OK`);
} catch (error) {
  // Состояние WebRTC на стороне web: где именно остановилось соединение
  const peers = await aliceContext.pages()[0]?.evaluate(async () => Promise.all(
    (globalThis.__parvaneE2ePeers || []).map(async (pc) => {
      const stats = [];
      (await pc.getStats()).forEach((r) => {
        if (['candidate-pair', 'local-candidate', 'remote-candidate', 'transport'].includes(r.type)) {
          stats.push(`${r.type}:${r.state || r.candidateType || r.dtlsState || ''}:${r.address || ''}:${r.protocol || ''}`);
        }
      });
      return {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        signaling: pc.signalingState,
        local: pc.localDescription?.type,
        remote: pc.remoteDescription?.type,
        remoteSdp: pc.remoteDescription?.sdp?.split('\n').filter((l) => /^(m=|a=(candidate|setup|fingerprint|ice-ufrag|mid|group|rtcp-mux|sendrecv|recvonly|sendonly|inactive))/.test(l)).join(' | '),
        localSdp: pc.localDescription?.sdp?.split('\n').filter((l) => /^(m=|a=(candidate|setup|mid|group))/.test(l)).join(' | '),
        stats,
      };
    }),
  )).catch((e) => String(e));
  console.error(`WebRTC web: ${JSON.stringify(peers, undefined, 1)}`);
  console.error(`консоль web:\n${consoleTail.join('\n')}`);
  console.error(`лог desktop (звонок):\n${readDesktopLog(bobWorkdir).split('\n')
    .filter((l) => /Parvane:/.test(l) && !/групп синхр|MTP|Config/.test(l)).slice(-80).join('\n')}`);
  throw error;
} finally {
  if (desktop) await stopDesktop(desktop);
  await browser.close();
}
