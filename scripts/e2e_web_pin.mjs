// PIN хранилища по макету (spec 041 E6; доски `ZpSystem`, `RpProfileB`, `ZdProfileX`). Компьютер: включение
// цифрами в «Профиле» (новый · повтор), смена (текущий · новый · повтор), экран блокировки после перезагрузки,
// неверный ввод уменьшает счётчик, счётчик переживает перезагрузку, верный ввод его сбрасывает, выключение,
// пятый неверный ввод подряд — выход на экран входа со стиранием данных аккаунта на устройстве (базы IndexedDB,
// кэши кроме оболочки PWA, ключи хранилищ страницы) и вход заново. Телефон: экран блокировки помещается в ширину,
// «Забыли PIN? Выйти и войти заново» выводит на экран входа и тоже стирает данные.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  dismissRecoveryKeyDialog,
  openSettingsScreen,
  preparePage,
  reloadPage,
  submitNickUntilPassword,
  waitForChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-pin-e2e-password';
const WAIT_MS = 20_000;
// Выход с экрана блокировки: устройство без токена ждёт сетевые шаги выхода до 5 с, потом стирает данные
const SIGN_OUT_MS = 40_000;

const browser = await chromium.launch();
const sessions = {};

const shown = (locator, timeout = WAIT_MS) => locator.waitFor({ state: 'visible', timeout });

const slide = (page) => page.locator('#Settings .Transition_slide-active');
const hub = (page, state) => slide(page).locator(`[data-settings-pin="${state}"]`);
const step = (page, name) => slide(page).locator(`[data-pin-step="${name}"]`);
const lock = (page) => page.locator('[data-pin-lock]');
const lockWithLeft = (page, left) => page.locator(`[data-pin-lock][data-pin-attempts-left="${left}"]`);
const authScreen = (page) => page.locator('.Transition_slide-active > #auth-phone-number-form');

// Снимки для сверки с досками — при `PARVANE_E2E_SHOT_DIR`
async function shot(page, name) {
  const dir = process.env.PARVANE_E2E_SHOT_DIR;
  if (!dir) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/pin-${name}.png` });
}

async function tapPin(scope, pin) {
  for (const digit of pin) {
    await scope.locator(`[data-pin-key="${digit}"]`).click();
  }
}

async function openPinScreen(page) {
  await openSettingsScreen(page, 'Privacy and Security');
  await slide(page).locator('[data-pin-state]').click();
  await shown(slide(page).locator('[data-settings-pin]'));
}

async function enablePin(page, pin) {
  await openPinScreen(page);
  await shown(hub(page, 'off'));
  await slide(page).locator('[data-pin-toggle]').click();
  await shown(step(page, 'new'));
  await tapPin(step(page, 'new'), pin);
  await shown(step(page, 'repeat'));
  await tapPin(step(page, 'repeat'), pin);
  await shown(hub(page, 'on'), LOGIN_TIMEOUT_MS);
}

async function reloadToLock(page, left) {
  await reloadPage(page);
  await shown(lockWithLeft(page, left), LOGIN_TIMEOUT_MS);
}

async function failedKeys(page) {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('parvane:pin-fails:')));
}

// Выдуманные данные модулей, которые сценарий сам не наполняет («Музыка» без сети, кэш медиа): стирание обязано
// убрать и их
async function seedModuleData(page) {
  await page.evaluate(async () => {
    localStorage.setItem('parvane:music-info', JSON.stringify({ tracks: 3, source: 'invented' }));
    localStorage.setItem('parvane:music-offline', JSON.stringify(['track-invented']));
    sessionStorage.setItem('parvane:e2e-session-probe', '1');
    const music = await caches.open('parvane-music-offline');
    await music.put('/__pin-e2e/track-invented', new Response('invented track'));
    const media = await caches.open('tt-media');
    await media.put('/__pin-e2e/photo-invented', new Response('invented photo'));
  });
}

// Всё, что лежит на устройстве: базы IndexedDB (хранилища и число записей), кэши, ключи localStorage/sessionStorage
async function readDeviceData(page) {
  return page.evaluate(async () => {
    const readDb = (name) => new Promise((resolve) => {
      const request = indexedDB.open(name);
      request.onerror = () => resolve({ error: String(request.error) });
      request.onsuccess = async () => {
        const db = request.result;
        const stores = {};
        for (const store of db.objectStoreNames) {
          stores[store] = await new Promise((done) => {
            const keys = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
            keys.onsuccess = () => done(keys.result.map(String));
            keys.onerror = () => done([]);
          });
        }
        db.close();
        resolve(stores);
      };
    });
    const idb = {};
    for (const { name } of await indexedDB.databases()) idb[name] = await readDb(name);
    const cacheStorage = {};
    for (const name of await caches.keys()) {
      cacheStorage[name] = (await (await caches.open(name)).keys()).map((request) => request.url);
    }
    return {
      idb,
      caches: cacheStorage,
      local: Object.keys(localStorage),
      localValues: Object.values(localStorage).join('\n'),
      session: Object.keys(sessionStorage),
    };
  });
}

// Ключи, которые переживают стирание: настройки устройства, не аккаунта (`deviceWipe.ts KEPT_LOCAL_KEYS`), метки
// сценариев и журнал диагностики, начатый уже после выхода (адреса аккаунта в значениях нет — проверяется ниже)
const KEPT_LOCAL = /^parvane:(color-scheme|modules|modules-view|modules-server-off|panel-widths|gateway|e2e:|diag:)/;
// Записи `tt-data` без данных аккаунта: общие настройки устройства (язык, тема) и настройки, которые выход сразу
// пишет заново значениями по умолчанию (`global/cache.ts watchParvaneSettings` после сброса состояния)
const KEPT_TT_DATA = new Set(['tt-shared-state', 'parvane-account-settings', 'parvane-theme-settings']);
// Оболочка приложения PWA и языковые пакеты — не данные аккаунта
const KEPT_CACHE = /^(tt-assets|tt-lang-packs)/;

function findAccountLeftovers(data, user) {
  const left = [];
  Object.entries(data.idb).forEach(([name, stores]) => {
    if (name === 'tt-data') {
      Object.values(stores).flat().filter((key) => !KEPT_TT_DATA.has(key)).forEach((key) => left.push(`idb tt-data/${key}`));
      return;
    }
    const keys = Object.values(stores).flat();
    if (keys.length) left.push(`idb ${name}: ${keys.slice(0, 5).join(', ')}`);
    else if (/^parvane-store-v3-[0-9a-f]+$/.test(name)) left.push(`idb ${name} (пустая база профиля)`);
  });
  Object.entries(data.caches).forEach(([name, urls]) => {
    if (!KEPT_CACHE.test(name) && urls.length) left.push(`cache ${name}: ${urls.length}`);
  });
  data.local.filter((key) => (key.startsWith('parvane:') && !KEPT_LOCAL.test(key)) || key.includes(user))
    .forEach((key) => left.push(`localStorage ${key}`));
  data.session.filter((key) => key.startsWith('parvane:') || key.includes(user))
    .forEach((key) => left.push(`sessionStorage ${key}`));
  if (data.localValues.includes(user)) left.push('localStorage: адрес аккаунта в значениях');
  return left;
}

try {
  const suffix = `${Date.now()}-${process.pid}`;

  // ── Компьютер ─────────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const deskUser = `pin-vera-${suffix}@local`;
  sessions.desktop = await preparePage(desktop, deskUser, PASSWORD);
  const { page } = sessions.desktop;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);

  // Включение: повтор с другим PIN не проходит, верный повтор включает
  await openPinScreen(page);
  await shown(hub(page, 'off'));
  assert.equal(await slide(page).locator('[data-pin-change]').count(), 0, 'без PIN есть «Сменить PIN»');
  await slide(page).locator('[data-pin-toggle]').click();
  await shown(step(page, 'new'));
  await shown(step(page, 'new').getByText('Create a PIN', { exact: true }));
  await tapPin(step(page, 'new'), '482');
  await shown(step(page, 'new').locator('[data-pin-filled="3"]'));
  await step(page, 'new').locator('[data-pin-key="erase"]').click();
  await shown(step(page, 'new').locator('[data-pin-filled="2"]'));
  await shot(page, 'desktop-new');
  await tapPin(step(page, 'new'), '21');
  await shown(step(page, 'repeat'));
  await tapPin(step(page, 'repeat'), '0000');
  await shown(step(page, 'repeat').getByText('The PINs do not match', { exact: true }));
  // Цифры принимаются и с клавиатуры
  await page.keyboard.type('4821');
  await shown(hub(page, 'on'), LOGIN_TIMEOUT_MS);
  await shown(slide(page).locator('[data-pin-toggle][aria-checked="true"]'));
  console.log('OK: PIN включён цифрами — новый, повтор, несовпадение не проходит');

  // Смена: неверный текущий не пускает дальше
  await slide(page).locator('[data-pin-change]').click();
  await shown(step(page, 'current'));
  await tapPin(step(page, 'current'), '0000');
  await shown(step(page, 'current').getByText('Wrong PIN', { exact: true }));
  await tapPin(step(page, 'current'), '4821');
  await shown(step(page, 'new'));
  await shown(step(page, 'new').getByText('New PIN', { exact: true }));
  await tapPin(step(page, 'new'), '1379');
  await shown(step(page, 'repeat'));
  await tapPin(step(page, 'repeat'), '1379');
  await shown(hub(page, 'on'), LOGIN_TIMEOUT_MS);
  await shot(page, 'desktop-settings');
  console.log('OK: PIN сменён — текущий, новый, повтор');

  // Экран блокировки после перезагрузки: по доске, без кнопки отпечатка
  await reloadToLock(page, 5);
  await shown(lock(page).getByText('Enter PIN', { exact: true }));
  await shown(lock(page).getByRole('button', { name: 'Forgot PIN? Sign out and sign in again' }));
  await shown(lock(page).getByText(/^After five wrong attempts/));
  assert.equal(await lock(page).locator('[data-pin-key]').count(), 11, 'клавиатура: десять цифр и «стереть»');
  assert.equal(await page.locator('#LeftColumn').count(), 0, 'под экраном блокировки открыт список чатов');

  // Прежний PIN больше не подходит; каждый неверный ввод уменьшает счётчик
  await tapPin(lock(page), '4821');
  await shown(lockWithLeft(page, 4));
  await shown(lock(page).getByText('Wrong PIN. Attempts left: 4', { exact: true }));
  await page.keyboard.type('0000');
  await shown(lockWithLeft(page, 3));
  await shown(lock(page).getByText('Wrong PIN. Attempts left: 3', { exact: true }));
  await shot(page, 'desktop-lock');
  console.log('OK: неверный ввод уменьшает счётчик попыток');

  // Перезагрузка счётчик не обнуляет
  await reloadToLock(page, 3);
  await shown(lock(page).getByText('Attempts left: 3', { exact: true }));
  assert.equal((await failedKeys(page)).length, 1);
  console.log('OK: счётчик переживает перезагрузку');

  // Верный ввод открывает приложение и возвращает все попытки
  await page.keyboard.type('1379');
  await waitForChatList(page);
  assert.deepEqual(await failedKeys(page), [], 'верный ввод не сбросил счётчик');
  await reloadToLock(page, 5);
  await tapPin(lock(page), '1379');
  await waitForChatList(page);
  console.log('OK: верный ввод открывает приложение и сбрасывает счётчик');

  // Выключение спрашивает текущий PIN; без PIN перезагрузка экран блокировки не показывает
  await openPinScreen(page);
  await shown(hub(page, 'on'));
  await slide(page).locator('[data-pin-toggle]').click();
  await shown(step(page, 'current'));
  await tapPin(step(page, 'current'), '1379');
  await shown(hub(page, 'off'), LOGIN_TIMEOUT_MS);
  await reloadPage(page);
  await waitForChatList(page);
  assert.equal(await lock(page).count(), 0, 'экран блокировки без PIN');
  console.log('OK: PIN выключен — запуск без экрана блокировки');

  // «Блокировать сейчас» и пять неверных вводов подряд — выход на экран входа со стиранием данных устройства
  await seedModuleData(page);
  await enablePin(page, '2468');
  const before = await readDeviceData(page);
  assert.ok(findAccountLeftovers(before, deskUser).length, 'до выхода на устройстве нет данных аккаунта — проверка пуста');
  await slide(page).locator('[data-pin-lock-now]').click();
  await shown(lockWithLeft(page, 5), LOGIN_TIMEOUT_MS);
  for (const left of [4, 3, 2, 1]) {
    await tapPin(lock(page), '0000');
    await shown(lockWithLeft(page, left));
  }
  await shown(lock(page).getByText('Wrong PIN. Attempts left: 1', { exact: true }));
  await tapPin(lock(page), '0000');
  await shown(authScreen(page), SIGN_OUT_MS);
  // Экран блокировки уходит переходом
  await lock(page).waitFor({ state: 'hidden', timeout: WAIT_MS });
  assert.deepEqual(await failedKeys(page), [], 'счётчик попыток остался после выхода');
  assert.equal(
    await page.evaluate(() => Object.keys(localStorage).some((key) => /^parvane:login/.test(key))), false,
    'адрес входа остался после выхода',
  );
  // На устройстве не осталось ничего от аккаунта: базы, кэши (кроме оболочки PWA), ключи хранилищ
  let leftovers = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    leftovers = findAccountLeftovers(await readDeviceData(page), deskUser);
    if (!leftovers.length) break;
    await page.waitForTimeout(500);
  }
  assert.deepEqual(leftovers, [], 'после стирания на устройстве остались данные аккаунта');
  console.log('OK: пятый неверный ввод — выход из аккаунта, данные устройства стёрты');

  // Вход заново: тот же аккаунт, пароль
  const passwordScreen = await submitNickUntilPassword(page, deskUser);
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.locator('[data-auth-submit]').click();
  await waitForChatList(page);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  assert.equal(await lock(page).count(), 0, 'после входа заново экран блокировки');
  console.log('OK: вход заново после стирания');

  // ── Телефон ───────────────────────────────────────────────────────────────
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phoneUser = `pin-lena-${suffix}@local`;
  sessions.phone = await preparePage(phone, phoneUser, PASSWORD);
  const mobile = sessions.phone.page;
  await dismissRecoveryKeyDialog(mobile).catch(() => undefined);
  await enablePin(mobile, '7410');
  await shot(mobile, 'phone-settings');
  await reloadToLock(mobile, 5);
  const overflow = await mobile.evaluate(() => {
    const width = window.innerWidth;
    return [...document.querySelectorAll('[data-pin-lock] *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1 || el.getBoundingClientRect().left < -1)
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`).slice(0, 5);
  });
  assert.deepEqual(overflow, [], 'экран блокировки выходит за ширину телефона');
  const keySize = await lock(mobile).locator('[data-pin-key="5"]').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [Math.round(box.width), Math.round(box.height)];
  });
  assert.deepEqual(keySize, [72, 60], 'клавиша не по доске');
  await tapPin(lock(mobile), '0000');
  await shown(lockWithLeft(mobile, 4));
  await tapPin(lock(mobile), '741');
  await shot(mobile, 'phone-lock');
  await lock(mobile).locator('[data-pin-forgot]').click();
  await mobile.getByRole('button', { name: 'Sign out', exact: true }).click();
  await shown(authScreen(mobile), SIGN_OUT_MS);
  assert.deepEqual(await failedKeys(mobile), []);
  let phoneLeft = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    phoneLeft = findAccountLeftovers(await readDeviceData(mobile), phoneUser);
    if (!phoneLeft.length) break;
    await mobile.waitForTimeout(500);
  }
  assert.deepEqual(phoneLeft, [], '«Забыли PIN?»: на устройстве остались данные аккаунта');
  console.log('OK: телефон — экран блокировки по ширине, «Забыли PIN?» выводит на экран входа');

  // Ошибки страницы после выхода (оборванный вход прежней сессии) сценарий не проверяет: важен экран входа
  console.log('OK: PIN хранилища по макету');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}pin-${name}.png` }).catch(() => {});
    console.error(`--- ${name}: журнал провайдера ---\n${(session.logs || []).slice(-25).join('\n')}`);
  }
  throw err;
} finally {
  await browser.close();
}
