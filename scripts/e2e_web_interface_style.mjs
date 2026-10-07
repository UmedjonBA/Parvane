// Оформление интерфейса (spec 008): «Панели» (вид по умолчанию) и «Классическое» (вид Web A 12.0.30).
// Проверяется геометрия колонок (отступы от краёв окна, скругление, тень), выбор
// на экране входа и в настройках, сохранение после перезагрузки и выхода, тёмная
// тема и мобильная ширина. Запуск: scripts/run_web_interface_style_e2e.sh
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  closeSettings,
  dismissRecoveryKeyDialog,
  exchangeMessages,
  logOut,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  requireEnv,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-style-e2e-1';
const STORAGE_KEY = 'parvane:interface-style';
const WIDE = { width: 1440, height: 900 };
const { baseUrl, gatewayUrl } = requireEnv();

// Геометрия колонки: прямоугольник, скругление и тень
function measure(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(window.innerWidth - rect.right),
      bottom: Math.round(window.innerHeight - rect.bottom),
      radius: parseFloat(style.borderTopLeftRadius) || 0,
      hasShadow: style.boxShadow !== 'none',
    };
  }, selector);
}

async function expectStyle(page, style, label) {
  await page.waitForFunction(
    (expected) => document.documentElement.classList.contains('interface-classic') === (expected === 'classic'),
    style,
    { timeout: 5000 },
  );
  const left = await measure(page, '#LeftColumn');
  const header = await measure(page, '.MiddleHeader');
  const footer = await measure(page, '#MiddleColumn .middle-column-footer');
  if (style === 'classic') {
    assert.deepEqual(
      { left: left.left, top: left.top, bottom: left.bottom, radius: left.radius, hasShadow: left.hasShadow },
      { left: 0, top: 0, bottom: 0, radius: 0, hasShadow: false },
      `${label}: левая колонка не вплотную к краям: ${JSON.stringify(left)}`,
    );
    assert.equal(header.top, 0, `${label}: заголовок чата не у верхнего края: ${JSON.stringify(header)}`);
    assert.equal(header.right, 0, `${label}: заголовок чата не до правого края: ${JSON.stringify(header)}`);
    assert.equal(header.radius, 0, `${label}: заголовок чата скруглён`);
    // Поле ввода как в Web A 12.0.30: «пузырь» (свой фон и скругление у обёртки,
    // а не у всей строки) и круглая кнопка отправки рядом
    // Кнопка отправки меняет размер с анимацией — ждём конечные 3rem
    await page.waitForFunction(() => {
      const button = document.querySelector('.Composer.is-chat-composer > .Button.main-button');
      return button && Math.round(button.getBoundingClientRect().width) === 48;
    }, undefined, { timeout: 5000 }).catch(() => undefined);
    const composer = await page.evaluate(() => {
      const row = getComputedStyle(document.querySelector('.Composer.is-chat-composer'));
      const bubble = getComputedStyle(document.querySelector('.Composer.is-chat-composer .composer-wrapper'));
      const button = document.querySelector('.Composer.is-chat-composer > .Button.main-button').getBoundingClientRect();
      return {
        rowHasShadow: row.boxShadow !== 'none',
        bubbleRadius: parseFloat(bubble.borderTopLeftRadius) || 0,
        bubbleTailCorner: parseFloat(bubble.borderBottomRightRadius) || 0,
        bubbleHasShadow: bubble.boxShadow !== 'none',
        button: [Math.round(button.width), Math.round(button.height)],
      };
    });
    assert.deepEqual(
      { ...composer, bubbleRadius: composer.bubbleRadius > 0 },
      { rowHasShadow: false, bubbleRadius: true, bubbleTailCorner: 0, bubbleHasShadow: true, button: [48, 48] },
      `${label}: поле ввода не «пузырь» с круглой кнопкой: ${JSON.stringify(composer)}`,
    );
    assert.ok(footer.bottom === 0, `${label}: нижняя полоса чата смещена: ${JSON.stringify(footer)}`);
  } else {
    // «Панели» — вид до фичи: отступ 1rem, скругление 1.5rem, тень
    assert.deepEqual(
      { left: left.left, top: left.top, bottom: left.bottom, radius: left.radius, hasShadow: left.hasShadow },
      { left: 16, top: 16, bottom: 16, radius: 24, hasShadow: true },
      `${label}: «Панели» изменились: ${JSON.stringify(left)}`,
    );
    assert.ok(header.top >= 16 && header.radius > 0, `${label}: заголовок «Панелей» изменился: ${JSON.stringify(header)}`);
    assert.ok(footer.bottom >= 0 && footer.right > 0, `${label}: поле ввода «Панелей» изменилось`);
  }
}

// Экраны входа живут слайдами одного Transition — уходящий слайд ещё в DOM
function authPicker(page) {
  return page.locator('.Auth .Transition_slide-active').getByRole('radiogroup', { name: 'Interface style' });
}

function settingsPicker(page) {
  return page.locator('#LeftColumn').getByRole('radiogroup', { name: 'Interface style' });
}

async function openGeneralSettings(page) {
  await page.getByRole('button', { name: 'Open menu' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByText('General Settings', { exact: false }).first().click();
  await settingsPicker(page).waitFor({ state: 'visible', timeout: 15000 });
}

const browser = await chromium.launch();
const aliceContext = await browser.newContext({ viewport: WIDE });
const bobContext = await browser.newContext({ viewport: WIDE });
const freshContext = await browser.newContext({ viewport: WIDE });

try {
  const suffix = Date.now().toString(36);
  const alice = `style-a-${suffix}@local`;
  const bob = `style-b-${suffix}@local`;

  // ── Экран входа: выбор оформления до регистрации (US2) ────────────────────
  let pickerSeen = false;
  const aliceSession = await preparePage(aliceContext, alice, PASSWORD, {
    beforeLogin: async (page) => {
      const picker = authPicker(page);
      await picker.waitFor({ state: 'visible', timeout: 60000 });
      // На новом устройстве заранее отмечены «Панели»
      assert.equal(await picker.getByRole('radio', { name: 'Panels' }).getAttribute('aria-checked'), 'true');
      await picker.getByRole('radio', { name: 'Classic' }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains('interface-classic'));
      pickerSeen = true;
    },
  });
  assert.ok(pickerSeen, 'выбор оформления на экране входа не показан');
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  const { page } = aliceSession;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await dismissRecoveryKeyDialog(bobSession.page).catch(() => undefined);
  await exchangeMessages(page, alice, bobSession.page, bob, 'style');
  await openPrivateChatStrict(page, bob);
  await expectStyle(page, 'classic', 'после регистрации с выбором «Классическое»');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), 'classic');
  console.log('OK: выбор на экране входа применён — интерфейс после регистрации «Классический»');

  // Второй пользователь ничего не выбирал — «Панели» как до фичи (FR-005, FR-009)
  await openPrivateChatStrict(bobSession.page, alice);
  await expectStyle(bobSession.page, 'panels', 'без выбора');
  console.log('OK: без выбора — «Панели», геометрия прежняя');

  // ── Настройки: переключение без перезагрузки (US1) ────────────────────────
  await openGeneralSettings(page);
  const picker = settingsPicker(page);
  assert.equal(await picker.getByRole('radio', { name: 'Classic' }).getAttribute('aria-checked'), 'true');
  const marker = await page.evaluate(() => { window.__styleMarker = 1; return performance.timeOrigin; });
  await picker.getByRole('radio', { name: 'Panels' }).click();
  await expectStyle(page, 'panels', 'переключение на «Панели»');
  await picker.getByRole('radio', { name: 'Classic' }).click();
  await expectStyle(page, 'classic', 'переключение на «Классическое»');
  assert.equal(await page.evaluate(() => performance.timeOrigin), marker, 'переключение перезагрузило страницу');
  assert.equal(await page.evaluate(() => window.__styleMarker), 1, 'переключение перезагрузило страницу');

  // Правая колонка и тёмная тема
  await page.getByText('Dark', { exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
  await closeSettings(page);
  await openPrivateChatStrict(page, bob);
  await expectStyle(page, 'classic', 'тёмная тема');
  await page.locator('.MiddleHeader .ChatInfo').first().click();
  await page.locator('#RightColumn .profile-info').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);
  const right = await measure(page, '#RightColumn');
  assert.deepEqual(
    { top: right.top, right: right.right, bottom: right.bottom, radius: right.radius, hasShadow: right.hasShadow },
    { top: 0, right: 0, bottom: 0, radius: 0, hasShadow: false },
    `правая колонка не вплотную к краям: ${JSON.stringify(right)}`,
  );
  const headerWithRight = await measure(page, '.MiddleHeader');
  const leftEdgeOfRight = await page.evaluate(() => Math.round(document.querySelector('#RightColumn').getBoundingClientRect().left));
  assert.ok(
    Math.abs((WIDE.width - headerWithRight.right) - leftEdgeOfRight) <= 1,
    `заголовок чата не примыкает к правой колонке: ${JSON.stringify(headerWithRight)} / ${leftEdgeOfRight}`,
  );
  console.log('OK: переключение в настройках без перезагрузки; правая колонка и тёмная тема');

  // ── Перезагрузка: сохранённое оформление до первой отрисовки (FR-008) ─────
  await page.addInitScript(() => {
    // Класс должен стоять раньше, чем появится интерфейс (document в этот момент может быть пуст)
    const probe = () => {
      if (document.querySelector('#LeftColumn')) {
        window.__styleAtFirstPaint = document.documentElement.classList.contains('interface-classic');
        return;
      }
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  });
  await reloadPage(page);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__styleAtFirstPaint), true, 'после reload интерфейс появился раньше оформления');
  await openPrivateChatStrict(page, bob);
  await expectStyle(page, 'classic', 'после перезагрузки');
  console.log('OK: после перезагрузки «Классическое» стоит до появления интерфейса');

  // ── Мобильная ширина: без горизонтального переполнения ────────────────────
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(800);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `горизонтальное переполнение на 390px: ${overflow}`);
  await page.setViewportSize(WIDE);
  console.log('OK: мобильная ширина без переполнения');

  // ── Выход: выбор остаётся на устройстве, экран входа показывает его ───────
  await logOut(page);
  const loginPicker = authPicker(page);
  await loginPicker.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await loginPicker.getByRole('radio', { name: 'Classic' }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY), 'classic');
  console.log('OK: после выхода выбор сохранён, экран входа показывает «Классическое»');

  // ── Повреждённое значение — оформление по умолчанию, без ошибок ───────────
  const freshPage = await freshContext.newPage();
  const errors = [];
  freshPage.on('pageerror', (err) => errors.push(String(err)));
  await freshPage.addInitScript(({ url, key }) => {
    localStorage.setItem('parvane:gateway', url);
    localStorage.setItem(key, 'garbage');
  }, { url: gatewayUrl, key: STORAGE_KEY });
  await freshPage.goto(baseUrl);
  const freshPicker = authPicker(freshPage);
  await freshPicker.waitFor({ state: 'visible', timeout: 60000 });
  assert.equal(await freshPicker.getByRole('radio', { name: 'Panels' }).getAttribute('aria-checked'), 'true');
  assert.equal(await freshPage.evaluate(() => document.documentElement.classList.contains('interface-classic')), false);
  assert.deepEqual(errors, [], `ошибки страницы при повреждённом значении: ${errors.join('; ')}`);
  console.log('OK: повреждённое значение — «Панели», ошибок нет');

  console.log('e2e_web_interface_style: OK');
} finally {
  await browser.close();
}
