// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type { SendMessageParams, ThreadReadState } from '../../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type {
  ApiAppConfig,
  ApiAvailableReaction,
  ApiBirthday,
  ApiChat, ApiDraft, ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiPeer,
  ApiPhoto,
  ApiSession,
  ApiSticker, ApiStickerSet, ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  ApiWallpaper,
  OnApiUpdate } from '../types';
import type { ServerInfo } from './connectionController';
import type { WireDeviceBundle } from './e2e';
import type { GatewayConnection } from './gateway';
import type { PackFile, StoredPack } from './stickerPacks';
import type { WireStoredMessage, WireUserInfo } from './wire';
import { MAIN_THREAD_ID } from '../types';

import {
  ARCHIVED_FOLDER_ID, MUTE_INDEFINITE_TIMESTAMP, PARVANE_LEGACY_APP_VERSION, UNMUTE_TIMESTAMP,
} from '../../config';
import { getLangStringByKey } from '../../util/localization';
import { diagLog } from '../../util/parvaneDiag';
import { DEFAULT_APP_CONFIG } from '../../limits';
import { createV2Controller, isV2GroupAddress, type V2DeviceBackup } from './v2/controller';
import { isV2Enabled } from './v2/engine';
import { collectV2History, parseV2History } from './v2/linkHistory';
import { createStateJournal } from './v2/stateJournal';
import {
  clearLoginStorage,
  consumeLegacyCredentials,
  isSessionExpired,
  parseLoginCredentials,
  readLoginAddress,
  readRememberMe,
  saveLoginAddress,
  touchSessionActivity,
} from './authStorage';
import { createCallController } from './calls';
import { canonicalAddress, createConnectionController, TwoFactorRequiredError } from './connectionController';
import { E2eEngine, fingerprintOf } from './e2e';
import { getGatewayUrl } from './gateway';
import { buildBuiltinGifs } from './gifs';
import { createGroupController } from './groups';
import { langPackMethods } from './langPacks';
import {
  exportLinkPublicKey,
  generateLinkKeyPair,
  type LinkBoxPayload,
  linkCommitment,
  linkCommitmentMatches,
  openLinkBox,
  sasCodeV2,
  sealLinkBox,
} from './linking';
import { createLocalState } from './localState';
import { createMediaService } from './media';
import { createMessageController } from './messages';
import { buildOldLangPack } from './oldLangPack';
import { PollStore } from './polls';
import {
  clearSecureSession, hasStoragePin, isStorageUnlocked, loadSecureSession, lockStorage, saveSecureSession,
  SecureE2eStorage, setStoragePin, unlockStorageWithPin,
} from './secureStorage';
import {
  buildApiCustomEmojiSetFromPack,
  buildApiStickerSetFromPack,
  findInstalledPackBySetId,
  getAliasEmojiSticker,
  getEmojiPackNames,
  getEmojiPackRawName,
  getPackFileMime,
  getPackSetId,
  getPendingFiles,
  getReceivedEmojiPackSetIds,
  getReceivedPackRef,
  isCustomPackSetId,
  isEmojiPackSetId,
  loadInstalledPacks,
  parsePvpkArchive,
  removeInstalledPack,
  resetPackRegistries,
  resolveSetIdByShortName,
  sanitizePackName,
  saveInstalledPack,
  setPendingFiles,
} from './stickerPacks';
import {
  buildBuiltinCustomEmojiSet, buildBuiltinStickerSet, getBuiltinLegacyEmojiIds, getStickerBlobMime,
} from './stickers';
import { ParvaneStore } from './store';
import { createSyncController } from './sync';
import { buildBuiltinWallpapers } from './wallpapers';
import {
  buildMsgInboxTopic,
  buildWireEvent as buildWireEventNotify,
  TOPIC_DEVICE_LIST,
  TOPIC_DEVICE_REVOKE,
  TOPIC_GROUP_INVITE_REVOKE,
  TOPIC_IDENTITY_PASSWORD_CHANGE,
  TOPIC_IDENTITY_SEARCH,
  TOPIC_IDENTITY_SETAVATAR,
  TOPIC_IDENTITY_SETNAME,
  TOPIC_IDENTITY_TWOFA,
  TOPIC_LINK_CHALLENGE,
  TOPIC_LINK_GRANT,
  TOPIC_LINK_OFFER,
  TOPIC_LINK_POLL,
  TOPIC_MSG_SETNOTIFY,
  TOPIC_PREKEYS_FETCH,
  TOPIC_PUSH_REGISTER,
  TOPIC_PUSH_UNREGISTER,
  TOPIC_PUSH_VAPID_GET,
} from './wire';

const LOGIN_HASH_PREFIX = '#parvane=';
// Свой фон чата — в шифрованном хранилище, а не открытым блобом в Cache Storage
const BACKGROUND_RECORD_PREFIX = 'background:';
const PARVANE_APP_CONFIG: ApiAppConfig = { ...DEFAULT_APP_CONFIG, hash: 1 };
const BUILTIN_REACTIONS: ApiAvailableReaction[] = [
  '👍', '❤️', '🔥', '😂', '👏', '🎉', '🤔',
].map((emoticon) => ({
  reaction: { type: 'emoji', emoticon },
  title: emoticon,
}));

let onUpdate: OnApiUpdate = () => undefined;
let startupCredentials = consumeStartupCredentials();

// Активность для «оставаться в системе»: отметка обновляется, пока вкладка
// видима (раз в минуту), при возвращении на вкладку и при уходе со страницы
const SESSION_ACTIVITY_INTERVAL_MS = 60 * 1000;
const MS_IN_SECOND = 1000;
if (typeof window !== 'undefined') {
  const touchIfVisible = () => {
    if (document.visibilityState === 'visible' && store.self) touchSessionActivity();
  };
  window.setInterval(touchIfVisible, SESSION_ACTIVITY_INTERVAL_MS);
  document.addEventListener('visibilitychange', touchIfVisible);
  window.addEventListener('pagehide', () => {
    if (store.self) touchSessionActivity();
  });
}
let connection: GatewayConnection | undefined;
let store = new ParvaneStore();
let token = '';

// Публикует весь блок настроек уведомлений (умолчания + исключения по чатам,
// включая мут) на messenger — синхронизация между своими устройствами.
// P-34: «кто может добавлять меня в группы» — часть блоба настроек
// (messenger читает `group_add`), хранится локально рядом с остальными
function groupAddPolicyKey(user: string) {
  return `parvane:group_add:${user}`;
}

function readGroupAddPolicy(): 'anyone' | 'nobody' {
  try {
    return localStorage.getItem(groupAddPolicyKey(store.self)) === 'nobody' ? 'nobody' : 'anyone';
  } catch {
    return 'anyone';
  }
}

function strangersPolicyKey(user: string) {
  return `parvane:strangers:${user}`;
}

function readStrangersAllowed() {
  try {
    return localStorage.getItem(strangersPolicyKey(store.self)) !== 'nobody';
  } catch {
    return true;
  }
}

// FR-040 (T137): «кто может мне звонить» и «кто видит, что я в сети». Значения
// хранит сервер (identity.privacy.*), соблюдает клиент владельца: звонок при
// «никто» отклоняется без звонка, присутствие при «никто» не публикуется
function callsPolicyKey(user: string) {
  return `parvane:calls_from:${user}`;
}

function presencePolicyKey(user: string) {
  return `parvane:presence_visibility:${user}`;
}

function readAudience(key: string): 'anyone' | 'nobody' {
  try {
    return localStorage.getItem(key) === 'nobody' ? 'nobody' : 'anyone';
  } catch {
    return 'anyone';
  }
}

function writeAudience(key: string, value: 'anyone' | 'nobody') {
  try {
    localStorage.setItem(key, value);
  } catch {
    // приватный режим — настройка не переживёт reload
  }
}

// Приватность v2 целиком (T079): identity.privacy.set перезаписывает все поля
function pushV2Privacy() {
  if (!v2Controller.isReady()) return;
  void v2Controller.setPrivacy({
    groupAdd: readGroupAddPolicy(),
    strangers: readStrangersAllowed(),
    callsFrom: readAudience(callsPolicyKey(store.self)),
    presence: readAudience(presencePolicyKey(store.self)),
  })
    .catch((err: unknown) => logDebug(`v2: приватность не сохранена: ${String(err)}`));
}

// FR-040: источник истины приватности — сервер. Перед показом настройки
// подтягиваем серверное значение (его могло сменить другое устройство)
async function refreshV2Privacy() {
  if (!v2Controller.isReady()) return;
  try {
    const remote = await v2Controller.getPrivacy();
    if (!remote) return;
    const isGroupAddChanged = remote.groupAdd !== readGroupAddPolicy();
    localStorage.setItem(groupAddPolicyKey(store.self), remote.groupAdd);
    localStorage.setItem(strangersPolicyKey(store.self), remote.strangers ? 'anyone' : 'nobody');
    writeAudience(callsPolicyKey(store.self), remote.callsFrom);
    writeAudience(presencePolicyKey(store.self), remote.presence);
    // v1-messenger читает `group_add` из блоба настроек — держим его в ногу
    if (isGroupAddChanged) pushNotifySettings();
  } catch (err) {
    logDebug(`v2: приватность не прочитана: ${String(err)}`);
  }
}

function pushNotifySettings() {
  if (!connection) return;
  // v1-блоб открыт серверу: список заглушённых чатов в нём — утечка. Когда
  // настройки уведомлений ведёт журнал личного состояния (v2, FR-039) и у
  // аккаунта нет v1-устройств, в блобе остаётся только то, что сервер обязан
  // исполнять (`group_add`); иначе блоб полный — для своих v1-устройств
  const isJournaled = stateJournal.isAttached() && !v2Controller.legacyDevices(store.self).size;
  const payload = JSON.stringify(isJournaled ? { group_add: readGroupAddPolicy() } : {
    defaults: localState.loadNotifyDefaults(),
    exceptions: localState.loadNotifyExceptions(),
    group_add: readGroupAddPolicy(),
  });
  try {
    connection.publish(
      TOPIC_MSG_SETNOTIFY,
      JSON.stringify(buildWireEventNotify(store.self, token, { settings: payload })),
    );
  } catch {
    // не критично — догонит следующий sync
  }
}
let pendingLoginAddress = '';
// Пароль между экранами регистрации: register (email) и confirm (код) должны
// повторить логин без повторного ввода
let pendingLoginPassword = '';
// Почта, на которую ушёл код (для шапки экрана кода)
let pendingEmail = '';
// Режим Telegram: токен deep link t.me/<bot>?start=<token> и опрос статуса
let pendingTelegramToken = '';
// Зачем Telegram: подтверждение регистрации или двухфакторный вход
let pendingTelegramMode: 'register' | 'login' = 'register';
let telegramPollTimer: number | undefined;
let telegramPollGeneration = 0;
const TELEGRAM_POLL_INTERVAL_MS = 2000;
// Токен живёт 15 мин на сервере; опрос прекращаем чуть раньше
const TELEGRAM_POLL_MAX_MS = 14 * 60 * 1000;
// Параметры сервера (домен адресов, нужна ли почта) — запрашиваются один раз
// на экране входа, дальше берутся из кэша
let serverInfoPromise: Promise<ServerInfo> | undefined;
// Ник нового аккаунта (зеркало valid_nick в identity): 2–64 символа, строчная
// латиница, цифры, _ . -; первый символ — буква или цифра
const NICK_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
let e2e: E2eEngine | undefined;
// Готовность E2E: движок создаётся асинхронно ПОСЛЕ авторизации (Olm, прекеи),
// а UI уже доступен — отправка в это окно падала «Encryption engine is
// unavailable». Пути отправки ждут готовности (с таймаутом)
const E2E_READY_TIMEOUT_MS = 20000;
let e2eReadyResolve: (() => void) | undefined;
let e2eReady = new Promise<void>((resolve) => {
  e2eReadyResolve = resolve;
});
// Уход со страницы: сбросить отложенную запись E2E-состояния (debounce)
if (typeof window !== 'undefined') {
  const flushE2e = () => e2e?.flushOnPageHide();
  window.addEventListener('pagehide', flushE2e);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushE2e();
  });
}

function setE2eEngine(next: E2eEngine | undefined) {
  e2e = next;
  if (next) {
    e2eReadyResolve?.();
  } else {
    e2eReady = new Promise<void>((resolve) => {
      e2eReadyResolve = resolve;
    });
  }
}
function awaitE2e(): Promise<void> {
  if (e2e) return Promise.resolve();
  return Promise.race([
    e2eReady,
    new Promise<void>((resolve) => {
      setTimeout(resolve, E2E_READY_TIMEOUT_MS);
    }),
  ]);
}
let isCallIdentityReady = false;
const polls = new PollStore();

const reportedMissingMethods = new Set<string>();

// Инициализируется после syncController: оба сервиса связаны только callback-ами.
// eslint-disable-next-line prefer-const
let messageController: ReturnType<typeof createMessageController>;

function refreshPollMessageFromSync(uuid: string) {
  messageController.refreshPollMessage(uuid);
}

function rememberSavedGifFromSync(gif: ApiVideo) {
  messageController.rememberSavedGif(gif);
}

async function sendMessageFromSchedule(params: SendMessageParams, uuid?: string): Promise<unknown> {
  return uuid ? messageController.sendMessageWithUuid(params, uuid) : methods.sendMessage(params);
}

const mediaService = createMediaService({
  getConnection: () => connection,
  getStore: () => store,
  getToken: () => token,
  // Блобы вложений v2-чатов — по capability (контроллер создаётся ниже)
  getV2: () => v2Controller,
});

const localState = createLocalState({
  getStore: () => store,
  getE2e: () => e2e,
  isAuthorized: () => Boolean(token),
  selfId,
  sendUpdate,
  buildLocalContent: mediaService.buildLocalContent,
  sendMessage: sendMessageFromSchedule,
});

// Журнал личного состояния v2 (T098): подключается, когда поднят v2-стек
const stateJournal = createStateJournal({
  localState,
  getStore: () => store,
  sendUpdate,
  // callController создаётся ниже; вызывается только после подключения журнала
  applyCallRecords: (records) => callController.applyCallRecords(records),
  applyChatCleared: (address, untilMs) => applyChatCleared(address, untilMs),
  // v2Controller создаётся ниже; вызывается только после подключения журнала
  sharedInvites: {
    list: () => v2Controller.allInvites(),
    merge: (invites) => v2Controller.mergeSharedInvites(invites),
  },
  log: logDebug,
});

// «Удалить чат у себя» на другом своём устройстве (T145): граница очистки
// пришла журналом личного состояния — скрываем сообщения чата не позже неё
function applyChatCleared(address: string, untilMs: number) {
  const chatId = store.getIdForAddress(address, address.includes('@') ? 'user' : 'group');
  const uuids = store.getMessages(chatId)
    .filter((message) => message.date * MS_IN_SECOND <= untilMs)
    .map((message) => store.getUuidForMessage(chatId, message.id))
    .filter((uuid): uuid is string => Boolean(uuid));
  if (!uuids.length) return;
  logDebug(`v2: чат ${address} очищен на другом устройстве — скрыто ${uuids.length} сообщений`);
  void syncController.forgetMessages(uuids);
}

const callController = createCallController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  isIdentityReady: () => isCallIdentityReady,
  // «Звонки — никто» (FR-040): входящий отклоняется так же, как от заблокированного
  isBlocked: (address) => localState.isBlocked(address) || readAudience(callsPolicyKey(store.self)) === 'nobody',
  sendUpdate,
  pushReadState: (chatId) => syncController.pushReadState(chatId),
  // v2Controller создаётся ниже; вызывается только во время звонка
  sendV2Signal: (to, signal, groupCallId) => (
    isV2Enabled() ? v2Controller.trySendCall(to, signal, groupCallId) : Promise.resolve(false)
  ),
  hasLegacyDevices: (peer) => isV2Enabled() && v2Controller.legacyDevices(peer).size > 0,
  isV2Peer: (peer) => (isV2Enabled() ? v2Controller.isV2Peer(peer).catch(() => false) : Promise.resolve(false)),
  recordV2Call: (record) => stateJournal.recordCall(record),
  log: logDebug,
});

// Forward-ref: подписку на групповой typing реализует connectionController,
// который создаётся ниже. Устанавливается после его создания
let subscribeGroupTyping: (groupChatId: string) => void = () => {};
let subscribePresence: (peerId: string) => void = () => {};

const groupController = createGroupController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  selfId,
  sendUpdate,
  onGroupRegistered: (groupChatId) => subscribeGroupTyping(groupChatId),
  log: logDebug,
  loadInviteLink: (groupId) => localState.loadInviteLinks()[groupId],
  saveInviteLink: (groupId, record) => {
    localState.saveInviteLinks({ ...localState.loadInviteLinks(), [groupId]: record });
  },
  forgetInviteLink: (groupId) => {
    const { [groupId]: _removed, ...rest } = localState.loadInviteLinks();
    localState.saveInviteLinks(rest);
  },
  buildAvatarPhoto,
  getV2: () => v2Controller,
  getUnconfirmedTemplate: () => getLangStringByKey('ParvaneGroupUnconfirmedMember'),
});

// Кросс-таб синхронизация черновиков: другая вкладка сохранила/очистила
// черновик — применяем у себя без обращения к серверу
const draftsChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('parvane:drafts')
  : undefined;
if (draftsChannel) {
  draftsChannel.onmessage = (event: MessageEvent) => {
    const { address, draft } = event.data as { address: string; draft?: Record<string, unknown> };
    localState.saveDraft(address, draft);
    sendUpdate({
      '@type': 'draftMessage',
      chatId: store.getIdForAddress(address),
      threadId: MAIN_THREAD_ID,
      draft: draft as ApiDraft | undefined,
    });
  };
}

const syncController = createSyncController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  groups: groupController,
  localState,
  media: mediaService,
  polls,
  refreshPollMessage: refreshPollMessageFromSync,
  rememberSavedGif: rememberSavedGifFromSync,
  sendUpdate,
  log: logDebug,
});

// Ключ восстановления нового корня v2 (D-12): отдаётся UI ровно один раз
let pendingRecoveryKey: string | undefined;
// Сервер ответил UPGRADE_REQUIRED (v2) — UI показывает диалог при монтировании
let isUpgradeRequired = false;

// E6 (spec 007): v1-путь сервера отключён — на экране входа ошибка
// «обновите приложение» (после входа — диалог в Main)
// T134: сервер отключил v1 — клиент на v2 продолжает работать методами v2
window.addEventListener('parvane-v1-disabled', () => {
  logDebug('соединения v1 нет (сервер отключил v1) — все запросы идут по v2');
});

window.addEventListener('parvane-upgrade-required', () => {
  sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneUpgradeRequired' } });
});

// Протокол v2 (spec 007, E2): второй стек для собеседников с журналом
// устройств v2; включается флагом (`VITE_PARVANE_PROTO_V2` / localStorage)
const v2Controller = createV2Controller({
  getToken: () => token,
  getSelf: () => store.self,
  gatewayUrl: getGatewayUrl,
  applyExternal: (stored) => syncController.applyExternal(stored),
  isEnabled: () => isV2Enabled(),
  onInviteCreated: (address, record) => stateJournal.recordGroupInvite({ address, record }),
  onInviteRevoked: (linkId) => stateJournal.removeGroupInvite(linkId),
  onRecoveryKey: (recoveryKey) => {
    // Main может быть ещё не смонтирован — ключ ждёт, пока его заберут
    pendingRecoveryKey = recoveryKey;
    window.dispatchEvent(new CustomEvent('parvane-recovery-key'));
  },
  onAuthRejected: () => {
    // При живом v1 протухший токен отвергает авторизация gateway, и вход идёт на
    // экран пароля. Без v1 (E6-1) отказ приходит только отсюда: снимаем сохранённую
    // сессию и перезагружаемся — запуск без токена спрашивает пароль (ключи и
    // история остаются)
    const self = store.self;
    logDebug('v2: токен не принят сервером — нужен повторный вход');
    void clearSecureSession(self).catch(() => undefined).then(() => window.location.reload());
  },
  onUpgradeRequired: () => {
    // Как и ключ восстановления — Main мог ещё не смонтироваться
    isUpgradeRequired = true;
    window.dispatchEvent(new CustomEvent('parvane-upgrade-required'));
  },
  onNewOwnDevices: (deviceIds) => {
    window.dispatchEvent(new CustomEvent('parvane-new-device', { detail: { count: deviceIds.length } }));
  },
  // Журнал устройств v2 у аккаунта есть, а этого устройства в нём нет: оффер
  // линковки нужен, даже если история v1 на устройстве уже есть
  onNeedsLinking: () => {
    if (!linkRuntime.timer) void startHistoryLinkOffer();
    // Экран «Устройства» покажет код линковки и вход по ключу восстановления
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-needs-linking'));
  },
  // Пока соединение v1 живо, те же кадры приходят по нему; без него (T134)
  // запись LegacyV1 — единственный путь: подаём кадр обработчику инбокса
  onLegacyFrame: (frame) => {
    if (connection?.hasV1 === false && store.self) connection.deliver(buildMsgInboxTopic(store.self), frame);
  },
  onGroupUpdated: (info, isNew) => groupController.applyV2Group(info, isNew),
  onGroupLeft: (address) => groupController.removeV2Group(address),
  onUnconfirmedMembers: (address, members) => groupController.announceUnconfirmed(address, members),
  onStateReady: (host, rekey) => {
    void refreshV2Privacy();
    // Устройство в журнале v2 — его v1-бандл, отвергнутый при входе, пора дослать (T146)
    if (connection && token) void connectionController.replenishDevicePrekeys(connection, token);
    return stateJournal.attach(host, rekey);
  },
  onL2Changed: (address) => applyL2Change(address),
  onCallSignal: (from, signal, groupCallId) => callController.handleV2Signal(from, signal, groupCallId),
  // KEY-1 v2: корень личности собеседника сменился — то же служебное
  // сообщение, что при смене ключа устройства в v1
  onPeerRootChanged: (user) => syncController.announceKeyChange(user),
  onSskRotationNeeded: () => {
    window.dispatchEvent(new CustomEvent('parvane-ssk-rotation'));
  },
  onTyping: (chat, from) => connectionController.showV2Typing(chat, from),
  onPresence: (from) => connectionController.showV2Presence(from),
  // Каталог своих устройств v1 (без расхода one-time prekeys) — для
  // подписанного списка v1-устройств (FR-058)
  listOwnV1Devices: async () => {
    if (!connection) return [];
    const raw = await connection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token }));
    const response = JSON.parse(raw) as {
      ok: boolean; devices?: { device_id: string; signing_key: string; identity_key: string }[];
    };
    if (!response.ok) throw new Error('device list');
    return (response.devices || []).map((d) => ({
      deviceId: d.device_id, identity: d.identity_key, signing: d.signing_key,
    }));
  },
  recordOwn: (stored) => localState.appendOwnJournal({ ...stored, origin: 'v2' }),
  loadHistory: async () => [
    ...await localState.loadHistoryRecords(),
    ...await localState.readOwnJournal(),
  ],
  log: logDebug,
});

messageController = createMessageController({
  v2: v2Controller,
  recordChatCleared: (address, untilMs) => {
    if (isV2Enabled()) stateJournal.recordChatCleared(address, untilMs);
  },
  getConnection: () => connection,
  getE2e: () => e2e,
  awaitE2e,
  getStore: () => store,
  getToken: () => token,
  localState,
  media: mediaService,
  polls,
  sync: syncController,
  selfId,
  sendUpdate,
  collectUsersFor,
  clearPersistedDraft: (address: string) => {
    localState.saveDraft(address, undefined);
    draftsChannel?.postMessage({ address, draft: undefined });
  },
  log: logDebug,
  resolveCustomPack: (setId) => resolveCustomPack(setId),
  primeCustomEmoji: (docIds) => methods.fetchCustomEmoji({ documentId: docIds }),
});

const connectionController = createConnectionController({
  isPresenceHidden: () => readAudience(presencePolicyKey(store.self)) === 'nobody',
  calls: callController,
  getConnection: () => connection,
  setConnection: (nextConnection) => { connection = nextConnection; },
  getE2e: () => e2e,
  setE2e: setE2eEngine,
  getStore: () => store,
  setStore: (nextStore) => {
    store = nextStore;
    // P-18: presence — по конкретным собеседникам, подписка при появлении адреса
    store.onUserRegistered = (peerId) => subscribePresence(peerId);
    store.getLangString = getLangStringByKey;
  },
  unlockStorage: (user) => ensureStorageUnlocked(user),
  getToken: () => token,
  setToken: (nextToken) => { token = nextToken; },
  setCallIdentityReady: (isReady) => { isCallIdentityReady = isReady; },
  polls,
  onNewSession: () => {
    stateJournal.reset();
    v2Controller.reset();
    stopHistoryLink();
    syncController.reset();
    resetPackRegistries();
    messageController.resetSavedGifs();
    messageController.reset();
    localState.reset();
    store.setContacts(localState.loadContacts(), localState.loadNonContacts());
    polls.reset();
    groupController.reset();
  },
  onSessionReady: () => {
    void startHistoryLinkOffer();
    if (isV2Enabled()) void v2Controller.start().then(registerV2Wake);
  },
  isSynced: syncController.isSynced,
  resetSyncPromise: syncController.resetPromise,
  requestDeltaSync: syncController.requestDeltaSync,
  requestFullSync: () => {
    void syncController.ensureSynced()
      .then(() => sendUpdate({ '@type': 'requestSync' }))
      .catch((error: unknown) => logDebug(`повторный синк не удался: ${String(error)}`));
  },
  resolveDisplayNames: syncController.resolveDisplayNames,
  handleInboxFrame: syncController.handleInboxFrame,
  selfId,
  sendUpdate,
  log: logDebug,
  v2: v2Controller,
});

subscribeGroupTyping = connectionController.ensureGroupTyping;
subscribePresence = connectionController.ensurePresence;

// Режим «усиленная приватность» (L2) чата сменился: typing/presence (правило
// L2-1) и открытые экраны — профиль чата, управление группой
function applyL2Change(address: string) {
  connectionController.refreshEphemeral(address);
  const chatId = store.getIdForAddress(address, store.isGroupAddress(address) ? 'group' : 'user');
  window.dispatchEvent(new CustomEvent('parvane-l2-changed', { detail: { chatId } }));
}

export async function initApi(_onUpdate: OnApiUpdate, _initialArgs: ApiInitialArgs) {
  onUpdate = _onUpdate;
  // eslint-disable-next-line no-console
  console.info('[parvane] initApi вызван');

  sendUpdate({ '@type': 'updateApiReady' });
  sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });

  const creds = startupCredentials;
  startupCredentials = undefined;
  if (!creds) {
    const savedAddress = readLoginAddress();
    if (savedAddress) {
      pendingLoginAddress = savedAddress;
      // «Keep me signed in» (P-39): пароль НЕ хранится — сессия возобновляется
      // сохранённым JWT (сутки, отзываемый, привязан к устройству). Протухший
      // или отозванный токен → экран пароля.
      if (readRememberMe() && isSessionExpired()) {
        // Сутки без активности — пароль просим заново
        await clearSecureSession(savedAddress).catch(() => undefined);
      } else if (readRememberMe()) {
        await ensureStorageUnlocked(savedAddress);
        const savedToken = await loadSecureSession(savedAddress).catch(() => undefined);
        if (savedToken) {
          try {
            await connectionController.connectWithToken(savedAddress, savedToken);
            saveLoginAddress(savedAddress);
            touchSessionActivity();
            return;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[parvane] возобновление сессии по токену не удалось, спрашиваем пароль:', err);
            await clearSecureSession(savedAddress).catch(() => undefined);
          }
        }
      }
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
      return;
    }
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return;
  }

  try {
    await connectionController.connectAndLogin(creds.user, creds.password);
    saveLoginAddress(creds.user);
    await persistSessionCredential(creds.user, creds.password);
  } catch (err) {
    if (err instanceof TwoFactorRequiredError) {
      startTelegramConfirmation(creds.user, creds.password, err.loginToken, 'login');
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[parvane] логин не удался:', err);
    pendingLoginAddress = creds.user;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
    sendUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  }
}

// ── подтверждение регистрации через Telegram-бота ────────────────────────────
// Экран WaitQrCode показывает deep link t.me/<bot>?start=<token>; провайдер
// опрашивает identity.register.status, пока бот не подтвердит аккаунт, потом
// логинит сохранённым паролем

function stopTelegramPolling() {
  telegramPollGeneration += 1;
  if (telegramPollTimer !== undefined) {
    window.clearTimeout(telegramPollTimer);
    telegramPollTimer = undefined;
  }
  pendingTelegramToken = '';
}

function startTelegramConfirmation(
  user: string, password: string, linkToken: string, mode: 'register' | 'login' = 'register',
) {
  stopTelegramPolling();
  pendingLoginAddress = user;
  pendingLoginPassword = password;
  pendingTelegramToken = linkToken;
  pendingTelegramMode = mode;
  const generation = telegramPollGeneration;
  sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitQrCode' });
  const startedAt = Date.now();
  const tick = async () => {
    if (generation !== telegramPollGeneration) return;
    if (Date.now() - startedAt > TELEGRAM_POLL_MAX_MS) {
      const isLogin = pendingTelegramMode === 'login';
      logDebug(`Telegram: токен истёк, обратно на ${isLogin ? 'экран пароля' : 'форму регистрации'}`);
      stopTelegramPolling();
      sendUpdate({
        '@type': 'updateAuthorizationState',
        authorizationState: isLogin ? 'authorizationStateWaitPassword' : 'authorizationStateWaitRegistration',
      });
      sendUpdate({
        '@type': 'updateAuthorizationError',
        errorKey: { key: isLogin ? 'ParvaneTelegramLoginExpired' : 'ParvaneTelegramExpired' },
      });
      return;
    }
    const done = await pollTelegramConfirmation(generation);
    if (!done && generation === telegramPollGeneration) {
      telegramPollTimer = window.setTimeout(() => {
        void tick();
      }, TELEGRAM_POLL_INTERVAL_MS);
    }
  };
  telegramPollTimer = window.setTimeout(() => {
    void tick();
  }, TELEGRAM_POLL_INTERVAL_MS);
}

// true — подтверждено и логин запущен (или опрос уже неактуален)
async function pollTelegramConfirmation(generation: number): Promise<boolean> {
  if (generation !== telegramPollGeneration || !pendingTelegramToken) return true;
  const user = pendingLoginAddress;
  const password = pendingLoginPassword;
  const linkToken = pendingTelegramToken;
  const mode = pendingTelegramMode;
  let confirmed = false;
  try {
    confirmed = await connectionController.fetchRegisterStatus(user, linkToken);
  } catch (err) {
    logDebug(`опрос статуса Telegram не удался: ${String(err)}`);
  }
  if (generation !== telegramPollGeneration) return true;
  if (!confirmed) return false;
  stopTelegramPolling();
  try {
    // Двухфакторный вход: JWT выдаётся только с подтверждённым login_token
    const address = await connectionController.connectAndLogin(user, password, mode === 'login' ? linkToken : '');
    saveLoginAddress(address);
    await persistSessionCredential(address, password);
  } catch (err) {
    logDebug(`логин после подтверждения в Telegram не удался: ${String(err)}`);
    pendingLoginAddress = user;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
  }
  return true;
}

function logDebug(message: string) {
  // eslint-disable-next-line no-console
  console.info(`[parvane] ${message}`);
  // parvaneDiag: внутренние события провайдера (пропуски расшифровки,
  // подмена отправителя и т.п.) — в журнал отчёта о баге
  diagLog('log', message);
}

// P-39: хранилище под PIN — спрашиваем PIN до открытия E2E/сессии.
// Минимальный UI: нативный prompt (3 попытки); при отказе хранилище остаётся
// закрытым — E2E и сохранённая сессия недоступны до перезагрузки
async function ensureStorageUnlocked(user: string) {
  if (!(await hasStoragePin(user).catch(() => false)) || isStorageUnlocked(user)) return;
  const prompts = buildOldLangPack('en');
  for (let attempt = 0; attempt < 3; attempt++) {
    const pin = window.prompt(prompts.ParvaneStoragePinPrompt as string, '');
    // eslint-disable-next-line no-null/no-null
    if (pin === null) return;
    if (await unlockStorageWithPin(user, pin).catch(() => false)) return;
  }
}

// «Keep me signed in» (P-39): при включённом флаге сохраняем JWT сессии
// (зашифрованным, под ключом хранилища/PIN), чтобы reload не спрашивал
// пароль. Сам пароль на диск не попадает. При выключенном — стираем.
async function persistSessionCredential(user: string, _password: string) {
  try {
    if (readRememberMe() && token) {
      await saveSecureSession(user, token);
      touchSessionActivity();
    } else {
      await clearSecureSession(user);
    }
  } catch {
    // Хранилище недоступно (приватный режим) — просто будем спрашивать пароль
  }
}

// ── методы (подмножество Methods, остальное — заглушки) ──────────────────────

const RECENT_STATUS: ApiUserStatus = { type: 'userStatusRecently' };
const INSTALLED_PACK_DATE = Math.floor(Date.now() / 1000);

function registerPackBlobs(blobs: Map<string, { blob: Blob; mime: string }>) {
  blobs.forEach(({ blob, mime }, id) => mediaService.cacheBlobIfAbsent(id, blob, mime));
}

// Стикер-пак или эмодзи-пак (по реестру emoji_packs / флагу isEmoji)
function buildCustomSet(setId: string, pack: StoredPack, installedDate?: number) {
  if (isEmojiPackSetId(setId) || pack.isEmoji) {
    // EMOJI-1: docId — от сохранённого сырого имени (переживает перезагрузку),
    // затем от имени из ссылок этой сессии
    const rawName = pack.rawName || getEmojiPackRawName(setId) || pack.name;
    return buildApiCustomEmojiSetFromPack(pack, rawName, setId, installedDate);
  }
  return buildApiStickerSetFromPack(pack, installedDate);
}

// Файлы кастомного пака: установленный → из IndexedDB; открытый в модалке —
// из pending-кэша; иначе тянем PVPK1-архив из cloud по pack_ref
async function resolveCustomPack(setId: string): Promise<{ pack: StoredPack; isInstalled: boolean } | undefined> {
  const installed = await findInstalledPackBySetId(store.self, setId);
  if (installed) return { pack: installed, isInstalled: true };
  const pending = getPendingFiles(setId);
  if (pending) return { pack: pending, isInstalled: false };
  const ref = getReceivedPackRef(setId);
  if (!ref?.file_id) return undefined;
  if (ref.key && ref.nonce) {
    mediaService.rememberKeys({
      kind: 'sticker', file_id: ref.file_id, file_key: ref.key, file_nonce: ref.nonce,
    });
  }
  const media = await mediaService.downloadBlob(ref.file_id);
  if (!media) return undefined;
  const files = parsePvpkArchive(new Uint8Array(await media.blob.arrayBuffer()));
  if (!files) return undefined;
  const rawName = getEmojiPackRawName(setId);
  const pack: StoredPack = {
    // Нормализованное имя: setId установленного пака считается отсюда
    // (`findInstalledPackBySetId`), а входящие ссылки регистрируются под
    // setId от нормализованного имени. С сырым именем эти два setId
    // расходились, и уже установленный пак скачивался из cloud заново.
    // Сырое имя для docId живёт отдельно, в rawName
    name: sanitizePackName(ref.name || 'Pack'),
    files,
    rawName,
    aliases: rawName ? getEmojiPackNames(setId).filter((name) => name !== rawName) : undefined,
  };
  setPendingFiles(setId, pack);
  return { pack, isInstalled: false };
}

// Метаданных об устройствах сервер не хранит (только ключи и updated_at) —
// человекочитаемые поля синтезируем: для текущего устройства из UA, для
// остальных по device_id ('' — legacy-primary: desktop или прежний web)
// Уже выданная подписка web-push → регистрация пробуждения v2 (T102):
// registerDevice мог отработать раньше, чем поднялся v2-стек
async function registerV2Wake() {
  if (!v2Controller.isReady() || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await v2Controller.pushRegister(
      subscription.toJSON() as Parameters<typeof v2Controller.pushRegister>[0],
    );
  } catch (err) {
    logDebug(`v2: пробуждение не зарегистрировано: ${String(err)}`);
  }
}

function buildDeviceSession(
  device: { device_id: string; updated_at: number },
  currentDeviceId: string,
): ApiSession {
  const isCurrent = device.device_id === currentDeviceId;
  const deviceModel = isCurrent
    ? detectBrowserName()
    : (device.device_id ? `Web ${device.device_id.slice(0, 8)}` : 'Desktop');
  return {
    hash: device.device_id,
    isCurrent,
    isOfficialApp: true,
    isPasswordPending: false,
    deviceModel,
    platform: isCurrent ? detectPlatformName() : '',
    systemVersion: '',
    appName: 'Parvane',
    appVersion: '',
    dateCreated: device.updated_at,
    dateActive: device.updated_at,
    ip: '',
    country: '',
    region: '',
    areCallsEnabled: true,
    areSecretChatsEnabled: false,
  };
}

function detectBrowserName() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('OPR/')) return 'Opera';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  return 'Browser';
}

function detectPlatformName() {
  const ua = navigator.userAgent;
  if (ua.includes('Android')) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (ua.includes('Mac OS')) return 'macOS';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return '';
}

// ── Авто-линковка истории ────────────────────────────────────────────────────
// Новое устройство (needsHistoryLink) после логина публикует оффер с
// эфемерным ECDH-ключом и опрашивает грант; старое устройство в Settings →
// Devices показывает запрос с SAS-кодом, подтверждение выгружает шифрованный
// экспорт в cloud и передаёт ECDH-бокс с координатами. Новое устройство
// сливает decCache и входящие Megolm-сессии (importLinkedHistory) и ресинкается

const LINK_GRANT_POLL_MS = 5000;
const LINK_OFFER_LIFETIME_MS = 10 * 60 * 1000;
// LINK-1 п. 8: сколько ждать появления группы v2 для привезённых строк
const LINKED_GROUP_RETRY_MS = 3000;
const LINKED_GROUP_RETRIES = 40;

type LinkRuntime = {
  generation: number;
  keyPair?: CryptoKeyPair;
  ephPub?: string;
  commitment?: string;
  // v2 (P-03): эфемерный ключ СТАРОГО устройства, приложенный к нашему офферу;
  // SAS считается от обоих ключей, грант принимается только под этот ключ
  challenge?: string;
  code?: string;
  timer?: number;
};

const linkRuntime: LinkRuntime = { generation: 0 };
// Грант сервер отдаёт ОДИН раз в любом `identity.link.poll` — и в опросе чужих
// офферов (экран «Устройства») тоже. Такой грант не теряем: его заберёт
// ближайший опрос своего оффера
let pendingLinkGrant: { box_payload: string; eph_pub: string } | undefined;

// Старое устройство: свой эфемерный ключ на каждый challenge (по целевому
// устройству). Приватный ключ живёт только в памяти вкладки.
type LinkChallengeState = { keyPair: CryptoKeyPair; pub: string };
const linkChallenges = new Map<string, LinkChallengeState>();

type LinkOfferWire = {
  device_id: string;
  eph_pub: string;
  created_at: number;
  commitment?: string;
  signing_key?: string;
  challenge_pub?: string;
};

function stopHistoryLink() {
  linkRuntime.generation++;
  window.clearInterval(linkRuntime.timer);
  linkRuntime.timer = undefined;
  linkRuntime.keyPair = undefined;
  linkRuntime.ephPub = undefined;
  linkRuntime.commitment = undefined;
  linkRuntime.challenge = undefined;
  linkRuntime.code = undefined;
  pendingLinkGrant = undefined;
}

// Новое устройство (протокол v2, P-03/P-48): публикуем ОБЯЗАТЕЛЬСТВО на
// эфемерный ключ и свой signing-ключ; сам ключ раскрываем только после
// challenge старого устройства, SAS — от обоих ключей. Опрос до гранта или
// истечения срока.
// Оффер нужен, пока нет истории v1 ИЛИ устройство не записано в журнал v2
function needsDeviceLink(engine: { needsHistoryLink: () => boolean }) {
  return engine.needsHistoryLink() || v2Controller.needsLinking();
}

async function startHistoryLinkOffer() {
  stopHistoryLink();
  const engine = e2e;
  if (!connection || !engine || !needsDeviceLink(engine)) return;
  const generation = linkRuntime.generation;
  const keyPair = await generateLinkKeyPair();
  const ephPub = await exportLinkPublicKey(keyPair);
  const commitment = await linkCommitment(ephPub);
  if (generation !== linkRuntime.generation) return;
  linkRuntime.keyPair = keyPair;
  linkRuntime.ephPub = ephPub;
  linkRuntime.commitment = commitment;
  try {
    const raw = await connection.request(TOPIC_LINK_OFFER, JSON.stringify({
      token, device_id: engine.deviceId, commitment, signing_key: engine.signingKey,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return;
  } catch {
    return;
  }
  logDebug('линковка: оффер (обязательство) опубликован');
  const startedAt = Date.now();
  linkRuntime.timer = window.setInterval(() => {
    if (generation !== linkRuntime.generation) return;
    if (Date.now() - startedAt > LINK_OFFER_LIFETIME_MS) {
      stopHistoryLink();
      return;
    }
    void pollHistoryLinkGrant(generation);
  }, LINK_GRANT_POLL_MS);
}

async function pollHistoryLinkGrant(generation: number) {
  const engine = e2e;
  const activeConnection = connection;
  const keyPair = linkRuntime.keyPair;
  const ephPub = linkRuntime.ephPub;
  const commitment = linkRuntime.commitment;
  if (!engine || !activeConnection || !keyPair || !ephPub || !commitment) return;
  // История появилась другим путём (живая переписка) — отзываем оффер, чтобы
  // другие устройства не видели висящий запрос
  if (!needsDeviceLink(engine)) {
    stopHistoryLink();
    try {
      await activeConnection.request(TOPIC_LINK_OFFER, JSON.stringify({
        token, device_id: engine.deviceId, revoke: true,
      }));
    } catch {
      // сервер вычистит по TTL
    }
    return;
  }
  let grant: { box_payload: string; eph_pub: string } | undefined;
  let challenge: string | undefined;
  try {
    const raw = await activeConnection.request(TOPIC_LINK_POLL, JSON.stringify({
      token, device_id: engine.deviceId,
    }));
    const response = JSON.parse(raw) as {
      ok: boolean;
      grant?: { box_payload: string; eph_pub: string };
      challenge?: string;
    };
    if (!response.ok) return;
    grant = response.grant || pendingLinkGrant;
    challenge = response.challenge;
  } catch {
    return;
  }
  if (generation !== linkRuntime.generation) return;

  // Challenge пришёл — раскрываем ключ (сервер сверяет его с обязательством)
  // и показываем SAS от пары ключей. Challenge фиксируется один раз: подмена
  // стороны сервером означала бы другой код на старом устройстве.
  if (challenge && !linkRuntime.challenge) {
    try {
      const raw = await activeConnection.request(TOPIC_LINK_OFFER, JSON.stringify({
        token, device_id: engine.deviceId, eph_pub: ephPub, commitment, signing_key: engine.signingKey,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return;
    } catch {
      return;
    }
    if (generation !== linkRuntime.generation) return;
    linkRuntime.challenge = challenge;
    linkRuntime.code = await sasCodeV2(ephPub, challenge);
    logDebug('линковка: ключ раскрыт, код сверки готов');
  }
  if (!grant) return;
  if (!linkRuntime.challenge || grant.eph_pub !== linkRuntime.challenge) {
    // Грант не под тот ключ, с которым считался SAS — игнорируем (это либо
    // гонка двух старых устройств, либо попытка подмены)
    logDebug('линковка: грант под чужой эфемерный ключ — отклонён');
    return;
  }
  stopHistoryLink();

  const boxPayload = await openLinkBox(keyPair.privateKey, grant.eph_pub, grant.box_payload);
  if (!boxPayload) {
    logDebug('линковка: бокс не расшифровался (чужой эфемерный ключ?)');
    return;
  }
  mediaService.rememberKeys({
    kind: 'file',
    file_id: boxPayload.file_id,
    file_key: boxPayload.file_key,
    file_nonce: boxPayload.file_nonce,
  });
  const media = await mediaService.downloadBlob(boxPayload.file_id);
  if (!media) {
    logDebug('линковка: экспорт не скачался из cloud');
    return;
  }
  let v2History: WireStoredMessage[];
  try {
    const stateJson = await media.blob.text();
    engine.importLinkedHistory(stateJson, boxPayload.transfer);
    await engine.flushStorage();
    v2History = parseV2History(stateJson);
  } catch (err) {
    logDebug(`линковка: импорт не удался: ${String(err)}`);
    return;
  }
  // Полный ресинк: пропущенная как нечитаемая история теперь расшифруется
  // из привезённого decCache/групповых сессий, а исходящие старого устройства
  // сервер отдаст по подписанному переносу владения (transfers)
  syncController.reset();
  sendUpdate({ '@type': 'requestSync' });
  logDebug('линковка: история получена и импортирована');
  await joinV2WithLinkGrant(boxPayload.v2);
  // Строки истории — после полного ресинка, а не вперемешку с ним: применённая
  // посреди ресинка строка (замечено на своих исходящих) временами не доходила до UI
  await syncController.ensureSynced().catch(() => undefined);
  await applyLinkedV2History(v2History, store.self);
}

// LINK-1 п. 8 (SC-002): история v2-эпохи — строками старого устройства. Строки
// групп v2 ждут, пока группа появится из журнала групп (после вступления
// устройства в журнал устройств), иначе сообщение ушло бы в чат с «адресом»
async function applyLinkedV2History(rows: WireStoredMessage[], owner: string, attempt = 0) {
  if (!rows.length || store.self !== owner) return;
  const waiting: WireStoredMessage[] = [];
  const clearedUntil = localState.loadClearedUntil();
  for (const stored of rows) {
    // Чат очищен «у себя» позже этой строки — привезённая история её не воскрешает
    if (stored.ts * MS_IN_SECOND <= (clearedUntil[store.resolveChatAddress(stored)] || 0)) continue;
    if (isV2GroupAddress(stored.to) && !store.isGroupAddress(stored.to)) {
      waiting.push(stored);
    } else {
      // Входящие истории — прочитаны (иначе всё привезённое стало бы «новым»)
      await syncController.applyExternal(stored.from === owner ? stored : { ...stored, read: true }, true);
    }
  }
  await localState.flushHistoryNow();
  if (rows.length > waiting.length) {
    logDebug(`линковка: история v2 перенесена (${rows.length - waiting.length} сообщений)`);
  }
  if (!waiting.length || attempt >= LINKED_GROUP_RETRIES) return;
  window.setTimeout(() => {
    void applyLinkedV2History(waiting, owner, attempt + 1);
  }, LINKED_GROUP_RETRY_MS);
}

// LINK-1 v2: материал гранта движка лежит отдельным блобом; по нему устройство
// записывает себя в журнал устройств и получает ключ личного состояния
async function joinV2WithLinkGrant(coords: LinkBoxPayload['v2']) {
  if (!coords || !isV2Enabled()) return;
  // Грант мог прийти раньше, чем запуск v2 выяснил «нужна линковка»
  await v2Controller.start();
  if (!v2Controller.needsLinking()) return;
  mediaService.rememberKeys({
    kind: 'file', file_id: coords.file_id, file_key: coords.file_key, file_nonce: coords.file_nonce,
  });
  const media = await mediaService.downloadBlob(coords.file_id);
  if (!media) {
    logDebug('линковка: грант v2 не скачался из cloud');
    return;
  }
  const material = new Uint8Array(await media.blob.arrayBuffer());
  if (await v2Controller.joinWithGrant(material)) registerV2Wake();
  else logDebug('линковка: вступление в журнал устройств v2 не удалось');
}

// Старое устройство: код сверки для оффера v2 — только после того, как наш
// challenge приложен и ключ нового устройства раскрыт и совпал с обязательством.
// Legacy-офферы (v1, без обязательства) не обслуживаются: их код зависел
// только от ключа, который сервер мог подменить.
async function describeLinkOffer(offer: LinkOfferWire): Promise<{ deviceId: string; code?: string } | undefined> {
  if (!offer.commitment) return undefined;
  const own = linkChallenges.get(offer.device_id);
  if (offer.challenge_pub && own && offer.challenge_pub !== own.pub) {
    // Challenge выставило другое наше устройство — грант отсюда невозможен
    return undefined;
  }
  if (!own || !offer.challenge_pub) {
    // Нет challenge (или новое устройство переофферило — сервер его сбросил):
    // шлём свой ключ; при повторе — тот же (сервер принимает идемпотентно)
    const keyPair = own?.keyPair || await generateLinkKeyPair();
    const pub = own?.pub || await exportLinkPublicKey(keyPair);
    try {
      const raw = await connection!.request(TOPIC_LINK_CHALLENGE, JSON.stringify({
        token, device_id: offer.device_id, eph_pub: pub,
      }));
      if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    } catch {
      return undefined;
    }
    linkChallenges.set(offer.device_id, { keyPair, pub });
    return { deviceId: offer.device_id };
  }
  if (!offer.eph_pub) return { deviceId: offer.device_id };
  if (!(await linkCommitmentMatches(offer.eph_pub, offer.commitment))) {
    logDebug(`линковка: ключ оффера ${offer.device_id} не соответствует обязательству`);
    return undefined;
  }
  return { deviceId: offer.device_id, code: await sasCodeV2(offer.eph_pub, own.pub) };
}

// Отзыв устройства: identity выкидывает его бандл из каталога (fan-out новых
// сообщений его больше не включает), локально — чистка каталога self и ротация
// групповых ключей (forgetOwnDevice)
async function revokeOwnDevice(deviceId: string, password?: string) {
  if (!connection || !e2e) return undefined;
  try {
    // P-07: отзыв устройства требует текущий пароль. P-39: сохранённого
    // пароля нет — только введённый пользователем
    const raw = await connection.request(TOPIC_DEVICE_REVOKE, JSON.stringify({
      token, device_id: deviceId, password,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    e2e.forgetOwnDevice(deviceId);
    await e2e.flushStorage();
    // Протокол v2 (T128, FR-066): запись отзыва в журнале устройств и ротации
    // ключей, которые устройство держало. После v1-отзыва (он проверил пароль):
    // сбой v2 не возвращает устройство, а оставляет ротации на повтор
    const isJournaled = await v2Controller.revokeDevice(deviceId).catch((e: unknown) => {
      logDebug(`v2: отзыв устройства в журнале не выполнен: ${String(e)}`);
      return false;
    });
    // Без соединения v1 (E6-1) отзыв — это только запись журнала устройств: мост
    // отвечает «ok» уже после проверки пароля. Записи нет (это устройство само не
    // привязано к журналу либо сервер её не принял) — отзыва не было, об успехе не
    // сообщаем: иначе сеанс «завершён» на экране, а устройство продолжает работать
    if (connection.hasV1 === false && !isJournaled) return undefined;
    return true;
  } catch {
    return undefined;
  }
}

// Фото профиля как ApiPhoto: один файл в облаке, ключ = file_id
function buildAvatarPhoto(fileId: string): ApiPhoto {
  return {
    mediaType: 'photo',
    id: fileId,
    date: Math.floor(Date.now() / 1000),
    sizes: [{ type: 'x', width: 640, height: 640 }],
  };
}

function persistContacts() {
  const { added, removed } = store.getContactLists();
  localState.saveContacts(added);
  localState.saveNonContacts(removed);
}

function addContactAddress(address: string) {
  store.addContact(address);
  persistContacts();
  const user = store.buildApiUser(address);
  sendUpdate({ '@type': 'updateUser', id: user.id, user });
}

// identity.user.setname применяет поля профиля ЦЕЛИКОМ или не применяет ничего:
// пустое либо длиннее 64 БАЙТ display_name и протухший токен отклоняют весь
// вызов вместе с bio, датой рождения, цветом, каналом и телефоном. Ответ надо
// читать, иначе веб покажет значения, которых на сервере нет, до следующего
// входа (fetchFullUser намеренно не перерезолвит себя), а собеседник их не
// увидит
// Вызовы строго по очереди: шард безусловно пишет display_name из КАЖДОГО
// запроса, поэтому два параллельных setname (одно «Сохранить» меняет и имя, и
// телефон) могли переупорядочиться, и запрос телефона со старым именем молча
// откатывал переименование. `useCurrentName` берёт имя в момент отправки, а не
// в момент вызова — по той же причине
let setNameQueue: Promise<unknown> = Promise.resolve();

async function requestSetName(
  payload: Record<string, unknown>, { useCurrentName }: { useCurrentName?: boolean } = {},
) {
  const run = async () => {
    if (!connection) return false;
    try {
      const body = useCurrentName
        ? { ...payload, display_name: store.getDisplayName(store.self) }
        : payload;
      const raw = await connection.request(TOPIC_IDENTITY_SETNAME, JSON.stringify(body));
      const response = JSON.parse(raw) as { ok?: boolean; error?: string };
      if (response.ok) return true;
      window.dispatchEvent(new CustomEvent('parvane-profile-error', { detail: { error: response.error } }));
    } catch {
      window.dispatchEvent(new CustomEvent('parvane-profile-error', { detail: {} }));
    }
    return false;
  };
  const result = setNameQueue.then(run, run);
  setNameQueue = result.catch(() => undefined);
  return result;
}

const methods = {
  // Языковые пакеты из сборки (fallback.strings / ru.strings)
  ...langPackMethods,

  fetchAppConfig({ hash }: { hash?: number }) {
    return Promise.resolve(hash === PARVANE_APP_CONFIG.hash ? undefined : PARVANE_APP_CONFIG);
  },

  fetchAvailableReactions() {
    return Promise.resolve(BUILTIN_REACTIONS);
  },

  // Рейтинга собеседников и ботов сервер не ведёт (ботов нет вовсе): tt просит его
  // после синхронизации и на экране поиска — отвечаем «нет данных»
  fetchTopPeers() {
    return Promise.resolve(undefined);
  },

  async fetchChats({ archived }: { archived?: boolean }) {
    await syncController.ensureSynced();
    void messageController.methods.parvaneResumeLiveLocations();
    // Пинок загрузки наборов стикеров/кастом-эмодзи после маунта Main: штатный
    // путь гейтится на isAppConfigLoaded (fetchAppConfig у нас нет), а апдейт
    // updateStickerSets зовёт loadStickerSets напрямую
    setTimeout(() => sendUpdate({ '@type': 'updateStickerSets' }), 0);

    const users: ApiUser[] = [];
    const chats: ApiChat[] = [];
    const userStatusesById: Record<string, ApiUserStatus> = {};

    store.getKnownUserAddresses().forEach((address) => {
      const user = store.buildApiUser(address);
      users.push(user);
      userStatusesById[user.id] = RECENT_STATUS;
      chats.push(store.buildApiChatForUser(address));
    });
    store.getGroupAddresses().forEach((address) => {
      chats.push(store.buildApiChatForGroup(store.getGroupInfo(address)!));
    });

    // Черновики хранятся по адресу пира: восстанавливаем чат даже если пир ещё
    // не известен (истории нет), иначе черновик негде показать
    await localState.hydrate();
    const savedDrafts = localState.loadDrafts();
    Object.keys(savedDrafts).forEach((address) => {
      const chatId = store.getIdForAddress(address);
      if (!chats.some((chat) => chat.id === chatId)) {
        const user = store.buildApiUser(address);
        users.push(user);
        chats.push(store.buildApiChatForUser(address));
      }
    });
    const chatIdsWithDrafts = new Set(
      Object.keys(savedDrafts).map((address) => store.getIdForAddress(address)),
    );

    // Только чаты с сообщениями: после «удалить чат» список в сторе пустеет,
    // но ключ остаётся — иначе пометка deleted снималась и пустой чат
    // всплывал в списке до reload
    const chatIdsWithHistory = new Set(store.getChatIds().filter((id) => store.getMessages(id).length > 0));
    const unreadMarks = new Set(localState.loadUnreadMarks());
    const isVisibleChat = (chat: ApiChat) => chatIdsWithHistory.has(chat.id)
      || chatIdsWithDrafts.has(chat.id)
      || chat.type !== 'chatTypePrivate';
    // Удалённые «для меня» личные чаты: скрыты, пока пусты; появление истории
    // (новое сообщение) снимает пометку
    const deletedChatIds = new Set<string>();
    localState.loadDeletedChats().forEach((address) => {
      const chatId = store.getIdForAddress(address);
      if (chatIdsWithHistory.has(chatId)) localState.unmarkChatDeleted(address);
      else deletedChatIds.add(chatId);
    });
    const listedChats = chats.filter(
      (chat) => (isVisibleChat(chat) || chat.id !== selfId()) && !deletedChatIds.has(chat.id),
    );
    const allVisibleChats = listedChats.filter(isVisibleChat);

    // Архив и пины (локальный persist по адресу пира/группы)
    const archivedIds = new Set(
      localState.loadArchived().map((address) => store.getIdForAddress(address)),
    );
    allVisibleChats.forEach((chat) => {
      chat.folderId = archivedIds.has(chat.id) ? ARCHIVED_FOLDER_ID : undefined;
    });
    const visibleChats = allVisibleChats.filter(
      (chat) => (archived ? archivedIds.has(chat.id) : !archivedIds.has(chat.id)),
    );
    const pinnedIds = localState.loadPinned()
      .map((address) => store.getIdForAddress(address))
      .filter((id) => visibleChats.some((chat) => chat.id === id));
    const orderedPinnedIds = archived || !pinnedIds.length ? undefined : pinnedIds;

    const messages: ApiMessage[] = [];
    const lastMessageByChatId: Record<string, number> = {};
    const threadReadStatesById: Record<string, ThreadReadState> = {};
    const threadInfos: ApiThreadInfo[] = [];
    visibleChats.forEach((chat) => {
      const history = store.getMessages(chat.id);
      const last = history[history.length - 1];
      if (last) {
        messages.push(last);
        lastMessageByChatId[chat.id] = last.id;
        // Реальное прочтение: входящее прочитано, только если МЫ уже слали
        // msg.chat.read (флаг read из синка). Иначе tt не видит непрочитанных
        // и никогда не зовёт markMessageListRead → ✓✓ у собеседника не будет.
        let lastReadInbox = 0;
        let unreadCount = 0;
        const isSelfChat = chat.id === selfId();
        const hasUnreadMark = unreadMarks.has(chat.id) || undefined;
        history.forEach((message) => {
          // Sealed-сообщения без senderId и «Избранное» непрочитанными не считаем.
          // Единый предикат (sync.isUnreadIncoming): записи о звонках и служебные
          // (без uuid, msg.chat.read невозможен) — прочитаны; прочитанным
          // считается и то, что пометило ЭТО устройство (READ-1): серверный
          // флаг мог не успеть вернуться, и после перезагрузки бейдж возвращался.
          if (message.isOutgoing || isSelfChat || !message.senderId) return;
          if (syncController.isUnreadIncoming(chat.id, message)) {
            unreadCount += 1;
          } else if (message.id > lastReadInbox) {
            lastReadInbox = message.id;
          }
        });
        if (isSelfChat) lastReadInbox = last.id;
        const unreadMentions = isSelfChat ? [] : syncController.collectUnreadMentions(chat.id);
        threadReadStatesById[chat.id] = {
          lastReadInboxMessageId: lastReadInbox,
          unreadCount,
          hasUnreadMark,
          unreadMentionsCount: unreadMentions.length,
          unreadMentions,
          // «Избранное»: свои сообщения прочитаны всегда (как в tdesktop)
          lastReadOutboxMessageId: isSelfChat ? last.id : syncController.getReadOutboxMax(chat.id),
        };
      }
      // Без ApiThreadInfo главного треда updateListedIds молча не создаёт тред —
      // лента сообщений навсегда остаётся в спиннере
      threadInfos.push({
        isCommentsInfo: false,
        chatId: chat.id,
        threadId: MAIN_THREAD_ID,
        lastMessageId: last?.id,
      });
    });

    // Черновики из localStorage (ключ — адрес пира): восстанавливаются после
    // reload/перезахода. loadAllChats ждёт плоский chatId → ApiDraft
    const draftsById = Object.fromEntries(
      Object.entries(savedDrafts)
        .map(([address, draft]) => [store.getIdForAddress(address), draft])
        .filter(([chatId]) => visibleChats.some((chat) => chat.id === chatId)),
    );

    // Saved Messages: self-чат обязан существовать в глобале всегда (иначе
    // композер «Text not allowed» и вечный спиннер треда) — в видимый список
    // при этом попадает только с историей
    const selfChat = store.self ? store.buildApiChatForUser(store.self) : undefined;
    const chatsPayload = selfChat && !visibleChats.some((chat) => chat.id === selfChat.id)
      ? [...visibleChats, selfChat]
      : visibleChats;
    if (store.self && !users.some((user) => user.id === selfId())) {
      users.push(store.buildApiUser(store.self));
    }

    return {
      chatIds: visibleChats.map((chat) => chat.id),
      chats: chatsPayload,
      users,
      userStatusesById,
      draftsById,
      threadReadStatesById,
      threadInfos,
      orderedPinnedIds,
      totalChatCount: visibleChats.length,
      messages,
      notifyExceptionById: Object.fromEntries(
        Object.entries(localState.loadNotifyExceptions())
          .map(([address, settings]) => [store.getIdForAddress(address), settings]),
      ),
      lastMessageByChatId,
    };
  },

  // Пагинация с семантикой Telegram messages.getHistory (tt строит на ней
  // окно вьюпорта): в списке НОВЫЕ→СТАРЫЕ берём позицию offsetId, сдвигаем на
  // addOffset и отдаём limit элементов. Backwards (offsetId, addOffset=-1) =
  // offsetId и старее; Around = половина новее/половина старее; Forwards
  // (addOffset=-(limit)) = offsetId и новее; без offsetId = самые новые.
  // Раньше параметры игнорировались и ВСЕГДА отдавались последние N: в длинном
  // чате при прокрутке вверх tt просил старое, а получал снова новое — учёт
  // окна ломался, «самое новое» терялось, и новые сообщения не попадали в
  // ленту (стрелка ↓).
  async fetchMessages({
    chat, limit, offsetId, addOffset,
  }: { chat: ApiChat; limit: number; offsetId?: number; addOffset?: number }) {
    await syncController.ensureSynced();
    const history = store.getMessages(chat.id);
    const newestFirst = history.slice().reverse();
    let start = 0;
    if (offsetId) {
      let anchor = newestFirst.findIndex((m) => m.id === offsetId);
      if (anchor < 0) {
        // offsetId нет в истории: встаём так, чтобы anchor+1 был первым более старым
        const firstOlder = newestFirst.findIndex((m) => m.id < offsetId);
        anchor = (firstOlder < 0 ? newestFirst.length : firstOlder) - 1;
      }
      start = anchor + 1 + (addOffset ?? 0);
    }
    start = Math.max(0, start);
    const messages = newestFirst.slice(start, start + Math.max(limit, 1));
    // Опросы: poll-объект не в content, доотдаём отдельными апдейтами после
    // того как сообщения окажутся в global (следующий тик)
    const pollMessages = messages.filter((m) => m.content.pollId);
    if (pollMessages.length) {
      window.setTimeout(() => {
        pollMessages.forEach((m) => (
          m.content.pollId && messageController.refreshPollMessage(m.content.pollId)
        ));
      }, 0);
    }
    return {
      messages,
      users: collectUsersFor(messages),
      chats: [chat],
      count: history.length,
      topics: [],
    };
  },

  ...messageController.methods,

  downloadMedia(
    { url, mediaFormat, start, end }: { url: string; mediaFormat: number; start?: number; end?: number },
    _onProgress?: ApiOnProgress,
  ) {
    return mediaService.downloadMedia({ url, mediaFormat, start, end });
  },

  // ── группы ─────────────────────────────────────────────────────────────────

  createGroupChat: groupController.createGroupChat,
  createChannel: groupController.createChannel,
  fetchFullChat: groupController.fetchFullChat,
  addChatMembers: groupController.addChatMembers,
  deleteChatMember: groupController.deleteChatMember,
  updateChatMemberBannedRights: groupController.updateChatMemberBannedRights,
  exportChatInvite: groupController.exportChatInvite,
  fetchExportedChatInvites: groupController.fetchExportedChatInvites,
  fetchMembers: groupController.fetchMembers,
  importChatInvite: groupController.importChatInvite,
  updateChatAdmin: groupController.updateChatAdmin,
  // Управление группой (spec 003): описание, фото, права по умолчанию,
  // инвайт-ссылки (список/отзыв/удаление/превью), заявки на вступление
  updateChatAbout: groupController.updateChatAbout,
  updateChatDefaultBannedRights: groupController.updateChatDefaultBannedRights,
  editExportedChatInvite: groupController.editExportedChatInvite,
  deleteExportedChatInvite: groupController.deleteExportedChatInvite,
  deleteRevokedExportedChatInvites: groupController.deleteRevokedExportedChatInvites,
  fetchChatInviteImporters: groupController.fetchChatInviteImporters,
  hideChatJoinRequest: groupController.hideChatJoinRequest,
  hideAllChatJoinRequests: groupController.hideAllChatJoinRequests,
  checkChatInvite: groupController.checkChatInvite,
  // Фото группы — как аватар пользователя: открытый объект cloud
  // (publicAccess), затем group.setinfo{avatar_file_id}; без файла — снять
  async editChatPhoto({ chatId, photo }: { chatId: string; accessHash?: string; photo?: File | ApiPhoto }) {
    const groupId = store.getAddressForId(chatId);
    if (!groupId || !connection) return undefined;
    if (!photo) return groupController.setGroupInfo(groupId, { clearAvatar: true });
    if (!(photo instanceof File)) return undefined;
    const { fileId } = await mediaService.uploadBlob(
      photo,
      photo.name || 'group.jpg',
      photo.type || 'image/jpeg',
      { publicAccess: true },
    );
    mediaService.cacheBlob(fileId, photo, photo.type || 'image/jpeg');
    return groupController.setGroupInfo(groupId, { avatarFileId: fileId });
  },
  // tt зовёт при удалении «не текущего» фото профиля; у группы фото одно
  deleteProfilePhotos() {
    return Promise.resolve(true);
  },

  // Экраны профиля и канала запрашивают это фоном; в Parvane нет историй,
  // рекомендаций каналов и плашек «добавить/заблокировать» — честно пусто
  fetchPeerStories() {
    return Promise.resolve(undefined);
  },
  fetchStoriesMaxIds() {
    return Promise.resolve(undefined);
  },
  fetchChannelRecommendations() {
    return Promise.resolve(undefined);
  },
  fetchPeerSettings() {
    return Promise.resolve(undefined);
  },
  // Фоновая обслуга MTProto при открытии чата/профиля: tt просит обновить
  // чат, отменить его запросы и сообщает об открытых каналах. Обновления
  // Parvane толкает сам через gateway, отменять нечего — честно пусто, а не
  // «метод не реализован» в журнале обхода UI
  requestChatUpdate() {
    return Promise.resolve(undefined);
  },
  abortChatRequests() {
    return Promise.resolve(undefined);
  },
  setOpenedChannelIds() {
    return Promise.resolve(undefined);
  },
  // Звёздных подарков, рекламных пиров, лимита поиска по постам и облачного
  // пароля (2FA — подтверждение через Telegram) в Parvane нет
  fetchSavedStarGifts() {
    return Promise.resolve(undefined);
  },
  fetchSponsoredPeer() {
    return Promise.resolve(undefined);
  },
  checkSearchPostsFlood() {
    return Promise.resolve(undefined);
  },
  getPasswordInfo() {
    return Promise.resolve(undefined);
  },

  // ── пины и архив чатов (локальный persist) ──────────────────────────────────

  // Дефолты уведомлений по типам чатов — локальный persist
  fetchNotifyDefaultSettings() {
    const stored = localState.loadNotifyDefaults();
    return Promise.resolve({
      users: stored.users || {},
      groups: stored.groups || {},
      channels: stored.channels || {},
    });
  },

  updateNotificationSettings(peerType: string, settings: { isMuted?: boolean; shouldShowPreviews?: boolean }) {
    const defaults = localState.loadNotifyDefaults();
    defaults[peerType] = {
      mutedUntil: settings.isMuted ? MUTE_INDEFINITE_TIMESTAMP : UNMUTE_TIMESTAMP,
      shouldShowPreviews: settings.shouldShowPreviews,
    };
    localState.saveNotifyDefaults(defaults);
    pushNotifySettings();
    return Promise.resolve(true);
  },

  // Мьют/превью уведомлений: локальный persist по адресу, tt рисует бейдж и
  // гасит уведомления через chats.notifyExceptionById
  updateChatNotifySettings({ chat, settings }: { chat: ApiChat; settings: Record<string, unknown> }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    const exceptions = localState.loadNotifyExceptions();
    exceptions[address] = { ...exceptions[address], ...settings };
    localState.saveNotifyExceptions(exceptions);
    pushNotifySettings();
    sendUpdate({ '@type': 'updateChatNotifySettings', chatId: chat.id, settings: exceptions[address] });
    return Promise.resolve(undefined);
  },

  toggleChatPinned({ chat, shouldBePinned }: { chat: ApiChat; shouldBePinned: boolean }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    localState.setPinned(address, shouldBePinned);
    sendUpdate({ '@type': 'updateChatPinned', id: chat.id, isPinned: shouldBePinned });
    return Promise.resolve(undefined);
  },

  toggleChatArchived({ chat, folderId }: { chat: ApiChat; folderId: number }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve(undefined);
    const isArchiving = folderId === ARCHIVED_FOLDER_ID;
    localState.setArchived(address, isArchiving);
    // Архивируемый чат снимается с пина
    if (isArchiving) localState.setPinned(address, false);
    sendUpdate({ '@type': 'updateChatListType', id: chat.id, folderId });
    return Promise.resolve(undefined);
  },

  // ── черновики (локальный persist + кросс-таб) ───────────────────────────────

  saveDraft({ chat, draft }: { chat: ApiChat; draft: Record<string, unknown> }) {
    const address = store.getAddressForId(chat.id);
    if (!address) return Promise.resolve({});
    localState.saveDraft(address, draft);
    draftsChannel?.postMessage({ address, draft });
    return Promise.resolve({});
  },

  clearDraft({ chatId }: { chatId: string }) {
    const address = store.getAddressForId(chatId);
    if (!address) return Promise.resolve(undefined);
    localState.saveDraft(address, undefined);
    draftsChannel?.postMessage({ address, draft: undefined });
    return Promise.resolve(undefined);
  },

  // ── упоминания ──────────────────────────────────────────────────────────────

  fetchUnreadMentions({ chat }: { chat: ApiChat }) {
    const ids = new Set(syncController.collectUnreadMentions(chat.id));
    const messages = store.getMessages(chat.id).filter((message) => ids.has(message.id));
    return Promise.resolve({ messages, totalCount: messages.length });
  },

  migrateChat: (chat: ApiChat) => Promise.resolve(groupController.migrateChat(chat)),

  updateChatTitle(chat: ApiChat, title: string) {
    return groupController.updateChatTitle(chat, title);
  },

  // Выход из группы/канала: на бэкенде это self-remove
  deleteChatUser({ chat }: { chat: ApiChat; user: ApiUser }) {
    return groupController.leaveGroup(chat.id);
  },

  leaveChannel({ chat }: { chat: ApiChat }) {
    return groupController.leaveGroup(chat.id);
  },

  deleteChat({ chatId }: { chatId: string }) {
    return groupController.deleteGroup(chatId);
  },

  deleteChannel({ channelId }: { channelId: string }) {
    return groupController.deleteGroup(channelId);
  },

  // ── блокировка (локальный персист — у Parvane нет серверного блока) ─────────
  blockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) {
      const blocked = localState.loadBlocked();
      if (!blocked.includes(address)) {
        blocked.push(address);
        localState.saveBlocked(blocked);
        // FR-033: блокировка сама ключ доступа к доставке не отнимает — меняем
        // ключ и раздаём всем, кроме заблокированного
        void v2Controller.revokeContactAccess(address)
          .catch((err: unknown) => logDebug(`v2: отзыв доступа не выполнен: ${String(err)}`));
      }
    }
    return Promise.resolve(true);
  },

  unblockUser({ user }: { user: ApiUser }) {
    const address = store.getAddressForId(user.id);
    if (address) localState.saveBlocked(localState.loadBlocked().filter((a) => a !== address));
    return Promise.resolve(true);
  },

  fetchBlockedUsers() {
    const ids = localState.loadBlocked().map((a) => store.getIdForAddress(a));
    return Promise.resolve({ blockedIds: ids, totalCount: ids.length });
  },

  // ── «Отметить непрочитанным» (локальный персист; снимается при открытии чата
  //    штатным markChatRead → hasUnreadMark: undefined) ──────────────────────
  toggleDialogUnread({ chat, hasUnreadMark }: { chat: ApiChat; hasUnreadMark?: true }) {
    const marks = new Set(localState.loadUnreadMarks());
    if (hasUnreadMark) marks.add(chat.id);
    else marks.delete(chat.id);
    localState.saveUnreadMarks(Array.from(marks));
    sendUpdate({
      '@type': 'updateThreadReadState',
      chatId: chat.id,
      threadId: MAIN_THREAD_ID,
      readState: { hasUnreadMark },
    });
    return Promise.resolve(undefined);
  },

  // «Открепить все»: по одному штатным msg.chat.pin (у сервера нет пакетного)
  unpinAllMessages({ chat }: { chat: ApiChat; threadId?: unknown }) {
    store.getMessages(chat.id)
      .filter((message) => message.isPinned)
      .forEach((message) => {
        void methods.pinMessage({ chat, messageId: message.id, isUnpin: true });
      });
    return Promise.resolve(undefined);
  },

  // «Общие группы» в профиле: группы из реестра, где состоим оба
  fetchCommonChats({ user }: { user: ApiUser; maxId?: string }) {
    const address = store.getAddressForId(user.id);
    if (!address || address === store.self) return Promise.resolve({ chatIds: [], count: 0 });
    const chatIds = store.getGroupAddresses()
      .map((groupAddress) => store.getGroupInfo(groupAddress))
      .filter((info): info is NonNullable<typeof info> => Boolean(info))
      .filter((info) => info.members.some((member) => member.address === address)
        && info.members.some((member) => member.address === store.self))
      .map((info) => store.buildApiChatForGroup(info).id);
    return Promise.resolve({ chatIds, count: chatIds.length });
  },

  // Пользователи/сообщения по id — из стора (сервер per-id не отдаёт)
  fetchUsers({ users }: { users: ApiUser[] }) {
    const apiUsers = users
      .map((user) => store.getAddressForId(user.id))
      .filter((address): address is string => Boolean(address))
      .map((address) => store.buildApiUser(address));
    if (!apiUsers.length) return Promise.resolve(undefined);
    const userStatusesById: Record<string, ApiUserStatus> = {};
    apiUsers.forEach((user) => {
      userStatusesById[user.id] = RECENT_STATUS;
    });
    return Promise.resolve({ users: apiUsers, userStatusesById });
  },

  fetchMessage({ chat, messageId }: { chat: ApiChat; messageId: number }) {
    const message = store.getMessage(chat.id, messageId);
    return Promise.resolve(message ? { message } : undefined);
  },

  // «Кто голосовал» в опросе (публичные): список проголосовавших за вариант
  loadPollOptionResults({ chat, messageId, option }: {
    chat: ApiChat; messageId: number; option?: string;
  }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    if (!uuid || option === undefined) return Promise.resolve(undefined);
    const voters = polls.getVoters(uuid, Number(option));
    const votes = voters.map((address) => ({
      peerId: store.getIdForAddress(address),
      date: Math.floor(Date.now() / 1000),
    }));
    return Promise.resolve({ count: votes.length, votes, nextOffset: undefined });
  },

  // ── папки (локальный персист, как в десктоп-форке) ──────────────────────────
  fetchChatFolders() {
    const folders = localState.loadFolders();
    const byId: Record<number, unknown> = {};
    const orderedIds: number[] = [0]; // 0 = All chats
    folders.forEach((folder) => {
      byId[folder.id] = folder;
      orderedIds.push(folder.id);
    });
    return Promise.resolve({ byId, orderedIds, recommended: undefined });
  },

  editChatFolder({ id, folderUpdate }: { id: number; folderUpdate: Record<string, unknown> }) {
    // Правка папки не должна переставлять её в конец
    const folders = localState.loadFolders();
    const index = folders.findIndex((f) => f.id === id);
    const next = { ...folderUpdate, id };
    if (index >= 0) {
      folders[index] = next;
    } else {
      folders.push(next);
    }
    localState.saveFolders(folders);
    return Promise.resolve(true);
  },

  // Перетаскивание папок в Settings → Folders: без ответа tt не обновлял ни
  // вкладки слева, ни порядок после reload
  sortChatFolders(folderIds: number[]) {
    const order = new Map(folderIds.map((folderId, index) => [folderId, index]));
    const folders = localState.loadFolders().sort((a, b) => (
      (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    ));
    localState.saveFolders(folders);
    return Promise.resolve(true);
  },

  deleteChatFolder(id: number) {
    localState.saveFolders(localState.loadFolders().filter((f) => f.id !== id));
    return Promise.resolve(true);
  },

  async searchChats({ query }: { query: string }) {
    if (!connection || !query.trim()) {
      return { accountResultIds: [], globalResultIds: [] };
    }
    // Ники строчные; мобильная клавиатура ставит заглавную первую букву и
    // пробел — с телефона поиск «Asd » не находил «asd»
    const raw = await connection.request(TOPIC_IDENTITY_SEARCH, JSON.stringify({
      query: query.trim().replace(/^@/, '').toLowerCase(),
    }));
    const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
    const globalResultIds: string[] = [];
    users.forEach((u) => {
      if (u.username === store.self) return;
      store.setDisplayName(u.username, u.display_name || u.username);
      syncController.announcePeer(u.username);
      globalResultIds.push(store.getIdForAddress(u.username));
    });
    return { accountResultIds: [], globalResultIds };
  },

  // chatId пользователя по ТОЧНОМУ адресу (поиск identity — подстрочный, и
  // порядок результатов задаёт сервер): нужен для адреса отчётов о багах
  async parvaneResolveExactAddress({ address }: { address: string }) {
    const result = await methods.searchChats({ query: address });
    const expectedId = store.getIdForAddress(address);
    return result.globalResultIds.includes(expectedId) ? expectedId : undefined;
  },

  // parvaneDiag: снимок состояния провайдера для отчёта о баге (без контента)
  fetchParvaneDiagStoreInfo({ chatId }: { chatId?: string }) {
    const history = chatId ? store.getMessages(chatId) : [];
    return Promise.resolve({
      self: store.self,
      connected: Boolean(connection),
      storeCount: history.length,
      storeFirstId: history[0]?.id,
      storeLastId: history[history.length - 1]?.id,
    });
  },

  searchMessagesGlobal({ query }: { query?: string }) {
    return Promise.resolve(buildSearchResults(searchLocalMessages(query)));
  },

  searchMessagesInChat({ peer, query, type }: { peer: { id: string }; query?: string; type?: string }) {
    // Вкладки профиля (Media/Files/Links/Voice/Music) зовут без query, но с
    // type — фильтруем по типу контента вместо текстового поиска
    if (type && type !== 'text') {
      return Promise.resolve(buildSearchResults(filterMediaMessages(peer.id, type)));
    }
    return Promise.resolve(buildSearchResults(searchLocalMessages(query, peer.id)));
  },

  oldFetchLangPack({ langCode }: { langCode: string }) {
    return Promise.resolve({ langPack: buildOldLangPack(langCode) });
  },

  // ── фон чата ────────────────────────────────────────────────────────────────
  // Галереи обоев Telegram нет: встроенные градиенты рисуем на клиенте
  // (wallpapers.ts). Свою картинку пользователя раньше клали открытым блобом в
  // Cache Storage (CUSTOM_BG_CACHE_NAME) — это пользовательское медиа в
  // постоянном хранилище в открытом виде (FR-023). Теперь она лежит
  // зашифрованной в SecureE2eStorage под ключом устройства
  // Картинка хранится БАЙТАМИ (`saveBytesRecord`), а не base64 в JSON: тот же
  // довод, что и для архивов паков — base64 раздувает файл на треть, а обои
  // бывают многомегабайтными. Мим-тип лежит отдельной маленькой записью
  async saveChatBackground({ theme, bytes, mimeType }: {
    theme: string; bytes: ArrayBuffer; mimeType: string;
  }) {
    if (!store.self) return { status: 'not-ready' as const };
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    if (!storage) return { status: 'not-ready' as const };
    const name = `${BACKGROUND_RECORD_PREFIX}${theme}`;
    await storage.saveBytesRecord(name, new Uint8Array(bytes));
    await storage.saveRecord(`${name}:mime`, mimeType);
    return { status: 'ok' as const };
  },

  // `not-ready` (провайдер ещё не знает пользователя) и `empty` (обоев нет)
  // РАЗНЫЕ: на `not-ready` вызывающий обязан повторить, а не сбрасывать
  // настройку темы — иначе фон терялся бы при каждой перезагрузке
  async loadChatBackground({ theme }: { theme: string }) {
    if (!store.self) return { status: 'not-ready' as const };
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    if (!storage) return { status: 'not-ready' as const };
    const name = `${BACKGROUND_RECORD_PREFIX}${theme}`;
    const bytes = await storage.loadBytesRecord(name);
    if (!bytes) return { status: 'empty' as const };
    const mimeType = await storage.loadRecord<string>(`${name}:mime`);
    return { status: 'ok' as const, blob: new Blob([bytes as BlobPart], { type: mimeType || 'image/jpeg' }) };
  },

  async fetchWallpapers() {
    const wallpapers = await buildBuiltinWallpapers(mediaService.cacheBlob);
    return { wallpapers };
  },

  uploadWallpaper(file: File) {
    const id = `wp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const mimeType = file.type || 'image/jpeg';
    mediaService.cacheBlob(id, file, mimeType);
    const wallpaper: ApiWallpaper = {
      slug: id,
      document: {
        mediaType: 'document',
        id,
        fileName: file.name || 'wallpaper.jpg',
        mimeType,
        size: file.size,
      },
    };
    return Promise.resolve({ wallpaper });
  },

  // Просмотр фото профиля (MediaViewer): у пользователя одно фото — аватар
  fetchProfilePhotos({ peer }: { peer: ApiPeer; offset?: number; limit?: number }) {
    const address = store.getAddressForId(peer.id);
    const fileId = address ? store.getAvatar(address) : undefined;
    const photos: ApiPhoto[] = fileId ? [buildAvatarPhoto(fileId)] : [];
    return Promise.resolve({ count: photos.length, photos, nextOffsetId: undefined });
  },

  // ── стикеры (встроенный набор + кастомные паки) ─────────────────────────────
  async fetchStickerSets() {
    const { set, blobs } = await buildBuiltinStickerSet();
    // Регистрируем картинки/видео стикеров в media-кэше (хэш document<id>)
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, getStickerBlobMime(id));
    });
    // Наборы эмодзи сюда не входят (их отдаёт `fetchCustomEmojiSets`), а поле
    // `stickers` у набора без содержимого опускается целиком: tt сливает ответ с
    // уже загруженным набором (`{ ...existing, ...set }`), и явное `undefined`
    // стирало содержимое — панель эмодзи показывала заголовок набора без эмодзи,
    // когда этот ответ приходил позже ответа со списком наборов эмодзи
    const withoutStickers = ({ stickers: _stickers, ...rest }: ApiStickerSet): ApiStickerSet => rest;
    const packs = (await loadInstalledPacks(store.self)).filter((pack) => !pack.isEmoji);
    const customSets = packs.map((pack) => {
      const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      return withoutStickers(built.set);
    });
    const hash = `1:${customSets.map(({ id }) => id).sort().join(',')}`;
    return { hash, sets: [withoutStickers(set), ...customSets] };
  },

  async fetchStickerSet(params?: { stickerSetInfo?: { id?: string; shortName?: string } }) {
    const info = params?.stickerSetInfo;
    const customSetId = info?.id && isCustomPackSetId(info.id)
      ? info.id
      : info?.shortName ? resolveSetIdByShortName(info.shortName) : undefined;
    if (customSetId) {
      const resolved = await resolveCustomPack(customSetId);
      if (!resolved) throw new Error('STICKERSET_INVALID');
      const built = buildCustomSet(customSetId, resolved.pack, resolved.isInstalled
        ? INSTALLED_PACK_DATE : undefined);
      registerPackBlobs(built.blobs);
      return { set: built.set, stickers: built.set.stickers };
    }
    const wantsEmoji = info?.id === 'parvane-emoji' || info?.shortName === 'ParvaneEmoji';
    const { set, blobs } = wantsEmoji ? await buildBuiltinCustomEmojiSet() : await buildBuiltinStickerSet();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, getStickerBlobMime(id));
    });
    return { set, stickers: set.stickers };
  },

  async installStickerSet({ stickerSetId }: { stickerSetId: string }) {
    if (!isCustomPackSetId(stickerSetId)) return undefined;
    const resolved = await resolveCustomPack(stickerSetId);
    if (!resolved) return undefined;
    const isEmoji = isEmojiPackSetId(stickerSetId) || Boolean(resolved.pack.isEmoji);
    const rawName = resolved.pack.rawName || (isEmoji ? getEmojiPackRawName(stickerSetId) : undefined);
    await saveInstalledPack(store.self, {
      ...resolved.pack,
      // Набор — тот, по которому пак пришёл: у одноимённого пака другого
      // отправителя он свой (PACK-1/EMOJI-1), и хранение обязано их различать
      setId: stickerSetId,
      isEmoji: isEmoji || undefined,
      rawName,
      aliases: isEmoji ? getEmojiPackNames(stickerSetId, resolved.pack).filter((name) => name !== rawName) : undefined,
    });
    const built = buildCustomSet(stickerSetId, resolved.pack, INSTALLED_PACK_DATE);
    registerPackBlobs(built.blobs);
    sendUpdate({ '@type': 'updateStickerSet', id: built.set.id, stickerSet: built.set });
    return true;
  },

  async uninstallStickerSet({ stickerSetId }: { stickerSetId: string }) {
    const pack = await findInstalledPackBySetId(store.self, stickerSetId);
    if (!pack) return undefined;
    await removeInstalledPack(store.self, stickerSetId);
    sendUpdate({ '@type': 'updateStickerSet', id: stickerSetId, stickerSet: { installedDate: undefined } });
    return true;
  },

  // Создание пака из локальных файлов (Настройки → Стикеры). Имя уникализируем
  // суффиксом, чтобы не перетереть существующий набор
  async parvaneCreateStickerPack({ name, files }: { name: string; files: File[] }) {
    const packFiles: PackFile[] = [];
    for (const file of files) {
      if (!getPackFileMime(file.name)) continue;
      packFiles.push({ name: file.name, data: await file.arrayBuffer() });
    }
    if (!packFiles.length) return undefined;
    const baseName = sanitizePackName(name);
    const existing = await loadInstalledPacks(store.self);
    let finalName = baseName;
    let suffix = 2;
    while (existing.some((pack) => pack.name === finalName)) {
      finalName = sanitizePackName(`${baseName.slice(0, 28)} ${suffix}`);
      suffix += 1;
    }
    const pack: StoredPack = { name: finalName, files: packFiles };
    await saveInstalledPack(store.self, pack);
    const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
    registerPackBlobs(built.blobs);
    sendUpdate({ '@type': 'updateStickerSet', id: built.set.id, stickerSet: built.set });
    return { title: finalName, count: packFiles.length };
  },

  // ── Settings → Devices: устройства аккаунта = прекей-каталог identity ───────

  async fetchAuthorizations() {
    if (!connection || !e2e) return undefined;
    try {
      const raw = await connection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token }));
      const response = JSON.parse(raw) as {
        ok: boolean;
        devices?: { device_id: string; updated_at: number }[];
      };
      if (!response.ok || !response.devices) return undefined;
      const currentDeviceId = e2e.deviceId;
      const v2Devices = v2Controller.logDevices(store.self);
      const authorizations: Record<string, ApiSession> = {};
      response.devices.forEach((device) => {
        const session = buildDeviceSession(device, currentDeviceId);
        // Журнал v2 есть, а устройства в нём нет — оно на старой версии
        if (v2Devices && !v2Devices.v2.includes(device.device_id)) {
          session.appVersion = PARVANE_LEGACY_APP_VERSION;
        }
        authorizations[device.device_id] = session;
      });
      // Устройства только из журнала v2: у аккаунта на v2 новое устройство в
      // каталог v1 не попадает (T048) — без этого его не видно и не отозвать
      (v2Devices?.v2 || []).forEach((deviceId) => {
        if (authorizations[deviceId]) return;
        // Времени активности у записи журнала нет — показываем «сейчас»
        authorizations[deviceId] = buildDeviceSession(
          { device_id: deviceId, updated_at: Math.floor(Date.now() / 1000) }, currentDeviceId,
        );
      });
      return { authorizations, ttlDays: undefined };
    } catch {
      return undefined;
    }
  },

  // hash = device_id ('' — legacy-primary: desktop или прежняя web-установка).
  // Текущее устройство не отзываем — UI его и не предлагает
  // P-07: сервер отзывает устройство только с текущим паролем — UI спрашивает
  // его перед отзывом (сохранённого пароля нет, P-39)
  async terminateAuthorization(hash: string, password?: string) {
    if (!e2e || hash === e2e.deviceId) return undefined;
    return revokeOwnDevice(hash, password);
  },

  async terminateAllAuthorizations(password?: string) {
    if (!connection || !e2e) return undefined;
    const list = await methods.fetchAuthorizations();
    if (!list) return undefined;
    const others = Object.keys(list.authorizations)
      .filter((deviceId) => deviceId !== e2e!.deviceId);
    const results = await Promise.all(others.map((deviceId) => revokeOwnDevice(deviceId, password)));
    return results.every(Boolean) ? true : undefined;
  },

  // ── Смена ключа подписи устройств после отзыва (T128/T130, D-12) ────────────

  // Отозвано устройство, державшее SSK: до смены корнем новые устройства не
  // принимаются. Корень — только в копии под ключом восстановления
  parvaneGetSskState() {
    return Promise.resolve(v2Controller.sskState());
  },

  parvaneRotateSsk({ recoveryKey }: { recoveryKey: string }) {
    return v2Controller.rotateSsk(recoveryKey);
  },

  // ── Авто-линковка истории: методы для Settings → Devices ────────────────────

  // Новое устройство: статус собственного оффера (код показывается в UI,
  // пользователь сверяет его на старом устройстве перед подтверждением)
  parvaneGetLinkStatus() {
    // v2: код появляется только после challenge старого устройства
    const isPending = Boolean(linkRuntime.timer && e2e && needsDeviceLink(e2e));
    return Promise.resolve({
      isPending,
      code: isPending ? linkRuntime.code : undefined,
      // v2: у аккаунта есть журнал устройств, а это устройство в него не входит —
      // кроме линковки, есть вход по ключу восстановления и сброс личности
      canRecover: v2Controller.needsLinking(),
    });
  },

  // Это единственное устройство аккаунта в журнале v2: выход с него стирает ключи,
  // и следующий вход потребует ключ восстановления (или сброс личности)
  parvaneIsLastDevice() {
    const own = v2Controller.logDevices(store.self);
    return Promise.resolve(Boolean(own && !v2Controller.needsLinking() && own.v2.length <= 1));
  },

  // ── Новое устройство без других устройств (T130, FR-066) ───────────────────

  // Корень — из копии на сервере под ключом восстановления; прежние устройства
  // отзываются
  parvaneRecoverWithKey({ recoveryKey }: { recoveryKey: string }) {
    return v2Controller.recoverWithKey(recoveryKey);
  },

  // Новый корень взамен прежнего (нужен пароль): собеседники увидят смену
  // ключа безопасности, прежняя переписка v2 этим устройством не читается
  parvaneResetIdentity({ password }: { password: string }) {
    return v2Controller.resetIdentity(password);
  },

  // Старое устройство: запросы линковки от других устройств аккаунта. На
  // каждый оффер v2 отправляем свой challenge; код появляется после раскрытия
  // ключа новым устройством.
  async parvaneListLinkOffers() {
    if (!connection || !e2e) return undefined;
    try {
      const raw = await connection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: e2e.deviceId,
      }));
      const response = JSON.parse(raw) as {
        ok: boolean; offers?: LinkOfferWire[]; grant?: { box_payload: string; eph_pub: string };
      };
      // Свой грант пришёл в опросе чужих офферов — оставляем опросу своего оффера
      if (response.ok && response.grant && linkRuntime.timer) pendingLinkGrant = response.grant;
      if (!response.ok || !response.offers) return undefined;
      const live = new Set(response.offers.map((offer) => offer.device_id));
      Array.from(linkChallenges.keys()).forEach((deviceId) => {
        if (!live.has(deviceId)) linkChallenges.delete(deviceId);
      });
      const described = await Promise.all(response.offers.map(describeLinkOffer));
      return { offers: described.filter(Boolean) };
    } catch {
      return undefined;
    }
  },

  // Старое устройство: подтверждённая передача истории целевому устройству.
  // Экспорт (без приватного Olm-аккаунта, P-48) шифруется случайным ключом и
  // уезжает в cloud (owner-only); координаты, ключ и подписанный перенос
  // владения исходящими — в ECDH-боксе под парой эфемерных ключей (P-03).
  async parvaneGrantLink({ deviceId }: { deviceId: string }) {
    const engine = e2e;
    const activeConnection = connection;
    if (!engine || !activeConnection) return undefined;
    try {
      const pollRaw = await activeConnection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: engine.deviceId,
      }));
      const poll = JSON.parse(pollRaw) as { ok: boolean; offers?: LinkOfferWire[] };
      const offer = poll.ok ? poll.offers?.find((entry) => entry.device_id === deviceId) : undefined;
      const own = linkChallenges.get(deviceId);
      if (!offer || !own || !offer.commitment || !offer.eph_pub || offer.challenge_pub !== own.pub) return undefined;
      if (!(await linkCommitmentMatches(offer.eph_pub, offer.commitment))) return undefined;

      await engine.flushStorage();
      // LINK-1 п. 8: строки v2-эпохи новому устройству сервер не отдаст
      await localState.flushHistoryNow();
      const exportJson = engine.exportLinkStateJson(collectV2History(
        await localState.loadHistoryRecords(), await localState.readOwnJournal(),
      ));
      const upload = await mediaService.uploadBlob(
        new Blob([exportJson]), 'link-transfer', 'application/octet-stream', { encrypt: true },
      );
      if (!upload.mediaKeys) return undefined;

      // LINK-1 v2: грант движка — вторым блобом (в бокс не помещается)
      const v2Material = v2Controller.linkGrantMaterial();
      const v2Upload = v2Material && await mediaService.uploadBlob(
        new Blob([v2Material.slice()]), 'link-grant-v2', 'application/octet-stream', { encrypt: true },
      );
      v2Material?.fill(0);

      const box = await sealLinkBox(own.keyPair.privateKey, offer.eph_pub, {
        file_id: upload.fileId,
        file_key: upload.mediaKeys.keyB64,
        file_nonce: upload.mediaKeys.nonceB64,
        transfer: offer.signing_key ? engine.signLinkTransfer(store.self, offer.signing_key) : undefined,
        v2: v2Upload?.mediaKeys ? {
          file_id: v2Upload.fileId,
          file_key: v2Upload.mediaKeys.keyB64,
          file_nonce: v2Upload.mediaKeys.nonceB64,
        } : undefined,
      });
      const grantRaw = await activeConnection.request(TOPIC_LINK_GRANT, JSON.stringify({
        token, device_id: deviceId, box_payload: box, eph_pub: own.pub,
      }));
      const ok = (JSON.parse(grantRaw) as { ok?: boolean }).ok;
      if (ok) linkChallenges.delete(deviceId);
      return ok ? true : undefined;
    } catch (err) {
      logDebug(`линковка: грант не удался: ${String(err)}`);
      return undefined;
    }
  },

  // ── web-push (шард push, VAPID) ─────────────────────────────────────────────

  async parvaneGetPushKey() {
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_PUSH_VAPID_GET, JSON.stringify({}));
      const response = JSON.parse(raw) as { ok: boolean; public_key?: string };
      if (!response.ok || !response.public_key) return undefined;
      return { publicKey: response.public_key };
    } catch {
      return undefined;
    }
  },

  // token — JSON PushSubscription из notifications.tsx (getDeviceToken)
  async registerDevice(deviceToken: string) {
    if (!connection) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string; keys?: unknown };
      if (!subscription.endpoint || !subscription.keys) return undefined;
      const raw = await connection.request(TOPIC_PUSH_REGISTER, JSON.stringify({
        token,
        subscription,
      }));
      // Протокол v2: журнал v2 будит устройство своей регистрацией
      if (v2Controller.isReady()) {
        void v2Controller.pushRegister(subscription as Parameters<typeof v2Controller.pushRegister>[0])
          .catch((err: unknown) => logDebug(`v2: push.wake.register не удался: ${String(err)}`));
      }
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  async unregisterDevice(deviceToken: string) {
    if (!connection) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string };
      const raw = await connection.request(TOPIC_PUSH_UNREGISTER, JSON.stringify({
        token,
        endpoint: subscription.endpoint,
      }));
      if (v2Controller.isReady() && subscription.endpoint) {
        void v2Controller.pushUnregister(subscription.endpoint).catch(() => undefined);
      }
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  // ── C1: бэкап E2E-ключей (перенос на другое устройство) ─────────────────────

  async parvaneExportE2eKeys({ password }: { password: string }) {
    if (!e2e) return undefined;
    await e2e.flushStorage();
    // Копия несёт и устройство v2 с историей v2-эпохи: сервер v2 не отдаст её
    // заново, а сообщения запечатаны под устройства журнала (T152)
    await localState.flushHistoryNow();
    const v2 = isV2Enabled() ? await v2Controller.exportBackup() : undefined;
    const v2History = v2 ? collectV2History(
      await localState.loadHistoryRecords(), await localState.readOwnJournal(),
    ) : undefined;
    return { payload: await e2e.exportEncrypted(password, v2 ? { v2, v2History } : undefined) };
  },

  async parvaneImportE2eKeys({ payload, password }: { payload: string; password: string }) {
    if (!store.self) return undefined;
    try {
      let extra: { v2?: V2DeviceBackup; v2History?: unknown } | undefined;
      const imported = await E2eEngine.importEncrypted(store.self, payload, password, (value) => {
        extra = value;
      });
      setE2eEngine(imported);
      if (extra?.v2 && isV2Enabled()) {
        // Этот браузер становится тем же устройством v2 (со следующего входа —
        // JWT выпустят под device_id из копии)
        v2Controller.reset();
        await v2Controller.importBackup(extra.v2);
        // Следующий вход просит JWT под device_id из копии — иначе сессия v2
        // представилась бы серверу другим устройством
        connectionController.rememberDeviceId(store.self, imported.deviceId);
      }
      // Полный ресинк с восстановленным состоянием: старая sealed-история
      // расшифруется из привезённого decCache
      syncController.reset();
      resetPackRegistries();
      sendUpdate({ '@type': 'requestSync' });
      if (extra?.v2History && isV2Enabled()) {
        await applyLinkedV2History(parseV2History(JSON.stringify({ v2History: extra.v2History })), store.self);
        await localState.flushHistoryNow();
      }
      return true;
    } catch (err) {
      logDebug(`импорт ключей не удался: ${String(err)}`);
      return undefined;
    }
  },

  async fetchStickers(params?: { stickerSetInfo?: { id?: string; shortName?: string } }) {
    const result = await methods.fetchStickerSet(params);
    const packs: Record<string, ApiSticker[]> = {};
    (result.stickers || []).forEach((s) => {
      if (s.emoji) (packs[s.emoji] ||= []).push(s);
    });
    return { set: result.set, stickers: result.stickers || [], packs };
  },

  async fetchRecentStickers() {
    const { set } = await buildBuiltinStickerSet();
    return { hash: '1', stickers: (set.stickers || []).slice(0, 6) };
  },

  fetchFeaturedStickers() {
    return Promise.resolve({ hash: '1', sets: [] });
  },

  // ── кастом-эмодзи (встроенный набор) ────────────────────────────────────────

  // Кастом-эмодзи: встроенный набор + установленные эмодзи-паки (в т.ч.
  // пришедшие из desktop через emoji_packs)
  async fetchCustomEmojiSets() {
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'image/png');
    });
    const sets = [set];
    const installed = (await loadInstalledPacks(store.self)).filter((pack) => pack.isEmoji);
    installed.forEach((pack) => {
      const built = buildCustomSet(getPackSetId(pack), pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      sets.push(built.set);
    });
    return { hash: `1:${installed.length}`, sets };
  },

  // Документы по docId из entity custom_emoji: встроенные, установленные и
  // ещё не установленные паки, приложенные к принятым сообщениям (архив
  // тянется из cloud по pack_ref)
  async fetchCustomEmoji({ documentId }: { documentId: string[] }) {
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'image/png');
    });
    const found = (set.stickers || []).filter((s) => documentId.includes(s.id));
    const missing = new Set(documentId.filter((id) => !found.some((s) => s.id === id)));
    // Старые docId встроенного набора: блоб тот же, что у нового id
    getBuiltinLegacyEmojiIds().forEach(([legacyId, currentId]) => {
      const blob = blobs.get(currentId);
      if (blob && missing.has(legacyId)) mediaService.cacheBlobIfAbsent(legacyId, blob, 'image/png');
    });
    const takeAliases = () => {
      Array.from(missing).forEach((id) => {
        const alias = getAliasEmojiSticker(id);
        if (alias) {
          found.push(alias);
          missing.delete(id);
        }
      });
    };
    takeAliases();
    if (!missing.size) return found;
    // Установленные эмодзи-паки (после перезагрузки реестр сессии пуст)
    for (const pack of (await loadInstalledPacks(store.self)).filter((candidate) => candidate.isEmoji)) {
      if (!missing.size) break;
      const built = buildCustomSet(getPackSetId(pack), pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      (built.set.stickers || []).forEach((sticker) => {
        if (missing.has(sticker.id)) {
          found.push(sticker);
          missing.delete(sticker.id);
        }
      });
      takeAliases();
    }
    for (const setId of getReceivedEmojiPackSetIds()) {
      if (!missing.size) break;
      if (setId === set.id) continue;
      const resolved = await resolveCustomPack(setId).catch(() => undefined);
      if (!resolved) continue;
      const built = buildCustomSet(setId, resolved.pack, resolved.isInstalled ? INSTALLED_PACK_DATE : undefined);
      registerPackBlobs(built.blobs);
      (built.set.stickers || []).forEach((sticker) => {
        if (missing.has(sticker.id)) {
          found.push(sticker);
          missing.delete(sticker.id);
        }
      });
      takeAliases();
    }
    return found;
  },

  async fetchSavedGifs() {
    const { gifs, blobs } = await buildBuiltinGifs();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'video/webm');
    });
    await messageController.ensureSavedGifsHydrated();
    const saved = messageController.getSavedGifs();
    return { hash: `1:${saved.length}`, gifs: [...saved, ...gifs] };
  },

  // ── запланированные сообщения (локальная очередь) ───────────────────────────

  fetchScheduledHistory({ chat }: { chat: ApiChat }) {
    return Promise.resolve({ messages: localState.fetchScheduledHistory(chat) });
  },

  deleteScheduledMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
    localState.deleteScheduledMessages(chat.id, messageIds);
    return Promise.resolve();
  },

  async sendScheduledMessages({ chat, ids }: { chat: ApiChat; ids: number[] }) {
    await localState.sendScheduledMessages(chat, ids);
  },

  rescheduleMessage({ chat, message, scheduledAt }: { chat: ApiChat; message: ApiMessage; scheduledAt: number }) {
    localState.rescheduleMessage(chat, message, scheduledAt);
    return Promise.resolve();
  },

  // ── звонки (программный API; UI-панель — window.parvaneCalls) ───────────────
  async parvanePlaceCall({ chat, isVideo }: { chat: ApiChat; isVideo?: boolean }) {
    return callController.placeCall(chat.id, isVideo);
  },

  async parvaneAcceptCall() {
    return callController.acceptIncoming();
  },

  parvaneHangUp() {
    callController.hangUp();
    return Promise.resolve(true);
  },

  parvaneToggleMute() {
    return Promise.resolve(callController.toggleMute());
  },

  parvaneToggleCamera() {
    return Promise.resolve(callController.toggleCamera());
  },

  // ── логин через штатные Auth-экраны ────────────────────────────────────────
  // «Телефон» = ник (сервер дополняет до ник@домен) или полный адрес
  // user@server; дальше нативный экран пароля

  // Параметры сервера для экранов входа/регистрации (кэш на сессию вкладки)
  parvaneFetchServerInfo() {
    if (!serverInfoPromise) {
      serverInfoPromise = connectionController.fetchServerInfo();
    }
    return serverInfoPromise;
  },

  // Что показать на экранах регистрации/кода/Telegram: ник (без домена),
  // почта, deep link бота
  parvaneFetchAuthContext() {
    const info = connectionController.getLastServerInfo();
    const bot = info?.telegramBot || '';
    return Promise.resolve({
      nick: pendingLoginAddress.split('@')[0],
      email: pendingEmail,
      telegramBot: bot,
      telegramLink: bot && pendingTelegramToken
        ? `https://t.me/${bot}?start=${encodeURIComponent(pendingTelegramToken)}`
        : '',
      telegramMode: pendingTelegramMode,
    });
  },

  // ── ключи безопасности (отпечатки identity-ключей) ──────────────────────
  async parvaneFetchSecurityInfo({ chatId }: { chatId?: string }) {
    const engine = e2e;
    if (!engine) return undefined;
    // v2 (T153): ключ безопасности — отпечаток корня личности из проверенного
    // журнала устройств, один на аккаунт (в v1 — отпечаток каждого устройства).
    // Свой показываем тем же способом, каким его увидит собеседник на v2
    const ownRoot = isV2Enabled() && v2Controller.isReady() ? v2Controller.logDevices(store.self)?.root : undefined;
    const own = ownRoot ? await fingerprintOf(ownRoot) : await engine.getOwnFingerprint();
    const address = chatId ? store.getAddressForId(chatId) : undefined;
    if (!address || address === store.self || store.isGroupAddress(address)) {
      return { own, devices: [] as { deviceId: string; fingerprint: string }[] };
    }
    if (ownRoot && await v2Controller.isV2Peer(address).catch(() => false)) {
      const peerRoot = v2Controller.logDevices(address)?.root;
      if (peerRoot) return { own, devices: [{ deviceId: 'v2', fingerprint: await fingerprintOf(peerRoot) }] };
    }
    const fetchBundle = async (user: string) => {
      const raw = await connection!.request(TOPIC_PREKEYS_FETCH, JSON.stringify({
        token, user, known_devices: engine.getKnownDeviceIds(user),
      }));
      return JSON.parse(raw) as {
        ok: boolean; identity_key?: string; signed_prekey?: string; one_time?: string; devices?: WireDeviceBundle[];
      };
    };
    const devices = await engine.getContactFingerprints(address, connection ? fetchBundle : undefined);
    return { own, devices };
  },

  // ── двухфакторный вход (Settings → Privacy) ──────────────────────────────
  async parvaneFetchTwoFactor() {
    if (!connection) return undefined;
    const raw = await connection.request(TOPIC_IDENTITY_TWOFA, JSON.stringify({ token }));
    const response = JSON.parse(raw) as { ok: boolean; enabled?: boolean; telegram_linked?: boolean; error?: string };
    return { enabled: Boolean(response.enabled), telegramLinked: Boolean(response.telegram_linked) };
  },

  // P-07: смена настройки 2FA требует текущий пароль (один украденный JWT не
  // должен снимать второй фактор; метод v2 без свежего пароля не включает и
  // 2FA). P-39: только введённый пароль, сохранённого нет.
  async parvaneSetTwoFactor({ enabled, password }: { enabled: boolean; password?: string }) {
    if (!connection) return undefined;
    const raw = await connection.request(TOPIC_IDENTITY_TWOFA, JSON.stringify({ token, enabled, password }));
    const response = JSON.parse(raw) as {
      ok: boolean; enabled?: boolean; telegram_linked?: boolean; error?: string; trust_secret?: string;
    };
    if (!response.ok) throw new Error(response.error || 'identity отклонил настройку');
    // Устройство, включившее 2FA, получает секрет доверия сразу — иначе при
    // следующей загрузке оно само попросило бы подтверждение в Telegram
    if (response.trust_secret) connectionController.writeTrustSecret(store.self, response.trust_secret);
    return { enabled: Boolean(response.enabled), telegramLinked: Boolean(response.telegram_linked) };
  },

  // P-07: смена пароля (identity.password.change): JWT + старый пароль; сервер
  // сбрасывает доверие устройств 2FA. Обновляем сохранённый пароль.
  // P-34: согласие на добавление в группы
  async parvaneGetGroupAddPolicy() {
    await refreshV2Privacy();
    return { policy: readGroupAddPolicy() };
  },

  parvaneSetGroupAddPolicy({ policy }: { policy: 'anyone' | 'nobody' }) {
    try {
      localStorage.setItem(groupAddPolicyKey(store.self), policy);
    } catch {
      // приватный режим — настройка не переживёт reload
    }
    pushNotifySettings();
    pushV2Privacy();
    return Promise.resolve(true);
  },

  // Протокол v2: «сообщения от незнакомых» (T079). Настройка есть только у
  // v2-стека — экран показывает её, когда он поднят
  parvaneIsUpgradeRequired() {
    return Promise.resolve(isUpgradeRequired);
  },

  parvaneTakeRecoveryKey() {
    const recoveryKey = pendingRecoveryKey;
    pendingRecoveryKey = undefined;
    return Promise.resolve(recoveryKey ? { recoveryKey } : undefined);
  },

  async parvaneGetCallPresencePolicy() {
    await refreshV2Privacy();
    return {
      isAvailable: v2Controller.isReady(),
      areCallsAllowed: readAudience(callsPolicyKey(store.self)) !== 'nobody',
      isPresenceShown: readAudience(presencePolicyKey(store.self)) !== 'nobody',
    };
  },

  parvaneSetCallsPolicy({ isAllowed }: { isAllowed: boolean }) {
    writeAudience(callsPolicyKey(store.self), isAllowed ? 'anyone' : 'nobody');
    pushV2Privacy();
    return Promise.resolve(true);
  },

  parvaneSetPresencePolicy({ isShown }: { isShown: boolean }) {
    writeAudience(presencePolicyKey(store.self), isShown ? 'anyone' : 'nobody');
    pushV2Privacy();
    return Promise.resolve(true);
  },

  async parvaneGetStrangersPolicy() {
    await refreshV2Privacy();
    return { isAvailable: v2Controller.isReady(), isAllowed: readStrangersAllowed() };
  },

  parvaneSetStrangersPolicy({ isAllowed }: { isAllowed: boolean }) {
    try {
      localStorage.setItem(strangersPolicyKey(store.self), isAllowed ? 'anyone' : 'nobody');
    } catch {
      // приватный режим — настройка не переживёт reload
    }
    pushV2Privacy();
    return Promise.resolve(true);
  },

  // Протокол v2: режим чата «усиленная приватность» (L2, FR-036). Личный чат —
  // своё предпочтение (`isMine`), режим активен, пока включён хотя бы у одного;
  // группа v2 — политика в журнале группы. Пункта нет, пока собеседник не на
  // v2 или стек не поднят
  async parvaneGetChatL2({ chatId }: { chatId: string }) {
    const address = store.getAddressForId(chatId);
    if (!address || address === store.self || !v2Controller.isReady()) return { isAvailable: false };
    const isGroup = v2Controller.isV2GroupAddress(address);
    if (!isGroup && (store.isGroupAddress(address) || !(await v2Controller.isV2Peer(address).catch(() => false)))) {
      return { isAvailable: false };
    }
    const state = v2Controller.l2State(address);
    if (!state) return { isAvailable: false };
    return { isAvailable: true, isActive: state.active, isMine: state.mine };
  },

  async parvaneSetChatL2({ chatId, isEnabled }: { chatId: string; isEnabled: boolean }) {
    const address = store.getAddressForId(chatId);
    if (!address) return false;
    try {
      return await (v2Controller.isV2GroupAddress(address)
        ? v2Controller.setGroupL2(address, isEnabled)
        : v2Controller.setDirectL2(address, isEnabled));
    } catch (err) {
      logDebug(`v2: режим «усиленная приватность» не изменён: ${String(err)}`);
      return false;
    }
  },

  // P-34: отзыв инвайт-ссылки группы (owner/admin)
  async parvaneRevokeGroupInvite({ groupId, invite }: { groupId: string; invite: string }) {
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_GROUP_INVITE_REVOKE, JSON.stringify({
        token, group_id: groupId, invite,
      }));
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  // P-39: опциональный PIN хранилища E2E/сессии
  async parvaneGetStoragePin() {
    if (!store.self) return { enabled: false };
    return { enabled: await hasStoragePin(store.self).catch(() => false) };
  },

  async parvaneSetStoragePin({ pin }: { pin: string }) {
    if (!store.self) return undefined;
    try {
      await ensureStorageUnlocked(store.self);
      await setStoragePin(store.self, pin);
      if (!pin) lockStorage(store.self);
      return true;
    } catch (err) {
      logDebug(`PIN хранилища: ${String(err)}`);
      return undefined;
    }
  },

  async parvaneChangePassword({ oldPassword, newPassword }: { oldPassword: string; newPassword: string }) {
    if (!connection) throw new Error('нет соединения');
    const raw = await connection.request(
      TOPIC_IDENTITY_PASSWORD_CHANGE,
      JSON.stringify({ token, old_password: oldPassword, new_password: newPassword }),
    );
    const response = JSON.parse(raw) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(response.error || 'identity отклонил смену пароля');
    // P-39: пароль не хранится — обновлять нечего
    return true;
  },

  provideAuthPhoneNumber(input: string) {
    const raw = input.trim().toLowerCase();
    const isFullAddress = /^[^@\s]+@[^@\s]+$/.test(raw);
    if (!isFullAddress && !NICK_PATTERN.test(raw)) {
      // Повторный WaitPhoneNumber сбрасывает auth.isLoading — иначе форма
      // навсегда останется в состоянии загрузки и не даст повторить ввод
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneNickInvalid' } });
      return Promise.resolve(undefined);
    }
    // Голый ник дополнит доменом сервера connectAndLogin (на логин-соединении)
    pendingLoginAddress = raw;
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
    return Promise.resolve(undefined);
  },

  async provideAuthPassword(password: string) {
    const user = pendingLoginAddress || readLoginAddress();
    if (!user) {
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      return;
    }
    try {
      const address = await connectionController.connectAndLogin(user, password);
      pendingLoginAddress = address;
      saveLoginAddress(address);
      await persistSessionCredential(address, password);
    } catch (err) {
      if (err instanceof TwoFactorRequiredError) {
        // Пароль верен, включён двухфакторный вход — экран Telegram (deep link)
        const info = connectionController.getLastServerInfo();
        const address = canonicalAddress(user, info?.domain || '');
        startTelegramConfirmation(address, password, err.loginToken, 'login');
        return;
      }
      const message = String(err);
      logDebug(`логин отклонён: ${message}`);
      // Сервер требует регистрацию через почту: такого аккаунта нет — форма
      // регистрации с этим ником; аккаунт есть, но не подтверждён — сразу
      // экран кода (fallback-register в issueToken уже перевыслал код на
      // сохранённую почту)
      if (message.includes('нужна регистрация через почту') || message.includes('нет такого пользователя')) {
        pendingLoginPassword = password;
        sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitRegistration' });
        sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneNoAccountYet' } });
        return;
      }
      if (message.includes('не подтверждена')) {
        // Пароль верен, аккаунт ждёт подтверждения: повторный register тем же
        // паролем перевысылает код / даёт новый токен deep link
        pendingLoginPassword = password;
        const info = connectionController.getLastServerInfo();
        const address = canonicalAddress(user, info?.domain || '');
        pendingLoginAddress = address;
        try {
          const result = await connectionController.registerAccount(address, password, '');
          if (result.telegramToken) {
            startTelegramConfirmation(address, password, result.telegramToken);
            return;
          }
        } catch (resendErr) {
          logDebug(`перевысылка подтверждения не удалась: ${String(resendErr)}`);
        }
        sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitCode' });
        return;
      }
      // Повторный WaitPassword сбрасывает auth.isLoading, чтобы форма дала
      // ввести пароль ещё раз
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ErrorIncorrectPassword' } });
    }
  },

  // Кнопка «Создать аккаунт» на экране входа — форма регистрации с пустым ником
  parvaneStartRegistration() {
    // Ник с экрана входа/пароля остаётся заполненным в форме
    pendingLoginPassword = '';
    pendingEmail = '';
    stopTelegramPolling();
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitRegistration' });
    return Promise.resolve(undefined);
  },

  // Форма регистрации (WaitRegistration): ник + почта (если сервер требует) +
  // пароль. Дальше экран кода или сразу логин
  async parvaneRegister({ nick, email, password }: { nick: string; email: string; password: string }) {
    const { domain, confirm } = await methods.parvaneFetchServerInfo();
    const emailRequired = confirm === 'email';
    const raw = nick.trim().toLowerCase();
    const fail = (key: 'ParvaneNickInvalid' | 'ParvaneEmailInvalid' | 'ParvaneNickTaken' | 'ParvaneRegisterFailed') => {
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitRegistration' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key } });
    };
    if (!NICK_PATTERN.test(raw) && !/^[^@\s]+@[^@\s]+$/.test(raw)) {
      fail('ParvaneNickInvalid');
      return;
    }
    const user = canonicalAddress(raw, domain);
    const cleanEmail = email.trim().toLowerCase();
    if (emailRequired && !EMAIL_PATTERN.test(cleanEmail)) {
      fail('ParvaneEmailInvalid');
      return;
    }
    pendingLoginAddress = user;
    pendingLoginPassword = password;
    pendingEmail = cleanEmail;
    try {
      const result = await connectionController.registerAccount(user, password, cleanEmail);
      if (result.telegramToken) {
        startTelegramConfirmation(user, password, result.telegramToken);
        return;
      }
      if (result.confirmRequired) {
        sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitCode' });
        return;
      }
      await connectionController.connectAndLogin(user, password);
      saveLoginAddress(user);
      await persistSessionCredential(user, password);
    } catch (err) {
      const message = String(err);
      logDebug(`регистрация отклонена: ${message}`);
      if (message.includes('email')) {
        fail('ParvaneEmailInvalid');
      } else if (message.includes('логин занят')) {
        fail('ParvaneNickTaken');
      } else if (message.includes('некорректный ник') || message.includes('чужой домен')) {
        fail('ParvaneNickInvalid');
      } else {
        fail('ParvaneRegisterFailed');
      }
    }
  },

  // Экран кода (WaitCode): подтверждение почты кодом из письма
  async provideAuthCode(code: string) {
    const user = pendingLoginAddress || readLoginAddress();
    if (!user || !pendingLoginPassword) {
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
      return;
    }
    try {
      await connectionController.confirmEmail(user, code);
      await connectionController.connectAndLogin(user, pendingLoginPassword);
      saveLoginAddress(user);
      await persistSessionCredential(user, pendingLoginPassword);
    } catch (err) {
      logDebug(`код отклонён: ${String(err)}`);
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitCode' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneCodeInvalid' } });
    }
  },

  restartAuth() {
    pendingLoginAddress = '';
    pendingLoginPassword = '';
    pendingEmail = '';
    stopTelegramPolling();
    sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
    return Promise.resolve(undefined);
  },

  // Экран Telegram (WaitQrCode): пользователь нажал Start в боте, но опрос
  // ещё не увидел подтверждения — проверить сразу
  parvaneCheckTelegramConfirmation() {
    return pollTelegramConfirmation(telegramPollGeneration);
  },

  // Контакты: явно добавленные плюс те, с кем есть личная переписка (см.
  // ParvaneStore.isContact). Раньше сюда попадал весь каталог сервера
  async fetchContactList() {
    // Сорвавшийся синк (обрыв WS) не должен оставлять экран контактов без ответа
    await syncController.ensureSynced().catch(() => undefined);
    // Явно добавленные без переписки после reload в сторе не «известны» —
    // регистрируем их и подтягиваем имена, иначе после перезагрузки пропадали
    const explicit = store.getContactLists().added.filter((address) => address !== store.self);
    explicit.forEach((address) => {
      if (!store.getKnownUserAddresses().includes(address)) {
        store.getIdForAddress(address);
        syncController.announcePeer(address);
      }
    });
    const users = Array.from(new Set([...store.getKnownUserAddresses(), ...explicit]))
      .filter((address) => address !== store.self && store.isContact(address))
      .map((address) => store.buildApiUser(address));
    const userStatusesById: Record<string, ApiUserStatus> = {};
    users.forEach((user) => {
      userStatusesById[user.id] = RECENT_STATUS;
    });
    return { users, userStatusesById };
  },

  // «Добавить в контакты» из профиля / «Новый контакт» по нику
  updateContact({ id }: { id: string; firstName?: string; lastName?: string }) {
    const address = store.getAddressForId(id);
    if (!address || address === store.self) return Promise.resolve(undefined);
    addContactAddress(address);
    return Promise.resolve(true);
  },

  async importContact({ phone }: { phone?: string; firstName?: string; lastName?: string }) {
    // tt передаёт «телефон» — у нас это ник или ник@сервер
    const input = (phone || '').trim().replace(/^@/, '').toLowerCase();
    if (!input) return undefined;
    const info = connectionController.getLastServerInfo();
    const address = canonicalAddress(input, info?.domain || '');
    if (address === store.self) return undefined;
    const id = await methods.parvaneResolveExactAddress({ address });
    if (!id) return undefined;
    addContactAddress(address);
    return id;
  },

  deleteContact({ id }: { id: string; accessHash?: string }) {
    const address = store.getAddressForId(id);
    if (!address) return Promise.resolve(undefined);
    store.removeContact(address);
    persistContacts();
    sendUpdate({ '@type': 'deleteContact', id });
    return Promise.resolve(undefined);
  },

  async updateProfile({ firstName, lastName, about }: { firstName?: string; lastName?: string; about?: string }) {
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!connection || !displayName) return undefined;
    // Bio (about) хранится в identity и синхронизируется через resolve.
    const payload: Record<string, unknown> = { token, display_name: displayName };
    if (about !== undefined) payload.bio = about;
    if (!await requestSetName(payload)) return undefined;
    store.setDisplayName(store.self, displayName);
    if (about !== undefined) {
      const prev = store.getProfile(store.self) || {};
      store.setProfile(store.self, { ...prev, bio: about });
    }
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
    return true;
  },

  // Дата рождения: identity.user.setname с текущим именем (display_name
  // обязателен в каждом вызове — иначе сервер не сохраняет ничего). Без года —
  // 0000-MM-DD (конвенция десктопа), сброс — пустая строка
  async updateBirthday(birthday?: ApiBirthday) {
    if (!connection) return undefined;
    const pad = (value: number, size: number) => String(value).padStart(size, '0');
    const iso = birthday ? `${pad(birthday.year || 0, 4)}-${pad(birthday.month, 2)}-${pad(birthday.day, 2)}` : '';
    const payload = { token, birthday: iso };
    if (!await requestSetName(payload, { useCurrentName: true })) return undefined;
    const prev = store.getProfile(store.self) || {};
    store.setProfile(store.self, { ...prev, birthday: iso || undefined });
    return true;
  },

  // Поля профиля без нативных редакторов в Web A: цвет имени (-1 — сброс),
  // личный канал (группа/канал Parvane, '' — убрать), телефон ('' — убрать)
  async parvaneUpdateProfileFields({ nameColor, personalChannelId, phone }: {
    nameColor?: number; personalChannelId?: string; phone?: string;
  }) {
    if (!connection) return undefined;
    const payload: Record<string, unknown> = { token };
    const prev = store.getProfile(store.self) || {};
    const next = { ...prev };
    if (nameColor !== undefined) {
      payload.name_color = nameColor;
      next.nameColor = nameColor >= 0 ? nameColor : undefined;
    }
    if (personalChannelId !== undefined) {
      const groupAddress = personalChannelId ? store.getAddressForId(personalChannelId) : '';
      payload.personal_channel = groupAddress || '';
      next.personalChannel = groupAddress || undefined;
    }
    if (phone !== undefined) {
      payload.phone = phone.trim();
      next.phone = phone.trim() || undefined;
    }
    if (!await requestSetName(payload, { useCurrentName: true })) return undefined;
    store.setProfile(store.self, next);
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    const full = await methods.fetchFullUser({ id: user.id });
    if (full) sendUpdate({ '@type': 'updateUserFullInfo', id: user.id, fullInfo: full.fullInfo });
    return true;
  },

  async uploadProfilePhoto(file: File) {
    if (!connection) return undefined;
    const { fileId } = await mediaService.uploadBlob(
      file,
      file.name || 'avatar.jpg',
      file.type || 'image/jpeg',
      { publicAccess: true },
    );
    await connection.request(TOPIC_IDENTITY_SETAVATAR, JSON.stringify({ token, file_id: fileId }));
    store.setAvatar(store.self, fileId);
    mediaService.cacheBlob(fileId, file, file.type || 'image/jpeg');
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
    return { photo: buildAvatarPhoto(fileId) };
  },

  // tt зовёт это при каждом открытии Edit profile и ждёт `updateCurrentUser`
  // с полной информацией: раньше провайдер молчал, и после перезагрузки форма
  // показывала пустые bio/дату рождения/канал (сохранение затёрло бы их)
  async fetchCurrentUser() {
    if (!store.self) return undefined;
    const user = store.buildApiUser(store.self);
    const full = await methods.fetchFullUser({ id: user.id });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: full?.fullInfo || {} });
    return undefined;
  },

  // Профиль: bio, дата рождения, личный канал, телефон, цвет имени хранятся в
  // identity (resolve); username — локальная часть адреса, не редактируется
  fetchFullUser({ id }: { id: string }) {
    const address = store.getAddressForId(id);
    if (!address) return Promise.resolve(undefined);
    // Отдаём кэш сразу, но заодно перечитываем identity: без этого открытый
    // профиль показывал старые поля до перезагрузки или входящего сообщения —
    // resolve сам разошлёт updateUser/updateUserFullInfo, если что-то менялось
    // (SC-011)
    if (address !== store.self) void syncController.resolveDisplayNames([address]).catch(() => undefined);
    const user = store.buildApiUser(address);
    const isBlocked = localState.loadBlocked().includes(address);
    // `loadFullUser` без guard'ов читает `users`/`chats`/`userStatusesById` —
    // отдаём полную форму ответа, иначе TypeError в экшене
    const profile = store.getProfile(address);
    const birthday = (() => {
      const iso = profile?.birthday;
      if (!iso) return undefined;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      if (!m) return undefined;
      // 0000 — дата без года (десктоп пишет так)
      return { year: Number(m[1]) || undefined, month: Number(m[2]), day: Number(m[3]) };
    })();
    return Promise.resolve({
      user,
      fullInfo: {
        isBlocked,
        commonChatsCount: 0,
        bio: profile?.bio || undefined,
        birthday,
        // personal_channel — group_id группы Parvane; tt ждёт id чата
        personalChannelId: profile?.personalChannel
          ? store.getIdForAddress(profile.personalChannel, 'group')
          : undefined,
      },
      users: [user],
      // Секция личного канала рисуется только когда сам чат есть в сторе
      // (ChatExtra → selectChat). Отдаём его, если группа клиенту известна;
      // если наблюдатель в ней не состоит, канал остаётся невидимым — без
      // серверной выдачи чужих групп иначе никак (отмечено в матрице)
      chats: (() => {
        const channelAddress = profile?.personalChannel;
        const info = channelAddress ? store.getGroupInfo(channelAddress) : undefined;
        return info ? [store.buildApiChatForGroup(info)] : [];
      })(),
      userStatusesById: { [user.id]: RECENT_STATUS },
    });
  },

  updateIsOnline() {
    return Promise.resolve(undefined);
  },

  async destroy(noSessionClear?: boolean) {
    const user = store.self || pendingLoginAddress || readLoginAddress();
    const currentE2e = connectionController.shutdown();
    mediaService.clearCache();
    // Стор прежнего аккаунта не должен отвечать на запросы между logout и
    // следующим входом
    store = new ParvaneStore();
    messageController.reset();
    localState.reset();
    polls.reset();
    if (!noSessionClear) {
      clearLoginStorage();
      if (user) {
        try {
          await currentE2e?.flushStorage();
        } catch {
          // Logout всё равно обязан удалить повреждённое/недоступное хранилище.
        }
        localState.clearUserData(user);
        await E2eEngine.clear(user);
        await clearSecureSession(user).catch(() => undefined);
      }
    }
    return undefined;
  },

  disconnect() {
    return Promise.resolve(undefined);
  },
};

function selfId() {
  return store.getIdForAddress(store.self);
}

function searchLocalMessages(query: string | undefined, chatId?: string): ApiMessage[] {
  const needle = query?.trim().toLowerCase();
  if (!needle) return [];
  const chatIds = chatId ? [chatId] : store.getChatIds();
  return chatIds
    .flatMap((id) => store.getMessages(id))
    .filter((m) => m.content.text?.text.toLowerCase().includes(needle))
    .sort((a, b) => b.date - a.date);
}

function filterMediaMessages(chatId: string, type: string): ApiMessage[] {
  const matches = (message: ApiMessage): boolean => {
    const c = message.content;
    switch (type) {
      case 'media': return Boolean(c.photo || (c.video && !c.video.isRound && !c.video.isGif));
      case 'documents': return Boolean(c.document);
      case 'links': return Boolean(c.text?.text && /https?:\/\//.test(c.text.text));
      case 'voice': return Boolean(c.voice || (c.video && c.video.isRound));
      case 'audio': return Boolean(c.audio);
      case 'gif': return Boolean(c.video?.isGif);
      default: return false;
    }
  };
  return store.getMessages(chatId).filter(matches).sort((a, b) => b.date - a.date);
}

function buildSearchResults(messages: ApiMessage[]) {
  return {
    messages,
    topics: [],
    userStatusesById: {},
    totalCount: messages.length,
  };
}

function collectUsersFor(messages: ApiMessage[]): ApiUser[] {
  const ids = new Set<string>();
  messages.forEach((m) => m.senderId && ids.add(m.senderId));
  return Array.from(ids)
    .map((id) => store.getAddressForId(id))
    .filter(Boolean)
    .map((address) => store.buildApiUser(address));
}

function sendUpdate(update: ApiUpdate) {
  // Как в апстрим Telegram: lastMessageId/lastMessage выставляет САМ reducer
  // newMessage (updateChatLastMessage) в правильном порядке — уже ПОСЛЕ
  // updateListedAndViewportIds, которое добавляет сообщение в окно, пока
  // isViewportNewest ещё истинно. Раньше мы слали отдельный updateThreadInfo с
  // lastMessageId — он гонил reducer: если lastMessageId поднимался до/вместо
  // штатного порядка, selectIsViewportNewest становился false и новое сообщение
  // не попадало в загруженное окно (стрелка ↓, «сообщение не появляется»).
  // Отдаём всё reducer'у — поведение 1:1 с Telegram.
  diagLog(`upd:${update['@type']}`, update);
  onUpdate(update);
}

// Пароль из login-link живёт только в памяти до первого connectAndLogin.
// Фрагмент удаляется из адресной строки до запуска UI.
function captureCredentialsFromHash() {
  const { hash } = window.location;
  if (!hash.startsWith(LOGIN_HASH_PREFIX)) return undefined;
  let credentials;
  try {
    credentials = parseLoginCredentials(decodeURIComponent(hash.slice(LOGIN_HASH_PREFIX.length)));
  } catch {
    credentials = undefined;
  }
  window.history.replaceState(undefined, '', window.location.pathname);
  return credentials;
}

function consumeStartupCredentials() {
  const hashCredentials = captureCredentialsFromHash();
  const legacyCredentials = consumeLegacyCredentials();
  return hashCredentials || legacyCredentials;
}

// ── интерфейс connector'а ────────────────────────────────────────────────────

export function callApi<T extends keyof Methods>(fnName: T, ...args: MethodArgs<T>): MethodResponse<T> {
  const method = (methods as Record<string, AnyFunction>)[fnName as string];
  if (!method) {
    // parvaneDiag: пропуск метода виден в журнале — по нему сценарий обхода
    // UI ловит действия, которые молча ничего не делают
    diagLog('api-missing', String(fnName));
    if (!reportedMissingMethods.has(fnName)) {
      reportedMissingMethods.add(fnName);
      // eslint-disable-next-line no-console
      console.debug(`[parvane] метод не реализован: ${String(fnName)}`);
    }
    return Promise.resolve(undefined) as MethodResponse<T>;
  }
  // parvaneDiag: журналим вызов провайдера (без содержимого) и его ошибку
  diagLog(`api:${String(fnName)}`, args[0]);
  const result = method(...args) as MethodResponse<T>;
  if (result && typeof (result as Promise<unknown>).catch === 'function') {
    (result as Promise<unknown>).catch((error: unknown) => {
      diagLog('api-err', `${String(fnName)}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return result;
}

export const callApiLocal = callApi;

export function cancelApiProgress(progressCallback: ApiOnProgress) {
  progressCallback.isCanceled = true;
}

// Мультитаб-мост и localDb — атрибуты MTProto-воркера, в Parvane не нужны
export function cancelApiProgressMaster(_messageId: string) {}

export function handleMethodCallback(_data: unknown) {}

export function handleMethodResponse(_data: unknown) {}

export function updateFullLocalDb(_initial: unknown) {}

export function updateLocalDb(_name: unknown, _prop?: unknown, _value?: unknown) {}

export function setShouldEnableDebugLog(_value: boolean) {
  return Promise.resolve(undefined);
}
