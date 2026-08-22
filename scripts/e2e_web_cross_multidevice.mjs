// Кросс-клиентский МУЛЬТИДЕВАЙС + ЛИНКОВКА: один аккаунт bob на Web (Chromium)
// и на desktop-форке (tdesktop через gateway TCP) одновременно.
//  1) web-bob накопил историю от alice; свежий desktop-bob публикует оффер
//     линковки, web-bob подтверждает в Settings → Devices (коды совпадают),
//     desktop получает историю;
//  2) живое сообщение alice читают ОБА устройства (fan-out копий);
//  3) исходящее desktop-bob видит web-bob как своё (self-копия по signing_key);
//  4) обратная линковка: свежее web-устройство bob получает историю от desktop
//     (desktop подтверждает автоматически: PARVANE_AUTOLINK_GRANT=1).
// Требует собранный desktop/build-probe/bin/Telegram; иначе SKIP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  findMessage,
  openPrivateChat,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-xmulti-e2e-password';
const DESKTOP_BIN = process.env.PARVANE_E2E_DESKTOP_BIN
  || new URL('../desktop/build-probe/bin/Telegram', import.meta.url).pathname;
const GATEWAY_TCP_URL = process.env.PARVANE_E2E_GATEWAY_TCP_URL;
const DESKTOP_READY = /E2E-устройство готово/;
const LINK_TIMEOUT_MS = 90000;

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

async function waitDesktopLog(workdir, pattern, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const log = readDesktopLog(workdir);
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

async function openPrivateChatStrict(page, address) {
  const name = address.split('@')[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPrivateChat(page, address).catch(() => {});
    const isOpen = await page.locator('.MiddleHeader').getByText(name).first()
      .isVisible().catch(() => false);
    if (isOpen) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  assert.fail(`chat with ${address} did not open`);
}

async function openDevicesScreen(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

async function closeSettings(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await page.locator('#telegram-search-input').isVisible()) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  throw new Error('Failed to return to chat list from settings');
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobWebContext = await browser.newContext();
const bobWeb2Context = await browser.newContext();
const desktopWorkdir = mkdtempSync(join(tmpdir(), 'parvane-xmulti-desktop-'));
const libraryShim = buildLibraryShim(desktopWorkdir);
let desktop;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `xm-alice-${suffix}@local`;
  const bob = `xm-bob-${suffix}@local`;
  const oldText = `old-history-${suffix}`;
  const liveText = `live-both-${suffix}`;
  const fromDesktop = `from-desktop-${suffix}`;

  // ── web-bob + история от alice ─────────────────────────────────────────────
  const bobWeb = await preparePage(bobWebContext, bob, PASSWORD);
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, oldText);
  await openPrivateChatStrict(bobWeb.page, alice);
  await findMessage(bobWeb.page, oldText).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── desktop-bob свежий: оффер линковки → web-bob подтверждает ─────────────
  desktop = spawnDesktop(desktopWorkdir, libraryShim, { PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}` });
  await waitDesktopLog(desktopWorkdir, DESKTOP_READY, 90000, desktop);
  const offer = await waitDesktopLog(desktopWorkdir, /линковка: оффер опубликован, код (\d{6})/, 60000, desktop);
  const desktopCode = offer[1];

  const devScreen = await openDevicesScreen(bobWeb.page);
  const offerItem = devScreen.locator('.ListItem').filter({ hasText: 'Code:' }).first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const webCode = (await offerItem.textContent()).match(/Code: (\d{6})/)[1];
  assert.equal(webCode, desktopCode, 'SAS codes must match (web ↔ desktop)');
  await offerItem.locator('.ListItem-button').click();
  const transferButton = bobWeb.page.getByRole('button', { name: 'Transfer', exact: true });
  await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await transferButton.click();
  await bobWeb.page.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(bobWeb.page);

  await waitDesktopLog(desktopWorkdir, /линковка: история получена/, LINK_TIMEOUT_MS, desktop);
  await waitDesktopLog(desktopWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${esc(alice)}\\): ${oldText}`), 60000, desktop);

  // ── живое: читают оба устройства bob ──────────────────────────────────────
  await aliceSession.page.waitForTimeout(17000); // TTL каталога устройств alice
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, liveText);
  await openPrivateChatStrict(bobWeb.page, alice);
  await findMessage(bobWeb.page, liveText).first().waitFor({ state: 'visible', timeout: 60000 });
  await waitDesktopLog(desktopWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${esc(alice)}\\): ${liveText}`), 60000, desktop);

  // ── исходящее desktop → alice; web-bob видит как своё ─────────────────────
  await stopDesktop(desktop);
  desktop = spawnDesktop(desktopWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_AUTOSEND: `${alice}:${fromDesktop}`,
    PARVANE_AUTOLINK_GRANT: '1',
  });
  await findMessage(aliceSession.page, fromDesktop).first().waitFor({ state: 'visible', timeout: 90000 });
  await findMessage(bobWeb.page, fromDesktop).first().waitFor({ state: 'visible', timeout: 90000 });

  // ── обратная линковка: свежий web-bob2 ← desktop (авто-грант) ─────────────
  const bobWeb2 = await preparePage(bobWeb2Context, bob, PASSWORD);
  bobWeb2.page.on('console', (msg) => {
    if (/линковк/.test(msg.text())) console.log('[web2]', msg.text());
  });
  await waitDesktopLog(desktopWorkdir, /линковка: грант выдан устройству/, 90000, desktop);
  await openPrivateChatStrict(bobWeb2.page, alice);
  await findMessage(bobWeb2.page, oldText).first().waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
  await findMessage(bobWeb2.page, fromDesktop).first().waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });

  const log = readDesktopLog(desktopWorkdir);
  assert(!/ОТКЛОНЕНО/.test(log), 'desktop must not reject legit senders');
  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobWeb.errors, [], `Bob web errors: ${bobWeb.errors.join('; ')}`);
  console.log('OK: web<->desktop multidevice (fan-out, self-copies) and history linking both ways');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, ctx] of [['alice', aliceContext], ['bobweb', bobWebContext], ['bobweb2', bobWeb2Context]]) {
    const page = ctx.pages()[0];
    if (page) await page.screenshot({ path: `${dir}xmulti-${name}.png` }).catch(() => {});
  }
  console.error('Desktop log tail:\n', readDesktopLog(desktopWorkdir).slice(-4000));
  throw err;
} finally {
  await stopDesktop(desktop);
  await aliceContext.close();
  await bobWebContext.close();
  await bobWeb2Context.close();
  await browser.close();
  rmSync(desktopWorkdir, { recursive: true, force: true });
}
