// Трёхбраузерный групповой звонок: создание группы через UI, входящий вызов с
// согласием (микрофон не запрашивается до «Принять»), mesh с двумя active-пирами
// и реальным звуком, групповой видеозвонок, mute, выход участника, отклонение
// (в том числе при обратном порядке адресов, когда буфера с invite нет),
// «занят», приглашение от заблокированного контакта, TURN. Плюс: pairwise-записи
// mesh НЕ появляются в личной истории.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  checkCallAudioOutput,
  checkCallMinimize,
  expectSharedScreen,
  findCallTimer,
  mockCallMedia,
  saveCallState,
  stopScreenInBrowser,
} from './e2e_web_call_media.mjs';

import {
  LOGIN_TIMEOUT_MS,
  callMediaStats,
  dumpDiagJournal,
  exchangeMessages,
  expectMediaFlowing,
  findMessage,
  openPrivateChat,
  preparePage,
  remoteVideoLuma,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-group-calls-e2e-password';

async function selectPickerRow(page, containerSelector, name) {
  const row = page.locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
    .filter({ hasText: name })
    .first();
  await row.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (let attempt = 0; attempt < 6; attempt++) {
    const checked = await page
      .locator(`${containerSelector} .PeerPickerItem, ${containerSelector} .ItemPickerItem`)
      .filter({ hasText: name })
      .first()
      .locator('input[type="checkbox"]:checked')
      .count();
    if (checked > 0) return;
    if (attempt % 2 === 0) await row.press(' ').catch(() => {});
    else await row.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  assert.fail(`picker row for ${name} is never selected`);
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

// Входящий групповой вызов: экран согласия ОБЯЗАТЕЛЕН, а микрофон/камера
// открываются только ПОСЛЕ клика «Принять» (SC-010, US6/AC1). Раньше хелпер
// молча продолжал без кнопки — регрессия «снова автоподключаемся» оставила бы
// все потоки, кроме самого первого приглашения, зелёными
async function acceptGroupCall(page, label) {
  const accept = page.getByRole('button', { name: 'Accept' });
  await accept.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => {
    assert.fail(`${label}: экран согласия на групповой вызов не появился`);
  });
  // Счётчик getUserMedia есть только в контекстах с init-скриптом
  const gumBefore = await page.evaluate(() => globalThis.__parvaneGumCalls);
  await accept.click();
  if (gumBefore === undefined) return;
  await page.waitForFunction(
    (before) => globalThis.__parvaneGumCalls > before,
    gumBefore,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(() => {
    assert.fail(`${label}: после согласия микрофон так и не запрошен`);
  });
}

async function createGroup(page, members, title) {
  for (const member of members) await openPrivateChat(page, member);
  await page.mouse.move(800, 360);
  await page.waitForTimeout(200);
  await page.locator('#LeftColumn').hover();
  await page.locator('[data-add-for="chats"]').click();
  await page.getByRole('menuitem', { name: 'New group' }).click();
  const search = page.locator('#new-group-picker-search');
  await search.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  for (const member of members) {
    const name = member.split('@')[0];
    await search.fill(name);
    await selectPickerRow(page, '#LeftColumn', name);
  }
  await page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(title);
  await page.getByRole('button', { name: 'Create Group' }).click();
  await page.locator('#editable-message-text').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
}

async function waitActivePeers(page, count, label) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-peer-state="active"]').length === expected,
    count,
    { timeout: LOGIN_TIMEOUT_MS },
  ).catch(async () => {
    const mesh = await page.evaluate(() => ({
      peers: window.parvaneCall?.group?.peerStates,
      connections: (globalThis.__parvaneE2ePeers || []).map((peer) => ({
        connection: peer.connectionState,
        ice: peer.iceConnectionState,
        signaling: peer.signalingState,
        local: peer.localDescription?.type,
        remote: peer.remoteDescription?.type,
      })),
    }));
    assert.fail(`${label}: не дождались ${count} активных участников (${JSON.stringify(mesh)})`);
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
// Считаем вызовы getUserMedia: до согласия приглашённый не открывает микрофон
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

const RING_SEED = { 'parvane:e2e:ringTimeoutMs': '10000' };
const contexts = await Promise.all(
  Array.from({ length: 4 }, () => browser.newContext({ permissions: ['microphone', 'camera'] })),
);
await Promise.all(contexts.map((context) => countGetUserMedia(context)));
await mockCallMedia(contexts[0], true);
// Журналы диагностики при падении — по имени участника
const diagSessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `gc-alice-${suffix}@local`;
  const bob = `gc-bob-${suffix}@local`;
  const carol = `gc-carol-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const carolName = carol.split('@')[0];
  const aliceName = alice.split('@')[0];
  const groupTitle = `GC-${suffix.slice(-6)}`;

  const dave = `gc-dave-${suffix}@local`;
  const [aliceSession, bobSession, carolSession, daveSession] = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[1], bob, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[2], carol, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[3], dave, PASSWORD, { seedLocalStorage: RING_SEED }),
  ]);
  diagSessions.push(['alice', aliceSession], ['bob', bobSession], ['carol', carolSession], ['dave', daveSession]);

  // Ключи доставки с инициатором готовы до проверки согласия и соединений mesh
  await exchangeMessages(aliceSession.page, alice, bobSession.page, bob, `gc-ab-${suffix}`);
  await exchangeMessages(aliceSession.page, alice, carolSession.page, carol, `gc-ac-${suffix}`);
  // Боб и Кэрол до звонка не переписываются: их пара проверяет обмен ключами доступа по ходу звонка

  // ── Группа с тремя участниками через UI ────────────────────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.locator('[data-add-for="chats"]').click();
  await aliceSession.page.getByRole('menuitem', { name: 'New group' }).click();
  const memberSearch = aliceSession.page.locator('#new-group-picker-search');
  await memberSearch.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await memberSearch.fill(bobName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', bobName);
  await memberSearch.fill(carolName);
  await selectPickerRow(aliceSession.page, '#LeftColumn', carolName);
  await aliceSession.page.getByRole('button', { name: 'Continue To Group Info' }).click();
  const nameInput = aliceSession.page.getByLabel('Group name');
  await nameInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await nameInput.fill(groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Create Group' }).click();
  await aliceSession.page.locator('#editable-message-text')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Строка чата появляется раньше, чем участники дочитают журнал и первую эпоху группы
  const invited = [['bob', bobSession], ['carol', carolSession]];
  const groupGreeting = `gc-start-${suffix}`;
  await openGroupChat(aliceSession.page, groupTitle);
  await sendText(aliceSession.page, groupGreeting);
  await Promise.all(invited.map(async ([label, { page }]) => {
    await openGroupChat(page, groupTitle);
    await findMessage(page, groupGreeting).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
      .catch(() => assert.fail(`${label}: не получил первое сообщение группы`));
    await page.evaluate(() => {
      globalThis.__testFirstGroupStates = [];
      window.addEventListener('parvane-call', () => {
        const call = window.parvaneCall;
        if (call?.state === 'incoming') globalThis.__testFirstGroupStates.push(call.pendingGroupTitle);
      });
    });
  }));

  // ── Групповой звонок из шапки группы ───────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Оба экрана согласия должны появиться до первых парных офферов от принявших участников
  await Promise.all(invited.map(async ([label, { page }]) => {
    await page.locator('[data-call-screen="incoming"]').getByText(`${groupTitle}: group call`, { exact: true })
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(async () => {
        const titles = await page.evaluate(() => globalThis.__testFirstGroupStates);
        assert.fail(`${label}: не было приглашения в «${groupTitle}», полученные названия: ${JSON.stringify(titles)}`);
      });
    assert.equal(await page.evaluate(() => globalThis.__parvaneGumCalls), 0, 'getUserMedia before consent');
  }));
  await Promise.all(invited.map(([label, { page }]) => acceptGroupCall(page, label)));
  // После согласия: у каждого участника по два active-пира
  await waitActivePeers(aliceSession.page, 2, 'alice');
  await waitActivePeers(bobSession.page, 2, 'bob');
  await waitActivePeers(carolSession.page, 2, 'carol');

  // Звук реально идёт между всеми парами mesh
  await expectMediaFlowing(aliceSession.page, { audio: true, minPeers: 2 });
  await expectMediaFlowing(bobSession.page, { audio: true, minPeers: 2 });
  await expectMediaFlowing(carolSession.page, { audio: true, minPeers: 2 });
  // «Говорит» (доска `PhCalls`): гудки поддельного микрофона Chromium — речь участника
  await aliceSession.page.waitForFunction(
    () => Boolean(document.querySelector('[data-peer][data-peer-state="active"][data-speaking]')),
    undefined,
    { timeout: 15000 },
  ).catch(() => assert.fail('у Алисы ни один участник не «говорит»'));
  console.log('OK: состояние «говорит» у плитки участника');

  await checkCallAudioOutput(aliceSession.page, true, 2);
  const viewport = aliceSession.page.viewportSize();
  await aliceSession.page.setViewportSize({ width: 360, height: 800 });
  await checkCallMinimize(aliceSession.page, { minPeers: 2, shotPrefix: 'group-', isPhone: true });
  await aliceSession.page.setViewportSize(viewport);
  await saveCallState(aliceSession.page, 'group');
  await aliceSession.page.getByRole('button', { name: 'Share screen', exact: true }).click();
  const sharedTile = `[data-peer="${alice}"] video`;
  await Promise.all([bobSession, carolSession].map(({ page }) => expectSharedScreen(page, sharedTile)));
  await saveCallState(bobSession.page, 'group-screen');
  await stopScreenInBrowser(aliceSession.page);
  for (const { page } of [bobSession, carolSession]) {
    await page.locator(sharedTile).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  }
  console.log('OK: показ экрана доходит по mesh до обоих участников и прекращается по событию браузера');

  // ── Mute в групповом звонке ────────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Значок «микрофон выключен» на плитке Алисы у остальных (доски `PhCalls`, `DkCalls`)
  for (const page of [bobSession.page, carolSession.page]) {
    await page.locator(`[data-peer="${alice}"] [data-peer-muted]`).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  }
  console.log('OK: «микрофон выключен» на плитке участника');
  // «Включить камеру» в групповом звонке без камеры: кнопка видна всегда (видео согласовано с каждым)
  await bobSession.page.getByRole('button', { name: /^Turn camera (on|off)$/ }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Выход одного участника: mesh остальных живёт ───────────────────────────
  await aliceSession.page.getByRole('button', { name: 'End call' }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await waitActivePeers(bobSession.page, 1, 'bob after alice left');
  await waitActivePeers(carolSession.page, 1, 'carol after alice left');

  // ── Полный роспуск ─────────────────────────────────────────────────────────
  await bobSession.page.getByRole('button', { name: 'End call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Групповой ВИДЕОзвонок: кадры от двух других участников у каждого ────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'More actions' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Video call' }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await acceptGroupCall(bobSession.page, 'bob (video)');
  await acceptGroupCall(carolSession.page, 'carol (video)');
  await Promise.all([
    waitActivePeers(aliceSession.page, 2, 'alice video'),
    waitActivePeers(bobSession.page, 2, 'bob video'),
    waitActivePeers(carolSession.page, 2, 'carol video'),
  ]);
  const groupVideoConnectedAt = Date.now();
  // Кадры и звук от каждого другого участника не позже 10 с после соединения (SC-009)
  const participants = [
    ['alice', aliceSession, [bob, carol]],
    ['bob', bobSession, [alice, carol]],
    ['carol', carolSession, [alice, bob]],
  ];
  const reports = await Promise.all(participants.map(([, session]) => expectMediaFlowing(session.page, {
    audio: true, video: true, minPeers: 2, windowMs: 2000, timeoutMs: 10000, sinceMs: groupVideoConnectedAt,
  })));
  console.log(`group video call: frames and audio from every peer within ${Date.now() - groupVideoConnectedAt} ms`);
  // Плитка должна быть у КАЖДОГО собеседника поимённо и с живой картинкой:
  // голый счётчик `[data-peer] video` засчитывал и пустую, и оставшуюся от
  // вышедшего участника плитку (FR-052)
  for (const [index, [name, session, others]] of participants.entries()) {
    assert(reports[index].length >= 2, `${name}: expected two video peers`);
    for (const peer of others) {
      const selector = `[data-peer="${peer}"] video`;
      const tile = session.page.locator(selector);
      assert.equal(await tile.count(), 1, `${name}: no tile for ${peer}`);
      const luma = await remoteVideoLuma(session.page, selector);
      assert(luma.variance > 5, `${name}: tile for ${peer} is blank or frozen (${JSON.stringify(luma)})`);
    }
  }
  await aliceSession.page.getByRole('button', { name: 'End call' }).click();
  await bobSession.page.getByRole('button', { name: 'End call' }).click();
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение: Кэрол отказывается, у Алисы не висит «connecting» ──────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await carolSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const carolGumBefore = await carolSession.page.evaluate(() => globalThis.__parvaneGumCalls);
  const declinedAt = Date.now();
  await carolSession.page.getByRole('button', { name: 'End call' }).click();
  await acceptGroupCall(bobSession.page, 'bob (carol declined)');
  await waitActivePeers(aliceSession.page, 1, 'alice with bob only');
  assert.equal(
    await carolSession.page.evaluate(() => globalThis.__parvaneGumCalls),
    carolGumBefore,
    'declined invite opened the microphone',
  );
  // Строка должна закрыться быстрым reject{declined}, а не истечением
  // ringTimeoutMs (в тесте 10 с): иначе сломанный путь отказа прошёл бы
  await aliceSession.page.waitForFunction(
    () => document.querySelectorAll('[data-peer-state="connecting"]').length === 0,
    undefined,
    { timeout: 6000 },
  );
  const declineMs = Date.now() - declinedAt;
  assert(declineMs < 6000, `declined peer row cleared in ${declineMs} ms — looks like the ring timeout, not a reject`);
  // Строка Кэрол — именно «отклонил», а не просто закрытая
  await aliceSession.page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-peer-state="declined"]'))
      .some((row) => row.textContent.includes(name)),
    carolName,
    { timeout: 2000 },
  ).catch(() => {
    assert.fail('строка Кэрол у Алисы не пришла в состояние «отклонил»');
  });
  console.log(`group call decline cleared the row in ${declineMs} ms`);
  // «Позвать участника» (доски `PhCalls`, `DkCalls`): отказавшую зовут снова, она входит в идущий звонок.
  // Повтор того же звонка у отказавшей глушится 2,5 с — ждём их
  await aliceSession.page.waitForTimeout(3000);
  await aliceSession.page.locator('[data-call-free-place]').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.getByRole('button', { name: 'Invite participant', exact: true }).click();
  await aliceSession.page.locator('[data-call-invite-list]').getByRole('button', { name: carolName }).click();
  await acceptGroupCall(carolSession.page, 'carol (invited again)');
  await Promise.all([
    waitActivePeers(aliceSession.page, 2, 'alice after inviting carol'),
    waitActivePeers(bobSession.page, 2, 'bob after carol joined'),
    waitActivePeers(carolSession.page, 2, 'carol joined the running call'),
  ]);
  console.log('OK: отказавшую позвали снова — она в идущем звонке');
  for (const { page } of [aliceSession, bobSession]) {
    await page.getByRole('button', { name: 'End call' }).click();
  }
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение при ОБРАТНОМ порядке адресов ────────────────────────────────
  // Оффер в mesh шлёт лексикографически меньший адрес, поэтому приглашённому,
  // который сортируется РАНЬШЕ инициатора (Алиса < Кэрол), парный invite не
  // приходит и попарно отказать нечем. Отказ уровня звонка (reject с call_id =
  // id группового звонка, запечатанным конвертом v2 каждому участнику)
  // закрывает её строку у инициатора сразу — «отклонил», а не по таймауту
  // соединения (ringTimeoutMs, 10 с в тесте, 45 с в проде); у Боба, который
  // принял вызов позже, строка Алисы тоже «отклонил». Микрофон отказавшей не
  // открывается, звонок Кэрол с Бобом живёт
  assert(alice < carol, 'шаг рассчитан на адрес Алисы меньше адреса Кэрол');
  await openGroupChat(carolSession.page, groupTitle);
  await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const aliceGumBeforeReverse = await aliceSession.page.evaluate(() => globalThis.__parvaneGumCalls);
  const reverseDeclinedAt = Date.now();
  await aliceSession.page.getByRole('button', { name: 'End call' }).click();
  await aliceSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await carolSession.page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-peer-state="declined"]'))
      .some((row) => row.textContent.includes(name)),
    aliceName,
    { timeout: 5000 },
  ).catch(() => {
    assert.fail('строка Алисы у Кэрол не закрылась отказом за 5 с (обратный порядок адресов)');
  });
  const reverseDeclineMs = Date.now() - reverseDeclinedAt;
  assert(reverseDeclineMs < 5000, `reversed-order row closed in ${reverseDeclineMs} ms — looks like the ring timeout`);
  await acceptGroupCall(bobSession.page, 'bob (alice declined, reversed order)');
  await waitActivePeers(carolSession.page, 1, 'carol with bob only');
  // У Боба строка Алисы — тоже «отклонил» (отказ пришёл ему до согласия и применился при входе)
  await bobSession.page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-peer-state="declined"]'))
      .some((row) => row.textContent.includes(name)),
    aliceName,
    { timeout: 5000 },
  ).catch(() => {
    assert.fail('строка Алисы у Боба не в состоянии «отклонил»');
  });
  assert.equal(
    await aliceSession.page.evaluate(() => globalThis.__parvaneGumCalls),
    aliceGumBeforeReverse,
    'declined (reversed order) invite opened the microphone',
  );
  // Звонок Кэрол с Бобом пережил закрытие строки
  await waitActivePeers(carolSession.page, 1, 'carol with bob after alice row closed');
  console.log(`reversed-order group call decline: caller row closed in ${reverseDeclineMs} ms (call-level reject)`);
  await carolSession.page.getByRole('button', { name: 'End call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отказ в доступе к камере/микрофону при ПРИНЯТИИ группового вызова ──────
  // Граничный случай спеки: понятная ошибка, остальные участники не зависают.
  // Разрешение браузера подменять бесполезно (Chromium с фейковыми
  // устройствами выдаёт его сам), поэтому глушим сам getUserMedia у Кэрол
  await carolSession.page.evaluate(() => {
    const devices = navigator.mediaDevices;
    globalThis.__parvaneGumRestore = devices.getUserMedia.bind(devices);
    devices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await carolSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const deniedAt = Date.now();
  await carolSession.page.getByRole('button', { name: 'Accept' }).click();
  // Понятная ошибка вместо молчаливого провала
  await carolSession.page.getByText('No access to the microphone or camera', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Экран согласия не должен был успеть превратиться в «звонок»: у Кэрол нет
  // ни одной строки участника
  assert.equal(
    await carolSession.page.locator('[data-peer]').count(), 0,
    'denied device access still entered the call',
  );
  // Остальные не зависают в ожидании: строка Кэрол закрывается отказом, а не
  // истечением ringTimeoutMs (10 с в тесте)
  await acceptGroupCall(bobSession.page, 'bob (carol denied devices)');
  await aliceSession.page.waitForFunction(
    () => document.querySelectorAll('[data-peer-state="connecting"]').length === 0,
    undefined,
    { timeout: 8000 },
  );
  const deniedMs = Date.now() - deniedAt;
  assert(deniedMs < 8000, `denied peer row cleared in ${deniedMs} ms — looks like the ring timeout, not a reject`);
  console.log(`group call device-denial cleared the row in ${deniedMs} ms`);
  await carolSession.page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = globalThis.__parvaneGumRestore;
  });
  await aliceSession.page.getByRole('button', { name: 'End call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Занят: Боб в личном звонке с Дейвом — групповой вызов его не прерывает ─
  // v2 (по умолчанию, T135): личный звонок принимается только от того, кому
  // адресат уже отвечал (ключ доступа, D-08) — сначала переписка в обе стороны
  // (Дейв позже звонит и Алисе — знакомим обе пары сейчас, пока никто не в звонке)
  await exchangeMessages(daveSession.page, dave, aliceSession.page, alice, `gc-da-${suffix}`);
  await exchangeMessages(daveSession.page, dave, bobSession.page, bob, `gc-db-${suffix}`);
  await daveSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await bobSession.page.getByRole('button', { name: 'Accept' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  await findCallTimer(bobSession.page).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await acceptGroupCall(carolSession.page, 'carol (bob is busy)');
  await waitActivePeers(aliceSession.page, 1, 'alice with carol while bob is busy');
  // Боб остаётся в личном звонке: приглашение — карточкой поверх разговора (доска `DkCalls`), не экраном входящего
  const waitingCard = bobSession.page.getByRole('alertdialog', { name: 'Incoming call' });
  await waitingCard.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  assert.equal(
    await bobSession.page.getByText(`${groupTitle}: group call`, { exact: true }).count(),
    0,
    'busy user got a group call invite screen',
  );
  await findCallTimer(bobSession.page).waitFor({ state: 'visible', timeout: 5000 });
  await waitingCard.getByRole('button', { name: 'Decline', exact: true }).click();
  await waitingCard.waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  // Строка Боба у Алисы — именно «занят», а не просто закрытая по таймауту:
  // раньше проверялось только отсутствие `connecting`, и сломанный путь busy
  // прошёл бы за счёт истечения ringTimeoutMs (FR-062)
  await aliceSession.page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-peer-state="busy"]'))
      .some((row) => row.textContent.includes(name)),
    bobName,
    { timeout: 15000 },
  ).catch(() => {
    assert.fail('строка Боба у Алисы не пришла в состояние «занят»');
  });
  // Подпись «busy» — часть текста строки участника («<адрес> — busy»),
  // отдельного узла с этим словом нет
  await aliceSession.page.locator('[data-peer-state="busy"]').first()
    .getByText(/busy/).waitFor({ state: 'visible', timeout: 5000 });
  // Занятого зовут снова; «Принять» на карточке завершает личный звонок с Дейвом и вводит Боба в групповой
  await aliceSession.page.waitForTimeout(3000);
  await aliceSession.page.getByRole('button', { name: 'Invite participant', exact: true }).click();
  await aliceSession.page.locator('[data-call-invite-list]').getByRole('button', { name: bobName }).click();
  await waitingCard.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitingCard.getByRole('button', { name: 'Join', exact: true }).click();
  await daveSession.page.getByRole('button', { name: 'End call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await Promise.all([
    waitActivePeers(aliceSession.page, 2, 'alice after bob joined from the card'),
    waitActivePeers(bobSession.page, 2, 'bob joined from the card'),
  ]);
  console.log('OK: карточка приглашения поверх разговора — «Отклонить» даёт «занят», «Принять» переводит в групповой');
  // Личный звонок Алисе во время группового — «Line busy», групповой живёт
  await openPrivateChat(daveSession.page, alice);
  await daveSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await daveSession.page.getByText('Line busy', { exact: true }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitActivePeers(aliceSession.page, 2, 'alice group call survives a 1-1 attempt');
  for (const { page } of [aliceSession, bobSession]) {
    await page.getByRole('button', { name: 'End call' }).click();
  }
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Приглашение после отзыва ключа заблокированного контакта ─────────────
  await openPrivateChat(carolSession.page, alice);
  await carolSession.page.getByRole('button', { name: 'More actions' }).click();
  const blockedCallProbe = await carolSession.page.evaluate(() => {
    const before = globalThis.__parvaneGumCalls;
    globalThis.__testBlockedCallStates = [];
    window.addEventListener('parvane-call', () => {
      const call = window.parvaneCall;
      if (call?.state === 'incoming' || call?.group) globalThis.__testBlockedCallStates.push(call.state);
    });
    return before;
  });
  // Дожидаемся отзыва ключа, а затем проверяем эффект блокировки у адресата.
  // У звонящего строка закрывается по парному «занят» или по таймауту, если сигнал не дошёл
  await Promise.all([
    carolSession.page.waitForEvent('console', {
      predicate: (message) => message.text().includes('v2: доступ собеседника отозван — ключ доступа сменён'),
      timeout: LOGIN_TIMEOUT_MS,
    }),
    carolSession.page.getByRole('menuitem', { name: 'Block user' }).click(),
  ]);
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await acceptGroupCall(bobSession.page, 'bob (alice blocked by carol)');
  await waitActivePeers(aliceSession.page, 1, 'alice with bob while carol blocked her');
  const carolRow = aliceSession.page.locator(`[data-peer="${carol}"]:is([data-peer-state="busy"], [data-peer-state="ended"])`);
  await carolRow.waitFor({ state: 'visible', timeout: 15000 });
  const blockedCall = await carolSession.page.evaluate(() => ({
    calls: globalThis.__testBlockedCallStates,
    mediaRequests: globalThis.__parvaneGumCalls,
  }));
  assert.deepEqual(blockedCall.calls, [], 'Заблокированный контакт показал входящий или открыл групповой звонок');
  assert.equal(blockedCall.mediaRequests, blockedCallProbe, 'Заблокированный контакт открыл микрофон');
  console.log(`OK: после отзыва ключа Кэрол не звонит, строка закрыта (${await carolRow.getAttribute('data-peer-state')})`);

  await aliceSession.page.getByRole('button', { name: 'End call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Групповой звонок только через TURN ─────────────────────────────────────
  if (process.env.PARVANE_E2E_TURN) {
    const relaySeed = { 'parvane:e2e:forceRelay': '1' };
    const relayContexts = await Promise.all(
      Array.from({ length: 3 }, () => browser.newContext({ permissions: ['microphone'] })),
    );
    try {
      const names = ['relay-a', 'relay-b', 'relay-c'].map((name) => `gc-${name}-${suffix}@local`);
      const relaySessions = await Promise.all(names.map((name, index) => preparePage(
        relayContexts[index], name, PASSWORD, { seedLocalStorage: relaySeed },
      )));
      const relayTitle = `GCR-${suffix.slice(-6)}`;
      await createGroup(relaySessions[0].page, [names[1], names[2]], relayTitle);
      await openGroupChat(relaySessions[0].page, relayTitle);
      await relaySessions[0].page.getByRole('button', { name: 'Call', exact: true }).click();
      await acceptGroupCall(relaySessions[1].page, 'relay-b');
      await acceptGroupCall(relaySessions[2].page, 'relay-c');
      for (const session of relaySessions) {
        await waitActivePeers(session.page, 2, 'relay');
        await expectMediaFlowing(session.page, { audio: true, minPeers: 2 });
        const stats = await callMediaStats(session.page);
        assert(stats.every((entry) => entry.candidateType === 'relay'), `not relayed: ${JSON.stringify(stats)}`);
      }
      await relaySessions[0].page.getByRole('button', { name: 'End call' }).click();
      console.log('OK: групповой звонок только через TURN');
    } finally {
      await Promise.all(relayContexts.map((context) => context.close()));
    }
  } else {
    console.log('SKIP: TURN не поднят в стеке (нет go) — групповой relay-тест пропущен');
  }

  // ── Личная история НЕ засорена mesh-парами ─────────────────────────────────
  await aliceSession.page.waitForTimeout(3000);
  await openPrivateChat(aliceSession.page, bob);
  const strayCalls = await aliceSession.page
    .locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: 'Call' })
    .count();
  assert.equal(strayCalls, 0, 'mesh-пары группового звонка попали в личную историю');

  assert.deepEqual(aliceSession.errors, [], `alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `bob page errors: ${bobSession.errors.join('; ')}`);
  assert.deepEqual(carolSession.errors, [], `carol page errors: ${carolSession.errors.join('; ')}`);
  console.log('OK: групповой mesh-звонок трёх браузеров — звук между всеми парами, групповой видеозвонок с кадрами, '
    + 'mute, выход и чистая история');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  await Promise.all(contexts.map((context, index) => context.pages()[0]
    ?.screenshot({ path: `${dir}group-calls-${index}.png` }).catch(() => {})));
  for (const [label, session] of diagSessions) await dumpDiagJournal(session.page, label).catch(() => {});
  throw err;
} finally {
  await browser.close();
}
