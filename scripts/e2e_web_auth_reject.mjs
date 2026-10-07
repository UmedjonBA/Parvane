// Отказ сохранённого токена (JWT) (spec 007, T134/T178, правило E6-1). Токен
// проверяет авторизация соединения v2: если сервер его больше не принимает (истёк,
// отозван, сменён ключ подписи), клиент не должен молча остаться «офлайн» — он
// снимает сохранённую сессию и показывает экран входа, а после ввода пароля
// работает дальше с прежней историей.
// Запуск: scripts/run_web_auth_reject_e2e.sh
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  clickUntil,
  exchangeMessages,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-auth-e2e-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
const RESTART_TIMEOUT_MS = 60000;

// identity с новым ключом подписи JWT: все выданные токены перестают приниматься
async function invalidateTokens() {
  const done = join(BACKEND_DIR, 'identity.restarted');
  rmSync(done, { force: true });
  rmSync(join(BACKEND_DIR, 'identity-jwt-ed25519.pem'));
  writeFileSync(join(BACKEND_DIR, 'identity.restart'), '');
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (!existsSync(done)) {
    assert(Date.now() < deadline, 'identity не перезапущен раннером');
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `ar-alice-${suffix}@local`;
  const bob = `ar-bob-${suffix}@local`;
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  const tag = `auth-${suffix}`;
  await exchangeMessages(aliceSession.page, alice, bobSession.page, bob, tag);

  await invalidateTokens();
  console.log('сервер сменил ключ подписи токенов');

  // ── Перезагрузка с сохранённой сессией: токен отвергнут → экран входа ─────
  aliceSession.logs.length = 0;
  await reloadPage(aliceSession.page);
  const passwordScreen = aliceSession.page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 }).catch(() => {
    assert.fail(`alice: после отказа токена экран входа не показан; журнал:\n${aliceSession.logs.slice(-25).join('\n')}`);
  });
  console.log('OK: отвергнутый токен привёл на экран входа');

  // ── Вход паролем: сессия новая, история и переписка на месте ──────────────
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await clickUntil(
    passwordScreen.getByRole('button', { name: 'Next' }),
    () => aliceSession.page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  await openPrivateChatStrict(aliceSession.page, bob);
  await aliceSession.page.locator('.Transition_slide-active > .MessageList .Message').filter({ hasText: tag }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const after = `after-relogin-${suffix}`;
  await sendText(aliceSession.page, after);
  await openPrivateChatStrict(bobSession.page, alice);
  await findMessage(bobSession.page, after).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  console.log('OK: после входа паролем история на месте, сообщения доходят');
} finally {
  await browser.close();
}
