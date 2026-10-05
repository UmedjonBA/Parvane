// Протокол v2 (spec 007, T182, FR-053 — этап E6): история v1 после отключения v1 в web.
// Аккаунты заведены и переписывались по v1; пока вкладка bob была закрыта, alice
// написала ему ещё раз (сообщение осталось в инбоксе v1). Затем сервер переведён в
// PARVANE_V1_MODE=disabled (gateway перезапущен посреди сценария), клиенты обновлены
// до v2: JSON-соединения v1 нет, и недоставленное сообщение v1 bob получает записью
// `LegacyV1` инбокса v2; история до отключения на месте, дальше переписка идёт по v2.
// Зеркало desktop/verify_protocol_v2_legacy_v1off.sh.
// Запуск: scripts/run_web_legacy_v1off_e2e.sh
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dumpDiagJournal,
  findMessage,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  relogin,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-legacy-e2e-password';
const V1_SEED = { 'parvane:proto': 'v1' };
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
const V2_START_TIMEOUT_MS = 90000;
const GATEWAY_RESTART_TIMEOUT_MS = 40000;

// Перезапуск gateway раннером (run_web_e2e.sh gateway_restart_watch); возвращает
// число строк журнала gateway до перезапуска
async function restartGateway(env) {
  const log = join(BACKEND_DIR, 'gateway.log');
  const before = readFileSync(log, 'utf8').split('\n').length;
  const done = join(BACKEND_DIR, 'gateway.restarted');
  rmSync(done, { force: true });
  writeFileSync(join(BACKEND_DIR, 'gateway.restart'), env);
  const deadline = Date.now() + GATEWAY_RESTART_TIMEOUT_MS;
  while (!existsSync(done)) {
    assert(Date.now() < deadline, 'gateway не перезапущен раннером');
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  return before;
}

function gatewayLogAfter(lines) {
  return readFileSync(join(BACKEND_DIR, 'gateway.log'), 'utf8').split('\n').slice(lines).join('\n');
}

async function waitLog(session, needle, timeout = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (session.logs.some((line) => line.includes(needle))) return;
    await session.page.waitForTimeout(200);
  }
  assert.fail(`в журнале нет «${needle}»; хвост:\n${session.logs.slice(-25).join('\n')}`);
}

// Клиент «обновлён до v2»: сид v1 ставится init-скриптом при каждой загрузке —
// более поздний init-скрипт его перекрывает
async function upgradeToV2(session) {
  session.logs.length = 0;
  await session.page.addInitScript(() => localStorage.removeItem('parvane:proto'));
  await relogin(session.page, PASSWORD);
  await waitLog(session, 'v2: готов', V2_START_TIMEOUT_MS);
  // Первый корень v2 — диалог ключа восстановления
  const dialog = session.page.locator('.Modal .modal-dialog').filter({ hasText: /recovery key|ключ восстановления/i })
    .filter({ has: session.page.getByRole('button', { name: 'OK', exact: true }) });
  await session.page.addLocatorHandler(dialog, async (shown) => {
    await shown.getByRole('button', { name: 'OK' }).click();
  });
}

const browser = await chromium.launch();
const contexts = { alice: await browser.newContext(), bob: await browser.newContext() };
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `lg-alice-${suffix}@local`;
  const bob = `lg-bob-${suffix}@local`;
  const beforeOff = `v1-before-${suffix}`;
  const beforeOffBack = `v1-before-back-${suffix}`;
  const whileAway = `v1-while-away-${suffix}`;
  const afterOff = `v2-after-${suffix}`;
  const afterOffBack = `v2-after-back-${suffix}`;

  // ── Эпоха v1: переписка и сообщение получателю с закрытой вкладкой ─────────
  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V1_SEED });
  sessions.bob = await preparePage(contexts.bob, bob, PASSWORD, { seedLocalStorage: V1_SEED });
  const alicePage = sessions.alice.page;
  const bobPage = sessions.bob.page;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, beforeOff);
  await openPrivateChatStrict(bobPage, alice);
  await findMessage(bobPage, beforeOff).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobPage, beforeOffBack);
  await findMessage(alicePage, beforeOffBack).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // bob «выключен»: вкладка уходит со страницы приложения, соединение закрыто
  await bobPage.goto('about:blank');
  await sendText(alicePage, whileAway);
  await findMessage(alicePage, whileAway).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await alicePage.waitForTimeout(3000); // сообщение записано шардом v1
  console.log('эпоха v1: переписка есть, сообщение ждёт выключенного получателя');

  // ── Сервер отключает v1, клиенты обновлены до v2 ───────────────────────────
  const linesBefore = await restartGateway('PARVANE_V1_MODE=disabled');
  await bobPage.goto(process.env.PARVANE_E2E_BASE_URL, { waitUntil: 'domcontentloaded' });
  await upgradeToV2(sessions.bob);
  // История до отключения — из локального хранилища; недоставленное — записью LegacyV1
  await openPrivateChatStrict(bobPage, alice);
  await findMessage(bobPage, beforeOff).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobPage, whileAway).waitFor({ state: 'visible', timeout: V2_START_TIMEOUT_MS });
  // Своё исходящее эпохи v1 — тоже на месте (сервер его больше не отдаст)
  await findMessage(bobPage, beforeOffBack).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await findMessage(bobPage, whileAway).count(), 1, 'bob: сообщение из LegacyV1 задвоилось');
  console.log('bob получил сообщение v1, отправленное до отключения (запись LegacyV1)');
  assert.equal(await bobPage.getByText(/update the app|обновите приложение/i).count(), 0,
    'bob: при отключённом v1 показан диалог «обновите приложение»');

  // ── Дальше — по v2 ─────────────────────────────────────────────────────────
  await upgradeToV2(sessions.alice);
  await openPrivateChatStrict(alicePage, bob);
  await findMessage(alicePage, beforeOffBack).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, afterOff);
  await findMessage(bobPage, afterOff).waitFor({ state: 'visible', timeout: V2_START_TIMEOUT_MS });
  await sendText(bobPage, afterOffBack);
  await findMessage(alicePage, afterOffBack).waitFor({ state: 'visible', timeout: V2_START_TIMEOUT_MS });
  // Перезагрузка: история обеих эпох на месте
  await relogin(bobPage, PASSWORD);
  await openPrivateChatStrict(bobPage, alice);
  for (const text of [beforeOff, beforeOffBack, whileAway, afterOff, afterOffBack]) {
    await findMessage(bobPage, text).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }

  // ── После отключения v1 не использовался ───────────────────────────────────
  const after = gatewayLogAfter(linesBefore);
  assert.match(after, /v1-путь в режиме Disabled/, 'gateway после перезапуска не в режиме disabled');
  assert.doesNotMatch(after, /gateway::session.*Клиент авторизован/, 'после отключения кто-то авторизовался по v1');

  Object.entries(sessions).forEach(([name, session]) => {
    // about:blank («выключенный» bob): init-скрипты раннера там не имеют доступа к localStorage
    const errors = session.errors.filter((text) => !/Access is denied for this document/.test(text));
    assert.deepEqual(errors, [], `${name} page errors: ${errors.join('; ')}`);
  });
  console.log('OK: история v1 после отключения v1 — недоставленное сообщение пришло записью LegacyV1, '
    + 'история до отключения на месте, переписка продолжилась по v2, по v1 никто не авторизовался');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, session] of Object.entries(sessions)) {
    await session.page.screenshot({ path: `${dir}legacy-v1off-${name}.png` }).catch(() => {});
    console.error(`--- журнал ${name} ---\n${session.logs.slice(-40).join('\n')}`);
    await dumpDiagJournal(session.page, name, 60);
  }
  throw err;
} finally {
  await browser.close();
}
