// Замер п. 21 плана 15 окт 2026 (окно истории чата): сколько стоят перезагрузка, память и открытие чата при
// большой истории в кэше устройства. История засевается прямо в кэш (`parvaneDiagSeedHistory`, диаг-сборка).
// Печатает таблицу `[history]`; ничего не утверждает, кроме того, что чат открывается.
// Запуск: PARVANE_E2E_HISTORY_SIZES=2000,20000 scripts/run_web_history_scale_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, openSavedMessages, preparePage, relogin, showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-history-scale-1';
const SIZES = (process.env.PARVANE_E2E_HISTORY_SIZES || '2000,20000').split(',').map(Number);
const rows = [];

async function heapMb(page) {
  await page.evaluate(() => window.gc?.()).catch(() => {});
  return page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576));
}

const browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
try {
  let seeded = 0;
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const user = `hist-${size}-${Date.now().toString(36)}@local`;
    const session = await preparePage(context, user, PASSWORD);
    const { page } = session;
    await dismissRecoveryKeyDialog(page).catch(() => undefined);
    const seedStart = Date.now();
    await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function');
    await page.evaluate((count) => window.__parvaneDiagCallApi('parvaneDiagSeedHistory', { count }), size);
    seeded = Date.now() - seedStart;
    const heapBefore = await heapMb(page);
    const reloadStart = Date.now();
    await relogin(page, PASSWORD);
    await page.waitForFunction(() => window.__parvaneGetGlobal?.().isSynced, undefined, { timeout: 120000 });
    const reloadMs = Date.now() - reloadStart;
    const openStart = Date.now();
    await openSavedMessages(page);
    await page.locator('.Transition_slide-active > .MessageList .Message')
      .filter({ hasText: `история ${size - 1} ` }).first().waitFor({ state: 'visible', timeout: 120000 });
    const openMs = Date.now() - openStart;
    await page.waitForTimeout(2000);
    const heapAfter = await heapMb(page);
    rows.push({
      size, seedMs: seeded, reloadMs, openSavedMs: openMs, heapBeforeMb: heapBefore, heapAfterReloadMb: heapAfter,
    });
    await showChatList(page).catch(() => {});
    await context.close();
  }
  console.log('[history]');
  console.table(rows);
  console.log('e2e_web_history_scale: OK');
} finally {
  await browser.close();
}
