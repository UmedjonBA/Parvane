// Протокол v2 (spec 007, T126, FR-054/FR-058): у аккаунта есть и v2-, и
// v1-устройство. bob1 — web на v1 (первое устройство), bob2 — web на v2, alice
// — web на v2.
// (1) первое v2-устройство bob публикует в журнале устройств ПОДПИСАННЫЙ
//     список своих v1-устройств (bob1);
// (2) сообщение alice → bob уходит по v2 на bob2 и легаси-копией v1 на bob1
//     (`msg.deliver_legacy`): видят оба, на bob2 оно одно и без заглушки
//     «не расшифровано»;
// (3) исходящее bob2 → alice доходит до alice по v2 и до bob1 своей копией v1;
// (4) ответ с v1-устройства bob1 видят alice и bob2 (v1-путь);
// (5) правка и удаление v2-сообщения доходят и до v1-устройства;
// (6) после перезагрузки (v1-синк с сервера) на v2-устройствах нет дублей и
//     заглушек.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  deleteMessage,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  editText,
  findMessage,
  findMessageContainers,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  reloadPage,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-legacy-password';
const V2_SEED = { 'parvane:proto': 'v2' };
// Журнал устройств собеседника обновляется раз в 15 с
const LOG_REFRESH_MS = 20000;

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const consoleTail = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t);
      consoleTail[who].push(`${m.type()}: ${t.slice(0, 300)}`);
      if (consoleTail[who].length > 80) consoleTail[who].shift();
    });
    page.on('pageerror', (e) => consoleTail[who].push(`pageerror: ${String(e).slice(0, 500)}`));
  });
});

async function waitLog(who, needle, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}» (журнал: ${logs[who].slice(-40).join(' | ')})`);
}

async function expectSingle(page, who, text) {
  await findMessage(page, text).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(await findMessageContainers(page, text).count(), 1, `${who}: «${text}» показано не один раз`);
}

function assertNoUndecryptable(who) {
  const bad = logs[who].filter((l) => l.includes('не расшифровано'));
  assert.deepEqual(bad, [], `${who}: есть нерасшифрованные записи`);
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `lga-${suffix}@local`;
  const bob = `lgb-${suffix}@local`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  // Первое устройство bob — на v1
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD);
  await waitLog('alice', 'v2: готов');
  assert.ok(await dismissRecoveryKeyDialog(sessions.alice.page), 'alice: не показан ключ восстановления v2');
  const alicePage = sessions.alice.page;
  const bob1Page = sessions.bob1.page;
  assert.ok(!logs.bob1.some((l) => l.includes('v2: готов')), 'bob1 должен работать на v1');

  // ── (1) Первое v2-устройство bob публикует список v1-устройств ─────────────
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await waitLog('bob2', 'v2: готов');
  assert.ok(await dismissRecoveryKeyDialog(bob2Page), 'bob2: не показан ключ восстановления v2');
  await waitLog('bob2', 'v2: список v1-устройств опубликован (1)');

  // ── (2) alice → bob: v2 на bob2, легаси-копия на bob1 ──────────────────────
  const first = `lg-first-${suffix}`;
  await openPrivateChatStrict(alicePage, bob);
  await sendText(alicePage, first);
  await waitLog('alice', 'v2: легаси-копии v1-устройствам: собеседника 1', LOG_REFRESH_MS);
  await openPrivateChatStrict(bob2Page, alice);
  await expectSingle(bob2Page, 'bob2', first);
  await openPrivateChatStrict(bob1Page, alice);
  await expectSingle(bob1Page, 'bob1', first);

  // ── (3) bob2 → alice: alice по v2, bob1 — своей копией v1 ──────────────────
  const reply = `lg-reply-${suffix}`;
  await sendText(bob2Page, reply);
  await waitLog('bob2', 'своим 1');
  await expectSingle(alicePage, 'alice', reply);
  await expectSingle(bob1Page, 'bob1', reply);

  // ── (4) v1-устройство bob1 → alice: видят alice и bob2 ─────────────────────
  const legacy = `lg-v1-${suffix}`;
  await sendText(bob1Page, legacy);
  await expectSingle(alicePage, 'alice', legacy);
  await expectSingle(bob2Page, 'bob2', legacy);

  // Вторая отправка alice — список v1-устройств уже в кэше
  const second = `lg-second-${suffix}`;
  await sendText(alicePage, second);
  await expectSingle(bob2Page, 'bob2', second);
  await expectSingle(bob1Page, 'bob1', second);

  // ── (5) Правка и удаление v2-сообщения — и на v1-устройстве ────────────────
  const edited = `lg-edited-${suffix}`;
  await editText(alicePage, first, edited);
  await waitLog('alice', 'v2: правка v1-устройствам');
  await expectSingle(bob2Page, 'bob2', edited);
  await expectSingle(bob1Page, 'bob1', edited);
  const doomed = `lg-doomed-${suffix}`;
  await sendText(alicePage, doomed);
  await expectSingle(bob2Page, 'bob2', doomed);
  await expectSingle(bob1Page, 'bob1', doomed);
  await deleteMessage(alicePage, doomed);
  await waitLog('alice', 'v2: удаление v1-устройствам');
  for (const [who, page] of [['bob2', bob2Page], ['bob1', bob1Page]]) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(page, doomed).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS })
      .catch(() => { throw new Error(`${who}: удалённое сообщение осталось`); });
  }

  // ── (6) Перезагрузка: v1-синк не приносит v2-устройствам чужие копии ───────
  for (const who of ['alice', 'bob2', 'bob1']) {
    const page = sessions[who].page;
    // eslint-disable-next-line no-await-in-loop
    await reloadPage(page);
    // eslint-disable-next-line no-await-in-loop
    await openPrivateChatStrict(page, who === 'alice' ? bob : alice);
    for (const text of [edited, reply, legacy, second]) {
      // eslint-disable-next-line no-await-in-loop
      await expectSingle(page, `${who} после перезагрузки`, text);
    }
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await findMessage(page, doomed).count(), 0, `${who}: удалённое вернулось после перезагрузки`);
  }

  names.forEach(assertNoUndecryptable);
  for (const who of names) {
    assert.ok(!logs[who].some((l) => l.includes('запуск не удался')), `${who}: ${logs[who].join(' | ')}`);
    assert.ok(!logs[who].some((l) => l.includes('легаси-копии не отправлены')), `${who}: ${logs[who].join(' | ')}`);
  }
  console.log('e2e_protocol_legacy_devices: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-legacy-devices-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`консоль ${who}:\n${consoleTail[who].join('\n')}`);
    console.error(`журнал ${who}: ${logs[who].slice(-60).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
