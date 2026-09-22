// Трёхбраузерный групповой звонок: создание группы через UI, входящий вызов с
// согласием (микрофон не запрашивается до «Принять»), mesh с двумя active-пирами
// и реальным звуком, групповой видеозвонок, mute, выход участника, отклонение
// (в том числе при обратном порядке адресов, когда буфера с invite нет),
// «занят», приглашение от заблокированного контакта, TURN. Плюс: pairwise-записи
// mesh НЕ появляются в личной истории.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  LOGIN_TIMEOUT_MS,
  callMediaStats,
  dumpDiagJournal,
  expectMediaFlowing,
  openPrivateChat,
  preparePage,
  remoteVideoLuma,
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
  await page.getByRole('button', { name: 'New Message' }).click();
  await page.getByRole('menuitem', { name: 'New Group' }).click();
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
// Журналы диагностики при падении — по имени участника
const diagSessions = [];

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `gc-alice-${suffix}@local`;
  const bob = `gc-bob-${suffix}@local`;
  const carol = `gc-carol-${suffix}@local`;
  const bobName = bob.split('@')[0];
  const carolName = carol.split('@')[0];
  const groupTitle = `GC-${suffix.slice(-6)}`;

  const dave = `gc-dave-${suffix}@local`;
  const [aliceSession, bobSession, carolSession, daveSession] = await Promise.all([
    preparePage(contexts[0], alice, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[1], bob, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[2], carol, PASSWORD, { seedLocalStorage: RING_SEED }),
    preparePage(contexts[3], dave, PASSWORD, { seedLocalStorage: RING_SEED }),
  ]);
  diagSessions.push(['alice', aliceSession], ['bob', bobSession], ['carol', carolSession], ['dave', daveSession]);

  // Знакомим пиров (имена/чаты) до группового пикера
  await openPrivateChat(aliceSession.page, bob);
  await openPrivateChat(aliceSession.page, carol);

  // ── Группа с тремя участниками через UI ────────────────────────────────────
  await aliceSession.page.mouse.move(800, 360);
  await aliceSession.page.waitForTimeout(200);
  await aliceSession.page.locator('#LeftColumn').hover();
  await aliceSession.page.getByRole('button', { name: 'New Message' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'New Group' }).click();
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
  // Название группы на экране входящего есть только у того, кто уже знает её
  // состав: о новой группе участник узнаёт по первому сообщению в неё
  // (`refreshGroupsIfUnknownChat`), поэтому до звонка ждём, пока группа
  // появится в списке чатов у обоих приглашённых — иначе гонка с приглашением
  for (const [label, session] of [['bob', bobSession], ['carol', carolSession]]) {
    await session.page.locator('#LeftColumn .ListItem').filter({ hasText: groupTitle }).first()
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }).catch(() => {
        assert.fail(`${label}: новая группа не появилась в списке чатов`);
      });
  }

  // ── Групповой звонок из шапки группы ───────────────────────────────────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Входящий вызов с согласием: экран приглашения с названием группы
  // (приглашённый в ней состоит), микрофон не запрошен до «Принять» (FR-060)
  for (const session of [bobSession, carolSession]) {
    await session.page.getByText(`${groupTitle}: group call`, { exact: true })
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    assert.equal(await session.page.evaluate(() => globalThis.__parvaneGumCalls), 0, 'getUserMedia before consent');
  }
  await acceptGroupCall(bobSession.page, 'bob');
  await acceptGroupCall(carolSession.page, 'carol');
  // После согласия: у каждого участника по два active-пира
  await waitActivePeers(aliceSession.page, 2, 'alice');
  await waitActivePeers(bobSession.page, 2, 'bob');
  await waitActivePeers(carolSession.page, 2, 'carol');

  // Звук реально идёт между всеми парами mesh
  await expectMediaFlowing(aliceSession.page, { audio: true, minPeers: 2 });
  await expectMediaFlowing(bobSession.page, { audio: true, minPeers: 2 });
  await expectMediaFlowing(carolSession.page, { audio: true, minPeers: 2 });

  // ── Mute в групповом звонке ────────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Выход одного участника: mesh остальных живёт ───────────────────────────
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await waitActivePeers(bobSession.page, 1, 'bob after alice left');
  await waitActivePeers(carolSession.page, 1, 'carol after alice left');

  // ── Полный роспуск ─────────────────────────────────────────────────────────
  await bobSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Групповой ВИДЕОзвонок: кадры от двух других участников у каждого ────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'More actions' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Video Call' }).click();
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
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByRole('button', { name: 'End Call' }).click();
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение: Кэрол отказывается, у Алисы не висит «connecting» ──────────
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await carolSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const carolGumBefore = await carolSession.page.evaluate(() => globalThis.__parvaneGumCalls);
  const declinedAt = Date.now();
  await carolSession.page.getByRole('button', { name: 'End Call' }).click();
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
  console.log(`group call decline cleared the row in ${declineMs} ms`);
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение при ОБРАТНОМ порядке адресов ────────────────────────────────
  // Оффер в mesh шлёт лексикографически меньший адрес, поэтому приглашённому,
  // который сортируется РАНЬШЕ инициатора, парный invite не приходит и буфер у
  // него пуст. Доставить отказ нечем: call-шард форвардит reject только по
  // записи invite (group_invite записи не заводит), reject с локально
  // выделенным call_id он отбрасывает («неизвестный call_id», проверено по логу
  // шарда 17 сен). Честное поведение: строка у инициатора закрывается по
  // таймауту соединения MeshPeerSession (ringTimeoutMs, 10 с в тесте, 45 с в
  // проде), звонок с остальными живёт, микрофон отказавшего не открывается.
  // Мгновенный отказ здесь требует правки шарда (FR-001)
  await openGroupChat(carolSession.page, groupTitle);
  await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  const aliceGumBeforeReverse = await aliceSession.page.evaluate(() => globalThis.__parvaneGumCalls);
  const reverseDeclinedAt = Date.now();
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByText(`${groupTitle}: group call`, { exact: true })
    .waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await acceptGroupCall(bobSession.page, 'bob (alice declined, reversed order)');
  await waitActivePeers(carolSession.page, 1, 'carol with bob only');
  await carolSession.page.waitForFunction(
    () => document.querySelectorAll('[data-peer-state="connecting"]').length === 0,
    undefined,
    { timeout: 15000 },
  ).catch(() => {
    assert.fail('строка Алисы у Кэрол не закрылась и по таймауту соединения');
  });
  const reverseDeclineMs = Date.now() - reverseDeclinedAt;
  assert(reverseDeclineMs <= 15000, `reversed-order row cleared in ${reverseDeclineMs} ms`);
  assert.equal(
    await aliceSession.page.evaluate(() => globalThis.__parvaneGumCalls),
    aliceGumBeforeReverse,
    'declined (reversed order) invite opened the microphone',
  );
  // Звонок Кэрол с Бобом пережил закрытие строки
  await waitActivePeers(carolSession.page, 1, 'carol with bob after alice row closed');
  console.log(`reversed-order group call decline: caller row closed in ${reverseDeclineMs} ms (by connect timeout)`);
  await carolSession.page.getByRole('button', { name: 'End Call' }).click();
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
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Занят: Боб в личном звонке с Дейвом — групповой вызов его не прерывает ─
  await openPrivateChat(daveSession.page, bob);
  await daveSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await bobSession.page.getByRole('button', { name: 'Accept' }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  await bobSession.page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await acceptGroupCall(carolSession.page, 'carol (bob is busy)');
  await waitActivePeers(aliceSession.page, 1, 'alice with carol while bob is busy');
  // Боб остаётся в личном звонке, приглашения не видит
  await bobSession.page.waitForTimeout(2000);
  assert.equal(
    await bobSession.page.getByText(`${groupTitle}: group call`, { exact: true }).count(),
    0,
    'busy user got a group call invite screen',
  );
  await bobSession.page.getByText(/^\d+:\d{2}$/).first().waitFor({ state: 'visible', timeout: 5000 });
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
  // Личный звонок Алисе во время группового — «Line busy», групповой живёт
  await daveSession.page.getByRole('button', { name: 'End Call' }).click();
  await daveSession.page.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'End Call' }).waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS })
    .catch(() => {});
  await openPrivateChat(daveSession.page, alice);
  await daveSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await daveSession.page.getByText('Line busy', { exact: true }).waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitActivePeers(aliceSession.page, 1, 'alice group call survives a 1-1 attempt');
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await carolSession.page.getByText('Group Call', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Приглашение от заблокированного контакта не звонит ─────────────────────
  // Тот же guard, что и в личном вызове: заблокированный не должен заставлять
  // клиент жертвы звонить, начав групповой звонок (US5/AC6, FR-060)
  await openPrivateChat(carolSession.page, alice);
  await carolSession.page.getByRole('button', { name: 'More actions' }).click();
  await carolSession.page.getByRole('menuitem', { name: 'Block user' }).click();
  await carolSession.page.waitForTimeout(1500);
  await openGroupChat(aliceSession.page, groupTitle);
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await acceptGroupCall(bobSession.page, 'bob (alice blocked by carol)');
  await waitActivePeers(aliceSession.page, 1, 'alice with bob while carol blocked her');
  // Кадры до Кэрол доходят (на парный invite она отвечает «занят»), но экрана
  // входящего у неё нет и в звонок она не входит
  await aliceSession.page.waitForFunction(
    (name) => Array.from(document.querySelectorAll('[data-peer-state="busy"]'))
      .some((row) => row.textContent.includes(name)),
    carolName,
    { timeout: 15000 },
  ).catch(() => {
    assert.fail('строка Кэрол у Алисы не пришла в состояние «занят» — приглашение до неё не дошло');
  });
  assert.equal(
    await carolSession.page.getByText(`${groupTitle}: group call`, { exact: true }).count(),
    0,
    'blocked contact rang the group call consent screen',
  );
  assert.equal(
    await carolSession.page.locator('[data-peer]').count(), 0,
    'blocked contact pulled the victim into a group call',
  );
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
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
      await relaySessions[0].page.getByRole('button', { name: 'End Call' }).click();
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
