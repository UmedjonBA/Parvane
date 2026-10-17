// Правка ссылки-приглашения и «кто вступил» (spec 024 И1): у созданной ссылки меняются название и лимит,
// счётчик вступивших прежний; карточка ссылки показывает вступивших; одобренная заявка по ссылке «по
// заявке» считается в ней; отозванную ссылку править нельзя.
import assert from 'node:assert/strict';

import { chromium } from '../web/telegram-tt/node_modules/playwright/index.mjs';

import {
  assertNoPageErrors,
  callProviderForChat,
  createGroupViaUi,
  inviteAppUrl,
  LOGIN_TIMEOUT_MS,
  openPrivateChatStrict,
  preparePage,
  readInvitesScreen,
  reloadPage,
  requireEnv,
  sendText,
} from './e2e_web_helpers.mjs';

const PASSWORD = 'Parvane-invite-edit-e2e-password';

async function acceptInviteModal(page, buttonName) {
  const modal = page.locator('.Modal .modal-dialog').filter({ has: page.getByRole('button', { name: buttonName }) }).first();
  await modal.waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS * 2 });
  await modal.getByRole('button', { name: buttonName }).first().click();
  await modal.waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
}

async function poll(read, isDone, message, timeout = LOGIN_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (isDone(last)) return last;
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

const { baseUrl } = requireEnv();
const browser = await chromium.launch();
const names = ['alice', 'bob', 'carol', 'dave'];
const contexts = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await browser.newContext()])));
const sessions = {};

try {
  const suffix = `${Date.now()}-${process.pid}`;
  const address = (name) => `ied-${name}-${suffix}@local`;
  const title = `Links ${suffix}`;
  for (const name of names) sessions[name] = await preparePage(contexts[name], address(name), PASSWORD);
  const { page: a } = sessions.alice;

  await openPrivateChatStrict(a, address('bob'));
  await sendText(a, `hi-${suffix}`);
  await createGroupViaUi(a, title, [address('bob').split('@')[0]]);
  await readInvitesScreen(a, title);

  const provider = (method, args) => callProviderForChat(a, method, title, undefined, { peer: '$chat', ...args });
  const created = await provider('exportChatInvite', { title: 'Старое', usageLimit: 5 });
  const link = created.result?.link;
  assert(link, `ссылка не создана: ${JSON.stringify(created)}`);

  // Кэрол вступает по ссылке — карточка ссылки знает её
  await sessions.carol.page.goto(inviteAppUrl(baseUrl, link), { waitUntil: 'domcontentloaded' });
  await acceptInviteModal(sessions.carol.page, /join group/i);
  const joined = await poll(
    () => provider('fetchChatInviteImporters', { link }),
    (answer) => (answer.result?.importers || []).length === 1,
    'вступившая по ссылке не видна',
  );
  const carolId = await a.evaluate((addr) => Object.values(window.__parvaneGetGlobal().users.byId)
    .find((user) => user.usernames?.some(({ username }) => username === addr.split('@')[0]))?.id, address('carol'));
  assert.equal(joined.result.importers[0].userId, carolId, 'в списке именно Кэрол');
  console.log('OK: вступившие по ссылке видны');

  // Правка: название и лимит; счётчик прежний
  const edited = await provider('editExportedChatInvite', { link, title: 'Новое', usageLimit: 3 });
  assert.equal(edited.result?.newInvite?.title, 'Новое', `название не сменилось: ${JSON.stringify(edited)}`);
  assert.equal(edited.result?.newInvite?.usageLimit, 3, 'лимит не сменился');
  assert.equal(edited.result?.newInvite?.usage, 1, 'счётчик вступивших сбросился');
  // Режим «по заявке» правкой не меняется
  const modeChange = await provider('editExportedChatInvite', { link, title: 'Новое', isRequestNeeded: true });
  assert.equal(modeChange.result, null, '«по заявке» поменялся правкой');
  console.log('OK: правка ссылки сохраняет счётчик');

  // Экран ссылки: название и вступившая
  // Экран ссылок перечитывает список при открытии — открываем его заново после правки
  await reloadPage(a);
  await a.locator('#LeftColumn').waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await readInvitesScreen(a, title, { keepOpen: true });
  const right = a.locator('#RightColumn');
  await right.getByText('Новое').first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  await right.getByText('Новое').first().click();
  await right.getByText(/1 joined|1 participant|joined/i).first().waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS })
    .catch(() => {});
  await right.locator('.ListItem').filter({ hasText: address('carol').split('@')[0] }).first()
    .waitFor({ state: 'visible', timeout: LOGIN_TIMEOUT_MS });
  console.log('OK: карточка ссылки показывает вступившую');

  // Ссылка «по заявке»: одобренная заявка считается в ней
  const request = await provider('exportChatInvite', { title: 'Заявки', isRequestNeeded: true });
  const requestLink = request.result?.link;
  assert(requestLink, 'ссылка по заявке не создана');
  await sessions.dave.page.goto(inviteAppUrl(baseUrl, requestLink), { waitUntil: 'domcontentloaded' });
  await acceptInviteModal(sessions.dave.page, /request to join/i);
  const requested = await poll(
    () => provider('fetchChatInviteImporters', { link: requestLink, isRequested: true }),
    (answer) => (answer.result?.importers || []).length === 1,
    'заявка не видна у своей ссылки',
  );
  const otherLink = await provider('fetchChatInviteImporters', { link, isRequested: true });
  assert.equal((otherLink.result?.importers || []).length, 0, 'заявка по другой ссылке попала в эту');
  const daveId = requested.result.importers[0].userId;
  const decided = await a.evaluate(async ({ chatTitle, userId }) => {
    const global = window.__parvaneGetGlobal();
    const chat = Object.values(global.chats.byId).find((candidate) => candidate.title === chatTitle);
    return window.__parvaneDiagCallApi('hideChatJoinRequest', {
      peer: chat, user: global.users.byId[userId], isApproved: true,
    });
  }, { chatTitle: title, userId: daveId });
  assert.equal(decided, true, 'заявка не одобрена');
  await poll(
    () => provider('fetchChatInviteImporters', { link: requestLink }),
    (answer) => (answer.result?.importers || []).some((importer) => importer.userId === daveId),
    'одобренный не попал во вступивших по ссылке',
  );
  const invites = (await provider('fetchExportedChatInvites', {})).result?.invites || [];
  assert.equal(invites.find((invite) => invite.link === requestLink)?.usage, 1, 'одобренный не посчитан в ссылке');
  console.log('OK: одобренная заявка считается в своей ссылке');

  // Отозванную — не править
  await provider('editExportedChatInvite', { link, isRevoked: true });
  const afterRevoke = await provider('editExportedChatInvite', { link, title: 'Снова' });
  assert.equal(afterRevoke.result, null, 'отозванная ссылка изменилась');
  console.log('OK: отозванную ссылку править нельзя');

  assertNoPageErrors(sessions);
  console.log('OK: сценарий правки ссылок пройден');
} finally {
  await browser.close();
}
