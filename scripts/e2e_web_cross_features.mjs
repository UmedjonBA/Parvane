// Кросс-клиентская проверка фич desktop от 2026-09-02 на одном стеке:
// Web (Chromium через gateway WS) + desktop-форк (gateway TCP, headless).
//  - «read at»: desktop шлёт alice текст, alice (web) читает → desktop по хуку
//    PARVANE_AUTOREADERS запрашивает msg.chat.readers и логирует alice@ts.
//  - live-локация web→desktop: alice шарит Live Location 15 min → desktop
//    логирует приём geoLive и, после смены геопозиции, правку локации.
//  - отзыв устройства: bob (web, второе устройство того же аккаунта) в
//    Settings→Devices терминирует desktop-сессию → JWT desktop (с device_id)
//    гаснет: desktop логирует «sync ошибка».
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  dumpDiagJournal,
  findMessage,
  openPrivateChatStrict,
  preparePage,
  relogin,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-xfeat-e2e-password';
const DESKTOP_BIN = process.env.PARVANE_E2E_DESKTOP_BIN
  || new URL('../desktop/build-probe/bin/Telegram', import.meta.url).pathname;
const GATEWAY_TCP_URL = process.env.PARVANE_E2E_GATEWAY_TCP_URL;
const DESKTOP_READY = /E2E-устройство готово/;
const READERS_DELAY_SECS = 45;

assert(GATEWAY_TCP_URL, 'PARVANE_E2E_GATEWAY_TCP_URL is required');
if (!existsSync(DESKTOP_BIN)) {
  console.log(`SKIP: desktop binary is not built (${DESKTOP_BIN})`);
  process.exit(0);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

async function waitDesktopLog(workdir, pattern, timeoutMs, child, { after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = readDesktopLog(workdir).slice(after);
    const m = log.match(pattern);
    if (m) return m;
    if (child.exitCode !== null) {
      throw new Error(`desktop exited with code ${child.exitCode} while waiting for ${pattern}`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  throw new Error(`Timed out waiting desktop log ${pattern}; tail:\n${readDesktopLog(workdir).slice(-2500)}`);
}

async function stopDesktop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({
  permissions: ['geolocation'], geolocation: { latitude: 52.52, longitude: 13.405 },
});
const bobWebContext = await browser.newContext();
const desktopWorkdir = mkdtempSync(join(tmpdir(), 'parvane-xfeat-desktop-'));
const libraryShim = buildLibraryShim(mkdtempSync(join(tmpdir(), 'parvane-xfeat-shim-')));
let desktop;
let aliceSession;
let bobWeb;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `xf-alice-${suffix}@local`;
  const bob = `xf-bob-${suffix}@local`;
  const fromDesktop = `from-desktop-${suffix}`;

  // ── alice (web) входит первой, чтобы прочитать сообщение desktop до хука ────
  aliceSession = await preparePage(aliceContext, alice, PASSWORD);

  desktop = spawnDesktop(desktopWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_NO_LINK_OFFER: '1',
    PARVANE_AUTOSEND: `${alice}:${fromDesktop}`,
    PARVANE_AUTOREADERS: String(READERS_DELAY_SECS),
  });
  await waitDesktopLog(desktopWorkdir, DESKTOP_READY, 90000, desktop);

  // ── «read at»: alice открывает чат → прочитано → desktop видит alice в readers
  await aliceSession.page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChatStrict(aliceSession.page, bob);
  await findMessage(aliceSession.page, fromDesktop).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const readers = await waitDesktopLog(
    desktopWorkdir,
    new RegExp(`readers [\\w-]+: (.*)`),
    (READERS_DELAY_SECS + 60) * 1000,
    desktop,
  );
  assert.match(readers[1], new RegExp(`${esc(alice)}@\\d+`), `readers без alice: ${readers[1]}`);
  console.log(`[cross-features] read at: ${readers[1]}`);

  // ── live-локация web→desktop ───────────────────────────────────────────────
  const logBeforeLive = readDesktopLog(desktopWorkdir).length;
  await aliceSession.page.getByRole('button', { name: 'Add an attachment' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Live Location' }).hover();
  await aliceSession.page.getByRole('menuitem', { name: '15 min' }).click();
  const live = await waitDesktopLog(
    desktopWorkdir, /live-локация live_period=(\d+) lat=([\d.]+) long=([\d.]+)/, 60000, desktop, { after: logBeforeLive },
  );
  assert.equal(live[1], '900', 'live_period ≠ 15 мин');
  assert.equal(Number(live[2]).toFixed(2), '52.52', `lat ${live[2]}`);
  console.log(`[cross-features] live location received: ${live[0]}`);

  const logBeforeMove = readDesktopLog(desktopWorkdir).length;
  await aliceContext.setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  await waitDesktopLog(desktopWorkdir, /правка локации применена msg [\w-]+/, 60000, desktop, { after: logBeforeMove });
  const moved = await waitDesktopLog(desktopWorkdir, /live-локация live_period=\d+ lat=48\.85\d+ long=2\.35\d+/, 60000, desktop, { after: logBeforeMove });
  console.log(`[cross-features] live location updated: ${moved[0]}`);

  // ── отзыв desktop-устройства из web Settings→Devices ───────────────────────
  bobWeb = await preparePage(bobWebContext, bob, PASSWORD);
  await bobWeb.page.getByRole('button', { name: 'Open menu' }).first().click();
  await bobWeb.page.getByRole('menuitem', { name: 'Settings' }).click();
  await bobWeb.page.getByRole('button', { name: 'Devices' }).click();
  const sessionsScreen = bobWeb.page.locator('.SettingsActiveSessions');
  await sessionsScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sessionsScreen.getByText('THIS DEVICE').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const desktopSession = sessionsScreen.locator('.ListItem').filter({ hasText: /Web |Desktop/ }).first();
  await desktopSession.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const logBeforeRevoke = readDesktopLog(desktopWorkdir).length;
  await desktopSession.locator('.ListItem-button').click();
  const terminateButton = bobWeb.page.getByRole('button', { name: 'Terminate Session' });
  await terminateButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await terminateButton.click();
  await sessionsScreen.getByText('Active sessions').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await relogin(bobWeb.page, PASSWORD);

  const syncError = await waitDesktopLog(desktopWorkdir, /sync ошибка: (.*)/, 120000, desktop, { after: logBeforeRevoke });
  console.log(`[cross-features] desktop after revoke: ${syncError[0]}`);

  console.log('web cross-features e2e: OK');
} catch (error) {
  if (aliceSession) await dumpDiagJournal(aliceSession.page, 'alice').catch(() => {});
  console.error(`--- desktop log tail ---\n${readDesktopLog(desktopWorkdir).slice(-3000)}`);
  throw error;
} finally {
  await stopDesktop(desktop);
  await aliceContext.close();
  await bobWebContext.close();
  await browser.close();
}
