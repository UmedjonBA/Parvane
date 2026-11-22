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
import { shootAuthScreen } from './e2e_web_auth_shots.mjs';

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
  await form.locator('[data-auth-submit]').click();
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
  // spec 041 (`DkSettingsA`, `XpProfile`): «Опасная зона» на «Устройствах и аккаунте» ведёт на экран удаления;
  // кнопка доступна только с паролем и отметкой «Понимаю»
  await openSettingsScreen(a, 'Devices and account');
  await a.locator('[data-delete-account-open]:visible').click();
  const dialog = a.locator('[data-delete-account-dialog]');
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const submit = dialog.locator('[data-delete-account-submit]');
  await dialog.locator('#parvane-delete-password').fill(`${PASSWORD}-wrong`);
  assert.equal(await submit.isDisabled(), true, 'без «Понимаю» удалить нельзя');
  await dialog.locator('[data-delete-account-confirm]').check();
  await submit.click();
  await dialog.locator('[data-delete-account-error="bad_password"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await dialog.locator('#parvane-delete-password').fill(PASSWORD);
  const reloaded = a.waitForEvent('load', { timeout: STEP_TIMEOUT_MS });
  await submit.click();
  await dialog.locator('[data-delete-account-done]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await reloaded;
  console.log('OK: аккаунт поставлен на удаление, вкладка ушла на вход');

  // Вход паролем — не ошибка пароля, а экран «Аккаунт будет удалён» (доска `RpProfileC`): дата, когда запрошено,
  // сколько дней осталось, «Восстановить аккаунт», «Выгрузить мои данные», «Выйти, удаление продолжится»
  const form = await submitPassword(a);
  const pending = a.locator('[data-deletion-pending]');
  await pending.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const notice = await pending.innerText();
  assert.match(notice, /The account will be deleted on/, `текст экрана: ${notice}`);
  assert.match(notice, /You requested deletion on .+\. Until .+ it can be canceled/, `дата запроса: ${notice}`);
  assert.equal(await pending.locator('[data-deletion-days]').getAttribute('data-deletion-days'), '7', 'семь дней до удаления');
  assert.equal(await form.locator('#sign-in-password').isVisible(), false, 'форма входа скрыта');
  await pending.locator('[data-restore-account] button').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await shootAuthScreen(a, 'deletion-pending');
  // «Выйти, удаление продолжится» — снова форма входа, пароль не запомнен; вход снова показывает экран удаления
  await pending.locator('[data-deletion-leave]').click();
  await a.locator('.Transition_slide-active > #auth-phone-number-form').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await a.locator('#sign-in-parvane-address').fill(aliceNick);
  await a.locator('#sign-in-password').fill(PASSWORD);
  await a.locator('[data-auth-submit]').click();
  await pending.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: вход предлагает восстановить аккаунт, «Выйти» удаление не отменяет');

  // Боб: Алиса — «Удалённый аккаунт» (профиль не находится, журнал с признаком deleted)
  await reloadPage(b);
  await b.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await poll(() => userType(b, aliceNick), (t) => t === 'userTypeDeleted', 'Алиса у Боба удалена', STEP_TIMEOUT_MS);
  await showChatList(b);
  await b.locator('.ListItem.chat-item-clickable').filter({ hasText: 'Deleted Account' }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: у Боба — «Удалённый аккаунт»');

  // «Выгрузить мои данные»: экран говорит, что вход отменит удаление; «Войти и выгрузить» восстанавливает аккаунт и
  // сразу открывает выгрузку
  await pending.locator('[data-deletion-export]').click();
  await pending.locator('[data-deletion-export-note]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await pending.locator('[data-deletion-export-confirm]').click();
  await a.locator('#LeftColumn').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await a.locator('[data-export-option="chats"]').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  console.log('OK: «Выгрузить мои данные» — вход с отменой удаления и экран выгрузки');
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
