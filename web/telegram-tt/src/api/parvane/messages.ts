import type { SendMessageParams } from '../../types';
import type {
  ApiChat, ApiMessage, ApiMessageEntity, ApiOnProgress, ApiSticker, ApiUpdate, ApiUser, ApiVideo,
} from '../types';
import type { GatewayConnection } from './gateway';
import type { createLocalState } from './localState';
import type { createMediaService } from './media';
import type { PollStore } from './polls';
import type { StoredPack } from './stickerPacks';
import type { ParvaneStore } from './store';
import type { createSyncController } from './sync';
import type { TaskOfferStore } from './taskOffers';
import type { createV2Controller } from './v2/controller';
import { ApiMessageEntityTypes, MAIN_THREAD_ID } from '../types';

import { E2E_SEND_ERROR, E2eSendError } from './e2eSendPolicy';
import { apiEntitiesToWire } from './entities';
import {
  buildApiVideoFromSavedRecord,
  loadSavedGifRecords,
  type SavedGifRecord,
  storeSavedGifRecords,
} from './gifs';
import {
  buildPvpkArchive,
  findInstalledPackBySetId,
  getEmojiPackRawName,
  getEmojiSetIdForDocId,
  getPendingFiles,
  isCustomPackSetId,
  isEmojiPackSetId,
} from './stickerPacks';
import { buildBuiltinEmojiPack, getBuiltinEmojiSetId } from './stickers';
import { taskOfferText, taskResponseText } from './taskOffers';
import { newMessageId, type WireMessageContent, type WirePackRef } from './wire';

type MessageDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  localState: ReturnType<typeof createLocalState>;
  media: ReturnType<typeof createMediaService>;
  polls: PollStore;
  // spec 011: задания в чат
  taskOffers: TaskOfferStore;
  sync: ReturnType<typeof createSyncController>;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  collectUsersFor: (messages: ApiMessage[]) => ApiUser[];
  clearPersistedDraft: (address: string) => void;
  log: (message: string) => void;
  // Файлы полученного, но не установленного пака (по pack_ref из cloud) и
  // дозагрузка документов эмодзи по docId (заполняет реестр docId → набор)
  resolveCustomPack?: (setId: string) => Promise<{ pack: StoredPack } | undefined>;
  primeCustomEmoji?: (docIds: string[]) => Promise<unknown>;
  // Протокол v2 (spec 007): переписка идёт только им (T110). Опционален ради
  // юнит-тестов отдельных функций контроллера
  v2?: ReturnType<typeof createV2Controller>;
  // «Удалить чат у себя» — в журнал личного состояния v2 (T145): остальные свои
  // устройства скрывают сообщения чата не позже границы (мс)
  recordChatCleared?: (address: string, untilMs: number) => void;
};

const PACK_REF_CACHE_LIMIT = 64;
const MS_IN_SECOND = 1000;

type CachedPackRef = { recipients: string[]; ref: WirePackRef };

// Ключ кэша загруженного архива пака: набор + отпечаток содержимого (тот же
// набор, пересобранный с другими файлами, не должен переиспользовать архив).
// Раньше отпечатком было «число файлов : суммарный размер» — пак, пересобранный
// с файлами той же общей длины, брал чужой архив
export async function packRefCacheKey(setId: string, files: Array<{ data: ArrayBuffer }>) {
  const totalBytes = files.reduce((sum, file) => sum + file.data.byteLength, 0);
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  files.forEach((file) => {
    joined.set(new Uint8Array(file.data), offset);
    offset += file.data.byteLength;
  });
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', joined.buffer));
  const digest = Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${setId}|${files.length}:${digest}`;
}

// PACK-1: архив в cloud доступен только получателям, названным при загрузке —
// переиспользовать можно, только если все новые получатели в том наборе
// Метка кэша ссылок на пак: ссылка с секретом скачивания (не привязана к получателям)
const PACK_REF_CAPABILITY = 'capability:';

export function shouldReusePackRef(cachedRecipients: string[], nextRecipients: string[]) {
  const cached = new Set(cachedRecipients);
  return nextRecipients.every((recipient) => cached.has(recipient));
}

const EXT_BY_STICKER_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'video/webm': 'webm',
  'application/x-tgsticker': 'tgs',
};

const LIVE_LOCATION_UPDATE_MS = 15000;
const EMOJI_PACKS_PER_MESSAGE = 4;
const LIVE_LOCATION_POSITION_TIMEOUT_MS = 10000;

// Собеседник без журнала устройств v2 (протокол v1 отключён, T110) — доставить нечем
const V2_PEER_REQUIRED = 'The recipient has no devices on protocol v2.';

export function createMessageController(deps: MessageDependencies) {
  // Чат, мутации которого может взять v2: личный или группа v2 (группы v1 —
  // только история, писать в них нечем)
  function isV2Routable(address: string) {
    return !deps.getStore().isGroupAddress(address) || Boolean(deps.v2?.isV2GroupAddress(address));
  }

  // Стек v2 обязан принять операцию чата; иначе — отказ (без v1 понижать некуда)
  function requireV2() {
    if (!deps.v2) throw new E2eSendError('Protocol v2 stack is unavailable.');
    return deps.v2;
  }

  const uuidBySentLocalKey = new Map<string, string>();
  const savedGifs: ApiVideo[] = [];
  // Кэш загруженных в cloud архивов паков на сессию: ключ набор+отпечаток,
  // значение — архивы под разные наборы получателей (PACK-1)
  const uploadedPackRefs = new Map<string, CachedPackRef[]>();

  const connection = () => deps.getConnection();

  // Смена аккаунта / logout: ничего из сессии прежнего пользователя не должно
  // пережить (persist считается от текущего self)
  function reset() {
    uuidBySentLocalKey.clear();
    uploadedPackRefs.clear();
    liveLocations.forEach((entry) => {
      if (entry.timer) clearInterval(entry.timer);
    });
    liveLocations.clear();
  }
  const store = () => deps.getStore();

  // Блоб вложения — без per-recipient гранта (CAP-1, FR-062, T131): секрет
  // скачивания едет внутри E2E-содержимого, получатель качает блоб анонимным
  // каналом. Чат обязан быть v2 — иначе отправка откажет
  function mediaUploadOptions(): { encrypt: true; withCapability: true } {
    return { encrypt: true, withCapability: true };
  }

  // Пересылка зашифрованного медиа в другой чат: скачать (или взять из кэша)
  // расшифрованный блоб и выгрузить заново под новым секретом. undefined —
  // оставить как есть (блоб недоступен)
  async function reshareMedia(fileId: string, toAddress: string) {
    const cached = await deps.media.getCached(fileId)?.catch(() => undefined)
      || await deps.media.downloadBlob(fileId).catch(() => undefined);
    if (!cached) return undefined;
    const mimeType = cached.mimeType || cached.blob.type || 'application/octet-stream';
    const upload = await deps.media.uploadBlob(cached.blob, `forward-${fileId}`, mimeType, mediaUploadOptions());
    if (!upload.mediaKeys) return undefined;
    deps.media.cacheBlob(upload.fileId, cached.blob, mimeType);
    return {
      oldId: fileId,
      fileId: upload.fileId,
      keyB64: upload.mediaKeys.keyB64,
      nonceB64: upload.mediaKeys.nonceB64,
      capability: upload.capability,
    };
  }

  function replaceMediaId(content: ApiMessage['content'], oldId: string, newId: string): ApiMessage['content'] {
    const next = { ...content };
    (['photo', 'document', 'video', 'voice', 'audio', 'sticker'] as const).forEach((key) => {
      const media = next[key] as { id?: string } | undefined;
      if (media?.id === oldId) {
        (next as Record<string, unknown>)[key] = { ...media, id: newId };
      }
    });
    return next;
  }

  async function publishInner(
    toAddress: string,
    wireContent: Record<string, unknown>,
    uuid = newMessageId(),
    replyTo?: string,
  ) {
    const currentStore = store();
    const ts = Math.floor(Date.now() / 1000);
    // TTL-эфемерное не журналируем — после срока сообщение не должно
    // восстанавливаться из журнала (как desktop)
    const isEphemeral = Boolean(wireContent.ttl_secs);
    const isSent = await requireV2().trySend(toAddress, wireContent as unknown as WireMessageContent, uuid, replyTo);
    if (!isSent) throw new E2eSendError(V2_PEER_REQUIRED);
    if (!isEphemeral) {
      deps.localState.appendOwnJournal({
        id: uuid,
        from: currentStore.self,
        to: toAddress,
        content: wireContent as never,
        ts,
        reply_to: replyTo,
        origin: 'v2',
      });
    }
    return uuid;
  }

  // Гидратация сохранённых GIF из IndexedDB — один раз на пользователя;
  // до её завершения персист не пишем, чтобы не затереть сохранённое.
  // Пришедшие до гидратации гифы этой сессии остаются в начале списка
  let savedGifsHydratedFor = '';
  let savedGifsHydration: Promise<void> | undefined;

  function resetSavedGifs() {
    savedGifs.length = 0;
    savedGifsHydratedFor = '';
    savedGifsHydration = undefined;
  }

  function ensureSavedGifsHydrated() {
    const self = store().self;
    if (!self) return Promise.resolve();
    if (savedGifsHydratedFor !== self) {
      savedGifsHydratedFor = self;
      savedGifsHydration = loadSavedGifRecords(self).then((records) => {
        records.forEach((record) => {
          if (savedGifs.some((candidate) => candidate.id === record.id)) return;
          if (record.keyB64 && record.nonceB64) {
            deps.media.rememberKeys({
              kind: 'gif', file_id: record.id, file_key: record.keyB64, file_nonce: record.nonceB64, mime: 'video/webm',
            });
          }
          savedGifs.push(buildApiVideoFromSavedRecord(record));
        });
      }).catch(() => undefined);
    }
    return savedGifsHydration || Promise.resolve();
  }

  function persistSavedGifs() {
    const self = store().self;
    if (!self) return;
    void ensureSavedGifsHydrated().then(() => {
      // Встроенные canvas-гифы не персистим — они генерируются на месте
      const records: SavedGifRecord[] = savedGifs
        .filter((gif) => !gif.id.startsWith('pvgif'))
        .map((gif) => {
          const keys = deps.media.getMediaKeys(gif.id);
          return {
            id: gif.id,
            width: gif.width,
            height: gif.height,
            duration: gif.duration,
            size: gif.size,
            keyB64: keys?.keyB64,
            nonceB64: keys?.nonceB64,
          };
        });
      void storeSavedGifRecords(self, records);
    });
  }

  function rememberSavedGif(gif: ApiVideo) {
    if (savedGifs.some((candidate) => candidate.id === gif.id)) return;
    savedGifs.unshift(gif);
    persistSavedGifs();
  }

  async function sendGif(chat: ApiChat, gif: ApiVideo) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    const cached = await deps.media.getCached(gif.id);
    const blob = cached?.blob || (
      gif.blobUrl ? await fetch(gif.blobUrl).then((response) => response.blob()) : undefined
    );
    if (!blob) return;
    const { fileId, mediaKeys, capability } = await deps.media.uploadBlob(
      blob, `${gif.id}.webm`, 'video/webm', mediaUploadOptions(),
    );
    const mediaCrypto = mediaKeys
      ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64, capability } : {};
    const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
    const wireContent: Record<string, unknown> = {
      kind: 'gif',
      file_id: fileId,
      filename: `${gif.id}.webm`,
      mime: 'video/webm',
      width: gif.width || 240,
      height: gif.height || 240,
      duration_secs: Math.round(gif.duration),
      size_bytes: blob.size,
      ttl_secs: ttlSecs || undefined,
      ...mediaCrypto,
    };
    deps.media.cacheBlob(fileId, blob, 'video/webm');
    const uuid = await publishInner(toAddress, wireContent);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const sentGif = { ...gif, id: fileId };
    rememberSavedGif(sentGif);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { video: sentGif },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
    if (ttlSecs) deps.localState.scheduleTtlDeletion(chat.id, id, ttlSecs);
  }

  // Архив пака грузится в cloud под каждый новый набор получателей (PACK-1:
  // доступ к архиву выдаётся списку, названному при загрузке), получатель по
  // pack_ref сможет установить весь набор (конвенция desktop-форка)
  // Кастом-эмодзи в тексте (entity custom_emoji → docId → пак): приложить
  // pack_ref паков, чтобы получатель (web/desktop) материализовал их. Лимит и
  // формат — как в desktop BuildEmojiPacks
  // Ссылки прошлой версии сообщения + ссылки текущего текста, без дублей по
  // file_id и не длиннее лимита на сообщение
  function mergePackRefs(previous: WirePackRef[] | undefined, next: WirePackRef[]) {
    const merged: WirePackRef[] = [];
    const seen = new Set<string>();
    for (const ref of [...next, ...(previous || [])]) {
      if (seen.has(ref.file_id)) continue;
      seen.add(ref.file_id);
      merged.push(ref);
    }
    return merged.length ? merged.slice(0, EMOJI_PACKS_PER_MESSAGE) : undefined;
  }

  async function buildEmojiPackRefs(
    entities: ApiMessageEntity[] | undefined, toAddress: string,
  ): Promise<WirePackRef[]> {
    const docIds = (entities || [])
      .filter((entity) => entity.type === ApiMessageEntityTypes.CustomEmoji && entity.documentId)
      .map((entity) => (entity as { documentId: string }).documentId);
    // Пересылка эмодзи из неустановленного пака: набор ещё не собран в этой
    // сессии — дозагружаем документы, это заполняет реестр docId → набор
    const unknown = docIds.filter((docId) => !getEmojiSetIdForDocId(docId));
    if (unknown.length && deps.primeCustomEmoji) await deps.primeCustomEmoji(unknown).catch(() => undefined);
    const setIds = new Set<string>();
    docIds.forEach((docId) => {
      const setId = getEmojiSetIdForDocId(docId);
      if (setId) setIds.add(setId);
    });
    const refs: WirePackRef[] = [];
    for (const setId of Array.from(setIds).slice(0, EMOJI_PACKS_PER_MESSAGE)) {
      const ref = await buildPackRefForSet(setId, toAddress);
      if (ref) refs.push(ref);
    }
    return refs;
  }

  async function findPackFiles(setId: string): Promise<StoredPack | undefined> {
    if (setId === getBuiltinEmojiSetId()) return buildBuiltinEmojiPack();
    const installed = await findInstalledPackBySetId(store().self, setId);
    if (installed) return installed;
    const pending = getPendingFiles(setId);
    if (pending) return pending;
    return (await deps.resolveCustomPack?.(setId).catch(() => undefined))?.pack;
  }

  async function buildPackRefForSet(setId: string, toAddress: string): Promise<WirePackRef | undefined> {
    const pack = await findPackFiles(setId);
    if (!pack) return undefined;
    const uploadOptions = mediaUploadOptions();
    // Ссылка с секретом скачивания годится любому v2-чату
    const recipients = [PACK_REF_CAPABILITY];
    const cacheKey = await packRefCacheKey(setId, pack.files);
    const cachedRefs = uploadedPackRefs.get(cacheKey) || [];
    const reusable = cachedRefs.find((entry) => shouldReusePackRef(entry.recipients, recipients));
    if (reusable) return reusable.ref;
    const archive = buildPvpkArchive(pack.files);
    if (!archive) return undefined;
    const { fileId, mediaKeys, capability } = await deps.media.uploadBlob(
      new Blob([archive as BlobPart], { type: 'application/octet-stream' }),
      'pack.pvpk',
      'application/octet-stream',
      uploadOptions,
    );
    // EMOJI-1: в ссылке — ровно то имя, от которого считались docId
    const isEmoji = pack.isEmoji || isEmojiPackSetId(setId);
    const refName = isEmoji ? (pack.rawName || getEmojiPackRawName(setId) || pack.name) : pack.name;
    const ref: WirePackRef = {
      file_id: fileId,
      name: refName,
      count: pack.files.length,
      key: mediaKeys?.keyB64,
      nonce: mediaKeys?.nonceB64,
      capability,
    };
    uploadedPackRefs.delete(cacheKey);
    uploadedPackRefs.set(cacheKey, [...cachedRefs, { recipients, ref }]);
    if (uploadedPackRefs.size > PACK_REF_CACHE_LIMIT) {
      const oldest = uploadedPackRefs.keys().next().value;
      if (oldest !== undefined) uploadedPackRefs.delete(oldest);
    }
    deps.log(`пак «${pack.name}» загружен в cloud (${archive.length} байт)`);
    return ref;
  }

  async function sendSticker(chat: ApiChat, sticker: ApiSticker) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    const cached = await deps.media.getCached(sticker.id);
    const blob = cached?.blob;
    if (!blob) return;
    const mime = cached.mimeType || 'image/png';
    const extension = EXT_BY_STICKER_MIME[mime] || 'png';
    const { fileId, mediaKeys, capability } = await deps.media.uploadBlob(
      blob,
      `sticker-${sticker.id}.${extension}`,
      mime,
      mediaUploadOptions(),
    );
    const mediaCrypto = mediaKeys
      ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64, capability } : {};
    const setId = 'id' in sticker.stickerSetInfo ? sticker.stickerSetInfo.id : undefined;
    const packRef = setId && isCustomPackSetId(setId)
      ? await buildPackRefForSet(setId, toAddress)
      : undefined;
    const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
    const wireContent: Record<string, unknown> = {
      kind: 'sticker',
      file_id: fileId,
      filename: sticker.emoji || '⭐',
      mime,
      width: sticker.width || 256,
      height: sticker.height || 256,
      pack_ref: packRef,
      ttl_secs: ttlSecs || undefined,
      ...mediaCrypto,
    };
    deps.media.cacheBlob(fileId, blob, mime);
    const uuid = await publishInner(toAddress, wireContent);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { sticker: { ...sticker, id: fileId } },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
    if (ttlSecs) deps.localState.scheduleTtlDeletion(chat.id, id, ttlSecs);
  }

  // Карточка задания обновляется как опрос: тот же `updateMessage` с полным содержимым
  function refreshTaskOfferMessage(uuid: string) {
    const chatId = deps.taskOffers.getChatId(uuid);
    if (!chatId) return;
    const currentStore = store();
    const messageId = currentStore.allocateMessageId(chatId, uuid);
    const taskOffer = deps.taskOffers.build(uuid);
    const message = currentStore.getMessages(chatId).find((candidate) => candidate.id === messageId);
    if (taskOffer && message) {
      // В стор тоже: чат, открытый позже (после восстановления из кэша), берёт сообщения из стора,
      // и без этого карточка показывала бы решения, какими они были на момент сборки строки
      const updated: ApiMessage = { ...message, content: { taskOffer } };
      currentStore.putMessage(updated);
      deps.sendUpdate({ '@type': 'updateMessage', chatId, id: messageId, isFull: true, message: updated });
    }
  }

  // Принятое задание — задача в планировщике получателя (spec 011, FR-019): один
  // раз на аккаунт (поле `source` задачи), на других устройствах — через контейнер
  type TaskOfferPlanResult = 'ok' | 'exists' | 'needs-linking' | 'no-key' | 'unavailable';

  function addTaskOfferToPlan(uuid: string, toAddress: string): TaskOfferPlanResult {
    const entry = deps.taskOffers.get(uuid);
    const planner = deps.v2?.planner;
    if (!entry || !planner) return 'unavailable';
    const status = planner.status();
    if (status === 'needs-linking' || status === 'no-key') return status;
    const json = planner.stateJson();
    const state = json ? JSON.parse(json) as { tasks?: { source?: { opId?: string } | null }[] } : undefined;
    // `Source.op_id` домена — hex без дефисов (движок отвергает иные символы)
    const opId = uuid.replace(/-/g, '');
    if (state?.tasks?.some((task) => task.source?.opId === opId)) return 'exists';
    planner.apply([{
      task: {
        id: newMessageId(),
        name: entry.name,
        description: entry.description,
        steps: entry.steps.map((text) => ({ text, isDone: false })),
        status: 'queue',
        listId: '',
        rank: 0,
        day: entry.day || '',
        start: entry.start || '',
        due: entry.due || '',
        // eslint-disable-next-line no-null/no-null -- JSON движка: null = «без оценки»
        minutes: entry.minutes ?? null,
        source: { chat: toAddress, opId },
      },
    }]);
    return 'ok';
  }

  function refreshPollMessage(uuid: string) {
    const chatId = deps.polls.getChatId(uuid);
    if (!chatId) return;
    const currentStore = store();
    const messageId = currentStore.allocateMessageId(chatId, uuid);
    const poll = deps.polls.build(uuid);
    const message = currentStore.getMessages(chatId).find((candidate) => candidate.id === messageId);
    if (poll && message) {
      deps.sendUpdate({ '@type': 'updateMessage', chatId, id: messageId, isFull: true, message, poll });
    }
  }

  async function sendPoll(chat: ApiChat, newPoll: {
    summary: {
      question: { text: string };
      answers: { text: { text: string } }[];
      isPublic?: true;
      isMultipleChoice?: true;
      isQuiz?: true;
    };
    correctAnswers?: number[];
    solution?: string;
  }) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    const question = newPoll.summary.question.text;
    const options = newPoll.summary.answers.map((answer) => answer.text.text);
    const isQuiz = Boolean(newPoll.summary.isQuiz);
    const uuid = newMessageId();
    deps.polls.register(uuid, chat.id, question, options, {
      author: currentStore.self,
      isPublic: Boolean(newPoll.summary.isPublic),
      isMultiple: Boolean(newPoll.summary.isMultipleChoice),
      isQuiz,
      correct: newPoll.correctAnswers,
      solution: newPoll.solution,
    });
    await publishInner(toAddress, {
      kind: 'poll',
      question,
      options,
      is_public: newPoll.summary.isPublic || undefined,
      is_multiple: newPoll.summary.isMultipleChoice || undefined,
      is_quiz: isQuiz || undefined,
      correct: isQuiz ? newPoll.correctAnswers : undefined,
      solution: isQuiz ? newPoll.solution : undefined,
    }, uuid);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { pollId: uuid },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message, poll: deps.polls.build(uuid) });
  }

  function reportEncryptionSendFailure(chatId: string, localId: number, detail?: unknown) {
    const detailMessage = detail instanceof Error ? detail.message : '';
    deps.log(`${E2E_SEND_ERROR}${detailMessage ? ` ${detailMessage}` : ''}`);
    deps.sendUpdate({
      '@type': 'updateMessageSendFailed', chatId, localId, error: E2E_SEND_ERROR,
    });
  }

  function sendMessageLocal(params: SendMessageParams, fixedUuid?: string) {
    const { chat, replyInfo } = params;
    if (!chat) return Promise.resolve(undefined);
    const currentStore = store();
    const uuid = fixedUuid || newMessageId();
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const replyToMsgId = replyInfo?.type === 'message' ? replyInfo.replyToMsgId : undefined;
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: deps.media.buildLocalContent(uuid, params),
      date: Math.floor(Date.now() / 1000),
      isForwardingAllowed: true,
      isOutgoing: true,
      senderId: deps.selfId(),
      sendingState: 'messageSendingStatePending',
      replyInfo: replyToMsgId ? { type: 'message', replyToMsgId } : undefined,
    };
    uuidBySentLocalKey.set(`${chat.id}:${id}`, uuid);
    deps.sendUpdate({
      '@type': 'newMessage', chatId: chat.id, id, message, wasDrafted: params.wasDrafted,
    });
    return Promise.resolve(message);
  }

  // Отложенное из журнала личного состояния (T098) уходит с op_id отложенного:
  // копию, отправленную другим устройством, получатель отсечёт как дубль
  function sendMessageWithUuid(params: SendMessageParams, uuid?: string) {
    return sendMessage(params, undefined, uuid);
  }

  async function sendMessage(params: SendMessageParams, _onProgress?: ApiOnProgress, fixedUuid?: string) {
    if (params.scheduledAt && params.chat) {
      deps.localState.scheduleMessage(params);
      return;
    }
    if (params.poll && params.chat) {
      await sendPoll(params.chat, params.poll);
      return;
    }
    if (params.sticker && params.chat) {
      await sendSticker(params.chat, params.sticker);
      return;
    }
    if (params.gif && params.chat) {
      await sendGif(params.chat, params.gif);
      return;
    }

    const localMessage = params.localMessage || await sendMessageLocal(params, fixedUuid);
    const { chat, attachment } = params;
    if (!localMessage || !chat) return;
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    // Отправка гасит persisted-черновик: tt чистит его только в памяти
    // (clearDraft isLocalOnly), до провайдера это не доходит
    deps.clearPersistedDraft(toAddress);

    const uuid = uuidBySentLocalKey.get(`${chat.id}:${localMessage.id}`) || newMessageId();
    const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;
    const replyToUuid = replyToMsgId ? currentStore.getUuidForMessage(chat.id, replyToMsgId) : undefined;
    const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
    // Богатое превью тянем с шарда (SSRF-safe); короткий дедлайн, деградация к
    // hostname. При noWebPage наружу не ходим вовсе
    const webpage = params.noWebPage ? undefined : await deps.media.fetchWebPagePreview(params.text);
    // Только для текстовой отправки: ветка вложения ниже целиком заменяет
    // wireContent, а подпись в проводе — простая строка без entities, так что
    // архив пака (PACK-1 грузит его под набор получателей) ушёл бы в cloud зря
    const emojiPacks = attachment ? [] : await buildEmojiPackRefs(params.entities, toAddress);
    let wireContent: Record<string, unknown> = {
      kind: 'text',
      text: params.text || '',
      entities: apiEntitiesToWire(params.entities),
      webpage,
      ttl_secs: ttlSecs || undefined,
      emoji_packs: emojiPacks.length ? emojiPacks : undefined,
    };
    let sentContent = localMessage.content;
    if (attachment) {
      try {
        const blob: Blob = attachment.blob ?? await fetch(attachment.blobUrl).then((response) => response.blob());
        // Local echo играет/скачивает по id локального uuid; кэшируем блоб под
        // ним до аплоада, иначе обращение до/после подмены контента упирается в
        // несуществующий file_id (у voice плеер фиксирует audio.src навсегда)
        deps.media.cacheBlob(uuid, blob, attachment.mimeType || 'application/octet-stream');
        const {
          fileId, size, mediaKeys, capability,
        } = await deps.media.uploadBlob(
          blob,
          attachment.filename,
          attachment.mimeType,
          mediaUploadOptions(),
        );
        const mediaCrypto = mediaKeys
          ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64, capability } : {};
        if (attachment.voice) {
          wireContent = {
            kind: 'voice',
            file_id: fileId,
            duration_secs: Math.max(1, Math.round(attachment.voice.duration)),
            mime: attachment.mimeType || 'audio/ogg',
            size_bytes: size,
            waveform: attachment.voice.waveform,
            ttl_secs: ttlSecs || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            voice: {
              mediaType: 'voice',
              id: fileId,
              duration: attachment.voice.duration,
              waveform: attachment.voice.waveform,
              size,
            },
          };
        } else if (attachment.isRoundVideo || deps.media.isVideoAttachment(attachment)) {
          const isRound = Boolean(attachment.isRoundVideo);
          const quick = attachment.quick;
          wireContent = {
            kind: isRound ? 'video_note' : 'video',
            file_id: fileId,
            duration_secs: Math.max(1, Math.round(quick?.duration || 1)),
            width: quick?.width || (isRound ? 384 : 640),
            height: quick?.height || (isRound ? 384 : 480),
            mime: attachment.mimeType,
            size_bytes: size,
            caption: isRound ? undefined : params.text || undefined,
            ttl_secs: ttlSecs || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text && !isRound ? { text: { text: params.text } } : {}),
            video: {
              mediaType: 'video',
              id: fileId,
              isRound: isRound || undefined,
              mimeType: attachment.mimeType,
              duration: quick?.duration || 1,
              fileName: attachment.filename,
              width: quick?.width,
              height: quick?.height,
              size,
              blobUrl: attachment.blobUrl,
              previewBlobUrl: attachment.previewBlobUrl,
            },
          };
        } else if (attachment.audio) {
          wireContent = {
            kind: 'file',
            file_id: fileId,
            filename: attachment.filename,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            duration_secs: Math.round(attachment.audio.duration) || undefined,
            audio_title: attachment.audio.title,
            audio_performer: attachment.audio.performer,
            ttl_secs: ttlSecs || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            audio: {
              mediaType: 'audio',
              id: fileId,
              size,
              mimeType: attachment.mimeType,
              fileName: attachment.filename,
              duration: attachment.audio.duration,
              title: attachment.audio.title,
              performer: attachment.audio.performer,
            },
          };
        } else if (deps.media.isPhotoAttachment(attachment)) {
          wireContent = {
            kind: 'photo',
            file_id: fileId,
            width: attachment.quick!.width,
            height: attachment.quick!.height,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ttl_secs: ttlSecs || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            photo: {
              mediaType: 'photo',
              id: fileId,
              date: localMessage.date,
              blobUrl: attachment.blobUrl,
              sizes: [
                { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
                { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
              ],
            },
          };
        } else {
          wireContent = {
            kind: 'file',
            file_id: fileId,
            filename: attachment.filename,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ttl_secs: ttlSecs || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            document: {
              mediaType: 'document',
              id: fileId,
              fileName: attachment.filename,
              size,
              mimeType: attachment.mimeType,
              timestamp: localMessage.date,
            },
          };
        }
      } catch (error) {
        deps.log(`загрузка вложения не удалась: ${String(error)}`);
        deps.sendUpdate({
          '@type': 'updateMessageSendFailed', chatId: chat.id, localId: localMessage.id, error: 'Upload failed',
        });
        return;
      }
    }

    const plainContent = wireContent;
    const ts = Math.floor(Date.now() / 1000);
    try {
      // Протокол v2: собеседник или группа с журналом (D-13); иначе отправить нечем
      const isSentViaV2 = await requireV2().trySend(
        toAddress, wireContent as unknown as WireMessageContent, uuid, replyToUuid,
      );
      if (!isSentViaV2) throw new E2eSendError(V2_PEER_REQUIRED);
    } catch (error) {
      reportEncryptionSendFailure(chat.id, localMessage.id, error);
      return;
    }
    if (!ttlSecs) {
      deps.localState.appendOwnJournal({
        id: uuid,
        from: currentStore.self,
        to: toAddress,
        content: plainContent as unknown as WireMessageContent,
        ts,
        reply_to: replyToUuid,
        origin: 'v2',
      });
    }
    const sentMessage: ApiMessage = { ...localMessage, content: sentContent, sendingState: undefined };
    currentStore.putMessage(sentMessage);
    deps.sendUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message: sentMessage,
    });
    if (ttlSecs) deps.localState.scheduleTtlDeletion(chat.id, localMessage.id, ttlSecs);
  }

  // Прочтения — E2E-квитанции, их знает только движок (серверу v2 не видно,
  // кто что прочитал)
  async function requestReaders(chatId: string, messageId: number) {
    const currentStore = store();
    const uuid = currentStore.getUuidForMessage(chatId, messageId);
    const address = currentStore.getAddressForId(chatId);
    if (!uuid || !address || !deps.v2 || !isV2Routable(address)) return undefined;
    if (!(await deps.v2.isV2Chat(address).catch(() => false))) return undefined;
    return deps.v2.readers(uuid);
  }

  // Правка содержимого сообщения: мутация v2. Общий путь для правки
  // текста/подписи и для обновлений live-локации
  async function publishEditedContent(uuid: string, toAddress: string, plainContent: WireMessageContent) {
    const currentStore = store();
    if (!connection()) return;
    // «Избранное» без других устройств — только локально; собеседник не на v2 —
    // править нечем
    const isEdited = await requireV2().tryEdit(toAddress, uuid, plainContent);
    if (!isEdited && toAddress !== currentStore.self) throw new E2eSendError(V2_PEER_REQUIRED);
  }

  // ── Live-локация ─────────────────────────────────────────────────────────
  // Как в Telegram: одно сообщение geoLive, позиция обновляется правками того
  // же сообщения, пока не истечёт period или пользователь не остановит.
  // Активные трансляции персистятся (localStorage) и возобновляются после
  // reload, пока не истёк срок
  type LiveLocationEntry = {
    chatId: string; messageId: number; uuid: string; toAddress: string; date: number; period: number;
  };
  const liveLocations = new Map<string, LiveLocationEntry & { timer?: ReturnType<typeof setInterval> }>();

  function liveLocationsStorageKey() {
    return `parvane:livelocs:${store().self}`;
  }

  function persistLiveLocations() {
    try {
      const entries = Array.from(liveLocations.values()).map(({ timer, ...entry }) => entry);
      localStorage.setItem(liveLocationsStorageKey(), JSON.stringify(entries));
    } catch {
      // приватный режим / квота — трансляция живёт только в памяти
    }
  }

  function readPosition(): Promise<{ lat: number; long: number; heading?: number; accuracy?: number } | undefined> {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(undefined);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          long: pos.coords.longitude,
          heading: typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading)
            ? Math.round(pos.coords.heading) : undefined,
          accuracy: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : undefined,
        }),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: LIVE_LOCATION_POSITION_TIMEOUT_MS, maximumAge: 5000 },
      );
    });
  }

  async function publishLivePosition(
    entry: LiveLocationEntry,
    position: { lat: number; long: number; heading?: number; accuracy?: number },
    period: number,
  ) {
    const currentStore = store();
    const ttlSecs = deps.localState.loadPeerTtl()[entry.toAddress];
    const wireContent: WireMessageContent = {
      kind: 'location',
      lat: position.lat,
      long: position.long,
      live_period: period,
      heading: position.heading,
      accuracy: position.accuracy,
      ttl_secs: ttlSecs || undefined,
    };
    await publishEditedContent(entry.uuid, entry.toAddress, wireContent);
    const current = currentStore.getMessages(entry.chatId).find((m) => m.id === entry.messageId);
    if (!current) return;
    const edited: ApiMessage = {
      ...current,
      content: {
        location: {
          mediaType: 'geoLive',
          geo: {
            lat: position.lat, long: position.long, accessHash: '0', accuracyRadius: position.accuracy,
          },
          heading: position.heading,
          period,
        },
      },
      isEdited: true,
      editDate: Math.floor(Date.now() / 1000),
    };
    currentStore.putMessage(edited);
    deps.sendUpdate({
      '@type': 'updateMessage', chatId: entry.chatId, id: entry.messageId, isFull: true, message: edited,
    });
  }

  function finishLiveLocation(key: string) {
    const entry = liveLocations.get(key);
    if (entry?.timer) clearInterval(entry.timer);
    liveLocations.delete(key);
    persistLiveLocations();
  }

  async function tickLiveLocation(key: string) {
    const entry = liveLocations.get(key);
    if (!entry) return;
    if (Math.floor(Date.now() / 1000) >= entry.date + entry.period) {
      finishLiveLocation(key);
      return;
    }
    const position = await readPosition();
    if (!position || !liveLocations.has(key)) return;
    try {
      await publishLivePosition(entry, position, entry.period);
    } catch (error) {
      deps.log(`live-локация: обновление не отправлено — ${String(error)}`);
    }
  }

  function startLiveLocation(entry: LiveLocationEntry) {
    const key = `${entry.chatId}:${entry.messageId}`;
    finishLiveLocation(key);
    const timer = setInterval(() => {
      void tickLiveLocation(key);
    }, LIVE_LOCATION_UPDATE_MS);
    liveLocations.set(key, { ...entry, timer });
    persistLiveLocations();
  }

  const methods = {
    fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
      const byId = new Map(store().getMessages(chat.id).map((message) => [message.id, message]));
      return Promise.resolve(messageIds.map((id) => byId.get(id)).filter(Boolean));
    },

    async editMessage({
      chat, message, text, entities,
    }: {
      chat: ApiChat; message: ApiMessage; text: string; entities?: ApiMessageEntity[];
    }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, message.id);
      const activeConnection = connection();
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !activeConnection || !toAddress) return undefined;

      const wireEntities = apiEntitiesToWire(entities);
      // Правка не должна терять форматирование и не должна подменять медиа
      // текстом: у медиа-сообщения меняем только подпись (по строке истории
      // движка), у текстового — текст и entities
      const previous = (await deps.v2?.storedMessage(uuid))?.content;
      // Правка обязана нести ссылки на паки так же, как отправка и пересылка:
      // без них entity custom_emoji у получателя не резолвится, а десктоп не
      // материализует пак. Ссылки прошлой версии сохраняем — иначе правка
      // текста снимала бы эмодзи, которые в сообщении уже были
      const isMediaEdit = Boolean(previous && previous.kind !== 'text');
      const emojiPacks = isMediaEdit ? undefined : mergePackRefs(
        previous?.kind === 'text' ? previous.emoji_packs : undefined,
        await buildEmojiPackRefs(entities, toAddress),
      );
      const plainContent: WireMessageContent = previous && previous.kind !== 'text'
        ? { ...previous, caption: text || undefined, entities: wireEntities }
        : {
          kind: 'text', text, entities: wireEntities, emoji_packs: emojiPacks,
        };
      await publishEditedContent(uuid, toAddress, plainContent);
      // Сохраняем медиа/вложение оригинала, обновляя только текст и entities
      const nextText = text ? { text, entities } : undefined;
      const edited: ApiMessage = {
        ...message,
        content: { ...message.content, text: nextText },
        isEdited: true,
      };
      currentStore.putMessage(edited);
      deps.sendUpdate({ '@type': 'updateMessage', chatId: chat.id, id: message.id, isFull: true, message: edited });
      return undefined;
    },

    async deleteMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
      if (!connection()) return undefined;
      const currentStore = store();
      const address = currentStore.getAddressForId(chat.id);
      const uuids = messageIds.map((id) => currentStore.getUuidForMessage(chat.id, id)).filter(Boolean);
      // Чат v2 — мутацией v2; чат без v2 (история v1) — только локально
      if (address && isV2Routable(address) && await deps.v2?.isV2Chat(address)) {
        await deps.v2!.tryDelete(address, uuids);
      }
      uuids.forEach((uuid) => deps.sync.markDeleted(uuid));
      deps.sendUpdate({ '@type': 'deleteMessages', ids: messageIds, chatId: chat.id });
      return undefined;
    },

    // «Удалить чат»: история чата удаляется локально, граница очистки едет
    // журналом личного состояния (T145) — остальные свои устройства скрывают
    // чат по ней. Для «удалить и у собеседника» свои сообщения дополнительно
    // удаляются у всех мутацией v2 — чужие у собеседника остаются (Parvane не
    // даёт удалять чужое). Пустой чат tt снимает из списка по update deleteHistory
    async deleteHistory({ chat, shouldDeleteForAll }: { chat: ApiChat; shouldDeleteForAll?: boolean }) {
      const currentStore = store();
      const uuids: string[] = [];
      const ownUuids: string[] = [];
      let lastDate = 0;
      currentStore.getMessages(chat.id).forEach((message) => {
        const uuid = currentStore.getUuidForMessage(chat.id, message.id);
        if (!uuid) return;
        uuids.push(uuid);
        lastDate = Math.max(lastDate, message.date);
        if (message.isOutgoing) ownUuids.push(uuid);
      });
      const chatAddress = currentStore.getAddressForId(chat.id);
      if (shouldDeleteForAll && ownUuids.length
        && chatAddress && isV2Routable(chatAddress) && await deps.v2?.isV2Chat(chatAddress)) {
        await deps.v2!.tryDelete(chatAddress, ownUuids);
      }
      const address = chatAddress;
      if (address && !currentStore.isGroupAddress(address)) {
        deps.localState.markChatDeleted(address);
        deps.localState.saveDraft(address, undefined);
      }
      // Граница очистки ставится ДО локального удаления: эхо своей копии v2,
      // пришедшее следом, отсеивается по ней (sync.isClearedForMe)
      if (address) {
        deps.recordChatCleared?.(address, lastDate ? lastDate * MS_IN_SECOND + (MS_IN_SECOND - 1) : Date.now());
      }
      await deps.sync.forgetMessages(uuids);
      deps.sendUpdate({ '@type': 'deleteHistory', chatId: chat.id });
      return undefined;
    },

    sendReaction({ chat, messageId, reactions }: {
      chat: ApiChat; messageId: number; reactions?: { type: string; emoticon?: string }[];
    }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      if (!uuid || !connection()) return Promise.resolve(undefined);
      const emoji = reactions?.find((reaction) => reaction.type === 'emoji')?.emoticon || '';
      const reactAddress = currentStore.getAddressForId(chat.id);
      if (reactAddress && isV2Routable(reactAddress)) {
        void deps.v2?.tryReact(reactAddress, uuid, emoji).catch((error: unknown) => {
          deps.log(`реакция не отправлена: ${String(error)}`);
        });
      }
      const message = currentStore.getMessages(chat.id).find((candidate) => candidate.id === messageId);
      if (message) {
        let results = (message.reactions?.results || []).map((reaction) => {
          if (reaction.chosenOrder === undefined) return reaction;
          return { ...reaction, chosenOrder: undefined, count: reaction.count - 1 };
        }).filter((reaction) => reaction.count > 0);
        if (emoji) {
          const existing = results.find(
            (reaction) => reaction.reaction.type === 'emoji' && reaction.reaction.emoticon === emoji,
          );
          results = existing
            ? results.map((reaction) => (
              reaction === existing ? { ...reaction, count: reaction.count + 1, chosenOrder: 0 } : reaction
            ))
            : [...results, { count: 1, reaction: { type: 'emoji' as const, emoticon: emoji }, chosenOrder: 0 }];
        }
        const updated: ApiMessage = { ...message, reactions: { results } };
        currentStore.putMessage(updated);
        deps.sendUpdate({
          '@type': 'updateMessageReactions', chatId: chat.id, id: messageId, reactions: { results },
        });
      }
      return Promise.resolve(true);
    },

    pinMessage({ chat, messageId, isUnpin }: { chat: ApiChat; messageId: number; isUnpin: boolean }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      if (!uuid || !connection()) return Promise.resolve(undefined);
      const pin = !isUnpin;
      const pinAddress = currentStore.getAddressForId(chat.id);
      if (pinAddress && isV2Routable(pinAddress)) {
        void deps.v2?.tryPin(pinAddress, uuid, pin).catch((error: unknown) => {
          deps.log(`закреп не отправлен: ${String(error)}`);
        });
      }
      deps.sendUpdate({ '@type': 'updatePinnedIds', chatId: chat.id, isPinned: pin, messageIds: [messageId] });
      return Promise.resolve(undefined);
    },

    // «Seen by» в группах: список прочитавших с временем из read_receipts
    // шарда (msg.chat.readers). Ключи — id пользователей tt, себя отбрасываем
    async fetchSeenBy({ chat, messageId }: { chat: ApiChat; messageId: number }) {
      const readers = await requestReaders(chat.id, messageId);
      if (!readers) return undefined;
      const currentStore = store();
      const result: Record<string, number> = {};
      readers.forEach(({ address, ts }) => {
        if (address === currentStore.self) return;
        result[currentStore.getIdForAddress(address)] = ts;
      });
      return result;
    },

    // Время прочтения своего сообщения собеседником (1-1, пункт «read at»)
    async fetchOutboxReadDate({ chat, messageId }: { chat: ApiChat; messageId: number }) {
      const readers = await requestReaders(chat.id, messageId);
      const other = readers?.find(({ address }) => address !== store().self);
      return other ? { date: other.ts } : undefined;
    },

    fetchPinnedMessages({ chat }: { chat: ApiChat }) {
      const messages = store().getMessages(chat.id).filter((message) => message.isPinned);
      return Promise.resolve({
        messages, users: deps.collectUsersFor(messages), chats: [chat], count: messages.length, topics: [],
      });
    },

    sendMessageAction({ peer, action }: { peer: { id: string }; action: { type: string } }) {
      if (action.type !== 'typing' || !connection()) return Promise.resolve(undefined);
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(peer.id);
      if (!toAddress) return Promise.resolve(undefined);
      // L2-1: в чате с режимом «усиленная приватность» typing не шлём
      if (deps.v2 && !deps.v2.ephemeralAllowed(toAddress)) return Promise.resolve(undefined);
      // «Печатает» — только эфемерным каналом v2 (T127, TYPING-1); сбой —
      // «печатает» просто не уходит
      if (deps.v2 && isV2Routable(toAddress)) {
        void deps.v2.trySendTyping(toAddress).catch(() => undefined);
      }
      return Promise.resolve(undefined);
    },

    async sendPollVote({ chat, messageId, options }: { chat: ApiChat; messageId: number; options: string[] }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !toAddress) return undefined;
      const indices = options.map(Number).filter((value) => !Number.isNaN(value));
      deps.polls.applyVote(uuid, currentStore.self, indices);
      refreshPollMessage(uuid);
      await publishInner(toAddress, { kind: 'poll_vote', poll: uuid, options: indices });
      return true;
    },

    async closePoll({ chat, messageId }: { chat: ApiChat; messageId: number }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !toAddress) return undefined;
      deps.polls.close(uuid);
      refreshPollMessage(uuid);
      await publishInner(toAddress, { kind: 'poll_close', poll: uuid });
      return true;
    },

    // «Save GIF»/unsave из контекст-меню сообщения; персист на пользователя
    saveGif({ gif, shouldUnsave }: { gif: ApiVideo; shouldUnsave?: boolean }) {
      if (shouldUnsave) {
        const index = savedGifs.findIndex((candidate) => candidate.id === gif.id);
        if (index >= 0) savedGifs.splice(index, 1);
        persistSavedGifs();
      } else {
        rememberSavedGif(gif);
      }
      return Promise.resolve(true);
    },

    // Внешних GIF-провайдеров нет (privacy by design) — честный пустой поиск
    searchGifs() {
      return Promise.resolve({ gifs: [] });
    },

    // Список голосовавших за вариант (панель результатов публичного опроса).
    // Агрегат весь на клиенте — пагинация не нужна
    loadPollOptionResults({ chat, messageId, option }: {
      chat: ApiChat; messageId: number; option: string;
    }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      if (!uuid) return Promise.resolve(undefined);
      const votes = deps.polls.getVoters(uuid, Number(option)).map((address) => ({
        peerId: currentStore.getIdForAddress(address),
        date: 0,
      }));
      return Promise.resolve({ count: votes.length, votes, nextOffset: '' });
    },

    setChatMessageAutoDeletePeriod({ chat, period }: { chat: ApiChat; period: number }) {
      const address = store().getAddressForId(chat.id);
      if (!address) return Promise.resolve(undefined);
      const ttl = deps.localState.loadPeerTtl();
      if (period > 0) ttl[address] = period;
      else delete ttl[address];
      deps.localState.savePeerTtl(ttl);
      return Promise.resolve(true);
    },

    markMessageListRead({ chat, maxId }: { chat: ApiChat; maxId?: number }) {
      const currentStore = store();
      const history = currentStore.getMessages(chat.id);
      const readAddress = currentStore.getAddressForId(chat.id);
      const newlyRead: string[] = [];
      history.forEach((message) => {
        if (message.isOutgoing || (maxId && message.id > maxId)) return;
        // Служебные сообщения чата квитанцией прочтения не подтверждаются
        if (message.content.action) return;
        const uuid = currentStore.getUuidForMessage(chat.id, message.id);
        if (!uuid || deps.sync.hasReportedRead(uuid)) return;
        deps.sync.markReportedRead(uuid);
        newlyRead.push(uuid);
      });
      // Протокол v2: квитанция прочтения — E2E-содержимое собеседнику (FR-035)
      if (newlyRead.length && readAddress && isV2Routable(readAddress)) {
        void deps.v2?.tryRead(readAddress, newlyRead).catch((error: unknown) => {
          deps.log(`квитанция прочтения не отправлена: ${String(error)}`);
        });
      }
      // ВАЖНО: двигаем и ЛОКАЛЬНЫЙ read-state tt. Сам tt в markMessageListRead
      // обновляет lastReadInboxMessageId только при unreadCount>0 (ранний
      // выход), а мы unreadCount вживую не ведём → lastReadInboxMessageId
      // застывал на снапшоте fetchChats. Тогда selectFirstUnreadId вечно
      // указывал на старое входящее; как только оно выпадало из окна (длинный
      // чат / прокрутка), reducer newMessage ОТКАЗЫВАЛСЯ добавлять новые
      // сообщения в окно (стрелка ↓, «сообщение появляется только по ↓»).
      const readUpTo = maxId ?? history[history.length - 1]?.id;
      if (readUpTo) {
        let lastReadInbox = 0;
        let unreadCount = 0;
        history.forEach((message) => {
          if (message.isOutgoing || !message.senderId) return;
          if (message.id <= readUpTo) {
            if (message.id > lastReadInbox) lastReadInbox = message.id;
          } else {
            unreadCount += 1;
          }
        });
        deps.sendUpdate({
          '@type': 'updateThreadReadState',
          chatId: chat.id,
          threadId: MAIN_THREAD_ID,
          readState: { lastReadInboxMessageId: lastReadInbox || readUpTo, unreadCount },
        });
      }
      deps.sync.pushMentionState(chat.id);
      return Promise.resolve(undefined);
    },

    readAllMentions({ chat }: { chat: ApiChat }) {
      // Прочитанность у Parvane помессаджная: квитанция по каждому упоминанию
      const currentStore = store();
      const readAddress = currentStore.getAddressForId(chat.id);
      const newlyRead: string[] = [];
      deps.sync.collectUnreadMentions(chat.id).forEach((id) => {
        const uuid = currentStore.getUuidForMessage(chat.id, id);
        if (!uuid || deps.sync.hasReportedRead(uuid)) return;
        deps.sync.markReportedRead(uuid);
        newlyRead.push(uuid);
      });
      if (newlyRead.length && readAddress && isV2Routable(readAddress)) {
        void deps.v2?.tryRead(readAddress, newlyRead).catch(() => undefined);
      }
      deps.sync.pushMentionState(chat.id);
      return Promise.resolve(true);
    },

    sendMessageLocal,
    sendMessage,

    async forwardMessages({ fromChat, toChat, messages }: {
      fromChat: ApiChat; toChat: ApiChat; messages: ApiMessage[];
    }) {
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(toChat.id);
      if (!toAddress) return undefined;
      const fromAddress = currentStore.getAddressForId(fromChat.id) || '';
      const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
      for (const message of messages) {
        const wireContent = deps.media.messageToWireContent(message);
        if (!wireContent) continue;
        // Зашифрованное медиа: файл в облаке выдан только участникам исходного
        // чата, у нового получателя доступа нет (грант только при загрузке) —
        // перевыгружаем блоб под новым ключом для получателей целевого чата
        let content = message.content;
        if (typeof wireContent.file_id === 'string' && wireContent.file_key) {
          const reshared = await reshareMedia(wireContent.file_id, toAddress);
          if (reshared) {
            wireContent.file_id = reshared.fileId;
            wireContent.file_key = reshared.keyB64;
            wireContent.file_nonce = reshared.nonceB64;
            wireContent.capability = reshared.capability;
            content = replaceMediaId(content, reshared.oldId, reshared.fileId);
          }
        }
        // Паки эмодзи/стикера перекладываются под нового получателя: архив в
        // cloud выдан только получателям исходного сообщения (PACK-1)
        if (wireContent.kind === 'text' && message.content.text?.entities?.length) {
          const emojiPacks = await buildEmojiPackRefs(message.content.text.entities, toAddress);
          if (emojiPacks.length) wireContent.emoji_packs = emojiPacks;
        }
        const stickerSetInfo = message.content.sticker?.stickerSetInfo;
        const stickerSetId = stickerSetInfo && 'id' in stickerSetInfo ? stickerSetInfo.id : undefined;
        if (wireContent.kind === 'sticker' && stickerSetId && isCustomPackSetId(stickerSetId)) {
          const packRef = await buildPackRefForSet(stickerSetId, toAddress);
          if (packRef) wireContent.pack_ref = packRef;
        }
        const originalSender = message.senderId ? currentStore.getAddressForId(message.senderId) : fromAddress;
        wireContent.forwarded_from = originalSender || fromAddress;
        wireContent.forwarded_name = originalSender
          ? currentStore.getDisplayName(originalSender)
          : currentStore.getDisplayName(fromAddress);
        // TTL целевого чата распространяется и на пересланное
        wireContent.ttl_secs = ttlSecs || undefined;
        const uuid = await publishInner(toAddress, wireContent);
        const id = currentStore.allocateMessageId(toChat.id, uuid);
        const localMessage: ApiMessage = {
          id,
          chatId: toChat.id,
          content,
          date: Math.floor(Date.now() / 1000),
          isForwardingAllowed: true,
          isOutgoing: true,
          senderId: deps.selfId(),
          forwardInfo: {
            date: message.date,
            isChannelPost: false,
            fromChatId: originalSender ? currentStore.getIdForAddress(originalSender) : undefined,
            hiddenUserName: wireContent.forwarded_name as string,
          },
        };
        currentStore.putMessage(localMessage);
        deps.sendUpdate({ '@type': 'newMessage', chatId: toChat.id, id, message: localMessage });
        if (ttlSecs) deps.localState.scheduleTtlDeletion(toChat.id, id, ttlSecs);
      }
      return true;
    },

    // Задание в чат (spec 011, US3): карточка с полями задачи; `text` — для
    // клиентов без планировщика (TASK-1)
    async parvaneSendTaskOffer({ chat, offer }: {
      chat: ApiChat;
      offer: {
        name: string;
        description?: string;
        steps?: string[];
        day?: string;
        start?: string;
        minutes?: number;
        due?: string;
      };
    }) {
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!toAddress) return undefined;
      const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
      const uuid = newMessageId();
      const content: WireMessageContent = {
        kind: 'task_offer',
        name: offer.name.trim().slice(0, 200),
        description: offer.description?.trim() || undefined,
        steps: offer.steps?.map((step) => step.trim()).filter(Boolean).slice(0, 100),
        day: offer.day || undefined,
        start: offer.start || undefined,
        minutes: offer.minutes || undefined,
        due: offer.due || undefined,
        text: taskOfferText(offer),
        ttl_secs: ttlSecs || undefined,
      };
      deps.taskOffers.register(uuid, chat.id, content, currentStore.self);
      await publishInner(toAddress, content, uuid);
      // v2 свою операцию назад не присылает: строка идёт обычным конвейером сама
      // (как `chat_mode`) — так карточка попадает в кэш истории и переживает reload
      await deps.sync.applyExternal({
        id: uuid, from: currentStore.self, to: toAddress, content, ts: Math.floor(Date.now() / 1000), origin: 'v2',
      });
      return true;
    },

    // Решение по заданию: «принять» создаёт задачу в плане и шлёт ответ-статус;
    // «отклонить» — только ответ. В «Избранном» ответ не публикуется (FR-022)
    async parvaneRespondTaskOffer({ chat, messageId, isAccepted }: {
      chat: ApiChat; messageId: number; isAccepted: boolean;
    }): Promise<TaskOfferPlanResult> {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      const entry = uuid ? deps.taskOffers.get(uuid) : undefined;
      if (!uuid || !toAddress || !entry) return 'unavailable';
      if (isAccepted) {
        const result = addTaskOfferToPlan(uuid, toAddress);
        if (result !== 'ok' && result !== 'exists') return result;
      }
      const isSelfChat = toAddress === currentStore.self;
      if (entry.author === currentStore.self || isSelfChat) {
        refreshTaskOfferMessage(uuid);
        return 'ok';
      }
      deps.taskOffers.applyResponse(uuid, currentStore.self, isAccepted, Math.floor(Date.now() / 1000));
      refreshTaskOfferMessage(uuid);
      const text = taskResponseText(entry.name, isAccepted);
      const content: WireMessageContent = { kind: 'task_response', offer: uuid, accepted: isAccepted, text };
      const responseUuid = await publishInner(toAddress, content, undefined, uuid);
      await deps.sync.applyExternal({
        id: responseUuid,
        from: currentStore.self,
        to: toAddress,
        content,
        ts: Math.floor(Date.now() / 1000),
        reply_to: uuid,
        origin: 'v2',
      });
      return 'ok';
    },

    // Геолокация: статичная точка или live (period в секундах) — тогда позиция
    // обновляется правками этого же сообщения (см. startLiveLocation)
    async parvaneSendLocation({
      chat, lat, long, period, heading, accuracy,
    }: {
      chat: ApiChat; lat: number; long: number; period?: number; heading?: number; accuracy?: number;
    }) {
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!toAddress) return undefined;
      const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
      const uuid = await publishInner(toAddress, {
        kind: 'location',
        lat,
        long,
        live_period: period || undefined,
        heading: period ? heading : undefined,
        accuracy: period ? accuracy : undefined,
        ttl_secs: ttlSecs || undefined,
      });
      const id = currentStore.allocateMessageId(chat.id, uuid);
      const date = Math.floor(Date.now() / 1000);
      const geo = {
        lat, long, accessHash: '0', accuracyRadius: period ? accuracy : undefined,
      };
      const message: ApiMessage = {
        id,
        chatId: chat.id,
        content: {
          location: period
            ? {
              mediaType: 'geoLive', geo, heading, period,
            }
            : { mediaType: 'geo', geo },
        },
        date,
        isOutgoing: true,
        senderId: deps.selfId(),
      };
      currentStore.putMessage(message);
      deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
      if (ttlSecs) deps.localState.scheduleTtlDeletion(chat.id, id, ttlSecs);
      if (period) {
        startLiveLocation({
          chatId: chat.id, messageId: id, uuid, toAddress, date, period,
        });
      }
      return true;
    },

    // Остановить трансляцию: последняя правка с истёкшим period (как Telegram —
    // сообщение остаётся, таймер и «live» гаснут у всех)
    async parvaneStopLiveLocation({ chat, messageId }: { chat: ApiChat; messageId: number }) {
      const currentStore = store();
      const message = currentStore.getMessages(chat.id).find((m) => m.id === messageId);
      const location = message?.content.location;
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!message || !location || location.mediaType !== 'geoLive' || !uuid || !toAddress) return undefined;
      const key = `${chat.id}:${messageId}`;
      finishLiveLocation(key);
      const expiredPeriod = Math.max(1, Math.floor(Date.now() / 1000) - message.date - 1);
      await publishLivePosition(
        {
          chatId: chat.id, messageId, uuid, toAddress, date: message.date, period: location.period,
        },
        {
          lat: location.geo.lat,
          long: location.geo.long,
          heading: location.heading,
          accuracy: location.geo.accuracyRadius,
        },
        expiredPeriod,
      );
      return true;
    },

    // После логина: возобновить незавершённые трансляции этого аккаунта
    parvaneResumeLiveLocations() {
      let stored: LiveLocationEntry[];
      try {
        stored = JSON.parse(localStorage.getItem(liveLocationsStorageKey()) || '[]') as LiveLocationEntry[];
      } catch {
        stored = [];
      }
      const now = Math.floor(Date.now() / 1000);
      stored.forEach((entry) => {
        if (!entry || now >= entry.date + entry.period) return;
        if (!liveLocations.has(`${entry.chatId}:${entry.messageId}`)) startLiveLocation(entry);
      });
      persistLiveLocations();
      return Promise.resolve(undefined);
    },
  };

  return {
    reset,
    sendMessageWithUuid,
    ensureSavedGifsHydrated,
    getSavedGifs: () => savedGifs,
    methods,
    rememberSavedGif,
    resetSavedGifs,
    refreshPollMessage,
    refreshTaskOfferMessage,
  };
}
