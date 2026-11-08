// Наполнение «всё понемногу» (spec 035, T006) для эталона «до» разового переноса: профили web с перепиской и всем
// хранимым — ТОЛЬКО выдуманные данные (правило корневого CLAUDE.md). alice — два устройства (второе привязано), bob и
// carol — собеседники. В конце — выгрузки `auditDump` каждого профиля (`parvaneAuditDump`, T007), счётчики SC-009
// (T009), выгрузка баз шардов (`scripts/migration_audit_server.py --dump`) и копия баз и профилей браузера: по ним
// T109 потом гоняет перенос (профиль T006 → новый web-dist → сверка).
//
// Шаги «мягкие»: сбой шага записывается в сводку (`seed-summary.json`) и наполнение идёт дальше — то, чего нынешний
// клиент не умеет, видно в сводке. Код 1 — если не прошли обязательные шаги (вход, переписка, выгрузки).
// Запуск: scripts/seed_everything.sh (поднимает стек и web сам); каталог выхода — PARVANE_SEED_OUT.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  addReaction,
  buildPngBuffer,
  dismissRecoveryKeyDialog,
  editText,
  exchangeMessages,
  findMessage,
  linkSecondDevice,
  LOGIN_TIMEOUT_MS,
  openPlannerScreen,
  openPrivateChatStrict,
  pinMessage,
  preparePage,
  sendText,
  showChatList,
} from './e2e_web_helpers.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = resolve(process.env.PARVANE_SEED_OUT || join(ROOT, 'local-workdirs/spec035/seed-web'));
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const PASSWORD = 'Seed-everything-2026';
const STORAGE_PIN = '73915264';
const SUFFIX = Date.now().toString(36);
const NICK = { alice: `seed-alice-${SUFFIX}`, bob: `seed-bob-${SUFFIX}`, carol: `seed-carol-${SUFFIX}` };
const ADDR = Object.fromEntries(Object.entries(NICK).map(([who, nick]) => [who, `${nick}@local`]));
const GROUP = `Выдуманный клуб ${SUFFIX}`;
const CLOUD_FOLDER = `Общая папка ${SUFFIX}`;
const PHOTO_GROUP = `Выдуманный фотоклуб ${SUFFIX}`;
const NOTE_TITLE = `Заметка о вымышленном походе ${SUFFIX}`;
const WIDE = { width: 1400, height: 900 };
// Окно пачки журнала истории в диаг-сборке (по умолчанию 1–3 с) — записи успевают уйти до выгрузок
const HISTORY_SETTLE_MS = 12000;
const REQUIRED = new Set(['вход', 'переписка 1:1', 'выгрузка alice1', 'выгрузка сервера']);

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, ms: Date.now() - started, detail: detail === undefined ? undefined : detail });
    console.log(`OK: ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - started, error: String(e?.message || e).slice(0, 600) });
    console.log(`СБОЙ: ${name}: ${String(e?.message || e).slice(0, 300)}`);
  }
}

// Вызов метода провайдера в странице: `$chat:<ник|название группы>`, `$user:<ник>`, `$msg:<текст>` (сообщение
// чата аргумента chat по тексту, id) заменяются объектами глобального состояния
async function api(page, method, ...args) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  return page.evaluate(async ({ fn, params }) => {
    const g = window.__parvaneGetGlobal();
    const userBy = (nick) => Object.values(g.users.byId)
      .find((u) => u.usernames?.some(({ username }) => username === nick) || u.firstName === nick);
    const chatBy = (name) => {
      const user = userBy(name);
      if (user && g.chats.byId[user.id]) return g.chats.byId[user.id];
      return Object.values(g.chats.byId).find((c) => c.title === name);
    };
    let chatId;
    const map = (value) => {
      if (typeof value === 'string' && value.startsWith('$chat:')) {
        const chat = chatBy(value.slice(6));
        if (!chat) throw new Error(`нет чата ${value}`);
        chatId = chat.id;
        return chat;
      }
      if (typeof value === 'string' && value.startsWith('$uid:')) {
        const user = userBy(value.slice(5));
        if (!user) throw new Error(`нет пользователя ${value}`);
        return user.id;
      }
      if (typeof value === 'string' && value.startsWith('$user:')) {
        const user = userBy(value.slice(6));
        if (!user) throw new Error(`нет пользователя ${value}`);
        return user;
      }
      if (typeof value === 'string' && value.startsWith('$msg:')) {
        const byId = g.messages.byChatId[chatId]?.byId || {};
        const found = Object.values(byId).find((m) => m.content?.text?.text === value.slice(5));
        if (!found) throw new Error(`нет сообщения «${value.slice(5)}»`);
        return found.id;
      }
      if (Array.isArray(value)) return value.map(map);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, map(v)]));
      return value;
    };
    const mapped = map(params);
    const result = await window.__parvaneDiagCallApi(fn, ...mapped);
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  }, { fn: method, params: args });
}

async function waitText(page, text, timeout = LOGIN_TIMEOUT_MS) {
  await findMessage(page, text).first().waitFor({ state: 'visible', timeout });
}

// Сообщение с текстом есть в глобальном состоянии страницы (любой чат)
async function waitGlobalText(page, text, timeout = LOGIN_TIMEOUT_MS) {
  await page.waitForFunction((needle) => {
    const g = window.__parvaneGetGlobal();
    return Object.values(g.messages.byChatId).some((chat) => Object.values(chat.byId || {})
      .some((m) => m.content?.text?.text === needle));
  }, text, { timeout });
}

// Закрыть всплывшее после сбоя прошлого шага (модальное окно, меню, правую колонку) — следующий шаг UI не упирается в него
async function resetUi(page) {
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape').catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(200);
  }
  const sidebar = page.locator('#FoldersSidebar');
  if (await sidebar.isVisible().catch(() => false)) {
    await sidebar.getByRole('tab', { name: 'Chats' }).click({ timeout: 5000 }).catch(() => undefined);
  }
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

mkdirSync(join(OUT, 'profiles'), { recursive: true });
mkdirSync(join(OUT, 'audit'), { recursive: true });
const browser = await chromium.launch();
const ctx = {};
const pages = {};
let exitCode = 0;

async function openProfile(who) {
  const dir = join(OUT, 'profiles', `web-${who}`);
  rmSync(dir, { recursive: true, force: true });
  // Профиль браузера — постоянный каталог: после выгрузок его откроет сценарий переноса (T109)
  ctx[who] = await chromium.launchPersistentContext(dir, { viewport: WIDE, acceptDownloads: true });
  return ctx[who];
}

try {
  await step('вход', async () => {
    for (const who of ['alice1', 'bob', 'carol']) {
      const user = who === 'alice1' ? ADDR.alice : ADDR[who];
      // eslint-disable-next-line no-await-in-loop
      const session = await preparePage(await openProfile(who), user, PASSWORD, {
        seedLocalStorage: { 'parvane:e2e:historyBatchMs': '1000,3000' },
      });
      pages[who] = session.page;
      // eslint-disable-next-line no-await-in-loop
      await dismissRecoveryKeyDialog(session.page).catch(() => undefined);
    }
    return ADDR;
  });
  const { alice1: a, bob: b, carol: c } = pages;

  await step('переписка 1:1', async () => {
    await exchangeMessages(a, ADDR.alice, b, ADDR.bob, `ab-${SUFFIX}`);
    await exchangeMessages(a, ADDR.alice, c, ADDR.carol, `ac-${SUFFIX}`);
    await openPrivateChatStrict(a, ADDR.bob);
    for (const text of ['Привет, это выдуманный разговор', 'Сообщение для правки', 'Сообщение удалить у всех',
      'Сообщение удалить у меня', 'Сообщение для закрепа', 'Сообщение для реакции от bob']) {
      // eslint-disable-next-line no-await-in-loop
      await sendText(a, text);
    }
    await openPrivateChatStrict(b, ADDR.alice);
    await waitText(b, 'Сообщение для реакции от bob');
    await sendText(b, 'Ответ bob о вымышленной погоде');
    await sendText(b, 'Сообщение bob для реакции alice');
    await waitText(a, 'Сообщение bob для реакции alice');
  });

  await step('правка', () => editText(a, 'Сообщение для правки', 'Сообщение после правки'));
  await step('удаление у всех', async () => {
    await api(a, 'deleteMessages', { chat: `$chat:${NICK.bob}`, messageIds: [`$msg:Сообщение удалить у всех`], shouldDeleteForAll: true });
  });
  await step('удаление у меня', async () => {
    await api(a, 'deleteMessages', { chat: `$chat:${NICK.bob}`, messageIds: [`$msg:Сообщение удалить у меня`], shouldDeleteForAll: false });
  });
  await step('реакции', async () => {
    await resetUi(a);
    await resetUi(b);
    await openPrivateChatStrict(a, ADDR.bob);
    await addReaction(a, 'Сообщение bob для реакции alice', '👍');
    await openPrivateChatStrict(b, ADDR.alice);
    await addReaction(b, 'Сообщение для реакции от bob', '👍');
  });
  await step('закреп сообщения', async () => {
    await openPrivateChatStrict(a, ADDR.bob);
    await pinMessage(a, 'Сообщение для закрепа');
  });

  await step('группа', async () => {
    await resetUi(a);
    const created = await api(a, 'createGroupChat', { title: GROUP, users: [`$user:${NICK.bob}`, `$user:${NICK.carol}`] });
    assert.ok(created, 'createGroupChat без ответа');
    await a.waitForFunction((title) => Object.values(window.__parvaneGetGlobal().chats.byId).some((ch) => ch.title === title),
      GROUP, { timeout: 60000 });
    await b.waitForFunction((title) => Object.values(window.__parvaneGetGlobal().chats.byId).some((ch) => ch.title === title),
      GROUP, { timeout: 120000 });
    await api(a, 'sendMessage', { chat: `$chat:${GROUP}`, text: 'Первое сообщение выдуманного клуба' });
    await waitGlobalText(b, 'Первое сообщение выдуманного клуба', 120000);
    await api(b, 'sendMessage', { chat: `$chat:${GROUP}`, text: 'Bob приветствует клуб' });
    await waitGlobalText(a, 'Bob приветствует клуб', 120000);
    await api(a, 'sendMessage', { chat: `$chat:${GROUP}`, text: 'Сообщение клуба удалить у всех' });
    await waitGlobalText(a, 'Сообщение клуба удалить у всех', 30000);
    await api(a, 'deleteMessages', { chat: `$chat:${GROUP}`, messageIds: ['$msg:Сообщение клуба удалить у всех'], shouldDeleteForAll: true });
  });

  // Ещё три группы — для счётчика SC-009 web (записей кэша групп на старте при N группах)
  await step('ещё группы', async () => {
    for (let i = 1; i <= 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await api(a, 'createGroupChat', { title: `${GROUP} — секция ${i}`, users: [`$user:${NICK.bob}`] });
    }
  });
  // Частная группа с ОТКРЫТЫМ фото (как до GPHOTO-1): фото ставится, пока группа публичная (открытый блоб без
  // секрета), затем группа снова частная. Разовый перенос просит админа перезалить такое фото с секретом
  // (`needs{group_avatar_reupload}`, FR-071) — это проверяет T109
  await step('открытое фото частной группы', async () => {
    await resetUi(a);
    await api(a, 'createGroupChat', { title: PHOTO_GROUP, users: [`$user:${NICK.bob}`] });
    await a.waitForFunction((title) => Object.values(window.__parvaneGetGlobal().chats.byId).some((ch) => ch.title === title),
      PHOTO_GROUP, { timeout: 60000 });
    const publicName = `seedphoto${SUFFIX}`;
    assert.ok(await api(a, 'setChatUsername', { chat: `$chat:${PHOTO_GROUP}`, username: publicName }), 'группа не стала публичной');
    const png = buildPngBuffer(64, [0x45, 0x85, 0x88]).toString('base64');
    const photo = await a.evaluate(async ({ b64, title }) => {
      const g = window.__parvaneGetGlobal();
      const chat = Object.values(g.chats.byId).find((ch) => ch.title === title);
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const file = new File([bytes], 'выдуманное-фото.png', { type: 'image/png' });
      return window.__parvaneDiagCallApi('editChatPhoto', { chatId: chat.id, photo: file });
    }, { b64: png, title: PHOTO_GROUP });
    assert.ok(photo, 'фото не поставлено');
    assert.ok(await api(a, 'setChatUsername', { chat: `$chat:${PHOTO_GROUP}`, username: '' }), 'группа не стала частной');
    return PHOTO_GROUP;
  });
  await step('папка', () => api(a, 'editChatFolder', {
    id: 2,
    folderUpdate: {
      title: { text: 'Выдуманная работа', entities: [] }, emoticon: '💼', includedChatIds: [`$uid:${NICK.bob}`],
      excludedChatIds: [], pinnedChatIds: [], contacts: false, nonContacts: false, groups: true, channels: false, bots: false,
    },
  }));
  await step('контакт с заметкой', async () => {
    await api(a, 'updateContact', { id: `$uid:${NICK.bob}`, firstName: 'Боб', lastName: 'Вымышленный' });
    await api(a, 'updateContactNote', `$user:${NICK.bob}`, { text: 'Заметка о вымышленном знакомом', entities: [] });
  });
  await step('черновик', () => api(a, 'saveDraft', {
    chat: `$chat:${NICK.carol}`, draft: { text: { text: 'Черновик про вымышленный пикник', entities: [] } },
  }));
  await step('отложенное', () => api(a, 'sendMessage', {
    chat: `$chat:${NICK.bob}`, text: 'Отложенное выдуманное напоминание', scheduledAt: Math.floor(Date.now() / 1000) + 3 * 86400,
  }));
  await step('закреп чата', () => api(a, 'toggleChatPinned', { chat: `$chat:${NICK.bob}`, shouldBePinned: true }));
  await step('отметка «непрочитано» и мьют', async () => {
    await api(a, 'toggleDialogUnread', { chat: `$chat:${GROUP}`, hasUnreadMark: true });
    await api(a, 'updateChatNotifySettings', { chat: `$chat:${GROUP}`, settings: { mutedUntil: 2147483647 } });
  });
  await step('быстрая реакция', () => api(a, 'setDefaultReaction', { reaction: { type: 'emoji', emoticon: '🔥' } }));

  await step('«План»', async () => {
    await openPlannerScreen(a, 'calendar');
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await api(a, 'parvanePlannerApply', {
      changes: [
        { task: { id: `seed-task-${SUFFIX}`, name: 'Выдуманная задача: полить кактус', description: '', steps: [{ text: 'набрать воду', isDone: false }], status: 'queue', listId: '', rank: 1, day, start: '', due: '', minutes: 15 } },
        { event: { id: `seed-event-${SUFFIX}`, name: 'Выдуманная встреча клуба', start: '18:00', end: '19:00', day, description: '' } },
      ],
    });
    await api(a, 'parvanePlannerFlush');
    await showChatList(a).catch(() => undefined);
  });

  await step('«Облако» с совместной папкой', async () => {
    await resetUi(a);
    const ac = cloudDriver(a);
    const bc = cloudDriver(b);
    await ac.open();
    await ac.upload('список-покупок.txt', 'Выдуманный список: хлеб, сыр\n');
    await ac.add('New shared folder');
    await a.locator('#parvane-cloud-shared-name').fill(CLOUD_FOLDER);
    await a.getByRole('button', { name: 'Create', exact: true }).click();
    const share = a.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' }).filter({ hasText: CLOUD_FOLDER });
    await share.waitFor({ state: 'visible', timeout: 20000 });
    await share.locator('select[data-new-role]').selectOption({ label: 'Editor' });
    await share.getByRole('button', { name: 'Add people', exact: true }).click();
    const picker = a.locator('.Modal').filter({ has: a.locator('.ChatOrUserPicker-item') });
    await picker.locator('.ChatOrUserPicker-item').filter({ hasText: /Боб|seed-bob/ }).first().click();
    await share.locator(`[data-member="${ADDR.bob}"]`).waitFor({ state: 'visible', timeout: 20000 });
    await share.getByRole('button', { name: 'Close', exact: true }).last().click();
    await ac.folderRow(CLOUD_FOLDER).click();
    await ac.upload('маршрут.txt', 'Выдуманный маршрут похода\n');
    await ac.close();
    await bc.open();
    const invite = bc.folderRow(CLOUD_FOLDER);
    await invite.waitFor({ state: 'visible', timeout: 60000 });
    await invite.getByRole('button', { name: 'Accept', exact: true }).click();
    await bc.item('маршрут.txt').waitFor({ state: 'visible', timeout: 60000 });
    await bc.close();
  });

  await step('заметка «Знаний»', async () => {
    await resetUi(a);
    const sidebar = a.locator('#FoldersSidebar');
    await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
    const knowledge = a.locator('#ParvaneKnowledge');
    await knowledge.waitFor({ state: 'visible', timeout: 30000 });
    await knowledge.locator('[data-notes-new]').click();
    const note = knowledge.locator('[data-note-id]');
    await note.getByLabel('Note title').fill(NOTE_TITLE);
    await note.getByLabel('Note title').blur();
    await knowledge.locator(`[data-note-row="${NOTE_TITLE}"]`).first().waitFor({ state: 'visible', timeout: 30000 });
    await sidebar.getByRole('tab', { name: 'Chats' }).click();
  });

  await step('набор стикеров', async () => {
    const png = buildPngBuffer(64, [0x8e, 0xc0, 0x7c]).toString('base64');
    return a.evaluate(async ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const file = new File([bytes], 'выдуманный-стикер.png', { type: 'image/png' });
      const result = await window.__parvaneDiagCallApi('parvaneCreateStickerPack', { name, files: [file] });
      return result ? 'создан' : 'нет ответа';
    }, { b64: png, name: `Выдуманные стикеры ${SUFFIX}` });
  });

  await step('свой GIF', async () => a.evaluate(async () => {
    // Самый маленький GIF 1×1 (выдуманная картинка)
    const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (ch) => ch.charCodeAt(0));
    const file = new File([gif], 'выдуманный.gif', { type: 'image/gif' });
    const result = await window.__parvaneDiagCallApi('parvaneUploadGif', { file });
    if (!result) throw new Error('parvaneUploadGif без ответа (нужна конвертация в webm)');
    return 'загружен';
  }));

  await step('блокировка', () => api(a, 'blockUser', { user: `$user:${NICK.carol}` }));
  await step('архив', () => api(a, 'toggleChatArchived', { chat: `$chat:${NICK.carol}`, folderId: 1 }));

  await step('второе устройство alice', async () => {
    await resetUi(a);
    const session = await preparePage(await openProfile('alice2'), ADDR.alice, PASSWORD, {
      seedLocalStorage: { 'parvane:e2e:historyBatchMs': '1000,3000' },
    });
    pages.alice2 = session.page;
    await linkSecondDevice(a, session.page);
    await waitGlobalText(session.page, 'Ответ bob о вымышленной погоде', 180000);
  });

  // Выгрузка carol до PIN: перевод хранилища под PIN (rekeyAll) — отдельное поведение, сверяется с выгрузкой после
  await step('выгрузка carol до PIN', async () => {
    const dump = await api(c, 'parvaneAuditDump');
    writeFileSync(join(OUT, 'audit', 'web-carol.before-pin.jsonl'), dump || '');
    return { lines: (dump || '').trim().split('\n').filter(Boolean).length };
  });
  await step('PIN хранилища (carol)', async () => {
    const result = await api(c, 'parvaneSetStoragePin', { pin: STORAGE_PIN });
    return { result, pin: STORAGE_PIN };
  });
  // Эталон «до» профиля под PIN — то, что прежний код читает ПОСЛЕ перезапуска (PIN спрашивается окном): записи,
  // которые он сам не смог бы открыть (PV-001), переносу показать нечем (T109)
  await step('перезапуск carol под PIN', async () => {
    c.on('dialog', (d) => { void d.accept(STORAGE_PIN); });
    await c.reload();
    await c.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await c.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, { timeout: LOGIN_TIMEOUT_MS });
    await pause(10000);
  });

  await pause(HISTORY_SETTLE_MS);

  await step('счётчики SC-009 web после перезагрузки', async () => {
    await a.reload();
    await a.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await a.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, { timeout: LOGIN_TIMEOUT_MS });
    await pause(15000);
    const counters = await api(a, 'parvaneAuditCounters');
    writeFileSync(join(OUT, 'counters-web.json'), `${JSON.stringify(counters, undefined, 1)}\n`);
    return counters;
  });

  for (const who of ['alice1', 'alice2', 'bob', 'carol']) {
    // eslint-disable-next-line no-await-in-loop
    await step(`выгрузка ${who}`, async () => {
      const page = pages[who];
      assert.ok(page, 'страницы нет');
      const first = await api(page, 'parvaneAuditDump');
      assert.ok(first && first.length > 0, 'пустая выгрузка');
      await pause(3000);
      const second = await api(page, 'parvaneAuditDump');
      writeFileSync(join(OUT, 'audit', `web-${who}.jsonl`), first);
      const lines = first.trim().split('\n');
      const kinds = {};
      lines.forEach((line) => { const { kind } = JSON.parse(line); kinds[kind] = (kinds[kind] || 0) + 1; });
      return { lines: lines.length, stable: first === second, kinds };
    });
  }

  await step('выгрузка сервера', async () => {
    assert.ok(BACKEND_DIR, 'нет PARVANE_E2E_BACKEND_LOG_DIR');
    // Профили закрыты ДО копии баз: курсоры и подтверждения профиля не уходят дальше копии сервера (T109)
    for (const context of Object.values(ctx)) {
      // eslint-disable-next-line no-await-in-loop
      await context.close().catch(() => undefined);
    }
    await pause(3000);
    const out = join(OUT, 'audit', 'server.jsonl');
    execFileSync('python3', [join(ROOT, 'scripts/migration_audit_server.py'), '--dump', BACKEND_DIR, '-o', out]);
    // Копия баз (вместе с -wal/-shm) — сервер этого же состояния для сценария переноса
    const dbDir = join(OUT, 'profiles', 'server');
    mkdirSync(dbDir, { recursive: true });
    // Ключ подписи JWT identity — тоже: сессии профилей сида принимаются тем же сервером (T109)
    const copied = readdirSync(BACKEND_DIR)
      .filter((n) => /\.db(-wal|-shm)?$/.test(n) || n === 'parvane.json' || /^identity-.*\.pem$/.test(n));
    copied.forEach((n) => copyFileSync(join(BACKEND_DIR, n), join(dbDir, n)));
    return { tables: execFileSync('wc', ['-l', out]).toString().trim(), copied: copied.length };
  });
} finally {
  for (const context of Object.values(ctx)) {
    // eslint-disable-next-line no-await-in-loop
    await context.close().catch(() => undefined);
  }
  await browser.close().catch(() => undefined);
  const failedRequired = results.filter((r) => !r.ok && REQUIRED.has(r.step)).map((r) => r.step);
  const summary = {
    created: new Date().toISOString(), suffix: SUFFIX, addresses: ADDR, group: GROUP, cloudFolder: CLOUD_FOLDER,
    photoGroup: PHOTO_GROUP,
    password: PASSWORD, storagePin: { carol: STORAGE_PIN }, results, failedRequired,
  };
  writeFileSync(join(OUT, 'seed-summary.json'), `${JSON.stringify(summary, undefined, 1)}\n`);
  const failed = results.filter((r) => !r.ok).map((r) => r.step);
  console.log(`\nнаполнение web: шагов ${results.length}, сбоев ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
  if (failedRequired.length || !existsSync(join(OUT, 'audit', 'web-alice1.jsonl'))) exitCode = 1;
}
process.exit(exitCode);
