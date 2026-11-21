// Двухфакторный вход через Telegram (по желанию, Settings → Privacy):
// регистрация с подтверждением ботом (tg 2001) → включаем 2FA → устройство
// получает секрет доверия (в шифрованном хранилище, НЕ в localStorage — P-14)
// и входит по паролю без Telegram; без секрета тот же device_id не доверенный:
// экран «Подтвердите вход» с deep link → чужой Telegram (2002) отклонён →
// привязанный (2001) подтверждает → вход, секрет выдан заново; полный выход
// стирает хранилище устройства вместе с секретом — снова подтверждение; новый
// браузер (другое устройство) — подтверждение; выключение 2FA требует текущий
// пароль (P-07), после него — обычный вход.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, logOut, requireEnv, submitNick,
  autoDismissRecoveryKeyDialog,
  openProfile,
  waitForChatList,
} from './e2e_web_helpers.mjs';
import { botConfirmV2, botPullV2 } from './e2e_tg_confirm_v2.mjs';
import { shootAuthScreen } from './e2e_web_auth_shots.mjs';

const PASSWORD = 'Parvane-telegram-2fa-password';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const TG_OWNER = 2001;
const TG_STRANGER = 2002;
const KEY_PATTERN = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){9}/;

// «Бот» забирает у сервера ключ восстановления владельца (spec 015: ключ уходит ему в Telegram)
async function pullRecoveryKey(telegramId) {
  const { gatewayUrl } = requireEnv();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    const messages = await botPullV2(gatewayUrl, SECRET, [], 2000);
    if (messages.length) await botPullV2(gatewayUrl, SECRET, messages.map((m) => m.id), 0);
    const key = messages.find((m) => m.telegramId === telegramId && KEY_PATTERN.test(m.recoveryKey || ''));
    if (key) return key.recoveryKey;
    assert(Date.now() < deadline, 'бот не получил ключ восстановления');
  }
}

// «Бот»: один запрос подтверждения через gateway по протоколу v2
// (`identity.account.confirm_telegram`, канал PRE) — как настоящий бот на VPS
async function botConfirm(token, telegramId) {
  const { gatewayUrl } = requireEnv();
  return botConfirmV2(gatewayUrl, SECRET, token, telegramId, `tg${telegramId}`);
}

async function openStartPage(context) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  await autoDismissRecoveryKeyDialog(page); // v2 по умолчанию (T135)
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((url) => { localStorage.setItem('parvane:gateway', url); }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, startScreen };
}

async function pressAuthButton(page, screen, name, targetScreenId) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await screen.locator('[data-auth-register]').dispatchEvent('click');
    try {
      await page.locator(`.Transition_slide-active > ${targetScreenId}`).waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
}

async function waitTelegramScreen(page, expectedTitle) {
  const telegramScreen = page.locator('.Transition_slide-active > #auth-telegram-form');
  await telegramScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (expectedTitle) {
    // Заголовок есть и в шапке телефона, и в окне компьютера — виден один из них
    await telegramScreen.getByText(expectedTitle, { exact: false }).locator('visible=true').first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  const link = telegramScreen.locator('#auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const href = await link.getAttribute('href');
  const match = /^https:\/\/t\.me\/([^?]+)\?start=([A-Za-z0-9_-]+)$/.exec(href || '');
  assert(match, `deep link: ${href}`);
  return { telegramScreen, token: match[2] };
}

const signedIn = (page) => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

async function enterPassword(page) {
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.locator('[data-auth-submit]').click();
}

async function loginWithPassword(page, nick) {
  await submitNick(page, nick);
  await enterPassword(page);
}

// Шифрованное хранилище устройства (`secureStorage.ts`, spec 035 — записи под AAD в `parvane-store-v3-<профиль>`):
// снаружи записи не адресуются — проверка и удаление методами диаг-сборки провайдера
async function callDiag(page, method, params) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, { timeout: 60000 });
  return page.evaluate(([fn, args]) => window.__parvaneDiagCallApi(fn, args), [method, params]);
}

async function dropSecureRecords(page, address, names) {
  const done = await callDiag(page, 'parvaneDiagDropSecureRecords', { names, address });
  if (!done) throw new Error(`записи хранилища ${address} не удалены: ${names.join(', ')}`);
}

function hasSecureRecord(page, address, name) {
  return callDiag(page, 'parvaneDiagHasSecureRecord', { name, address });
}

// Профиль хранилища адреса есть: указатель `profile/<адрес>` каталога `parvane-store-v3` либо прежняя база
// `parvane-e2e-v2` с ключом адреса. Читается напрямую — после выхода экран входа диаг-хуков провайдера не
// выставляет. Отсутствующую базу не создаём (приложение открывает её со своей схемой)
function hasSecureProfile(page, address) {
  return page.evaluate(async (user) => {
    const openExisting = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      let isMissing = false;
      request.onupgradeneeded = () => {
        isMissing = true;
        request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => (isMissing ? resolve(undefined) : reject(request.error));
    });
    const has = async (dbName, storeName, key) => {
      const db = await openExisting(dbName);
      if (!db) return false;
      try {
        if (!db.objectStoreNames.contains(storeName)) return false;
        return await new Promise((resolve, reject) => {
          const request = db.transaction(storeName).objectStore(storeName).getKey(key);
          request.onsuccess = () => resolve(request.result !== undefined);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    };
    return (await has('parvane-store-v3', 'records', `profile/${user}`))
      || (await has('parvane-e2e-v2', 'secure-state', `key:${user}`));
  }, address);
}

async function waitSecureRecord(page, address, name, message) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!(await hasSecureRecord(page, address, name))) {
    assert(Date.now() < deadline, message);
    await page.waitForTimeout(200);
  }
}

// Вход по паролю на том же устройстве: сохранённый JWT сессии («keep me signed
// in») убран, поэтому reload ведёт на экран пароля — как после суток без
// активности. Ключи E2E и (если не указано иное) секрет доверия остаются
async function reloadToPasswordLogin(page, address, { dropTrustSecret = false } = {}) {
  await dropSecureRecords(page, address, dropTrustSecret ? ['session-token', 'trust-secret'] : ['session-token']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await enterPassword(page);
}

async function openPrivacySettings(page) {
  await openProfile(page);
  await page.getByRole('button', { name: /Privacy and Security/ }).click();
  const toggle = page.getByLabel('Confirm sign-in in Telegram');
  await toggle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return toggle;
}

const waitToggle = async (page, toggle, enabled) => page.waitForFunction(
  // Выключатель экрана по макету (spec 041 E3) — кнопка `role="switch"`, состояние в `aria-checked`
  ([el, want]) => el && !el.disabled && el.getAttribute('aria-checked') === String(want),
  [await toggle.elementHandle(), enabled],
  { timeout: LOGIN_TIMEOUT_MS },
);

async function enableTwoFactor(page) {
  const toggle = await openPrivacySettings(page);
  // состояние подтягивается с сервера — ждём, пока чекбокс станет активным
  await page.waitForFunction((el) => el && !el.disabled, await toggle.elementHandle(), { timeout: LOGIN_TIMEOUT_MS });
  if (!(await toggle.isChecked())) {
    await toggle.click({ force: true });
    // включение тоже спрашивает текущий пароль (метод v2 без свежего пароля
    // 2FA не включает — иначе без соединения v1 настройка недоступна)
    const confirmButton = page.getByRole('button', { name: 'Enable two-factor', exact: true });
    const passwordInput = page.locator('[data-twofa-confirm] input[type="password"]');
    await passwordInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
      timeout: LOGIN_TIMEOUT_MS,
    });
    assert.equal(await serverTwoFactor(page), false, '2FA включился без ввода пароля');
    await passwordInput.fill(PASSWORD);
    await confirmButton.click();
    await confirmButton.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
    await waitToggle(page, toggle, true);
    assert.equal(await serverTwoFactor(page), true, '2FA не включился с верным паролем');
  }
}

// Настройка 2FA на сервере (identity.twofa по JWT сессии) — источник истины:
// нативный чекбокс после клика снимается в DOM сам, ещё до подтверждения
function serverTwoFactor(page) {
  return page.evaluate(async () => (await window.__parvaneDiagCallApi('parvaneFetchTwoFactor'))?.enabled);
}

// P-07: выключение 2FA — только с текущим паролем (украденный JWT второй
// фактор не снимает). Неверный пароль отклоняется, настройка остаётся
async function disableTwoFactor(page) {
  const toggle = await openPrivacySettings(page);
  await waitToggle(page, toggle, true);
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  await toggle.click({ force: true });
  // Поле пароля — то, что рядом с кнопкой выключения: такой же placeholder
  // у поля «Текущий пароль» в секции смены пароля ниже
  const confirmButton = page.getByRole('button', { name: 'Disable two-factor', exact: true });
  const passwordInput = page.locator('[data-twofa-confirm] input[type="password"]');
  await passwordInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await serverTwoFactor(page), true, '2FA выключился без ввода пароля');
  assert.equal(await confirmButton.isDisabled(), true, 'подтверждение доступно без пароля');

  await passwordInput.fill(`${PASSWORD}-wrong`);
  await confirmButton.click();
  await page.locator('.Notification-container').getByText('Could not change the two-factor setting').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await serverTwoFactor(page), true, '2FA выключился с неверным паролем');

  await passwordInput.fill(PASSWORD);
  await confirmButton.click();
  await confirmButton.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await serverTwoFactor(page), false, '2FA не выключился с верным паролем');
}

const browser = await chromium.launch();
try {
  const suffix = `${Date.now()}-${process.pid}`;
  const nick = `tfa-${suffix}`;
  const address = `${nick}@local`;

  // ── Регистрация + привязка Telegram (владелец 2001) ──
  const ctx1 = await browser.newContext();
  const s1 = await openStartPage(ctx1);
  await pressAuthButton(s1.page, s1.startScreen, 'Create account', '#auth-registration-form');
  const registerScreen = s1.page.locator('.Transition_slide-active > #auth-registration-form');
  await registerScreen.locator('#sign-up-parvane-nick').fill(nick);
  await registerScreen.locator('#sign-up-parvane-password').fill(PASSWORD);
  await registerScreen.locator('[data-auth-submit]').click();
  const { token: regToken } = await waitTelegramScreen(s1.page, 'Confirm your account');
  assert.equal((await botConfirm(regToken, TG_OWNER)).ok, true);
  await signedIn(s1.page);
  const recoveryKey = await pullRecoveryKey(TG_OWNER);

  // ── Включаем 2FA в Settings → Privacy ──
  await enableTwoFactor(s1.page);
  console.log('OK: двухфакторный вход включён в настройках');

  // ── Устройство, включившее 2FA, получило секрет доверия — в шифрованное
  // хранилище, а не в localStorage (P-14) ──
  const trustMirrors = () => s1.page.evaluate(
    () => Object.keys(localStorage).filter((key) => key.startsWith('parvane:trust:')),
  );
  await waitSecureRecord(s1.page, address, 'trust-secret', 'секрет доверия не сохранён в шифрованном хранилище');
  assert.deepEqual(await trustMirrors(), [], 'секрет доверия лежит в localStorage открытым текстом');

  // …и входит по паролю без Telegram (как и десктоп)
  await reloadToPasswordLogin(s1.page, address);
  await signedIn(s1.page);
  assert.equal(await s1.page.locator('#auth-telegram-form').count(), 0);
  assert.deepEqual(await trustMirrors(), [], 'секрет доверия попал в localStorage после входа');
  console.log('OK: устройство, включившее 2FA, входит по паролю без повторного подтверждения');

  // ── Без секрета доверия голый device_id НЕ доверенный (device_id публичен):
  // стираем только секрет, device_id и ключи остаются → подтверждение ──
  await reloadToPasswordLogin(s1.page, address, { dropTrustSecret: true });
  const { telegramScreen, token: loginToken } = await waitTelegramScreen(s1.page, 'Confirm sign-in');
  assert.notEqual(loginToken, regToken);
  assert.equal(await telegramScreen.getAttribute('data-telegram-mode'), 'login', 'экран Telegram в режиме входа');
  await shootAuthScreen(s1.page, 'telegram-login');
  assert.equal(await s1.page.locator('#LeftColumn').count(), 0, 'без подтверждения входа быть не должно');
  const stranger = await botConfirm(loginToken, TG_STRANGER);
  assert.equal(stranger.ok, false, 'чужой Telegram не должен подтверждать вход');
  assert.match(stranger.error || '', /привязан/);
  await telegramScreen.getByRole('button', { name: 'I pressed Start' }).click();
  await telegramScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const owner = await botConfirm(loginToken, TG_OWNER);
  assert.equal(owner.ok, true, `подтверждение владельцем: ${JSON.stringify(owner)}`);
  assert.equal(owner.kind, 'login');
  await signedIn(s1.page);
  console.log('OK: без секрета device_id не доверяется; вход подтверждён только привязанным Telegram');

  // ── То же устройство: вход по паролю без Telegram (секрет выдан заново) ──
  await waitSecureRecord(s1.page, address, 'trust-secret',
    'после подтверждения в Telegram секрет доверия не выдан заново');
  await reloadToPasswordLogin(s1.page, address);
  await signedIn(s1.page);
  assert.equal(await s1.page.locator('#auth-telegram-form').count(), 0);
  console.log('OK: доверенное устройство входит без повторного подтверждения');

  // ── Полный выход стирает хранилище устройства вместе с секретом доверия:
  // следующий вход на нём снова требует Telegram ──
  await logOut(s1.page);
  // Выход сам перезагружает страницу — чтение посреди навигации повторяем
  const wipeDeadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (await hasSecureProfile(s1.page, address).catch(() => true)) {
    assert(Date.now() < wipeDeadline, 'хранилище устройства (с секретом доверия) пережило полный выход');
    await s1.page.waitForTimeout(250);
  }
  await loginWithPassword(s1.page, nick);
  const { token: reloginToken } = await waitTelegramScreen(s1.page, 'Confirm sign-in');
  assert.equal(await s1.page.locator('#LeftColumn').count(), 0, 'после выхода вход прошёл без подтверждения');
  assert.equal((await botConfirm(reloginToken, TG_OWNER)).ok, true);
  await signedIn(s1.page);
  // После повторного входа — список чатов, а не экран Settings, с которого вышли
  await waitForChatList(s1.page);
  console.log('OK: после полного выхода вход снова подтверждается в Telegram (на список чатов)');

  // ── Новое устройство (другой контекст): снова подтверждение ──
  const ctx2 = await browser.newContext();
  const s2 = await openStartPage(ctx2);
  await loginWithPassword(s2.page, nick);
  const { telegramScreen: screen2, token: loginToken2 } = await waitTelegramScreen(s2.page, 'Confirm sign-in');
  // Доски `ZpAuthX`, `ZdAuthX`: «Прислать ещё раз» — новая ссылка без ввода пароля; подсказка «кто-то знает пароль»
  await screen2.getByText(/Someone knows your password/).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await screen2.locator('[data-telegram-again]').click();
  const deadline2 = Date.now() + LOGIN_TIMEOUT_MS;
  let renewedToken = loginToken2;
  while (renewedToken === loginToken2) {
    assert(Date.now() < deadline2, '«Прислать ещё раз» не выдал новую ссылку');
    await s2.page.waitForTimeout(300);
    const href = await screen2.locator('#auth-telegram-link').getAttribute('href');
    renewedToken = /start=([A-Za-z0-9_-]+)/.exec(href || '')?.[1] || loginToken2;
  }
  assert.equal((await botConfirm(loginToken2, TG_OWNER)).ok, false, 'прежняя ссылка погашена новой');
  // «Войти ключом восстановления» вместо Telegram: неверный ключ — ошибка, верный — вход
  await screen2.locator('[data-telegram-use-key]').click();
  const keyInput = screen2.locator('[data-telegram-key-input]');
  await keyInput.fill(recoveryKey.replace(/^.{4}/, 'ZZZZ'));
  await screen2.locator('[data-telegram-key-submit]').click();
  await screen2.locator('[data-telegram-key-error]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await s2.page.locator('#LeftColumn').count(), 0, 'неверный ключ не впускает');
  await keyInput.fill(recoveryKey);
  await screen2.locator('[data-telegram-key-submit]').click();
  await signedIn(s2.page);
  console.log('OK: новое устройство — «Прислать ещё раз» выдаёт новую ссылку, вход подтверждён ключом восстановления');

  // ── Выключаем 2FA (с паролем) — вход без Telegram на третьем устройстве ──
  await disableTwoFactor(s2.page);
  console.log('OK: выключение 2FA требует текущий пароль');
  const ctx3 = await browser.newContext();
  const s3 = await openStartPage(ctx3);
  await loginWithPassword(s3.page, nick);
  await signedIn(s3.page);
  assert.equal(await s3.page.locator('#auth-telegram-form').count(), 0);
  console.log('OK: после выключения 2FA обычный вход');

  assertNoPageErrors({ one: s1, two: s2, three: s3 });
  console.log('OK: двухфакторный вход через Telegram');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR;
  if (shotDir) {
    await Promise.all(browser.contexts().map((c, i) => c.pages()[0]?.screenshot({ path: `${shotDir}/tfa-${i}.png` }).catch(() => {})));
  }
  throw error;
} finally {
  await browser.close();
}
