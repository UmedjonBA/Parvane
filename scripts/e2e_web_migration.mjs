// Разовый перенос web (spec 035, T109; contracts/migration.md «Канонические выгрузки и сверка»). Профили браузера,
// снятые ПРЕЖНИМ кодом (сид T006 нынешним кодом исходной точки T008 — `run_web_migration_e2e.sh seed`), открываются
// НОВЫМ web-dist на копии баз сида; после переноса — выгрузка модели движка (`parvaneAuditDump({source: 'engine'})`)
// и сверка с выгрузкой «до» (`scripts/migration_audit_diff.py`): потеряно 0, изменено 0.
//
// Вариант (`PARVANE_MIGRATION_VARIANT`):
//   plain — все профили сида (alice1, alice2 — второе устройство, bob, carol — хранилище под PIN);
//   M2/M4 — профиль alice1: вкладка закрыта посреди переноса в точке M2 (часть строк поколения 1 записана) либо M4
//           (после `Migrated` журнала личного состояния), затем открыта снова — перенос доходит до конца, сверка 0/0.
//   month — «устройство отсутствовало» (T142, US1 п. 3; conformance README): переносится alice1 (журнал личного
//           состояния state.v1 → state.v2 на сервере), затем на ней — новая папка (личное состояние) и сообщение
//           bob (журнал истории; копия своим устройствам — в инбокс alice2); alice1 закрыта; messenger
//           останавливается и на его базе один раз идёт `messenger --gc-as-of <сейчас + 31 сутки>` — все плановые
//           чистки «как через месяц» (инбоксы старше 30 суток вычищены; часы стенда не трогаются); затем переносится
//           alice2 (второе устройство аккаунта, выключенное всё это время): сверка с её выгрузкой «до» — потеряно 0;
//           правка alice1 видна (строки личного состояния, изменённые alice1, — с тем же дайджестом, что у alice1;
//           папка — в состоянии и в UI), сообщение alice1 — из журнала истории (инбокс уже пуст).
//           Проверка «ловит потерю»: `PARVANE_MIGRATION_MONTH_BREAK=history|state` — перед чисткой из базы
//           messenger стираются записи alice1 после переноса в журнале истории (или личного состояния) — шаг обязан
//           упасть; `PARVANE_MIGRATION_MONTH_GC=0` — перезапуск без чистки (контроль: сообщение тогда доезжает
//           инбоксом, и потерю журнала истории сценарий не видит — поэтому и нужна чистка «как через месяц»).
// Каждый вариант — на своей копии профилей и баз (раннер поднимает стек заново). Данные — выдуманные (сид).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { readDiagJournal } from './e2e_web_helpers.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SEED = process.env.PARVANE_MIGRATION_SEED;
const OUT = process.env.PARVANE_MIGRATION_OUT;
const VARIANT = process.env.PARVANE_MIGRATION_VARIANT || 'plain';
const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
const READY_TIMEOUT_MS = 240000;
const SETTLE_MS = 8000;
const HALT = { M2: 2, M4: 4 };
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
const MONTH_SECS = 31 * 86400;
const MONTH_BREAK = process.env.PARVANE_MIGRATION_MONTH_BREAK || '';
const MONTH_GC = process.env.PARVANE_MIGRATION_MONTH_GC !== '0';

assert.ok(SEED && OUT && BASE_URL && GATEWAY_URL, 'нужны PARVANE_MIGRATION_SEED, _OUT, PARVANE_E2E_BASE_URL, _GATEWAY_URL');
const summary = JSON.parse(readFileSync(join(SEED, 'seed-summary.json'), 'utf8'));
const pins = summary.storagePin || {};
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const results = [];

// Профиль сида — копией (сид не трогается); gateway — тот же адрес, что записан в профиле
async function launch(dir, { halt, chunk, pin } = {}) {
  const context = await chromium.launchPersistentContext(dir, { viewport: { width: 1400, height: 900 } });
  await context.addInitScript(({ gateway, haltAt, chunkSize }) => {
    localStorage.setItem('parvane:gateway', gateway);
    if (haltAt) {
      localStorage.setItem('parvane:e2e:migrationHalt', String(haltAt));
      localStorage.setItem('parvane:e2e:migrationChunk', String(chunkSize || 3));
    } else {
      localStorage.removeItem('parvane:e2e:migrationHalt');
      localStorage.removeItem('parvane:e2e:migrationChunk');
    }
  }, { gateway: GATEWAY_URL, haltAt: halt || 0, chunkSize: chunk || 0 });
  const page = context.pages()[0] || await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    const text = m.text();
    if (text.includes('[parvane]')) logs.push(text.slice(0, 300));
    if (logs.length > 300) logs.shift();
  });
  // Исключение страницы на старте журнал провайдера не видит — без этого сбой выглядел как одна строка «initApi»
  page.on('pageerror', (e) => logs.push(`pageerror: ${String(e?.stack || e).slice(0, 600)}`));
  // Хранилище под PIN: прежний код спрашивал PIN окном — новый тоже (перенос — после верного PIN)
  page.on('dialog', (d) => { void (pin ? d.accept(pin) : d.dismiss()); });
  await page.goto(BASE_URL);
  return { context, page, logs };
}

async function waitReady(page) {
  await loginIfAsked(page);
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: READY_TIMEOUT_MS,
  });
  await page.waitForFunction(async () => {
    const state = await window.__parvaneDiagCallApi('parvaneDiagMigration').catch(() => undefined);
    return state?.open === 'OPEN_STATE_READY';
  }, undefined, { timeout: READY_TIMEOUT_MS, polling: 1000 });
}

// Сессия не возобновилась (профиль без «не выходить» либо сид старше суток без активности — SESSION_IDLE_LIMIT_MS)
// — вход паролем сида тем же устройством. Хук диагностики есть только в главном экране, после входа: ждать его
// раньше экрана пароля нельзя
async function loginIfAsked(page, { waitMain = true } = {}) {
  const password = page.locator('.Transition_slide-active > #auth-password-form');
  const left = page.locator('#LeftColumn');
  await Promise.race([
    password.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS }),
    left.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS }),
  ]).catch(() => undefined);
  if (await password.isVisible().catch(() => false)) {
    await password.locator('#sign-in-password').fill(summary.password);
    await password.getByRole('button', { name: 'Next' }).click();
    if (waitMain) await left.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
  }
}

function diff(before, after, name) {
  const report = join(OUT, `diff-${name}.json`);
  let text;
  let code = 0;
  try {
    text = execFileSync('python3', [join(ROOT, 'scripts/migration_audit_diff.py'), before, after, '--json'],
      { encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? 1;
    text = String(e.stdout || '');
  }
  writeFileSync(report, text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { code, report: parsed };
}

// Выгрузка JSONL → Map «вид\tключ» → дайджест
function loadDump(path) {
  const map = new Map();
  readFileSync(path, 'utf8').split('\n').filter(Boolean).forEach((line) => {
    const { kind, key, digest } = JSON.parse(line);
    map.set(`${kind}\t${key}`, digest);
  });
  return map;
}

// Что изменилось и что добавилось от выгрузки a к выгрузке b (ключи «вид\tключ»)
function delta(a, b) {
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  return { changed, added };
}

// Журнал диагностики клиента (вход, перенос, журнал состояния) и снимок экрана — при сбое: в консоль провайдер почти
// не пишет
async function saveFailure(session, who) {
  const diag = await readDiagJournal(session.page).catch((err) => [{ k: `diag: ${String(err)}` }]);
  const diagLines = diag.slice(-300).map((d) => `${d.t ? new Date(d.t).toISOString().slice(11, 23) : ''} ${d.k} ${(d.d || '').slice(0, 300)}`);
  writeFileSync(join(OUT, `log-${who}.txt`), [...session.logs, '--- diag ---', ...diagLines].join('\n'));
  await session.page.screenshot({ path: join(OUT, `fail-${who}.png`) }).catch(() => undefined);
}

// keep — не закрывать вкладку после удачной сверки (вернуть сессию и путь выгрузки «после»); verify — своя проверка
// вместо «только фото группы» (month)
async function migrateProfile(who, { keep = false, verify } = {}) {
  const started = Date.now();
  const src = join(SEED, 'profiles', `web-${who}`);
  const before = join(SEED, 'audit', `web-${who}.jsonl`);
  assert.ok(existsSync(src), `нет профиля сида ${src}`);
  assert.ok(existsSync(before), `нет выгрузки «до» ${before}`);
  const dir = join(OUT, `profile-${who}`);
  cpSync(src, dir, { recursive: true });
  const pin = pins[who];
  const halt = HALT[VARIANT];
  let session = await launch(dir, { halt, pin });
  if (halt) {
    // Перенос может встать раньше главного экрана — после пароля главный экран не ждём
    await loginIfAsked(session.page, { waitMain: false });
    // Перенос встал в точке (шаг этой точки уже на диске) — вкладка закрывается, как при обрыве
    await session.page.waitForFunction((n) => (window.__parvaneMigrationHalted || 0) >= n, halt, {
      timeout: READY_TIMEOUT_MS, polling: 200,
    });
    const point = await session.page.evaluate(() => window.__parvaneMigrationHalted);
    await session.context.close();
    results.push({ step: `${who}: вкладка закрыта в M${point}`, ok: true });
    session = await launch(dir, { pin });
  }
  try {
    await waitReady(session.page);
    // FR-071: частная группа сида с открытым фото — владелец (alice1, первым из устройств аккаунта) перезаливает
    // его с секретом; выгрузка — после перезалива
    const reuploads = who === 'alice1' && summary.photoGroup;
    if (reuploads) {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!session.logs.some((l) => /фото группы [0-9a-f]+ перезалито с секретом/.test(l))) {
        if (Date.now() > deadline) throw new Error('фото частной группы не перезалито (needs{group_avatar_reupload})');
        // eslint-disable-next-line no-await-in-loop
        await pause(1000);
      }
      results.push({ step: `${who}: открытое фото группы перезалито с секретом`, ok: true });
    }
    await pause(SETTLE_MS);
    const engine = await session.page.evaluate(() => window.__parvaneDiagCallApi('parvaneAuditDump', { source: 'engine' }));
    const host = await session.page.evaluate(() => window.__parvaneDiagCallApi('parvaneAuditDump'));
    assert.ok(engine, 'пустая выгрузка модели');
    const after = join(OUT, `web-${who}.engine.jsonl`);
    writeFileSync(after, engine);
    writeFileSync(join(OUT, `web-${who}.host.jsonl`), host || '');
    const fromEngine = diff(before, after, `${who}-engine`);
    const fromHost = diff(before, join(OUT, `web-${who}.host.jsonl`), `${who}-host`);
    // Ожидаемое изменение — только сведения группы с перезалитым фото (новый файл и отпечаток секрета, FR-071):
    // одна строка вида `group`; у владельца, перезалившего фото, — ровно одна
    const r = fromEngine.report;
    const changed = r.changed_by_kind || {};
    const onlyPhoto = Object.keys(changed).every((k) => k === 'group') && (changed.group || 0) <= 1
      && (!reuploads || changed.group === 1);
    let ok = fromEngine.code === 0 || (summary.photoGroup && r.lost === 0 && !r.unexpected_added && onlyPhoto);
    let detail;
    if (verify) ({ ok, detail } = await verify({ session, after, report: r }));
    results.push({
      step: `${who}: сверка`, ok, ms: Date.now() - started, engine: fromEngine.report, host: fromHost.report, detail,
    });
    console.log(`${ok ? 'OK' : 'СБОЙ'}: ${who} — модель ${JSON.stringify(fromEngine.report).slice(0, 300)}`);
    if (detail) console.log(`  ${JSON.stringify(detail).slice(0, 800)}`);
    if (!ok) await saveFailure(session, who);
    if (keep && ok) return { session, after };
  } catch (e) {
    results.push({ step: `${who}: перенос`, ok: false, error: String(e?.message || e).slice(0, 600) });
    await saveFailure(session, who);
    console.log(`СБОЙ: ${who}: ${String(e?.message || e).slice(0, 300)}`);
  }
  await session.context.close().catch(() => undefined);
  return undefined;
}

// ---- month: «устройство отсутствовало» (T142) ----

// Запрос к базе messenger стенда (sqlite3 из Python: в node встроенного драйвера нет)
function messengerDb(sql, params = []) {
  const db = join(BACKEND_DIR, 'messenger.db-v2.db');
  const code = [
    'import json, sqlite3, sys',
    'c = sqlite3.connect(sys.argv[1], timeout=30)',
    'r = c.execute(sys.argv[2], json.loads(sys.argv[3])).fetchall()',
    'c.commit()',
    'print(json.dumps(r))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code, db, sql, JSON.stringify(params)], { encoding: 'utf8' }));
}

const maxSeq = (table, user) => messengerDb(`SELECT COALESCE(MAX(seq), 0) FROM ${table} WHERE user = ?`, [user])[0][0];

async function waitFor(what, fn, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await pause(1000);
  }
}

// Перезапуск messenger раннером (`run_web_e2e.sh`, файл `messenger.restart`): аргументы — разовый запуск шарда
// между остановкой и подъёмом (`--gc-as-of …`), его stdout — `messenger.once.out`
async function restartMessenger(onceArgs) {
  const flag = join(BACKEND_DIR, 'messenger.restarted');
  rmSync(flag, { force: true });
  writeFileSync(join(BACKEND_DIR, 'messenger.restart'), onceArgs);
  await waitFor('перезапуск messenger (messenger.restart)', () => existsSync(flag), 120000);
  return readFileSync(join(BACKEND_DIR, 'messenger.once.out'), 'utf8').trim();
}

async function month() {
  assert.ok(BACKEND_DIR, 'нужен PARVANE_E2E_BACKEND_LOG_DIR (раннер run_web_e2e.sh)');
  const alice = summary.addresses.alice;
  const bobNick = summary.addresses.bob.split('@')[0];
  const folderTitle = `Месяц спустя ${summary.suffix}`;
  const text = `Выдуманное сообщение после переноса ${summary.suffix}`;

  // 1. alice1 переносится (как plain) и остаётся открытой
  const first = await migrateProfile('alice1', { keep: true });
  if (!first) return;
  const { page } = first.session;
  const historyFrom = maxSeq('user_history_log', alice);
  const stateFrom = maxSeq('user_state_log_v2', alice);
  results.push({ step: 'alice1: журнал личного состояния перенесён на сервер (state.v2)', ok: stateFrom > 0, stateFrom });
  let changedDump;
  try {
    // 2. Правка личного состояния (новая папка) и сообщение bob — уже после переноса
    const sent = await page.evaluate(async ({ nick, title, body }) => {
      const g = window.__parvaneGetGlobal();
      const bob = Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick));
      if (!bob || !g.chats.byId[bob.id]) throw new Error(`нет чата ${nick}`);
      const ids = Object.keys(g.chatFolders?.byId || {}).map(Number);
      const id = Math.max(2, ...ids) + 1;
      await window.__parvaneDiagCallApi('editChatFolder', {
        id,
        folderUpdate: {
          title: { text: title, entities: [] }, emoticon: '🗓', includedChatIds: [bob.id], excludedChatIds: [],
          pinnedChatIds: [], contacts: false, nonContacts: false, groups: false, channels: false, bots: false,
        },
      });
      await window.__parvaneDiagCallApi('sendMessage', { chat: g.chats.byId[bob.id], text: body });
      return { folderId: id };
    }, { nick: bobNick, title: folderTitle, body: text });
    await waitFor('запись alice1 в журнал истории', () => maxSeq('user_history_log', alice) > historyFrom);
    await waitFor('запись alice1 в журнал личного состояния (state.v2)', () => maxSeq('user_state_log_v2', alice) > stateFrom);
    await pause(SETTLE_MS);
    const dump = await page.evaluate(() => window.__parvaneDiagCallApi('parvaneAuditDump', { source: 'engine' }));
    changedDump = join(OUT, 'web-alice1.changed.engine.jsonl');
    writeFileSync(changedDump, dump || '');
    const d = delta(loadDump(first.after), loadDump(changedDump));
    results.push({
      step: 'alice1: папка и сообщение после переноса', ok: d.added.some((k) => k.startsWith('message\t')), ...sent, delta: d,
    });
  } catch (e) {
    results.push({ step: 'alice1: правка после переноса', ok: false, error: String(e?.message || e).slice(0, 600) });
    return;
  } finally {
    await first.session.context.close().catch(() => undefined);
  }

  // Проверка «ловит потерю»: стереть записи alice1 после переноса из журнала истории либо личного состояния
  if (MONTH_BREAK) {
    const table = MONTH_BREAK === 'state' ? 'user_state_log_v2' : 'user_history_log';
    const from = MONTH_BREAK === 'state' ? stateFrom : historyFrom;
    const gone = messengerDb(`DELETE FROM ${table} WHERE user = ? AND seq > ? RETURNING seq`, [alice, from]);
    results.push({ step: `ПРОВЕРКА НА ПОТЕРЮ: из ${table} стёрто записей ${gone.length}`, ok: true });
  }

  // 3. «Месяц спустя»: плановые чистки messenger как через 31 сутки (часы стенда не двигаем)
  const inboxBefore = messengerDb('SELECT COUNT(*) FROM inbox_log')[0][0];
  const stateFirst = maxSeq('user_state_log_v2', alice);
  const out = await restartMessenger(MONTH_GC ? `--gc-as-of ${Math.floor(Date.now() / 1000) + MONTH_SECS}` : '');
  const inboxAfter = messengerDb('SELECT COUNT(*) FROM inbox_log')[0][0];
  let gc = {};
  try {
    gc = out ? JSON.parse(out.split('\n').pop()) : {};
  } catch {
    gc = { raw: out.slice(0, 200) };
  }
  results.push({
    step: MONTH_GC ? 'messenger --gc-as-of +31 сутки: инбоксы вычищены' : 'messenger перезапущен БЕЗ чистки (контроль)',
    ok: MONTH_GC ? gc.inbox > 0 && inboxAfter === 0 : true,
    inboxBefore,
    inboxAfter,
    gc,
  });

  // 4. alice2 — устройство, выключенное всё это время, — переносится и видит правку alice1
  const a1 = loadDump(changedDump);
  const d1 = delta(loadDump(first.after), a1);
  await migrateProfile('alice2', {
    verify: async ({ session, after, report }) => {
      const a2 = loadDump(after);
      const d2 = delta(loadDump(join(SEED, 'audit', 'web-alice2.jsonl')), a2);
      const msgKeys = d1.added.filter((k) => k.startsWith('message\t'));
      const stateKeys = d1.changed.concat(d1.added).filter((k) => k.startsWith('state:'));
      const missingMsg = msgKeys.filter((k) => !a2.has(k));
      const staleState = stateKeys.filter((k) => a2.get(k) !== a1.get(k));
      // Всё изменившееся у alice2 — то, что изменила alice1 (и сведения группы с перезалитым фото, FR-071)
      const allowed = new Set([...d1.changed, ...d1.added]);
      const extraChanged = d2.changed.filter((k) => !allowed.has(k) && !k.startsWith('group\t'));
      const extraAdded = d2.added.filter((k) => !allowed.has(k));
      const ui = await session.page.waitForFunction(({ title, body }) => {
        const g = window.__parvaneGetGlobal();
        const folder = Object.values(g.chatFolders?.byId || {}).some((f) => f.title?.text === title);
        const message = Object.values(g.messages.byChatId).some((chat) => Object.values(chat.byId || {})
          .some((m) => m.content?.text?.text === body));
        return folder && message ? { folder, message } : undefined;
      }, { title: folderTitle, body: text }, { timeout: 60000, polling: 1000 })
        .then((h) => h.jsonValue())
        .catch(() => session.page.evaluate(({ title, body }) => {
          const g = window.__parvaneGetGlobal();
          return {
            folder: Object.values(g.chatFolders?.byId || {}).some((f) => f.title?.text === title),
            message: Object.values(g.messages.byChatId).some((chat) => Object.values(chat.byId || {})
              .some((m) => m.content?.text?.text === body)),
          };
        }, { title: folderTitle, body: text }));
      const view = await session.page.evaluate(() => window.__parvaneDiagCallApi('parvaneDiagStateView'));
      const folderInState = JSON.stringify(view?.snapshot || {}).includes(folderTitle);
      const detail = {
        // Записи второго устройства в журнал личного состояния при возвращении (ровно то же — без записей; запись
        // прежнего значения поверх правки первого откатила бы её у всех устройств)
        secondStateWrites: maxSeq('user_state_log_v2', alice) - stateFirst,
        lost: report.lost,
        msgKeys: msgKeys.length,
        missingMsg,
        stateKeys: stateKeys.length,
        staleState,
        extraChanged,
        extraAdded,
        ui,
        folderInState,
      };
      const ok = report.lost === 0 && msgKeys.length > 0 && !missingMsg.length && stateKeys.length > 0
        && !staleState.length && !extraChanged.length && !extraAdded.length && ui.folder && ui.message && folderInState;
      return { ok, detail };
    },
  });
}

if (VARIANT === 'month') {
  await month();
} else {
  const who = VARIANT === 'plain' ? ['alice1', 'alice2', 'bob', 'carol'] : ['alice1'];
  for (const name of who) {
    // eslint-disable-next-line no-await-in-loop
    await migrateProfile(name);
  }
}
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ variant: VARIANT, results }, undefined, 1)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(`\nперенос web (${VARIANT}): ${results.length} шагов, сбоев ${failed.length}`);
process.exit(failed.length ? 1 : 0);
