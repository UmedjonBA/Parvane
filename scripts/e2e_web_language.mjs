// Язык интерфейса: Settings → Language → «Русский» переводит настройки и
// список чатов, выбор переживает reload, обратное переключение на English
// возвращает исходные подписи. Плюс старый lang-провайдер (useOldLang)
// берёт русские строки для модалки удаления чата.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  openPrivateChatStrict,
  preparePage as preparePageShared,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-language-e2e-password';
const preparePage = (context, user) => preparePageShared(context, user, PASSWORD);

const browser = await chromium.launch();
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
let aliceSession;
let bobSession;

async function openSettings(page) {
  await page.getByRole('button', { name: /Open menu|Открыть меню/ }).first().click();
  await page.getByRole('menuitem', { name: /^(Settings|Настройки)$/ }).click();
}

const RAW_KEY = /^(lng_\w+|[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)+|[A-Z][a-z]+([A-Z][a-z0-9]+){2,})$/;
// Латиница без кириллицы, хотя бы два слова: подпись, оставшаяся на английском
const ENGLISH_LINE = /^[A-Za-z][A-Za-z'’,.!?:()-]*( [A-Za-z'’,.!?:()-]+)+$/;
// Имена собственные и то, что по-русски пишется так же
const ENGLISH_ALLOWED = /Parvane|Telegram|GIF|Ctrl|Cmd|Enter|Wi-Fi|Web|Linux|Chrome|Firefox|Playwright|@local/;
// Пункты, которые не открывают экран настроек или уводят из них
const SKIPPED_ITEMS = /Выйти|Log Out|Сообщить|Report|Вопрос|Ask/i;

function classifyTexts(text, found) {
  text.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
    if (RAW_KEY.test(line)) found.rawKeys.add(line);
    else if (ENGLISH_LINE.test(line) && !ENGLISH_ALLOWED.test(line)) found.english.add(line);
  });
}

// Обход: каждый пункт главного экрана настроек и пункты экранов первого уровня
async function walkSettingsScreens(page) {
  const found = { rawKeys: new Set(), english: new Set() };
  const settings = page.locator('#Settings');
  const labelsOf = async () => (await settings.locator('.ListItem:visible').allInnerTexts())
    .map((text) => text.split('\n')[0].trim()).filter(Boolean);
  classifyTexts(await settings.innerText(), found);
  const mainLabels = (await labelsOf()).filter((label) => !SKIPPED_ITEMS.test(label));
  assert.ok(mainLabels.length >= 6, `главный экран настроек не распознан: ${mainLabels.join(' | ')}`);
  const mainItem = (label) => settings.locator('.ListItem:visible').filter({ hasText: label }).first();
  const backToMain = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await mainItem(mainLabels[1]).isVisible().catch(() => false)) return;
      await page.getByRole('button', { name: /Назад|Go back|Back/ }).first().click();
      await page.waitForTimeout(700);
    }
  };
  for (const label of mainLabels) {
    await mainItem(label).click();
    await page.waitForTimeout(900);
    classifyTexts(await settings.innerText(), found);
    await backToMain();
  }
  return { rawKeys: [...found.rawKeys].sort(), english: [...found.english].sort() };
}

async function pickLanguage(page, nativeName) {
  await page.getByRole('button', { name: /^(Language|Язык)/ }).click();
  // ItemPicker рендерит пункты как div[role=button] с названием языка
  const option = page.locator('.settings-language [role="button"]').filter({ hasText: nativeName }).first();
  await option.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await option.click();
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `lang-alice-${suffix}@local`;
  const bob = `lang-bob-${suffix}@local`;

  aliceSession = await preparePage(aliceContext, alice);
  bobSession = await preparePage(bobContext, bob);

  // Чат нужен, чтобы проверить перевод списка чатов и модалки удаления
  await openPrivateChatStrict(aliceSession.page, bob);
  await sendText(aliceSession.page, `hello-${suffix}`);

  const { page } = aliceSession;

  // ── English → Русский ────────────────────────────────────────────────────
  await openSettings(page);
  await pickLanguage(page, 'Русский');
  await page.locator('#Settings, .settings-content, .SettingsHeader, #LeftColumn')
    .locator('text=Язык интерфейса').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByRole('button', { name: /Назад|Go back|Back/ }).first().click();
  await page.locator('#LeftColumn').getByText('Настройки').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: интерфейс переключился на русский');

  // ── Экраны настроек на русском: ни сырых ключей, ни английских подписей (spec 012, A8) ──
  const { rawKeys, english } = await walkSettingsScreens(page);
  if (english.length) console.log(`английские строки на экранах настроек:\n  ${english.join('\n  ')}`);
  assert.deepEqual(rawKeys, [], `сырые ключи строк на экранах настроек: ${rawKeys.join(', ')}`);
  assert.deepEqual(english, [], 'на экранах настроек остались английские строки');
  console.log('OK: экраны настроек переведены');

  // ── Reload: выбор сохранён, старый lang-провайдер тоже на русском ────────
  // Персист sharedState в IDB троттлится (1 с, global/cache.ts) — даём записаться
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByPlaceholder('Поиск').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const chatItem = page.locator('#LeftColumn .ListItem').filter({ hasText: bob.split('@')[0] }).first();
  await chatItem.click({ button: 'right' });
  const deleteItem = page.getByRole('menuitem', { name: /Удалить/ }).first();
  await deleteItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await deleteItem.click();
  const deleteForMe = page.getByRole('button', { name: /Удалить только у меня/i }).first();
  await deleteForMe.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByText('Удалить чат', { exact: true }).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByRole('button', { name: /Отмена/i }).first().click();
  await deleteForMe.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: русский пережил reload, модалка удаления чата переведена');

  // ── Русский → English ────────────────────────────────────────────────────
  await openSettings(page);
  await pickLanguage(page, 'English');
  await page.locator('text=Interface Language').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.getByRole('button', { name: /Go back|Back|Назад/ }).first().click();
  await page.locator('#LeftColumn').getByText('Settings').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: обратно на английский');

  assertNoPageErrors({ alice: aliceSession, bob: bobSession });
  console.log('OK: язык интерфейса — переключение, persist, старый провайдер');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || process.env.PARVANE_E2E_BACKEND_LOG_DIR;
  const dir = shotDir ? `${shotDir}/` : '';
  await aliceSession?.page.screenshot({ path: `${dir}language-alice.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
