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
} from './e2e_web_helpers.mjs';
import { botConfirmV2 } from './e2e_tg_confirm_v2.mjs';

const PASSWORD = 'Parvane-telegram-2fa-password';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const TG_OWNER = 2001;
const TG_STRANGER = 2002;

// На сервере с отключённым v1 (`run_web_telegram_2fa_v1off_e2e.sh`, E6-1) JSON-
// соединения gateway нет — «бот» ходит в шину напрямую, как настоящий
const V1_OFF = process.env.PARVANE_E2E_V1_OFF === '1';

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
    await screen.getByRole('button', { name }).dispatchEvent('mousedown', { button: 0 });
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
    await telegramScreen.getByText(expectedTitle, { exact: false }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
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
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
}

async function loginWithPassword(page, nick) {
  await submitNick(page, nick);
  await enterPassword(page);
}

// Шифрованное хранилище устройства (`secureStorage.ts`): IndexedDB
// `parvane-e2e-v2` / `secure-state`, именованные записи `rec:<адрес>:<имя>`.
// Значения — шифртекст под non-extractable ключом; сценарию достаточно знать,
// есть ли запись, и уметь её удалить
const secureRecordKey = (address, name) => `rec:${address}:${name}`;

function hasSecureRecord(page, address, name) {
  return page.evaluate((key) => new Promise((resolve, reject) => {
    const open = indexedDB.open('parvane-e2e-v2');
    // Базы ещё нет — не создаём пустую (приложение ждёт в ней своё хранилище)
    open.onupgradeneeded = () => open.transaction.abort();
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('secure-state').objectStore('secure-state').get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        open.result.close();
        resolve(request.result !== undefined);
      };
    };
  }), secureRecordKey(address, name));
}

async function waitSecureRecord(page, address, name, message) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!(await hasSecureRecord(page, address, name))) {
    assert(Date.now() < deadline, message);
    await page.waitForTimeout(200);
  }
}

function dropSecureRecords(page, address, names) {
  return page.evaluate((keys) => new Promise((resolve, reject) => {
    const open = indexedDB.open('parvane-e2e-v2');
    // Базы ещё нет — не создаём пустую (приложение ждёт в ней своё хранилище)
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
  }), names.map((name) => secureRecordKey(address, name)));
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
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Privacy and Security/ }).click();
  const toggle = page.getByLabel('Confirm sign-in in Telegram');
  await toggle.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return toggle;
}

const waitToggle = async (page, toggle, enabled) => page.waitForFunction(
  ([el, want]) => el && !el.disabled && el.checked === want,
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
    const passwordInput = page.locator('.settings-item').filter({ has: confirmButton }).locator('input[type="password"]');
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
  const passwordInput = page.locator('.settings-item').filter({ has: confirmButton }).locator('input[type="password"]');
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
  await registerScreen.getByRole('button', { name: 'Create account' }).click();
  const { token: regToken } = await waitTelegramScreen(s1.page, 'Confirm via Telegram');
  assert.equal((await botConfirm(regToken, TG_OWNER)).ok, true);
  await signedIn(s1.page);

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
  assert.equal(await hasSecureRecord(s1.page, address, 'trust-secret'), false,
    'секрет доверия пережил полный выход');
  await loginWithPassword(s1.page, nick);
  const { token: reloginToken } = await waitTelegramScreen(s1.page, 'Confirm sign-in');
  assert.equal(await s1.page.locator('#LeftColumn').count(), 0, 'после выхода вход прошёл без подтверждения');
  assert.equal((await botConfirm(reloginToken, TG_OWNER)).ok, true);
  await signedIn(s1.page);
  // После повторного входа — список чатов, а не экран Settings, с которого вышли
  await s1.page.getByRole('button', { name: 'Open menu' }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: после полного выхода вход снова подтверждается в Telegram (на список чатов)');

  // ── Новое устройство (другой контекст): снова подтверждение ──
  const ctx2 = await browser.newContext();
  const s2 = await openStartPage(ctx2);
  await loginWithPassword(s2.page, nick);
  const { token: loginToken2 } = await waitTelegramScreen(s2.page, 'Confirm sign-in');
  assert.equal((await botConfirm(loginToken2, TG_OWNER)).ok, true);
  await signedIn(s2.page);
  console.log('OK: новое устройство подтверждает вход заново');

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
  if (V1_OFF) {
    const gatewayLog = readFileSync(join(process.env.PARVANE_E2E_BACKEND_LOG_DIR, 'gateway.log'), 'utf8');
    assert.match(gatewayLog, /v1-путь в режиме Disabled/, 'gateway не в режиме disabled');
    assert.doesNotMatch(gatewayLog, /gateway::session.*Клиент авторизован/, 'кто-то авторизовался по v1');
    console.log('OK: включение, вход и выключение 2FA — без соединения v1');
  }
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
