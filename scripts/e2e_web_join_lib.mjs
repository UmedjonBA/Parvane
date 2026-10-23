// Общее для сценариев «новое устройство получает всё сразу» (web — e2e_web_join_completeness.mjs, Android —
// e2e_protocol_join_android.mjs): регистрация с подтверждением «ботом», ответы бота, первое устройство с перепиской,
// группой, каналом, «Планом» и «Облаком», проверки через диагностические вызовы провайдера.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LOGIN_TIMEOUT_MS, createGroupViaUi, findMessage, openGroupChatByTitle, openPrivateChatStrict, requireEnv, sendText,
  submitNick,
} from './e2e_web_helpers.mjs';
import { botConfirmV2, botPullV2, botReplyV2 } from './e2e_tg_confirm_v2.mjs';

export const PASSWORD = 'Parvane-join-complete-1';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
assert(SECRET && process.env.PARVANE_TELEGRAM_BOT, 'PARVANE_TELEGRAM_BOT/SECRET are required');
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
export const TG_ALICE = 6101;
export const TG_BOB = 6102;
export const WIDE = { width: 1440, height: 900 };
export const STEP_TIMEOUT_MS = 30000;
export const JOIN_TIMEOUT_MS = 90000;
// «Сразу»: всё, что было на прежних устройствах, — не позже этого срока после готовности нового
export const FAST_MS = Number(process.env.PARVANE_E2E_JOIN_FAST_MS) || 20000;
// После входа устройство не должно публиковать оффер привязки — смотрим журнал identity столько
const NO_OFFER_WATCH_MS = 12000;
const KEY_PATTERN = /([0-9A-Z]{4}(?:-[0-9A-Z]{4}){9})/;

export const { baseUrl, gatewayUrl } = requireEnv();

export { botReplyV2, LOGIN_TIMEOUT_MS };

// ── вход и бот ─────────────────────────────────────────────────────────────

export async function openStartPage(context) {
  const page = await context.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[parvane]')) {
      logs.push(`${new Date().toISOString().slice(11, 23)} ${text.slice(0, 300)}`);
      if (logs.length > 800) logs.shift();
    }
  });
  await page.addInitScript((url) => {
    localStorage.setItem('parvane:gateway', url);
  }, gatewayUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const startScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  await startScreen.getByLabel('Nickname').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return { page, errors, logs, startScreen, context };
}

export async function pressAuthButton(page, screen, name, targetScreenId) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await screen.getByRole('button', { name }).dispatchEvent('mousedown', { button: 0 });
    try {
      await page.locator(`.Transition_slide-active > ${targetScreenId}`).waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
  }
}

export function hasLog(session, pattern) {
  return session.logs.some((line) => pattern.test(line));
}

export async function waitLog(session, pattern, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (!hasLog(session, pattern)) {
    assert(Date.now() < deadline, `нет строки ${pattern} за ${timeout} мс:\n${session.logs.slice(-25).join('\n')}`);
    await session.page.waitForTimeout(250);
  }
}

/** Сообщения бота для одного владельца: забираем и сразу подтверждаем доставку. */
export async function pullFor(telegramId, kind, timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const messages = await botPullV2(gatewayUrl, SECRET, [], 2000);
    const mine = messages.filter((m) => m.telegramId === telegramId && m.kind === kind);
    if (messages.length) await botPullV2(gatewayUrl, SECRET, messages.map((m) => m.id), 0);
    if (mine.length) return mine;
    assert(Date.now() < deadline, `бот не получил сообщение «${kind}» для ${telegramId}`);
  }
}

export async function register(context, nick, telegramId) {
  const session = await openStartPage(context);
  const { page, startScreen } = session;
  await pressAuthButton(page, startScreen, 'Create account', '#auth-registration-form');
  const form = page.locator('.Transition_slide-active > #auth-registration-form');
  await form.locator('#sign-up-parvane-nick').fill(nick);
  await form.locator('#sign-up-parvane-password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Create account' }).click();
  const link = page.locator('.Transition_slide-active > #auth-telegram-form #auth-telegram-link');
  await link.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const token = /start=([A-Za-z0-9_-]+)$/.exec(await link.getAttribute('href'))[1];
  const confirm = await botConfirmV2(gatewayUrl, SECRET, token, telegramId, `tg${telegramId}`);
  assert.equal(confirm.ok, true, `подтверждение: ${JSON.stringify(confirm)}`);
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const [message] = await pullFor(telegramId, 'key');
  assert.match(message.recoveryKey, KEY_PATTERN, `${nick}: бот получил не ключ`);
  await waitLog(session, /v2: готов/, LOGIN_TIMEOUT_MS);
  return { ...session, key: message.recoveryKey, address: `${nick}@local`, label: nick };
}

/** Новое устройство: ник и пароль, устройство ждёт привязки. */
export async function login(context, nick, label) {
  const session = await openStartPage(context);
  const { page } = session;
  await submitNick(page, nick);
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await passwordScreen.getByRole('button', { name: 'Next' }).click();
  await page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitLog(session, /у аккаунта уже есть журнал устройств|нужна линковка/, LOGIN_TIMEOUT_MS);
  return { ...session, address: `${nick}@local`, label };
}

// ── состояние для проверок (диагностическая сборка) ─────────────────────────

export async function callApi(page, method, args, timeoutMs = 0) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, { timeout: LOGIN_TIMEOUT_MS });
  const call = page.evaluate(([m, a]) => window.__parvaneDiagCallApi(m, a), [method, args]);
  if (!timeoutMs) return call;
  return Promise.race([call, new Promise((resolve) => { setTimeout(() => resolve(undefined), timeoutMs); })]);
}

/** Что видит устройство без открытия чатов: названия чатов, задачи «Плана», имена узлов «Облака». */
export async function readSections(page) {
  const titles = await page.evaluate(() => {
    const global = window.__parvaneGetGlobal?.();
    return global ? Object.values(global.chats.byId).map((chat) => chat.title).filter(Boolean) : [];
  });
  const planner = await callApi(page, 'parvanePlannerState', undefined, 3000).catch(() => undefined);
  const tasks = (planner?.state?.tasks || []).map((t) => t.name);
  const cloud = await callApi(page, 'parvaneCloudState', undefined, 3000).catch(() => undefined);
  const nodes = Object.values(cloud?.trees || {})
    .flatMap((tree) => tree?.nodes || [])
    .filter((node) => node?.name && !node.trashed)
    .map((node) => node.name);
  return { titles, tasks, nodes };
}

export function missingOf(seen, expected) {
  return [
    ...expected.titles.filter((title) => !seen.titles.includes(title)).map((title) => `чат «${title}»`),
    ...expected.tasks.filter((task) => !seen.tasks.includes(task)).map((task) => `задача «${task}»`),
    ...expected.nodes.filter((node) => !seen.nodes.includes(node)).map((node) => `облако «${node}»`),
  ];
}

export function failSlow(session, readyAt, what) {
  assert.fail(`${session.label}: через ${Math.round((Date.now() - readyAt) / 1000)} с после входа нет: ${what}\n`
    + `${session.logs.slice(-30).join('\n')}`);
}

/** Сообщения чата видны в ленте — в пределах общего срока. */
export async function expectChatTexts(session, open, texts, readyAt) {
  if (process.env.PARVANE_E2E_JOIN_DEBUG) await sampleChats(session, texts);
  await open();
  for (const text of texts) {
    const left = Math.max(1000, readyAt + FAST_MS - Date.now());
    try {
      await findMessage(session.page, text).first().waitFor({ state: 'visible', timeout: left });
    } catch {
      failSlow(session, readyAt, `сообщение «${text}»`);
    }
  }
}

/** Всё прежнее — на новом устройстве не позже FAST_MS после его готовности. */
export async function expectEverythingFast(session, expected, readyAt) {
  const stages = [];
  const mark = (name) => stages.push(`${name} ${((Date.now() - readyAt) / 1000).toFixed(1)} с`);
  for (;;) {
    const missing = missingOf(await readSections(session.page), expected);
    if (!missing.length) break;
    if (Date.now() - readyAt > FAST_MS) failSlow(session, readyAt, missing.join(', '));
    await session.page.waitForTimeout(500);
  }
  mark('чаты, «План», «Облако»');
  await expectChatTexts(session, () => openPrivateChatStrict(session.page, expected.peer), expected.dmTexts, readyAt);
  mark('личный чат');
  await expectChatTexts(session, () => openGroupChatByTitle(session.page, expected.titles[0]), expected.groupTexts, readyAt);
  mark('группа');
  await expectChatTexts(session, () => openGroupChatByTitle(session.page, expected.titles[1]), expected.channelTexts, readyAt);
  mark('канал');
  const elapsed = Date.now() - readyAt;
  // Каждый шаг ждёт не дольше остатка срока, но открытие чатов тоже занимает время — итог проверяется отдельно
  assert(elapsed <= FAST_MS + 5000, `${session.label}: всё прежнее видно только через ${(elapsed / 1000).toFixed(1)} с `
    + `(${stages.join(', ')})\n${session.logs.slice(-30).join('\n')}`);
  console.log(`OK: ${session.label} — всё прежнее видно через ${(elapsed / 1000).toFixed(1)} с после входа (${stages.join(', ')})`);
}

// ── сервер: офферы привязки после входа ─────────────────────────────────────

export function identityLog() {
  try {
    return readFileSync(join(BACKEND_DIR, 'identity.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  } catch {
    return '';
  }
}

export function offerCount(address) {
  return identityLog().split('\n').filter((line) => line.includes(`${address} опубликовал оффер линковки`)).length;
}

/** После входа нового устройства: сервер не получает новых офферов, другие устройства запроса не видят. */
export async function expectNoOfferAfterJoin(session, address, others) {
  const before = offerCount(address);
  await session.page.waitForTimeout(NO_OFFER_WATCH_MS);
  const after = offerCount(address);
  assert.equal(after, before, `${session.label}: после входа опубликовано офферов привязки: ${after - before}`);
  for (const other of others) {
    const offers = await callApi(other.page, 'parvaneListLinkOffers');
    assert.equal(offers?.offers?.length || 0, 0, `${other.label} видит запрос привязки уже вошедшего устройства: ${JSON.stringify(offers)}`);
  }
  console.log(`OK: ${session.label} — после входа запроса привязки нет (сервер и ${others.length} других устройств)`);
}

export async function expectJoinState(session, state) {
  const status = await callApi(session.page, 'parvaneGetLinkStatus');
  assert.equal(status?.telegram, state, `${session.label}: состояние входа ${JSON.stringify(status)}`);
  assert(!hasLog(session, /вход не удался|привязка не удалась/), `${session.label}: в журнале отказ входа:\n${session.logs.slice(-30).join('\n')}`);
  assert.equal(status?.canRecover, false, `${session.label}: после входа устройство всё ещё ждёт привязки`);
}

// ── способы входа ───────────────────────────────────────────────────────────

export async function joinByTelegram(session, key) {
  await pullFor(TG_ALICE, 'ask');
  const accepted = await botReplyV2(gatewayUrl, SECRET, TG_ALICE, key);
  assert.equal(accepted.result, 'ok', JSON.stringify(accepted));
  await waitLog(session, /устройство привязано ключом восстановления/, JOIN_TIMEOUT_MS);
  await waitLog(session, /v2: готов/, JOIN_TIMEOUT_MS);
  const readyAt = Date.now();
  // Состояние «готово» ставится после применения копии — ждём его недолго
  const deadline = Date.now() + 5000;
  while ((await callApi(session.page, 'parvaneGetLinkStatus'))?.telegram !== 'done' && Date.now() < deadline) {
    await session.page.waitForTimeout(250);
  }
  return readyAt;
}

export async function joinByTypedKey(session, key) {
  // Бот тоже спросил ключ — просьбу забираем, отвечать не будем
  await pullFor(TG_ALICE, 'ask');
  const typed = ` ${key.toLowerCase().replace(/-/g, ' ')} `;
  const result = await callApi(session.page, 'parvaneRecoverWithKey', { recoveryKey: typed });
  assert.equal(result, 'ok', `${session.label}: ввод ключа руками → ${result}`);
  await waitLog(session, /v2: готов/, JOIN_TIMEOUT_MS);
  return Date.now();
}

export async function createChannel(page, title, memberName) {
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Channel' }).click();
  const search = page.locator('#new-group-picker-search');
  await search.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await search.fill(memberName);
  const row = page.locator('#LeftColumn .PeerPickerItem, #LeftColumn .ItemPickerItem').filter({ hasText: memberName }).first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6 && !(await row.locator('input[type="checkbox"]:checked').count()); attempt++) {
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.locator('#LeftColumn .FloatingActionButton').click();
  const name = page.locator('#LeftColumn .input-group:has(label:has-text("Channel name")) input');
  await name.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await name.fill(title);
  await page.getByRole('button', { name: 'Create Channel', exact: true }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

/** Ждём, пока устройство запишет копию ключей аккаунта после всего, что уже сделано. */
export async function waitBundleWrite(session, timeout = 150000, before = undefined) {
  const count = () => session.logs.filter((line) => line.includes('копия ключей аккаунта обновлена')).length;
  const from = before ?? count();
  const deadline = Date.now() + timeout;
  while (count() === from) {
    assert(Date.now() < deadline, `${session.label}: копия ключей аккаунта не обновилась:\n${session.logs.slice(-20).join('\n')}`);
    await session.page.waitForTimeout(1000);
  }
}

/** Первое устройство Алисы и Боб: переписка, группа и канал с сообщениями, задача «Плана», папка и файл «Облака».
 * Возвращает сессии и то, что новое устройство обязано увидеть сразу. */
export async function seedAccount(browser, suffix) {
  const sessions = {};
  const aliceNick = `jc-a-${suffix}`;
  const bobNick = `jc-b-${suffix}`;
  // ── Первое устройство Алисы и Боб: всё, что новое устройство обязано увидеть сразу ──
  const alice1Context = await browser.newContext({ viewport: WIDE });
  const alice1 = await register(alice1Context, aliceNick, TG_ALICE);
  alice1.label = 'alice1';
  sessions.alice1 = alice1;
  const bob = await register(await browser.newContext({ viewport: WIDE }), bobNick, TG_BOB);
  bob.label = 'bob';
  sessions.bob = bob;

  const fromAlice = `dm-alice-${suffix}`;
  const fromBob = `dm-bob-${suffix}`;
  await openPrivateChatStrict(alice1.page, bob.address);
  await sendText(alice1.page, fromAlice);
  await openPrivateChatStrict(bob.page, alice1.address);
  await findMessage(bob.page, fromAlice).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bob.page, fromBob);
  await findMessage(alice1.page, fromBob).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const groupTitle = `JC Group ${suffix}`;
  const groupFromAlice = `grp-alice-${suffix}`;
  const groupFromBob = `grp-bob-${suffix}`;
  await createGroupViaUi(alice1.page, groupTitle, [bobNick]);
  await openGroupChatByTitle(alice1.page, groupTitle);
  await sendText(alice1.page, groupFromAlice);
  await openGroupChatByTitle(bob.page, groupTitle);
  await findMessage(bob.page, groupFromAlice).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bob.page, groupFromBob);
  await findMessage(alice1.page, groupFromBob).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  const channelTitle = `JC Channel ${suffix}`;
  const channelPost = `post-${suffix}`;
  await createChannel(alice1.page, channelTitle, bobNick);
  await sendText(alice1.page, channelPost);

  const taskName = `jc-task-${suffix}`;
  await callApi(alice1.page, 'parvanePlannerState');
  await callApi(alice1.page, 'parvanePlannerApply', {
    changes: [{
      task: {
        id: `jc-${suffix}`, name: taskName, description: '', steps: [], status: 'queue', listId: '',
        rank: 1000, day: '', start: '', due: '', minutes: null,
      },
    }],
  });
  await callApi(alice1.page, 'parvanePlannerFlush');

  const folderName = `jc-folder-${suffix}`;
  const fileName = `jc-note-${suffix}.md`;
  await callApi(alice1.page, 'parvaneCloudState');
  const folder = await callApi(alice1.page, 'parvaneCloudApply', {
    container: 'root',
    ops: [{ op: 'create', id: randomBytes(16).toString('hex'), kind: 'folder', name: folderName }],
  });
  assert.equal(folder?.ok, true, `папка облака: ${JSON.stringify(folder)}`);
  const file = await callApi(alice1.page, 'parvaneCloudWriteText', { container: folder.container, name: fileName, text: '# Join' });
  assert.equal(file?.ok, true, `файл облака: ${JSON.stringify(file)}`);

  const expected = {
    peer: bob.address,
    titles: [groupTitle, channelTitle],
    dmTexts: [fromAlice, fromBob],
    groupTexts: [groupFromAlice, groupFromBob],
    channelTexts: [channelPost],
    tasks: [taskName],
    nodes: [folderName, fileName],
  };
  // Первое устройство само видит всё (иначе проверка ниже ничего не значит)
  await expectEverythingFast(alice1, expected, Date.now());
  await waitBundleWrite(alice1);
  console.log('OK: на первом устройстве — переписка, группа, канал, «План», «Облако»; копия ключей аккаунта на сервере');

  return { alice1, bob, aliceNick, bobNick, expected, sessions };
}

/** Диагностика (PARVANE_E2E_JOIN_DEBUG=1): где лежат тексты — в global (по чатам) и в кэше истории провайдера. */
async function sampleChats(session, texts) {
  for (let i = 0; i < 14; i++) {
    const info = await session.page.evaluate((wanted) => {
      const global = window.__parvaneGetGlobal?.();
      if (!global) return 'нет global';
      const chats = Object.values(global.chats.byId).map((chat) => {
        const byId = global.messages.byChatId[chat.id]?.byId || {};
        const all = Object.values(byId).map((m) => m.content?.text?.text).filter(Boolean);
        return `${chat.title || chat.id}:${all.length}${wanted.some((w) => all.includes(w)) ? '*' : ''}`;
      });
      const listed = (global.chats.listIds?.active || []).length;
      return `чатов ${chats.length}, в списке ${listed}: ${chats.join(' | ')}`;
    }, texts).catch((e) => `ошибка ${String(e)}`);
    console.log(`[join-debug] ${session.label} +${i * 5} с: ${info}`);
    if (info.includes('*')) return;
    await session.page.waitForTimeout(5000);
  }
}
