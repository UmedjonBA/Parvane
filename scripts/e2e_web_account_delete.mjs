// Удаление аккаунта (spec 027): Алиса удаляет аккаунт в «Конфиденциальности» (неверный пароль — отказ), вкладка
// уходит на экран входа; вход паролем показывает дату удаления и «Восстановить аккаунт»; у Боба Алиса —
// «Удалённый аккаунт», отправка не уходит; Алиса восстанавливает аккаунт на том же устройстве — история на месте,
// у Боба она снова обычный собеседник и переписка идёт в обе стороны.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  exchangeMessages,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  openSettingsScreen,
  preparePage,
  reloadPage,
  sendText,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-delete-e2e-password';
const STEP_TIMEOUT_MS = 90000;

async function poll(read, isDone, message, timeout = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (isDone(last)) return last;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

// Тип пользователя по нику в сторе UI
function userType(page, nick) {
  return page.evaluate((name) => {
    const g = globalThis.__parvaneGetGlobal?.();
    const user = g && Object.values(g.users.byId).find((u) => u.usernames?.[0]?.username === name);
    return user?.type;
  }, nick);
}

async function submitPassword(page) {
  const form = page.locator('.Transition_slide-active > #auth-password-form');
  await form.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await form.locator('#sign-in-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Next' }).click();
  return form;
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const tag = suffix.replace(/\D/g, '').slice(-8);
  const alice = `del-a-${tag}@local`;
  const bob = `del-b-${tag}@local`;
  const aliceNick = alice.split('@')[0];

  sessions.alice = await preparePage(await browser.newContext(), alice, PASSWORD);
  sessions.bob = await preparePage(await browser.newContext(), bob, PASSWORD);
  const a = sessions.alice.page;
  const b = sessions.bob.page;
  await exchangeMessages(a, alice, b, bob, suffix);
  console.log('OK: переписка до удаления');

  // ── удаление ──
  await openSettingsScreen(a, 'Privacy and Security');
  await a.locator('[data-delete-account-open] .ListItem-button').click();
  const dialog = a.locator('[data-delete-account-dialog]');
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await dialog.locator('#parvane-delete-password').fill(`${PASSWORD}-wrong`);
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click();
  await dialog.locator('[data-delete-account-error="bad_password"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dialog.locator('#parvane-delete-password').fill(PASSWORD);
  const reloaded = a.waitForEvent('load', { timeout: STEP_TIMEOUT_MS });
  await dialog.getByRole('button', { name: 'Delete account', exact: true }).click();
  await dialog.locator('[data-delete-account-done]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await reloaded;
  console.log('OK: аккаунт поставлен на удаление, вкладка ушла на вход');

  // Вход паролем — не ошибка пароля, а дата удаления и «Восстановить аккаунт»
  const form = await submitPassword(a);
  await a.locator('[data-restore-account]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const notice = await form.innerText();
  assert.match(notice, /will be deleted on/, `текст экрана: ${notice}`);
  console.log('OK: вход предлагает восстановить аккаунт');

  // Боб: Алиса — «Удалённый аккаунт» (профиль не находится, журнал с признаком deleted)
  await reloadPage(b);
  await b.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await poll(() => userType(b, aliceNick), (t) => t === 'userTypeDeleted', 'Алиса у Боба удалена', STEP_TIMEOUT_MS);
  await showChatList(b);
  await b.locator('.ListItem.chat-item-clickable').filter({ hasText: 'Deleted Account' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: у Боба — «Удалённый аккаунт»');

  // Восстановление на том же устройстве: история на месте
  await a.locator('[data-restore-account] button').click();
  await a.locator('#LeftColumn').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await showChatList(a);
  await openPrivateChatStrict(a, bob);
  await findMessage(a, `hello-from-b-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: аккаунт восстановлен, история на месте');

  // Боб снова видит Алису и пишет ей; она отвечает
  await reloadPage(b);
  await b.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await poll(() => userType(b, aliceNick), (t) => t === 'userTypeRegular', 'Алиса у Боба восстановлена', STEP_TIMEOUT_MS);
  await showChatList(b);
  await openPrivateChatStrict(b, alice);
  await sendText(b, `after-restore-${suffix}`);
  await findMessage(a, `after-restore-${suffix}`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await sendText(a, `reply-after-restore-${suffix}`);
  await findMessage(b, `reply-after-restore-${suffix}`).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: переписка после восстановления');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий удаления аккаунта пройден');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    console.log(`--- журнал ${name} ---\n${session.logs.slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
