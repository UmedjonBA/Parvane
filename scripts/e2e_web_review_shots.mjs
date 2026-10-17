// Снимки для проверки глазами (spec 012 quickstart п. 3, spec 018 T008, локализация 17 окт 2026):
// русский язык, тёмная тема — список чатов, редактор папки, профиль «Избранного», календарь поиска,
// «Анимации и производительность», меню вложений, меню группы, полоска «Плана» до и после 3 с,
// телефонный вид «Плана» (полоса недели и день, «Сегодня»), заявки на вступление, окно отчёта об ошибке.
// Шаг, который не удался, снимает экран с пометкой fail и не останавливает остальные: сценарий
// ничего не утверждает, кроме того, что вход и переключение языка прошли.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> scripts/run_web_review_shots_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  createGroupViaUi,
  dismissRecoveryKeyDialog,
  openPrivateChatStrict,
  openSavedMessages,
  preparePage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-review-e2e-1';
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const STEP_TIMEOUT_MS = 20000;
const dir = process.env.PARVANE_E2E_SHOT_DIR || '/tmp';
const failures = [];

const browser = await chromium.launch();
const suffix = Date.now().toString(36);
const alice = `review-a-${suffix}@local`;
const bob = `review-b-${suffix}@local`;

async function step(page, name, fn, { escape = true } = {}) {
  try {
    await fn();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/${name}.png` });
    console.log(`OK: снимок ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${String(error).split('\n')[0]}`);
    await page.screenshot({ path: `${dir}/${name}-fail.png` }).catch(() => undefined);
  }
  // На телефоне Escape в списке чатов открывает поиск — там шаги без него
  if (escape) await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(300);
}

async function openSettings(page) {
  await page.locator('#FoldersSidebar').getByRole('button', { name: /^(Profile|Профиль)$/ }).click();
  await page.locator('.settings-main-scroll').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

const settingsRow = (page, text) => page.locator('#Settings .ListItem:visible').filter({ hasText: text }).first();

async function backToChats(page) {
  await page.locator('#FoldersSidebar').getByRole('tab').first().click().catch(() => undefined);
  await page.waitForTimeout(500);
}

try {
  const aliceContext = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
  const bobContext = await browser.newContext({ viewport: WIDE, colorScheme: 'dark' });
  const { page } = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await dismissRecoveryKeyDialog(bobSession.page).catch(() => undefined);

  // Данные: личный чат, группа с заявкой нет — заявки требуют ссылки с одобрением, достаточно пустого экрана
  await openPrivateChatStrict(page, bob);
  await sendText(page, 'Привет! Проверка оформления: ссылка https://example.org');
  await openPrivateChatStrict(bobSession.page, alice);
  await sendText(bobSession.page, 'Ответ собеседника');
  await createGroupViaUi(page, 'Кружок по средам', [bob.split('@')[0]]).catch((e) => console.log(`группа: ${e}`));
  await openSavedMessages(page);
  await sendText(page, 'Заметка себе');

  // Русский язык
  await openSettings(page);
  await page.getByRole('button', { name: /^(Language|Язык)/ }).click();
  await page.locator('.settings-language [role="button"]').filter({ hasText: 'Русский' }).first().click();
  await page.getByText('Язык интерфейса').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.getByRole('button', { name: /Назад|Go back|Back/ }).first().click();
  console.log('OK: интерфейс на русском');
  await page.waitForTimeout(1500);

  await step(page, '01-settings-main', async () => {
    await page.locator('.settings-main-scroll').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, '02-animations', async () => {
    await settingsRow(page, 'Анимации и производительность').click();
    await page.getByText('Уровень анимаций').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await openSettings(page).catch(() => undefined);
  await step(page, '03-folder-editor', async () => {
    await settingsRow(page, 'Папки').click();
    await page.getByText('Создать папку').first().click();
    await page.waitForTimeout(800);
  });
  await openSettings(page).catch(() => undefined);
  await step(page, '04-privacy', async () => {
    await settingsRow(page, 'Конфиденциальность').click();
    await page.waitForTimeout(800);
  });
  await step(page, '05-privacy-bottom', async () => {
    await page.locator('#Settings .custom-scroll, .settings-content').first()
      .evaluate((el) => { el.scrollTop = el.scrollHeight; });
  });
  await openSettings(page).catch(() => undefined);
  await step(page, '07-bug-report', async () => {
    await settingsRow(page, 'Ещё').click().catch(() => undefined);
    await page.locator('.ListItem:visible').filter({ hasText: 'Сообщить об ошибке' }).first().click();
    await page.getByText('Что пошло не так?').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS })
      .catch(() => page.getByPlaceholder('Что пошло не так?').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }));
  });

  await backToChats(page);
  await step(page, '08-chat-list', async () => {
    await page.locator('#LeftColumn .ListItem').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, '09-chat', async () => {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first().click();
    await page.getByText('Ответ собеседника').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, '10-attach-menu', async () => {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first().click();
    await page.getByRole('button', { name: 'Add an attachment' }).click();
    await page.getByRole('menuitem').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(page, '11-search-calendar', async () => {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first().click();
    await page.locator('.MiddleHeader').getByRole('button', { name: /Поиск|Search/ }).first().click()
      .catch(() => page.locator('.MiddleHeader').getByRole('button').filter({ has: page.locator('.icon-search') })
        .first().click());
    await page.getByRole('button', { name: 'Перейти к дате' }).first().click();
    await page.waitForTimeout(800);
  });
  await step(page, '12-saved-profile', async () => {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: 'Избранное' }).first().click();
    await page.locator('.MiddleHeader .ChatInfo').first().click();
    await page.waitForTimeout(1200);
  });
  await step(page, '13-group-menu', async () => {
    await page.locator('#LeftColumn .ListItem').filter({ hasText: 'Кружок по средам' }).first().click();
    await page.locator('.MiddleHeader').getByRole('button', { name: /Ещё|More/ }).last().click();
    await page.waitForTimeout(800);
  });
  await step(page, '14-group-edit', async () => {
    await page.locator('.MiddleHeader .ChatInfo').first().click();
    await page.locator('#RightColumn').getByRole('button', { name: /Изменить|Edit/ }).first().click();
    await page.locator('#RightColumn').getByText('Ссылки-приглашения').first()
      .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });

  // «План»: полоска уведомления после действия и через 3 с
  await step(page, '15-planner-strip', async () => {
    await page.locator('#FoldersSidebar').getByRole('tab', { name: /Календарь|Calendar/ }).first().click();
    const planner = page.locator('#ParvanePlanner');
    await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await planner.getByRole('button', { name: /\+ Запись|\+ Entry/ }).first().click();
    await page.locator('#planner-quick-input').fill('задача полить цветы');
    await page.locator('#planner-quick-input').press('Enter');
    await page.waitForTimeout(500);
  });
  await step(page, '16-planner-strip-after-3s', async () => {
    await page.waitForTimeout(3000);
  });

  // Телефон: полоса недели, день под ней, «Сегодня»
  const phone = await browser.newContext({ viewport: PHONE, colorScheme: 'dark', hasTouch: true, isMobile: true });
  const phonePage = (await preparePage(phone, `review-p-${suffix}@local`, PASSWORD)).page;
  await dismissRecoveryKeyDialog(phonePage).catch(() => undefined);
  await step(phonePage, '17-phone-chats', async () => {
    await phonePage.waitForTimeout(800);
  }, { escape: false });
  await step(phonePage, '18-phone-planner-today', async () => {
    await phonePage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Planner' }).click();
    await phonePage.locator('#ParvanePlanner').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }, { escape: false });
  await step(phonePage, '19-phone-planner-week', async () => {
    const views = phonePage.locator('#ParvanePlanner').getByRole('group', { name: 'Calendar view' });
    await phonePage.locator('#ParvanePlanner header').getByText('Calendar', { exact: true }).first().click()
      .catch(() => undefined);
    await views.locator('button[data-value="week"]').click();
    await phonePage.locator('#ParvanePlanner [data-day-strip]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  }, { escape: false });
  await step(phonePage, '20-phone-planner-month', async () => {
    const views = phonePage.locator('#ParvanePlanner').getByRole('group', { name: 'Calendar view' });
    await views.locator('button[data-value="month"]').click();
  }, { escape: false });
} finally {
  await browser.close();
}
console.log(failures.length ? `не снято: ${failures.join(', ')}` : 'все снимки сняты');
console.log('OK');
