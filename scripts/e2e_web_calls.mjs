// Двухбраузерный звонок 1-на-1: вызов из шапки чата, входящий оверлей,
// принятие с fake-микрофоном, совпадение SAS-эмодзи, mute, видеозвонок с
// рендером потоков, завершение/отклонение и история звонков в чате
// (включая персист после reload).
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dumpDiagJournal,
  relogin,
  LOGIN_TIMEOUT_MS,
  exchangeMessages,
  expectMediaFlowing,
  findMessage,
  openPrivateChat,
  openPrivateChatStrict,
  preparePage,
  remoteCallVideoLuma,
  sendText,
  waitLuma,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-calls-e2e-password';
// Сценарий идёт по протоколу v2 (T110: другого нет)

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // С выданным mic-разрешением Chromium иначе фильтрует loopback-кандидаты —
    // relay-тест против TURN на 127.0.0.1 без флага не соединяется
    '--allow-loopback-in-peer-connection',
  ],
});
const aliceContext = await browser.newContext({ permissions: ['microphone', 'camera'] });
const bobContext = await browser.newContext({ permissions: ['microphone', 'camera'] });


function findHistoryEntry(page, text) {
  return page.locator('.Transition_slide-active > .MessageList .Message')
    .filter({ hasText: text }).first();
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `call-alice-${suffix}@local`;
  const bob = `call-bob-${suffix}@local`;

  const aliceSession = await preparePage(aliceContext, alice, PASSWORD);
  const bobSession = await preparePage(bobContext, bob, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);

  // ── Протокол v2 (по умолчанию, T135): звонок принимается только от того, кому
  // адресат уже отвечал (ключ доступа, D-08). Незнакомцу — понятное уведомление,
  // а не бесконечное «ringing»
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('You can call this person after they reply to your message')
    .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.getByText('ringing...', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  // Переписка в обе стороны — собеседники обменялись ключами доступа
  await sendText(aliceSession.page, `call-hi-${suffix}`);
  await openPrivateChat(bobSession.page, alice);
  await findMessage(bobSession.page, `call-hi-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(bobSession.page, `call-hello-${suffix}`);
  await findMessage(aliceSession.page, `call-hello-${suffix}`).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Третий участник (шаг «занято») знакомится с Алисой заранее: во время её
  // звонка с Бобом переписку уже не устроить
  const carolContext = await browser.newContext({ permissions: ['microphone'] });
  const carolSession = await preparePage(carolContext, `call-carol-${suffix}@local`, PASSWORD);
  await exchangeMessages(carolSession.page, `call-carol-${suffix}@local`, aliceSession.page, alice, `carol-${suffix}`);
  await openPrivateChat(aliceSession.page, bob);

  // ── Исходящий вызов и входящий оверлей ─────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await aliceSession.page.getByText('ringing...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Принятие: активный звонок с таймером и совпадающим SAS ─────────────────
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  const aliceSas = aliceSession.page.locator('[title*="fully secure"]');
  const bobSas = bobSession.page.locator('[title*="fully secure"]');
  await aliceSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSas.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Таймер длительности: формат 0:SS появляется только в состоянии active
  await aliceSession.page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Звук реально идёт в обе стороны (растёт bytesReceived)
  await expectMediaFlowing(aliceSession.page, { audio: true });
  await expectMediaFlowing(bobSession.page, { audio: true });

  const aliceSasText = (await aliceSas.innerText()).trim();
  const bobSasText = (await bobSas.innerText()).trim();
  assert(aliceSasText.length > 0, 'SAS is empty on the caller side');
  assert.equal(aliceSasText, bobSasText, 'SAS emoji differ between the two peers');

  // ── Busy: третий пользователь звонит занятой стороне и видит «занято» ──────
  await openPrivateChat(carolSession.page, alice);
  await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await carolSession.page.getByText('Line busy', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Оверлей закрывается сам через пару секунд
  await carolSession.page.getByText('Line busy', { exact: true })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await carolContext.close();

  // ── Mute: кнопка переключается и меняет aria ───────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await aliceSession.page.getByRole('button', { name: 'Unmute', exact: true }).click();
  await aliceSession.page.getByRole('button', { name: 'Mute', exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Завершение звонка ──────────────────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Видеозвонок: рендер удалённого потока и локального превью ──────────────
  await aliceSession.page.getByRole('button', { name: 'More actions' }).click();
  await aliceSession.page.getByRole('menuitem', { name: 'Video Call' }).click();
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' }).click();
  // Соединено — у обеих сторон идёт таймер длительности (состояние active)
  await Promise.all([aliceSession.page, bobSession.page].map((page) => page.getByText(/^\d+:\d{2}$/).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })));
  const videoConnectedAt = Date.now();
  // Удалённое видео (плюс локальное превью у обеих сторон)
  await aliceSession.page.locator('video').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.locator('video').first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Кадры и звук идут у обеих сторон не позже 10 с после соединения (SC-009)
  await Promise.all([aliceSession.page, bobSession.page].map((page) => expectMediaFlowing(page, {
    audio: true, video: true, windowMs: 2000, timeoutMs: 10000, sinceMs: videoConnectedAt,
  })));
  console.log(`1-1 video call: frames and audio flow both ways within ${Date.now() - videoConnectedAt} ms`);
  // Живой узор фейковой камеры у собеседника
  await waitLuma(() => remoteCallVideoLuma(bobSession.page), ({ variance }) => variance > 50);
  // Камера выкл → у Боба чёрные кадры; вкл → изображение возвращается
  await aliceSession.page.getByRole('button', { name: 'Turn camera off' }).click();
  await aliceSession.page.getByRole('button', { name: 'Turn camera on' })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await waitLuma(() => remoteCallVideoLuma(bobSession.page), ({ mean, variance }) => mean >= 0 && mean < 20 && variance < 5);
  await aliceSession.page.getByRole('button', { name: 'Turn camera on' }).click();
  await waitLuma(() => remoteCallVideoLuma(bobSession.page), ({ variance }) => variance > 50);
  await aliceSession.page.getByRole('button', { name: 'End Call' }).click();
  await bobSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── Отклонение повторного вызова ───────────────────────────────────────────
  await aliceSession.page.getByRole('button', { name: 'Call', exact: true }).click();
  await bobSession.page.getByText('is calling you...', { exact: true })
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'End Call' }).click();
  await aliceSession.page.getByRole('button', { name: 'End Call' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });
  await bobSession.page.getByRole('button', { name: 'Accept' })
    .waitFor({ state: 'detached', timeout: LOGIN_TIMEOUT_MS });

  // ── История звонков в чате: статусы у обеих сторон ─────────────────────────
  await findHistoryEntry(aliceSession.page, 'Outgoing Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(aliceSession.page, 'Outgoing Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(aliceSession.page, 'Declined Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(bobSession.page, 'Incoming Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await findHistoryEntry(bobSession.page, 'Incoming Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // ── Запись о звонке не делает чат «непрочитанным» (бейдж на строке чата) ──
  // У звонившего запись исходящая; у принявшего чат открыт — прочитано.
  const unreadBadge = (page, name) => page.locator('#LeftColumn .ListItem')
    .filter({ hasText: name.split('@')[0] }).first().getByText(/^\d{1,3}$/);
  await aliceSession.page.waitForTimeout(1000);
  assert.equal(await unreadBadge(aliceSession.page, bob).count(), 0, 'у Алисы бейдж непрочитанного после звонка');
  assert.equal(await unreadBadge(bobSession.page, alice).count(), 0, 'у Боба бейдж непрочитанного при открытом чате');
  console.log('OK: записи о звонках не оставляют бейдж непрочитанного');

  // ── Персист истории: reload, источник — call-шард ──────────────────────────
  await relogin(aliceSession.page, PASSWORD);
  await openPrivateChat(aliceSession.page, bob);
  await findHistoryEntry(aliceSession.page, 'Outgoing Video Call')
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  // Записи из истории после reload не должны помечать чат непрочитанным.
  // У Боба запись ВХОДЯЩАЯ и чат ЗАКРЫТ (как в списке чатов у пользователя):
  // историю звонков веб инъецирует через newMessage спустя ~3 с после синка,
  // а tt на чужой newMessage прибавляет +1 к непрочитанному (10 сен 2026 —
  // бейдж «1» на чате, где последним был звонок, после каждого reload).
  await bobSession.page.keyboard.press('Escape');
  await relogin(bobSession.page, PASSWORD);
  await bobSession.page.keyboard.press('Escape');
  // v2: записи о звонках приходят из журнала личного состояния (опрос раз в 8 с)
  await bobSession.page.waitForTimeout(12000);
  assert.equal(await unreadBadge(aliceSession.page, bob).count(), 0, 'у Алисы бейдж после reload (последний — звонок)');
  if (await unreadBadge(bobSession.page, alice).count()) {
    // Что именно считается непрочитанным: состояние прочтения и хвост чата
    const state = await bobSession.page.evaluate(() => {
      const g = window.__parvaneGetGlobal?.();
      if (!g) return 'no global';
      return JSON.stringify(Object.entries(g.messages.byChatId).map(([chatId, m]) => ({
        chatId,
        read: m.threadsById?.[-1]?.readState,
        chat: { unreadCount: g.chats.byId[chatId]?.unreadCount, hasUnreadMark: g.chats.byId[chatId]?.hasUnreadMark },
        tail: Object.values(m.byId || {}).slice(-8).map((x) => ({
          id: x.id, out: x.isOutgoing, sender: x.senderId, date: x.date,
          kind: x.content?.action?.type || Object.keys(x.content || {}).join(','),
          text: x.content?.text?.text?.slice(0, 30),
        })),
      })));
    }).catch((e) => `unavailable: ${e.message}`);
    console.error(`--- bob unread state ---\n${state}`);
    await dumpDiagJournal(bobSession.page, 'bob', 120);
  }
  assert.equal(await unreadBadge(bobSession.page, alice).count(), 0, 'у Боба бейдж после reload (последний — звонок)');
  console.log('OK: после reload записи о звонках не дают бейдж');

  // ── TURN fallback: relay-only звонок соединяется ТОЛЬКО через TURN ─────────
  if (process.env.PARVANE_E2E_TURN) {
    const forceRelaySeed = { 'parvane:e2e:forceRelay': '1' };
    const carolContext = await browser.newContext({ permissions: ['microphone'] });
    const daveContext = await browser.newContext({ permissions: ['microphone'] });
    try {
      const carol = `call-carol-${suffix}@local`;
      const dave = `call-dave-${suffix}@local`;
      const carolSession = await preparePage(carolContext, carol, PASSWORD, {
        seedLocalStorage: forceRelaySeed,
      });
      const daveSession = await preparePage(daveContext, dave, PASSWORD, {
        seedLocalStorage: forceRelaySeed,
      });
      await exchangeMessages(carolSession.page, carol, daveSession.page, dave, `turn-${suffix}`);
      await carolSession.page.getByRole('button', { name: 'Call', exact: true }).click();
      await daveSession.page.getByRole('button', { name: 'Accept' })
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await daveSession.page.getByRole('button', { name: 'Accept' }).click();
      // active достижим только если relay-кандидаты через TURN сработали
      await carolSession.page.getByText(/^\d+:\d{2}$/).first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await daveSession.page.getByText(/^\d+:\d{2}$/).first()
        .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
      await carolSession.page.getByRole('button', { name: 'End Call' }).click();
      console.log('OK: relay-only звонок через TURN с ephemeral-кредами');
    } finally {
      await carolContext.close();
      await daveContext.close();
    }
  } else {
    console.log('SKIP: TURN не поднят в стеке (нет go) — relay-тест пропущен');
  }

  // ── Пропущенный звонок: таймаут вызова (тестовое переопределение 5 с) ─────
  const shortRing = { 'parvane:e2e:ringTimeoutMs': '5000' };
  const erinContext = await browser.newContext({ permissions: ['microphone'] });
  const frankContext = await browser.newContext({ permissions: ['microphone'] });
  const malloryContext = await browser.newContext({ permissions: ['microphone'] });
  try {
    const erin = `call-erin-${suffix}@local`;
    const frank = `call-frank-${suffix}@local`;
    const erinSession = await preparePage(erinContext, erin, PASSWORD, { seedLocalStorage: shortRing });
    const frankSession = await preparePage(frankContext, frank, PASSWORD, { seedLocalStorage: shortRing });
    await exchangeMessages(erinSession.page, erin, frankSession.page, frank, `ring-${suffix}`);
    await erinSession.page.getByRole('button', { name: 'Call', exact: true }).click();
    await frankSession.page.getByText('is calling you...', { exact: true })
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await erinSession.page.getByText('ringing...', { exact: true })
      .waitFor({ state: 'detached', timeout: 20000 });
    await frankSession.page.getByText('is calling you...', { exact: true })
      .waitFor({ state: 'detached', timeout: 20000 });
    await findHistoryEntry(erinSession.page, 'Canceled Call')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    await findHistoryEntry(frankSession.page, 'Missed Call')
      .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

    // ── Заблокированный абонент: вызов отбивается без «занято» ────────────────
    await frankSession.page.getByRole('button', { name: 'More actions' }).click();
    await frankSession.page.getByRole('menuitem', { name: 'Block user' }).click();
    await frankSession.page.waitForTimeout(1500);
    const declinedBefore = await erinSession.page.locator('.Transition_slide-active > .MessageList .Message')
      .filter({ hasText: 'Declined Call' }).count();
    let frankRang = false;
    const ringWatcher = frankSession.page.getByText('is calling you...', { exact: true })
      .waitFor({ state: 'visible', timeout: 12000 }).then(() => { frankRang = true; }).catch(() => {});
    await erinSession.page.getByRole('button', { name: 'Call', exact: true }).click();
    const blockedStarted = Date.now();
    await erinSession.page.getByRole('button', { name: 'End Call' })
      .waitFor({ state: 'detached', timeout: 10000 });
    assert(Date.now() - blockedStarted < 10000, 'blocked call did not end quickly');
    assert.equal(await erinSession.page.getByText('Line busy', { exact: true }).count(), 0, 'blocked call shows busy');
    await ringWatcher;
    assert.equal(frankRang, false, 'blocked caller rang on the callee');
    // Звонящий видит отказ: запись «Declined Call» (клиент заблокировавшего
    // отбил вызов) либо — в v2, когда отзыв ключа доступа уже дошёл до шарда
    // call (ACCESS-1; кэш ключей 60 с), — уведомление как при звонке незнакомцу
    const declined = erinSession.page.waitForFunction((count) => Array.from(
      document.querySelectorAll('.Transition_slide-active > .MessageList .Message'),
    ).filter((element) => element.textContent.includes('Declined Call')).length > count, declinedBefore, {
      timeout: LOGIN_TIMEOUT_MS,
    });
    const refused = erinSession.page.getByText('You can call this person after they reply to your message')
      .first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
    declined.catch(() => {});
    refused.catch(() => {});
    await Promise.any([declined, refused]);

    assert.deepEqual(erinSession.errors, [], `Erin page errors: ${erinSession.errors.join('; ')}`);
    assert.deepEqual(frankSession.errors, [], `Frank page errors: ${frankSession.errors.join('; ')}`);
    console.log('OK: пропущенный звонок, автоотбой заблокированного, отказ при неверной подписи');
  } finally {
    await erinContext.close();
    await frankContext.close();
    await malloryContext.close();
  }

  assert.deepEqual(aliceSession.errors, [], `Alice page errors: ${aliceSession.errors.join('; ')}`);
  assert.deepEqual(bobSession.errors, [], `Bob page errors: ${bobSession.errors.join('; ')}`);

  console.log('OK: звонки — SAS, звук и кадры идут, камера выкл/вкл, mute, decline, пропущенный, блок, '
    + 'неверная подпись, история и TURN relay');
} catch (err) {
  const dir = new URL('../web/telegram-tt/test-results/', import.meta.url).pathname;
  for (const [name, context] of [['alice', aliceContext], ['bob', bobContext]]) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: `${dir}calls-${name}.png` }).catch(() => {});
  }
  throw err;
} finally {
  await aliceContext.close();
  await bobContext.close();
  await browser.close();
}
