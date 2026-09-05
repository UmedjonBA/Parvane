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
