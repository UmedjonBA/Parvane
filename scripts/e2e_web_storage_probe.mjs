// Проба: после регистрации/входа — какие ключи localStorage содержат пароль
// (регрессия live-stack.spec «passwordLeaked»). Запуск:
//   PARVANE_E2E_EXTERNAL_BROWSER_SCRIPT=scripts/e2e_web_storage_probe.mjs scripts/run_web_e2e.sh
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { preparePage } from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-probe-e2e-password';
const browser = await chromium.launch();
const context = await browser.newContext();
try {
  const user = `probe-${Date.now()}@local`;
  const session = await preparePage(context, user, PASSWORD);
  await session.page.waitForTimeout(5000);
  const hits = await session.page.evaluate((password) => Object.keys(localStorage)
    .filter((key) => (localStorage.getItem(key) || '').includes(password))
    .map((key) => {
      const value = localStorage.getItem(key) || '';
      const at = value.indexOf(password);
      return `${key} :: …${value.slice(Math.max(0, at - 120), at)}[PASSWORD]…`;
    }), PASSWORD);
  console.log(`[storage-probe] keys with password: ${hits.length}`);
  hits.forEach((hit) => console.log(`[storage-probe] ${hit}`));
} finally {
  await browser.close();
}
