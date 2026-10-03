// Мультидевайс: один аккаунт (bob) на двух «устройствах» (два изолированных
// браузерных контекста). Проверяем: (1) старая sealed-история нечитаема на
// новом устройстве (E2E честный); (2) новые входящие 1-на-1 приходят на ОБА
// устройства (fan-out копий у отправителя); (3) исходящее со второго
// устройства видит и Алиса, и первое устройство (self-копии + подписанный
// sync); (4) групповое сообщение читается обоими устройствами (SKDM fan-out);
// (5) всё переживает перезапуск второго устройства; (6) у каждого устройства
// СВОЯ постоянная инвайт-ссылка группы, обе рабочие, повторный заход и рестарт
// новых не создают; (7) входящий групповой вызов звонит на обоих устройствах,
// принимает одно, второе замолкает по своему таймауту вызова (≤ 45 с, в тесте
// 10 с) — и его поздний отказ НЕ роняет разговор принявшего устройства.
import assert from 'node:assert/strict';

// Сценарий проверяет мультидевайс v1: общая основная ссылка-приглашение из
// списка шарда (таблица group_invites), fan-out копий и SKDM, история,
// нечитаемая без линковки. Клиенты идут по v1. Мультидевайс v2 (линковка,
// журнал состояния, группы на привязанном устройстве) —
// scripts/e2e_protocol_state_sync.mjs (пара state-sync)
process.env.PARVANE_E2E_PROTO = 'v1';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  relogin,
  LOGIN_TIMEOUT_MS,
  assertNoPageErrors,
  expectMediaFlowing,
  findMessage,
  openPrivateChat,
  preparePage,
  readInvitesScreen,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-multidevice-e2e-password';
const BACKEND_DIR = process.env.PARVANE_E2E_BACKEND_LOG_DIR;
assert(BACKEND_DIR, 'PARVANE_E2E_BACKEND_LOG_DIR is required');
// Клиентский кэш списка устройств контакта (DEVICE_LIST_TTL_MS в e2e.ts) + запас:
// отправитель заметит новое устройство не раньше истечения TTL
const DEVICE_LIST_TTL_WAIT_MS = 17000;
// Дельта-синк соседнего устройства — интервал 10с + запас
const SIBLING_SYNC_TIMEOUT_MS = 45000;
// Таймаут вызова (тестовое переопределение диагностической сборки, contracts/
// calls-consent-and-test-hooks.md): второе устройство замолкает по нему
const RING_TIMEOUT_MS = 10000;
// Верхняя граница спеки: «остальные замолкают по своему таймауту вызова (≤ 45 с)»
const RING_TIMEOUT_SPEC_MAX_MS = 45000;
const RING_SEED = { 'parvane:e2e:ringTimeoutMs': String(RING_TIMEOUT_MS) };

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const checkedRows = `${containerSelector} .PeerPickerItem input[type="checkbox"]:checked, `
    + `${containerSelector} .ItemPickerItem input[type="checkbox"]:checked`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page.locator(checkedRows).count();
    if (checked > 0) return;
    if (attempt % 2 === 0) {
      await row.press(' ').catch(() => {});
    } else {
      await row.click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`Row '${name}' was not selected in picker ${containerSelector}`);
}

async function openGroupChat(page, title) {
  const item = page.locator('#LeftColumn .ListItem').filter({ hasText: title }).first();
  await item.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await item.locator('.ListItem-button').click();
  // Композер предыдущего чата уже в DOM: без ожидания шапки ввод уходил в него
  await page.locator('.MiddleHeader').getByText(title).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

// Группа из одного участника через UI: New Message → New Group
async function createGroup(page, memberName, title) {
  await page.mouse.move(800, 360);
  await page.waitForTimeout(200);
  await page.locator('#LeftColumn').hover();
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
  const memberSearch = page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(memberName);
  await selectPickerRow(page, '#LeftColumn', memberName);
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // NewChatStep2 асинхронно подставляет авто-имя из участников — даём эффекту
  // отработать и перепроверяем, что наше название не перетёрто
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(700);
    await nameInput.fill(title);
    if (await nameInput.inputValue() === title) break;
  }
  assert.equal(await nameInput.inputValue(), title, 'group title must survive auto-suggestion');
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

function countInvitesCreatedBy(address) {
  const out = execFileSync('sqlite3', [
    join(BACKEND_DIR, 'messenger.db'),
    `SELECT count(*) FROM group_invites WHERE created_by = '${address.replace(/'/g, "''")}'`,
  ], { encoding: 'utf8' });
  return Number(out.trim());
}

function inviteToken(url) {
  const match = url.match(/#\+([0-9a-f]{32})/);
  assert(match, `no invite token in ${url}`);
  return match[1];
}

function membersCountLocator(page, count) {
  return page.locator('.MiddleHeader').getByText(new RegExp(`${count} members`)).first();
}

// Считаем вызовы getUserMedia: до согласия устройство не открывает микрофон
async function countGetUserMedia(context) {
  await context.addInitScript(() => {
    globalThis.__parvaneGumCalls = 0;
    const devices = navigator.mediaDevices;
    if (!devices?.getUserMedia) return;
    const native = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (constraints) => {
      globalThis.__parvaneGumCalls += 1;
      return native(constraints);
    };
  });
}

// Входящий групповой вызов: экран согласия обязателен, микрофон открывается
// только ПОСЛЕ клика «Принять» (как в e2e_web_group_calls.mjs)
async function acceptGroupCall(page, label) {
  const accept = page.getByRole('button', { name: 'Accept' });
  await accept.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => {
    assert.fail(`${label}: экран согласия на групповой вызов не появился`);
  });
  const gumBefore = await page.evaluate(() => globalThis.__parvaneGumCalls);
  await accept.click();
  await page.waitForFunction(
    (before) => globalThis.__parvaneGumCalls > before,
    gumBefore,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {
    assert.fail(`${label}: после согласия микрофон так и не запрошен`);
  });
}

async function waitActivePeers(page, count, label) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-peer-state="active"]').length === expected,
    count,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {
    assert.fail(`${label}: не дождались ${count} активных участников`);
  });
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-loopback-in-peer-connection',
  ],
});
const mediaPermissions = { permissions: ['microphone', 'camera'] };
const aliceContext = await browser.newContext(mediaPermissions);
const bobDevice1Context = await browser.newContext(mediaPermissions);
// Второе «устройство» Боба — полностью чистый контекст, тот же аккаунт
const bobDevice2Context = await browser.newContext(mediaPermissions);
// Вступающие по ссылкам с разных устройств Боба
const charlieContext = await browser.newContext();
const daveContext = await browser.newContext();
await Promise.all([bobDevice1Context, bobDevice2Context].map((context) => countGetUserMedia(context)));

try {
  const { baseUrl } = requireEnv();
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `md-alice-${suffix}@local`;
  const bob = `md-bob-${suffix}@local`;
  const charlie = `md-charlie-${suffix}@local`;
  const dave = `md-dave-${suffix}@local`;
  const aliceName = alice.split('@')[0];
  const bobName = bob.split('@')[0];
  const beforeSecondDevice = `md-before-${suffix}`;
  const forBothDevices = `md-both-${suffix}`;
  const replyFromSecond = `md-reply-${suffix}`;
  const groupTitle = `MD Group ${suffix}`;
  const groupMessage = `md-group-${suffix}`;
  const inviteGroupTitle = `MD Invite ${suffix.slice(-6)}`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD, { seedLocalStorage: RING_SEED });
  const bobDevice1 = await preparePage(bobDevice1Context, bob, PASSWORD, { seedLocalStorage: RING_SEED });

  // ── До второго устройства: обычная sealed-переписка ────────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, beforeSecondDevice);
  await openPrivateChat(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, beforeSecondDevice).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Группа, где Боб — владелец (экран «Invite Links» доступен только ему):
  // создаётся на первом устройстве до входа второго
  await createGroup(bobDevice1.page, aliceName, inviteGroupTitle);

  // ── Логин второго устройства НЕ перетирает первое ──────────────────────────
  // Чат с Алисой НЕ открываем: вся его история пока нечитаема, а лента из
  // одних пропущенных сообщений виснет в спиннере (известный шов, как в
  // keys_backup). Нечитаемость ассертим по счётчику после ожидания синка
  const bobDevice2 = await preparePage(bobDevice2Context, bob, PASSWORD, { seedLocalStorage: RING_SEED });
  await bobDevice2.page.waitForTimeout(4000);
  assert.equal(
    await findMessage(bobDevice2.page, beforeSecondDevice).count(),
    0,
    'old sealed history must stay unreadable on a brand-new device',
  );

  // Отправитель обнаруживает новое устройство после истечения TTL кэша списка
  await aliceSession.page.waitForTimeout(DEVICE_LIST_TTL_WAIT_MS);

  // ── Новое входящее приходит на ОБА устройства ──────────────────────────────
  await openPrivateChat(aliceSession.page, bob);
  await sendText(aliceSession.page, forBothDevices);
  // На первом устройстве открыт только что созданный чат группы — возвращаемся к Алисе
  await openPrivateChat(bobDevice1.page, alice);
  await findMessage(bobDevice1.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openPrivateChat(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // Первое устройство при этом НЕ разлогинено и живо (прежний баг: свежий
  // логин перетирал identity)
  await sendText(bobDevice2.page, replyFromSecond);
  await findMessage(aliceSession.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // …и исходящее со второго устройства появляется на первом (self-копия)
  await findMessage(bobDevice1.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Группа: SKDM-fan-out — читают оба устройства Боба ──────────────────────
  await createGroup(aliceSession.page, bobName, groupTitle);
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupMessage);

  await openGroupChat(bobDevice1.page, groupTitle);
  await findMessage(bobDevice1.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Инвайт-ссылки: у группы ОДНА основная ссылка, общая для устройств ─────
  // spec 003: источник истины — список сервера (group.invite.list, is_primary),
  // поэтому второе устройство видит ту же ссылку и ничего не создаёт
  const linkDevice1 = await readInvitesScreen(bobDevice1.page, inviteGroupTitle);
  assert.equal(countInvitesCreatedBy(bob), 1, 'first device must hold exactly one invite');
  const linkDevice2 = await readInvitesScreen(bobDevice2.page, inviteGroupTitle);
  assert.equal(countInvitesCreatedBy(bob), 1, 'second device must reuse the primary invite, not mint one');
  assert.equal(inviteToken(linkDevice1), inviteToken(linkDevice2), 'devices must share the primary invite token');
  // Повторный заход на экран ссылку не меняет и новых не создаёт
  assert.equal(await readInvitesScreen(bobDevice1.page, inviteGroupTitle), linkDevice1,
    'first device link changed between visits');
  assert.equal(await readInvitesScreen(bobDevice2.page, inviteGroupTitle), linkDevice2,
    'second device link changed between visits');
  assert.equal(countInvitesCreatedBy(bob), 1, 'repeat visits must not create new invites');

  // Ссылка рабочая с любого устройства: Чарли и Дейв входят через нативную
  // модалку приглашения (t.me/+hash-поведение)
  const joinByLink = async (page, token) => {
    await page.goto(`${baseUrl}#+${token}`, { waitUntil: 'domcontentloaded' });
    const modal = page.locator('.Modal .modal-dialog').filter({ has: page.getByRole('button', { name: /join group/i }) }).first();
    await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
    await modal.getByRole('button', { name: /join group/i }).first().click();
    await page.locator('.MiddleHeader').getByText(inviteGroupTitle)
      .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
  };
  const charlieSession = await preparePage(charlieContext, charlie, PASSWORD);
  await joinByLink(charlieSession.page, inviteToken(linkDevice2));
  const daveSession = await preparePage(daveContext, dave, PASSWORD);
  await joinByLink(daveSession.page, inviteToken(linkDevice1));
  // Оба устройства владельца видят вступивших (bob, alice, charlie, dave)
  await openGroupChat(bobDevice1.page, inviteGroupTitle);
  await membersCountLocator(bobDevice1.page, 4).waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, inviteGroupTitle);
  await membersCountLocator(bobDevice2.page, 4).waitFor({ state: 'visible', timeout: SIBLING_SYNC_TIMEOUT_MS });

  // ── Перезапуск второго устройства: ключи и копии персистентны ──────────────
  await relogin(bobDevice2.page, PASSWORD);
  await openPrivateChat(bobDevice2.page, alice);
  await findMessage(bobDevice2.page, forBothDevices).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findMessage(bobDevice2.page, replyFromSecond).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(bobDevice2.page, groupTitle);
  await findMessage(bobDevice2.page, groupMessage).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // …и своя ссылка устройства переживает рестарт, не плодя новых
  assert.equal(await readInvitesScreen(bobDevice2.page, inviteGroupTitle), linkDevice2,
    'second device link changed after restart');
  assert.equal(countInvitesCreatedBy(bob), 1, 'restart must not create a new invite');

  // ── Групповой вызов звонит на ОБА устройства, входит только принявшее ──────
  // Снять звонок на остальных устройствах без нового сигнала протокола нельзя
  // (research R18): они замолкают по своему таймауту вызова (≤ 45 с; здесь
  // переопределён в 10 с). Их поздний reject{declined} уходит инициатору с тем
  // же call_id, что и парный invite, — и НЕ должен ронять сессию с принявшим
  // устройством (в звонке на двоих это заканчивало бы звонок целиком)
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const ringStartedAt = Date.now();
  const consentOn = (page) => page.getByText(`${groupTitle}: group call`, { exact: true });
  for (const [label, session] of [['device 1', bobDevice1], ['device 2', bobDevice2]]) {
    await consentOn(session.page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => {
      assert.fail(`${label}: входящий групповой вызов не позвонил`);
    });
    assert.equal(await session.page.evaluate(() => globalThis.__parvaneGumCalls), 0,
      `${label}: getUserMedia before consent`);
  }
  await acceptGroupCall(bobDevice1.page, 'bob device 1');
  await waitActivePeers(aliceSession.page, 1, 'alice with bob device 1');
  await waitActivePeers(bobDevice1.page, 1, 'bob device 1 with alice');
  await expectMediaFlowing(aliceSession.page, { audio: true, minPeers: 1 });
  // Второе устройство всё ещё звонит: мгновенного снятия у протокола нет
  assert.equal(await consentOn(bobDevice2.page).count(), 1,
    'device 2 consent screen vanished right after device 1 accepted — no such protocol signal exists');
  // …и замолкает по своему таймауту вызова
  await consentOn(bobDevice2.page).waitFor({ state: 'hidden', timeout: RING_TIMEOUT_SPEC_MAX_MS + 5000 }).catch(() => {
    assert.fail('device 2 kept ringing past the spec maximum of 45 s');
  });
  const silencedMs = Date.now() - ringStartedAt;
  assert(silencedMs <= RING_TIMEOUT_SPEC_MAX_MS, `device 2 silenced after ${silencedMs} ms (> 45 s)`);
  assert(silencedMs >= RING_TIMEOUT_MS - 1000,
    `device 2 silenced after ${silencedMs} ms — earlier than its own ring timeout (${RING_TIMEOUT_MS} ms)`);
  console.log(`second device stopped ringing ${silencedMs} ms after the invite (ring timeout ${RING_TIMEOUT_MS} ms)`);
  assert.equal(await bobDevice2.page.evaluate(() => globalThis.__parvaneGumCalls), 0,
    'device 2 opened the microphone without consent');
  assert.equal(await bobDevice2.page.locator('[data-peer]').count(), 0, 'device 2 entered the call');
  // Разговор принявшего устройства пережил отказ второго
  await aliceSession.page.waitForTimeout(2000);
  assert.equal(await aliceSession.page.locator('[data-peer-state="active"]').count(), 1,
    "device 2's late reject dropped device 1's session at the caller");
  assert.equal(await aliceSession.page.getByText('Group Call', { exact: true }).count(), 1,
    'group call ended at the caller after the second device gave up');
  assert.equal(await bobDevice1.page.locator('[data-peer-state="active"]').count(), 1,
    'device 1 lost its session after device 2 gave up');
  await expectMediaFlowing(aliceSession.page, { audio: true, minPeers: 1 });
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobDevice1.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  assertNoPageErrors({
    alice: aliceSession,
    'bob-device-1': bobDevice1,
    'bob-device-2': bobDevice2,
    charlie: charlieSession,
    dave: daveSession,
  });

  console.log('OK: мультидевайс — второй логин не перетирает первый, входящие и исходящие видны на обоих устройствах, '
    + 'группа читается, рестарт переживается, у каждого устройства своя рабочая инвайт-ссылка, '
    + 'групповой вызов звонит на оба устройства и живёт после отказа второго по таймауту');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [
    ['alice', aliceContext], ['bob-dev1', bobDevice1Context], ['bob-dev2', bobDevice2Context],
    ['charlie', charlieContext], ['dave', daveContext],
  ]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}multidevice-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}
