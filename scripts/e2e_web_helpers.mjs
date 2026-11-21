// Общие помощники двухбраузерных Web e2e сценариев (живой стек NATS+gateway).
// Скрипты-сценарии: e2e_web_sync_reconnect.mjs, e2e_web_media_ttl.mjs и другие.
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const LOGIN_TIMEOUT_MS = 60000;
export const RECONNECT_TIMEOUT_MS = 30000;

// --- Оболочка: меню «☰» в шапке списка чатов нет, его пункты — в «Профиле» (главный экран настроек).
// «Профиль» — модуль `Profile`: на компьютере — вкладка боковой панели `#FoldersSidebar`, на телефоне — кнопка
// нижней ленты (`navigation` `Modules`). Вернуться к списку чатов — вкладка/кнопка `Chats` там же. «+» (`[data-add-for]`, «Add record»)
// — отдельная кнопка `[data-add-for]`: на телефоне плавает над лентой, на компьютере стоит внизу панели.

// Признак «показан список чатов»: заголовок «Чаты» в шапке списка. Он есть на обеих ширинах и только в
// состоянии списка — в поиске, контактах, настройках и при открытой панели форума его нет
// (`#telegram-search-input` есть и в поиске, и в контактах, поэтому признаком списка не служит)
export function chatListMarker(page) {
  return page.locator('#LeftMainHeader .left-header-title');
}

export async function isChatListShown(page) {
  return chatListMarker(page).isVisible().catch(() => false);
}

export async function waitForChatList(page, timeout = LOGIN_TIMEOUT_MS) {
  await chatListMarker(page).waitFor({ state: 'visible', timeout });
}

// Кнопка раздела оболочки (`Chats`, `Profile`): боковая панель либо нижняя панель телефона. У «Чатов» в
// название входит счётчик непрочитанного — поэтому по началу названия
function shellButton(page, name) {
  const pattern = new RegExp(`^${name}`);
  const rail = page.locator('#FoldersSidebar').getByRole('tab', { name: pattern });
  const bar = page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: pattern });
  return rail.or(bar).first();
}

// «Профиль» (spec 041 E3): на телефоне — экран со списком разделов, на компьютере — колонка разделов слева,
// справа «Обзор». И то и другое помечено `data-profile-menu`, пункты и плитки — `data-profile-item`
const profileScreen = (page) => page.locator('[data-profile-menu]');

// Пункт «Профиля» по точному названию (`Devices and account`, `Language`, …) либо плитка `Saved Messages`,
// `Contacts`, `Archived Chats`; подпись справа в название не входит
export function profileRow(page, name) {
  return page.locator('[data-profile-item]:visible')
    .filter({ has: page.getByText(name, { exact: true }) }).first();
}

// «Профиль» — главный экран настроек; из вложенного экрана настроек возвращается к главному
export async function openProfile(page) {
  const screen = profileScreen(page);
  await clickUntil(
    shellButton(page, 'Profile'),
    () => screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  );
  return screen;
}

// Экраны, которые открываются со второго шага: папки и стикеры — из «Настроек мессенджера», фон чатов и
// подробные анимации — из «Оформления»
const NESTED_SETTINGS = {
  'Chat Folders': 'Messenger settings',
  'Stickers and Emoji': 'Messenger settings',
  'Chat background': 'Appearance',
  'Animations and Performance': 'Appearance',
};

// Экран настроек по названию пункта «Профиля» (`Devices and account`, `Privacy and Security`, `Language`, …)
export async function openSettingsScreen(page, name) {
  await openProfile(page);
  const parent = NESTED_SETTINGS[name];
  if (!parent) {
    await profileRow(page, name).click();
    return;
  }
  await profileRow(page, parent).click();
  const screen = page.locator('#Settings .Transition_slide-active');
  // «Фон чатов» — переключатель «По умолчанию / Рисунок / Своя картинка»: экран выбора открывает «Рисунок»
  if (name === 'Chat background') {
    await screen.locator('[data-appearance-row="background"]').getByRole('button', { name: 'Pattern', exact: true })
      .click();
    return;
  }
  await screen.getByText(name, { exact: true }).first().click();
}

// К списку чатов из «Профиля» (кнопка `Chats`) и из поиска или контактов (стрелка «назад» в шапке)
export async function showChatList(page) {
  const back = page.locator('#LeftMainHeader').getByRole('button', { name: 'Return to chat list' });
  // Окно «Изменить профиль» компьютера (`RdProfile`) перекрывает панель модулей: без сохранения его закрывает «Отмена»
  const profileCancel = page.locator('[data-edit-profile-window] [data-profile-cancel]');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await isChatListShown(page)) return;
    if (await profileCancel.isVisible().catch(() => false)) {
      await profileCancel.click({ timeout: 5000 }).catch(() => {});
      await profileCancel.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    const target = await back.isVisible().catch(() => false) ? back : shellButton(page, 'Chats');
    await target.click({ timeout: 5000 }).catch(() => {});
    await waitForChatList(page, 3000).catch(() => {});
  }
  await waitForChatList(page);
}

// «Избранное»: строка «Профиля» `Saved Messages`. На компьютере чат открывается в средней колонке, после
// чего левая колонка возвращается к списку чатов (как было при открытии из меню); на телефоне открыт чат
export async function openSavedMessages(page) {
  await openProfile(page);
  await profileRow(page, 'Saved Messages').click();
  await page.locator('#MiddleColumn').getByText('Saved Messages').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#editable-message-text[contenteditable="true"]')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await page.locator('#FoldersSidebar').isVisible().catch(() => false)) await showChatList(page);
}

// Список контактов в левой колонке: строка «Профиля» `Contacts`
export async function openContacts(page) {
  await openProfile(page);
  await profileRow(page, 'Contacts').click();
}

// Правка своего профиля: карандаш в шапке «Профиля» на телефоне, «Изменить» в «Обзоре» на компьютере
// «Мой профиль»: на телефоне — экран, на компьютере — окно поверх «Профиля» (доска `RdProfile`)
export async function openEditProfile(page) {
  await openProfile(page);
  await page.locator('[data-profile-edit]:visible').first().click();
  await page.locator('[data-edit-profile]').getByLabel('First name (required)')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Поля сверх досок (фамилия, день рождения, цвет имени, личный канал, телефон) — под «Ещё»: раскрыть
  const more = page.locator('[data-edit-profile] [data-profile-more][aria-expanded="false"]');
  if (await more.isVisible().catch(() => false)) await more.click();
}

// «Готово» в шапке экрана (`XpProfile`) либо «Сохранить» окна (`RdProfile`): сохраняет и ждёт, пока форма перестанет
// помнить несохранённое (`data-dirty` снимается после ответа сервера; окно после сохранения закрывается)
export async function saveEditProfile(page) {
  await page.locator('[data-profile-done]:visible, [data-profile-save]:visible').first().click();
  await page.locator('[data-edit-profile][data-dirty]').waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
}

// Экран «Плана»: `today` — вид «День», `calendar` — сетка в виде, который устройство запомнило (по умолчанию
// месяц); `health` открывает модуль «Здоровье». «День» — первый пункт переключателя вида (значение `today`):
// путь — «План» в панели модулей (на телефоне — в ленте), затем пункт переключателя. Модуль сам открывает то,
// что показывал в последний раз, поэтому нужный пункт выбирается явно
const PLANNER_CALENDAR_VIEWS = ['week', 'month', 'year', 'agenda'];

/** Модуль «Здоровье» (spec 041): вкладка боковой панели либо кнопка нижней ленты. Возвращает корень модуля. */
export async function openHealthModule(page) {
  const health = page.locator('#ParvaneHealth');
  const rail = page.locator('#FoldersSidebar');
  // После перезагрузки навигации ещё нет: ждём панель либо ленту, потом выбираем путь
  await rail.or(page.getByRole('navigation', { name: 'Modules' })).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await rail.isVisible().catch(() => false)) {
    await rail.getByRole('tab', { name: 'Health', exact: true }).click();
  } else {
    await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Health' }).click();
  }
  await health.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return health;
}

export async function openPlannerScreen(page, screen = 'calendar') {
  // «Здоровье» — отдельный модуль, экрана в «Плане» у него больше нет
  if (screen === 'health') return openHealthModule(page);
  const planner = page.locator('#ParvanePlanner');
  const rail = page.locator('#FoldersSidebar');
  if (await rail.isVisible().catch(() => false)) {
    await rail.getByRole('tab', { name: 'Plan', exact: true }).click();
  } else {
    if (!(await planner.isVisible().catch(() => false))) {
      await page.getByRole('navigation', { name: 'Modules' }).getByRole('button', { name: 'Plan', exact: true }).click();
    }
  }
  await planner.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const saved = await page.evaluate(() => localStorage.getItem('parvane:planner-view'));
  const value = screen === 'today' ? 'today' : PLANNER_CALENDAR_VIEWS.includes(saved) ? saved : 'month';
  const segment = planner.getByRole('group', { name: 'Calendar view' }).locator(`button[data-value="${value}"]`);
  await segment.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (await segment.getAttribute('aria-pressed') !== 'true') await segment.click();
  await planner.locator(`button[data-value="${value}"][aria-pressed="true"]`)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return planner;
}

// День в левой колонке «Плана» на компьютере (`[data-planner-day]`): колонка есть только у недели (доска `RdPlan`:
// «Месяц» — сетка на всю ширину), день выбирается в её мини-месяце; день другого месяца — листанием недель
export async function pickPlannerDay(page, day) {
  const planner = await openPlannerScreen(page, 'calendar');
  const week = planner.getByRole('group', { name: 'Calendar view' }).locator('button[data-value="week"]');
  if (await week.getAttribute('aria-pressed') !== 'true') await week.click();
  await planner.locator('[data-planner-rail]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await planner.locator('header').getByRole('button', { name: 'Current date', exact: true }).click();
  for (let step = 0; step < 6; step += 1) {
    const cell = planner.locator(`[data-mini-day="${day}"]`);
    if (await cell.isVisible().catch(() => false)) {
      await cell.click();
      await planner.locator(`[data-planner-day="${day}"]`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      return planner;
    }
    await planner.getByRole('button', { name: 'Next period' }).click();
  }
  throw new Error(`день ${day} не найден в мини-месяце «Плана»`);
}

// Настройки «Плана» — страница «Профиль → Модули / План» (spec 041, доски `RdPlanSet`, `PhModSettings`): шестерёнка
// в шапке «Плана» открывает её. Возвращает содержимое страницы; уведомления о сохранении — `[role="status"]` в ней
export async function openPlannerSettings(page) {
  const settings = page.locator('[data-settings-page="plan"]');
  await clickUntil(
    page.locator('#ParvanePlanner').getByRole('button', { name: 'Planner settings' }).first(),
    () => settings.locator('[data-planner-settings]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  );
  return settings;
}

// Со страницы настроек — обратно в «План» (тот же вид): «назад» до экрана с панелью модулей, затем «План»
export async function closePlannerSettings(page) {
  const planner = page.locator('#ParvanePlanner');
  const rail = page.locator('#FoldersSidebar');
  const tabBar = page.getByRole('navigation', { name: 'Modules' });
  for (let attempt = 0; attempt < 6; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await rail.isVisible().catch(() => false)) {
      // eslint-disable-next-line no-await-in-loop
      await rail.getByRole('tab', { name: 'Plan', exact: true }).click();
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await tabBar.isVisible().catch(() => false)) {
      // eslint-disable-next-line no-await-in-loop
      await tabBar.getByRole('button', { name: 'Plan', exact: true }).click();
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(400);
  }
  await planner.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return planner;
}

// Пункт «Log Out» — последний в списке разделов «Профиля»; `[data-settings-sign-out]` — от языка не зависит
export function logOutRow(page) {
  return page.locator('[data-settings-sign-out]:visible').first();
}

// Полный выход из аккаунта (не reload): «Профиль» → строка «Log Out» → подтверждение
export async function logOut(page) {
  await openProfile(page);
  await logOutRow(page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await logOutRow(page).click();
  await clickUntil(
    // Шторка выхода (доска `PhProfileB`): «Просто выйти»
    page.locator('.Modal [data-sign-out-plain]').last(),
    () => page.locator('.Transition_slide-active > #auth-phone-number-form')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
}

// Клик, который под нагрузкой мог не дойти (перерисовка/анимация кнопки):
// обычный → force → dispatchEvent, после каждого ждём `isDone`
export async function clickUntil(locator, isDone, { attempts = 4, settleMs = 3000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt === 0) await locator.click({ timeout: 5000 });
      else if (attempt === 1) await locator.click({ force: true, timeout: 5000 });
      else await locator.dispatchEvent('click');
    } catch {
      // кнопка перемонтировалась — проверим результат и попробуем снова
    }
    const done = await Promise.race([
      isDone().then(() => true).catch(() => false),
      new Promise((resolve) => { setTimeout(() => resolve(false), settleMs); }),
    ]);
    if (done) return;
  }
  await isDone();
}

// Сколько ждать исхода запуска v2 после входа и появления диалога ключа после него
const V2_STARTUP_TIMEOUT_MS = 30000;
const RECOVERY_DIALOG_SETTLE_MS = 3000;

export function requireEnv() {
  const baseUrl = process.env.PARVANE_E2E_BASE_URL;
  const gatewayUrl = process.env.PARVANE_E2E_GATEWAY_URL;
  assert(baseUrl, 'PARVANE_E2E_BASE_URL is required');
  assert(gatewayUrl, 'PARVANE_E2E_GATEWAY_URL is required');
  return { baseUrl, gatewayUrl };
}

export async function preparePage(context, user, password, options = {}) {
  // `noGatewaySeed` — адрес gateway выбирает само приложение (страница `.onion`, spec 025)
  const { startUrl, beforeLogin, noGatewaySeed } = options;
  const { seedLocalStorage } = options;
  const env = requireEnv();
  const { baseUrl } = env;
  // `gatewayUrl` — другой сервер (федерация, spec 028: та же сборка web, свой gateway у каждого)
  const gatewayUrl = options.gatewayUrl || env.gatewayUrl;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // Исход запуска v2 (готов / нужна линковка / сбой) — по журналу провайдера
  const v2Outcome = { isKnown: false };
  // Журнал провайдера (`[parvane] …`) — для разбора падений: session.logs
  const logs = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.includes('[parvane]') && !text.includes('метод не реализован')) {
      // Время браузера нам недоступно — ставим своё: разбирать паузы между строками
      logs.push(`${new Date().toISOString().slice(11, 23)} ${text.slice(0, 300)}`);
      if (logs.length > 400) logs.shift();
    }
    if (/\[parvane\] v2: (готов|у аккаунта уже есть журнал устройств|запуск не удался)/.test(text)) {
      v2Outcome.isKnown = true;
    }
  });
  await page.addInitScript(({ gatewayUrl: url, seed }) => {
    if (url) localStorage.setItem('parvane:gateway', url);
    else localStorage.removeItem('parvane:gateway');
    // «План» открывается на экране, где пользователь был в последний раз (по умолчанию «Сегодня» — первый
    // вид календаря); сценарии календаря ждут сетку сразу — «Сегодня» сценарий открывает сам
    // (`openPlannerScreen(page, 'today')`). Второй ключ — что «Календарь» показывал в последний раз
    if (!localStorage.getItem('parvane:planner-tab')) localStorage.setItem('parvane:planner-tab', '1');
    if (!localStorage.getItem('parvane:planner-calendar-tab')) {
      localStorage.setItem('parvane:planner-calendar-tab', '1');
    }
    // Блок «Повтор и детали» карточки записи раскрыт: сценарии правят поля внутри него
    if (!localStorage.getItem('parvane:planner-details')) localStorage.setItem('parvane:planner-details', '1');
    // Первый запуск «Что вам нужно в Parvane?» (доски `XpStart`, `ZdNav`) пройден: сценарии ждут чаты сразу.
    // Сам экран проверяет `e2e_web_first_run.mjs` (сид `parvane:modules-first-run` пустой)
    if (localStorage.getItem('parvane:modules-first-run') === null) {
      localStorage.setItem('parvane:modules-first-run', 'shown');
    }
    // Экран «Уведомления» после первого входа (spec 041 `ZpSysGen`) перекрыл бы сценарии — отмечен показанным; свой
    // шаг его проверяет, сняв отметку (`seed`)
    if (!localStorage.getItem('parvane:notify-onboard')) localStorage.setItem('parvane:notify-onboard', '1');
    Object.entries(seed || {}).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    const NativeWebSocket = window.WebSocket;
    globalThis.__parvaneE2eSockets = { opened: 0, closed: 0, active: new Set() };
    globalThis.__parvaneE2eDisconnect = () => {
      for (const socket of globalThis.__parvaneE2eSockets.active) {
        socket.close(4001, 'e2e network interruption');
      }
    };
    // Звонки: движки держат RTCPeerConnection в приватных полях — запоминаем
    // все экземпляры, чтобы e2e читал getStats() (callMediaStats)
    const NativePeerConnection = window.RTCPeerConnection;
    globalThis.__parvaneE2ePeers = [];
    if (NativePeerConnection) {
      window.RTCPeerConnection = class TrackedPeerConnection extends NativePeerConnection {
        constructor(...args) {
          super(...args);
          globalThis.__parvaneE2ePeers.push(this);
        }
      };
    }
    // Учёт скачанного из облака (trackDownloadedBytes): id запроса → file_id
    globalThis.__parvaneE2eDownloads = { fileByRequest: {}, bytesByFile: {}, requests: [] };
    window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
      constructor(url2, protocols) {
        super(url2, protocols);
        globalThis.__parvaneE2eSockets.active.add(this);
        const downloads = globalThis.__parvaneE2eDownloads;
        const nativeSend = this.send.bind(this);
        this.send = (data) => {
          try {
            const frame = JSON.parse(String(data));
            if (frame.op === 'reqmany' && frame.subject === 'file.download.request') {
              // payload запроса — WireEvent { id, from, token, payload: { file_id, … } }
              const event = JSON.parse(frame.payload || '{}');
              const body = event.payload || event;
              downloads.fileByRequest[frame.id] = body.file_id;
              downloads.requests.push({
                fileId: body.file_id, from: body.chunk_from, to: body.chunk_to, at: Date.now(),
              });
            }
          } catch {
            // не JSON-кадр
          }
          return nativeSend(data);
        };
        this.addEventListener('message', (event) => {
          try {
            const frame = JSON.parse(String(event.data));
            const fileId = frame.op === 'reply' && downloads.fileByRequest[frame.id];
            if (!fileId) return;
            const body = JSON.parse(frame.payload || '{}');
            if (!body.data) return;
            const padding = body.data.endsWith('==') ? 2 : body.data.endsWith('=') ? 1 : 0;
            downloads.bytesByFile[fileId] = (downloads.bytesByFile[fileId] || 0)
              + Math.floor((body.data.length * 3) / 4) - padding;
          } catch {
            // не JSON-кадр
          }
        });
        this.addEventListener('open', () => {
          globalThis.__parvaneE2eSockets.opened += 1;
        });
        this.addEventListener('close', () => {
          globalThis.__parvaneE2eSockets.active.delete(this);
          globalThis.__parvaneE2eSockets.closed += 1;
        });
      }
    };
  }, {
    gatewayUrl: noGatewaySeed ? '' : gatewayUrl,
    seed: seedLocalStorage,
  });
  await page.route(/https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/_websync_/, async (route) => {
    await route.fulfill({ contentType: 'application/javascript', body: '' });
  });
  // При первом создании корня web показывает диалог ключа восстановления — в
  // произвольный момент после входа. Обычные сценарии закрывают его автоматически;
  // сценарии протокола (метка `parvane:proto` в seed) читают ключ сами
  // (dismissRecoveryKeyDialog).
  const isAutoRecoveryDialog = !seedLocalStorage || !('parvane:proto' in seedLocalStorage);
  await page.goto(startUrl || baseUrl, { waitUntil: 'domcontentloaded' });
  // Хук между открытием страницы и вводом ника (например, уйти на другой
  // адрес в той же вкладке, проверяя переживание sessionStorage)
  if (beforeLogin) await beforeLogin(page);

  const passwordScreen = await submitNickUntilPassword(page, user);
  await passwordScreen.locator('#sign-in-password').fill(password);
  await clickUntil(
    passwordScreen.locator('[data-auth-submit]'),
    () => page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  await page.waitForFunction(() => globalThis.__parvaneE2eSockets?.opened >= 1);
  if (isAutoRecoveryDialog) {
    // Диалог ключа закрываем ДО возврата: появившись посреди шага сценария, он
    // отбирает фокус (сбрасывается поиск, ввод уходит мимо). Ждём исхода
    // запуска v2; у второго устройства и при сбое диалога не будет
    const deadline = Date.now() + V2_STARTUP_TIMEOUT_MS;
    while (!v2Outcome.isKnown && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(200);
    }
    await dismissRecoveryKeyDialog(page, RECOVERY_DIALOG_SETTLE_MS);
    // Запасной путь: диалог появился позже (корень создан после линковки/сброса)
    await autoDismissRecoveryKeyDialog(page);
  }
  return { page, errors, logs };
}

// Экран входа — одна форма «сервер, ник, пароль» (spec 041 E4): ввести ник (или полный адрес) и нажать Enter —
// без пароля форма переходит к шагу пароля (тот же экран, корень `#auth-password-form`). Провайдер может
// повторно прислать шаг ника (после чтения storage) — повторяем, пока шаг ника не сменится
export async function submitNick(page, user) {
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const addressInput = addressScreen.getByLabel('Nickname');
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  try {
    await addressInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  } catch (err) {
    if (await passwordScreen.isVisible().catch(() => false)) return;
    // Поле ника не появилось — снимаем состояние страницы для разбора
    const shot = `web/telegram-tt/test-results/submit-nick-${Date.now()}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch((e) => String(e));
    console.error(`submitNick: поле ника недоступно (${page.url()}); снимок ${shot}; текст страницы: ${text}`);
    throw err;
  }
  const hidden = () => addressScreen.waitFor({ state: 'hidden', timeout: 8000 }).then(() => true).catch(() => false);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await passwordScreen.isVisible().catch(() => false)) return;
    if ((await addressInput.inputValue().catch(() => '')) !== user) await addressInput.fill(user).catch(() => {});
    await addressInput.press('Enter').catch(() => {});
    if (await hidden()) return;
  }
  await addressScreen.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Ник → экран пароля. Под нагрузкой экран ника перемонтируется уже ПОСЛЕ
// отправки (провайдер повторно шлёт WaitPhoneNumber) и возвращается пустым —
// тогда ник вводится заново, пока не откроется экран пароля
export async function submitNickUntilPassword(page, user) {
  const addressScreen = page.locator('.Transition_slide-active > #auth-phone-number-form');
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    await submitNick(page, user);
    const isPassword = await Promise.race([
      passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).then(() => true),
      addressScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).then(() => false),
    ]).catch(() => undefined);
    if (isPassword) return passwordScreen;
    if (isPassword === undefined || Date.now() > deadline) {
      await passwordScreen.waitFor({ state: 'visible', timeout: 1000 });
      return passwordScreen;
    }
  }
}

export async function openPrivateChat(page, address) {
  const search = page.locator('#telegram-search-input');
  const displayName = address.split('@')[0];
  const pane = page.locator('.LeftSearch');
  // Панель открывается по фокусу: если поле уже в фокусе (прошлый вызов),
  // клик её не откроет — снимаем фокус и кликаем снова
  // Телефон: значок поиска в шапке «Чатов» открывает общий поиск — поиск по чатам идёт его строкой
  // «Искать в сообщениях» (spec 041, доска `XpStart`)
  const palette = page.locator('#parvane-palette-search');
  let isFromPalette = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await search.click();
    const opened = await Promise.race([
      pane.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'pane'),
      palette.waitFor({ state: 'visible', timeout: 3000 }).then(() => 'palette'),
    ]).catch(() => undefined);
    if (opened === 'palette') {
      await palette.fill(displayName);
      await page.locator('[data-palette-item="chat-search"]').click();
      isFromPalette = true;
      break;
    }
    if (opened === 'pane') break;
    await search.evaluate((el) => el.blur());
    await page.waitForTimeout(300);
  }
  await pane.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(250);
  if (!isFromPalette) await search.fill(displayName);
  const result = page.locator('.LeftSearch .search-result').filter({ hasText: displayName }).first();
  await result.waitFor({ state: 'visible', timeout: 15000 });
  await result.locator('.ListItem-button').click();
  // Пока история чата не подгружена (шапка «Updating»), tt рендерит композер
  // с contenteditable=false и placeholder «Text not allowed»: fill() падает
  // сразу, без ретраев. Ждём именно редактируемый композер
  await page.locator('#editable-message-text[contenteditable="true"]')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await closeLeftSearch(page);
}

// Панель поиска после клика по результату закрывается с анимацией; если чат
// уже был открыт, tt иногда оставляет её висеть поверх списка чатов (клик по
// чату в списке тогда падает «element is not visible»). Дожидаемся закрытия,
// иначе закрываем кнопкой «назад» в шапке. НЕ Escape: после открытия чата
// последним Esc-обработчиком становится MiddleColumn — он закрывает сам чат,
// и композер остаётся без объекта чата («Text not allowed»)
async function closeLeftSearch(page) {
  const search = page.locator('.LeftSearch');
  for (let attempt = 0; attempt < 3; attempt++) {
    const isHidden = await search.waitFor({ state: 'hidden', timeout: 2000 }).then(() => true).catch(() => false);
    if (isHidden) return;
    await page.locator('#LeftColumn').getByRole('button', { name: 'Return to chat list' }).first()
      .click({ timeout: 2000 }).catch(() => {});
  }
}

// Строгий вариант: проверяет заголовок чата и ретраит — нестрогий
// openPrivateChat мог оставить композер предыдущего чата (текст уходил не туда)
export async function openPrivateChatStrict(page, address) {
  const name = address.split('@')[0];
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPrivateChat(page, address).catch((err) => { lastError = err; });
    const isOpen = await page.locator('.MiddleHeader').getByText(name).first()
      .isVisible().catch(() => false);
    if (isOpen) return;
    // Снимок ДО Escape: после него панель поиска закрыта и причины уже не видно
    if (attempt === 2) {
      const shot = new URL('../web/telegram-tt/test-results/open-chat-failed.png', import.meta.url).pathname;
      await page.screenshot({ path: shot }).catch(() => {});
      const searchState = await page.evaluate((nick) => {
        const g = window.__parvaneGetGlobal?.();
        if (!g) return 'no global';
        const tab = Object.values(g.byTabId || {})[0];
        const user = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
        return JSON.stringify({ globalSearch: tab?.globalSearch, user: user && { id: user.id, firstName: user.firstName } });
      }, name).catch((e) => `unavailable: ${e.message}`);
      console.error(`--- search state (${name}) ---\n${String(searchState).slice(0, 2000)}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  // Причина последней попытки — в тексте: иначе по «did not open» не понять,
  // не нашёлся ли собеседник поиском или не открылся композер
  const reason = lastError ? String(lastError.message || lastError).split('\n').slice(0, 3).join(' | ') : 'header mismatch';
  throw new Error(`chat with ${address} did not open: ${reason}`);
}

export async function sendText(page, text) {
  // Только редактируемый композер: пока история открытого чата подгружается
  // (шапка «Updating»), tt кратко рендерит его с contenteditable=false и
  // placeholder «Text not allowed», а fill() на таком элементе падает сразу,
  // без авто-ожидания. Селектор с атрибутом заставляет Playwright дождаться
  const input = page.locator('#editable-message-text[contenteditable="true"]');
  const bubbles = () => page.locator('.Transition_slide-active > .MessageList .Message').count();
  const before = await bubbles();
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#editable-message-text')?.textContent);
  // Сразу после перехода в чат в DOM ещё живёт композер прежнего чата: текст,
  // введённый в него, пропадает вместе с ним, и сообщение не уходит вовсе (так
  // «терялось» первое сообщение в группе в `mixed:web2-groups`). Своё сообщение
  // появляется в ленте сразу — если лента не выросла, вводим ещё раз
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await bubbles() > before) return;
    await page.waitForTimeout(200);
  }
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#editable-message-text')?.textContent);
}

export function findMessage(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message .text-content')
    .filter({ hasText: text });
}

export function findMessageContainers(page, text) {
  return page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text });
}

export function findMessageContainer(page, text) {
  return findMessageContainers(page, text).last();
}

export async function openMessageMenuOn(container) {
  const box = await container.boundingBox();
  assert(box, 'message is not visible');
  await container.click({
    button: 'right',
    position: { x: box.width / 2, y: box.height / 2 },
  });
}

export async function selectMessageActionOn(page, container, action) {
  await openMessageMenuOn(container);
  const item = page.locator('.MessageContextMenu').getByRole('menuitem', { name: action, exact: true });
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.click();
}

export async function openMessageMenu(page, text) {
  await openMessageMenuOn(findMessageContainer(page, text));
}

export async function selectMessageAction(page, text, action) {
  await selectMessageActionOn(page, findMessageContainer(page, text), action);
}

export async function addReaction(page, text, emoji) {
  await openMessageMenu(page, text);
  const reaction = page.locator('.MessageContextMenu .ReactionSelector')
    .getByRole('button', { name: emoji, exact: true });
  await reaction.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await reaction.click();
  // Меню закрывается с анимацией, и её конец снимает контейнер меню целиком.
  // Правый клик по тому же сообщению раньше этого (pinMessage сразу после
  // реакции) открывал новое меню в старом контейнере — и окно «Pin» исчезало
  // вместе с ним, не дождавшись клика
  await page.locator('.MessageContextMenu').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

export async function pinMessage(page, text) {
  await selectMessageAction(page, text, 'Pin');
  const confirm = page.locator('.Modal.pin').getByRole('button', { name: 'Pin', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

// Экран «Кому отправить» (доска `RpPick`): поиск, галочка у чата, «Отправить в 1 чат» — пересылка уходит сразу,
// после неё открывается чат получателя. `options` — выключатели настроек пересылки по `data-forward-option`
export async function pickForwardRecipientAndSend(page, address, { caption, options = [] } = {}) {
  const displayName = address.split('@')[0];
  const picker = page.locator('.Modal').filter({ has: page.locator('[data-send-picker]') });
  await picker.locator('[data-send-search]').fill(displayName);
  const recipient = picker.locator('[data-send-row]').filter({ hasText: displayName }).last();
  await recipient.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await recipient.locator('input[type="checkbox"]').check();
  for (const option of options) {
    await picker.locator(`[data-forward-option="${option}"]`).click();
  }
  if (caption) await picker.locator('[data-send-caption]').fill(caption);
  await picker.locator('[data-send-submit]').click();
  await picker.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Экран «Место» (доска `RpChat`) из меню вложений: текущее место либо трансляция `period` — подпись сегмента
// ('15 min' | '1 hour' | '8 hours')
export async function sendLocation(page, { period } = {}) {
  await page.getByRole('button', { name: 'Add an attachment' }).click();
  await page.getByRole('menuitem', { name: 'Location', exact: true }).click();
  const screen = page.locator('.Modal').filter({ has: page.locator('[data-location-map]') });
  if (period) {
    await screen.getByRole('button', { name: period, exact: true }).click();
    const live = screen.locator('[data-location-live]');
    await live.and(page.locator(':enabled')).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await live.click();
  } else {
    const current = screen.locator('[data-location-send]');
    await current.and(page.locator(':enabled')).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await current.click();
  }
  await screen.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

export async function forwardMessage(page, text, address) {
  await selectMessageAction(page, text, 'Forward');
  await pickForwardRecipientAndSend(page, address);
}

export async function editText(page, sourceText, editedText) {
  await selectMessageAction(page, sourceText, 'Edit');
  await page.locator('.ComposerEmbeddedMessage').filter({ hasText: sourceText })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const input = page.locator('#editable-message-text');
  // Плашка «Edit message» появляется раньше, чем композер входит в режим
  // правки (состояние главной кнопки выводится на кадр-два позже): до этого
  // Enter уходил обычной отправкой, и вместо правки появлялось новое сообщение
  const editButton = page.locator('.main-button.edit');
  await editButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction((expected) => {
    return Array.from(document.querySelectorAll('#editable-message-text'))
      .some((field) => (field.textContent || '').includes(expected));
  }, sourceText, { timeout: LOGIN_TIMEOUT_MS });
  await input.fill(editedText);
  await editButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await input.press('Enter');
  await page.locator('.ComposerEmbeddedMessage').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

export async function deleteMessage(page, text) {
  await selectMessageAction(page, text, 'Delete');
  const confirm = page.locator('.Modal').getByRole('button', { name: 'Delete', exact: true });
  await confirm.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await confirm.click();
}

export async function waitForSocketCount(page, field, count) {
  await page.waitForFunction(
    ({ fieldName, expected }) => globalThis.__parvaneE2eSockets?.[fieldName] >= expected,
    { fieldName: field, expected: count },
    { timeout: RECONNECT_TIMEOUT_MS },
  );
}

export async function disconnectWhileOffline(context, page) {
  await context.setOffline(true);
  await page.evaluate(() => globalThis.__parvaneE2eDisconnect());
}

export function assertNoPageErrors(sessions) {
  for (const [name, session] of Object.entries(sessions)) {
    assert.deepEqual(session.errors, [], `${name} page errors: ${session.errors.join('; ')}`);
  }
}

// Reload, переживающий чужую навигацию. tt закрывает оверлеи (звонок, меню,
// модалки) через history.back(); если такой переход ещё в полёте, Chromium
// обрывает reload с net::ERR_ABORTED («maybe frame was detached») — ждём, пока
// страница успокоится, и повторяем. Любая другая ошибка пробрасывается
export async function reloadPage(page) {
  // Разбор зависшего reload: старый документ не выгрузился (маркер жив) или
  // новый не дошёл до DOMContentLoaded (readyState) + консоль за это время
  const consoleTail = [];
  const onConsole = (message) => {
    consoleTail.push(`${message.type()}: ${message.text().slice(0, 200)}`);
    if (consoleTail.length > 60) consoleTail.shift();
  };
  page.on('console', onConsole);
  // Дождаться кадра: reload, выданный пока главный поток занят закрытием
  // оверлея (history.back() после звонка), терялся — Playwright ждал нового
  // документа 30 с (`calls` после T110: 3 красных из 4 без этого ожидания)
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    globalThis.__parvaneE2eReloadMarker = Date.now();
  })).catch(() => undefined);
  // Закрытие раздела/оверлея снимает свою запись истории отложенным `history.go(-1)` (useHistoryBack): переход
  // по истории, ещё идущий в момент reload, отменял перезагрузку (старый документ оставался, article). Ждём тишины
  // `popstate` (300 мс, не дольше 3 с)
  await page.evaluate(() => new Promise((resolve) => {
    const started = Date.now();
    let last = Date.now();
    const onPop = () => { last = Date.now(); };
    window.addEventListener('popstate', onPop);
    const tick = () => {
      if (Date.now() - last >= 300 || Date.now() - started >= 3000) {
        window.removeEventListener('popstate', onPop);
        resolve(undefined);
      } else {
        setTimeout(tick, 50);
      }
    };
    setTimeout(tick, 50);
  })).catch(() => undefined);
  try {
    let lastReloadState;
    for (let attempt = 0; ; attempt++) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        return;
      } catch (err) {
        if (err?.name === 'TimeoutError') {
          const state = await page.evaluate(() => ({
            readyState: document.readyState,
            oldDocument: Boolean(globalThis.__parvaneE2eReloadMarker),
            href: location.href,
            pendingResources: performance.getEntriesByType('resource')
              .filter((e) => e.responseEnd === 0).map((e) => e.name).slice(0, 10),
          })).catch((e) => `evaluate failed: ${e.message}`);
          console.error(`--- reload diag ---\n${JSON.stringify(state)}\n--- console tail ---\n${consoleTail.join('\n')}`);
          lastReloadState = typeof state === 'object' ? state : undefined;
        }
        // Перезагрузка, проглоченная навигацией внутри страницы (закрытие раздела/оверлея через history.back()):
        // старый документ жив, новый не начинался — выдаём перезагрузку ещё раз
        const isSwallowed = err?.name === 'TimeoutError' && lastReloadState?.oldDocument === true;
        if (isSwallowed && attempt < 2) {
          // Страховка: в логе сценария видно, что перезагрузка не началась с первого раза
          console.error('--- reload diag: перезагрузка не началась (старый документ жив) — повтор ---');
          continue;
        }
        if (attempt >= 2 || !/ERR_ABORTED|frame was detached/.test(String(err?.message))) throw err;
        await page.waitForLoadState('domcontentloaded').catch(() => {});
      }
    }
  } finally {
    page.off('console', onConsole);
  }
}

// Reload + вход. keep-signed-in: сессия возобновляется сохранённым JWT (P-39,
// пароль на диск не пишется), вход после reload автоматический; форма пароля
// появляется только без сохранённой сессии
export async function relogin(page, password) {
  await reloadPage(page);
  const passwordScreen = page.locator('.Transition_slide-active > #auth-password-form');
  const leftColumn = page.locator('#LeftColumn');
  await Promise.race([
    passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (await passwordScreen.isVisible()) {
    await passwordScreen.locator('#sign-in-password').fill(password);
    await clickUntil(
      passwordScreen.locator('[data-auth-submit]'),
      () => leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
      { settleMs: 15000 },
    );
  }
  await leftColumn.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

const DIAG_STORAGE_KEY = 'parvane:diag:v2';

// Записи журнала клиента: { t, k, d?, n? }. Журнал пишется в localStorage с
// задержкой ~1.5 с — перед чтением свежих событий нужно подождать
export async function readDiagJournal(page) {
  return page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }, DIAG_STORAGE_KEY);
}

// Журнал действий клиента (web util/parvaneDiag, localStorage parvane:diag:v2)
// — при падении сценария печатаем хвост: видно апдейты/ошибки провайдера.
// PARVANE_E2E_DIAG_LINES — длина хвоста (журнал кольцевой, до 800 записей)
export async function dumpDiagJournal(page, label, limit = Number(process.env.PARVANE_E2E_DIAG_LINES) || 40) {
  const lines = await page.evaluate(({ max, key }) => {
    try {
      const raw = localStorage.getItem(key);
      const entries = raw ? JSON.parse(raw) : [];
      return entries.slice(-max).map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.k}${e.n ? ` x${e.n}` : ''} ${(e.d || '').slice(0, 140)}`);
    } catch (e) { return [`diag unavailable: ${e}`]; }
  }, { max: limit, key: DIAG_STORAGE_KEY }).catch((e) => [`diag eval failed: ${e.message}`]);
  console.error(`--- diag ${label} ---\n${lines.join('\n')}`);
}

// Скачивание документа из пузыря: download приходит либо на странице, либо на
// попапе service worker. Возвращает { name, sha256 }
export async function sha256OfDownload(page, locator) {
  const context = page.context();
  const downloadFromPopup = context.waitForEvent('page', { timeout: LOGIN_TIMEOUT_MS })
    .then((popup) => popup.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS }));
  const downloadFromPage = page.waitForEvent('download', { timeout: LOGIN_TIMEOUT_MS });
  downloadFromPopup.catch(() => {});
  downloadFromPage.catch(() => {});
  await locator.click();
  const download = await Promise.race([downloadFromPage, downloadFromPopup]);
  const bytes = await readFile(await download.path());
  return {
    name: download.suggestedFilename(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// Учёт скачанного из облака: запросы file.download.request (file_id,
// chunk_from/chunk_to) и байты data в ответах. Счётчики живут в странице
// (init-скрипт preparePage), поэтому видят и сокет, открытый до вызова
export function trackDownloadedBytes(page) {
  return {
    reset: () => page.evaluate(() => {
      globalThis.__parvaneE2eDownloads.bytesByFile = {};
      globalThis.__parvaneE2eDownloads.requests = [];
    }),
    bytesFor: (fileId) => page.evaluate((id) => {
      const { bytesByFile } = globalThis.__parvaneE2eDownloads;
      if (id) return bytesByFile[id] || 0;
      return Object.values(bytesByFile).reduce((sum, value) => sum + value, 0);
    }, fileId),
    requests: () => page.evaluate(() => globalThis.__parvaneE2eDownloads.requests.slice()),
  };
}

// Статистика медиа всех живых соединений звонка на странице. peer — адрес
// участника группового звонка (по совпадению id треков с parvaneCall.groupStreams),
// для 1-1 — 'peer'
export async function callMediaStats(page) {
  return page.evaluate(async () => {
    const call = window.parvaneCall || {};
    const trackOwner = new Map();
    Object.entries(call.groupStreams || {}).forEach(([address, stream]) => {
      stream?.getTracks?.().forEach((track) => trackOwner.set(track.id, address));
    });
    const peers = (globalThis.__parvaneE2ePeers || []).filter((pc) => pc.connectionState !== 'closed');
    const result = [];
    for (const pc of peers) {
      const trackIds = pc.getReceivers().map((receiver) => receiver.track?.id).filter(Boolean);
      const peer = trackIds.map((id) => trackOwner.get(id)).find(Boolean) || 'peer';
      const stats = await pc.getStats();
      const snapshot = {
        peer,
        connectionState: pc.connectionState,
        audio: { bytesReceived: 0, totalAudioEnergy: 0 },
        video: {
          framesDecoded: 0, frameWidth: 0, frameHeight: 0, framesPerSecond: 0,
        },
        candidateType: undefined,
      };
      let selectedPairId;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) selectedPairId = report.selectedCandidatePairId;
      });
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          snapshot.audio.bytesReceived += report.bytesReceived || 0;
          snapshot.audio.totalAudioEnergy += report.totalAudioEnergy || 0;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          snapshot.video.framesDecoded += report.framesDecoded || 0;
          snapshot.video.frameWidth = Math.max(snapshot.video.frameWidth, report.frameWidth || 0);
          snapshot.video.frameHeight = Math.max(snapshot.video.frameHeight, report.frameHeight || 0);
          snapshot.video.framesPerSecond = Math.max(snapshot.video.framesPerSecond, report.framesPerSecond || 0);
        }
        if (report.type === 'candidate-pair' && (report.id === selectedPairId || (!selectedPairId && report.nominated))) {
          const local = stats.get(report.localCandidateId);
          snapshot.candidateType = local?.candidateType;
        }
      });
      result.push(snapshot);
    }
    return result;
  });
}

// Средняя яркость и дисперсия удалённого видео (canvas 32×24): выключенная
// камера у собеседника даёт чёрные кадры (mean < 20, variance ≈ 0)
export async function remoteVideoLuma(page, selector) {
  return page.evaluate((sel) => {
    const video = document.querySelector(sel);
    if (!video || !video.videoWidth) return { mean: -1, variance: -1 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const { data } = ctx.getImageData(0, 0, 32, 24);
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return { mean, variance };
  }, selector);
}

// Яркость удалённого видео 1-1 звонка: элемент, чей srcObject — удалённый поток
export async function remoteCallVideoLuma(page) {
  return page.evaluate(() => {
    const remote = window.parvaneCall?.remoteStream;
    const video = Array.from(document.querySelectorAll('video')).find((element) => element.srcObject === remote);
    if (!video || !video.videoWidth) return { mean: -1, variance: -1 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const { data } = ctx.getImageData(0, 0, 32, 24);
    const values = [];
    for (let i = 0; i < data.length; i += 4) values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return { mean, variance };
  });
}

// Ждёт, пока предикат яркости выполнится `samples` замеров подряд
export async function waitLuma(readLuma, predicate, { samples = 2, intervalMs = 500, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  let last;
  while (Date.now() < deadline) {
    last = await readLuma();
    streak = predicate(last) ? streak + 1 : 0;
    if (streak >= samples) return last;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  throw new Error(`luma condition not met: ${JSON.stringify(last)}`);
}

// Ждёт роста счётчиков медиа за окно windowMs хотя бы у minPeers соединений
// sinceMs — точка отсчёта таймаута (например, момент соединения, SC-009):
// последнее окно замера должно закончиться до sinceMs + timeoutMs
export async function expectMediaFlowing(page, {
  audio = true, video = false, minPeers = 1, windowMs = 4000, timeoutMs = 30000, sinceMs = Date.now(),
} = {}) {
  const deadline = sinceMs + timeoutMs;
  let lastReport = [];
  let isFirstWindow = true;
  while (isFirstWindow || Date.now() + windowMs <= deadline) {
    isFirstWindow = false;
    const before = await callMediaStats(page);
    await page.waitForTimeout(windowMs);
    const after = await callMediaStats(page);
    // Сверяем по УЧАСТНИКУ, а не по позиции в массиве: если между замерами
    // список соединений изменился (кто-то подключился или вышел), сравнение
    // по индексу считало прирост по разным парам (FR-052)
    const beforeByPeer = new Map(before.map((snapshot) => [snapshot.peer, snapshot]));
    lastReport = after.map((snapshot) => {
      const prev = beforeByPeer.get(snapshot.peer);
      return {
        peer: snapshot.peer,
        audioGrowth: prev ? snapshot.audio.bytesReceived - prev.audio.bytesReceived : 0,
        framesGrowth: prev ? snapshot.video.framesDecoded - prev.video.framesDecoded : 0,
        frameWidth: snapshot.video.frameWidth,
        frameHeight: snapshot.video.frameHeight,
      };
    });
    const flowing = lastReport.filter((entry) => (
      (!audio || entry.audioGrowth > 0)
      && (!video || (entry.framesGrowth > 0 && entry.frameWidth > 0 && entry.frameHeight > 0))
    ));
    if (flowing.length >= minPeers && Date.now() <= deadline) return lastReport;
  }
  // Пустой отчёт — живых соединений нет вовсе: звонок завершился. Состояние звонка и всех
  // соединений (включая закрытые) отличает это от «соединение есть, медиа не идёт»
  const diag = await page.evaluate(() => ({
    callState: window.parvaneCall?.state,
    peers: (globalThis.__parvaneE2ePeers || []).map((pc) => `${pc.connectionState}/${pc.iceConnectionState}`),
  })).catch((err) => ({ error: String(err) }));
  throw new Error(
    `media is not flowing within ${timeoutMs} ms: ${JSON.stringify(lastReport)}; call ${JSON.stringify(diag)}`,
  );
}

// Миниатюра в пузыре: картинка ненулевого размера и не однотонная
export async function thumbnailStats(bubble, selector = 'img.thumbnail') {
  const img = bubble.locator(selector).first();
  await img.waitFor({ state: 'attached', timeout: LOGIN_TIMEOUT_MS });
  // Ожидание загрузки ограничено: картинка без src/битая держит naturalWidth=0
  // вечно, и без предела сценарий висел сутками (17 сен, video_stream)
  return img.evaluate((element) => new Promise((resolve) => {
    const deadline = Date.now() + 20000;
    const measure = () => {
      if (!element.complete || !element.naturalWidth) {
        if (Date.now() > deadline) {
          resolve({
            width: element.naturalWidth, height: element.naturalHeight, mean: 0, variance: 0, alpha: 0,
            src: (element.currentSrc || element.src || '').slice(0, 80), timedOut: true,
          });
          return;
        }
        setTimeout(measure, 100);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(element, 0, 0, 32, 24);
      const { data } = ctx.getImageData(0, 0, 32, 24);
      const values = [];
      for (let i = 0; i < data.length; i += 4) values.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
      resolve({
        width: element.naturalWidth, height: element.naturalHeight, mean, variance, alpha: data[3],
      });
    };
    measure();
  }));
}

// Группа из списка чатов по названию: ждём заголовок в шапке (композер может
// быть недоступен, пока история подгружается)
export async function openGroupChatByTitle(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  await page.locator('.MiddleHeader').getByText(title).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Профиль группы → Edit → «Invite Links»: экран открывается, на нём основная
// ссылка `…/#+<токен>` и «Create a New Link» (spec 003: сервер хранит список
// ссылок, отзыв и параметры). Возвращает основную ссылку и закрывает правую
// колонку. Общая для сценариев инвайтов и мультидевайса: у всех устройств и
// админов одного владельца — одна и та же основная ссылка группы
export async function readInvitesScreen(page, title, { keepOpen = false } = {}) {
  await openGroupChatByTitle(page, title);
  const right = page.locator('#RightColumn');
  const invitesItem = right.locator('.ListItem').filter({ hasText: 'Invite Links' }).first();
  const editButton = right.getByRole('button', { name: 'Edit' });
  const screen = right.locator('.ManageInvites');
  // Повторный заход: колонка могла ещё закрываться (клик по шапке попадал в
  // уходящую колонку) или tt восстанавливал её сразу на экране управления либо
  // на самом экране ссылок — тогда пункта «Invite Links» в ней нет вовсе.
  // Шапку кликаем, только если колонка не показывает ни одного из трёх состояний
  const isShown = async (locator) => locator.isVisible().catch(() => false);
  for (let attempt = 0; ; attempt++) {
    try {
      if (!(await isShown(screen)) && !(await isShown(invitesItem)) && !(await isShown(editButton))) {
        await page.locator('.MiddleHeader .ChatInfo').click();
      }
      await Promise.race([
        screen.waitFor({ state: 'visible', timeout: 20000 }),
        invitesItem.waitFor({ state: 'visible', timeout: 20000 }),
        editButton.waitFor({ state: 'visible', timeout: 20000 }),
      ]);
      if (!(await isShown(screen))) {
        if (!(await isShown(invitesItem))) await editButton.click();
        await invitesItem.waitFor({ state: 'visible', timeout: 20000 });
        // Вечное «Loading» (нет fetchExportedChatInvites) держало пункт disabled
        await right.locator('.ListItem').filter({ hasText: 'Invite Links' }).filter({ hasText: /\d/ }).first()
          .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
        await invitesItem.click({ timeout: 8000 });
        await screen.waitFor({ state: 'visible', timeout: 8000 });
      }
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await page.waitForTimeout(1000);
    }
  }
  // Основная ссылка — значение readonly-поля LinkField (getByText его не видит)
  const linkInput = screen.locator('input[readonly]');
  await linkInput.first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.waitForFunction(
    () => /#\+[0-9a-f]{32}|\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}/
      .test(document.querySelector('.ManageInvites input[readonly]')?.value || ''),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS },
  );
  const links = await linkInput.evaluateAll((inputs) => inputs.map((input) => input.value));
  assert.equal(links.length, 1, `expected one primary invite link field, got ${links}`);
  assert.match(links[0], /#\+[0-9a-f]{32}|\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}/, 'invite link field is empty');
  assert.equal(await screen.getByText(/FolderLinkScreen|LinkActionShare/).count(), 0, 'raw lang key on the share button');
  await screen.getByText('Create a New Link').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const link = links[0].trim();
  if (!keepOpen) {
    // Назад к чату
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  return link.startsWith('http') ? link : `https://${link}`;
}

// Токен из ссылки-приглашения
// Адрес, который открывает ссылку-приглашение в приложении под тестом: путь
// `/join/<link_id>#<секрет>` (домен ссылки — домен сервера, а приложение
// сценария живёт на baseUrl); прежняя форма `#+<токен>` — для ссылок, уже
// лежащих в тестовых данных
export function inviteAppUrl(baseUrl, link) {
  const v2 = String(link).match(/\/join\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
  if (v2) return `${baseUrl.replace(/\/$/, '')}${v2[0]}`;
  const token = inviteTokenOf(link);
  return token ? `${baseUrl}#+${token}` : undefined;
}

export function inviteTokenOf(link) {
  return link.match(/#\+([0-9a-f]{32})/)?.[1];
}

// Создать группу через нативный пикер «New Group» (участники — по никам)
// `options.isJoinRequestNeeded` — отметить «Join by request» (spec 014): основная ссылка с одобрением
export async function createGroupViaUi(page, title, memberNames, options = {}) {
  await page.mouse.move(800, 360);
  await page.waitForTimeout(200);
  await page.locator('#LeftColumn').hover();
  await page.locator('[data-add-for="chats"]').click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const name of memberNames) {
    await memberSearch.fill(name);
    const row = page.locator('#LeftColumn .PeerPickerItem, #LeftColumn .ItemPickerItem').filter({ hasText: name }).first();
    await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    let selected = false;
    for (let attempt = 0; attempt < 6 && !selected; attempt++) {
      if (attempt % 2 === 0) await row.press(' ').catch(() => {});
      else await row.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      selected = (await row.locator('input[type="checkbox"]:checked').count()) > 0;
    }
    assert(selected, `picker row for ${name} is never selected`);
  }
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  // При повторном создании в DOM остаётся и прежний экран мастера — берём видимое поле
  const nameInput = page.getByLabel('Group name').locator('visible=true').first();
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(title);
  if (options.publicName) {
    // Публичное имя (spec 023): группа сразу публичная — сегмент «Публичная», затем поле имени (доска `ZpChat2`)
    await page.locator('#LeftColumn').getByRole('radio', { name: 'Public', exact: true })
      .locator('visible=true').first().click();
    await page.locator('#new-chat-public-name').locator('visible=true').first().fill(options.publicName);
  }
  if (options.isJoinRequestNeeded) {
    // Чекбокс форка перехватывает клик своей подписью — кликаем по подписи. Только в форме новой группы (левая
    // колонка): та же подпись есть на экране управления прежней группы справа (ManageJoinMode), и клик туда под
    // нагрузкой, пока правая колонка ещё закрывается, открывал окно «основная ссылка будет заменена» поверх всего
    const joinByRequest = page.locator('#LeftColumn .Checkbox').filter({ hasText: 'Join by request' })
      .locator('visible=true').first();
    // Отметка проверяется: клик, пришедшийся на перерисовку формы, терялся — группа создавалась без одобрения
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await joinByRequest.locator('input[type="checkbox"]').isChecked().catch(() => false)) break;
      await joinByRequest.getByText('Join by request', { exact: true }).click();
      await page.waitForTimeout(300);
    }
    assert(await joinByRequest.locator('input[type="checkbox"]').isChecked(), '«Join by request» не отмечен');
  }
  // Форма подставляет название по участникам, пока поле «не тронуто», — введённое может стереться
  for (let attempt = 0; attempt < 5 && await nameInput.inputValue() !== title; attempt++) {
    await nameInput.fill(title);
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Профиль группы → кнопка Edit → экран управления (`.Management`)
export async function openGroupManagement(page, title) {
  await openGroupChatByTitle(page, title);
  await page.locator('.MiddleHeader .ChatInfo').click();
  const right = page.locator('#RightColumn');
  const editButton = right.getByRole('button', { name: 'Edit' });
  const management = right.locator('.Management');
  await Promise.race([
    editButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    management.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
  ]);
  if (!(await management.isVisible())) await editButton.click();
  await management.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return right;
}

// Закрыть правую колонку (несколько Escape — вложенные экраны)
export async function closeRightColumn(page) {
  const column = page.locator('#RightColumn');
  for (let i = 0; i < 5; i++) {
    const visible = await column.isVisible().catch(() => false);
    const box = visible ? await column.boundingBox().catch(() => null) : null;
    if (!box || box.width < 10) break;
    // Кнопка закрытия/назад надёжнее Escape: Escape по пустой колонке закрывает чат
    const close = column.getByRole('button', { name: /Close|Back|Go back/ }).first();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

// Вызов метода провайдера из страницы (диаг-сборка): chat/user ищутся по
// названию/нику в глобальном состоянии
export async function callProviderForChat(page, method, chatTitle, userName, extra = {}) {
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  return page.evaluate(async ({ method: fn, title, name, args }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === title);
    const user = name ? Object.values(global.users.byId)
      .find((candidate) => candidate.usernames?.some(({ username }) => username === name)) : undefined;
    if (!chat || (name && !user)) return { error: `chat=${Boolean(chat)} user=${Boolean(user)}` };
    const map = (value) => {
      if (value === '$chat') return chat;
      if (value === '$user') return user;
      if (Array.isArray(value)) return value.map(map);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, map(inner)]));
      }
      return value;
    };
    let params = map(args);
    if (params && typeof params === 'object' && !Array.isArray(params) && (params.peer === chat || params.chat === chat)) {
      // Методы провайдера ждут то `peer`, то `chat` — даём оба
      params = { chatId: chat.id, chat, peer: chat, ...params, user: params.user ?? user };
    }
    const result = await window.__parvaneDiagCallApi(fn, ...(Array.isArray(params) ? params : [params]));
    return result === undefined ? { result: null } : { result };
  }, { method, title: chatTitle, name: userName, args: extra });
}

// Settings → Devices: строка устройства → модалка сеанса → пароль →
// «Terminate Session». Отзыв устройства сервер выполняет только с текущим
// паролем (P-07), поэтому без него кнопка выключена
// `rotateKeys` — режим «Sign out and change keys» (отзыв со сменой ключей); по умолчанию — «Just sign out»
export async function terminateSessionWithPassword(page, sessionRow, password, { rotateKeys } = {}) {
  await sessionRow.locator('[data-session-signout]').click();
  const terminateButton = page.getByRole('button', { name: 'Terminate Session' });
  await terminateButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await terminateButton.isDisabled(), true, 'Terminate Session is enabled without the password');
  if (rotateKeys) await page.locator('.Modal').getByText('Sign out and change keys', { exact: true }).click();
  await page.locator('.Modal input[type="password"]:visible').first().fill(password);
  await terminateButton.click();
  await terminateButton.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// «Terminate All Other Sessions» → выбор режима → пароль → подтверждение
export async function terminateAllSessionsWithPassword(page, password, { rotateKeys } = {}) {
  await page.locator('.SettingsActiveSessions [data-terminate-all]').click();
  const dialog = page.locator('.Modal').filter({ hasText: 'terminate all other sessions' });
  await dialog.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  if (rotateKeys) await dialog.getByText('Sign out and change keys', { exact: true }).click();
  await dialog.locator('input[type="password"]').fill(password);
  const confirm = dialog.getByRole('button', { name: 'Terminate All Other Sessions' });
  await confirm.click();
  await dialog.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
}

// Тост (`.Notification-container`) с текстом
export async function expectToast(page, text, timeout = LOGIN_TIMEOUT_MS) {
  await page.locator('.Notification-container').getByText(text).first().waitFor({ state: 'visible', timeout });
}

// Минимальный валидный PNG (сплошной цвет) — фикстура фото группы
// `isNoise` — случайные точки вместо заливки: файл не сжимается (большой файл для хода отправки)
export function buildPngBuffer(size = 64, rgb = [0x2a, 0xab, 0xee], { isNoise } = {}) {
  const { deflateSync } = zlib;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      raw.set(isNoise ? [Math.random() * 256, Math.random() * 256, Math.random() * 256] : rgb, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Протокол v2 (spec 007, D-12): при первом создании корня web показывает
// ключ восстановления нативным диалогом — сценарии его запоминают и закрывают
// Протокол v2: звонок (и доставка по ключу доступа, а не по жетону) возможны
// только между теми, кто уже переписывался в обе стороны, — собеседники
// обмениваются ключами доступа (D-08). Сценариям звонков нужен этот шаг перед
// первым вызовом
export async function exchangeMessages(aPage, aAddress, bPage, bAddress, tag) {
  const fromA = `hello-from-a-${tag}`;
  const fromB = `hello-from-b-${tag}`;
  await openPrivateChatStrict(aPage, bAddress);
  await sendText(aPage, fromA);
  await openPrivateChatStrict(bPage, aAddress);
  await findMessage(bPage, fromA).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bPage, fromB);
  await findMessage(aPage, fromB).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Настройки → Устройства (экран `SettingsActiveSessions`)
export async function openDevicesScreen(page) {
  // Непривязанное устройство web само открывает экран «Устройства» (код линковки,
  // ключ восстановления) — тогда он уже на месте
  const shown = page.locator('.SettingsActiveSessions');
  if (await shown.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false)) {
    // «Чаты» в боковой панели закрывают настройки: экран мог быть уходящим слайдом — перепроверяем
    await page.waitForTimeout(700);
    if (await shown.isVisible().catch(() => false)) return shown;
  }
  await openSettingsScreen(page, 'Devices and account');
  const screen = page.locator('.SettingsActiveSessions');
  await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  return screen;
}

// Из настроек — обратно к списку чатов
export async function closeSettings(page) {
  // Escape на самом списке чатов открывает общий поиск (поведение приложения): если настройки закрылись сами
  // между проверкой и нажатием, лишнее нажатие уводит в поиск — выходим из него тем же Escape и не считаем
  // поле поиска признаком списка, пока открыт экран поиска
  // Экран поиска остаётся в разметке и после выхода из него — «открыт» только в активном слайде перехода
  const isSearchOpen = () => page.evaluate(() => {
    const search = document.querySelector('#LeftColumn .LeftSearch');
    const slide = search?.closest('.Transition_slide');
    return Boolean(search && (!slide || slide.classList.contains('Transition_slide-active')));
  }).catch(() => false);
  const isAtChatList = async () => await page.locator('#telegram-search-input').isVisible() && !(await isSearchOpen());
  for (let attempt = 0; attempt < 8; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isAtChatList()) return;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
  throw new Error('не удалось вернуться из настроек к списку чатов');
}

// Протокол v2 включён по умолчанию (T135): второе устройство аккаунта обязано
// быть привязано (LINK-1 v2) — без линковки оно не входит в журнал устройств и
// ничего не получает. Оба устройства открывают Настройки → Устройства, коды
// сверки совпадают, старое подтверждает перенос; ждём подъёма v2 на новом
const LINK_DEVICE_TIMEOUT_MS = 90000;

export async function linkSecondDevice(oldPage, newPage) {
  const newScreen = await openDevicesScreen(newPage);
  await newScreen.getByText(/Waiting for confirmation/)
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const oldScreen = await openDevicesScreen(oldPage);
  const pendingText = newScreen.locator('[data-confirm-sign-in] [data-link-code]:not([data-link-code=""])');
  await pendingText.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const newCode = await pendingText.getAttribute('data-link-code');
  const offerItem = oldScreen.locator('[data-link-offer]:not([data-link-code=""])').first();
  await offerItem.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const oldCode = await offerItem.getAttribute('data-link-code');
  assert.equal(oldCode, newCode, 'коды сверки на устройствах не совпали');
  const isLinked = newPage.waitForEvent('console', {
    predicate: (message) => message.text().includes('[parvane] v2: готов'),
    timeout: LINK_DEVICE_TIMEOUT_MS,
  });
  await offerItem.locator('[data-link-confirm]').click();
  await oldPage.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await isLinked;
  await closeSettings(newPage);
  await closeSettings(oldPage);
}

// Экран ключа восстановления (spec 041 E4) перекрывает интерфейс — закрывается отметкой «Я сохранил ключ»
const recoveryKeyScreen = (page) => page.locator('[data-recovery-key-screen]');

async function closeRecoveryKeyScreen(screen, timeout) {
  await screen.locator('[data-recovery-key-saved]').check({ timeout });
  await screen.locator('[data-recovery-key-done]').click({ timeout });
}

// Обработчик закрывает экран ключа перед любым действием Playwright, когда бы он ни появился. Заодно — экран
// первого запуска (выбор модулей): сценарии со своей страницей без сида `preparePage` проходят его «Начать»
export async function autoDismissRecoveryKeyDialog(page) {
  await page.addLocatorHandler(recoveryKeyScreen(page), (screen) => closeRecoveryKeyScreen(screen));
  // Сид `parvane:modules-first-run` пустой — сценарий проверяет экран сам (`e2e_web_first_run.mjs`)
  const isFirstRunChecked = await page.evaluate(() => localStorage.getItem('parvane:modules-first-run') === '')
    .catch(() => false);
  if (isFirstRunChecked) return;
  await page.addLocatorHandler(page.locator('[data-first-run]'), (screen) => screen.locator('[data-first-run-done]').click());
}

// Текст экрана (в нём ключ) — сценарии берут ключ из него
export async function dismissRecoveryKeyDialog(page, timeout = 15000) {
  const screen = recoveryKeyScreen(page);
  try {
    await screen.waitFor({ state: 'visible', timeout });
  } catch {
    return undefined;
  }
  // На телефоне ключ — в две строки (доска `XpAuth`): целиком он в атрибуте, его — первым
  const key = await screen.locator('[data-recovery-key]').getAttribute('data-recovery-key').catch(() => undefined);
  const text = `${key || ''}\n${await screen.innerText()}`;
  // Экран мог закрыть обработчик `autoDismissRecoveryKeyDialog` посреди этих нажатий — тогда закрывать уже нечего
  await closeRecoveryKeyScreen(screen, 5000).catch(async (err) => {
    if (await screen.isVisible().catch(() => false)) throw err;
  });
  await screen.waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  return text;
}

// Отладка кэша истории: ключи записей `m:<uuid>` шифрованного хранилища (IndexedDB)
// этого браузера — видно, какие сообщения записаны на диск
export async function dumpHistoryCacheKeys(page, label) {
  const keys = await page.evaluate(async () => {
    const out = [];
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const storeName of Array.from(db.objectStoreNames)) {
        const all = await new Promise((resolve) => {
          const req = db.transaction(storeName).objectStore(storeName).getAllKeys();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve([]);
        });
        // Хранилище движка (spec 035): `g<поколение>/history-row/m:<uuid>`; прежнее: `rec:<адрес>:m:<uuid>`
        const records = all.map(String).map((key) => key.match(/(?:\/history-row\/|:)m:(.+)$/)?.[1])
          .filter(Boolean);
        if (records.length) out.push(`${name}/${storeName}: ${records.length} — ${records.join(' ')}`);
      }
      db.close();
    }
    return out;
  }).catch((e) => [`unavailable: ${e.message}`]);
  console.log(`--- history cache ${label} ---\n${keys.join('\n')}`);
}

// ── Смена даты посреди сценария (flaky, 20 ноя 2026) ─────────────────────────────────────────────────────────────
// Сценарии «Плана», «Здоровья», «Заметок» вычисляют «сегодня» один раз; прогон, перешедший через полночь, сверял бы
// прежний день с новым. До полуночи меньше `marginMin` минут — дождаться начала нового дня
const MIDNIGHT_SETTLE_MS = 30000;

export async function waitPastMidnight(marginMin = 12) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const left = midnight - now.getTime();
  if (left > marginMin * 60000) return;
  console.log(`--- до полуночи ${Math.ceil(left / 1000)} с: сценарий ждёт начала нового дня ---`);
  await new Promise((resolve) => {
    setTimeout(resolve, left + MIDNIGHT_SETTLE_MS);
  });
}

/** «Заметки»: открыть вид «List» / «Graph» / «Canvas». На компьютере (доска `ZdNotesX`) холсты — пункт колонки
 * «Холсты», список и граф — кнопки шапки; с холстов, справки и корзины к спискам ведёт «Все заметки» колонки. На
 * телефоне — вкладки под шапкой. `knowledge` — локатор `#ParvaneKnowledge`. */
export async function openNotesView(knowledge, name, timeout = 20000) {
  const column = knowledge.locator('[data-notes-column]');
  const isDesk = await column.isVisible().catch(() => false);
  if (!isDesk) {
    await knowledge.locator('[role="tablist"]').first().getByRole('tab', { name, exact: true }).click({ timeout });
  } else if (name === 'Canvas') {
    await column.locator('[data-notes-place="canvas"]').click({ timeout });
  } else {
    const head = knowledge.locator('[data-notes-desk-head]');
    if (!(await head.isVisible().catch(() => false))) await column.locator('[data-notes-all]').click({ timeout });
    await head.getByRole('tab', { name, exact: true }).click({ timeout });
  }
  const view = { List: 'notes', Graph: 'graph', Canvas: 'canvas' }[name];
  await knowledge.page().waitForFunction(
    (wanted) => document.querySelector('#ParvaneKnowledge')?.getAttribute('data-knowledge-view') === wanted,
    view, { timeout },
  );
}
