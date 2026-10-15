// Список чатов после перезагрузки (жалоба 15 окт 2026: «иногда очень долгая загрузка, пару раз обновляю — потом
// появляются чаты»). Два пользователя с перепиской и группой, затем у первого N перезагрузок подряд в Chromium и
// Firefox: время от перезагрузки до первой строки списка чатов. Список не появился за `PARVANE_E2E_RELOAD_WAIT_MS`
// — печатаем состояние клиента и журнал провайдера и считаем перезагрузку зависшей; сценарий падает, если такие были.
// Запуск: PARVANE_E2E_RELOADS=20 PARVANE_E2E_BROWSERS=chromium,firefox scripts/run_web_reload_chats_e2e.sh
import { chromium, firefox } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  createGroupViaUi, dumpDiagJournal, exchangeMessages, preparePage, reloadPage, showChatList,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-reload-chats-1';
const RELOADS = Number(process.env.PARVANE_E2E_RELOADS) || 20;
const WAIT_MS = Number(process.env.PARVANE_E2E_RELOAD_WAIT_MS) || 30000;
const BROWSERS = (process.env.PARVANE_E2E_BROWSERS || 'chromium,firefox').split(',');
const ENGINES = { chromium, firefox };

const chatRow = (page) => page.locator('#LeftColumn .chat-list .ListItem.Chat').first();

async function clientState(page) {
  return page.evaluate(() => {
    const global = window.__parvaneGetGlobal?.();
    return {
      auth: global?.auth?.state,
      connection: global?.connectionState,
      isSynced: global?.isSynced,
      isSyncing: global?.isSyncing,
      activeIds: global?.chats?.listIds?.active?.length,
      isFullyLoaded: global?.chats?.isFullyLoaded?.active,
      sockets: globalThis.__parvaneE2eSockets
        ? { opened: globalThis.__parvaneE2eSockets.opened, closed: globalThis.__parvaneE2eSockets.closed }
        : undefined,
    };
  }).catch((e) => ({ error: e.message }));
}

const summary = [];
let hangs = 0;
for (const name of BROWSERS) {
  const browser = await ENGINES[name].launch();
  try {
    const stamp = Date.now().toString(36);
    const aAddress = `rl-a-${name.slice(0, 2)}-${stamp}@local`;
    const bAddress = `rl-b-${name.slice(0, 2)}-${stamp}@local`;
    const aContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const bContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const a = await preparePage(aContext, aAddress, PASSWORD);
    const b = await preparePage(bContext, bAddress, PASSWORD);
    await exchangeMessages(a.page, aAddress, b.page, bAddress, stamp);
    await showChatList(a.page);
    await createGroupViaUi(a.page, `rl-group-${stamp}`, [bAddress.split('@')[0]]);
    await showChatList(a.page);
    await chatRow(a.page).waitFor({ state: 'visible', timeout: WAIT_MS });

    const times = [];
    for (let i = 1; i <= RELOADS; i++) {
      a.logs.length = 0;
      const started = Date.now();
      await reloadPage(a.page);
      try {
        await chatRow(a.page).waitFor({ state: 'visible', timeout: WAIT_MS });
        times.push(Date.now() - started);
      } catch {
        hangs += 1;
        times.push(-1);
        console.error(`[reload] ${name} #${i}: список чатов не появился за ${WAIT_MS} мс`);
        console.error(`[reload] состояние: ${JSON.stringify(await clientState(a.page))}`);
        console.error(`--- журнал провайдера ---\n${a.logs.join('\n')}`);
        await dumpDiagJournal(a.page, `${name} #${i}`, 80);
        await a.page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR || '/tmp'}/reload-${name}-${i}.png` })
          .catch(() => undefined);
      }
    }
    // Вторая вкладка того же профиля: синк ведёт только главная вкладка (multitab tt)
    const tabSteps = [];
    const waitTab = async (page, label) => {
      const started = Date.now();
      try {
        await chatRow(page).waitFor({ state: 'visible', timeout: WAIT_MS });
        tabSteps.push(`${label}:${Date.now() - started}`);
      } catch {
        hangs += 1;
        tabSteps.push(`${label}:HANG`);
        console.error(`[reload] ${name} ${label}: список чатов не появился за ${WAIT_MS} мс`);
        console.error(`[reload] состояние: ${JSON.stringify(await clientState(page))}`);
        await page.screenshot({ path: `${process.env.PARVANE_E2E_SHOT_DIR || '/tmp'}/reload-${name}-${label}.png` })
          .catch(() => undefined);
      }
    };
    const second = await aContext.newPage();
    await second.goto(process.env.PARVANE_E2E_BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitTab(second, 'tab2-open');
    await reloadPage(a.page);
    await waitTab(a.page, 'tab1-reload');
    await reloadPage(second);
    await waitTab(second, 'tab2-reload');
    await second.close();
    await reloadPage(a.page);
    await waitTab(a.page, 'tab1-after-close');
    const third = await aContext.newPage();
    await a.page.close();
    await third.goto(process.env.PARVANE_E2E_BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitTab(third, 'tab3-after-first-closed');
    await third.reload({ waitUntil: 'domcontentloaded' });
    await waitTab(third, 'tab3-reload');

    const ok = times.filter((t) => t >= 0).sort((x, y) => x - y);
    summary.push({
      browser: name,
      reloads: RELOADS,
      hangs: times.filter((t) => t < 0).length,
      medianMs: ok[Math.floor(ok.length / 2)],
      maxMs: ok[ok.length - 1],
      all: times.join(' '),
      tabs: tabSteps.join(' '),
    });
    await aContext.close();
    await bContext.close();
  } finally {
    await browser.close();
  }
}
console.log('[reload]');
console.table(summary);
if (hangs) {
  console.error(`e2e_web_reload_chats: зависших перезагрузок ${hangs}`);
  process.exit(1);
}
console.log('e2e_web_reload_chats: OK');
