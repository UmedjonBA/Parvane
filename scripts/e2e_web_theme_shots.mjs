// Снимки экранов в тёмной и светлой теме выбранной цветовой схемы — для проверки глазами (spec 019).
// Ничего не утверждает, кроме того, что экраны открываются. Снимки — в PARVANE_E2E_SHOT_DIR.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> scripts/run_web_theme_shots_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog,
  preparePage,
  sendText,
  openSavedMessages,
  openPlannerScreen,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-theme-e2e-1';
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const STEP_TIMEOUT_MS = 20000;
const dir = process.env.PARVANE_E2E_SHOT_DIR;
const schemes = (process.env.PARVANE_E2E_SCHEMES || 'gruvbox').split(',');

const browser = await chromium.launch();
try {
  for (const scheme of schemes) {
    for (const mode of ['dark', 'light']) {
      const context = await browser.newContext({ viewport: WIDE, colorScheme: mode });
      const session = await preparePage(context, `theme-${scheme}-${mode}-${Date.now().toString(36)}@local`, PASSWORD, {
        seedLocalStorage: { 'parvane:color-scheme': scheme },
      });
      const { page } = session;
      await dismissRecoveryKeyDialog(page).catch(() => undefined);
      const shot = async (name) => {
        await page.waitForTimeout(700);
        if (dir) await page.screenshot({ path: `${dir}/${scheme}-${mode}-${name}.png` });
      };
      const sidebar = page.locator('#FoldersSidebar');
      const planner = page.locator('#ParvanePlanner');
      // Чат с собой: свои сообщения, поле ввода, шапка
      await openSavedMessages(page);
      await sendText(page, 'Проверка цветов: своё сообщение со ссылкой https://example.org и `кодом`');
      await sendText(page, 'Второе сообщение');
      await shot('chat');
      // «План»: запись, «Сегодня», календарь, карточка, «Здоровье»
      await openPlannerScreen(page, 'today');
      await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      for (const line of ['созвон 16:00 45 мин', 'задача сдать отчёт до пт', 'обед гречка б30 ж10 у60 сахар 60 520 ккал', 'сон 01:00-06:00', 'вес 72,4']) {
        await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
        await page.locator('#planner-quick-input').fill(line);
        await page.locator('#planner-quick-input').press('Enter');
        await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS })
          .catch(async (error) => {
            const failDir = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
            if (failDir) await page.screenshot({ path: `${failDir}/theme-quick-failure.png` });
            console.log(`окно ввода не закрылось после «${line}»; история ${await page.evaluate(() => JSON.stringify({
              cursor: window.TEST_getHistoryCursor?.(),
              state: window.TEST_getHistoryState?.()?.map((r) => (r ? { i: r.index, c: r.isClosed } : r)),
              real: window.history.state,
            }))}`);
            throw error;
          });
      }
      await shot('today');
      await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
      await page.locator('#planner-quick-input').fill('урок вт 15:00 каждую неделю 5 мес');
      await shot('quick');
      await page.keyboard.press('Escape');
      await openPlannerScreen(page, 'calendar');
      await shot('calendar');
      await sidebar.getByRole('tab', { name: 'Health' }).click();
      await shot('health');
      // «Знания»: заметка и файлы
      await sidebar.getByRole('tab', { name: 'Cloud' }).click();
      await page.locator('#ParvaneCloud').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await shot('files');
      await page.locator('#ParvaneCloud header').getByText('Notes', { exact: true }).first().click();
      const knowledge = page.locator('#ParvaneKnowledge');
      // Новому аккаунту «Знания» сами открывают заметку-инструкцию
      await knowledge.locator('[data-note-body]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await shot('note');
      await page.getByRole('tab', { name: 'Canvas' }).first().click();
      await knowledge.locator('[data-canvas-from-graph]').first().click().catch(() => undefined);
      await shot('canvas');
      // Настройки: выбор схемы
      await sidebar.getByRole('button', { name: 'Profile' }).click();
      await shot('settings');
      // Те же экраны на ширине телефона: нижняя панель, вкладки внутри разделов
      await context.close();
      const phoneContext = await browser.newContext({ viewport: PHONE, colorScheme: mode, hasTouch: true });
      const phoneSession = await preparePage(phoneContext, `theme-p-${scheme}-${mode}-${Date.now().toString(36)}@local`, PASSWORD, {
        seedLocalStorage: { 'parvane:color-scheme': scheme },
      });
      const phonePage = phoneSession.page;
      await dismissRecoveryKeyDialog(phonePage).catch(() => undefined);
      const bar = phonePage.getByRole('navigation', { name: 'Sections' });
      const phone = async (name, open) => {
        await open().catch((err) => console.log(`WARN: телефон, ${name}: ${String(err).split('\n')[0]}`));
        await phonePage.waitForTimeout(700);
        if (dir) await phonePage.screenshot({ path: `${dir}/${scheme}-${mode}-phone-${name}.png` });
      };
      await phone('chats', () => bar.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }));
      await phone('profile', () => bar.getByRole('button', { name: 'Profile' }).click());
      await phone('chats2', () => bar.getByRole('button', { name: 'Chats' }).click());
      await phone('plus', () => bar.getByRole('button', { name: 'New entry' }).click());
      await phonePage.keyboard.press('Escape');
      await phone('today', async () => {
        await bar.getByRole('button', { name: 'Planner' }).click();
        await openPlannerScreen(phonePage, 'today');
      });
      await phone('calendar', () => openPlannerScreen(phonePage, 'calendar'));
      await phone('health', () => phonePage.locator('#ParvanePlanner').locator('header').getByText('Health', { exact: true }).first().click());
      await phone('quick', async () => {
        await bar.getByRole('button', { name: 'New entry' }).click();
        await phonePage.locator('#planner-quick-input').fill('урок вт 15:00 каждую неделю 5 мес');
      });
      await phonePage.keyboard.press('Escape');
      await phone('knowledge', () => bar.getByRole('button', { name: 'Knowledge' }).click());
      await phone('files', () => phonePage.getByRole('tab', { name: 'Files' }).first().click());
      console.log(`OK: снимки ${scheme} / ${mode}`);
      await phoneContext.close();
    }
  }
  console.log('e2e_web_theme_shots: OK');
} finally {
  await browser.close();
}
