// Сессия без ежедневного пароля (SESSION-1). Стек сценария выдаёт токен на минуту, gateway сверяет его каждые
// 5 с: открытая вкладка продлевает сессию подписью ключа устройства и остаётся в аккаунте; перезагрузка с
// истёкшим токеном и двое суток без активности пароль не спрашивают. Тишина дольше окна продления (180 суток) —
// экран пароля, после ввода пароля вход проходит.
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
// Срок токена в стеке сценария (`PARVANE_E2E_SESSION_TTL_SECS` раннера)
const TOKEN_TTL_MS = 60_000;
const TOKEN_LIFETIMES_MS = 2 * TOKEN_TTL_MS + 15_000;

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

  // ── Токен истекает у открытой вкладки: сессия продлевается сама ───────────
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const renewals = () => session.logs.filter((line) => line.includes('сессия продлена без пароля')).length;
  const startedAt = Date.now();
  while (Date.now() - startedAt < TOKEN_LIFETIMES_MS) {
    await page.waitForTimeout(5000);
    assert.equal(await passwordScreen.count(), 0, 'экран пароля при истёкшем токене — сессия не продлена');
    // Продление по отказу сервера перезагружает страницу — после неё снова список чатов
    await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  assert(renewals() >= 1, 'за два срока токена сессия ни разу не продлена');
  console.log(`OK: открытая вкладка пережила истечение токена (продлений: ${renewals()})`);

  // ── Перезагрузка с истёкшим сохранённым токеном и двое суток без активности ─
  // pagehide при reload обновляет отметку активности, поэтому устаревшую отметку подкладываем init-скриптом —
  // он выполняется уже после pagehide, перед кодом приложения
  await page.waitForTimeout(TOKEN_TTL_MS + 5000);
  let staleBy = 2 * DAY_MS;
  await page.addInitScript(() => {
    const staleMs = Number(sessionStorage.getItem('e2e:stale-ms') || 0);
    if (staleMs) localStorage.setItem('parvane:last-active', String(Date.now() - staleMs));
    sessionStorage.removeItem('e2e:stale-ms');
  });
  await page.evaluate((value) => sessionStorage.setItem('e2e:stale-ms', String(value)), staleBy);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForTimeout(10_000); // отказ сервера по токену пришёл бы за это время
  assert.equal(await passwordScreen.count(), 0, 'после двух суток тишины и истёкшего токена запрошен пароль');
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: перезагрузка с истёкшим токеном и двое суток тишины — без пароля');

  // ── Тишина дольше окна продления: reload → экран пароля ───────────────────
  staleBy = 181 * DAY_MS;
  await page.evaluate((value) => sessionStorage.setItem('e2e:stale-ms', String(value)), staleBy);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: после 181 суток без активности запрошен пароль');

  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await clickUntil(
    passwordScreen.locator('[data-auth-submit]'),
    () => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  const renewed = await page.evaluate(() => Number(localStorage.getItem('parvane:last-active')));
  assert(renewed > Date.now() - 5 * 60 * 1000, 'после входа отметка активности не обновлена');
  console.log('OK: вход по паролю восстанавливает сессию');

  assertNoPageErrors({ alice: session });
  console.log('OK: сессия продлевается без пароля, пароль — только после окна продления');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir && session) await session.page.screenshot({ path: `${shotDir}/session-expiry.png` }).catch(() => {});
  if (session) console.error(session.logs.slice(-60).join('\n'));
  throw error;
} finally {
  await browser.close();
}
