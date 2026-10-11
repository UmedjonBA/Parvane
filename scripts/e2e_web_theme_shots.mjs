// Снимки экранов в тёмной и светлой теме выбранной цветовой схемы — для проверки глазами (spec 019).
// Ничего не утверждает, кроме того, что экраны открываются. Снимки — в PARVANE_E2E_SHOT_DIR.
// Запуск: PARVANE_E2E_SHOT_DIR=<каталог> scripts/run_web_theme_shots_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { dismissRecoveryKeyDialog, preparePage, sendText } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-theme-e2e-1';
const WIDE = { width: 1440, height: 900 };
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
      await page.locator('#LeftColumn').getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('menuitem', { name: 'Saved Messages' }).click();
      await page.locator('#MiddleColumn').getByText('Saved Messages').first().waitFor({ timeout: STEP_TIMEOUT_MS });
      await sendText(page, 'Проверка цветов: своё сообщение со ссылкой https://example.org и `кодом`');
      await sendText(page, 'Второе сообщение');
      await shot('chat');
      // «План»: запись, «Сегодня», календарь, карточка, «Здоровье»
      await sidebar.getByRole('tab', { name: 'Today' }).click();
      await planner.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      for (const line of ['созвон 16:00 45 мин', 'задача сдать отчёт до пт', 'обед гречка б30 ж10 у60 сахар 60 520 ккал', 'сон 01:00-06:00', 'вес 72,4']) {
        await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
        await page.locator('#planner-quick-input').fill(line);
        await page.locator('#planner-quick-input').press('Enter');
        await page.locator('#planner-quick-input').waitFor({ state: 'hidden', timeout: STEP_TIMEOUT_MS });
      }
      await shot('today');
      await planner.getByRole('button', { name: '+ Entry', exact: true }).click();
      await page.locator('#planner-quick-input').fill('урок вт 15:00 каждую неделю 5 мес');
      await shot('quick');
      await page.keyboard.press('Escape');
      await sidebar.getByRole('tab', { name: 'Calendar' }).click();
      await shot('calendar');
      await sidebar.getByRole('tab', { name: 'Health' }).click();
      await shot('health');
      // «Знания»: заметка и файлы
      await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
      await page.locator('#ParvaneCloud').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await shot('files');
      await page.locator('#ParvaneCloud header').getByText('Notes', { exact: true }).first().click();
      const knowledge = page.locator('#ParvaneKnowledge');
      await knowledge.getByRole('button', { name: 'New note' }).click();
      await knowledge.locator('[data-note-id]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await knowledge.getByRole('button', { name: 'Edit' }).click();
      await page.locator('#knowledge-note-editor').fill('# Заметка\n\nТекст со [[ссылкой]] и #тегом\n\n- [ ] пункт\n- [x] сделано');
      await knowledge.getByRole('button', { name: 'Save' }).click();
      await knowledge.locator('[data-note-body]').waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await shot('note');
      // Настройки: выбор схемы
      await sidebar.getByRole('button', { name: 'Profile' }).click();
      await shot('settings');
      console.log(`OK: снимки ${scheme} / ${mode}`);
      await context.close();
    }
  }
  console.log('e2e_web_theme_shots: OK');
} finally {
  await browser.close();
}
