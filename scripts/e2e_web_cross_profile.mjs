// Кросс-клиентский ПРОФИЛЬ desktop → web: desktop-alice (tdesktop через gateway
// TCP) создаёт группу с bob и ставит bio, телефон, цвет имени и личный канал
// (PARVANE_AUTOPROFILE → identity.user.setname); web-bob открывает профиль
// alice и видит bio, телефон, секцию «Channel» с этой группой, цвет имени.
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
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-xprofile-e2e-password';
const DESKTOP_BIN = process.env.PARVANE_E2E_DESKTOP_BIN
  || new URL('../desktop/build-probe/bin/Telegram', import.meta.url).pathname;
const GATEWAY_TCP_URL = process.env.PARVANE_E2E_GATEWAY_TCP_URL;

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
      PARVANE_NO_LINK_OFFER: '1',
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
    const m = readDesktopLog(workdir).match(pattern);
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
const bobContext = await browser.newContext();
const scratch = mkdtempSync(join(tmpdir(), 'pv-xprofile-'));
const desktopWorkdir = join(scratch, 'alice');
const libraryShim = buildLibraryShim(scratch);
let desktop;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `xp-alice-${suffix}@local`;
  const bob = `xp-bob-${suffix}@local`;
  const groupTitle = `XP Channel ${suffix}`;
  const bio = `desktop bio ${suffix}`;
  const phone = `+7900${String(Date.now()).slice(-6)}`;
  const color = 5;
  const fromBob = `from-web-bob-${suffix}`;

  // ── web-bob регистрируется первым: desktop-alice добавит его в группу ─────
  const bobWeb = await preparePage(bobContext, bob, PASSWORD);

  // ── desktop-alice: группа с bob (~4с), профиль + личный канал (8с) ────────
  desktop = spawnDesktop(desktopWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${alice}:${PASSWORD}`,
    PARVANE_AUTOGROUP: `${groupTitle}:${bob}`,
    PARVANE_AUTOPROFILE: `bio=${bio};phone=${phone};color=${color};channel=${groupTitle}:8`,
  });
  await waitDesktopLog(desktopWorkdir, /E2E-устройство готово/, 90000, desktop);
  const created = await waitDesktopLog(
    desktopWorkdir, new RegExp(`группа '${esc(groupTitle)}' создана.*?([0-9a-f-]{36})`), 60000, desktop,
  );
  const groupId = created[1];
  await waitDesktopLog(desktopWorkdir, /autoprofile применён/, 60000, desktop);
  await waitDesktopLog(desktopWorkdir, /профиль обновлён/, 30000, desktop);
  console.log(`OK: desktop-alice выставила профиль и личный канал (${groupId})`);

  // ── web-bob резолвит alice ПОСЛЕ правки профиля и открывает её профиль ────
  await openPrivateChatStrict(bobWeb.page, alice);
  await sendText(bobWeb.page, fromBob);
  await waitDesktopLog(desktopWorkdir, new RegExp(`входящее msg [\\w-]+ \\(${esc(bob)}\\): ${esc(fromBob)}`), 60000, desktop);
  await findMessage(bobWeb.page, fromBob).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Группа (личный канал) должна быть известна web-bob
  await bobWeb.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await bobWeb.page.locator('.MiddleHeader .chat-info-wrapper').first().click();
  const right = bobWeb.page.locator('#RightColumn');
  await right.getByText(bio, { exact: true }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: web-bob видит bio с десктопа');
  const phoneDigits = phone.replace(/\D/g, '');
  await bobWeb.page.waitForFunction(
    ([sel, digits]) => (document.querySelector(sel)?.textContent || '').replace(/\D/g, '').includes(digits),
    ['#RightColumn', phoneDigits],
    { timeout: LOGIN_TIMEOUT_MS },
  );
  console.log('OK: web-bob видит телефон с десктопа');
  await right.getByText(groupTitle, { exact: true }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: web-bob видит личный канал alice (секция Channel)');

  const aliceNick = alice.split('@')[0];
  const nameColor = await bobWeb.page.evaluate((nick) => {
    const global = window.__parvaneGetGlobal?.();
    const user = Object.values(global?.users.byId || {})
      .find((u) => (u.usernames || []).some((n) => n.username === nick));
    return user?.color?.color;
  }, aliceNick);
  assert.equal(nameColor, color, 'цвет имени alice у web-bob');
  console.log('OK: web-bob видит цвет имени с десктопа');

  console.log('OK: кросс-клиентский профиль desktop → web');
} finally {
  await stopDesktop(desktop);
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
