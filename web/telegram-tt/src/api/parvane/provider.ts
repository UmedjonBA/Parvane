// Провайдер Parvane: тот же интерфейс, что у `gramjs/worker/connector`
// (initApi/callApi + поток ApiUpdate), но вместо MTProto — шина Parvane через
// gateway (WebSocket, JSON-кадры). Работает в главном потоке, без воркера.

import type { SendMessageParams, ThreadReadState } from '../../types';
import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type {
  ApiAppConfig,
  ApiAvailableReaction,
  ApiChat, ApiDraft, ApiInitialArgs,
  ApiMessage,
  ApiOnProgress,
  ApiPeer,
  ApiPhoto,
  ApiSession,
  ApiSticker, ApiThreadInfo,
  ApiUpdate,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  ApiWallpaper,
  OnApiUpdate } from '../types';
import type { ServerInfo } from './connectionController';
import type { GatewayConnection } from './gateway';
import type { PackFile, StoredPack } from './stickerPacks';
import type { WireUserInfo } from './wire';
import { MAIN_THREAD_ID } from '../types';

import { ARCHIVED_FOLDER_ID, MUTE_INDEFINITE_TIMESTAMP, UNMUTE_TIMESTAMP } from '../../config';
import { diagLog } from '../../util/parvaneDiag';
import { DEFAULT_APP_CONFIG } from '../../limits';
import {
  clearLoginStorage,
  consumeLegacyCredentials,
  parseLoginCredentials,
  readLoginAddress,
  readRememberMe,
  saveLoginAddress,
} from './authStorage';
import { createCallController } from './calls';
import { canonicalAddress, createConnectionController } from './connectionController';
import { E2eEngine } from './e2e';
import { buildBuiltinGifs } from './gifs';
import { createGroupController } from './groups';
import { langPackMethods } from './langPacks';
import {
  exportLinkPublicKey,
  generateLinkKeyPair,
  openLinkBox,
  sasCodeForEphPub,
  sealLinkBox,
} from './linking';
import { createLocalState } from './localState';
import { createMediaService } from './media';
import { createMessageController } from './messages';
import { buildOldLangPack } from './oldLangPack';
import { PollStore } from './polls';
import { clearSecureCredential, loadSecureCredential, saveSecureCredential } from './secureStorage';
import {
  buildApiCustomEmojiSetFromPack,
  buildApiStickerSetFromPack,
  findInstalledPackBySetId,
  getEmojiPackRawName,
  getPackFileMime,
  getPendingFiles,
  getReceivedEmojiPackSetIds,
  getReceivedPackRef,
  getSetIdForPackName,
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
import { buildBuiltinCustomEmojiSet, buildBuiltinStickerSet, getStickerBlobMime } from './stickers';
import { ParvaneStore } from './store';
import { createSyncController } from './sync';
import { buildBuiltinWallpapers } from './wallpapers';
import {
  TOPIC_DEVICE_LIST,
  TOPIC_DEVICE_REVOKE,
  TOPIC_IDENTITY_SEARCH,
  TOPIC_IDENTITY_SETAVATAR,
  TOPIC_IDENTITY_SETNAME,
  TOPIC_LINK_GRANT,
  TOPIC_LINK_OFFER,
  TOPIC_LINK_POLL,
  TOPIC_PUSH_REGISTER,
  TOPIC_PUSH_UNREGISTER,
  TOPIC_PUSH_VAPID_GET,
} from './wire';

const LOGIN_HASH_PREFIX = '#parvane=';
const PARVANE_APP_CONFIG: ApiAppConfig = { ...DEFAULT_APP_CONFIG, hash: 1 };
const BUILTIN_REACTIONS: ApiAvailableReaction[] = [
  '👍', '❤️', '🔥', '😂', '👏', '🎉', '🤔',
].map((emoticon) => ({
  reaction: { type: 'emoji', emoticon },
  title: emoticon,
}));

let onUpdate: OnApiUpdate = () => undefined;
let startupCredentials = consumeStartupCredentials();
let connection: GatewayConnection | undefined;
let store = new ParvaneStore();
let token = '';
let pendingLoginAddress = '';
// Пароль между экранами регистрации: register (email) и confirm (код) должны
// повторить логин без повторного ввода
let pendingLoginPassword = '';
// Почта, на которую ушёл код (для шапки экрана кода)
let pendingEmail = '';
// Режим Telegram: токен deep link t.me/<bot>?start=<token> и опрос статуса
let pendingTelegramToken = '';
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

async function sendMessageFromSchedule(params: SendMessageParams): Promise<unknown> {
  return methods.sendMessage(params);
}

const mediaService = createMediaService({
  getConnection: () => connection,
  getStore: () => store,
  getToken: () => token,
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

const callController = createCallController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  isIdentityReady: () => isCallIdentityReady,
  isBlocked: localState.isBlocked,
  sendUpdate,
  log: logDebug,
});

// Forward-ref: подписку на групповой typing реализует connectionController,
// который создаётся ниже. Устанавливается после его создания
let subscribeGroupTyping: (groupChatId: string) => void = () => {};

const groupController = createGroupController({
  getConnection: () => connection,
  getE2e: () => e2e,
  getStore: () => store,
  getToken: () => token,
  selfId,
  sendUpdate,
  onGroupRegistered: (groupChatId) => subscribeGroupTyping(groupChatId),
  log: logDebug,
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

messageController = createMessageController({
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
});

const connectionController = createConnectionController({
  calls: callController,
  getConnection: () => connection,
  setConnection: (nextConnection) => { connection = nextConnection; },
  getE2e: () => e2e,
  setE2e: setE2eEngine,
  getStore: () => store,
  setStore: (nextStore) => { store = nextStore; },
  getToken: () => token,
  setToken: (nextToken) => { token = nextToken; },
  setCallIdentityReady: (isReady) => { isCallIdentityReady = isReady; },
  polls,
  onNewSession: () => {
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
});

subscribeGroupTyping = connectionController.ensureGroupTyping;

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
      // «Keep me signed in»: если пароль сохранён (зашифрован в IndexedDB) —
      // авто-логин без экрана пароля. Иначе (или при просроченном/битом
      // credential) показываем экран пароля.
      if (readRememberMe()) {
        const savedPassword = await loadSecureCredential(savedAddress).catch(() => undefined);
        if (savedPassword) {
          try {
            await connectionController.connectAndLogin(savedAddress, savedPassword);
            saveLoginAddress(savedAddress);
            return;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[parvane] авто-логин не удался, спрашиваем пароль:', err);
            await clearSecureCredential(savedAddress).catch(() => undefined);
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

function startTelegramConfirmation(user: string, password: string, linkToken: string) {
  stopTelegramPolling();
  pendingLoginAddress = user;
  pendingLoginPassword = password;
  pendingTelegramToken = linkToken;
  const generation = telegramPollGeneration;
  sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitQrCode' });
  const startedAt = Date.now();
  const tick = async () => {
    if (generation !== telegramPollGeneration) return;
    if (Date.now() - startedAt > TELEGRAM_POLL_MAX_MS) {
      logDebug('Telegram: токен истёк, обратно на форму регистрации');
      stopTelegramPolling();
      sendUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitRegistration' });
      sendUpdate({ '@type': 'updateAuthorizationError', errorKey: { key: 'ParvaneTelegramExpired' } });
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
    const address = await connectionController.connectAndLogin(user, password);
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

// «Keep me signed in»: при включённом флаге сохраняем пароль (зашифрованным),
// чтобы reload не спрашивал его снова. При выключенном — стираем сохранённое.
async function persistSessionCredential(user: string, password: string) {
  try {
    if (readRememberMe()) {
      await saveSecureCredential(user, password);
    } else {
      await clearSecureCredential(user);
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
    const rawName = getEmojiPackRawName(setId) || pack.name;
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
  const pack: StoredPack = { name: ref.name, files };
  setPendingFiles(setId, pack);
  return { pack, isInstalled: false };
}

// Метаданных об устройствах сервер не хранит (только ключи и updated_at) —
// человекочитаемые поля синтезируем: для текущего устройства из UA, для
// остальных по device_id ('' — legacy-primary: desktop или прежний web)
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

type LinkRuntime = {
  generation: number;
  keyPair?: CryptoKeyPair;
  code?: string;
  timer?: number;
};

const linkRuntime: LinkRuntime = { generation: 0 };

function stopHistoryLink() {
  linkRuntime.generation++;
  window.clearInterval(linkRuntime.timer);
  linkRuntime.timer = undefined;
  linkRuntime.keyPair = undefined;
  linkRuntime.code = undefined;
}

// Новое устройство: оффер + опрос гранта до успеха или истечения срока
async function startHistoryLinkOffer() {
  stopHistoryLink();
  const engine = e2e;
  if (!connection || !engine || !engine.needsHistoryLink()) return;
  const generation = linkRuntime.generation;
  const keyPair = await generateLinkKeyPair();
  const ephPub = await exportLinkPublicKey(keyPair);
  const code = await sasCodeForEphPub(ephPub);
  if (generation !== linkRuntime.generation) return;
  linkRuntime.keyPair = keyPair;
  linkRuntime.code = code;
  try {
    const raw = await connection.request(TOPIC_LINK_OFFER, JSON.stringify({
      token, device_id: engine.deviceId, eph_pub: ephPub,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return;
  } catch {
    return;
  }
  logDebug('линковка: оффер опубликован');
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
  if (!engine || !activeConnection || !keyPair) return;
  // История появилась другим путём (живая переписка) — отзываем оффер, чтобы
  // другие устройства не видели висящий запрос
  if (!engine.needsHistoryLink()) {
    stopHistoryLink();
    try {
      await activeConnection.request(TOPIC_LINK_OFFER, JSON.stringify({
        token, device_id: engine.deviceId, eph_pub: '',
      }));
    } catch {
      // сервер вычистит по TTL
    }
    return;
  }
  let grant: { box_payload: string; eph_pub: string } | undefined;
  try {
    const raw = await activeConnection.request(TOPIC_LINK_POLL, JSON.stringify({
      token, device_id: engine.deviceId,
    }));
    const response = JSON.parse(raw) as {
      ok: boolean;
      grant?: { box_payload: string; eph_pub: string };
    };
    if (!response.ok || !response.grant) return;
    grant = response.grant;
  } catch {
    return;
  }
  if (generation !== linkRuntime.generation) return;
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
  try {
    engine.importLinkedHistory(await media.blob.text());
    await engine.flushStorage();
  } catch (err) {
    logDebug(`линковка: импорт не удался: ${String(err)}`);
    return;
  }
  // Полный ресинк: пропущенная как нечитаемая история теперь расшифруется
  // из привезённого decCache/групповых сессий
  syncController.reset();
  sendUpdate({ '@type': 'requestSync' });
  logDebug('линковка: история получена и импортирована');
}

// Отзыв устройства: identity выкидывает его бандл из каталога (fan-out новых
// сообщений его больше не включает), локально — чистка каталога self и ротация
// групповых ключей (forgetOwnDevice)
async function revokeOwnDevice(deviceId: string) {
  if (!connection || !e2e) return undefined;
  try {
    const raw = await connection.request(TOPIC_DEVICE_REVOKE, JSON.stringify({
      token, device_id: deviceId,
    }));
    if (!(JSON.parse(raw) as { ok?: boolean }).ok) return undefined;
    e2e.forgetOwnDevice(deviceId);
    await e2e.flushStorage();
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

const methods = {
  // Языковые пакеты из сборки (fallback.strings / ru.strings)
  ...langPackMethods,

  fetchAppConfig({ hash }: { hash?: number }) {
    return Promise.resolve(hash === PARVANE_APP_CONFIG.hash ? undefined : PARVANE_APP_CONFIG);
  },

  fetchAvailableReactions() {
    return Promise.resolve(BUILTIN_REACTIONS);
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

    const chatIdsWithHistory = new Set(store.getChatIds());
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
          // Sealed-сообщения без senderId и «Избранное» непрочитанными не считаем
          if (message.isOutgoing || isSelfChat || !message.senderId) return;
          const uuid = store.getUuidForMessage(chat.id, message.id);
          if (uuid && syncController.getFlags(uuid)?.read) {
            if (message.id > lastReadInbox) lastReadInbox = message.id;
          } else {
            unreadCount += 1;
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
          lastReadOutboxMessageId: syncController.getReadOutboxMax(chat.id),
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
  importChatInvite: groupController.importChatInvite,
  updateChatAdmin: groupController.updateChatAdmin,

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
  // (wallpapers.ts); свою картинку клиент кладёт в CUSTOM_BG_CACHE_NAME сам
  // (WallpaperTile), нам достаточно отдать её как локальный документ
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
    const packs = await loadInstalledPacks(store.self);
    const customSets = packs.map((pack) => {
      const built = buildApiStickerSetFromPack(pack, INSTALLED_PACK_DATE);
      registerPackBlobs(built.blobs);
      return { ...built.set, stickers: undefined, count: built.set.count };
    });
    const hash = `1:${customSets.map(({ id }) => id).sort().join(',')}`;
    return { hash, sets: [{ ...set, stickers: undefined, count: set.count }, ...customSets] };
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
    await saveInstalledPack(store.self, { ...resolved.pack, isEmoji: isEmoji || undefined });
    const built = buildCustomSet(stickerSetId, resolved.pack, INSTALLED_PACK_DATE);
    registerPackBlobs(built.blobs);
    sendUpdate({ '@type': 'updateStickerSet', id: built.set.id, stickerSet: built.set });
    return true;
  },

  async uninstallStickerSet({ stickerSetId }: { stickerSetId: string }) {
    const pack = await findInstalledPackBySetId(store.self, stickerSetId);
    if (!pack) return undefined;
    await removeInstalledPack(store.self, pack.name);
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
      const authorizations: Record<string, ApiSession> = {};
      response.devices.forEach((device) => {
        authorizations[device.device_id] = buildDeviceSession(device, currentDeviceId);
      });
      return { authorizations, ttlDays: undefined };
    } catch {
      return undefined;
    }
  },

  // hash = device_id ('' — legacy-primary: desktop или прежняя web-установка).
  // Текущее устройство не отзываем — UI его и не предлагает
  async terminateAuthorization(hash: string) {
    if (!e2e || hash === e2e.deviceId) return undefined;
    return revokeOwnDevice(hash);
  },

  async terminateAllAuthorizations() {
    if (!connection || !e2e) return undefined;
    const list = await methods.fetchAuthorizations();
    if (!list) return undefined;
    const others = Object.keys(list.authorizations)
      .filter((deviceId) => deviceId !== e2e!.deviceId);
    const results = await Promise.all(others.map((deviceId) => revokeOwnDevice(deviceId)));
    return results.every(Boolean) ? true : undefined;
  },

  // ── Авто-линковка истории: методы для Settings → Devices ────────────────────

  // Новое устройство: статус собственного оффера (код показывается в UI,
  // пользователь сверяет его на старом устройстве перед подтверждением)
  parvaneGetLinkStatus() {
    const isPending = Boolean(linkRuntime.timer && linkRuntime.code && e2e?.needsHistoryLink());
    return Promise.resolve({ isPending, code: isPending ? linkRuntime.code : undefined });
  },

  // Старое устройство: запросы линковки от других устройств аккаунта
  async parvaneListLinkOffers() {
    if (!connection || !e2e) return undefined;
    try {
      const raw = await connection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: e2e.deviceId,
      }));
      const response = JSON.parse(raw) as {
        ok: boolean;
        offers?: { device_id: string; eph_pub: string; created_at: number }[];
      };
      if (!response.ok || !response.offers) return undefined;
      return {
        offers: await Promise.all(response.offers.map(async (offer) => ({
          deviceId: offer.device_id,
          code: await sasCodeForEphPub(offer.eph_pub),
        }))),
      };
    } catch {
      return undefined;
    }
  },

  // Старое устройство: подтверждённая передача истории целевому устройству.
  // Экспорт шифруется случайным ключом и уезжает в cloud (owner-only),
  // координаты и ключ — в ECDH-боксе под эфемерным ключом оффера
  async parvaneGrantLink({ deviceId }: { deviceId: string }) {
    const engine = e2e;
    const activeConnection = connection;
    if (!engine || !activeConnection) return undefined;
    try {
      const pollRaw = await activeConnection.request(TOPIC_LINK_POLL, JSON.stringify({
        token, device_id: engine.deviceId,
      }));
      const poll = JSON.parse(pollRaw) as {
        ok: boolean;
        offers?: { device_id: string; eph_pub: string }[];
      };
      const offer = poll.ok ? poll.offers?.find((entry) => entry.device_id === deviceId) : undefined;
      if (!offer) return undefined;

      await engine.flushStorage();
      const exportJson = engine.exportStateJson();
      const upload = await mediaService.uploadBlob(
        new Blob([exportJson]), 'link-transfer', 'application/octet-stream', { encrypt: true },
      );
      if (!upload.mediaKeys) return undefined;

      const keyPair = await generateLinkKeyPair();
      const ephPub = await exportLinkPublicKey(keyPair);
      const box = await sealLinkBox(keyPair.privateKey, offer.eph_pub, {
        file_id: upload.fileId,
        file_key: upload.mediaKeys.keyB64,
        file_nonce: upload.mediaKeys.nonceB64,
      });
      const grantRaw = await activeConnection.request(TOPIC_LINK_GRANT, JSON.stringify({
        token, device_id: deviceId, box_payload: box, eph_pub: ephPub,
      }));
      return (JSON.parse(grantRaw) as { ok?: boolean }).ok ? true : undefined;
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
      return (JSON.parse(raw) as { ok?: boolean }).ok ? true : undefined;
    } catch {
      return undefined;
    }
  },

  // ── C1: бэкап E2E-ключей (перенос на другое устройство) ─────────────────────

  async parvaneExportE2eKeys({ password }: { password: string }) {
    if (!e2e) return undefined;
    await e2e.flushStorage();
    return { payload: await e2e.exportEncrypted(password) };
  },

  async parvaneImportE2eKeys({ payload, password }: { payload: string; password: string }) {
    if (!store.self) return undefined;
    try {
      const imported = await E2eEngine.importEncrypted(store.self, payload, password);
      setE2eEngine(imported);
      // Полный ресинк с восстановленным состоянием: старая sealed-история
      // расшифруется из привезённого decCache
      syncController.reset();
      resetPackRegistries();
      sendUpdate({ '@type': 'requestSync' });
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
      const built = buildCustomSet(getSetIdForPackName(pack.name), pack, INSTALLED_PACK_DATE);
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
    if (!missing.size) return found;
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
    });
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

  async updateProfile({ firstName, lastName }: { firstName?: string; lastName?: string; about?: string }) {
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (!connection || !displayName) return undefined;
    await connection.request(TOPIC_IDENTITY_SETNAME, JSON.stringify({ token, display_name: displayName }));
    store.setDisplayName(store.self, displayName);
    const user = store.buildApiUser(store.self);
    sendUpdate({ '@type': 'updateUser', id: user.id, user });
    sendUpdate({ '@type': 'updateCurrentUser', currentUser: user, currentUserFullInfo: {} });
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

  fetchCurrentUser() {
    return Promise.resolve(undefined);
  },

  // Профиль контакта: bio/username локальны у Parvane (нет серверного
  // профиля), но full-user нужен, чтобы экран профиля не оставался пустым
  fetchFullUser({ id }: { id: string }) {
    const address = store.getAddressForId(id);
    if (!address) return Promise.resolve(undefined);
    const user = store.buildApiUser(address);
    const isBlocked = localState.loadBlocked().includes(address);
    // `loadFullUser` без guard'ов читает `users`/`chats`/`userStatusesById` —
    // отдаём полную форму ответа, иначе TypeError в экшене
    return Promise.resolve({
      user,
      fullInfo: { isBlocked, commonChatsCount: 0 },
      users: [user],
      chats: [],
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
        await clearSecureCredential(user).catch(() => undefined);
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
