// Разовый перенос web (spec 035, T109; contracts/migration.md «Канонические выгрузки и сверка»). Профили браузера,
// снятые ПРЕЖНИМ кодом (сид T006 нынешним кодом исходной точки T008 — `run_web_migration_e2e.sh seed`), открываются
// НОВЫМ web-dist на копии баз сида; после переноса — выгрузка модели движка (`parvaneAuditDump({source: 'engine'})`)
// и сверка с выгрузкой «до» (`scripts/migration_audit_diff.py`): потеряно 0, изменено 0.
//
// Вариант (`PARVANE_MIGRATION_VARIANT`):
//   plain — все профили сида (alice1, alice2 — второе устройство, bob, carol — хранилище под PIN);
//   M2/M4 — профиль alice1: вкладка закрыта посреди переноса в точке M2 (часть строк поколения 1 записана) либо M4
//           (после `Migrated` журнала личного состояния), затем открыта снова — перенос доходит до конца, сверка 0/0.
// Каждый вариант — на своей копии профилей и баз (раннер поднимает стек заново). Данные — выдуманные (сид).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SEED = process.env.PARVANE_MIGRATION_SEED;
const OUT = process.env.PARVANE_MIGRATION_OUT;
const VARIANT = process.env.PARVANE_MIGRATION_VARIANT || 'plain';
const BASE_URL = process.env.PARVANE_E2E_BASE_URL;
const GATEWAY_URL = process.env.PARVANE_E2E_GATEWAY_URL;
const READY_TIMEOUT_MS = 240000;
const SETTLE_MS = 8000;
const HALT = { M2: 2, M4: 4 };

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
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined, {
    timeout: READY_TIMEOUT_MS,
  });
  // Сессия не возобновилась (профиль без «не выходить») — вход паролем сида тем же устройством
  const password = page.locator('.Transition_slide-active > #auth-password-form');
  const left = page.locator('#LeftColumn');
  await Promise.race([
    password.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS }),
    left.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS }),
  ]).catch(() => undefined);
  if (await password.isVisible().catch(() => false)) {
    await password.locator('#sign-in-password').fill(summary.password);
    await password.getByRole('button', { name: 'Next' }).click();
    await left.waitFor({ state: 'visible', timeout: READY_TIMEOUT_MS });
  }
  await page.waitForFunction(async () => {
    const state = await window.__parvaneDiagCallApi('parvaneDiagMigration').catch(() => undefined);
    return state?.open === 'OPEN_STATE_READY';
  }, undefined, { timeout: READY_TIMEOUT_MS, polling: 1000 });
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

async function migrateProfile(who) {
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
    const ok = fromEngine.code === 0 || (summary.photoGroup && r.lost === 0 && !r.unexpected_added && onlyPhoto);
    results.push({
      step: `${who}: сверка`, ok, ms: Date.now() - started, engine: fromEngine.report, host: fromHost.report,
    });
    console.log(`${ok ? 'OK' : 'СБОЙ'}: ${who} — модель ${JSON.stringify(fromEngine.report).slice(0, 300)}`);
  } catch (e) {
    results.push({ step: `${who}: перенос`, ok: false, error: String(e?.message || e).slice(0, 600) });
    writeFileSync(join(OUT, `log-${who}.txt`), session.logs.join('\n'));
    await session.page.screenshot({ path: join(OUT, `fail-${who}.png`) }).catch(() => undefined);
    console.log(`СБОЙ: ${who}: ${String(e?.message || e).slice(0, 300)}`);
  } finally {
    await session.context.close().catch(() => undefined);
  }
}

const who = VARIANT === 'plain' ? ['alice1', 'alice2', 'bob', 'carol'] : ['alice1'];
for (const name of who) {
  // eslint-disable-next-line no-await-in-loop
  await migrateProfile(name);
}
writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ variant: VARIANT, results }, undefined, 1)}\n`);
const failed = results.filter((r) => !r.ok);
console.log(`\nперенос web (${VARIANT}): ${results.length} шагов, сбоев ${failed.length}`);
process.exit(failed.length ? 1 : 0);
