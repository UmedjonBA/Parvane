// spec 029: разделы «План», «Знания», «Облако» между web и desktop одного аккаунта (домены `parvane.planner.v1` и
// `cloud.v1` шарда domains). bob1 — web, первое v2-устройство: заводит задачу и событие «Плана» (через движок, как
// e2e_web_planner_sync.mjs), папку «Облака» и заметку «Знаний» (через UI). bob2 — desktop: привязывается грантом
// (Settings → Devices → Transfer, как в e2e_protocol_state_sync_desktop.mjs) и должен показать данные web в
// маркерах снимков «planner: …», «notes: …», «cloud: …» (parvane_sections_hooks.cpp). Затем desktop
// перезапускается с хуками PARVANE_AUTOPLANNER/AUTOCLOUD/AUTONOTES и заводит своё; web видит это ≤ 60 с.
// Пара `sections-desktop` в run_protocol_mixed_e2e.sh. Данные — выдуманные.
// Требует бинарь desktop/build-probe/bin/Telegram (-DPARVANE_DEV=ON: хуки читаются только в такой сборке); без
// него — SKIP.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { cloudDriver } from './e2e_web_cloud_lib.mjs';
import {
  buildLibraryShim,
  escapeRegExp,
  readDesktopLog,
  requireGatewayTcpUrl,
  skipWithoutDesktop,
  spawnDesktop,
  stopDesktop,
  waitDesktopLog,
} from './e2e_desktop_helpers.mjs';
import {
  LOGIN_TIMEOUT_MS,
  dismissRecoveryKeyDialog,
  openPlannerScreen,
  openProfile,
  preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-sections-desktop-password-1';
const WIDE = { width: 1440, height: 900 };
const STEP_TIMEOUT_MS = 20000;
const LINK_TIMEOUT_MS = 120000;
// Правка desktop → web: опрос открытого раздела 8 с, отправка по тишине, запас
const WEB_SYNC_BUDGET_MS = 60000;
const DESKTOP_MARKER_TIMEOUT_MS = 120000;

requireGatewayTcpUrl();
skipWithoutDesktop('protocol sections web ↔ desktop');

const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;

const S = String(Date.now()).slice(-6);
// web → desktop
const WEB_TASK = `Полить кактус ${S}`;
const WEB_EVENT = `Шахматы ${S}`;
const WEB_FOLDER = `Черновики ${S}`;
const WEB_NOTE = `Идеи ${S}`;
// desktop → web (без «,», «@», «|» в названиях — разделители хуков)
const DESK_TASK = `Купить грунт ${S}`;
const DESK_FOLDER = `Входящие ${S}`;
const DESK_NOTE = `Рецепт пирога ${S}`;
const DESK_NOTE_TEXT = 'Мука и яблоки';

let failures = 0;
function ok(label) {
  console.log(`ok   ${label}`);
}
function fail(label, error) {
  failures += 1;
  console.log(`FAIL ${label}${error ? `: ${String(error?.message || error).split('\n')[0]}` : ''}`);
}
// Мягкая проверка: провал печатается и считается, сценарий идёт дальше
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
// Жёсткий шаг: без него дальше проверять нечего
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

const plannerState = (page) => page.evaluate(() => window.__parvaneDiagCallApi('parvanePlannerState'));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: WIDE });
const consoleLog = [];
context.on('page', (page) => {
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[parvane] v2') || t.includes('линковк')) consoleLog.push(t);
  });
});
const bobWorkdir = mkdtempSync(join(tmpdir(), 'parvane-sections-desktop-'));
const libraryShim = buildLibraryShim(bobWorkdir);
let desktop;
let desktopLogOffset = '';

async function waitConsole(needle, timeout = LOGIN_TIMEOUT_MS) {
  await waitFor(() => Promise.resolve(consoleLog.some((l) => l.includes(needle))), timeout, `web: «${needle}»`);
}

const desktopWait = (re, timeout = DESKTOP_MARKER_TIMEOUT_MS) => waitDesktopLog(
  bobWorkdir, re, timeout, desktop, { since: desktopLogOffset },
);
// Маркеры снимков: «planner: status=ready loaded=1 задачи=[a;b] события=[…]» и т. п.
const plannerTaskRe = (name) => new RegExp(`planner: status=ready loaded=1 задачи=\\[[^\\]]*${escapeRegExp(name)}`);
const plannerEventRe = (name) => new RegExp(`planner: status=ready loaded=1 задачи=\\[[^\\]]*\\] события=\\[[^\\]]*${
  escapeRegExp(name)}`);
const cloudRe = (name) => new RegExp(`cloud: status=ready корень=\\[[^\\]]*${escapeRegExp(name)}`);
const notesRe = (name) => new RegExp(`notes: status=ready заметки=\\[[^\\]]*${escapeRegExp(name)}`);

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
  const bob = `secd-${S}-${process.pid}@local`;
  const { page } = await step('web: вход, v2-сессия готова', async () => {
    const session = await preparePage(context, bob, PASSWORD);
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
    await page.evaluate(async ({ task, event, today, tomorrow, suffix }) => {
      await window.__parvaneDiagCallApi('parvanePlannerApply', {
        changes: [
          {
            task: {
              id: `secd-task-${suffix}`, name: task, description: '', steps: [], status: 'queue', listId: '', rank: 1,
              day: today, start: '', due: '', minutes: null,
            },
          },
          {
            event: {
              id: `secd-event-${suffix}`, name: event, start: '18:00', end: '19:30', weekdays: null, day: tomorrow,
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

  await step(`web: в «Знаниях» заметка «${WEB_NOTE}»`, async () => {
    await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
    await knowledge.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    // Новое хранилище сначала пишет справку — после неё папка-хранилище уже есть
    await noteRow('Overview').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await knowledge.getByRole('button', { name: 'New note' }).click();
    const note = knowledge.locator('[data-note-id]');
    await note.first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    const title = note.getByLabel('Note title');
    await title.fill(WEB_NOTE);
    await title.blur();
    await noteRow(WEB_NOTE).waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  });

  // ── 2. desktop bob2: привязка грантом, данные web в маркерах ────────────────
  // Маркеры пишутся, только если задан хоть один хук: `watch` — шаг без действия (хук знает task/event)
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_PROTO_V2: '1',
    PARVANE_AUTOPLANNER: 'watch:-@0',
  });
  await step('desktop: просит линковку (корня не создаёт)', async () => {
    await desktopWait(/нужна линковка/, 90000);
    if (/v2: устройство создано/.test(readDesktopLog(bobWorkdir))) throw new Error('desktop создал собственный корень');
    await desktopWait(/линковка: оффер \(обязательство\) опубликован/, 60000);
  });

  await step('web: подтверждает оффер desktop (Settings → Devices → Transfer)', async () => {
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

  await step('desktop: привязан грантом линковки', async () => {
    await desktopWait(/линковка: грант v2 получен/, LINK_TIMEOUT_MS);
    await desktopWait(/v2: устройство привязано грантом линковки/, 60000);
  });

  await check(`desktop: задача web «${WEB_TASK}» в «Плане»`, () => desktopWait(plannerTaskRe(WEB_TASK)));
  await check(`desktop: событие web «${WEB_EVENT}» в «Плане»`, () => desktopWait(plannerEventRe(WEB_EVENT), 60000));

  // ── 3. desktop с хуками: облако и заметки поднимаются хуками после привязки ─
  // Перезапуск привязанного устройства: хуки отсчитывают секунды от готовности сессии; облако — до заметок, чтобы
  // заметка нашла уже загруженную папку-хранилище web (как alice2 в verify_sections.sh)
  await stopDesktop(desktop);
  desktopLogOffset = readDesktopLog(bobWorkdir);
  desktop = spawnDesktop(bobWorkdir, libraryShim, {
    PARVANE_AUTOLOGIN: `${bob}:${PASSWORD}`,
    PARVANE_PROTO_V2: '1',
    PARVANE_AUTOPLANNER: `task:${DESK_TASK}@20`,
    PARVANE_AUTOCLOUD: `folder:${DESK_FOLDER}@40`,
    PARVANE_AUTONOTES: `note:${DESK_NOTE}|${DESK_NOTE_TEXT}@55`,
  });
  await step('desktop: после перезапуска v2-сессия готова', () => desktopWait(/v2: готов/, 90000));
  await check(`desktop: папка web «${WEB_FOLDER}» в «Облаке»`, () => desktopWait(cloudRe(WEB_FOLDER)));
  await check(`desktop: заметка web «${WEB_NOTE}» в «Знаниях»`, () => desktopWait(notesRe(WEB_NOTE)));
  await check(`desktop: задача web «${WEB_TASK}» после перезапуска`, () => desktopWait(plannerTaskRe(WEB_TASK), 60000));

  const deskTask = await check(`desktop: своя задача «${DESK_TASK}» отправлена`, async () => {
    await desktopWait(new RegExp(`autoplanner task ${escapeRegExp(DESK_TASK)} → отправлено`));
    await desktopWait(plannerTaskRe(DESK_TASK), 60000);
  });
  const deskFolder = await check(`desktop: своя папка «${DESK_FOLDER}» создана`, async () => {
    await desktopWait(new RegExp(`autocloud folder ${escapeRegExp(DESK_FOLDER)} → ok`));
    await desktopWait(cloudRe(DESK_FOLDER), 60000);
  });
  const deskNote = await check(`desktop: своя заметка «${DESK_NOTE}» создана`, async () => {
    await desktopWait(new RegExp(`autonotes note ${escapeRegExp(DESK_NOTE)} → создана`));
    await desktopWait(notesRe(DESK_NOTE), 60000);
  });

  // ── 4. web видит правки desktop ≤ 60 с (раздел открыт — частый опрос) ──────
  const timed = async (label, fn) => {
    const started = Date.now();
    await fn();
    console.log(`     ${label} на web через ${Date.now() - started} мс`);
  };
  if (deskTask) {
    await check(`web: задача desktop «${DESK_TASK}» в «Плане» ≤ 60 с`, () => timed('задача', async () => {
      await openPlannerScreen(page, 'calendar');
      await waitFor(async () => (await plannerState(page))?.state?.tasks?.some((t) => t.name === DESK_TASK),
        WEB_SYNC_BUDGET_MS, `задача «${DESK_TASK}» в состоянии «Плана»`);
    }));
  } else fail(`web: задача desktop «${DESK_TASK}» (desktop её не завёл)`);
  if (deskFolder) {
    await check(`web: папка desktop «${DESK_FOLDER}» в «Облаке» ≤ 60 с`, () => timed('папка', async () => {
      await cloud.open();
      await cloud.item(DESK_FOLDER).waitFor({ state: 'visible', timeout: WEB_SYNC_BUDGET_MS });
    }));
  } else fail(`web: папка desktop «${DESK_FOLDER}» (desktop её не создал)`);
  if (deskNote) {
    await check(`web: заметка desktop «${DESK_NOTE}» в «Знаниях» ≤ 60 с`, () => timed('заметка', async () => {
      await sidebar.getByRole('tab', { name: 'Knowledge' }).click();
      await knowledge.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await noteRow(DESK_NOTE).waitFor({ state: 'visible', timeout: WEB_SYNC_BUDGET_MS });
      await noteRow(DESK_NOTE).click();
      await knowledge.locator('[data-note-body]').getByText(DESK_NOTE_TEXT)
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
    }));
  } else fail(`web: заметка desktop «${DESK_NOTE}» (desktop её не создал)`);

  // ── инварианты ──────────────────────────────────────────────────────────────
  if (BACKEND_DIR) {
    await check('на сервере разделы только шифртекстом', () => {
      const words = [WEB_TASK, WEB_EVENT, WEB_FOLDER, WEB_NOTE, DESK_TASK, DESK_FOLDER, DESK_NOTE];
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
  await check('desktop: без фатальных ошибок и сбоев записей v2', () => {
    // tdesktop начинает log.txt заново при перезапуске — первый запуск берём из сохранённого
    const current = readDesktopLog(bobWorkdir);
    const log = current.startsWith(desktopLogOffset) ? current : desktopLogOffset + current;
    if (/Fatal|Unexpected in |запись не открыта|ошибка записи|E2E не удался/.test(log)) {
      throw new Error('в журнале desktop есть сбой');
    }
  });
} catch (error) {
  if (!failures) fail('сценарий', error);
  console.error(error);
} finally {
  if (failures) {
    console.error(`журнал web: ${consoleLog.join('\n')}`);
    console.error(`хвост лога desktop:\n${readDesktopLog(bobWorkdir).slice(-4000)}`);
  }
  await stopDesktop(desktop);
  await browser.close();
}

if (failures) {
  console.log(`e2e_protocol_sections_desktop: FAIL (${failures})`);
  process.exit(1);
}
console.log('e2e_protocol_sections_desktop: OK');
