// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type { ExportSnapshot, ExportSourceChat } from '../../components/parvane/export/exportModel';
import type { PlannerReminder } from '../../components/parvane/planner/plannerReminders';
import type { SendMessageParams, ThreadReadState } from '../../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type {
  ApiAppConfig,
  ApiAvailableReaction,
  ApiBirthday,
  ApiChat, ApiConfig, ApiDraft, ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiPeer,
  ApiPhoto,
  ApiReaction,
  ApiSession,
  ApiSticker, ApiStickerSet, ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  ApiWallpaper,
  OnApiUpdate } from '../types';
import type { ServerInfo } from './connectionController';
import type { GatewayConnection } from './gateway';
import type { PackFile, StoredPack } from './stickerPacks';
import type { WireStoredMessage, WireUserInfo } from './wire';
import { ApiMessageEntityTypes, MAIN_THREAD_ID } from '../types';

import {
  ARCHIVED_FOLDER_ID, MUTE_INDEFINITE_TIMESTAMP, PARVANE_LEGACY_APP_VERSION, UNMUTE_TIMESTAMP,
} from '../../config';
import { getLangStringByKey, getTranslationFn } from '../../util/localization';
import { diagLog } from '../../util/parvaneDiag';
import { clearWorkerReminders, markWorkerReminderShown, saveWorkerReminders } from '../../util/reminderStore';
import { DEFAULT_APP_CONFIG } from '../../limits';
import { bytesToBase64 } from './v2/base64';
import {
  createV2Controller, isV2GroupAddress, type KeyJoinOutcome, type V2DeviceBackup,
} from './v2/controller';
import { loadProtocol } from './v2/engine';
import { digestHex, type KeyBundleHistory, pickRecoveryKey } from './v2/keyBundle';
import { collectV2History, parseLinkCloudKeys, parseLinkPlannerKeys, parseV2History } from './v2/linkHistory';
import { createMessageIndex } from './v2/messageIndex';
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
import { createCloudDrive } from './cloudDrive';
import {
  AccountDeletionPendingError, canonicalAddress, createConnectionController, TwoFactorRequiredError,
} from './connectionController';
import { fingerprintOf } from './fingerprint';
import { getGatewayUrl, getV2Bridge } from './gateway';
import { buildBuiltinGifs, BUILTIN_GIF_TAGS } from './gifs';
import { createGroupController } from './groups';
import { exportEncryptedBackup, importEncryptedBackup } from './keyBackup';
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
import { createReminderScheduler } from './reminders';
import {
  clearSecureSession, hasStoragePin, isStorageUnlocked, loadSecureSession, lockStorage, migrateStorageUser,
  saveSecureSession,
  SecureE2eStorage, setStoragePin, unlockStorageWithPin,
} from './secureStorage';
import {
  buildApiCustomEmojiSetFromPack,
  buildApiStickerSetFromPack,
  findInstalledPackBySetId,
  getAliasEmojiSticker,
  getEmojiPackNames,
  getEmojiPackRawName,
  getEmojiSetIdForDocId,
  getPackFileMime,
  getPackSetId,
  getPackSetIdOfStickerId,
  getPendingFiles,
  getReceivedEmojiPackSetIds,
  getReceivedPackRef,
  isCustomPackSetId,
  isEmojiPackSetId,
  loadInstalledPacks,
  packContentHash,
  parsePvpkArchive,
  removeInstalledPack,
  resetPackRegistries,
  resolveSetIdByShortName,
  sanitizePackName,
  saveInstalledPack,
  setPendingFiles,
} from './stickerPacks';
import {
  buildBuiltinCustomEmojiSet,
  getBuiltinLegacyEmojiIds,
  getBuiltinStickerSet,
  getStickerBlobMime,
  isBuiltinStickerId,
  renderBuiltinStickerBlob,
} from './stickers';
import {
  buildReactorsList, compareStoredOrder, ParvaneStore, setTaskOfferResolver,
} from './store';
import {
  type GifSearchSource, hasEmojiNameData, searchGifSources, searchStickerSets, setEmojiNameData,
  type StickerSearchSource, wordsOfFileName,
} from './symbolSearch';
import { createSyncController } from './sync';
import { TaskOfferStore } from './taskOffers';
import { createTranslation } from './translation';
import { buildThumbnailDataUri, renderBackgroundBlob, UPLOADED_SLUG_PREFIX } from './wallpapers';
import {
  newMessageId,
  TOPIC_DEVICE_LIST,
  TOPIC_DEVICE_REVOKE,
  TOPIC_IDENTITY_PASSWORD_CHANGE,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_IDENTITY_SEARCH,
  TOPIC_IDENTITY_SETAVATAR,
  TOPIC_IDENTITY_SETNAME,
  TOPIC_IDENTITY_TWOFA,
  TOPIC_LINK_CHALLENGE,
  TOPIC_LINK_GRANT,
  TOPIC_LINK_OFFER,
  TOPIC_LINK_POLL,
  TOPIC_PUSH_VAPID_GET,
} from './wire';

const LOGIN_HASH_PREFIX = '#parvane=';
// Свой фон чата — в шифрованном хранилище, а не открытым блобом в Cache Storage
const PLANNER_RECORD = 'planner';
// Подключение контейнера планировщика запускается один раз за сессию (spec 010)
let plannerEnsureStarted = false;

// Снимок «Плана» для запуска без сети: показывается, пока движок не поднялся (на медленной сети движок ждёт
// сервер, без сети не поднимается вовсе), в шифрованном хранилище устройства
const PLANNER_VIEW_RECORD = 'planner-view';
const PLANNER_VIEW_SAVE_DELAY_MS = 2000;
let plannerViewSaved: string | undefined;
let plannerViewTimer: ReturnType<typeof setTimeout> | undefined;
let plannerViewLogged = false;

function rememberPlannerView(json: string) {
  if (json === plannerViewSaved) return;
  plannerViewSaved = json;
  if (plannerViewTimer) clearTimeout(plannerViewTimer);
  plannerViewTimer = setTimeout(async () => {
    plannerViewTimer = undefined;
    const self = store.self;
    if (!self) return;
    const storage = await SecureE2eStorage.open(self).catch(() => undefined);
    await storage?.saveRecord(PLANNER_VIEW_RECORD, plannerViewSaved).then(() => {
      if (!plannerViewLogged) logDebug('планировщик: снимок для запуска без сети сохранён');
      plannerViewLogged = true;
    }).catch((err: unknown) => {
      logDebug(`планировщик: снимок для запуска без сети не сохранён: ${String(err)}`);
    });
  }, PLANNER_VIEW_SAVE_DELAY_MS);
}

function readPlannerState() {
  const { planner } = v2Controller;
  const status = planner.status();
  // Подключение и опрос — один раз; дальше синк идёт по таймеру модуля (8 с),
  // иначе опрос состояния из UI раз в секунду даёт шторм запросов (RATE_LIMITED)
  if (status !== 'needs-linking' && status !== 'loading' && !plannerEnsureStarted) {
    plannerEnsureStarted = true;
    void planner.ensure();
  }
  const json = planner.stateJson();
  // Размер и ревизия — из того же JSON: отдельный `plannerSize()` движка — ещё одна
  // полная protobuf-копия состояния. `raw` — та же строка: по ней экран
  // пропускает равные состояния, не разбирая их заново
  const state = json ? JSON.parse(json) as { sizeBytes?: number; headSeq?: number } : undefined;
  const hasPending = planner.hasPending();
  if (json && status === 'ready' && !hasPending) rememberPlannerView(json);
  return {
    status,
    state: state as unknown,
    sizeBytes: state?.sizeBytes ?? 0,
    hasPending,
    error: planner.lastError(),
    raw: json,
    revision: state?.headSeq,
  };
}
const BACKGROUND_RECORD_PREFIX = 'background:';
// Последняя своя картинка — отдельной копией: выбор встроенного фона перезаписывает запись темы, а плитка
// «Свои» должна остаться и после перезагрузки
const OWN_BACKGROUND_RECORD = `${BACKGROUND_RECORD_PREFIX}own`;
const builtinBackgroundRequests = new Map<string, number>();
let builtinBackgroundQueue: Promise<unknown> = Promise.resolve();

async function storeChatBackground(theme: string, bytes: ArrayBuffer, mimeType: string, slug?: string) {
  if (!store.self) return { status: 'not-ready' as const };
  const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
  if (!storage) return { status: 'not-ready' as const };
  const names = [`${BACKGROUND_RECORD_PREFIX}${theme}`];
  if (slug?.startsWith(UPLOADED_SLUG_PREFIX)) names.push(OWN_BACKGROUND_RECORD);
  for (const name of names) {
    await storage.saveBytesRecord(name, new Uint8Array(bytes));
    await storage.saveRecord(`${name}:mime`, mimeType);
    await storage.saveRecord(`${name}:slug`, slug || '');
  }
  return { status: 'ok' as const };
}

async function buildUploadedWallpaper(slug: string, blob: Blob, fileName: string): Promise<ApiWallpaper> {
  const dataUri = await buildThumbnailDataUri(blob);
  return {
    slug,
    document: {
      mediaType: 'document',
      id: slug,
      fileName,
      mimeType: blob.type || 'image/jpeg',
      size: blob.size,
      thumbnail: dataUri ? { dataUri, width: 32, height: 32 } : undefined,
    },
  };
}
const PARVANE_APP_CONFIG: ApiAppConfig = { ...DEFAULT_APP_CONFIG, hash: 1 };
// Быстрая реакция, пока пользователь её не выбирал (как у Telegram)
const DEFAULT_QUICK_REACTION: ApiReaction = { type: 'emoji', emoticon: '👍' };
// Срок ответа fetchConfig: tt перечитывает его по таймеру (меньше суток — без переполнения setTimeout)
const CONFIG_TTL_SECS = 3600;
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
// Режим L2 (spec 025): вложения до этого размера качаются при получении
const L2_PREFETCH_MAX_BYTES = 32 * 1024 * 1024;
// Полный выход: запись «устройство вышло» в журнал — сетевой шаг; стирание на устройстве его дольше не ждёт
const LEAVE_TIMEOUT_MS = 5000;
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

// WEB-14: «звонки только через сервер» — настройка устройства (свой транспорт), на сервер не уходит;
// «nobody» — прямых соединений нет ни с кем
function callsRelayKey(user: string) {
  return `parvane:calls_p2p:${user}`;
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
    localStorage.setItem(groupAddPolicyKey(store.self), remote.groupAdd);
    localStorage.setItem(strangersPolicyKey(store.self), remote.strangers ? 'anyone' : 'nobody');
    writeAudience(callsPolicyKey(store.self), remote.callsFrom);
    writeAudience(presencePolicyKey(store.self), remote.presence);
  } catch (err) {
    logDebug(`v2: приватность не прочитана: ${String(err)}`);
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
// Полный адрес пользователя: ник и домен сервера (в том числе другого — spec 028)
const FULL_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}@[a-z0-9][a-z0-9.-]{0,126}$/;

// Причины отказа смены пароля: формулировки моста v2 (`bridgeErrorText`) → ключи словаря
const PASSWORD_CHANGE_REASONS: Record<string, string> = {
  'неверный пароль': 'ParvaneChangePasswordWrong',
  'пароль короче 8 символов': 'ParvaneChangePasswordShort',
  'новый пароль совпадает со старым': 'ParvaneChangePasswordSame',
  'слишком много попыток, попробуйте позже': 'ParvaneTryLater',
  'сервер временно недоступен': 'ParvaneServerUnavailable',
};

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
let isCallIdentityReady = false;
const polls = new PollStore();
const taskOffers = new TaskOfferStore();
setTaskOfferResolver((uuid) => taskOffers.build(uuid));

const reportedMissingMethods = new Set<string>();

// Инициализируется после syncController: оба сервиса связаны только callback-ами.
// eslint-disable-next-line prefer-const
let messageController: ReturnType<typeof createMessageController>;

function refreshPollMessageFromSync(uuid: string) {
  messageController.refreshPollMessage(uuid);
}

polls.setExpireHandler(refreshPollMessageFromSync);

function refreshTaskOfferMessageFromSync(uuid: string) {
  messageController.refreshTaskOfferMessage(uuid);
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
  restoreLocalBlob: (fileId) => restoreStickerBlob(fileId),
});

const localState = createLocalState({
  getStore: () => store,
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
  getStore: () => store,
  getToken: () => token,
  isIdentityReady: () => isCallIdentityReady,
  // «Звонки — никто» (FR-040): входящий отклоняется так же, как от заблокированного
  isBlocked: (address) => localState.isBlocked(address) || readAudience(callsPolicyKey(store.self)) === 'nobody',
  isRelayOnly: () => readAudience(callsRelayKey(store.self)) === 'nobody',
  sendUpdate,
  pushReadState: (chatId) => syncController.pushReadState(chatId),
  // v2Controller создаётся ниже; вызывается только во время звонка
  sendV2Signal: (to, signal, groupCallId) => v2Controller.trySendCall(to, signal, groupCallId),
  sendV2OwnSignal: (signal) => v2Controller.trySendCallOwn(signal),
  isV2Peer: (peer) => v2Controller.isV2Peer(peer).catch(() => false),
  recordV2Call: (record) => stateJournal.recordCall(record),
  log: logDebug,
});

// Forward-ref: присутствие собеседников слушает connectionController, который
// создаётся ниже. Устанавливается после его создания
let subscribePresence: (peerId: string) => void = () => {};

const groupController = createGroupController({
  getConnection: () => connection,
  getStore: () => store,
  selfId,
  sendUpdate,
  log: logDebug,
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

// perf A2: строки истории по uuid — общий индекс конвейера отображения и
// контроллера v2 (цели мутаций без чтения всей истории)
const messageIndex = createMessageIndex({
  loadAll: async () => [
    ...await localState.loadHistoryRecords(),
    ...await localState.readOwnJournal(),
  ],
  loadOne: (uuid) => localState.loadHistoryRecord(uuid),
});

/** Аккаунт собеседника удалён (spec 027): «Удалённый аккаунт» в списке, шапке и профиле */
function markPeerDeleted(address: string) {
  if (!store.markUserDeleted(address)) return;
  logDebug('аккаунт собеседника удалён');
  const user = store.buildApiUser(address);
  sendUpdate({ '@type': 'updateUser', id: user.id, user });
}

const syncController = createSyncController({
  getConnection: () => connection,
  checkPeerDeleted: (address) => {
    void v2Controller.checkPeerDeleted(address);
  },
  getStore: () => store,
  getToken: () => token,
  groups: groupController,
  localState,
  media: mediaService,
  polls,
  refreshPollMessage: refreshPollMessageFromSync,
  taskOffers,
  refreshTaskOfferMessage: refreshTaskOfferMessageFromSync,
  rememberSavedGif: rememberSavedGifFromSync,
  rememberStored: messageIndex.set,
  sendUpdate,
  log: logDebug,
});

// Ключ восстановления нового корня v2 (D-12): отдаётся UI ровно один раз
let pendingRecoveryKey: string | undefined;
// Сервер ответил UPGRADE_REQUIRED (v2) — UI показывает диалог при монтировании
let isUpgradeRequired = false;

window.addEventListener('parvane-upgrade-required', () => {
  isUpgradeRequired = true;
  sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneUpgradeRequired' } });
});

// Вход не удался, потому что сервер больше не поддерживает эту версию (T042,
// UPGRADE_REQUIRED уже на канале PRE): на экране пароля — текст про обновление,
// а не «неверный пароль». true — отказ объяснён
function reportUpgradeRequiredAtLogin(): boolean {
  if (!isUpgradeRequired) return false;
  sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
  sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneUpgradeRequired' } });
  return true;
}

// Протокол v2 (spec 007): переписка, группы, звонки, присутствие (T110 —
// единственный стек)
const v2Controller = createV2Controller({
  // Режим L2 (spec 025): вложения до 32 МБ — заранее, при получении; ключи помнит медиа-сервис
  prefetchMedia: (content) => {
    if (!content.file_id || (content.size_bytes || 0) > L2_PREFETCH_MAX_BYTES) return;
    mediaService.rememberKeys(content);
    void mediaService.downloadBlob(content.file_id).catch(() => undefined);
  },
  getToken: () => token,
  getSelf: () => store.self,
  gatewayUrl: getGatewayUrl,
  applyExternal: (stored) => syncController.applyExternal(stored),
  onInviteCreated: (address, record) => stateJournal.recordGroupInvite({ address, record }),
  onInviteRevoked: (linkId) => stateJournal.removeGroupInvite(linkId),
  onRecoveryKey: (recoveryKey) => {
    // Main может быть ещё не смонтирован — ключ ждёт, пока его заберут
    pendingRecoveryKey = recoveryKey;
    window.dispatchEvent(new CustomEvent('parvane-recovery-key'));
  },
  describeDevice: describeThisDevice,
  bundleHistory: (previous, force) => buildBundleHistory(previous, force),
  dropBundleHistory: (replaced) => {
    void mediaService.deleteFile(replaced.fileId).catch(() => undefined);
  },
  onBundleReady: () => {
    void syncFromKeyBundle();
  },
  onAuthRejected: () => {
    // Протухший/отозванный токен (E6-1): снимаем сохранённую сессию и
    // перезагружаемся — запуск без токена спрашивает пароль (ключи и история
    // остаются)
    const self = store.self;
    logDebug('v2: токен не принят сервером — нужен повторный вход');
    void clearSecureSession(self).catch(() => undefined).then(() => window.location.reload());
  },
  onUpgradeRequired: () => {
    // Как и ключ восстановления — Main мог ещё не смонтироваться
    isUpgradeRequired = true;
    window.dispatchEvent(new CustomEvent('parvane-upgrade-required'));
  },
  onOwnDevicesChanged: () => {
    window.dispatchEvent(new CustomEvent('parvane-devices-changed'));
  },
  onNewOwnDevices: (deviceIds) => {
    window.dispatchEvent(new CustomEvent('parvane-new-device', { detail: { count: deviceIds.length } }));
    // Новому устройству — свежий снимок истории в копии ключей аккаунта (spec 015)
    void v2Controller.refreshKeyBundle(true);
  },
  // Журнал устройств v2 у аккаунта есть, а этого устройства в нём нет: оффер
  // линковки нужен, даже если история на устройстве уже есть
  onJoined: () => {
    void completeJoinFromBundle().catch((err: unknown) => logDebug(`вход: копия ключей не применена: ${String(err)}`));
  },
  onNeedsLinking: () => {
    if (!linkRuntime.timer) void startHistoryLinkOffer();
    // Бот спросит у владельца ключ восстановления в Telegram (spec 015)
    void startTelegramRecovery(false);
    // Экран «Устройства» покажет код линковки и вход по ключу восстановления
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-needs-linking'));
  },
  onGroupUpdated: (info, isNew) => groupController.applyV2Group(info, isNew),
  onGroupLeft: (address) => groupController.removeV2Group(address),
  onUnconfirmedMembers: (address, members) => groupController.announceUnconfirmed(address, members),
  // Планировщик на сервере (spec 010): контейнер объявляется в журнале состояния
  plannerContainerFromState: () => stateJournal.plannerContainer(),
  recordPlannerContainer: (ref) => stateJournal.recordPlannerContainer(ref),
  onPlannerChanged: () => {
    reminderScheduler.onPlannerChanged();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-planner-changed'));
  },
  // Облако (spec 016): контейнеры объявляются в журнале состояния
  cloudEntriesFromState: () => stateJournal.cloudEntries(),
  recordCloudEntry: (entry) => stateJournal.recordCloudEntry(entry),
  onCloudChanged: () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('parvane-cloud-changed'));
  },
  onStateReady: (host, rekey) => {
    void refreshV2Privacy();
    // Устройство, привязанное после входа, готово только теперь — напоминания запускаются и здесь
    startReminders();
    return stateJournal.attach(host, rekey);
  },
  onL2Changed: (address) => applyL2Change(address),
  onCallSignal: (from, signal, groupCallId, device) => callController.handleV2Signal(from, signal, groupCallId, device),
  // KEY-1 v2: корень личности собеседника сменился — то же служебное
  // сообщение, что при смене ключа устройства в v1
  onPeerRootChanged: (user) => syncController.announceKeyChange(user),
  onPeerRenamed: (oldAddress, newAddress) => {
    if (!store.registerUserRename(oldAddress, newAddress)) return;
    localState.saveRename(oldAddress, newAddress);
    syncController.announceRename(oldAddress, newAddress);
  },
  onPeerDeleted: (user) => markPeerDeleted(user),
  onSskRotationNeeded: () => {
    window.dispatchEvent(new CustomEvent('parvane-ssk-rotation'));
  },
  onTyping: (chat, from) => connectionController.showV2Typing(chat, from),
  onPresence: (from) => connectionController.showV2Presence(from),
  recordOwn: (stored) => localState.appendOwnJournal({ ...stored, origin: 'v2' }),
  loadHistory: async () => [
    ...await localState.loadHistoryRecords(),
    ...await localState.readOwnJournal(),
  ],
  index: messageIndex,
  log: logDebug,
});
// ID-01: вход привязанного устройства несёт доказательство его ключа
getV2Bridge().setSessionProof(v2Controller.sessionProof);

messageController = createMessageController({
  v2: v2Controller,
  recordChatCleared: (address, untilMs) => stateJournal.recordChatCleared(address, untilMs),
  getConnection: () => connection,
  getStore: () => store,
  getToken: () => token,
  localState,
  media: mediaService,
  polls,
  taskOffers,
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
  getStore: () => store,
  setStore: (nextStore) => {
    store = nextStore;
    // P-18: presence — по конкретным собеседникам, подписка при появлении адреса
    store.onUserRegistered = (peerId) => subscribePresence(peerId);
    store.getLangString = getLangStringByKey;
    // Смена ника (spec 026): прежние адреса ведут в прежние чаты
    for (const [from, to] of localState.loadRenames()) store.registerUserRename(from, to);
  },
  unlockStorage: (user) => ensureStorageUnlocked(user),
  describeDevice: describeThisDevice,
  wipeDevice: async (user) => {
    localState.clearUserData(user);
    // Отложенная запись состояния движка (perf A1) не должна лечь поверх стирания
    await v2Controller.settleState().catch(() => undefined);
    await SecureE2eStorage.clear(user);
    await clearSecureSession(user).catch(() => undefined);
  },
  onAccountRenamed: (oldAddress, newAddress) => moveAccountLocal(oldAddress, newAddress),
  getToken: () => token,
  setToken: (nextToken) => { token = nextToken; },
  setCallIdentityReady: (isReady) => { isCallIdentityReady = isReady; },
  polls,
  taskOffers,
  onNewSession: () => {
    stateJournal.reset();
    v2Controller.reset();
    stopHistoryLink();
    stopTelegramRecovery('idle');
    joinCompletedFor = undefined;
    syncController.reset();
    resetPackRegistries();
    messageController.resetSavedGifs();
    messageController.reset();
    localState.reset();
    store.setContacts(localState.loadContacts(), localState.loadNonContacts());
    polls.reset();
    taskOffers.reset();
  },
  onSessionReady: () => {
    void startHistoryLinkOffer();
    void v2Controller.start().then(registerV2Wake).then(startReminders);
  },
  resetSyncPromise: syncController.resetPromise,
  resolveDisplayNames: syncController.resolveDisplayNames,
  selfId,
  sendUpdate,
  log: logDebug,
  v2: v2Controller,
});

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
  // perf B1: WASM-движок (2,6 МБ) качается и инициализируется параллельно
  // чтению хранилища и входу, а не на первом вызове движка
  void loadProtocol().catch(() => undefined);

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
    if (err instanceof AccountDeletionPendingError) {
      reportDeletionPending(creds.user, creds.password, err.deletionAtMs);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[parvane] логин не удался:', err);
    pendingLoginAddress = creds.user;
    if (reportUpgradeRequiredAtLogin()) return;
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

// spec 027: пауза после удаления аккаунта, чтобы человек прочитал дату, — затем экран входа
const ACCOUNT_DELETE_RELOAD_MS = 4000;

/** spec 027: аккаунт ждёт удаления — экран пароля с датой и кнопкой «Восстановить аккаунт» */
function reportDeletionPending(user: string, password: string, deletionAtMs: number) {
  pendingLoginAddress = user;
  pendingLoginPassword = password;
  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(deletionAtMs));
  sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPassword' });
  sendUpdate({
    '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneAccountDeletionPending', variables: { date } },
  });
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

// Смена ника (spec 026): всё локальное устройства — под новым адресом (localStorage, шифрованное хранилище,
// адрес входа); прежний адрес ведёт в те же чаты (список переносов адресов)
async function moveAccountLocal(oldAddress: string, newAddress: string) {
  await v2Controller.settleState().catch(() => undefined);
  localState.moveUserData(oldAddress, newAddress);
  localState.saveRename(oldAddress, newAddress, newAddress);
  try {
    await migrateStorageUser(oldAddress, newAddress);
  } catch (e) {
    logDebug(`хранилище не перенесено на новый адрес: ${String(e)}`);
  }
  saveLoginAddress(newAddress);
}

// ── методы (подмножество Methods, остальное — заглушки) ──────────────────────

const RECENT_STATUS: ApiUserStatus = { type: 'userStatusRecently' };
const INSTALLED_PACK_DATE = Math.floor(Date.now() / 1000);

function registerPackBlobs(blobs: Map<string, { blob: Blob; mime: string }>) {
  blobs.forEach(({ blob, mime }, id) => mediaService.cacheBlobIfAbsent(id, blob, mime));
}

// Картинка стикера/эмодзи живёт только в кэше медиа (в облаке её нет), а кэш
// под бюджетом памяти: вытесненный блоб возвращаем, заново собрав его набор.
// `undefined` — id не из наших наборов (обычный файл облака)
const restoringStickerSets = new Map<string, Promise<void>>();

function restoreStickerBlob(fileId: string): Promise<void> | undefined {
  // Встроенный стикер рисуется сам по себе — набор целиком не нужен
  const builtin = isBuiltinStickerId(fileId) ? renderBuiltinStickerBlob(fileId) : undefined;
  if (builtin) {
    return builtin.then((blob) => mediaService.cacheBlobIfAbsent(fileId, blob, getStickerBlobMime(fileId)));
  }
  const setId = getPackSetIdOfStickerId(fileId) || getEmojiSetIdForDocId(fileId);
  if (!setId) return undefined;
  // Плитки одного набора просят картинки разом — набор собираем один раз
  let restoring = restoringStickerSets.get(setId);
  if (!restoring) {
    restoring = methods.fetchStickerSet({ stickerSetInfo: { id: setId } })
      .then(() => undefined, (err) => {
        logDebug(`картинка стикера ${fileId}: набор ${setId} не собран — ${String(err)}`);
      })
      .finally(() => restoringStickerSets.delete(setId));
    restoringStickerSets.set(setId, restoring);
  }
  return restoring;
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
  // PACK-2: набор объединён с другими по отпечатку — архив обязан ему соответствовать,
  // иначе отправитель мог бы заявить чужой отпечаток и подменить картинки
  if (ref.content_hash && bytesToBase64(await packContentHash(files)) !== ref.content_hash) {
    logDebug(`пак ${setId}: содержимое архива не совпало с отпечатком — отвергнут`);
    return undefined;
  }
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
// ── Напоминания «Плана» (этап 4 плана 15 окт 2026) ─────────────────────────────
function formatReminderWhen(reminder: PlannerReminder) {
  const langCode = getTranslationFn().code || 'en';
  const startsAt = new Date(reminder.startsAt);
  const isToday = startsAt.toDateString() === new Date().toDateString();
  const parts: string[] = [];
  if (!isToday || !reminder.start) {
    parts.push(new Intl.DateTimeFormat(langCode, { day: 'numeric', month: 'long' }).format(startsAt));
  }
  if (reminder.start) {
    parts.push(new Intl.DateTimeFormat(langCode, { hour: '2-digit', minute: '2-digit' }).format(startsAt));
  }
  return parts.join(', ');
}

function formatReminderMessage(reminder: PlannerReminder) {
  return (getLangStringByKey('PlannerReminderMessage') || '⏰ {title} — {when}')
    .replace('{title}', reminder.title)
    .replace('{when}', formatReminderWhen(reminder));
}

const reminderScheduler = createReminderScheduler({
  stateJson: () => v2Controller.planner.stateJson(),
  isReady: () => v2Controller.planner.status() === 'ready',
  apply: (changes) => v2Controller.planner.apply(changes),
  flush: () => v2Controller.planner.flush(),
  syncNow: () => v2Controller.planner.syncNow(),
  sendToSelf: (text) => messageController.methods.parvaneSendSelfText({ text }),
  ring: (reminder) => {
    const text = formatReminderMessage(reminder);
    window.dispatchEvent(new CustomEvent('parvane-reminder', { detail: { text, key: reminder.key } }));
    if (document.visibilityState === 'visible' || typeof Notification === 'undefined'
      || Notification.permission !== 'granted') return;
    void navigator.serviceWorker?.getRegistration()
      .then((registration) => registration?.showNotification('Parvane', {
        body: text, tag: `reminder:${reminder.key}`,
      }))
      .catch(() => undefined);
  },
  setAlarms: (atMs) => v2Controller.pushSetAlarms(atMs),
  saveForWorker: (items) => saveWorkerReminders(items),
  markShown: (key) => markWorkerReminderShown(key),
  canKeepText: async () => !store.self || !(await hasStoragePin(store.self).catch(() => true)),
  formatMessage: formatReminderMessage,
  log: logDebug,
});

// Напоминаниям нужен «План» и без открытого раздела: контейнер подключается в фоне (опрос — редкий)
function startReminders() {
  if (!v2Controller.isReady()) return;
  void v2Controller.planner.ensure(true).catch(() => undefined);
  reminderScheduler.start();
}

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

// ── Копия ключей аккаунта и ключ восстановления через Telegram (spec 015) ────

// Снимок истории в копии ключей аккаунта — вся расшифрованная история одним
// блобом: небольшой перезаливается, как только изменился (проверка раз в минуту),
// большой — не чаще раза в полчаса (кроме появления нового своего устройства)
const BUNDLE_HISTORY_SMALL_BYTES = 512 * 1024;
const BUNDLE_HISTORY_MIN_MS = 30 * 60 * 1000;
// Новое устройство перечитывает копию: прежнее устройство, увидев его в журнале,
// кладёт туда свежий снимок истории
const BUNDLE_RECHECK_DELAYS_MS = [60 * 1000, 5 * 60 * 1000];
// Вход по ключу сорвался на временной ошибке: столько ждём, пока запись в журнал завершится повтором в фоне
const JOIN_BACKGROUND_WAIT_MS = 60 * 1000;
const BUNDLE_APPLIED_KEY = 'parvane:bundle-history:';
// Опрос ответа владельца из Telegram: первый через 3 с, дальше интервал растёт
// ×1,5 до 30 с (вместо запроса каждые 3 с четверть часа); по истечении
// TELEGRAM_KEY_WAIT_MS опрос останавливается («истекло», можно попросить снова)
const TELEGRAM_KEY_POLL_MS = 3000;
const TELEGRAM_KEY_POLL_MAX_MS = 30000;
const TELEGRAM_KEY_POLL_GROWTH = 1.5;
const TELEGRAM_KEY_WAIT_MS = 15 * 60 * 1000;

type TelegramRecoveryState = 'idle' | 'unavailable' | 'waiting' | 'joining' | 'done' | 'failed' | 'limit' | 'expired';
const telegramRecovery: { state: TelegramRecoveryState; timer?: number; generation: number; startedAt?: number } = {
  state: 'idle', generation: 0,
};

// Человек ответил боту и вернулся в приложение — опрашиваем сразу, а не через растущий интервал (до 30 с; на
// телефоне таймеры свёрнутой вкладки ещё и замирают)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || telegramRecovery.state !== 'waiting') return;
    if (!telegramRecovery.startedAt) return;
    window.clearTimeout(telegramRecovery.timer);
    scheduleTelegramPoll(telegramRecovery.generation, telegramRecovery.startedAt, 0);
  });
}

function readAppliedBundleMark(owner: string) {
  try {
    return localStorage.getItem(BUNDLE_APPLIED_KEY + owner) || undefined;
  } catch {
    return undefined;
  }
}

function rememberAppliedBundleMark(owner: string, mark: string) {
  try {
    localStorage.setItem(BUNDLE_APPLIED_KEY + owner, mark);
  } catch {
    // без localStorage снимок просто применится ещё раз (строки не дублируются)
  }
}

// Устройство с ключом копии: снимок расшифрованной истории — блобом в cloud
// (случайный ключ, координаты — в копии ключей под ключом восстановления)
async function buildBundleHistory(previous: KeyBundleHistory | undefined, force: boolean) {
  const isLarge = (previous?.size || 0) > BUNDLE_HISTORY_SMALL_BYTES;
  if (previous && !force && isLarge && Date.now() - previous.at < BUNDLE_HISTORY_MIN_MS) return previous;
  const owner = store.self;
  await localState.flushHistoryNow();
  const rows = collectV2History(await localState.loadHistoryRecords(), await localState.readOwnJournal());
  if (!rows.length) return previous;
  const exportJson = JSON.stringify({ linkVersion: 2, v2History: rows });
  const mark = await digestHex(exportJson);
  if (previous?.mark === mark) return previous;
  const upload = await mediaService.uploadBlob(
    new Blob([exportJson]), 'account-history', 'application/octet-stream', { encrypt: true },
  );
  if (!upload.mediaKeys || store.self !== owner) return previous;
  rememberAppliedBundleMark(owner, mark);
  logDebug(`копия ключей: снимок истории загружен (${rows.length} строк)`);
  return {
    fileId: upload.fileId,
    fileKey: upload.mediaKeys.keyB64,
    fileNonce: upload.mediaKeys.nonceB64,
    at: Date.now(),
    mark,
    size: exportJson.length,
  };
}

async function applyBundleHistory(history: KeyBundleHistory | undefined, owner: string) {
  if (!history || store.self !== owner || readAppliedBundleMark(owner) === history.mark) return;
  mediaService.rememberKeys({
    kind: 'file', file_id: history.fileId, file_key: history.fileKey, file_nonce: history.fileNonce,
  });
  const media = await mediaService.downloadBlob(history.fileId);
  if (!media) {
    logDebug('копия ключей: снимок истории не скачался из cloud');
    return;
  }
  const rows = parseV2History(await media.blob.text());
  if (store.self !== owner) return;
  // Строки — после ресинка, как при привязке с другого устройства
  await syncController.ensureSynced()
    .catch((err: unknown) => logDebug(`копия ключей: ресинк перед историей не выполнен: ${String(err)}`));
  await applyLinkedV2History(rows, owner);
  rememberAppliedBundleMark(owner, history.mark);
  logDebug(`копия ключей: снимок истории применён (${rows.length} строк)`);
}

const cloudDrive = createCloudDrive({
  log: logDebug,
  self: () => store.self,
  cloud: () => v2Controller.cloud,
  transport: () => v2Controller,
  mediaKeys: (fileId) => {
    const keys = mediaService.getMediaKeys(fileId);
    return keys && { key: keys.keyB64, nonce: keys.nonceB64, capability: mediaService.getCapability(fileId) };
  },
  downloadMedia: async (fileId) => (await mediaService.downloadBlob(fileId))?.blob,
  sendFile: (chatId, file) => messageController.methods.parvaneSendCloudFile({ chatId, file }),
  addressOf: (chatId) => store.getAddressForId(chatId),
});

// Свериться с копией ключей аккаунта на сервере: ключи планировщика и снимок
// истории свежее применённого (его мог положить другое своё устройство)
async function syncFromKeyBundle() {
  const owner = store.self;
  const bundle = await v2Controller.fetchKeyBundle();
  if (!bundle || store.self !== owner) return;
  if (bundle.planner) v2Controller.planner.keysImport(bundle.planner);
  if (bundle.cloud) v2Controller.cloud.keysImport(bundle.cloud);
  await v2Controller.applyBundleGroupsFrom(bundle.groups)
    .catch((err: unknown) => logDebug(`копия ключей: группы не применены: ${String(err)}`));
  await applyBundleHistory(bundle.history, owner)
    .catch((err: unknown) => logDebug(`копия ключей: история не применена: ${String(err)}`));
}

// Устройство вошло в журнал — любым путём (ключ через бота, ключ руками, подтверждение с другого устройства, повтор
// после обрыва): сразу отзываем оффер привязки, отмечаем ключ у бота забранным и забираем из копии ключей аккаунта
// всё — группы, «План», «Облако», историю. Раньше это делал только «успешный» ответ входа по ключу, и при временной
// ошибке (вход доделывался в фоне) группы и «План» приходили через минуты, от другого своего устройства
let joinCompletedFor: string | undefined;

async function completeJoinFromBundle() {
  const owner = store.self;
  window.dispatchEvent(new CustomEvent('parvane-device-joined'));
  void retractLinkOffer();
  if (telegramRecovery.state !== 'idle' && telegramRecovery.state !== 'unavailable') stopTelegramRecovery('done');
  void v2Controller.pollTelegramKey(true);
  if (joinCompletedFor === owner) {
    await v2Controller.ackJoined();
    return;
  }
  const bundle = await v2Controller.fetchKeyBundle();
  if (store.self !== owner) return;
  if (bundle) {
    await v2Controller.applyBundleGroupsFrom(bundle.groups)
      .catch((err: unknown) => logDebug(`копия ключей: группы не применены: ${String(err)}`));
    await completeKeyJoin({
      result: 'ok', planner: bundle.planner, cloud: bundle.cloud, history: bundle.history,
    });
  }
  await v2Controller.ackJoined();
}

// Устройство вошло в журнал по ключу восстановления: ключи планировщика и
// история — из копии ключей аккаунта, без участия других устройств
async function completeKeyJoin(outcome: KeyJoinOutcome) {
  const owner = store.self;
  if (joinCompletedFor === owner) return;
  joinCompletedFor = owner;
  window.dispatchEvent(new CustomEvent('parvane-device-joined'));
  void registerV2Wake();
  if (outcome.planner) v2Controller.planner.keysImport(outcome.planner);
  if (outcome.cloud) v2Controller.cloud.keysImport(outcome.cloud);
  await applyBundleHistory(outcome.history, owner)
    .catch((err: unknown) => logDebug(`копия ключей: история не применена: ${String(err)}`));
  BUNDLE_RECHECK_DELAYS_MS.forEach((delay) => {
    window.setTimeout(() => {
      if (store.self === owner) void syncFromKeyBundle();
    }, delay);
  });
  window.dispatchEvent(new CustomEvent('parvane-devices-changed'));
}

function setTelegramRecoveryState(state: TelegramRecoveryState) {
  telegramRecovery.state = state;
  window.dispatchEvent(new CustomEvent('parvane-telegram-recovery'));
}

function stopTelegramRecovery(state: TelegramRecoveryState) {
  telegramRecovery.generation++;
  window.clearTimeout(telegramRecovery.timer);
  telegramRecovery.timer = undefined;
  setTelegramRecoveryState(state);
}

/** Следующий опрос через `delayMs`; пока ждём ответа — интервал растёт. */
function scheduleTelegramPoll(generation: number, startedAt: number, delayMs: number) {
  telegramRecovery.timer = window.setTimeout(() => {
    telegramRecovery.timer = undefined;
    void pollTelegramRecovery(generation, startedAt).then(() => {
      if (generation !== telegramRecovery.generation || telegramRecovery.state !== 'waiting') return;
      const grown = Math.max(TELEGRAM_KEY_POLL_MS, Math.round(delayMs * TELEGRAM_KEY_POLL_GROWTH));
      const next = Math.min(TELEGRAM_KEY_POLL_MAX_MS, grown);
      scheduleTelegramPoll(generation, startedAt, next);
    });
  }, delayMs);
}

// Новое устройство: бот просит владельца ответить ключом восстановления, ответ
// забираем опросом. `again` — владелец попросил прислать сообщение ещё раз
async function startTelegramRecovery(again: boolean) {
  if (!v2Controller.needsLinking()) return;
  if (telegramRecovery.state === 'joining' || (telegramRecovery.state === 'waiting' && !again)) return;
  stopTelegramRecovery('idle');
  const generation = telegramRecovery.generation;
  const requested = await v2Controller.requestTelegramKey(again);
  if (generation !== telegramRecovery.generation) return;
  if (requested !== 'sent') {
    setTelegramRecoveryState(requested === 'no_telegram' ? 'unavailable' : requested);
    return;
  }
  logDebug('ключ восстановления: бот спросит владельца в Telegram');
  const startedAt = Date.now();
  telegramRecovery.startedAt = startedAt;
  setTelegramRecoveryState('waiting');
  scheduleTelegramPoll(generation, startedAt, TELEGRAM_KEY_POLL_MS);
}

async function pollTelegramRecovery(generation: number, startedAt: number) {
  if (generation !== telegramRecovery.generation || telegramRecovery.state !== 'waiting') return;
  // Устройство привязано другим путём (подтверждение с другого устройства)
  if (!v2Controller.needsLinking()) {
    stopTelegramRecovery('idle');
    return;
  }
  if (Date.now() - startedAt > TELEGRAM_KEY_WAIT_MS) {
    stopTelegramRecovery('expired');
    return;
  }
  const reply = await v2Controller.pollTelegramKey(false);
  if (generation !== telegramRecovery.generation || telegramRecovery.state !== 'waiting' || !reply) return;
  if (!reply.recovery_key) {
    // Сервер запроса не помнит (перезапуск) — просим заново, без нового сообщения
    if (!reply.pending) void v2Controller.requestTelegramKey(false);
    return;
  }
  window.clearTimeout(telegramRecovery.timer);
  telegramRecovery.timer = undefined;
  setTelegramRecoveryState('joining');
  logDebug('ключ восстановления: получен ответ владельца из Telegram');
  const outcome = await v2Controller.joinWithRecoveryKey(reply.recovery_key, true);
  if (outcome.result === 'ok') {
    // Успешный вход завершаем, даже если состояние окна успели сменить (новая сессия, «прислать ещё раз»)
    void v2Controller.pollTelegramKey(true);
    stopTelegramRecovery('done');
    await completeKeyJoin(outcome);
    return;
  }
  if (generation !== telegramRecovery.generation) return;
  // Временная ошибка: запись в журнал повторяется в фоне — «не удалось» показывать рано
  if (outcome.result === 'failed' && await v2Controller.waitJoined(JOIN_BACKGROUND_WAIT_MS)) {
    logDebug('ключ восстановления: вход завершён повтором');
    await completeJoinFromBundle();
    return;
  }
  if (generation !== telegramRecovery.generation) return;
  logDebug(`ключ восстановления: вход не удался (${outcome.result})`);
  setTelegramRecoveryState('failed');
}

// Устройство каталога: `label` и `login_at` — как оно назвало себя при входе
type DeviceRow = { device_id: string; updated_at: number; label?: string; login_at?: number };

// Подпись этого устройства для экрана «Устройства» у владельца аккаунта
function describeThisDevice() {
  return `${detectBrowserName()}, ${detectPlatformName()}`;
}

function buildDeviceSession(device: DeviceRow, currentDeviceId: string): ApiSession {
  const isCurrent = device.device_id === currentDeviceId;
  // «Firefox, Linux» → модель и платформа; устройства прежних версий себя не называли
  const [labelModel, labelPlatform] = (device.label || '').split(',').map((part) => part.trim());
  const deviceModel = isCurrent
    ? detectBrowserName()
    : (labelModel || (device.device_id ? `Web ${device.device_id.slice(0, 8)}` : 'Desktop'));
  return {
    hash: device.device_id,
    isCurrent,
    isOfficialApp: true,
    isPasswordPending: false,
    deviceModel,
    platform: isCurrent ? detectPlatformName() : (labelPlatform || ''),
    systemVersion: '',
    appName: 'Parvane',
    appVersion: '',
    dateCreated: device.login_at || device.updated_at,
    dateActive: device.login_at || device.updated_at,
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

// ── Авто-линковка устройства ────────────────────────────────────────────────
// Новое устройство (не записано в журнал устройств v2) после логина публикует
// оффер с эфемерным ECDH-ключом и опрашивает грант; старое устройство в
// Settings → Devices показывает запрос с SAS-кодом, подтверждение выгружает
// шифрованный экспорт истории v2-эпохи и грант движка в cloud и передаёт
// ECDH-бокс с координатами. Новое устройство вступает в журнал по гранту
// (joinV2WithLinkGrant) и применяет историю (applyLinkedV2History)

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

// Устройство вошло в журнал: оффер привязки отзываем сразу, а не на следующем опросе — иначе другие устройства
// успевают показать запрос привязки уже вошедшего устройства
async function retractLinkOffer() {
  const activeConnection = connection;
  const hadOffer = Boolean(linkRuntime.timer || linkRuntime.commitment);
  stopHistoryLink();
  if (!activeConnection || !hadOffer) return;
  try {
    await activeConnection.request(TOPIC_LINK_OFFER, JSON.stringify({ token, device_id: ownDeviceId(), revoke: true }));
  } catch {
    // сервер вычистит по TTL
  }
}

// Новое устройство (протокол v2, P-03/P-48): публикуем ОБЯЗАТЕЛЬСТВО на
// эфемерный ключ и свой signing-ключ; сам ключ раскрываем только после
// challenge старого устройства, SAS — от обоих ключей. Опрос до гранта или
// истечения срока.
// Id этого устройства: из сессии v2 (claim JWT), до её подъёма — из зеркала localStorage
function ownDeviceId() {
  return v2Controller.deviceId() || connectionController.currentDeviceId(store.self);
}

// Оффер нужен, пока устройство не записано в журнал устройств v2
async function startHistoryLinkOffer() {
  stopHistoryLink();
  if (!connection || !v2Controller.needsLinking()) return;
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
      token, device_id: ownDeviceId(), commitment,
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
  const activeConnection = connection;
  const keyPair = linkRuntime.keyPair;
  const ephPub = linkRuntime.ephPub;
  const commitment = linkRuntime.commitment;
  if (!activeConnection || !keyPair || !ephPub || !commitment) return;
  // Устройство попало в журнал другим путём (ключ восстановления) — отзываем
  // оффер, чтобы другие устройства не видели висящий запрос
  if (!v2Controller.needsLinking()) {
    stopHistoryLink();
    try {
      await activeConnection.request(TOPIC_LINK_OFFER, JSON.stringify({
        token, device_id: ownDeviceId(), revoke: true,
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
      token, device_id: ownDeviceId(),
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
        token, device_id: ownDeviceId(), eph_pub: ephPub, commitment,
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
  let plannerKeys: string | undefined;
  let cloudKeys: string | undefined;
  try {
    const exportText = await media.blob.text();
    v2History = parseV2History(exportText);
    plannerKeys = parseLinkPlannerKeys(exportText);
    cloudKeys = parseLinkCloudKeys(exportText);
  } catch (err) {
    logDebug(`линковка: экспорт не прочитан: ${String(err)}`);
    return;
  }
  logDebug(`линковка: экспорт получен (${v2History.length} строк истории)`);
  await joinV2WithLinkGrant(boxPayload.v2);
  // spec 010: ключи контейнера планировщика старого устройства
  if (plannerKeys) v2Controller.planner.keysImport(plannerKeys);
  // spec 016: ключи контейнеров облака старого устройства
  if (cloudKeys) v2Controller.cloud.keysImport(cloudKeys);
  // Строки истории — после полного ресинка, а не вперемешку с ним: применённая
  // посреди ресинка строка (замечено на своих исходящих) временами не доходила до UI
  await syncController.ensureSynced()
    .catch((err: unknown) => logDebug(`линковка: ресинк перед историей v2 не выполнен: ${String(err)}`));
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
  if (!coords) return;
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

// Отзыв устройства: пароль проверяет мост (identity.device.revoke), сам отзыв —
// запись журнала устройств v2 и ротации ключей (T128)
// `shouldRotateKeys` — «устройство потеряно или украдено»: отзыв со сменой ключей, которые оно держало (для новых
// устройств потом нужен ключ восстановления). Иначе обычный выход: ключи прежние
async function revokeOwnDevice(deviceId: string, password?: string, shouldRotateKeys?: boolean) {
  if (!connection) return undefined;
  try {
    // P-07: отзыв устройства требует текущий пароль. P-39: сохранённого
    // пароля нет — только введённый пользователем
    const raw = await connection.request(TOPIC_DEVICE_REVOKE, JSON.stringify({
      token, device_id: deviceId, password,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    // Протокол v2 (T128, FR-066): запись отзыва в журнале устройств и ротации
    // ключей, которые устройство держало (пароль проверил мост выше)
    const revoke = shouldRotateKeys ? v2Controller.revokeDevice : v2Controller.signOutDevice;
    const isJournaled = await revoke(deviceId).catch((e: unknown) => {
      logDebug(`v2: отзыв устройства в журнале не выполнен: ${String(e)}`);
      return false;
    });
    // Отзыв — это запись журнала устройств: мост отвечает «ok» уже после проверки
    // пароля. Записи нет (это устройство само не привязано к журналу либо сервер
    // её не принял) — отзыва не было, об успехе не сообщаем: иначе сеанс
    // «завершён» на экране, а устройство продолжает работать
    return isJournaled ? true : undefined;
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

// Перевод на устройстве (spec 024): текст сообщения не покидает браузер
const translation = createTranslation({
  getText: (chatId, messageId) => store.getMessage(chatId, messageId)?.content.text?.text,
  sendUpdate: (update) => sendUpdate(update as ApiUpdate),
  log: logDebug,
});

const methods = {
  // Языковые пакеты из сборки (fallback.strings / ru.strings)
  ...langPackMethods,

  fetchAppConfig({ hash }: { hash?: number }) {
    return Promise.resolve(hash === PARVANE_APP_CONFIG.hash ? undefined : PARVANE_APP_CONFIG);
  },

  fetchAvailableReactions() {
    return Promise.resolve(BUILTIN_REACTIONS);
  },

  // Из настроек сервера Telegram у нас есть только быстрая реакция (журнал личного
  // состояния); нулевые пределы tt читает как «без предела», как без config
  fetchConfig() {
    const quick = localState.loadQuickReaction();
    const defaultReaction: ApiReaction = quick?.documentId
      ? { type: 'custom', documentId: quick.documentId }
      : quick?.emoji ? { type: 'emoji', emoticon: quick.emoji } : DEFAULT_QUICK_REACTION;
    return Promise.resolve({
      expiresAt: Math.floor(Date.now() / 1000) + CONFIG_TTL_SECS,
      defaultReaction,
      maxGroupSize: 0,
      maxMessageLength: 0,
      editTimeLimit: 0,
      maxForwardedCount: 0,
      ratingEDecay: 0,
    } satisfies ApiConfig);
  },

  setDefaultReaction({ reaction }: { reaction: ApiReaction }) {
    localState.saveQuickReaction(
      reaction.type === 'custom' ? { documentId: reaction.documentId } : { emoji: reaction.emoticon },
    );
    return Promise.resolve(true);
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
    setTimeout(() => {
      sendUpdate({ '@type': 'updateStickerSets' });
      // Быстрая реакция живёт в config: штатно его грузит MTProto-клиент, у нас — этот пинок
      sendUpdate({ '@type': 'updateConfig' });
    }, 0);

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
      // Превью публичной группы (не участник) в список чатов не входит
      if (store.isPublicPreview(store.getGroupInfo(address)!)) return;
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
    const legacyMarks = localState.takeLegacyUnreadMarks()
      .map((id) => store.getAddressForId(id))
      .filter((address): address is string => Boolean(address));
    if (legacyMarks.length) {
      localState.saveUnreadMarks(Array.from(new Set([...localState.loadUnreadMarks(), ...legacyMarks])));
    }
    const unreadMarks = new Set(localState.loadUnreadMarks().map((address) => store.getIdForAddress(address)));
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
    // Превью публичной группы (spec 023): лента приходит событиями после загрузки
    if (groupController.isPublicPreview(chat.id)) void groupController.loadPublicPreview(chat.id);
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
    // Карточки превью ссылок — в global до сообщений, которые на них ссылаются
    const webPages = store.getWebPagesFor(messages);
    if (webPages.length) sendUpdate({ '@type': 'updateEntities', webPages });
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
  parvaneModBan: groupController.banFromReport,
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
  parvaneSetJoinByRequest: groupController.setJoinByRequest,
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

  // ── «Отметить непрочитанным» (журнал личного состояния — на всех своих
  //    устройствах; снимается при открытии чата штатным markChatRead →
  //    hasUnreadMark: undefined) ─────────────────────────────────────────────
  toggleDialogUnread({ chat, hasUnreadMark }: { chat: ApiChat; hasUnreadMark?: true }) {
    const address = store.getAddressForId(chat.id);
    const marks = localState.loadUnreadMarks();
    if (address && marks.includes(address) !== Boolean(hasUnreadMark)) {
      localState.saveUnreadMarks(hasUnreadMark ? [...marks, address] : marks.filter((a) => a !== address));
    }
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

  translateText: translation.translateText,

  // «Кто отреагировал» (spec 024): авторы реакций известны только устройству —
  // список из сохранённой строки сообщения, без сервера
  async fetchMessageReactionsList({ chat, messageId, reaction }: {
    chat: ApiChat; messageId: number; reaction?: { type: string; emoticon?: string };
  }) {
    const uuid = store.getUuidForMessage(chat.id, messageId);
    const stored = uuid ? await v2Controller.storedMessage(uuid) : undefined;
    if (!stored) return undefined;
    const emoji = reaction?.type === 'emoji' ? reaction.emoticon : undefined;
    const list = buildReactorsList(stored, (address) => store.getIdForAddress(address), store.self || '', emoji);
    return { ...list, nextOffset: undefined };
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
    const normalized = query.trim().replace(/^@/, '').toLowerCase();
    const raw = await connection.request(TOPIC_IDENTITY_SEARCH, JSON.stringify({
      query: normalized,
    }));
    const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
    // Полный адрес `ник@сервер` (spec 028, FR-001): пользователь другого сервера находится у его сервера
    if (FULL_ADDRESS_PATTERN.test(normalized) && !users.some((u) => u.username === normalized)) {
      const resolved = await connection.request(TOPIC_IDENTITY_RESOLVE, JSON.stringify({ usernames: [normalized] }))
        .then((r) => (JSON.parse(r) as { users?: WireUserInfo[] }).users || [])
        .catch(() => []);
      users.push(...resolved.filter((u) => u.username === normalized));
    }
    const globalResultIds: string[] = [];
    users.forEach((u) => {
      if (u.username === store.self) return;
      store.setDisplayName(u.username, u.display_name || u.username);
      syncController.announcePeer(u.username);
      globalResultIds.push(store.getIdForAddress(u.username));
    });
    // Публичные группы и каналы каталога (spec 023)
    globalResultIds.push(...await groupController.searchPublicGroups(query));
    return { accountResultIds: [], globalResultIds };
  },

  // ── публичные группы (spec 023) ──
  checkChatUsername: ({ username }: { username: string }) => groupController.checkChatUsername({ username }),
  setChatUsername: ({ chat, username }: { chat: ApiChat; username: string }) => (
    groupController.setChatUsername({ chat, username })
  ),
  // Имя у группы одно — снимает его `setChatUsername('')`
  deactivateAllUsernames: () => Promise.resolve(true),
  parvaneGetPublicOptions: (args: { chatId: string }) => groupController.getPublicOptions(args),
  parvaneSetPublicOptions: (args: { chatId: string; isPreview: boolean; isHistory: boolean }) => (
    groupController.setPublicOptions(args)
  ),
  // «Вступить / Подписаться» в превью публичной группы
  async joinChannel({ channelId }: { channelId: string; accessHash?: string }) {
    await groupController.joinPublicGroup(channelId);
    return undefined;
  },
  // `@имя` публичной группы: чат участника либо превью с «Вступить»
  // Иначе — пользователь с этим ником (упоминание `@ник` в тексте сообщения):
  // известный адрес сразу, незнакомый — точным запросом identity
  async getChatByUsername(username: string) {
    const chat = await groupController.resolvePublicChat(username);
    if (chat) return { chat, user: undefined };
    const address = await resolveUserAddressByNick(username);
    if (!address) return undefined;
    syncController.announcePeer(address);
    return { chat: store.buildApiChatForUser(address), user: store.buildApiUser(address) };
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
  saveChatBackground({
    theme, bytes, mimeType, slug,
  }: {
    theme: string; bytes: ArrayBuffer; mimeType: string; slug?: string;
  }) {
    return storeChatBackground(theme, bytes, mimeType, slug);
  },

  // Встроенный фон (сочетание «цвет + рисунок»): картинка рисуется здесь по идентификатору и кладётся
  // туда же, куда своя картинка, — после перезагрузки `loadChatBackground` отдаёт готовые байты, рисовать
  // заново не нужно. Быстрый перебор образцов: записи идут по очереди, устаревший выбор не пишется
  applyBuiltinChatBackground({ theme, slug }: { theme: string; slug: string }) {
    const request = (builtinBackgroundRequests.get(theme) || 0) + 1;
    builtinBackgroundRequests.set(theme, request);
    const rendering = renderBackgroundBlob(slug);
    const result = builtinBackgroundQueue.then(async () => {
      const blob = await rendering;
      if (!blob) return { status: 'failed' as const };
      if (builtinBackgroundRequests.get(theme) !== request) return { status: 'superseded' as const };
      return storeChatBackground(theme, await blob.arrayBuffer(), blob.type || 'image/jpeg', slug);
    }).catch(() => ({ status: 'failed' as const }));
    builtinBackgroundQueue = result;
    return result;
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

  // Планировщик (spec 009): состояние целиком одной шифрованной записью устройства.
  // `not-ready` — провайдер ещё не знает пользователя, вызывающий повторяет
  async parvaneLoadPlanner() {
    if (!store.self) return { status: 'not-ready' as const };
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    if (!storage) return { status: 'not-ready' as const };
    return { status: 'ok' as const, state: await storage.loadRecord<unknown>(PLANNER_RECORD) };
  },

  async parvaneSavePlanner({ state }: { state: unknown }) {
    if (!store.self) return false;
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    if (!storage) return false;
    await storage.saveRecord(PLANNER_RECORD, state);
    return true;
  },

  // Планировщик на сервере (spec 010): состояние — из движка (контейнер домена);
  // первый вызов запускает подключение контейнера и синхронизацию, итог —
  // событием `parvane-planner-changed`
  // Методы планировщика — всегда Promise: вызывающие ждут `.catch` у результата
  // eslint-disable-next-line @typescript-eslint/require-await
  async parvanePlannerState() {
    try {
      return readPlannerState();
    } catch (err) {
      logDebug(`планировщик: состояние не прочитано: ${String(err)}`);
      return { status: 'offline' as const, sizeBytes: 0, hasPending: false, error: String(err) };
    }
  },

  /** Файл, встроенный в статью (этап 6 плана 15 окт 2026): расшифрованное содержимое по id вложения. */
  async parvaneArticleMediaBlob({ fileId }: { fileId: string }) {
    try {
      return (await mediaService.downloadBlob(fileId))?.blob;
    } catch (err) {
      logDebug(`статья: файл ${fileId} не скачан: ${String(err)}`);
      return undefined;
    }
  },

  /** «Выгрузка данных»: снимок переписки для архива — расшифрованный кэш истории и журнал исходящих, разложенные
   * по чатам (как при восстановлении истории), плюс контакты. Удалённое, очищенное «у себя» и непрочитанное
   * шифрованное в снимок не входит; на сервер ничего не уходит. */
  async parvaneExportSnapshot(): Promise<ExportSnapshot | undefined> {
    if (!store.self) return undefined;
    await localState.flushHistoryNow().catch(() => undefined);
    const records = await localState.loadHistoryRecords();
    const known = new Set(records.map((record) => record.id));
    const journal = (await localState.readOwnJournal()).filter((message) => !known.has(message.id));
    const clearedUntil = localState.loadClearedUntil();
    const blocked = new Set(localState.loadBlocked());
    const self = store.self;
    const selfName = store.getDisplayName(self);
    const chats = new Map<string, ExportSourceChat>();
    const seen = new Set<string>();
    records.concat(journal).sort(compareStoredOrder).forEach((stored) => {
      if (stored.deleted || seen.has(stored.id)) return;
      seen.add(stored.id);
      const address = store.resolveChatAddress(stored);
      const until = clearedUntil[address];
      if (until && stored.ts * MS_IN_SECOND <= until) return;
      const isGroup = store.isGroupAddress(address);
      if (!isGroup && stored.from && !store.isSelfAddress(stored.from) && blocked.has(stored.from)) return;
      let chat = chats.get(address);
      if (!chat) {
        const info = isGroup ? store.getGroupInfo(address) : undefined;
        chat = {
          address,
          kind: address === self ? 'saved' : info ? (info.kind === 'channel' ? 'channel' : 'group') : 'user',
          title: info?.name || store.getDisplayName(address),
          messages: [],
        };
        chats.set(address, chat);
      }
      const isOutgoing = store.isSelfAddress(stored.from);
      chat.messages.push({
        uuid: stored.id,
        from: isOutgoing ? self : stored.from,
        fromName: isOutgoing ? selfName : store.getDisplayName(stored.from),
        isOutgoing,
        ts: stored.ts,
        replyTo: stored.reply_to,
        edited: stored.edited,
        editedAt: stored.edited ? stored.updated_at : undefined,
        pinned: stored.pinned,
        content: stored.content,
        reactions: stored.reactions?.map(({ emoji, count }) => ({ emoji, count })),
      });
    });
    const { added } = store.getContactLists();
    const contactSet = new Set(added);
    chats.forEach((chat) => {
      if (chat.kind === 'user' && store.isContact(chat.address)) contactSet.add(chat.address);
    });
    contactSet.delete(self);
    const contacts = Array.from(contactSet).sort().map((address) => ({
      address, name: store.getDisplayName(address), isExplicit: added.includes(address),
    }));
    // Чаты — по последнему сообщению, свежие сверху (как список чатов); «Избранное» первым
    const ordered = Array.from(chats.values()).sort((a, b) => {
      if (a.kind === 'saved' || b.kind === 'saved') return a.kind === 'saved' ? -1 : 1;
      return (b.messages[b.messages.length - 1]?.ts || 0) - (a.messages[a.messages.length - 1]?.ts || 0);
    });
    return {
      self, selfName, chats: ordered, contacts,
    };
  },

  /** «Выгрузка данных»: расшифрованное вложение сообщения (из кэша сессии либо скачанное заново). */
  async parvaneExportMedia({ fileId }: { fileId: string }) {
    try {
      const cached = await mediaService.getCached(fileId)?.catch(() => undefined);
      if (cached?.blob) return cached.blob;
      return (await mediaService.downloadBlob(fileId))?.blob;
    } catch (err) {
      logDebug(`выгрузка: вложение ${fileId} не скачано: ${String(err)}`);
      return undefined;
    }
  },

  /** Замер п. 21 плана 15 окт (только диаг-сборка): `count` строк истории «Избранного» прямо в кэш истории. */
  async parvaneDiagSeedHistory({ count }: { count: number }) {
    if (import.meta.env.VITE_PARVANE_DIAG_HOOKS !== '1' || !store.self) return false;
    const self = store.self;
    const startSecs = Math.floor(Date.now() / 1000) - count;
    for (let i = 0; i < count; i++) {
      localState.saveHistoryRecord({
        id: newMessageId(),
        from: self,
        to: self,
        content: { kind: 'text', text: `история ${i} для замера окна истории чата` },
        ts: startSecs + i,
        origin: 'v2',
      });
    }
    await localState.flushHistoryNow();
    return true;
  },

  /** Явный синк (раздел открыт заново): не чаще, чем позволяет модуль. */
  async parvanePlannerSync() {
    await v2Controller.planner.syncNow();
    return true;
  },

  /** Есть ли потребители «Плана» (раздел, палитра, карточки задания в чате):
   * без них опрос сервера редкий (60 с), с первым — немедленный синк и 8 с. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async parvanePlannerSetActive({ isActive }: { isActive: boolean }) {
    v2Controller.planner.setActive(isActive);
    return true;
  },

  /** Последний сохранённый снимок «Плана» (только показ, пока движок не поднялся). */
  async parvanePlannerCachedState() {
    if (!store.self) return undefined;
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    const json = await storage?.loadRecord<string>(PLANNER_VIEW_RECORD).catch(() => undefined);
    return json ? JSON.parse(json) as unknown : undefined;
  },

  // eslint-disable-next-line @typescript-eslint/require-await
  async parvanePlannerApply({ changes }: { changes: unknown[] }) {
    v2Controller.planner.apply(changes);
    return true;
  },

  async parvanePlannerFlush() {
    await v2Controller.planner.flush();
    return true;
  },

  /** Данные этапа 1 перенесены в контейнер: запись устройства — маркер (FR-008). */
  async parvanePlannerMarkMigrated({ count }: { count: number }) {
    if (!store.self) return false;
    const storage = await SecureE2eStorage.open(store.self).catch(() => undefined);
    if (!storage) return false;
    await storage.saveRecord(PLANNER_RECORD, { migrated: true, at: Date.now(), count });
    return true;
  },

  // Облако (spec 016): состояние, загрузка, скачивание, место — `./cloudDrive`
  ...cloudDrive,

  /** Превью страницы для карточки-ссылки холста («Знания»): метаданные шарда `preview`, наружу браузер не ходит. */
  parvaneLinkPreview({ url }: { url: string }) {
    return mediaService.fetchLinkPreview(url);
  },

  // Галерея — только свои картинки: встроенные фоны собираются на экране из градиента и рисунка
  // (`wallpaperCombo.ts`) и рисуются по требованию. Своя картинка живёт в шифрованном хранилище (фон темы
  // и копия последней загруженной) — возвращаем её плитку, иначе после перезагрузки её не выбрать снова
  async fetchWallpapers() {
    const uploaded: ApiWallpaper[] = [];
    const storage = store.self ? await SecureE2eStorage.open(store.self).catch(() => undefined) : undefined;
    if (storage) {
      const names = [...['light', 'dark'].map((theme) => `${BACKGROUND_RECORD_PREFIX}${theme}`), OWN_BACKGROUND_RECORD];
      for (const name of names) {
        const slug = await storage.loadRecord<string>(`${name}:slug`);
        if (!slug?.startsWith(UPLOADED_SLUG_PREFIX) || uploaded.some((item) => item.slug === slug)) continue;
        const bytes = await storage.loadBytesRecord(name);
        if (!bytes) continue;
        const mimeType = await storage.loadRecord<string>(`${name}:mime`) || 'image/jpeg';
        const blob = new Blob([bytes as BlobPart], { type: mimeType });
        mediaService.cacheBlob(slug, blob, mimeType);
        uploaded.push(await buildUploadedWallpaper(slug, blob, 'wallpaper.jpg'));
      }
    }
    return { wallpapers: uploaded };
  },

  async uploadWallpaper(file: File) {
    const id = `${UPLOADED_SLUG_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    mediaService.cacheBlob(id, file, file.type || 'image/jpeg');
    return { wallpaper: await buildUploadedWallpaper(id, file, file.name || 'wallpaper.jpg') };
  },

  // Просмотр фото профиля (MediaViewer): у пользователя одно фото — аватар; у группы и канала — фото из
  // сведений группы (без него просмотрщик открывался пустым)
  fetchProfilePhotos({ peer }: { peer: ApiPeer; offset?: number; limit?: number }) {
    const address = store.getAddressForId(peer.id);
    const fileId = address ? store.getAvatar(address) || store.getGroupInfo(address)?.avatar || undefined : undefined;
    const photos: ApiPhoto[] = fileId ? [buildAvatarPhoto(fileId)] : [];
    return Promise.resolve({ count: photos.length, photos, nextOffsetId: undefined });
  },

  // ── стикеры (встроенный набор + кастомные паки) ─────────────────────────────
  async fetchStickerSets() {
    // Картинки встроенных стикеров рисуются по запросу медиа (`restoreStickerBlob`)
    const set = getBuiltinStickerSet();
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
    if (!wantsEmoji) {
      const set = getBuiltinStickerSet();
      return { set, stickers: set.stickers };
    }
    const { set, blobs } = await buildBuiltinCustomEmojiSet();
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
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_DEVICE_LIST, JSON.stringify({ token }));
      const response = JSON.parse(raw) as {
        ok: boolean;
        devices?: DeviceRow[];
      };
      if (!response.ok || !response.devices) return undefined;
      const currentDeviceId = ownDeviceId();
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
  async terminateAuthorization(hash: string, password?: string, shouldRotateKeys?: boolean) {
    if (hash === ownDeviceId()) return undefined;
    return revokeOwnDevice(hash, password, shouldRotateKeys);
  },

  async terminateAllAuthorizations(password?: string, shouldRotateKeys?: boolean) {
    if (!connection) return undefined;
    const list = await methods.fetchAuthorizations();
    if (!list) return undefined;
    const current = ownDeviceId();
    const others = Object.keys(list.authorizations).filter((deviceId) => deviceId !== current);
    const results = await Promise.all(others.map((deviceId) => revokeOwnDevice(deviceId, password, shouldRotateKeys)));
    return results.every(Boolean) ? true : undefined;
  },

  // ── Смена ключа подписи устройств после отзыва (T128/T130, D-12) ────────────

  // Отозвано устройство, державшее SSK: до смены корнем новые устройства не
  // принимаются. Корень — только в копии под ключом восстановления
  // Экран «Устройства»: состав своих устройств мог измениться без извещения
  async parvanePollOwnDevices() {
    await v2Controller.pollOwnDevices();
    return true;
  },

  // ENG-04: свои устройства, державшие ключ подписи и вышедшие сами; выход украденного выглядит так же
  parvaneGetLeftDevices() {
    return Promise.resolve({ deviceIds: v2Controller.leftSskHolders() });
  },

  async parvaneReportDeviceStolen({ deviceId }: { deviceId: string }) {
    return v2Controller.reportDeviceStolen(deviceId).catch((e: unknown) => {
      logDebug(`v2: отметка «устройство украдено» не выполнена: ${String(e)}`);
      return false;
    });
  },

  async parvaneGetSskState() {
    return {
      ...v2Controller.sskState(),
      isEscrowCopyMissing: await v2Controller.isEscrowCopyMissing(),
      // spec 015: ключ восстановления ещё можно отправить владельцу в Telegram
      canSendKeyToTelegram: await v2Controller.canSendKeyToTelegram(),
    };
  },

  // Копия корня для администратора у аккаунта, созданного до включения страховки
  parvaneStoreEscrowCopy({ recoveryKey }: { recoveryKey: string }) {
    return v2Controller.storeEscrowCopy(pickRecoveryKey(recoveryKey));
  },

  parvaneRotateSsk({ recoveryKey }: { recoveryKey: string }) {
    return v2Controller.rotateSsk(pickRecoveryKey(recoveryKey));
  },

  // Смена ника (spec 026): после успеха локальное переезжает под новый адрес, вкладка перезагружается с токеном
  // нового адреса (сессия прежнего сервер закрывает)
  async parvaneRenameAccount({ nick, password, recoveryKey }: { nick: string; password: string; recoveryKey: string }) {
    const oldAddress = store.self;
    const out = await v2Controller.renameAccount(nick.trim().toLowerCase(), password, pickRecoveryKey(recoveryKey));
    if (out.result !== 'ok') return { result: out.result };
    token = out.token;
    await moveAccountLocal(oldAddress, out.address);
    if (out.token) await persistSessionCredential(out.address, '');
    window.setTimeout(() => window.location.reload(), 400);
    return { result: 'ok', address: out.address };
  },

  // spec 027: удалить аккаунт (7 дней отсрочки). После ответа UI выходит; сессии закрывает сервер
  async parvaneDeleteAccount({ password }: { password: string }) {
    const out = await v2Controller.deleteAccount(password);
    if (out.result === 'ok') {
      // Ключи и история устройства остаются: вход паролем до срока восстанавливает аккаунт на этом же устройстве
      const self = store.self;
      window.setTimeout(() => {
        void clearSecureSession(self).catch(() => undefined).then(() => window.location.reload());
      }, ACCOUNT_DELETE_RELOAD_MS);
    }
    return out;
  },

  // spec 027: экран пароля сообщил, что аккаунт ждёт удаления, — войти, отменив удаление
  async parvaneRestoreAccount() {
    if (!pendingLoginPassword) return;
    connectionController.cancelDeletionOnNextLogin();
    await methods.provideAuthPassword(pendingLoginPassword);
  },

  // Проверка ника до смены: формат и занятость (поиск в каталоге не выдаёт занятые прежние ники — их держит сервер)
  parvaneCheckNick({ nick }: { nick: string }) {
    const value = nick.trim().toLowerCase();
    return { isValid: /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(value), current: store.self.split('@')[0] };
  },

  // ── Авто-линковка истории: методы для Settings → Devices ────────────────────

  // Новое устройство: статус собственного оффера (код показывается в UI,
  // пользователь сверяет его на старом устройстве перед подтверждением)
  parvaneGetLinkStatus() {
    // v2: код появляется только после challenge старого устройства
    const isPending = Boolean(linkRuntime.timer && v2Controller.needsLinking());
    return v2Controller.hasEscrow().then((hasEscrow) => ({
      hasEscrow,
      isPending,
      // spec 015: бот спрашивает ключ восстановления у владельца в Telegram
      telegram: telegramRecovery.state,
      code: isPending ? linkRuntime.code : undefined,
      // v2: у аккаунта есть журнал устройств, а это устройство в него не входит —
      // кроме линковки, есть вход по ключу восстановления и сброс личности
      canRecover: v2Controller.needsLinking(),
    }));
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
  async parvaneRecoverWithKey({ recoveryKey }: { recoveryKey: string }) {
    const outcome = await v2Controller.joinWithRecoveryKey(pickRecoveryKey(recoveryKey), false);
    if (outcome.result === 'ok') {
      stopTelegramRecovery('done');
      void v2Controller.pollTelegramKey(true);
      await completeKeyJoin(outcome);
    } else if (outcome.result === 'failed' && await v2Controller.waitJoined(JOIN_BACKGROUND_WAIT_MS)) {
      // Временная ошибка, запись в журнал прошла повтором
      await completeJoinFromBundle();
      return 'ok';
    }
    return outcome.result;
  },

  // spec 015: попросить бота прислать просьбу о ключе ещё раз
  async parvaneRequestTelegramKey() {
    await startTelegramRecovery(true);
    return telegramRecovery.state;
  },

  // spec 015: действующее устройство — отправить ключ восстановления владельцу в
  // Telegram (аккаунт создан до того, как ключ стал уходить туда сам)
  parvaneSendKeyToTelegram({ recoveryKey }: { recoveryKey: string }) {
    return v2Controller.sendKeyToTelegram(pickRecoveryKey(recoveryKey));
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
    if (!connection) return undefined;
    try {
      const raw = await connection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: ownDeviceId(),
      }));
      const response = JSON.parse(raw) as {
        ok: boolean; offers?: LinkOfferWire[]; grant?: { box_payload: string; eph_pub: string };
      };
      // Свой грант пришёл в опросе чужих офферов — оставляем опросу своего оффера
      if (response.ok && response.grant && linkRuntime.timer) pendingLinkGrant = response.grant;
      if (!response.ok || !response.offers) return undefined;
      // Уже вошедшие в журнал своих устройств (ключом восстановления, подтверждением) — не запрос: их оффер мог
      // остаться на сервере до отзыва, а «новое устройство просит привязку» для них только путает
      const joined = new Set(v2Controller.logDevices(store.self)?.v2 || []);
      response.offers = response.offers.filter((offer) => !joined.has(offer.device_id));
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

  // Старое устройство: подтверждённая передача целевому устройству. Экспорт
  // истории v2-эпохи шифруется случайным ключом и уезжает в cloud (owner-only);
  // координаты и ключ — в ECDH-боксе под парой эфемерных ключей (P-03);
  // материал гранта движка — вторым блобом (LINK-1 v2)
  async parvaneGrantLink({ deviceId }: { deviceId: string }) {
    const activeConnection = connection;
    if (!activeConnection) return undefined;
    try {
      const pollRaw = await activeConnection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: ownDeviceId(),
      }));
      const poll = JSON.parse(pollRaw) as { ok: boolean; offers?: LinkOfferWire[] };
      const offer = poll.ok ? poll.offers?.find((entry) => entry.device_id === deviceId) : undefined;
      const own = linkChallenges.get(deviceId);
      if (!offer || !own || !offer.commitment || !offer.eph_pub || offer.challenge_pub !== own.pub) return undefined;
      if (!(await linkCommitmentMatches(offer.eph_pub, offer.commitment))) return undefined;

      // LINK-1 п. 8: строки v2-эпохи новому устройству сервер не отдаст
      await localState.flushHistoryNow();
      const exportJson = JSON.stringify({
        linkVersion: 2,
        v2History: collectV2History(await localState.loadHistoryRecords(), await localState.readOwnJournal()),
        // spec 010: ключи контейнера планировщика — чтобы раздел открылся сразу после привязки
        planner: v2Controller.planner.keysExport(),
        // spec 016: ключи контейнеров облака (личный диск, совместные папки)
        cloud: v2Controller.cloud.keysExport(),
      });
      const upload = await mediaService.uploadBlob(
        new Blob([exportJson]), 'link-transfer', 'application/octet-stream', { encrypt: true },
      );
      if (!upload.mediaKeys) return undefined;

      // LINK-1 v2: грант движка — вторым блобом (в бокс не помещается)
      const v2Material = await v2Controller.linkGrantMaterial();
      const v2Upload = v2Material && await mediaService.uploadBlob(
        new Blob([v2Material.slice()]), 'link-grant-v2', 'application/octet-stream', { encrypt: true },
      );
      v2Material?.fill(0);

      const box = await sealLinkBox(own.keyPair.privateKey, offer.eph_pub, {
        file_id: upload.fileId,
        file_key: upload.mediaKeys.keyB64,
        file_nonce: upload.mediaKeys.nonceB64,
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

  // token — JSON PushSubscription из notifications.tsx (getDeviceToken).
  // Протокол v2: журнал v2 будит устройство своей регистрацией (`push.wake.register`)
  async registerDevice(deviceToken: string) {
    if (!connection || !v2Controller.isReady()) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string; keys?: unknown };
      if (!subscription.endpoint || !subscription.keys) return undefined;
      await v2Controller.pushRegister(subscription as Parameters<typeof v2Controller.pushRegister>[0]);
      return true;
    } catch (err) {
      logDebug(`v2: push.wake.register не удался: ${String(err)}`);
      return undefined;
    }
  },

  async unregisterDevice(deviceToken: string) {
    if (!connection || !v2Controller.isReady()) return undefined;
    try {
      const subscription = JSON.parse(deviceToken) as { endpoint?: string };
      if (!subscription.endpoint) return undefined;
      await v2Controller.pushUnregister(subscription.endpoint);
      return true;
    } catch {
      return undefined;
    }
  },

  // ── C1: ручная копия ключей устройства (перенос на другой браузер) ──────────

  async parvaneExportE2eKeys({ password }: { password: string }) {
    const deviceId = ownDeviceId();
    if (!store.self || !deviceId) return undefined;
    // Копия несёт устройство v2 с историей v2-эпохи: сервер v2 не отдаст её
    // заново, а сообщения запечатаны под устройства журнала (T152)
    await localState.flushHistoryNow();
    const v2 = await v2Controller.exportBackup();
    if (!v2) return undefined;
    const v2History = collectV2History(await localState.loadHistoryRecords(), await localState.readOwnJournal());
    return { payload: await exportEncryptedBackup(password, { deviceId, v2, v2History }) };
  },

  async parvaneImportE2eKeys({ payload, password }: { payload: string; password: string }) {
    if (!store.self) return undefined;
    try {
      const backup = await importEncryptedBackup(password, payload);
      // Этот браузер становится тем же устройством v2: следующий вход просит JWT
      // под device_id из копии — иначе сессия v2 представилась бы серверу другим
      // устройством
      v2Controller.reset();
      await v2Controller.importBackup(backup.v2 as V2DeviceBackup);
      connectionController.rememberDeviceId(store.self, backup.deviceId);
      syncController.reset();
      resetPackRegistries();
      sendUpdate({ '@type': 'requestSync' });
      if (backup.v2History) {
        await applyLinkedV2History(parseV2History(JSON.stringify({ v2History: backup.v2History })), store.self);
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

  fetchRecentStickers() {
    const set = getBuiltinStickerSet();
    return Promise.resolve({ hash: '1', stickers: (set.stickers || []).slice(0, 6) });
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

  // ── локальный поиск стикеров и GIF (каталога на сервере нет) ────────────────

  // Наборы по эмодзи (и слову → эмодзи, EN+RU), названию и имени файла стикера:
  // встроенный набор и установленные паки стикеров
  async searchStickers({ query }: { query: string }) {
    await ensureEmojiNameData();
    const sources: StickerSearchSource[] = [{ set: getBuiltinStickerSet() }];
    (await loadInstalledPacks(store.self)).filter((pack) => !pack.isEmoji).forEach((pack) => {
      const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      const files = pack.files.filter((file) => getPackFileMime(file.name));
      const fileWords = new Map<string, string[]>();
      (built.set.stickers || []).forEach((sticker, index) => {
        // `NN-1f602.webp`: хвост с кодом эмодзи — не слово
        const name = files[index]?.name.replace(/\.[^.]+$/, '').replace(/-[0-9a-f]{4,6}$/i, '');
        if (name) fileWords.set(sticker.id, wordsOfFileName(name));
      });
      sources.push({ set: built.set, fileWords });
    });
    const sets = searchStickerSets(query, sources);
    return { hash: `local:${query}`, sets };
  },

  // Сохранённые и встроенные GIF по эмодзи, словам и имени файла; пустой запрос —
  // все. Ответ один, без страниц: повторный запрос с `GIF_SEARCH_END` пуст и
  // ничего не меняет (иначе подгрузка ленты крутилась бы по кругу)
  async searchGifs({ query, offset }: { query: string; offset?: string }) {
    if (offset === GIF_SEARCH_END) return undefined;
    await ensureEmojiNameData();
    const { gifs: builtin, blobs } = await buildBuiltinGifs();
    blobs.forEach((blob, id) => {
      mediaService.cacheBlobIfAbsent(id, blob, 'video/webm');
    });
    await messageController.ensureSavedGifsHydrated();
    // Как в `fetchSavedGifs`: сначала сохранённые, затем встроенные (без повторов)
    const saved = messageController.getSavedGifs();
    const savedIds = new Set(saved.map((gif) => gif.id));
    const sources: GifSearchSource[] = [...saved, ...builtin.filter((gif) => !savedIds.has(gif.id))]
      .map((gif) => ({ gif, ...BUILTIN_GIF_TAGS[gif.id] }));
    return { gifs: searchGifSources(query, sources), nextOffset: GIF_SEARCH_END };
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
    if (!store.self) return undefined;
    // v2 (T153): ключ безопасности — отпечаток корня личности из проверенного
    // журнала устройств, один на аккаунт. Свой показываем тем же способом, каким
    // его увидит собеседник; до подъёма журнала показать нечего
    const ownRoot = v2Controller.isReady() ? v2Controller.logDevices(store.self)?.root : undefined;
    const own = ownRoot ? await fingerprintOf(ownRoot) : '';
    const address = chatId ? store.getAddressForId(chatId) : undefined;
    if (!address || address === store.self || store.isGroupAddress(address)) {
      return { own, devices: [] as { deviceId: string; fingerprint: string }[] };
    }
    const peerRoot = ownRoot && await v2Controller.isV2Peer(address).catch(() => false)
      ? v2Controller.logDevices(address)?.root : undefined;
    return { own, devices: peerRoot ? [{ deviceId: 'v2', fingerprint: await fingerprintOf(peerRoot) }] : [] };
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
    pushV2Privacy();
    return Promise.resolve(true);
  },

  // Протокол v2: «сообщения от незнакомых» (T079). Настройка есть только у
  // v2-стека — экран показывает её, когда он поднят
  parvaneIsUpgradeRequired() {
    return Promise.resolve(isUpgradeRequired);
  },

  async parvaneTakeRecoveryKey() {
    const recoveryKey = pendingRecoveryKey;
    pendingRecoveryKey = undefined;
    if (!recoveryKey) return undefined;
    return { recoveryKey, hasEscrow: await v2Controller.hasEscrow() };
  },

  async parvaneGetCallPresencePolicy() {
    await refreshV2Privacy();
    return {
      isAvailable: v2Controller.isReady(),
      areCallsAllowed: readAudience(callsPolicyKey(store.self)) !== 'nobody',
      isRelayOnly: readAudience(callsRelayKey(store.self)) === 'nobody',
      isPresenceShown: readAudience(presencePolicyKey(store.self)) !== 'nobody',
    };
  },

  parvaneSetCallsRelay({ isRelayOnly }: { isRelayOnly: boolean }) {
    writeAudience(callsRelayKey(store.self), isRelayOnly ? 'nobody' : 'anyone');
    return Promise.resolve(true);
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

  /** Ошибка — ключ словаря с причиной (`ParvaneChangePassword*`), пусто — причина неизвестна. */
  async parvaneChangePassword({ oldPassword, newPassword }: { oldPassword: string; newPassword: string }) {
    if (!connection) throw new Error('ParvaneNoConnection');
    const raw = await connection.request(
      TOPIC_IDENTITY_PASSWORD_CHANGE,
      JSON.stringify({ token, old_password: oldPassword, new_password: newPassword }),
    );
    const response = JSON.parse(raw) as { ok: boolean; error?: string };
    if (!response.ok) throw new Error(PASSWORD_CHANGE_REASONS[response.error || ''] || '');
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
      if (err instanceof AccountDeletionPendingError) {
        reportDeletionPending(user, password, err.deletionAtMs);
        return;
      }
      const message = String(err);
      logDebug(`логин отклонён: ${message}`);
      if (reportUpgradeRequiredAtLogin()) return;
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
    if (address !== store.self) void syncController.resolveDisplayNames([address], true).catch(() => undefined);
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
    // Полный выход: устройство убирает себя из аккаунта, пока соединение живо, —
    // иначе у остальных устройств оставался бы «призрак» в списке. Нет связи —
    // не дольше LEAVE_TIMEOUT_MS: локальное стирание идёт в любом случае (WEB-11)
    if (!noSessionClear) {
      await Promise.race([
        v2Controller.leave(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, LEAVE_TIMEOUT_MS);
        }),
      ]);
    }
    reminderScheduler.stop();
    if (!noSessionClear) {
      await Promise.race([
        v2Controller.pushSetAlarms([]).catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, LEAVE_TIMEOUT_MS);
        }),
      ]);
      await clearWorkerReminders().catch(() => undefined);
    }
    connectionController.shutdown();
    mediaService.clearCache();
    // Стор прежнего аккаунта не должен отвечать на запросы между logout и
    // следующим входом
    store = new ParvaneStore();
    messageController.reset();
    localState.reset();
    polls.reset();
    taskOffers.reset();
    if (!noSessionClear) {
      clearLoginStorage();
      if (user) {
        localState.clearUserData(user);
        await SecureE2eStorage.clear(user);
        await clearSecureSession(user).catch(() => undefined);
        // Ключи стёрты — следующий вход идёт новым устройством
        connectionController.forgetDeviceId(user);
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

/** Адрес пользователя по нику из `@ник` либо `@ник@сервер`; не найден — `undefined`. */
async function resolveUserAddressByNick(username: string) {
  const self = store.self;
  const raw = username.trim().replace(/^@/, '').toLowerCase();
  if (!self || !raw) return undefined;
  const address = raw.includes('@') ? raw : `${raw}@${self.split('@')[1] || ''}`;
  if (!/^[a-z0-9][a-z0-9_.-]{1,63}@[^@\s]+$/.test(address)) return undefined;
  const canonical = store.canonicalAddress(address);
  if (canonical === self || store.getKnownUserAddresses().includes(canonical)) return canonical;
  if (!connection) return undefined;
  try {
    const response = await connection.request(TOPIC_IDENTITY_RESOLVE, JSON.stringify({ usernames: [address] }));
    const found = ((JSON.parse(response) as { users?: WireUserInfo[] }).users || [])
      .find((user) => user.username === address);
    if (!found) return undefined;
    store.setDisplayName(found.username, found.display_name || found.username);
    return found.username;
  } catch {
    return undefined;
  }
}

const GIF_SEARCH_END = 'end';

// Английские имена эмодзи для поиска «слово → эмодзи»: тот же файл, что у
// панели эмодзи, грузится один раз и только при первом поиске
let emojiNameDataPromise: Promise<void> | undefined;
function ensureEmojiNameData() {
  if (hasEmojiNameData()) return Promise.resolve();
  emojiNameDataPromise ||= import('emoji-data-ios/emoji-data.json')
    .then((module) => setEmojiNameData((module as { default: unknown[] }).default))
    .catch(() => {
      emojiNameDataPromise = undefined;
    });
  return emojiNameDataPromise;
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
      case 'links': return Boolean(c.text?.text && (/https?:\/\//.test(c.text.text) || c.text.entities?.some(
        (e) => e.type === ApiMessageEntityTypes.Url || e.type === ApiMessageEntityTypes.TextUrl,
      )));
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
  // perf A12: апдейты в диагностический журнал не пишутся — их сотни на старте,
  // каждый стоил summarize и записи в localStorage; действия и вызовы остаются
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
    // UI ловит действия, которые молча ничего не делают. Заглушки Telegram
    // (B5: ~40 загрузок после синка) — раз на имя метода, без записи на
    // каждый вызов
    if (!reportedMissingMethods.has(fnName)) {
      reportedMissingMethods.add(fnName);
      diagLog('api-missing', String(fnName));
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
