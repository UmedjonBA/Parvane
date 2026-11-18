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

// «Профиль» боковой панели — главный экран настроек (подпись кнопки зависит от языка)
async function openSettings(page) {
  await page.locator('#FoldersSidebar').getByRole('tab', { name: /^(Profile|Профиль)$/ }).click();
  await page.locator('.settings-main-scroll').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const RAW_KEY = /^(lng_\w+|[A-Z][A-Za-z0-9]*(\.[A-Z][A-Za-z0-9]*)+|[A-Z][a-z]+([A-Z][a-z0-9]+){2,})$/;
// Латиница без кириллицы, хотя бы два слова: подпись, оставшаяся на английском
const ENGLISH_LINE = /^[A-Za-z][A-Za-z'’,.!?:()-]*( [A-Za-z'’,.!?:()-]+)+$/;
// Имена собственные и то, что по-русски пишется так же
const ENGLISH_ALLOWED = /Parvane|Telegram|GIF|Ctrl|Cmd|Enter|Wi-Fi|Web|Linux|Chrome|Firefox|Playwright|@local/;
// Пункты «Профиля», открывающие экран настроек (выгрузка, отчёт об ошибке и выход — окна)
const SCREEN_ITEMS = [
  'modules', 'appearance', 'notifications', 'language', 'devices', 'privacy', 'keys', 'data', 'messenger', 'about',
];

function classifyTexts(text, found) {
  text.split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
    if (RAW_KEY.test(line)) found.rawKeys.add(line);
    else if (ENGLISH_LINE.test(line) && !ENGLISH_ALLOWED.test(line)) found.english.add(line);
  });
}

// Обход: «Обзор», колонка разделов и каждый экран, который открывается из неё (компьютер)
async function walkSettingsScreens(page) {
  const found = { rawKeys: new Set(), english: new Set() };
  const settings = page.locator('#Settings');
  const menu = page.locator('[data-profile-menu="nav"]');
  // Экран «Язык» уходит: пока он виден, его пункты («Не переводить») попадали бы в обход
  await settings.locator('.settings-language').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS })
    .catch(() => undefined);
  // Строки языка догружаются отдельной частью сборки: ждём, пока подписи колонки перестанут меняться
  let settled = await menu.innerText();
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(400);
    const next = await menu.innerText();
    if (next === settled) break;
    settled = next;
  }
  classifyTexts(settled, found);
  classifyTexts(await settings.innerText(), found);
  for (const id of SCREEN_ITEMS) {
    const item = menu.locator(`[data-profile-item="${id}"]`);
    await item.click();
    await menu.locator(`[data-profile-item="${id}"][aria-current="page"]`)
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await page.waitForTimeout(700);
    classifyTexts(await settings.innerText(), found);
  }
  await menu.locator('[data-profile-item="overview"]').click();
  return { rawKeys: [...found.rawKeys].sort(), english: [...found.english].sort() };
}

async function pickLanguage(page, nativeName) {
  await page.locator('[data-profile-item="language"]').click();
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
  // «Язык» открыт из колонки разделов: стрелки «Назад» у него нет, колонка переведена на месте
  await page.locator('[data-profile-item="overview"]').getByText('Обзор', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('[data-profile-item="overview"]').click();
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
  await page.locator('[data-profile-item="overview"]').getByText('Overview', { exact: true })
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
