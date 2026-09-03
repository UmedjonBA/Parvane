// Читалка отчётов «Report a Bug» (web/telegram-tt, util/parvaneDiag): отчёты
// уходят ОБЫЧНЫМ E2E-сообщением с JSON-вложением на аккаунт bugs@server, поэтому
// читать их может только устройство этого аккаунта. Это устройство — ПЕРСИСТЕНТНЫЙ
// профиль Chromium в local-workdirs/demos/bugs-reader/ (создаётся первым запуском;
// каталог вне git). Терять профиль нельзя — старые отчёты на новом устройстве
// не расшифруются (E2E честный).
//
//   node scripts/bugs_reader.mjs login   # зарегистрировать/войти, прогреть прекеи
//   node scripts/bugs_reader.mjs read    # выгрузить отчёты в local-workdirs/demos/bugs-reader/reports/
//
// env: PARVANE_E2E_BASE_URL, PARVANE_E2E_GATEWAY_URL, PARVANE_E2E_HTTP_USER/PASS
// (basic-auth сайта), PARVANE_BUGS_USER (default bugs@server), PARVANE_BUGS_PASS.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';
import { LOGIN_TIMEOUT_MS } from './e2e_web_helpers.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PROFILE_DIR = path.join(ROOT, 'local-workdirs/demos/bugs-reader/profile');
const REPORTS_DIR = path.join(ROOT, 'local-workdirs/demos/bugs-reader/reports');
const mode = process.argv[2] || 'read';
const bugsUser = process.env.PARVANE_BUGS_USER || 'bugs@server';
const bugsPass = process.env.PARVANE_BUGS_PASS;
if (!bugsPass) {
  console.error('PARVANE_BUGS_PASS is required');
  process.exit(2);
}
fs.mkdirSync(PROFILE_DIR, { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const httpCredentials = process.env.PARVANE_E2E_HTTP_USER
  ? { username: process.env.PARVANE_E2E_HTTP_USER, password: process.env.PARVANE_E2E_HTTP_PASS || '' }
  : undefined;
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  httpCredentials, acceptDownloads: true, viewport: { width: 1280, height: 800 },
});
context.setDefaultNavigationTimeout(120000);
try {
  const page = await loginPersistent(context, bugsUser, bugsPass);
  await page.waitForTimeout(20000); // первичный sync (прод медленный)
  if (process.env.PARVANE_BUGS_DEBUG) {
    const lines = await page.evaluate(() => (JSON.parse(localStorage.getItem('parvane:diag:v1') || '[]')).filter((e) => e.k === 'log' || /err/.test(e.k) || /fetchChats/.test(e.d || '')).slice(-14).map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.k} ${(e.d || '').slice(0, 140)}`));
    console.error(lines.join('\n'));
  }
  if (mode === 'login') {
    console.log(`[bugs-reader] вошли как ${bugsUser}; профиль: ${PROFILE_DIR}`);
  } else {
    const chats = page.locator('#LeftColumn .chat-list .ListItem.Chat');
    const count = await chats.count();
    console.log(`[bugs-reader] чатов: ${count}`);
    for (let i = 0; i < count; i++) {
      const item = chats.nth(i);
      const title = (await item.locator('.title').first().innerText().catch(() => `chat-${i}`)).trim();
      await item.click();
      await page.locator('.MessageList').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await page.waitForTimeout(2500);
      const texts = await page.locator('.MessageList .Message .text-content').allInnerTexts();
      const reports = texts.filter((t) => /🐞|probe report|report/i.test(t));
      console.log(`\n== ${title}: сообщений ${texts.length}, отчётов ${reports.length}`);
      reports.forEach((t) => console.log(`  ${t.replace(/\s+/g, ' ').slice(0, 300)}`));
      // Файлы — через хук приложения (mediaLoader + blobcrypt), а не клик:
      // браузерное скачивание в headless не ловится
      const docs = await page.evaluate(async () => {
        const g = window.__parvaneGetGlobal?.();
        const tab = Object.values(g?.byTabId || {})[0];
        const chatId = tab?.messageLists?.[0]?.chatId;
        const byId = g?.messages?.byChatId?.[chatId]?.byId || {};
        const out = [];
        for (const m of Object.values(byId)) {
          const name = m.content?.document?.fileName;
          if (!name || !name.startsWith('parvane-bug-')) continue;
          try {
            out.push({ name, text: await window.__parvaneDiagReadDocument(chatId, m.id) });
          } catch (e) {
            out.push({ name, error: String(e) });
          }
        }
        return out;
      });
      for (const doc of docs) {
        const dest = path.join(REPORTS_DIR, `${title.replace(/[^\w.@-]+/g, '_')}-${doc.name}`);
        if (!doc.text) {
          console.log(`  ! не прочитался: ${doc.name} ${doc.error || ''}`);
          continue;
        }
        if (fs.existsSync(dest)) continue;
        fs.writeFileSync(dest, doc.text);
        console.log(`  + ${dest}`);
      }
    }
  }
} finally {
  await context.close();
}

// Свой логин (а не preparePage): общий хелпер требует «ровно один сокет» и
// свежий localStorage, что для персистентного профиля с ключами неверно
async function loginPersistent(ctx, user, password) {
  const baseUrl = process.env.PARVANE_E2E_BASE_URL;
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  if (!baseUrl || !gatewayUrl) throw new Error('PARVANE_E2E_BASE_URL/GATEWAY_URL are required');
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.addInitScript(({ gw }) => { localStorage.setItem('parvane:gateway', gw); }, { gw: gatewayUrl });
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Address (user@server)');
  await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await addressInput.fill(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return page;
}
