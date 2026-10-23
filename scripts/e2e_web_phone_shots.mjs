// Эталон телефонной версии web для Android (spec 032): снимки всех экранов на ширине телефона, русский
// интерфейс, Gruvbox тёмная. Ничего не утверждает, кроме того, что экраны открываются. Данные — выдуманные.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> scripts/run_web_phone_shots_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-phone-e2e-1';
const PHONE = { width: 360, height: 800 };
const dir = process.env.PARVANE_E2E_SHOT_DIR;
const mode = process.env.PARVANE_E2E_MODE || 'dark';

const browser = await chromium.launch();
try {
  const suffix = Date.now().toString(36);
  const phoneOptions = {
    viewport: PHONE, deviceScaleFactor: 2.5, colorScheme: mode, hasTouch: true, isMobile: true,
  };
  const phoneContext = await browser.newContext(phoneOptions);
  let count = 0;
  const snap = async (page, name) => {
    await page.waitForTimeout(800);
    count += 1;
    if (dir) await page.screenshot({ path: `${dir}/${String(count).padStart(2, '0')}-${name}.png` });
  };
  const step = async (page, name, action) => {
    try {
      await action();
      await snap(page, name);
    } catch (err) {
      console.log(`WARN: ${name}: ${String(err).split('\n')[0]}`);
      await snap(page, `${name}-fail`).catch(() => undefined);
    }
  };

  // Вход и регистрация до входа
  const { baseUrl } = { baseUrl: process.env.PARVANE_E2E_BASE_URL };
  // Экраны входа — по-русски (язык браузера); вход сценария ниже ищет английские подписи
  const authContext = await browser.newContext({ ...phoneOptions, locale: 'ru-RU' });
  const authPage = await authContext.newPage();
  await authPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const start = authPage.locator('.Transition_slide-active > #auth-phone-number-form');
  await step(authPage, 'auth-start', () => start.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }));
  await step(authPage, 'auth-register', async () => {
    const form = authPage.locator('.Transition_slide-active > #auth-registration-form');
    for (let attempt = 0; attempt < 5; attempt++) {
      await start.getByRole('button', { name: /Create account|Создать/ }).click();
      if (await form.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) break;
    }
    await form.waitFor({ state: 'visible', timeout: 5000 });
  });
  await step(authPage, 'auth-register-filled', async () => {
    const form = authPage.locator('.Transition_slide-active > #auth-registration-form');
    await form.locator('#sign-up-parvane-nick').fill('lisa_k');
    await form.locator('#sign-up-parvane-password').fill('Пароль-123');
  });
  await authContext.close();

  // Собеседник с группой
  const peerContext = await browser.newContext();
  const peerName = `phone-peer-${suffix}@local`;
  const userName = `phone-user-${suffix}@local`;
  const peer = await preparePage(peerContext, peerName, PASSWORD);
  const session = await preparePage(phoneContext, userName, PASSWORD, {
    seedLocalStorage: { 'parvane:color-scheme': 'gruvbox' },
  });
  const { page } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  const bar = page.locator('nav').filter({ has: page.locator('button') }).last();
  page.setDefaultTimeout(8000);

  // Русский интерфейс
  await step(page, 'profile-en', () => bar.locator(':scope > button').nth(4).evaluate((el) => el.click()));
  await step(page, 'language', async () => {
    await page.getByRole('button', { name: /^(Language|Язык)/ }).click();
    const option = page.locator('.settings-language [role="button"]').filter({ hasText: 'Русский' }).first();
    await option.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await option.click();
    await page.waitForTimeout(1500);
  });
  await page.getByRole('button', { name: /Назад|Back/ }).first().click().catch(() => undefined);

  await openPrivateChatStrict(peer.page, userName);
  await sendText(peer.page, 'Привет! Завтра встречаемся у библиотеки в 10?');
  await createGroupViaUi(peer.page, 'Книжный клуб', [userName]).catch((err) => console.log(`WARN группа: ${err}`));
  await sendText(peer.page, 'Читаем «Мастера и Маргариту» к пятнице').catch(() => undefined);

  // Кнопки панели по месту: подписи зависят от языка, у «Чатов» в имени ещё и счётчик
  const NAV = [/Chats|Чаты/, /Planner|План/, /New entry|Новая запись/, /Knowledge|Знания/, /Profile|Профиль/];
  const navTo = async (name) => {
    const index = NAV.findIndex((re) => re.source === name.source.replace(/^\^\(|\)\$$/g, ''));
    const buttons = bar.locator(':scope > button');
    console.log(`панель: кнопок ${await buttons.count()}, жму ${index}`);
    await buttons.nth(index >= 0 ? index : 0).evaluate((el) => el.click());
  };
  // Нажатие через DOM: окна и шторки web перехватывают указатель у соседних слоёв
  const tap = (locator) => locator.first().evaluate((el) => el.click());
  const closeModal = async () => {
    await tap(page.locator('.Modal button, [role="dialog"] button').filter({ hasText: /^(Отмена|Cancel)$/ }))
      .catch(() => page.keyboard.press('Escape'));
    await page.waitForTimeout(500);
  };
  await step(page, 'chats', async () => {
    await navTo(/^(Chats|Чаты)$/);
    await page.waitForTimeout(3000);
  });
  await step(page, 'chats-plus-menu', () => navTo(/^(New entry|Новая запись)$/));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await step(page, 'chat-open', async () => {
    await tap(page.locator('.chat-list .ListItem-button, .chat-list .ListItem'));
    await page.waitForTimeout(2000);
  });
  await step(page, 'chat-header-menu', () => tap(page.locator('.MiddleHeader button[aria-label="More actions"], .MiddleHeader .DropdownMenu button')));
  await page.keyboard.press('Escape');
  await tap(page.locator('.MiddleHeader button').first()).catch(() => undefined);
  await page.waitForTimeout(1000);
  await step(page, 'chat-search', () => tap(page.locator('#LeftMainHeader button')));
  await page.keyboard.press('Escape');
  await tap(page.locator('#LeftMainHeader button').first()).catch(() => undefined);
  await step(page, 'profile', () => navTo(/^(Profile|Профиль)$/));
  await step(page, 'profile-scroll', async () => {
    await page.locator('.settings-main-scroll').first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  });
  await step(page, 'profile-account', async () => {
    await page.locator('.settings-main-scroll').first().evaluate((el) => { el.scrollTop = 0; });
    await tap(page.locator('.settings-main-scroll button').first());
    await page.waitForTimeout(1500);
  });
  await page.goBack().catch(() => undefined);
  await page.waitForTimeout(800);

  // «+» и ввод текстом (в «Плане» «+» сразу открывает окно)
  const planner = page.locator('#ParvanePlanner');
  await navTo(/^(Planner|План)$/);
  await page.waitForTimeout(1500);
  await step(page, 'plus', () => navTo(/^(New entry|Новая запись)$/));
  await step(page, 'quick-typed', () => page.locator('#planner-quick-input').fill('урок вт 15:00 каждую неделю 5 мес'));
  await closeModal();
  for (const line of ['созвон 16:00 45 мин', 'задача сдать отчёт до пт', 'пробежка завтра 8:00 30 мин',
    'обед гречка 150г б30 ж10 у60 520 ккал', 'вода 500 мл', 'сон 23:40-07:30', 'вес 72,4']) {
    await navTo(/^(New entry|Новая запись)$/);
    await page.locator('#planner-quick-input').fill(line);
    await page.locator('#planner-quick-input').press('Enter');
    await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: 20000 })
      .catch(async () => { console.log(`WARN: окно не закрылось после «${line}»`); await closeModal(); });
    await page.waitForTimeout(400);
  }
  await step(page, 'plan', () => planner.waitFor({ state: 'visible' }));
  for (const value of ['today', 'week', 'month', 'year', 'agenda']) {
    await step(page, `plan-view-${value}`, async () => {
      await tap(planner.locator(`button[data-value="${value}"]`));
      await page.waitForTimeout(1200);
    });
    if (value === 'today') {
      await step(page, 'plan-today-scroll', async () => {
        await planner.locator('.custom-scroll, [class*="scroll"]').first().evaluate((el) => { el.scrollTop = 600; })
          .catch(() => page.mouse.wheel(0, 600));
      });
    }
  }
  await tap(planner.locator('button[data-value="today"]'));
  await page.waitForTimeout(800);
  await step(page, 'plan-entry', async () => {
    await tap(planner.getByText('созвон', { exact: false }));
    await page.waitForTimeout(1200);
  });
  await page.goBack().catch(() => undefined);
  await page.waitForTimeout(800);
  await step(page, 'plan-settings', async () => {
    await tap(planner.locator('button[aria-label="Настройки плана"], button[aria-label="Planner settings"], button[aria-label*="астрой"]'));
    await page.waitForTimeout(1000);
  });
  await page.goBack().catch(() => undefined);
  await page.waitForTimeout(800);
  await step(page, 'plan-health', () => tap(planner.locator('header').getByText(/^(Health|Здоровье)$/)));
  for (const y of [700, 1400, 2100, 2800]) {
    await step(page, `plan-health-${y}`, async () => {
      await planner.evaluate((root, top) => {
        const el = [...root.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 50
          && getComputedStyle(n).overflowY !== 'visible');
        if (el) el.scrollTop = top;
      }, y);
    });
  }

  // «Знания»
  const knowledge = page.locator('#ParvaneKnowledge');
  await navTo(/^(Knowledge|Знания)$/);
  await page.waitForTimeout(2500);
  const tabByName = (name) => page.locator('[role="tab"]:visible, header button:visible').filter({ hasText: name });
  await step(page, 'knowledge-notes', async () => {
    await tap(tabByName('Заметки'));
    await page.waitForTimeout(4000);
  });
  await step(page, 'knowledge-guide', async () => {
    await tap(knowledge.locator('[data-notes-guide]'));
    await page.waitForTimeout(6000);
  });
  await step(page, 'note-open', async () => {
    await tap(knowledge.locator('[data-note-row]'));
    await page.waitForTimeout(2000);
  });
  await step(page, 'note-scroll', () => page.mouse.wheel(0, 700));
  await page.goBack().catch(() => undefined);
  await page.waitForTimeout(800);
  await step(page, 'knowledge-notes-list', () => page.waitForTimeout(300));
  for (const name of ['Граф', 'Холст', 'Файлы']) {
    await step(page, `knowledge-${name}`, async () => {
      await tap(tabByName(name));
      await page.waitForTimeout(3000);
    });
  }
  await step(page, 'knowledge-canvas-from-graph', async () => {
    await tap(tabByName('Холст'));
    await page.waitForTimeout(1000);
    await tap(knowledge.locator('[data-canvas-from-graph]'));
    await page.waitForTimeout(3000);
  });
  await step(page, 'knowledge-search', async () => {
    await tap(tabByName('Заметки'));
    await tap(knowledge.locator('header button[aria-label*="оиск"], header button[aria-label*="Search"]'));
  });
  console.log('e2e_web_phone_shots: OK');
} finally {
  await browser.close();
}
