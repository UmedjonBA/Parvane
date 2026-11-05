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
import { randomBytes } from 'node:crypto';
import { dismissRecoveryKeyDialog, LOGIN_TIMEOUT_MS } from './e2e_web_helpers.mjs';
import { botConfirmV2 } from './e2e_tg_confirm_v2.mjs';

// Прод (с 4 ноя 2026): аккаунт bugs@<домен сервера> заводится режимом `register` (подтверждение «ботом» по
// PARVANE_TELEGRAM_SECRET сервера); пароль и ключ восстановления — в credentials-v2.txt рядом с профилем (вне git).
// Прежний профиль `profile` (v1, сентябрь 2026) не трогается.
const ROOT = new URL('..', import.meta.url).pathname;
const BASE_DIR = path.join(ROOT, 'local-workdirs/demos/bugs-reader');
const PROFILE_DIR = process.env.PARVANE_BUGS_PROFILE || path.join(BASE_DIR, 'profile-v2');
const REPORTS_DIR = path.join(BASE_DIR, 'reports');
const CREDENTIALS = path.join(BASE_DIR, 'credentials-v2.txt');
const mode = process.argv[2] || 'read';
const bugsUser = process.env.PARVANE_BUGS_USER || 'bugs@server';
const bugsPass = process.env.PARVANE_BUGS_PASS
  || (mode === 'register' ? `Pv1-${randomBytes(12).toString('hex')}` : undefined);
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
  const page = mode === 'register'
    ? await registerPersistent(context, bugsUser.split('@')[0], bugsPass)
    : await loginPersistent(context, bugsUser, bugsPass);
  await page.waitForTimeout(20000); // первичный sync (прод медленный)
  if (process.env.PARVANE_BUGS_DEBUG) {
    const lines = await page.evaluate(() => (JSON.parse(localStorage.getItem('parvane:diag:v2') || '[]')).filter((e) => e.k === 'log' || /err/.test(e.k) || /fetchChats/.test(e.d || '')).slice(-14).map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.k} ${(e.d || '').slice(0, 140)}`));
    console.error(lines.join('\n'));
  }
  if (mode === 'login' || mode === 'register') {
    console.log(`[bugs-reader] вошли как ${bugsUser}; профиль: ${PROFILE_DIR}`);
  } else {
    await page.screenshot({ path: path.join(BASE_DIR, 'reader-last.png') }).catch(() => undefined);
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
      // Прод не выставляет глобальное состояние (WEB-09): чат — из адреса страницы, сообщения — из ленты;
      // вложение читает хук отчётов (`__parvaneDiagReadDocument`, есть и в проде, только свои документы)
      const docs = await page.evaluate(async () => {
        const chatId = decodeURIComponent(window.location.hash.slice(1)).split('_')[0];
        const ids = [...document.querySelectorAll('.MessageList .Message[id^="message-"]')]
          .map((el) => Number(el.id.replace(/^message-/, '')))
          .filter((id) => Number.isFinite(id));
        const out = [];
        for (const id of ids) {
          try {
            const text = await window.__parvaneDiagReadDocument?.(chatId, id);
            if (text) out.push({ name: `parvane-bug-${id}.json`, text });
          } catch (e) {
            out.push({ name: `message-${id}`, error: String(e) });
          }
        }
        return out;
      });
      for (const doc of docs) {
        // имя вложения задаёт отправитель: только basename и безопасные символы, путь не выходит из REPORTS_DIR
        const safeName = path.basename(String(doc.name)).replace(/[^\w.@-]+/g, '_');
        const dest = path.join(REPORTS_DIR, `${title.replace(/[^\w.@-]+/g, '_')}-${safeName}`);
        if (!path.resolve(dest).startsWith(path.resolve(REPORTS_DIR) + path.sep)) continue;
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
  const addressInput = addressScreen.getByLabel('Nickname');
  // Профиль уже вошёл — повторный вход не нужен
  const signedIn = await Promise.race([
    page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).then(() => true),
    addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).then(() => false),
  ]);
  if (signedIn) return page;
  await addressInput.fill(user);
  await addressScreen.getByRole('button', { name: 'Next' }).click();
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(password);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return page;
}

// Регистрация аккаунта-получателя (прод: подтверждение через Telegram-бота — здесь «ботом» по секрету сервера)
async function registerPersistent(ctx, nick, password) {
  const baseUrl = process.env.PARVANE_E2E_BASE_URL;
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  const secret = process.env.PARVANE_TELEGRAM_SECRET;
  if (!baseUrl || !gatewayUrl || !secret) throw new Error('PARVANE_E2E_BASE_URL/GATEWAY_URL и PARVANE_TELEGRAM_SECRET обязательны');
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const start = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await start.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let i = 0; i < 20; i++) {
    await start.getByRole('button', { name: 'Create account' }).dispatchEvent('mousedown', { button: 0 });
    const shown = await page.locator('.Transition_slide-active > #auth-registration-form')
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
    if (shown) break;
  }
  const form = page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(nick);
  await form.locator('#sign-up-parvane-password').fill(password);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const token = /start=([A-Za-z0-9_-]+)/.exec(await link.getAttribute('href') || '')?.[1];
  if (!token) throw new Error('нет ссылки на бота');
  // Telegram-id из диапазона, которого у настоящих пользователей нет (как у дыма прода)
  const tg = 9_100_000_000_000 + (Date.now() % 1_000_000_000);
  const ok = await botConfirmV2(gatewayUrl, secret, token, tg, `tg${tg}`);
  if (!ok.ok) throw new Error(`подтверждение: ${JSON.stringify(ok)}`);
  // Ключ восстановления с spec 015 уходит в Telegram (у получателя Telegram-id тестовый) — на экране его нет:
  // профиль profile-v2 — единственное устройство, его потеря = новый аккаунт и непрочитанные старые отчёты
  const recovery = await dismissRecoveryKeyDialog(page, 10000);
  const keyNote = recovery ? recovery.replace(/\s+/g, ' ').trim() : 'нет (ключ уходит в Telegram)';
  fs.writeFileSync(CREDENTIALS, `user=${ok.user}\npass=${password}\nrecovery=${keyNote}\n`, { mode: 0o600 });
  console.log(`[bugs-reader] зарегистрирован ${ok.user}; пароль и ключ восстановления — ${CREDENTIALS}`);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return page;
}
