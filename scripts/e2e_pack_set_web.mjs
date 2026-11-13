// PACK-1 (spec 036 T026): два одноимённых набора стикеров разных отправителей — web ↔ desktop ↔ android. Web-часть
// сценария `android/tgx_pack_set_flow.sh` (стенд tgx_protocol_link_flow: alice — desktop + X, bob — desktop; стек,
// эмулятор и vite preview уже подняты).
// carol (web) создаёт свой набор «Котики» из файлов раннера и шлёт его стикер alice и bob; bob (desktop) шлёт carol
// стикер СВОЕГО «Котики» (те же имена файлов, другое содержимое). У carol — два разных набора; «В избранное» стикер
// чужого набора и своего пишет в журнал общий id (`h:<отпечаток>/<файл>`), тот же, что у desktop и X.
// Обмен с раннером — файлы в PV_OUT: `web.carol` (адрес carol), `web.sent` (стикеры ушли). Строки `ok …` / `FAIL …`
// разбирает раннер. Данные выдуманные.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  dismissRecoveryKeyDialog, LOGIN_TIMEOUT_MS, openPrivateChatStrict, preparePage,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-pack-set-2026';
const OUT = process.env.PV_OUT;
const STAMP = process.env.PV_STAMP || String(Date.now());
const ALICE = 'alice@local';
const BOB = 'bob@local';
const CAROL = `pkc-${STAMP}@local`;
const PACK = process.env.PV_PACK_NAME || 'Котики';
const H_BOB = process.env.PV_HASH_BOB;
const H_CAROL = process.env.PV_HASH_CAROL;
const FILES = ['01-1f600.png', '02-1f602.png'];
const WAIT_MS = 180000;

function ok(text) {
  console.log(`ok ${text}`);
}

function fail(text) {
  console.log(`FAIL ${text}`);
}

async function waitLog(logs, re, label, timeout = WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = logs.find((l) => re.test(l));
    if (hit) return hit;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  throw new Error(`${label}: нет в журнале web`);
}

const browser = await chromium.launch();
let session;
try {
  assert(OUT && H_BOB && H_CAROL, 'нужны PV_OUT, PV_HASH_BOB, PV_HASH_CAROL');
  session = await preparePage(await browser.newContext({ viewport: { width: 1400, height: 900 } }), CAROL, PASSWORD);
  const { page, logs } = session;
  await dismissRecoveryKeyDialog(page).catch(() => undefined);
  await page.waitForFunction(() => typeof window.__parvaneDiagCallApi === 'function', undefined,
    { timeout: LOGIN_TIMEOUT_MS });
  writeFileSync(join(OUT, 'web.carol'), CAROL);
  ok(`web: carol вошла (${CAROL})`);

  // Свой набор «Котики» из файлов раннера (байты те же — раннер знает отпечаток)
  const files = FILES.map((name) => ({ name, b64: readFileSync(join(OUT, 'carol', name)).toString('base64') }));
  const created = await page.evaluate(async ({ name, list }) => {
    const toFile = ({ name: fileName, b64 }) => new File(
      [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], fileName, { type: 'image/png' },
    );
    return window.__parvaneDiagCallApi('parvaneCreateStickerPack', { name, files: list.map(toFile) });
  }, { name: PACK, list: files });
  assert.equal(created?.title, PACK, `набор не создан: ${JSON.stringify(created)}`);
  const ownSetId = await page.evaluate(async (title) => {
    const got = await window.__parvaneDiagCallApi('fetchStickerSets', {});
    return (got?.sets || []).find((set) => set.title === title)?.id;
  }, PACK);
  assert.ok(ownSetId, 'свой набор не среди установленных');
  ok(`web: свой набор «${PACK}» создан (${ownSetId})`);

  // Второй стикер своего набора — alice (desktop + X); bob — в чат, который откроет его стикер (поиск по нику
  // находит не всех: у bob на стенде нет переписки с carol)
  const sendOwn = (chatId) => page.evaluate(async ({ setId, id }) => {
    const chat = window.__parvaneGetGlobal().chats.byId[id];
    if (!chat) return 'нет чата';
    const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id: setId } });
    const sticker = set?.stickers?.[1];
    if (!sticker) return 'нет стикера';
    await window.__parvaneDiagCallApi('sendMessage', { chat, sticker });
    return 'ok';
  }, { setId: ownSetId, id: chatId });
  await openPrivateChatStrict(page, ALICE);
  const aliceChatId = await page.evaluate((nick) => {
    const g = window.__parvaneGetGlobal();
    return Object.values(g.users.byId).find((u) => u.usernames?.some(({ username }) => username === nick))?.id;
  }, ALICE.split('@')[0]);
  const sentAlice = await sendOwn(aliceChatId);
  assert.equal(sentAlice, 'ok', `стикер alice: ${sentAlice}`);
  writeFileSync(join(OUT, 'web.sent'), '1');
  ok('web: стикер своего «Котики» отправлен alice');

  // Стикер bob (desktop): одноимённый набор с другим содержимым — отдельный набор
  const dumpIncoming = () => page.evaluate(() => {
    const g = window.__parvaneGetGlobal();
    return Object.values(g.messages.byChatId).flatMap((c) => Object.values(c.byId || {}))
      .filter((m) => !m.isOutgoing).slice(-10)
      .map((m) => ({ chat: m.chatId, keys: Object.keys(m.content || {}), set: m.content?.sticker?.stickerSetInfo }));
  }).catch((err) => String(err));
  const incomingMessage = await (await page.waitForFunction((own) => {
    const g = window.__parvaneGetGlobal();
    const found = Object.values(g.messages.byChatId).flatMap((c) => Object.values(c.byId || {}))
      .filter((m) => !m.isOutgoing && m.content?.sticker?.stickerSetInfo?.id
        && m.content.sticker.stickerSetInfo.id !== own)
      .sort((x, y) => y.date - x.date)[0];
    return found ? { chatId: found.chatId, sticker: found.content.sticker } : undefined;
  }, ownSetId, { timeout: WAIT_MS }).catch(async (err) => {
    console.log(`входящие web: ${JSON.stringify(await dumpIncoming())}`);
    throw err;
  })).jsonValue();
  const incoming = incomingMessage.sticker;
  const bobSetId = incoming.stickerSetInfo.id;
  const sentBob = await sendOwn(incomingMessage.chatId);
  assert.equal(sentBob, 'ok', `стикер bob: ${sentBob}`);
  writeFileSync(join(OUT, 'web.sent2'), '1');
  ok(`web: стикер своего «Котики» отправлен ${BOB} в его чат`);
  assert.notEqual(bobSetId, ownSetId, 'набор bob слился со своим');
  ok(`web: стикер bob пришёл с отдельным набором (${bobSetId} ≠ ${ownSetId})`);
  const installed = await page.evaluate(
    (id) => window.__parvaneDiagCallApi('installStickerSet', { stickerSetId: id }), bobSetId,
  );
  assert.ok(installed, 'набор bob не установлен');
  const sets = await page.evaluate(async ({ own, other }) => {
    const got = await window.__parvaneDiagCallApi('fetchStickerSets', {});
    const pick = async (id) => {
      const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id } });
      return set ? { title: set.set?.title, count: set.stickers?.length, first: set.stickers?.[0]?.id } : undefined;
    };
    return {
      ids: (got?.sets || []).map((s) => s.id).filter((id) => id === own || id === other),
      own: await pick(own),
      other: await pick(other),
    };
  }, { own: ownSetId, other: bobSetId });
  assert.equal(sets.ids.length, 2, `установлено наборов: ${JSON.stringify(sets)}`);
  assert.ok(sets.own?.count === 2 && sets.other?.count === 2 && sets.own.first !== sets.other.first,
    `содержимое наборов: ${JSON.stringify(sets)}`);
  ok(`web: два набора «${PACK}», у каждого свои стикеры (${JSON.stringify(sets)})`);

  // «В избранное»: стикер bob из ленты и свой — общий id набора (PACK-1) с отпечатком содержимого
  await page.evaluate((sticker) => window.__parvaneDiagCallApi('faveSticker', { sticker }), incoming);
  const bobLine = await waitLog(logs, /избранное \(PACK-1\): .* добавлен/, 'избранное bob');
  const wantBob = `h:${H_BOB}/${FILES[0]}`;
  if (bobLine.includes(`избранное (PACK-1): ${wantBob} добавлен`)) ok(`web: избранное стикера bob — ${wantBob}`);
  else fail(`web: избранное стикера bob — ${bobLine}, ждали ${wantBob}`);
  await page.evaluate(async (setId) => {
    const set = await window.__parvaneDiagCallApi('fetchStickerSet', { stickerSetInfo: { id: setId } });
    await window.__parvaneDiagCallApi('faveSticker', { sticker: set.stickers[0] });
  }, ownSetId);
  const wantOwn = `h:${H_CAROL}/${FILES[0]}`;
  await waitLog(logs, new RegExp(`избранное \\(PACK-1\\): ${wantOwn.replace(/[+/=]/g, '\\$&')} добавлен`),
    'избранное своего').then(() => ok(`web: избранное своего стикера — ${wantOwn}`))
    .catch(() => fail(`web: избранное своего стикера не ${wantOwn}: ${logs.filter((l) => l.includes('PACK-1')).join(' | ')}`));
  // Избранное на устройстве — оба стикера, наборы не перепутаны
  const faved = await page.evaluate(async () => (await window.__parvaneDiagCallApi('fetchFavoriteStickers', {}))
    .stickers.map((s) => s.stickerSetInfo?.id));
  if (faved.includes(ownSetId) && faved.includes(bobSetId)) ok('web: в «Избранном» стикеры обоих наборов');
  else fail(`web: «Избранное» — наборы ${JSON.stringify(faved)}`);
  console.log('E2E_PACK_SET_WEB_DONE');
} catch (e) {
  fail(`web: ${e.message}`);
  console.log(`--- журнал web:\n${(session?.logs || []).slice(-60).join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
