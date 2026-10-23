// Новое устройство получает ВСЁ сразу после входа — Telegram X и web вперемешку (отзыв 23–24 окт 2026: после ответа
// боту ключом на телефоне были видны 3 чата, группы, канал и «План» приходили через минуты, PWA писала «привязка не
// удалась», а телефон потом спрашивал подтверждение привязки уже вошедшего устройства). Запускается из
// `android/tgx_join_methods_flow.sh` (стек с ботом Telegram, эмулятор, vite preview и logcat X в $TGX_LOG подняты).
// web alice1 — первое устройство: переписка с bob, группа и канал, задача «Плана», папка и файл «Облака». Дальше:
//   A. X входит ответом боту, alice1 в сети;
//   B. web alice2 входит ответом боту, все прочие закрыты, копию ключей последним писал X (Android не «беднит» её);
//   C. X (чистые данные) входит ключом восстановления, введённым руками;
//   D. X (чистые данные) входит подтверждением с web alice2 (код сверки, «Передать»);
//   E. web alice3 входит подтверждением с X (X — старое устройство).
// После каждого входа не позже FAST_MS видны все чаты и тексты, задача «Плана», папка и файл «Облака»; входа «не
// удалось» нет; после входа сервер не получает оффера привязки, другие устройства запроса не показывают.
// Строки `ok …` / `FAIL …` в stdout разбирает раннер. Данные — выдуманные.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import { closeSettings, openDevicesScreen } from './e2e_web_helpers.mjs';

import {
  FAST_MS, JOIN_TIMEOUT_MS, PASSWORD, TG_ALICE, WIDE, botReplyV2, callApi, expectEverythingFast,
  expectJoinState, expectNoOfferAfterJoin, gatewayUrl, joinByTelegram, login, offerCount, pullFor, seedAccount,
  waitLog,
} from './e2e_web_join_lib.mjs';

const OUT = process.env.PV_ANDROID_OUT;
const TGX_LOG = process.env.TGX_LOG;
const GW_PORT = process.env.PV_GW_WS_PORT || '9222';
const SECRET = process.env.PARVANE_TELEGRAM_SECRET;
const PKG = 'org.parvane.tgx';
const LINK_TIMEOUT_MS = 120000;

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

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', timeout: 60000 });
}
function put(name, text) {
  const file = join(OUT, `put-${name}`);
  writeFileSync(file, text);
  adb('push', file, `/data/local/tmp/${name}`);
  adb('shell', 'chmod', '644', `/data/local/tmp/${name}`);
}
const xLog = () => {
  try {
    return readFileSync(TGX_LOG, 'utf8');
  } catch {
    return '';
  }
};
let xMark = 0;
const markX = () => {
  xMark = xLog().length;
};
async function waitFor(fn, timeout, what) {
  const until = Date.now() + timeout;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await Promise.resolve(fn()).catch(() => undefined);
    if (value) return value;
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
}
const xSince = (mark) => xLog().slice(mark);
const xWait = (re, timeout, from = xMark) => waitFor(() => re.test(xSince(from)), timeout, `X: ${re.source}`);
async function xCommand(command) {
  const mark = xLog().length;
  put('parvane-e2e-cmd', JSON.stringify(command));
  await xWait(new RegExp(`e2e-cmd ${command.op} →`), 30000, mark);
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** X с чистыми данными входит тем же аккаунтом паролем и ждёт привязки. */
async function xFreshLogin(user, label) {
  adb('shell', 'am', 'force-stop', PKG);
  adb('shell', 'pm', 'clear', PKG);
  adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS');
  adb('shell', 'rm', '-f', '/data/local/tmp/parvane-e2e-cmd', '/data/local/tmp/parvane-autolink');
  adb('reverse', `tcp:${GW_PORT}`, `tcp:${GW_PORT}`);
  put('parvane-gateway', `ws://127.0.0.1:${GW_PORT}/ws`);
  put('parvane-autologin', `${user}:${PASSWORD}`);
  markX();
  adb('shell', 'am', 'start', '-n', `${PKG}/org.thunderdog.challegram.MainActivity`);
  await xWait(/устройству нужна привязка/, LINK_TIMEOUT_MS);
  ok(`${label}: X ждёт привязки`);
  return xMark;
}

/** Всё прежнее на X — не позже FAST_MS после готовности (маркеры журнала X). */
async function expectEverythingOnX(label, expected, startMark, readyAt) {
  await xCommand({ op: 'sections', section: 'calendar' });
  const left = () => Math.max(1000, readyAt + FAST_MS - Date.now());
  const missing = [];
  const taskRe = new RegExp(`planner: status=ready loaded=1 задачи=\\[[^\\]]*${escapeRegExp(expected.tasks[0])}`);
  await xWait(taskRe, left(), startMark).catch(() => missing.push(`задача «${expected.tasks[0]}»`));
  await xCommand({ op: 'sections', section: 'files' });
  const cloudLine = () => xSince(startMark).split('\n').filter((l) => l.includes('cloud: status=ready')).pop() || '';
  await waitFor(() => expected.nodes.every((n) => cloudLine().includes(n)), left(), 'облако X')
    .catch(() => missing.push(...expected.nodes.filter((n) => !cloudLine().includes(n)).map((n) => `облако «${n}»`)));
  const dumpOk = await waitFor(async () => {
    const mark = xLog().length;
    await xCommand({ op: 'dump' });
    const line = xSince(mark).split('\n').find((l) => l.includes('e2e-dump: '));
    if (!line) return false;
    const dump = JSON.parse(line.slice(line.indexOf('e2e-dump: ') + 10));
    const all = [...expected.titles.filter((t) => !dump.chats.includes(t)).map((t) => `чат «${t}»`),
      ...[...expected.dmTexts, ...expected.groupTexts, ...expected.channelTexts]
        .filter((t) => !dump.texts.includes(t)).map((t) => `сообщение «${t}»`)];
    if (!all.length) return true;
    if (Date.now() > readyAt + FAST_MS) missing.push(...all);
    return Date.now() > readyAt + FAST_MS;
  }, FAST_MS + 15000, 'дамп чатов X').catch(() => false);
  if (!dumpOk && !missing.length) missing.push('дамп чатов X не получен');
  const seconds = ((Date.now() - readyAt) / 1000).toFixed(1);
  if (missing.length) throw new Error(`${label}: через ${seconds} с после входа нет: ${missing.join(', ')}`);
  console.log(`     ${label}: всё прежнее через ${seconds} с после входа`);
}

function expectNoFailureOnX(label, startMark) {
  const log = xSince(startMark);
  if (/вход не удался|Привязка не удалась|ключ восстановления: failed/.test(log)) {
    throw new Error(`${label}: в журнале X отказ входа`);
  }
}

const browser = await chromium.launch();
const all = {};
try {
  const suffix = `${Date.now().toString(36)}${process.pid}`;
  const seeded = await seedAccount(browser, suffix);
  Object.assign(all, seeded.sessions);
  const { alice1, aliceNick, expected } = seeded;
  ok('web alice1: переписка, группа, канал, «План», «Облако»; копия ключей на сервере');

  // ── A. X — ответом боту, alice1 в сети ──
  let mark = await xFreshLogin(`${aliceNick}@local`, 'A');
  await pullFor(TG_ALICE, 'ask');
  const offersBefore = offerCount(alice1.address);
  const accepted = await botReplyV2(gatewayUrl, SECRET, TG_ALICE, alice1.key);
  if (accepted.result !== 'ok') throw new Error(`бот: ${JSON.stringify(accepted)}`);
  // Запись в журнал принята — с этого момента и считаем «сразу»
  await xWait(/устройство привязано грантом линковки/, JOIN_TIMEOUT_MS, mark);
  let readyAt = Date.now();
  await check('A: X (ответ боту) — всё прежнее сразу', () => expectEverythingOnX('A', expected, mark, readyAt));
  await check('A: X — без «не удалось»', () => expectNoFailureOnX('A', mark));
  await check('A: после входа X запроса привязки нет', async () => {
    await new Promise((r) => { setTimeout(r, 12000); });
    const offers = await callApi(alice1.page, 'parvaneListLinkOffers');
    if (offers?.offers?.length) throw new Error(`alice1 видит запрос: ${JSON.stringify(offers)}`);
    // Публикация оффера до ответа боту — одна; после входа новых нет (отзыв пишется отдельной строкой)
    if (offerCount(alice1.address) > offersBefore) throw new Error('после входа X опубликован оффер');
  });

  // ── B. web alice2 — ответом боту; копию последним писал X; прочие web закрыты ──
  await check('B: X записал копию ключей аккаунта', () => xWait(/копия ключей аккаунта обновлена/, 150000, mark));
  await alice1.page.close();
  const alice2 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice2 (бот, после X)');
  all.alice2 = alice2;
  await check('B: web после X — всё прежнее сразу', async () => {
    const ready = await joinByTelegram(alice2, alice1.key);
    await expectEverythingFast(alice2, expected, ready);
    await expectJoinState(alice2, 'done');
  });

  // ── C. X — ключом руками ──
  mark = await xFreshLogin(`${aliceNick}@local`, 'C');
  await pullFor(TG_ALICE, 'ask');
  await xCommand({ op: 'recover_key', key: ` ${alice1.key.toLowerCase().replace(/-/g, ' ')} ` });
  await check('C: вход по ключу → ok', () => xWait(/вход по ключу → ok/, JOIN_TIMEOUT_MS, mark));
  readyAt = Date.now();
  await check('C: X (ключ руками) — всё прежнее сразу', () => expectEverythingOnX('C', expected, mark, readyAt));
  await check('C: после входа запроса привязки нет', () => expectNoOfferAfterJoin(alice2, alice1.address, [alice2]));

  // ── D. X — подтверждением с web alice2 ──
  mark = await xFreshLogin(`${aliceNick}@local`, 'D');
  await pullFor(TG_ALICE, 'ask');
  await check('D: web подтверждает X (код сверки, «Передать»)', async () => {
    const screen = await openDevicesScreen(alice2.page);
    const offerItem = screen.locator('.ListItem').filter({ hasText: /Code: \d{4}/ }).first();
    await offerItem.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await offerItem.locator('.ListItem-button').click();
    const transfer = alice2.page.getByRole('button', { name: 'Transfer', exact: true });
    await transfer.waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await transfer.click();
    await alice2.page.getByText('History transferred').waitFor({ state: 'visible', timeout: LINK_TIMEOUT_MS });
    await closeSettings(alice2.page);
    await xWait(/привязка: грант v2 получен/, LINK_TIMEOUT_MS, mark);
  });
  await xWait(/устройство привязано грантом линковки/, JOIN_TIMEOUT_MS, mark).catch(() => undefined);
  readyAt = Date.now();
  await check('D: X (подтверждение с web) — всё прежнее сразу', () => expectEverythingOnX('D', expected, mark, readyAt));
  await check('D: X — без «не удалось»', () => expectNoFailureOnX('D', mark));

  // ── E. web alice3 — подтверждением с X (X — старое устройство; dev-хук автогранта) ──
  await alice2.page.close();
  put('parvane-autolink', '1');
  const alice3 = await login(await browser.newContext({ viewport: WIDE }), aliceNick, 'alice3 (подтверждение с X)');
  all.alice3 = alice3;
  await pullFor(TG_ALICE, 'ask');
  await check('E: web (подтверждение с X) — всё прежнее сразу', async () => {
    await waitLog(alice3, /v2: устройство привязано грантом линковки/, LINK_TIMEOUT_MS);
    await expectEverythingFast(alice3, expected, Date.now());
  });
  adb('shell', 'rm', '-f', '/data/local/tmp/parvane-autolink');
} catch (error) {
  fail('сценарий прерван', error);
  for (const [name, session] of Object.entries(all)) {
    console.log(`--- ${name} ---\n${(session.logs || []).slice(-30).join('\n')}`);
  }
} finally {
  await browser.close();
}
console.log(failures ? `JOIN ANDROID: FAIL (${failures})` : 'JOIN ANDROID: OK');
process.exit(failures ? 1 : 0);
