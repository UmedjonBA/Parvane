// Ключ восстановления через Telegram-бота (spec 015). Роль бота играет сценарий
// (как в e2e_web_telegram_register.mjs): забирает у сервера сообщения для
// владельца и передаёт его ответ.
// Проверяет:
//  1. после регистрации ключ восстановления уходит владельцу в Telegram — тот
//     же, что в диалоге; повторно сервер его не шлёт;
//  2. вход с нового устройства: бот получает просьбу спросить ключ; неверный
//     ключ отклонён, верный принят;
//  3. новое устройство входит в журнал устройств БЕЗ участия первого (оно
//     закрыто): видна прежняя переписка, отправка и приём работают, планировщик
//     синхронизирован;
//  4. первое устройство после этого не отозвано: открывается, пишет и получает;
//  5. обрыв связи посреди привязки её не отменяет (материал лежит в хранилище);
//  6. ключ в базе identity открытым текстом не лежит;
//  7. аккаунт без копии ключей (создан до spec 015): действующее устройство само
//     заводит копию из ответа владельца боту, новое входит по ней — прежнее не
//     отозвано.
// Запуск: scripts/run_web_telegram_recovery_e2e.sh
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, closeSettings, dismissRecoveryKeyDialog, findMessage, openDevicesScreen,
  openPrivateChatStrict, requireEnv, sendText, submitNick,
} from './e2e_web_helpers.mjs';
import { botConfirmV2, botPullV2, botReplyV2 } from './e2e_tg_confirm_v2.mjs';

const PASSWORD = 'Parvane-telegram-recovery-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const TG_ALICE = 5001;
const TG_BOB = 5002;
const TG_CAROL = 5003;
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 30000;
const JOIN_TIMEOUT_MS = 90000;
const KEY_PATTERN = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){9})/;
// Снимки экранов для просмотра глазами (необязательно)
const SHOT_DIR = process.env.PARVANE_E2E_SHOT_DIR;
const PHONE = { width: 390, height: 844 };

async function shoot(page, name) {
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) }).catch(() => undefined);
}

const { baseUrl, gatewayUrl } = requireEnv();

async function openStartPage(context) {
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[parvane]')) {
      logs.push(text.slice(0, 300));
      if (logs.length > 600) logs.shift();
    }
  });
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, logs, startScreen };
}

async function pressAuthButton(page, screen, name, targetScreenId) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await screen.getByRole('button', { name }).dispatchEvent('mousedown', { button: 0 });
    try {
      await page.locator(`.Transition_slide-active > ${targetScreenId}`).waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
}

function waitLog(session, pattern, timeout = STEP_TIMEOUT_MS) {
  if (session.logs.some((line) => pattern.test(line))) return Promise.resolve();
  return session.page.waitForEvent('console', {
    predicate: (message) => pattern.test(message.text()),
    timeout,
  });
}

/** Регистрация через форму с подтверждением «ботом»; возвращает сессию и ключ из диалога. */
async function register(context, nick, telegramId) {
  const session = await openStartPage(context);
  const { page, startScreen } = session;
  await pressAuthButton(page, startScreen, 'Create account', '#auth-registration-form');
  const form = page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(nick);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const token = /start=([A-Za-z0-9_-]+)$/.exec(await link.getAttribute('href'))[1];
  const confirm = await botConfirmV2(gatewayUrl, SECRET, token, telegramId, `tg${telegramId}`);
  assert.equal(confirm.ok, true, `подтверждение: ${JSON.stringify(confirm)}`);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Ключ уходит владельцу в Telegram — окна с ключом в приложении нет
  const [message] = await pullFor(telegramId, 'key');
  assert.equal(message.user, `${nick}@local`);
  assert.match(message.recoveryKey, KEY_PATTERN, `${nick}: бот получил не ключ`);
  assert.equal(await dismissRecoveryKeyDialog(page, 2500), undefined, `${nick}: окно с ключом показано, хотя ключ ушёл в Telegram`);
  return { ...session, key: message.recoveryKey, address: `${nick}@local` };
}

/** Вход по нику и паролю на новом устройстве (без регистрации). */
async function login(context, nick) {
  const session = await openStartPage(context);
  const { page } = session;
  await submitNick(page, nick);
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { ...session, address: `${nick}@local` };
}

/** После открытия или перезагрузки: сессия возобновляется сама либо просит пароль. */
async function ensureSignedIn(page) {
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
    await passwordScreen.getByRole('button', { name: 'Next' }).click();
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Шифрованное хранилище устройства (`secureStorage.ts`): IndexedDB `parvane-e2e-v2` /
// `secure-state`, именованные записи `rec:<адрес>:<имя>`
function dropSecureRecords(page, address, names) {
  return page.evaluate((keys) => new Promise((resolve, reject) => {
    const open = indexedDB.open('parvane-e2e-v2');
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('secure-state', 'readwrite');
      keys.forEach((key) => tx.objectStore('secure-state').delete(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
    };
  }), names.map((name) => `rec:${address}:${name}`));
}

/** Сообщения бота для одного владельца: забираем и сразу подтверждаем доставку. */
async function pullFor(telegramId, kind, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const messages = await botPullV2(gatewayUrl, SECRET, [], 2000);
    const mine = messages.filter((m) => m.telegramId === telegramId && m.kind === kind);
    if (messages.length) await botPullV2(gatewayUrl, SECRET, messages.map((m) => m.id), 0);
    if (mine.length) return mine;
    assert(Date.now() < deadline, `бот не получил сообщение «${kind}» для ${telegramId}`);
  }
}

async function openPlanner(page) {
  const planner = page.locator('#ParvanePlanner');
  if (!(await planner.count())) await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Planner' }).click();
  await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  return planner;
}

async function closePlanner(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: 'Chats' }).click();
  await page.locator('#ParvanePlanner').waitFor({ state: 'detached', timeout: STEP_TIMEOUT_MS });
}

async function createTask(page, name) {
  const planner = await openPlanner(page);
  await planner.getByText('Calendar', { exact: true }).first().click();
  await planner.getByRole('button', { name: '+ Task', exact: true }).click();
  await page.locator('#planner-new-name').fill(name);
  await planner.getByRole('button', { name: 'Create' }).click();
  await planner.getByRole('heading', { name }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await planner.locator('[data-planner-side]').getByRole('button', { name: 'Close' }).first().click();
}

async function expectTask(page, name, timeout = JOIN_TIMEOUT_MS) {
  const planner = await openPlanner(page);
  await planner.getByText('Tasks', { exact: true }).first().click();
  await planner.getByRole('button', { name, exact: false }).first().waitFor({ state: 'visible', timeout });
}

const browser = await chromium.launch();
// Сессии — для разбора падения (журнал провайдера)
const sessions = {};

try {
  const suffix = `${Date.now().toString(36)}${process.pid}`;
  const aliceNick = `rk-a-${suffix}`;
  const bobNick = `rk-b-${suffix}`;

  // ── 1. Регистрация: ключ восстановления уходит владельцу в Telegram ──
  const aliceContext1 = await browser.newContext({ viewport: WIDE });
  const alice1 = await register(aliceContext1, aliceNick, TG_ALICE);
  sessions.alice1 = alice1;
  await new Promise((resolve) => { setTimeout(resolve, 3000); });
  const repeated = (await botPullV2(gatewayUrl, SECRET, [], 0)).filter((m) => m.telegramId === TG_ALICE);
  assert.equal(repeated.length, 0, 'доставленный ключ повторно не шлётся');
  console.log('OK: ключ восстановления ушёл владельцу в Telegram, окна с ключом в приложении нет');

  const bobContext = await browser.newContext({ viewport: WIDE });
  const bob = await register(bobContext, bobNick, TG_BOB);

  // ── Переписка и задача планировщика на первом устройстве ──
  const fromAlice = `from-alice-${suffix}`;
  const fromBob = `from-bob-${suffix}`;
  await openPrivateChatStrict(alice1.page, bob.address);
  await sendText(alice1.page, fromAlice);
  await openPrivateChatStrict(bob.page, alice1.address);
  await findMessage(bob.page, fromAlice).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bob.page, fromBob);
  await findMessage(alice1.page, fromBob).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const taskName = `task-${suffix}`;
  await createTask(alice1.page, taskName);
  await closePlanner(alice1.page);

  // Копия ключей аккаунта со свежей историей и ключами планировщика — на сервере:
  // первая копия уходит сразу после запуска, обновлённая — по минутной проверке
  // (снимок, сделанный до переписки, не годится — ждём следующий)
  const countLog = (needle) => alice1.logs.filter((line) => line.includes(needle)).length;
  const snapshotsBefore = countLog('снимок истории загружен');
  const writesBefore = countLog('копия ключей аккаунта обновлена');
  const snapshotDeadline = Date.now() + 150000;
  while (countLog('снимок истории загружен') === snapshotsBefore
    || countLog('копия ключей аккаунта обновлена') === writesBefore) {
    assert(Date.now() < snapshotDeadline, `копия ключей с историей не ушла на сервер:\n${alice1.logs.slice(-15).join('\n')}`);
    await alice1.page.waitForTimeout(1000);
  }

  // ── 2–3. Первое устройство ЗАКРЫТО; новое входит по ответу боту ──
  await alice1.page.close();
  const aliceContext2 = await browser.newContext({ viewport: WIDE });
  const alice2 = await login(aliceContext2, aliceNick);
  sessions.alice2 = alice2;
  const devices = await openDevicesScreen(alice2.page);
  await devices.locator('[data-telegram-recovery="waiting"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const [ask] = await pullFor(TG_ALICE, 'ask');
  assert.equal(ask.user, alice1.address);
  assert(ask.client.length > 0, 'бот знает, с какого устройства вход');
  assert.equal(ask.recoveryKey, '', 'в просьбе ключа нет');

  // Чужой Telegram ответить не может; неверный ключ отклонён
  const stranger = await botReplyV2(gatewayUrl, SECRET, 5999, alice1.key);
  assert.equal(stranger.result, 'no_account');
  const wrongOwner = await botReplyV2(gatewayUrl, SECRET, TG_BOB, alice1.key);
  assert.equal(wrongOwner.result, 'no_request', 'ключ Алисы от Telegram Боба не принимается');
  const wrong = await botReplyV2(gatewayUrl, SECRET, TG_ALICE, bob.key);
  assert.equal(wrong.result, 'bad_key');
  const garbage = await botReplyV2(gatewayUrl, SECRET, TG_ALICE, 'привет, это не ключ');
  assert.equal(garbage.result, 'bad_key');
  assert.equal(await devices.locator('[data-telegram-recovery="waiting"]').count(), 1, 'после неверного ключа ждём дальше');
  await shoot(alice2.page, 'devices-waiting-wide');
  await alice2.page.setViewportSize(PHONE);
  await alice2.page.waitForTimeout(500);
  await shoot(alice2.page, 'devices-waiting-phone');
  await alice2.page.setViewportSize(WIDE);

  // Верный ключ — как его набрал бы человек: строчными и с пробелами
  const typed = ` ${alice1.key.toLowerCase().replace(/-/g, ' ')} `;
  const accepted = await botReplyV2(gatewayUrl, SECRET, TG_ALICE, typed);
  assert.equal(accepted.result, 'ok', JSON.stringify(accepted));
  assert.equal(accepted.user, alice1.address);
  await waitLog(alice2, /устройство привязано ключом восстановления \(прежние устройства остались\)/, JOIN_TIMEOUT_MS);
  await waitLog(alice2, /v2: готов/, JOIN_TIMEOUT_MS);
  await devices.locator('[data-telegram-recovery="done"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await shoot(alice2.page, 'devices-done-wide');
  console.log('OK: новое устройство вошло по ответу боту, первое устройство выключено');
  await closeSettings(alice2.page);

  // Прежняя переписка видна, отправка и приём работают
  await openPrivateChatStrict(alice2.page, bob.address);
  await findMessage(alice2.page, fromAlice).first().waitFor({ state: 'visible', timeout: JOIN_TIMEOUT_MS });
  await findMessage(alice2.page, fromBob).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const fromAlice2 = `from-alice-device2-${suffix}`;
  await sendText(alice2.page, fromAlice2);
  await findMessage(bob.page, fromAlice2).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const fromBob2 = `from-bob-2-${suffix}`;
  await sendText(bob.page, fromBob2);
  await findMessage(alice2.page, fromBob2).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: на новом устройстве видна прежняя переписка, сообщения уходят и приходят');

  // Планировщик синхронизирован без другого устройства
  await expectTask(alice2.page, taskName);
  await closePlanner(alice2.page);
  console.log('OK: планировщик на новом устройстве синхронизирован');

  // ── 4. Первое устройство не отозвано ──
  // Сессия первого устройства сохранена: открывается приложение, а не экран входа
  const reopened = { page: await aliceContext1.newPage(), errors: [], logs: [] };
  reopened.page.on('pageerror', (err) => reopened.errors.push(err.message));
  await reopened.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await ensureSignedIn(reopened.page);
  await openPrivateChatStrict(reopened.page, bob.address);
  await findMessage(reopened.page, fromBob2).first().waitFor({ state: 'visible', timeout: JOIN_TIMEOUT_MS });
  const fromAlice1b = `from-alice-device1-again-${suffix}`;
  await sendText(reopened.page, fromAlice1b);
  await findMessage(bob.page, fromAlice1b).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(alice2.page, fromAlice1b).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await reopened.page.locator('.SettingsActiveSessions [data-telegram-recovery]').count(), 0);
  console.log('OK: первое устройство не отозвано — пишет и получает, второе видит его сообщения');

  // ── 5. Обрыв связи посреди привязки её не отменяет ──
  const aliceContext3 = await browser.newContext({ viewport: WIDE });
  const alice3 = await login(aliceContext3, aliceNick);
  sessions.alice3 = alice3;
  const devices3 = await openDevicesScreen(alice3.page);
  await devices3.locator('[data-telegram-recovery="waiting"]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await pullFor(TG_ALICE, 'ask');
  // Запрос вступления в журнал теряется: устройство уходит в офлайн, как только
  // ключ получен, и перезагружается — привязка должна завершиться сама
  let isCut = false;
  alice3.page.on('console', (message) => {
    if (!isCut && message.text().includes('получен ответ владельца из Telegram')) {
      isCut = true;
      void aliceContext3.setOffline(true);
    }
  });
  assert.equal((await botReplyV2(gatewayUrl, SECRET, TG_ALICE, alice1.key)).result, 'ok');
  const cutDeadline = Date.now() + STEP_TIMEOUT_MS;
  while (!isCut) {
    assert(Date.now() < cutDeadline, 'третье устройство не получило ключ');
    await alice3.page.waitForTimeout(200);
  }
  await alice3.page.waitForTimeout(3000);
  await aliceContext3.setOffline(false);
  const isReady = alice3.page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[parvane] v2: готов'),
    timeout: JOIN_TIMEOUT_MS,
  });
  await alice3.page.reload({ waitUntil: 'domcontentloaded' });
  await ensureSignedIn(alice3.page);
  await isReady;
  await alice3.page.waitForTimeout(1500);
  assert.equal(await alice3.page.locator('[data-telegram-recovery="waiting"]').count(), 0, 'устройство привязано');
  await openPrivateChatStrict(alice3.page, bob.address);
  const fromAlice3 = `from-alice-device3-${suffix}`;
  await sendText(alice3.page, fromAlice3);
  await findMessage(bob.page, fromAlice3).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: обрыв связи и перезагрузка посреди привязки её не отменили');

  // ── 6. Ключ восстановления в базах identity открытым текстом не лежит ──
  if (BACKEND_DIR) {
    const needles = [alice1.key, alice1.key.replace(/-/g, '')];
    const files = readdirSync(BACKEND_DIR).filter((name) => /identity.*\.db/.test(name));
    assert(files.length > 0, `базы identity не найдены в ${BACKEND_DIR}`);
    files.forEach((name) => {
      const content = readFileSync(join(BACKEND_DIR, name)).toString('latin1');
      needles.forEach((needle) => {
        assert(!content.includes(needle), `ключ восстановления найден в ${name}`);
      });
    });
    console.log(`OK: ключа восстановления нет в базах identity (${files.join(', ')})`);
  }

  // ── 7. Аккаунт без копии ключей (создан до spec 015) ──
  if (BACKEND_DIR) {
    const carolNick = `rk-c-${suffix}`;
    const carolContext1 = await browser.newContext({ viewport: WIDE });
    const carol1 = await register(carolContext1, carolNick, TG_CAROL);
    sessions.carol1 = carol1;
    const fromCarol = `from-carol-${suffix}`;
    await openPrivateChatStrict(carol1.page, bob.address);
    await sendText(carol1.page, fromCarol);
    await openPrivateChatStrict(bob.page, carol1.address);
    await findMessage(bob.page, fromCarol).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await waitLog(carol1, /копия ключей аккаунта обновлена на сервере/, 60000);
    // Делаем аккаунт «прежним»: у устройства нет ключа копии, на сервере нет копии
    await dropSecureRecords(carol1.page, carol1.address, ['v2-bundle-key', 'v2-bundle-sent', 'v2-bundle-history']);
    const identityDb = new DatabaseSync(join(BACKEND_DIR, 'identity.db-v2.db'));
    identityDb.exec('PRAGMA busy_timeout = 5000');
    identityDb.prepare('UPDATE root_backup SET key_bundle = NULL WHERE user = ?').run(carol1.address);
    identityDb.close();
    carol1.logs.length = 0;
    const carolReady = carol1.page.waitForEvent('console', {
      predicate: (message) => message.text().includes('[parvane] v2: готов'),
      timeout: JOIN_TIMEOUT_MS,
    });
    await carol1.page.reload({ waitUntil: 'domcontentloaded' });
    await ensureSignedIn(carol1.page);
    await carolReady;
    // Такому аккаунту экран «Устройства» предлагает отправить ключ в Telegram
    const carolDevices = await openDevicesScreen(carol1.page);
    await carolDevices.getByText('Send key to Telegram').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await shoot(carol1.page, 'devices-send-key-wide');
    await closeSettings(carol1.page);

    const carolContext2 = await browser.newContext({ viewport: WIDE });
    const carol2 = await login(carolContext2, carolNick);
    sessions.carol2 = carol2;
    const carolDevices2 = await openDevicesScreen(carol2.page);
    await carolDevices2.locator('[data-telegram-recovery="waiting"]')
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await pullFor(TG_CAROL, 'ask');
    // Владелец присылает ключ вместе с куском сообщения бота
    const pasted = `🔑 Ключ восстановления аккаунта @${carolNick} в Parvane:\n\n${carol1.key}\n\nНе удаляйте это сообщение.`;
    assert.equal((await botReplyV2(gatewayUrl, SECRET, TG_CAROL, pasted)).result, 'ok');
    await waitLog(carol1, /заводим копию ключей аккаунта/, JOIN_TIMEOUT_MS);
    await waitLog(carol2, /устройство привязано ключом восстановления \(прежние устройства остались\)/, JOIN_TIMEOUT_MS);
    await waitLog(carol2, /v2: готов/, JOIN_TIMEOUT_MS);
    await closeSettings(carol2.page);
    await openPrivateChatStrict(carol2.page, bob.address);
    await findMessage(carol2.page, fromCarol).first().waitFor({ state: 'visible', timeout: JOIN_TIMEOUT_MS });
    // Прежнее устройство не отозвано: его сообщение доходит и собеседнику, и новому устройству
    const fromCarol1 = `from-carol-device1-${suffix}`;
    await openPrivateChatStrict(carol1.page, bob.address);
    await sendText(carol1.page, fromCarol1);
    await findMessage(bob.page, fromCarol1).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await findMessage(carol2.page, fromCarol1).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    console.log('OK: аккаунт без копии ключей — прежнее устройство завело копию само, новое вошло, прежнее не отозвано');
    assertNoPageErrors({ carol1, carol2 });
  }

  assertNoPageErrors({ alice2, bob, alice3, alice1: reopened });
} catch (err) {
  for (const [name, session] of Object.entries(sessions)) {
    console.error(`--- журнал ${name} (хвост) ---\n${session.logs.slice(-40).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}
