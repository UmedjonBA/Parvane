// Смена ника (spec 026): Алиса меняет ник в «Моём профиле» (пароль + ключ восстановления). Чат с Бобом и группа
// остаются; Боб пишет на прежний ник — доходит; Боб видит служебное «сменила ник» и продолжает переписку в том
// же чате; группа пишется в обе стороны; второе устройство Алисы входит прежним ником и само переходит на новый.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  autoDismissRecoveryKeyDialog,
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  findMessage,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  openEditProfile,
  openGroupChatByTitle,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  sendText,
  showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-rename-e2e-password';
const RENAME_TIMEOUT_MS = 90000;

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

// Свой ник по данным UI (username текущего пользователя)
function ownUsername(page) {
  return page.evaluate(() => {
    const g = globalThis.__parvaneGetGlobal?.();
    const me = g?.currentUserId && g.users.byId[g.currentUserId];
    return me?.usernames?.[0]?.username;
  });
}

const browser = await chromium.launch();
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const tag = suffix.replace(/\D/g, '').slice(-8);
  const alice = `ren-a-${tag}@local`;
  const bob = `ren-b-${tag}@local`;
  const newNick = `renamed-${tag}`;

  // Ключ восстановления Алиса читает из диалога (сценарий протокола: диалог не закрывается сам)
  sessions.alice = await preparePage(await browser.newContext(), alice, PASSWORD, { seedLocalStorage: { 'parvane:proto': 'v2' } });
  const a = sessions.alice.page;
  const keyText = await dismissRecoveryKeyDialog(a, 60000);
  const recoveryKey = keyText?.match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/)?.[0];
  assert.ok(recoveryKey, `ключ восстановления не найден: ${keyText}`);
  await autoDismissRecoveryKeyDialog(a);
  sessions.bob = await preparePage(await browser.newContext(), bob, PASSWORD);
  const b = sessions.bob.page;
  await exchangeMessages(a, alice, b, bob, suffix);
  const group = `ren-club-${tag}`;
  await createGroupViaUi(a, group, [bob.split('@')[0]]);
  await openGroupChatByTitle(a, group);
  await sendText(a, `group-before-${suffix}`);
  await openGroupChatByTitle(b, group);
  await findMessage(b, `group-before-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: переписка и группа до смены ника');

  // Второе устройство Алисы
  sessions.alice2 = await preparePage(await browser.newContext(), alice, PASSWORD);
  const a2 = sessions.alice2.page;
  await linkSecondDevice(a, a2);
  console.log('OK: второе устройство привязано');

  // ── смена ника ──
  await openEditProfile(a);
  await a.locator('[data-rename-open] .ListItem-button').click();
  const dialog = a.locator('[data-rename-dialog]');
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Ник занят — отказ с объяснением
  await dialog.locator('#parvane-rename-nick').fill(bob.split('@')[0]);
  await dialog.locator('#parvane-rename-password').fill(PASSWORD);
  await dialog.locator('#parvane-rename-key').fill(recoveryKey);
  await dialog.getByRole('button', { name: 'Change', exact: true }).click();
  await dialog.locator('[data-rename-error="taken"]').waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  // Неверный пароль
  await dialog.locator('#parvane-rename-nick').fill(newNick);
  await dialog.locator('#parvane-rename-password').fill(`${PASSWORD}-wrong`);
  await dialog.getByRole('button', { name: 'Change', exact: true }).click();
  await dialog.locator('[data-rename-error="bad_password"]').waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await dialog.locator('#parvane-rename-password').fill(PASSWORD);
  const reloaded = a.waitForEvent('load', { timeout: RENAME_TIMEOUT_MS });
  await dialog.getByRole('button', { name: 'Change', exact: true }).click();
  await dialog.locator('[data-rename-done]').waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await reloaded;
  await a.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await poll(() => ownUsername(a), (u) => u === newNick, 'свой ник после перезагрузки', RENAME_TIMEOUT_MS);
  console.log('OK: ник сменён, вкладка вошла под новым адресом без пароля');

  // Боб ещё не знает: пишет на прежний адрес — в тот же чат у Алисы
  await showChatList(b);
  await openPrivateChatStrict(b, alice);
  await sendText(b, `to-old-${suffix}`);
  await showChatList(a);
  await openPrivateChatStrict(a, bob);
  await findMessage(a, `to-old-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  // История до смены — в том же чате
  await findMessage(a, `hello-from-b-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: сообщение на прежний ник дошло, история на месте');

  // Боб узнаёт о смене: служебное сообщение в том же чате, ответ Алисы туда же
  await sendText(a, `from-new-${suffix}`);
  await findMessage(b, `from-new-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await poll(
    () => b.locator('.ActionMessage').filter({ hasText: `changed username to @${newNick}` }).count(),
    (n) => n > 0,
    'служебное «сменил ник» у Боба',
    RENAME_TIMEOUT_MS,
  );
  const chats = await b.evaluate((addrs) => {
    const g = globalThis.__parvaneGetGlobal?.();
    return Object.values(g.users.byId).filter((u) => addrs.includes(u.usernames?.[0]?.username)).map((u) => u.id);
  }, [alice.split('@')[0], newNick]);
  assert.equal(new Set(chats).size, 1, `у Боба один чат с Алисой: ${JSON.stringify(chats)}`);
  await sendText(b, `to-new-${suffix}`);
  await findMessage(a, `to-new-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  console.log('OK: Боб видит смену ника, переписка в том же чате');

  // Группа в обе стороны
  await openGroupChatByTitle(b, group);
  await sendText(b, `group-bob-after-${suffix}`);
  await openGroupChatByTitle(a, group);
  await findMessage(a, `group-bob-after-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await sendText(a, `group-alice-after-${suffix}`);
  await findMessage(b, `group-alice-after-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  console.log('OK: группа после смены ника');

  // Второе устройство: сессия прежнего адреса закрыта — вход прежним ником переводит его на новый
  await reloadPage(a2);
  const passwordScreen = a2.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await a2.locator('#LeftColumn').waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await poll(() => ownUsername(a2), (u) => u === newNick, 'ник на втором устройстве', RENAME_TIMEOUT_MS);
  await poll(
    () => Promise.resolve(sessions.alice2.logs.some((l) => l.includes('ник сменён на другом устройстве'))),
    Boolean,
    'второе устройство перешло на новый адрес',
    RENAME_TIMEOUT_MS,
  );
  // Новое устройство в журнале нового адреса Боб узнаёт обычным перечитыванием журнала собеседника (раз в 15 с
  // при отправке) — как любое новое устройство контакта
  await b.waitForTimeout(17000);
  // Чат Боба с Алисой — прежний (имя в шапке — прежнее отображаемое имя)
  await showChatList(b);
  await openPrivateChatStrict(b, alice);
  await sendText(b, `both-devices-${suffix}`);
  await openPrivateChatStrict(a2, bob);
  await findMessage(a2, `both-devices-${suffix}`).first().waitFor({ state: 'visible', timeout: RENAME_TIMEOUT_MS });
  await findMessage(a2, `hello-from-b-${suffix}`).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: второе устройство на новом адресе, история на месте');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий смены ника пройден');
} catch (error) {
  for (const [name, session] of Object.entries(sessions)) {
    console.log(`--- журнал ${name} ---\n${session.logs.slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
