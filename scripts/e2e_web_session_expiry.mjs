// «Оставаться в системе» действует сутки без активности: после reload с
// отметкой активности старше суток показывается экран пароля (сохранённый
// пароль стёрт), после ввода пароля вход проходит, свежая сессия — автологин.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  clickUntil,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-session-expiry-e2e-password';
const DAY_MS = 24 * 60 * 60 * 1000;

const browser = await chromium.launch();
const context = await browser.newContext();
let session;

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `expiry-alice-${suffix}@local`;
  session = await preparePage(context, alice, PASSWORD);
  const { page } = session;

  // ── Свежая сессия: reload → автологин ─────────────────────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const lastActive = await page.evaluate(() => Number(localStorage.getItem('parvane:last-active')));
  assert(lastActive > Date.now() - 5 * 60 * 1000, 'отметка активности не записана');
  console.log('OK: свежая сессия — автологин после reload');

  // ── Сутки тишины: reload → экран пароля ───────────────────────────────────
  // pagehide при reload обновляет отметку активности (это и есть «последняя
  // активность»), поэтому устаревшую отметку подкладываем init-скриптом —
  // он выполняется уже после pagehide, перед кодом приложения
  const stale = Date.now() - DAY_MS - 60_000;
  await page.addInitScript((value) => localStorage.setItem('parvane:last-active', String(value)), stale);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: после суток без активности запрошен пароль');

  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await clickUntil(
    passwordScreen.getByRole('button', { name: 'Next' }),
    () => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  const renewed = await page.evaluate(() => Number(localStorage.getItem('parvane:last-active')));
  assert(renewed > Date.now() - 5 * 60 * 1000, 'после входа отметка активности не обновлена');
  console.log('OK: вход по паролю восстанавливает сессию');

  assertNoPageErrors({ alice: session });
  console.log('OK: срок сессии — сутки без активности');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir && session) await session.page.screenshot({ path: `${shotDir}/session-expiry.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
