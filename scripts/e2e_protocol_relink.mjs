// Протокол v2 (spec 007, T195): выход и повторный вход на устройстве при живом втором.
// bob на двух web-устройствах (bob1 создал личность, bob2 привязан). bob1 переписывается
// с alice, затем полностью выходит (ключи устройства стёрты) и входит снова в том же
// браузере — идентификатор устройства прежний. bob2 подтверждает привязку. На bob1
// должны вернуться ОБЕ стороны переписки (свои исходящие и входящие), а новые сообщения
// после привязки — доходить в обе стороны.
// Затем bob2 завершает сеанс bob1 («выйти на других устройствах»): отозванное устройство
// держало ключ подписи устройств, а ключ восстановления «утерян» — bob2 сбрасывает
// защищённую личность НА МЕСТЕ (история и чаты остаются, показан новый ключ). bob1 входит
// тем же паролем: отозванный идентификатор устройства сервер не принимает, клиент входит
// новым устройством (а не «неверный пароль») и привязывается от bob2.
// Запуск: scripts/run_protocol_mixed_e2e.sh relink
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  clickUntil,
  closeSettings,
  dismissRecoveryKeyDialog,
  dumpDiagJournal,
  findMessage,
  linkSecondDevice,
  logOut,
  LOGIN_TIMEOUT_MS,
  openDevicesScreen,
  openPrivateChatStrict,
  preparePage,
  relogin,
  sendText,
  submitNick,
  terminateSessionWithPassword,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-v2-relink-password';
const V2_SEED = { 'parvane:proto': 'v2' };

const browser = await chromium.launch();
const names = ['alice', 'bob1', 'bob2'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await browser.newContext()])));
const logs = Object.fromEntries(names.map((n) => [n, []]));
const sessions = {};

names.forEach((who) => {
  contexts[who].on('page', (page) => {
    page.on('console', (m) => {
      const t = m.text();
      if (t.includes('[parvane]')) logs[who].push(t.slice(0, 300));
    });
    page.on('pageerror', (e) => logs[who].push(`pageerror: ${String(e).slice(0, 500)}`));
  });
});

async function waitLog(who, needle, from = 0, timeout = LOGIN_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (logs[who].slice(from).some((l) => l.includes(needle))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 200); });
  }
  throw new Error(`${who}: нет записи «${needle}»`);
}

async function expectMessages(page, who, texts) {
  for (const text of texts) {
    // eslint-disable-next-line no-await-in-loop
    await findMessage(page, text).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
      .catch(() => { throw new Error(`${who}: нет сообщения «${text}»`); });
  }
}

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const alice = `rla-${suffix}@local`;
  const bob = `rlb-${suffix}@local`;

  sessions.alice = await preparePage(contexts.alice, alice, PASSWORD, { seedLocalStorage: V2_SEED });
  sessions.bob1 = await preparePage(contexts.bob1, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  await Promise.all(['alice', 'bob1'].map((who) => waitLog(who, 'v2: готов')));
  await dismissRecoveryKeyDialog(sessions.alice.page);
  await dismissRecoveryKeyDialog(sessions.bob1.page);
  const alicePage = sessions.alice.page;
  const bob1Page = sessions.bob1.page;

  // Переписка до появления второго устройства
  const early = `rl-early-own-${suffix}`;
  const earlyIn = `rl-early-in-${suffix}`;
  await openPrivateChatStrict(bob1Page, alice);
  await sendText(bob1Page, early);
  await openPrivateChatStrict(alicePage, bob);
  await findMessage(alicePage, early).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, earlyIn);
  await findMessage(bob1Page, earlyIn).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });

  // Второе устройство bob
  sessions.bob2 = await preparePage(contexts.bob2, bob, PASSWORD, { seedLocalStorage: V2_SEED });
  const bob2Page = sessions.bob2.page;
  await linkSecondDevice(bob1Page, bob2Page);
  await openPrivateChatStrict(bob2Page, alice);
  await expectMessages(bob2Page, 'bob2 после привязки', [early, earlyIn]);

  // Переписка при двух устройствах: писал bob1
  const own = `rl-own-${suffix}`;
  const incoming = `rl-in-${suffix}`;
  await openPrivateChatStrict(bob1Page, alice);
  await sendText(bob1Page, own);
  await findMessage(alicePage, own).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, incoming);
  await findMessage(bob1Page, incoming).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await expectMessages(bob2Page, 'bob2 (второе устройство)', [own, incoming]);
  console.log('до выхода: обе стороны переписки есть на обоих устройствах bob');

  // bob1 выходит и входит снова в том же браузере
  const mark = logs.bob1.length;
  await logOut(bob1Page);
  await submitNick(bob1Page, bob);
  const passwordScreen = bob1Page.locator('.Transition_slide-active > #auth-password-form');
  await passwordScreen.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await passwordScreen.locator('#sign-in-password').fill(PASSWORD);
  await clickUntil(
    passwordScreen.getByRole('button', { name: 'Next' }),
    () => bob1Page.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS }),
    { settleMs: 15000 },
  );
  await waitLog('bob1', 'нужна линковка этого устройства', mark);
  await linkSecondDevice(bob2Page, bob1Page);
  console.log('bob1 вышел, вошёл снова и привязан вторым устройством');

  await openPrivateChatStrict(bob1Page, alice);
  await expectMessages(bob1Page, 'bob1 после повторной привязки', [earlyIn, incoming, early, own]);

  // Новые сообщения после привязки — в обе стороны и на оба устройства
  const after = `rl-after-own-${suffix}`;
  const afterIn = `rl-after-in-${suffix}`;
  await sendText(bob1Page, after);
  await findMessage(alicePage, after).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, afterIn);
  await expectMessages(bob1Page, 'bob1 (новые)', [afterIn]);
  await expectMessages(bob2Page, 'bob2 (новые)', [after, afterIn]);
  console.log('повторная привязка: обе стороны переписки на месте');

  // ── bob2 завершает сеанс bob1; ключ восстановления утерян — сброс на месте ──
  const resetMark = logs.bob2.length;
  const dev2 = await openDevicesScreen(bob2Page);
  const otherSession = dev2.locator('.ListItem').filter({ hasText: 'Web ' }).first();
  await otherSession.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await terminateSessionWithPassword(bob2Page, otherSession, PASSWORD);
  await dev2.getByText('Device signing key').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await dev2.locator('.ListItem').filter({ hasText: 'Reset secure identity' }).locator('.ListItem-button').click();
  const resetInput = bob2Page.locator('.Modal input[aria-label="Current password"]');
  await resetInput.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await resetInput.fill(PASSWORD);
  await bob2Page.locator('.Modal').getByRole('button', { name: 'Reset', exact: true }).click();
  await waitLog('bob2', 'личность сброшена на работающем устройстве', resetMark);
  await waitLog('bob2', 'v2: готов', resetMark);
  const newKey = await dismissRecoveryKeyDialog(bob2Page);
  assert.ok(newKey, 'bob2: после сброса не показан новый ключ восстановления');
  await dev2.getByText('Device signing key').waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS });
  await closeSettings(bob2Page);
  await openPrivateChatStrict(bob2Page, alice);
  await expectMessages(bob2Page, 'bob2 после сброса личности', [early, earlyIn, own, incoming, after, afterIn]);
  console.log('bob2 сбросил личность на месте: история осталась, показан новый ключ');

  // ── bob1 (отозван) входит тем же паролем — новым устройством ───────────────
  const reloginMark = logs.bob1.length;
  await relogin(bob1Page, PASSWORD);
  await waitLog('bob1', 'вход новым устройством', reloginMark);
  await waitLog('bob1', 'нужна линковка этого устройства', reloginMark);
  await linkSecondDevice(bob2Page, bob1Page);
  await openPrivateChatStrict(bob1Page, alice);
  await expectMessages(bob1Page, 'bob1 после отзыва и новой привязки', [earlyIn, incoming, early, own]);

  // Переписка после сброса: в обе стороны, на оба устройства
  const fresh = `rl-fresh-own-${suffix}`;
  const freshIn = `rl-fresh-in-${suffix}`;
  await sendText(bob2Page, fresh);
  await findMessage(alicePage, fresh).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await sendText(alicePage, freshIn);
  await expectMessages(bob2Page, 'bob2 (после сброса)', [freshIn]);
  await expectMessages(bob1Page, 'bob1 (после сброса)', [fresh, freshIn]);
  console.log('e2e_protocol_relink: OK');
} catch (error) {
  const shotDir = process.env.PARVANE_E2E_SHOT_DIR || 'web/telegram-tt/test-results';
  for (const who of names) {
    const session = sessions[who];
    if (!session) continue;
    // eslint-disable-next-line no-await-in-loop
    await session.page.screenshot({ path: `${shotDir}/protocol-relink-${who}.png` }).catch(() => undefined);
    // eslint-disable-next-line no-await-in-loop
    await dumpDiagJournal(session.page, who);
    console.error(`журнал ${who}:\n${logs[who].slice(-70).join('\n')}`);
  }
  throw error;
} finally {
  await browser.close();
}
