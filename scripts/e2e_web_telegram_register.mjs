// Регистрация с подтверждением через Telegram-бота (PARVANE_TELEGRAM_BOT +
// PARVANE_TELEGRAM_SECRET). Роль бота играет сам сценарий: шлёт
// identity.telegram.confirm в gateway по WebSocket с общим секретом.
// Проверяет: «Create account» → форма без поля почты → экран Telegram с deep
// link t.me/<bot>?start=<token> → «бот» подтверждает → клиент логинится сам;
// повторный вход по нику; чужой Telegram (уже привязанный) отклоняется;
// вход в НЕподтверждённый аккаунт ведёт на экран Telegram с новым токеном;
// вход под неизвестным ником — ошибка и «Create account» с заполненным ником.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS, assertNoPageErrors, preparePage, requireEnv, submitNick,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-telegram-e2e-password';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const BOT = process.env.PARVANE_TELEGRAM_BOT;
assert(SECRET && BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');

// «Бот»: один запрос identity.telegram.confirm через gateway
async function botConfirm(token, telegramId) {
  const { gatewayUrl } = requireEnv();
  const ws = new WebSocket(gatewayUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('gateway ws error')), { once: true });
  });
  const payload = JSON.stringify({
    secret: SECRET, token, telegram_id: telegramId, telegram_name: `tg${telegramId}`,
  });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway reply timeout')), 10000);
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== '1') return;
      clearTimeout(timer);
      if (frame.op === 'err') {
        resolve({ ok: false, error: frame.error });
      } else {
        resolve(JSON.parse(frame.payload || '{}'));
      }
    });
  });
  ws.send(JSON.stringify({
    op: 'req', id: '1', subject: 'identity.telegram.confirm', payload, timeout_ms: 5000,
  }));
  const result = await reply;
  ws.close();
  return result;
}

async function openStartPage(context) {
  const { baseUrl, gatewayUrl } = requireEnv();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, startScreen };
}

// Кнопка — событием mousedown (Button срабатывает на mousedown): стартовая
// маска UiLoader в headless-вкладке подолгу висит в closing и перехватывает
// указатель; ранний клик может перекрыть повторный WaitPhoneNumber — повторяем
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

async function registerViaForm(page, nick) {
  const registerScreen = page.locator('.Transition_slide-active > #auth-registration-form');
  await registerScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await registerScreen.locator('#sign-up-parvane-nick').fill(nick);
  // Поле почты не показывается: сервер подтверждает через Telegram
  await registerScreen.locator('#sign-up-parvane-password').fill(PASSWORD);
  assert.equal(await registerScreen.locator('#sign-up-parvane-email').count(), 0, 'поле почты не ожидается');
  await registerScreen.getByRole('button', { name: 'Create account' }).click();
  return waitTelegramScreen(page);
}

async function waitTelegramScreen(page) {
  const telegramScreen = page.locator('.Transition_slide-active > #auth-telegram-form');
  await telegramScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const link = telegramScreen.locator('#auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const href = await link.getAttribute('href');
  const match = /^https:\/\/t\.me\/([^?]+)\?start=([A-Za-z0-9_-]+)$/.exec(href || '');
  assert(match, `deep link: ${href}`);
  assert.equal(match[1], BOT);
  return { telegramScreen, token: match[2] };
}

async function waitSignedIn(page) {
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const browser = await chromium.launch();

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const aliceNick = `tg-a-${suffix}`;

  // ── Новый аккаунт: форма → экран Telegram → «бот» подтверждает → логин ──
  const registerContext = await browser.newContext();
  const registerSession = await openStartPage(registerContext);
  const { page, startScreen } = registerSession;
  await pressAuthButton(page, startScreen, 'Create account', '#auth-registration-form');
  const { token: aliceToken } = await registerViaForm(page, aliceNick);
  // до Start в боте — не залогинен
  assert.equal(await page.locator('#LeftColumn').count(), 0);
  const confirm = await botConfirm(aliceToken, 1001);
  assert.equal(confirm.ok, true, `подтверждение: ${JSON.stringify(confirm)}`);
  assert.equal(confirm.user, `${aliceNick}@local`);
  await waitSignedIn(page);
  console.log('OK: регистрация через Telegram — бот подтвердил, клиент залогинился сам');
  assertNoPageErrors({ alice: registerSession });
  await registerContext.close();

  // ── Подтверждённый аккаунт: обычный вход по нику ──
  const reloginContext = await browser.newContext();
  const reloginSession = await preparePage(reloginContext, aliceNick, PASSWORD);
  console.log('OK: повторный вход по нику подтверждённого аккаунта');
  assertNoPageErrors({ alice: reloginSession });
  await reloginContext.close();

  // ── Один Telegram = один аккаунт; кнопка «I pressed Start» ──
  const bobNick = `tg-b-${suffix}`;
  const bobContext = await browser.newContext();
  const bobSession = await openStartPage(bobContext);
  await pressAuthButton(bobSession.page, bobSession.startScreen, 'Create account', '#auth-registration-form');
  const { telegramScreen: bobScreen, token: bobToken } = await registerViaForm(bobSession.page, bobNick);
  const dup = await botConfirm(bobToken, 1001);
  assert.equal(dup.ok, false, 'тот же Telegram не должен подтвердить второй аккаунт');
  assert.match(dup.error || '', /привязан/);
  await bobScreen.getByRole('button', { name: 'I pressed Start' }).click();
  // после отказа и «I pressed Start» — по-прежнему экран Telegram
  await bobScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: чужой (уже привязанный) Telegram отклонён');
  await bobContext.close();

  // ── Вход в НЕподтверждённый аккаунт → экран Telegram с НОВЫМ токеном ──
  const resumeContext = await browser.newContext();
  const resumeSession = await openStartPage(resumeContext);
  await submitNick(resumeSession.page, bobNick);
  const passwordScreen = resumeSession.page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  const { token: bobToken2 } = await waitTelegramScreen(resumeSession.page);
  assert.notEqual(bobToken2, bobToken, 'повторный вход выдаёт новый токен');
  const stale = await botConfirm(bobToken, 1003);
  assert.equal(stale.ok, false, 'старый токен погашен');
  const fresh = await botConfirm(bobToken2, 1003);
  assert.equal(fresh.ok, true, `подтверждение: ${JSON.stringify(fresh)}`);
  await waitSignedIn(resumeSession.page);
  console.log('OK: вход в неподтверждённый аккаунт — новый токен, старый погашен, подтверждён');
  assertNoPageErrors({ bob: resumeSession });
  await resumeContext.close();

  // ── Неизвестный ник: ошибка пароля, «Create account» с заполненным ником ──
  const ghostNick = `tg-ghost-${suffix}`;
  const ghostContext = await browser.newContext();
  const ghostSession = await openStartPage(ghostContext);
  await submitNick(ghostSession.page, ghostNick);
  const ghostPassword = ghostSession.page.locator('.Transition_slide-active > #auth-password-form');
  await ghostPassword.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await ghostPassword.locator('#sign-in-password').fill(PASSWORD);
  await ghostPassword.getByRole('button', { name: 'Next' }).click();
  await ghostPassword.getByText('Invalid password', { exact: false })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await pressAuthButton(ghostSession.page, ghostPassword, 'Create account', '#auth-registration-form');
  const ghostForm = ghostSession.page.locator('.Transition_slide-active > #auth-registration-form');
  assert.equal(await ghostForm.locator('#sign-up-parvane-nick').inputValue(), ghostNick);
  console.log('OK: вход под неизвестным ником не регистрирует молча, «Create account» переносит ник');
  assertNoPageErrors({ ghost: ghostSession });
  await ghostContext.close();
} finally {
  await browser.close();
}
