// Протокол v2 (spec 007, T064): смешанная пара web ↔ desktop. Пара задаётся
// PARVANE_E2E_PAIR: web2-desktop2 — оба на v2 (web: localStorage
// parvane:proto=v2, desktop: PARVANE_PROTO_V2=1); web2-desktop1 — desktop на
// v1 (web v2 обязан говорить с ним по v1). Проверяет текст в обе стороны и
// что для пары v2 отправка десктопа действительно ушла по v2 (журнал
// десктопа «v2 → …»), а приём — через движок («v2 ← …»).
// Требует бинарь desktop/build-probe/bin/Telegram (-DPARVANE_DEV=ON); без
// него — SKIP.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  dismissRecoveryKeyDialog,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-mixed-password';
const PAIR = process.env.PARVANE_E2E_PAIR || 'web2-desktop2';
const desktopIsV2 = PAIR === 'web2-desktop2';

requireGatewayTcpUrl();
skipWithoutDesktop(`protocol mixed ${PAIR}`);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const webLogs = [];
aliceContext.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2')) webLogs.push(t);
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
    } : { PARVANE_AUTOSEND: `${alice}:${desktopToWeb}` }),
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
  console.log(`e2e_protocol_mixed_desktop (${PAIR}): OK`);
} catch (error) {
  console.error(`журнал v2 web: ${webLogs.join('\n')}`);
  console.error(`хвост лога desktop:\n${readDesktopLog(bobWorkdir).slice(-3000)}`);
  throw error;
} finally {
  await stopDesktop(desktop);
  await browser.close();
}
