// spec 031 (T068): разделы «План», «Знания», «Облако» между web и Telegram X одного аккаунта (домены
// `parvane.planner.v1` и `cloud.v1` шарда domains). Запускается из `android/tgx_protocol_sections_web_flow.sh`
// (стек, эмулятор, vite preview и logcat X в $TGX_LOG уже подняты).
// web — первое v2-устройство нового аккаунта: заводит задачу и событие «Плана» (через движок, как
// e2e_protocol_sections_desktop.mjs), папку «Облака» и заметку «Знаний» (через UI). X входит тем же аккаунтом с
// чистыми данными, просит привязку, web подтверждает (Settings → Devices → Transfer); X показывает данные web в
// маркерах снимков хаба разделов («planner: …», «notes: …», «cloud: …»). Затем X заводит своё теми же вызовами ядра,
// что экраны (e2e-хук: planner_add, note_create, cloud_folder), web видит это ≤ 60 с. Данные — выдуманные.
// Строки `ok …` / `FAIL …` в stdout разбирает раннер.
import { execFileSync } from 'node:child_process';
import {
  readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  LOGIN_TIMEOUT_MS,
  dismissRecoveryKeyDialog,
  openPlannerScreen,
  openProfile,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-sections-android-password-1';
const OUT = process.env.PV_ANDROID_OUT;
const TGX_LOG = process.env.TGX_LOG;
const GW_PORT = process.env.PV_GW_WS_PORT || '9222';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const PKG = 'org.parvane.tgx';
const STEP_TIMEOUT_MS = 20000;
const LINK_TIMEOUT_MS = 120000;
const X_MARKER_TIMEOUT_MS = 150000;
// Правка X → web: опрос открытого раздела 8 с, отправка по тишине, запас
const WEB_SYNC_BUDGET_MS = 60000;

const S = String(Date.now()).slice(-6);
// буквы вместо цифр в задаче X: ввод текстом принял бы цифры за время/количество
const W = S.replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
const WEB_TASK = `Полить кактус ${S}`;
const WEB_EVENT = `Шахматы ${S}`;
const WEB_FOLDER = `Черновики ${S}`;
const WEB_NOTE = `Идеи ${S}`;
const WEB_SHARED = `Общая ${S}`;
const X_TASK = `Купить хлеб ${W}`;
const X_FOLDER = `С телефона ${S}`;
const X_NOTE = `Заметка с телефона ${S}`;

let failures = 0;
function ok(label) {
  console.log(`ok ${label}`);
}
function fail(label, error) {
  failures += 1;
  console.log(`FAIL ${label}${error ? `: ${String(error?.message || error).split('\n')[0]}` : ''}`);
}
async function check(label, fn) {
  try {
    await fn();
    ok(label);
    return true;
  } catch (error) {
    fail(label, error);
    return false;
  }
}
async function step(label, fn) {
  try {
    const result = await fn();
    ok(label);
    return result;
  } catch (error) {
    fail(label, error);
    throw error;
  }
}

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 60000 });
}
// Файл в /data/local/tmp гостя (читает debug-сборка шва)
function put(name, text) {
  const file = join(OUT, `put-${name}`);
  writeFileSync(file, text);
  adb('push', file, `/data/local/tmp/${name}`);
  adb('shell', 'chmod', '644', `/data/local/tmp/${name}`);
}
// Отметка в logcat X: дальше ищем только новые строки
let xMark = 0;
let xStartMark = 0;
const xLog = () => {
  try {
    return readFileSync(TGX_LOG, 'utf8');
  } catch {
    return '';
  }
};
const markX = () => {
  xMark = xLog().length;
};
function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function waitFor(fn, timeout, what) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn().catch(() => false)) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  throw new Error(`не дождались: ${what}`);
}
const xWait = (re, timeout = X_MARKER_TIMEOUT_MS) => waitFor(
  () => Promise.resolve(re.test(xLog().slice(xMark))), timeout, `X: ${re.source}`,
);
// Команда e2e-хука шва (файл читается раз в 3 с) — ждём её выполнения
async function xCommand(command) {
  markX();
  put('parvane-e2e-cmd', JSON.stringify(command));
  await xWait(new RegExp(`e2e-cmd ${command.op} →`), 30000);
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plannerTaskRe = (name) => new RegExp(`planner: status=ready loaded=1 задачи=\\[[^\\]]*${escapeRegExp(name)}`);
const plannerEventRe = (name) => new RegExp(`события=\\[[^\\]]*${escapeRegExp(name)}`);
const cloudRe = (name) => new RegExp(`cloud: status=ready корень=\\[[^\\]]*${escapeRegExp(name)}`);
const notesRe = (name) => new RegExp(`notes: status=ready заметки=\\[[^\\]]*${escapeRegExp(name)}`);

const plannerState = (page) => page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const consoleLog = [];
context.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2') || t.includes('линковк')) consoleLog.push(t);
  });
});
async function waitConsole(needle, timeout = LOGIN_TIMEOUT_MS) {
  await waitFor(() => Promise.resolve(consoleLog.some((l) => l.includes(needle))), timeout, `web: «${needle}»`);
}
async function closeSettings(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    if (await page.locator('#telegram-search-input').isVisible()) return;
    // eslint-disable-next-line no-await-in-loop
    await page.keyboard.press('Escape');
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(500);
  }
}

try {
  const user = `secx-${S}@local`;
  const { page } = await step('web: вход, v2-сессия готова', async () => {
    const session = await preparePage(context, user, PASSWORD);
    await waitConsole('v2: готов');
    await dismissRecoveryKeyDialog(session.page);
    await waitConsole('v2: журнал состояния подключён');
    return session;
  });
  const sidebar = page.locator('#FoldersSidebar');
  const knowledge = page.locator('#ParvaneKnowledge');
  const noteRow = (title) => knowledge.locator(`[data-note-row="${title}"]`);
  const cloud = cloudDriver(page);

  // ── 1. web: «План» (задача, событие), «Облако» (папка), «Знания» (заметка) ──
  await step(`web: в «Плане» задача «${WEB_TASK}» и событие «${WEB_EVENT}»`, async () => {
    await openPlannerScreen(page, 'calendar');
    await waitFor(async () => (await plannerState(page))?.status === 'ready', LOGIN_TIMEOUT_MS, '«План» готов');
    await page.evaluate(async ({
      task, event, today, tomorrow, suffix,
    }) => {
      await window.__parvaneDiagCallApi('parvanePlannerApply', {
        changes: [
          {
            task: {
              id: `secx-task-${suffix}`, name: task, description: '', steps: [], status: 'queue', listId: '', rank: 1,
              day: today, start: '', due: '', minutes: null,
            },
          },
          {
            event: {
              id: `secx-event-${suffix}`, name: event, start: '18:00', end: '19:30', weekdays: null, day: tomorrow,
              allDay: false, isHoliday: false, description: '',
            },
          },
        ],
      });
      await window.__parvaneDiagCallApi('parvanePlannerFlush');
    }, {
      task: WEB_TASK, event: WEB_EVENT, today: dayKey(0), tomorrow: dayKey(1), suffix: S,
    });
    await waitFor(async () => {
      const state = await plannerState(page);
      return !state?.hasPending
        && state?.state?.tasks?.some((t) => t.name === WEB_TASK)
        && state?.state?.events?.some((e) => e.name === WEB_EVENT);
    }, STEP_TIMEOUT_MS, 'задача и событие записаны на сервер');
  });
  await step(`web: в «Облаке» папка «${WEB_FOLDER}»`, async () => {
    await cloud.open();
    await cloud.add('New folder');
    await page.locator('#parvane-cloud-name').fill(WEB_FOLDER);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await cloud.item(WEB_FOLDER).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(`web: в «Облаке» общая папка «${WEB_SHARED}»`, async () => {
    await cloud.root();
    await cloud.add('New shared folder');
    await page.locator('#parvane-cloud-shared-name').fill(WEB_SHARED);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const sheet = page.locator('.Modal .modal-dialog').filter({ hasText: 'Access to' });
    await sheet.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await sheet.getByRole('button', { name: 'Close', exact: true }).last().click();
    await cloud.root();
    await cloud.folderRow(WEB_SHARED).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });
  await step(`web: в «Знаниях» заметка «${WEB_NOTE}»`, async () => {
    await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
    await knowledge.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    await noteRow('Overview').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await knowledge.getByRole('button', { name: 'New note' }).click();
    const note = knowledge.locator('[data-note-id]');
    await note.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    const title = note.getByLabel('Note title');
    await title.fill(WEB_NOTE);
    await title.blur();
    await noteRow(WEB_NOTE).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });

  // ── 2. X: чистый вход тем же аккаунтом → просьба привязки → web подтверждает ──
  await step('X: вход тем же аккаунтом просит привязку (корня не создаёт)', async () => {
    adb('shell', 'am', 'force-stop', PKG);
    adb('shell', 'pm', 'clear', PKG);
    adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
    adb('shell', 'rm', '-f', '/data/local/tmp/parvane-e2e-cmd', '/data/local/tmp/parvane-autolink');
    adb('reverse', `tcp:${GW_PORT}`, `tcp:${GW_PORT}`);
    put('parvane-gateway', `ws://127.0.0.1:${GW_PORT}/ws`);
    put('parvane-autologin', `${user}:${PASSWORD}`);
    markX();
    xStartMark = xMark;
    adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
    await xWait(/устройству нужна привязка/, 120000);
    if (/v2: устройство создано/.test(xLog().slice(xMark))) throw new Error('X создал собственный корень');
  });
  await step('web: подтверждает оффер X (Settings → Devices → Transfer)', async () => {
    await openProfile(page);
    await page.getByRole('button', { name: 'Devices' }).click();
    const screen = page.locator('.SettingsActiveSessions');
    await screen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    const offerItem = screen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
    await offerItem.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await offerItem.locator('.ListItem-button').click();
    const transferButton = page.getByRole('button', { name: 'Transfer', exact: true });
    await transferButton.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await transferButton.click();
    await page.getByText('History transferred').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await closeSettings(page);
  });
  await step('X: привязан грантом, v2-сессия готова', async () => {
    await xWait(/привязка: грант v2 получен/, LINK_TIMEOUT_MS);
    await xWait(/v2: готов/, 90000);
  });

  // ── 3. X видит данные web в снимках хаба разделов ──────────────────────────
  // Снимки хаба могут прийти раньше команды (хаб грузит разделы сам после привязки) — ищем от запуска X:
  // названий данных web до привязки в журнале X быть не может
  const linkedMark = xStartMark;
  await xCommand({ op: 'sections', section: 'calendar' });
  xMark = linkedMark;
  await check(`X: задача web «${WEB_TASK}» в «Плане»`, () => xWait(plannerTaskRe(WEB_TASK)));
  await check(`X: событие web «${WEB_EVENT}» в «Плане»`, () => xWait(plannerEventRe(WEB_EVENT), 60000));
  await xCommand({ op: 'sections', section: 'knowledge' });
  xMark = linkedMark;
  await check(`X: папка web «${WEB_FOLDER}» в «Облаке»`, () => xWait(cloudRe(WEB_FOLDER)));
  await check(`X: заметка web «${WEB_NOTE}» в «Знаниях»`, () => xWait(notesRe(WEB_NOTE)));
  // Своя общая папка — отдельный контейнер; телефон обязан подключить его (прод 26 окт: общих папок не было)
  await check(`X: общая папка web «${WEB_SHARED}» в «Облаке»`, () => xWait(new RegExp(`cloud: status=ready .*папки=\\[[^\\]]*${escapeRegExp(WEB_SHARED)}:owned`)));

  // ── 4. X заводит своё → web видит ≤ 60 с ──────────────────────────────────
  const timed = async (label, fn) => {
    const started = Date.now();
    await fn();
    console.log(`     ${label} на web через ${Date.now() - started} мс`);
  };
  await xCommand({ op: 'planner_add', text: X_TASK });
  const xTask = /planner_add → ok/.test(xLog().slice(xMark)) || await xWait(/planner_add → ok/, 30000).then(() => true, () => false);
  if (xTask) {
    ok(`X: задача «${X_TASK}» добавлена вводом текстом`);
    await check(`web: задача X «${X_TASK}» в «Плане» ≤ 60 с`, () => timed('задача', async () => {
      await openPlannerScreen(page, 'calendar');
      await waitFor(async () => (await plannerState(page))?.state?.tasks?.some((t) => t.name === X_TASK),
        WEB_SYNC_BUDGET_MS, `задача «${X_TASK}» в состоянии «Плана»`);
    }));
  } else fail(`X: задача «${X_TASK}» не добавлена`);
  await xCommand({ op: 'cloud_folder', name: X_FOLDER });
  if (await xWait(cloudRe(X_FOLDER), 60000).then(() => true, () => false)) {
    ok(`X: папка облака «${X_FOLDER}» создана`);
    await check(`web: папка X «${X_FOLDER}» в «Облаке» ≤ 60 с`, () => timed('папка', async () => {
      await cloud.open();
      await cloud.item(X_FOLDER).waitFor({ state: 'visible', timeout: WEB_SYNC_BUDGET_MS });
    }));
  } else fail(`X: папка облака «${X_FOLDER}» не создана`);
  await xCommand({ op: 'note_create', title: X_NOTE, text: 'Строка с телефона' });
  if (await xWait(notesRe(X_NOTE), 60000).then(() => true, () => false)) {
    ok(`X: заметка «${X_NOTE}» создана`);
    await check(`web: заметка X «${X_NOTE}» в «Знаниях» ≤ 60 с`, () => timed('заметка', async () => {
      await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
      await knowledge.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await noteRow(X_NOTE).waitFor({ state: 'visible', timeout: WEB_SYNC_BUDGET_MS });
    }));
  } else fail(`X: заметка «${X_NOTE}» не создана`);

  // ── инварианты ──────────────────────────────────────────────────────────────
  if (BACKEND_DIR) {
    await check('на сервере разделы только шифртекстом', () => {
      const words = [WEB_TASK, WEB_EVENT, WEB_FOLDER, WEB_NOTE, X_TASK, X_FOLDER, X_NOTE];
      const leaks = new Set();
      for (const name of readdirSync(BACKEND_DIR)) {
        if (!/^(domains|cloud)\.db/.test(name)) continue;
        const path = join(BACKEND_DIR, name);
        if (!statSync(path).isFile()) continue;
        const text = readFileSync(path).toString('utf8');
        words.filter((w) => text.includes(w)).forEach((w) => leaks.add(`${w} (${name})`));
      }
      if (leaks.size) throw new Error(`открытый текст: ${[...leaks].join(', ')}`);
    });
  }
} catch (error) {
  if (!failures) fail('сценарий', error);
  console.error(error);
} finally {
  if (failures) console.error(`журнал web: ${consoleLog.join('\n')}`);
  await browser.close();
}

if (failures) {
  console.log(`e2e_protocol_sections_android: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e_protocol_sections_android: OK');
