// Перевод сообщений на устройстве (spec 024 И4): «Перевести» есть только там,
// где у браузера встроенный переводчик (Translator API), перевод показывается
// в пузыре и снимается «Показать оригинал»; текст сообщения не уходит ни в один
// HTTP-запрос. В браузере без переводчика пункта нет, а «Язык» объясняет почему.
// Переводчик в Playwright подставной: настоящая модель Chrome в headless не
// скачивается, а проверяется здесь цепочка провайдера, не качество перевода.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  findMessageContainer,
  LOGIN_TIMEOUT_MS,
  openMessageMenu,
  openPrivateChatStrict,
  openSettingsScreen,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-translate-e2e-password';

function installFakeTranslator() {
  window.__translateCalls = [];
  const detect = (text) => (/[а-яё]/i.test(text) ? 'ru' : 'en');
  window.LanguageDetector = {
    create: async () => ({
      detect: async (text) => [{ detectedLanguage: detect(text), confidence: 0.95 }],
    }),
  };
  window.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage }) => ({
      translate: async (text) => {
        window.__translateCalls.push({ sourceLanguage, targetLanguage, text });
        return `[${sourceLanguage}→${targetLanguage}] ${text.toUpperCase()}`;
      },
    }),
  };
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const plainContext = await browser.newContext();
await aliceContext.addInitScript(installFakeTranslator);
// Chromium Playwright уже несёт встроенный Translator API — «браузер без переводчика» моделируем, убирая его
await plainContext.addInitScript(() => {
  delete window.Translator;
  delete window.LanguageDetector;
});
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `translate-alice-${suffix}@local`;
  const bob = `translate-bob-${suffix}@local`;
  const original = `привет как дела ${suffix}`;

  // Каждый HTTP-запрос Алисы — без текста сообщения
  const leaks = [];
  aliceContext.on('request', (request) => {
    const body = request.postData() || '';
    if (request.url().includes(suffix) || body.includes(original)) leaks.push(request.url());
  });

  sessions.alice = await preparePage(aliceContext, alice, PASSWORD);
  sessions.bob = await preparePage(bobContext, bob, PASSWORD);
  const { page: a } = sessions.alice;
  const { page: b } = sessions.bob;

  await openPrivateChatStrict(a, bob);
  await sendText(a, `hello-${suffix}`);
  await openPrivateChatStrict(b, alice);
  await sendText(b, original);
  await findMessageContainer(a, original).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  await openMessageMenu(a, original);
  const translateItem = a.getByRole('menuitem', { name: 'Translate', exact: true });
  await translateItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await translateItem.click();
  const translated = `[ru→en] ${original.toUpperCase()}`;
  await a.locator('.Message').filter({ hasText: translated }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const calls = await a.evaluate(() => window.__translateCalls);
  assert(calls.some((call) => call.text === original && call.targetLanguage === 'en'), 'переводчик браузера вызван');
  // Перевод запрошен один раз: повторные запросы по кругу перерисовывали ленту без конца
  await a.waitForTimeout(3000);
  const settled = await a.evaluate(() => window.__translateCalls.length);
  await a.waitForTimeout(3000);
  assert.equal(await a.evaluate(() => window.__translateCalls.length), settled, 'перевод запрашивается по кругу');
  console.log(`OK: перевод показан в пузыре (вызовов переводчика: ${settled})`);

  await openMessageMenu(a, translated);
  // Пункт меню у нижнего края ленты: прокрутка к нему закрывала и переоткрывала меню — нажатие без прокрутки
  await a.getByRole('menuitem', { name: 'Show Original', exact: true }).dispatchEvent('click');
  await findMessageContainer(a, original).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: «Показать оригинал» возвращает текст');
  assert.deepEqual(leaks, [], `текст сообщения ушёл в сеть: ${leaks.join(', ')}`);
  console.log('OK: текст сообщения не уходил в HTTP-запросы');

  // «Язык»: переключатель кнопки перевода
  await openSettingsScreen(a, 'Language');
  await a.getByText('Show Translate Button', { exact: true }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await a.getByText(/translated by your browser on this device/).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: настройка перевода в «Языке»');

  // Браузер без переводчика: пункта нет, «Язык» объясняет
  sessions.bob2 = await preparePage(plainContext, `translate-carol-${suffix}@local`, PASSWORD);
  const { page: c } = sessions.bob2;
  await openPrivateChatStrict(c, bob);
  await sendText(c, `привет-без-переводчика ${suffix}`);
  await openMessageMenu(c, `привет-без-переводчика ${suffix}`);
  await c.getByRole('menuitem', { name: 'Reply' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await c.getByRole('menuitem', { name: 'Translate', exact: true }).count(), 0,
    'без переводчика пункта «Перевести» нет');
  await c.keyboard.press('Escape');
  await openSettingsScreen(c, 'Language');
  await c.getByText(/Translation is not available in this browser/).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: без переводчика пункта нет, «Язык» объясняет');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий перевода пройден');
} finally {
  await browser.close();
}
