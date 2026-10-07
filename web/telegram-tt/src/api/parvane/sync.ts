import type { ApiMessage, ApiUpdate, ApiVideo } from '../types';
import type { E2eEngine, WireDeviceBundle } from './e2e';
import type { GatewayConnection } from './gateway';
import type { PollStore } from './polls';
import { MAIN_THREAD_ID } from '../types';

import { getLangStringByKey } from '../../util/localization';
import { diagLog } from '../../util/parvaneDiag';
import { isContentAllowedForMember } from './groups';
import { readPollFields } from './polls';
import { buildWebPage, type ParvaneStore } from './store';
import {
  TOPIC_IDENTITY_RESOLVE,
  type WireEvent,
  type WireGroupInfo,
  type WireMessageContent,
  type WireStoredMessage,
  type WireUserInfo,
} from './wire';

type SyncDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  groups: {
    register: (info: WireGroupInfo) => void;
    // Группы v2 из кэша сведений — до разбора истории (сообщения ложатся в их чаты)
    registerCachedV2?: () => void;
  };
  localState: {
    readOwnJournal: () => Promise<WireStoredMessage[]>;
    updateOwnJournalEntry: (stored: WireStoredMessage) => void;
    // Кэш истории (расшифрованные строки) — в шифрованном IDB: после входа
    // история показывается без сервера (инбокс v2 отдаёт только новое)
    saveHistoryRecord: (stored: WireStoredMessage) => void;
    deleteHistoryRecord: (uuid: string) => void;
    loadHistoryRecords: () => Promise<WireStoredMessage[]>;
    flushHistoryNow: () => Promise<void>;
    markChatDeleted: (address: string) => void;
    loadClearedUntil?: () => Record<string, number>;
    removeOwnJournalEntries: (uuids: string[]) => Promise<void>;
    scheduleTtlDeletion: (chatId: string, messageId: number, ttlSecs: number) => void;
    isBlocked: (address: string) => boolean;
    loadNotifyExceptions: () => Record<string, Record<string, unknown>>;
    saveNotifyExceptions: (map: Record<string, Record<string, unknown>>) => void;
    loadNotifyDefaults: () => Record<string, Record<string, unknown>>;
    saveNotifyDefaults: (map: Record<string, Record<string, unknown>>) => void;
    loadReadUuids: () => string[];
    saveReadUuids: (uuids: string[]) => void;
  };
  media: { rememberKeys: (content: WireMessageContent) => void };
  polls: PollStore;
  refreshPollMessage: (uuid: string) => void;
  rememberSavedGif: (gif: ApiVideo) => void;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

type WireFlags = { read: boolean; deleted: boolean; pinned: boolean; snapshot: string };
// `verify` присутствует у sealed 1-1 сообщений, чью аутентичность отправителя
// нужно подтвердить по каталогу identity перед показом (анти-имперсонация)
type SenderCheck = { claimedFrom: string; senderIdentity: string; isHistory?: boolean };
type UnsealResult = {
  stored: WireStoredMessage; wasSealed: boolean; hidden?: boolean; verify?: SenderCheck;
  // Собственный исходящий конверт: скрыт, приём не подтверждается (ack — дело получателя)
  isOwnEnvelope?: boolean;
};

const MS_IN_SECOND = 1000;

export function createSyncController(deps: SyncDependencies) {
  let isSynced = false;
  let syncPromise: Promise<void> | undefined;
  const wireFlagsByUuid = new Map<string, WireFlags>();
  const readOutboxMaxByChatId = new Map<string, number>();
  const reportedReadUuids = new Set<string>();
  const announcedThreadChatIds = new Set<string>();

  // FNV-1a 32-бит от полного шифртекста: по нему decCache отличает «тот же ct,
  // что уже расшифрован» от нового ct после правки. Без этого delta-строка
  // отредактированного sealed-сообщения пыталась расшифроваться повторно
  // (Olm-ратчет ct уже потребил), падала и ПРОПУСКАЛАСЬ вместе с флагами
  // (пин/прочтение/реакции у собеседника). Паритет с desktop (FNV полного ct)
  function hashCiphertext(ciphertext: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < ciphertext.length; i++) {
      hash ^= ciphertext.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16);
  }

  // E2E-1: разворачивает Megolm-plaintext. Канонический формат — голый
  // WireMessageContent; legacy-клиенты слали обёртку {from, content}. Возвращаем
  // сам content; поле from обёртки игнорируется (автор берётся из wire `from`).
  function unwrapMegolmContent(parsed: unknown): WireMessageContent {
    if (
      parsed && typeof parsed === 'object'
      && 'content' in parsed && 'from' in parsed
      && typeof (parsed as { content: unknown }).content === 'object'
      && Boolean((parsed as { content: unknown }).content)
    ) {
      return (parsed as { content: WireMessageContent }).content;
    }
    return parsed as WireMessageContent;
  }

  const buildWireFlags = (stored: WireStoredMessage): WireFlags => ({
    read: Boolean(stored.read),
    deleted: Boolean(stored.deleted),
    pinned: Boolean(stored.pinned),
    snapshot: JSON.stringify([stored.content, stored.reactions, stored.pinned, stored.edited]),
  });

  function reset() {
    isSynced = false;
    syncPromise = undefined;
    wireFlagsByUuid.clear();
    announcedThreadChatIds.clear();
    inFlightByUuid.clear();
    undecryptableUuids.clear();
    readOutboxMaxByChatId.clear();
    reportedReadUuids.clear();
    deps.localState.loadReadUuids().forEach((uuid) => reportedReadUuids.add(uuid));
  }

  function resetPromise() {
    syncPromise = undefined;
  }

  function unsealStored(rawStored: WireStoredMessage): UnsealResult {
    const e2e = deps.getE2e();
    const store = deps.getStore();
    // Мультидевайс: live-пуш несёт копии всех устройств адресата — подменяем
    // шифртекст своей (по device_id) до расшифровки. В sync-ответах сервер
    // уже подменил, copies там пусто
    const ownCopy = e2e && rawStored.content.kind === 'encrypted'
      ? rawStored.copies?.find((copy) => copy.device_id === e2e.deviceId
        && (copy.recipient === store.self || (copy.signing_key && copy.signing_key === e2e.signingKey)))
      : undefined;
    const stored = ownCopy
      ? {
        ...rawStored,
        content: { ...rawStored.content, ciphertext: ownCopy.ciphertext, ctype: ownCopy.ctype },
      }
      : rawStored;
    const content = stored.content;
    const cached = e2e?.getCachedInner(stored.id);

    // A sealed tombstone intentionally has no ciphertext or public sender.
    // Reuse the UUID binding established when the original message was
    // decrypted so the delete update targets the correct private chat.
    if (stored.deleted && cached) {
      return {
        stored: { ...stored, from: cached.from, content: cached.content as WireMessageContent },
        wasSealed: true,
      };
    }

    if (content.kind === 'group_encrypted') {
      // Группы: `from` — открытое поле провода, сервер может переподписать
      // сообщение любым участником. Как и в 1-1, требуем, чтобы sender_identity
      // принадлежал заявленному адресу по каталогу устройств (verify ниже)
      if (cached && (!stored.edited || cached.from === store.self)) {
        deps.media.rememberKeys(cached.content as WireMessageContent);
        return {
          stored: { ...stored, content: cached.content as WireMessageContent },
          wasSealed: true,
          verify: cached.senderIdentity && cached.from !== store.self
            ? { claimedFrom: cached.from, senderIdentity: cached.senderIdentity, isHistory: true }
            : undefined,
        };
      }
      if (!e2e || !content.ciphertext || !content.group || !content.sender_identity) {
        return { stored, wasSealed: false };
      }
      const plain = e2e.groupDecrypt(content.group, content.sender_identity, content.ciphertext);
      if (!plain) return { stored, wasSealed: false };
      try {
        // E2E-1: канонический Megolm-plaintext — ГОЛЫЙ content, автор = wire
        // `stored.from` (его ставит gateway). Принимаем и legacy-обёртку
        // {from, content} от старых клиентов, но inner.from НИКОГДА не
        // используется как автор (иначе подмена отправителя в группе — P-02).
        const inner = unwrapMegolmContent(JSON.parse(plain));
        e2e.cacheInner(stored.id, {
          from: stored.from, content: inner, senderIdentity: content.sender_identity,
        });
        deps.media.rememberKeys(inner);
        return {
          stored: { ...stored, content: inner },
          wasSealed: true,
          verify: stored.from !== store.self
            ? { claimedFrom: stored.from, senderIdentity: content.sender_identity }
            : undefined,
        };
      } catch {
        return { stored, wasSealed: false };
      }
    }

    if (content.kind !== 'encrypted') return { stored, wasSealed: false };
    // Легаси-копия от v2-отправителя (FR-054): основной шифртекст пуст, всё
    // адресное — в copies. Нашей копии нет — запись не для этого устройства
    // (своё v2-сообщение пришло по v2): молча пропускаем, курсор не держим.
    // Так же и её надгробие: удаление v2-устройству приходит по v2
    if (!cached && !ownCopy && !content.ciphertext && content.sender_identity) {
      return { stored, wasSealed: false, hidden: true };
    }
    const sameCiphertext = Boolean(cached?.ctHash && content.ciphertext
      && cached.ctHash === hashCiphertext(content.ciphertext));
    if (cached && (!stored.edited || cached.from === store.self || sameCiphertext)) {
      deps.media.rememberKeys(cached.content as WireMessageContent);
      return {
        stored: { ...stored, from: cached.from, content: cached.content as WireMessageContent },
        wasSealed: true,
        // Перепроверяем и cached-путь: иначе однажды закэшированная подмена
        // доверялась бы вечно. Своё исходящее кэшируется без senderIdentity
        // (verify не ставится); self-копии сиблинг-устройств проверяются
        verify: cached.senderIdentity
          ? { claimedFrom: cached.from, senderIdentity: cached.senderIdentity, isHistory: true }
          : undefined,
      };
    }
    if (!e2e || !content.ciphertext || !content.sender_identity) return { stored, wasSealed: false };

    // Собственное исходящее ЭТОГО устройства, адресованное другому: шифртекст
    // предназначен устройству получателя, своей Olm-сессией он не открывается.
    // Обычные сообщения сюда не доходят (inner кэшируется при отправке), остаются
    // служебные конверты без кэша — раздача группового ключа (SKDM). Sync
    // возвращает их отправителю по `sender_signing_key`; без этой ветки после
    // каждой раздачи ключа в личном чате с участником группы появлялась
    // заглушка «не удалось расшифровать» с бейджем непрочитанного
    if (content.sender_identity === e2e.identityKey && stored.to !== store.self) {
      return {
        stored, wasSealed: true, hidden: true, isOwnEnvelope: true,
      };
    }

    const plain = e2e.decryptFrom(content.sender_identity, content.ctype || 0, content.ciphertext);
    if (!plain) return { stored, wasSealed: false };
    try {
      const inner = JSON.parse(plain) as { from: string; content: WireMessageContent };
      // ВАЖНО про порядок: `decryptFrom` не персистит продвинутый ратчет —
      // первым персист-снапшотом ОБЯЗАН быть `cacheInner`/`acceptGroupKey`,
      // чтобы уехавший ратчет и результат расшифровки легли на диск атомарно.
      // Резкий kill до этой точки безопасен: на диске ратчет не уехал,
      // и после рестарта то же сообщение расшифруется заново
      if (inner.content?.kind === 'skdm' && inner.content.group && inner.content.session_key) {
        // Групповой ключ привязываем к устройству, РЕАЛЬНО приславшему конверт
        // (внешний sender_identity, расшифровавший Olm), а не к самозаявленному
        // внутри SKDM — иначе участник затирал бы megolm-сессию другого,
        // назвав его identity (подмена/DoS канала участника)
        if (inner.content.sender_identity === content.sender_identity) {
          e2e.acceptGroupKey(
            inner.content.group,
            content.sender_identity,
            inner.content.session_key,
            inner.content.epoch || 0,
          );
        } else {
          deps.log(`SKDM с чужим sender_identity от ${inner.from} — отклонён`);
        }
        if (inner.from && e2e.rememberContactIdentity(inner.from, content.sender_identity)) {
          announceKeyChange(inner.from);
        }
        return { stored, wasSealed: true, hidden: true };
      }
      // Кэшируем вместе с sender_identity — для показа сообщение ещё должно
      // пройти проверку аутентичности отправителя в `applyStoredUpdate`
      e2e.cacheInner(stored.id, {
        from: inner.from,
        content: inner.content,
        senderIdentity: content.sender_identity,
        ctHash: content.ciphertext ? hashCiphertext(content.ciphertext) : undefined,
      });
      deps.media.rememberKeys(inner.content);
      return {
        stored: { ...stored, from: inner.from, content: inner.content },
        wasSealed: true,
        // Проверяем и inner.from === self: спуфер иначе вложил бы сообщение в
        // «Избранное» жертвы. Легитимная self-копия сиблинг-устройства пройдёт
        // (его identity есть в каталоге своих устройств)
        verify: inner.from
          ? { claimedFrom: inner.from, senderIdentity: content.sender_identity }
          : undefined,
      };
    } catch {
      return { stored, wasSealed: false };
    }
  }

  // Подтверждение принадлежности sender_identity заявленному отправителю
  // (анти-имперсонация) для кадров v1, долетающих записями `LegacyV1`: только по
  // локальному каталогу устройств — серверного каталога прекеев v1 больше нет
  // (T110), неизвестный ключ подтвердить нельзя (`unknown`)
  function fetchBundleForVerify(): Promise<{ ok: boolean; devices?: WireDeviceBundle[] }> {
    return Promise.resolve({ ok: false });
  }

  async function verifySender(check: SenderCheck): Promise<'ok' | 'spoofed' | 'unknown'> {
    const engine = deps.getE2e();
    if (!engine) return 'unknown';
    try {
      const verdict = await engine.verifySenderIdentity(
        check.claimedFrom, check.senderIdentity, fetchBundleForVerify, check.isHistory,
      );
      // Свои устройства `rememberContactIdentity` не запоминает — а их история
      // должна читаться и после отзыва устройства
      // (у собеседников виденные ключи ведёт rememberContactIdentity — по ним же
      // определяется смена ключа, сюда их не добавляем)
      if (verdict === 'ok' && check.claimedFrom === deps.getStore().self) {
        engine.rememberVerifiedIdentity(check.claimedFrom, check.senderIdentity);
      }
      return verdict;
    } catch {
      return 'unknown';
    }
  }

  function handlePollContent(stored: WireStoredMessage) {
    const content = stored.content;
    if (content.kind === 'poll') {
      const chatId = pollChatIdOf(stored);
      // spec 005: оба набора имён (web options/is_*, desktop answers/public/…)
      const fields = readPollFields(content);
      deps.polls.register(
        stored.id,
        chatId,
        fields.question,
        fields.options,
        {
          author: stored.from,
          isPublic: fields.isPublic,
          isMultiple: fields.isMultiple,
          isQuiz: fields.isQuiz,
          correct: fields.correct,
          solution: fields.solution,
        },
      );
      return false;
    }
    if (content.kind === 'poll_vote') {
      const pollUuid = content.poll;
      const options = (content.options || []).map(Number).filter((idx) => !Number.isNaN(idx));
      // P-44: голос — только из чата опроса (иначе участник другого чата
      // голосовал бы в чужом опросе по uuid)
      if (pollUuid && stored.from && deps.polls.isInChat(pollUuid, pollChatIdOf(stored))) {
        deps.polls.applyVote(pollUuid, stored.from, options);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    if (content.kind === 'poll_close') {
      const pollUuid = content.poll;
      // P-44: закрыть опрос может только автор, и только из того же чата
      if (pollUuid && stored.from && deps.polls.canClose(pollUuid, stored.from)
        && deps.polls.isInChat(pollUuid, pollChatIdOf(stored))) {
        deps.polls.close(pollUuid);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    return false;
  }

  // Чат, к которому относится сообщение (для опросов: группа или 1-1 собеседник)
  function pollChatIdOf(stored: WireStoredMessage) {
    const store = deps.getStore();
    const chatAddress = store.isGroupAddress(stored.to) ? stored.to
      : (stored.from && stored.from !== store.self ? stored.from : stored.to);
    return store.getIdForAddress(chatAddress, store.isGroupAddress(chatAddress) ? 'group' : 'user');
  }

  async function resolveDisplayNames(addresses: string[]) {
    if (!addresses.length) return;
    try {
      const raw = await deps.getConnection()!.request(
        TOPIC_IDENTITY_RESOLVE,
        JSON.stringify({ usernames: addresses }),
      );
      const users = (JSON.parse(raw) as { users?: WireUserInfo[] }).users || [];
      const store = deps.getStore();
      users.forEach((userInfo) => {
        store.setDisplayName(userInfo.username, userInfo.display_name || userInfo.username);
        const previousProfile = store.getProfile(userInfo.username);
        const profile = {
          bio: userInfo.bio,
          birthday: userInfo.birthday,
          // отрицательный name_color = «сброшен» (десктоп шлёт -1 при сбросе)
          nameColor: (userInfo.name_color ?? -1) >= 0 ? userInfo.name_color : undefined,
          personalChannel: userInfo.personal_channel,
          phone: userInfo.phone,
        };
        store.setProfile(userInfo.username, profile);
        // Профиль собеседника изменился (bio, дата рождения, личный канал, цвет,
        // телефон): tt не перечитывает уже загруженный fullInfo — шлём апдейты,
        // иначе открытый профиль показывал старое до перезагрузки. Профили в
        // снимок кэша не входят: после восстановления устройства «предыдущего»
        // нет, и без сравнения с пустым профилем bio, изменённое за время
        // отсутствия, не показывалось вовсе (fetchFullUser отдаёт store ДО
        // резолва). JSON.stringify опускает undefined — пустой профиль равен {}
        if (JSON.stringify(previousProfile ?? {}) !== JSON.stringify(profile)) {
          const user = store.buildApiUser(userInfo.username);
          deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
          const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(profile.birthday || '');
          deps.sendUpdate({
            '@type': 'updateUserFullInfo',
            id: user.id,
            fullInfo: {
              bio: profile.bio || undefined,
              birthday: iso
                ? { year: Number(iso[1]) || undefined, month: Number(iso[2]), day: Number(iso[3]) }
                : undefined,
              personalChannelId: profile.personalChannel
                ? store.getIdForAddress(profile.personalChannel, 'group')
                : undefined,
            },
          });
        }
        const previousAvatar = store.getAvatar(userInfo.username);
        store.setAvatar(userInfo.username, userInfo.avatar);
        if (userInfo.avatar !== previousAvatar && userInfo.username !== store.self) {
          const user = store.buildApiUser(userInfo.username);
          deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        }
      });
    } catch {
      // Имена не критичны — показываем локальную часть адреса.
    }
  }

  // Ключ безопасности собеседника сменился (новый identity-ключ у известного
  // контакта): служебное сообщение в его чате, как «safety number changed».
  // Локальное, на сервер не уходит; отпечатки — в профиле
  function announceKeyChange(address: string) {
    const store = deps.getStore();
    if (store.isGroupAddress(address) || address === store.self) return;
    const chatId = store.getIdForAddress(address);
    const ts = Math.floor(Date.now() / 1000);
    const id = store.allocateMessageId(chatId, `keychange:${address}:${ts}`, ts);
    const template = getLangStringByKey('ParvaneSecurityKeyChanged') || 'The security key of {user} has changed.';
    const message: ApiMessage = {
      id,
      chatId,
      date: ts,
      isOutgoing: false,
      senderId: chatId,
      content: {
        action: {
          mediaType: 'action',
          type: 'customAction',
          message: template.replace('{user}', store.getDisplayName(address)),
        },
      },
    };
    store.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId, id, message });
    deps.log(`ключ безопасности ${address} изменился`);
  }

  function announcePeer(address: string) {
    const store = deps.getStore();
    if (store.isGroupAddress(address)) return;
    const user = store.buildApiUser(address);
    deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    deps.sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
    ensureMainThread(user.id);
    void resolveDisplayNames([address]);
  }

  // Как в Telegram, где тред главной ленты приходит вместе с диалогом: без
  // объекта треда tt МОЛЧА отбрасывает записи listedIds/pinnedIds/readState
  // (updateThreadLocalState → no-op). Чат из поиска/входящего появлялся раньше,
  // чем loadViewportMessages успевал создать тред (гонка) → пин собеседника,
  // «прочитано» и пр. терялись. Создаём тред один раз на чат, БЕЗ lastMessageId:
  // его выставляет сам reducer newMessage в правильном порядке относительно
  // вьюпорта (иначе isViewportNewest ломается — стрелка ↓).
  function ensureMainThread(chatId: string) {
    if (announcedThreadChatIds.has(chatId)) return;
    announcedThreadChatIds.add(chatId);
    deps.sendUpdate({
      '@type': 'updateThreadInfo',
      threadInfo: { isCommentsInfo: false, chatId, threadId: MAIN_THREAD_ID },
    });
  }

  // Локальный журнал прочитанного пишем с задержкой: markMessageListRead
  // помечает пачку сообщений подряд, а localStorage синхронный.
  let persistReadTimer: ReturnType<typeof setTimeout> | undefined;
  function persistReadUuids() {
    if (persistReadTimer) return;
    persistReadTimer = setTimeout(() => {
      persistReadTimer = undefined;
      deps.localState.saveReadUuids([...reportedReadUuids]);
    }, 500);
  }

  async function forgetMessages(uuids: string[]) {
    const store = deps.getStore();
    const idsByChatId = new Map<string, number[]>();
    uuids.forEach((uuid) => {
      wireFlagsByUuid.delete(uuid);
      deps.localState.deleteHistoryRecord(uuid);
      const message = store.getMessageByUuid(uuid);
      if (!message) return;
      store.removeMessage(message.chatId, message.id);
      const ids = idsByChatId.get(message.chatId) || [];
      ids.push(message.id);
      idsByChatId.set(message.chatId, ids);
    });
    idsByChatId.forEach((ids, chatId) => {
      deps.sendUpdate({ '@type': 'deleteMessages', ids, chatId });
      if (!store.getMessages(chatId).length) {
        const address = store.getAddressForId(chatId);
        if (address && !store.isGroupAddress(address)) deps.localState.markChatDeleted(address);
        deps.sendUpdate({ '@type': 'deleteHistory', chatId });
      }
    });
    // Кэш истории и журнал исходящих — сразу, не по таймеру: reload сразу
    // после удаления не должен воскресить очищенное из IDB
    await deps.localState.removeOwnJournalEntries(uuids);
    await deps.localState.flushHistoryNow();
  }

  // Чат очищен «у себя» (T145) позже этого сообщения. Сервер v1 очищенное не
  // присылает сам, а копия v2 (эхо своего сообщения, повтор доставки) приходит
  // мимо него — без отсева она воскрешала только что удалённый чат
  function isClearedForMe(stored: WireStoredMessage) {
    const clearedUntil = deps.localState.loadClearedUntil?.();
    if (!clearedUntil) return false;
    const until = clearedUntil[deps.getStore().resolveChatAddress(stored)];
    return Boolean(until) && stored.ts * MS_IN_SECOND <= until;
  }

  // Групповое сообщение участника без роли с типом содержимого, запрещённым
  // текущими правами по умолчанию (владелец и админы правам не подчиняются)
  function isHiddenByGroupPermissions(stored: WireStoredMessage) {
    const store = deps.getStore();
    if (!stored.from || stored.from === store.self || !store.isGroupAddress(stored.to)) return false;
    // Служебное сообщение о режиме группы собрано из её проверенного журнала
    if (stored.content.kind === 'chat_mode') return false;
    const info = store.getGroupInfo(stored.to);
    const role = info?.members.find(({ address }) => address === stored.from)?.role;
    if (!info || role !== 'member') return false;
    if (isContentAllowedForMember(info.default_permissions, stored.content)) return false;
    diagLog('group-perm-hidden', { uuid: stored.id, kind: stored.content.kind, from: stored.from });
    deps.log(`сообщение ${stored.id} (${stored.content.kind}) от ${stored.from} скрыто правами группы`);
    return true;
  }

  // Служебное сообщение о режиме «усиленная приватность» (L2) собирает только
  // v2-контроллер — из события, проверенного движком, или журнала группы. Тот
  // же вид, пришедший v1-путём, — подделка: чат выглядел бы защищённым
  function isForgedChatMode(stored: WireStoredMessage, origin: WireStoredMessage['origin']) {
    return stored.content.kind === 'chat_mode' && origin !== 'v2';
  }

  // Кросс-девайс прочитанное: сообщения, которые я прочитал на другом
  // устройстве (ReadNotice из инбокса или read_message_ids из sync). Помечаем
  // прочитанными и двигаем бейдж непрочитанного затронутых чатов.
  // Кросс-девайс настройки уведомлений/мута: применить блок, пришедший с
  // другого своего устройства (NotifyNotice из инбокса или notify_settings из
  // sync). Сохраняем локально и обновляем бейджи мута затронутых чатов.
  function applyNotifySettings(json: string) {
    if (!json) return;
    let parsed: { defaults?: Record<string, Record<string, unknown>>;
      exceptions?: Record<string, Record<string, unknown>>; };
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const store = deps.getStore();
    if (parsed.defaults) deps.localState.saveNotifyDefaults(parsed.defaults);
    if (parsed.exceptions) {
      deps.localState.saveNotifyExceptions(parsed.exceptions);
      Object.entries(parsed.exceptions).forEach(([address, settings]) => {
        const chatId = store.getIdForAddress(address);
        deps.sendUpdate({ '@type': 'updateChatNotifySettings', chatId, settings });
      });
    }
  }

  // ЕДИНЫЙ предикат «входящее не прочитано» — для стартового состояния
  // (provider), пересчёта после кросс-девайс прочтения и упоминаний. Раньше
  // пересчёт считал непрочитанным всё без uuid — записи о звонках и служебные
  // сообщения (у них нет uuid, квитанция прочтения невозможна), и бейдж «1»
  // возвращался на чат, где последним был звонок (10 сен 2026).
  function isUnreadIncoming(chatId: string, message: ApiMessage) {
    if (message.isOutgoing || !message.senderId) return false;
    if (message.content.action) return false;
    const uuid = store_().getUuidForMessage(chatId, message.id);
    if (!uuid) return false;
    return !wireFlagsByUuid.get(uuid)?.read && !reportedReadUuids.has(uuid);
  }

  function store_() {
    return deps.getStore();
  }

  // Пересчитать и разослать состояние прочитанного чата по стору. Зовётся и
  // из calls.ts после инъекции входящей записи о звонке: tt на любой
  // newMessage с чужим senderId прибавляет +1 к непрочитанному (chats.ts,
  // addUnreadMessageToCounter), не глядя на lastReadInboxMessageId.
  function pushReadState(chatId: string) {
    // tt отбрасывает `updateThreadReadState`, пока у чата нет основного треда
    // (`updateThreadReadState` reducer: нет треда — нет изменений). Запись о
    // звонке из журнала состояния могла прийти раньше объявления чата: «+1» от
    // newMessage оставался, а исправление терялось — бейдж «1» после reload
    const store = deps.getStore();
    // Пустой чат (история очищена, чат удалён «у себя») не объявляем заново
    if (store.getMessages(chatId).length) ensureMainThread(chatId);
    let lastReadInbox = 0;
    let unreadCount = 0;
    store.getMessages(chatId).forEach((message) => {
      if (message.isOutgoing || !message.senderId) return;
      if (isUnreadIncoming(chatId, message)) {
        unreadCount += 1;
      } else if (message.id > lastReadInbox) {
        lastReadInbox = message.id;
      }
    });
    deps.sendUpdate({
      '@type': 'updateThreadReadState',
      chatId,
      threadId: MAIN_THREAD_ID,
      readState: { lastReadInboxMessageId: lastReadInbox, unreadCount },
    });
  }

  function markUuidsRead(uuids: string[]) {
    if (!uuids.length) return;
    const store = deps.getStore();
    const affected = new Set<string>();
    uuids.forEach((uuid) => {
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) {
        flags.read = true;
        wireFlagsByUuid.set(uuid, flags);
      }
      reportedReadUuids.add(uuid);
      const message = store.getMessageByUuid(uuid);
      if (!message || message.isOutgoing) return;
      affected.add(message.chatId);
    });
    affected.forEach((chatId) => pushReadState(chatId));
  }

  // «Избранное»: свои сообщения там прочитаны всегда (tdesktop:
  // HistoryItem::unread → false для peer->isSelf()); серверный флаг read у
  // них никогда не встанет (receipt «не от меня» невозможен) — иначе одна
  // галочка навсегда у отправленного с другого устройства (10 сен 2026).
  function isSelfChat(chatId: string) {
    const store = deps.getStore();
    return Boolean(store.self) && chatId === store.getIdForAddress(store.self);
  }

  function noteReadOutbox(message: ApiMessage) {
    const current = readOutboxMaxByChatId.get(message.chatId) || 0;
    if (message.id <= current) return;
    readOutboxMaxByChatId.set(message.chatId, message.id);
    // Именно updateThreadReadState: updateChat с readState tt игнорирует,
    // и исходящие никогда не получают ✓✓
    deps.sendUpdate({
      '@type': 'updateThreadReadState',
      chatId: message.chatId,
      threadId: MAIN_THREAD_ID,
      readState: { lastReadOutboxMessageId: message.id },
    });
  }

  // Live-пуш и delta-синк могут нести один uuid одновременно; проверка
  // «известно» внутри стоит после await'ов → без сериализации по uuid
  // сообщение попадало в ленту дважды
  const inFlightByUuid = new Map<string, Promise<void>>();

  // `isLive` — строка пришла сейчас (инбокс v2, кадр `LegacyV1`), а не из кэша
  function applyStoredUpdate(
    rawStored: WireStoredMessage, isLive: boolean, shouldPersist = isLive,
  ): Promise<void> {
    const previous = inFlightByUuid.get(rawStored.id) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => applyStoredUpdateUnserialized(rawStored, shouldPersist));
    inFlightByUuid.set(rawStored.id, next);
    void next.finally(() => {
      if (inFlightByUuid.get(rawStored.id) === next) inFlightByUuid.delete(rawStored.id);
    }).catch(() => undefined);
    return next;
  }

  async function applyStoredUpdateUnserialized(rawStored: WireStoredMessage, shouldPersist: boolean) {
    const { stored, hidden, verify } = unsealStored(rawStored);
    const store = deps.getStore();
    if (hidden) {
      return;
    }
    if (verify) {
      const verdict = await verifySender(verify);
      if (verdict === 'spoofed') {
        // Подмена отправителя: расшифровалось, но sender_identity не принадлежит
        // заявленному адресу. НЕ показываем и НЕ роутим в его чат
        deps.log(`ОТКЛОНЕНО: подмена отправителя ${verify.claimedFrom} в ${rawStored.id}`);
        return;
      }
      if (verdict === 'unknown') {
        // E2E-1: ключ отправителя подтвердить нельзя — НЕ показываем (P-26)
        deps.log(
          `отправитель ${verify.claimedFrom} в ${rawStored.id} не подтверждён (каталог недоступен) — откладываем`,
        );
        undecryptableUuids.add(rawStored.id);
        return;
      } else if (verify.claimedFrom !== store.self) {
        if (deps.getE2e()?.rememberContactIdentity(verify.claimedFrom, verify.senderIdentity)) {
          announceKeyChange(verify.claimedFrom);
        }
      }
    }
    // Заблокированный контакт: входящее личное сообщение не показываем и не
    // роутим в его чат (в группах блок участника так не работает — только 1-1)
    if (!store.isGroupAddress(stored.to) && stored.from && stored.from !== store.self
      && deps.localState.isBlocked(stored.from)) {
      return;
    }
    // Права по типу содержимого (spec 003, FR-009): сервер видит шифртекст и
    // тип не проверяет — участник без роли, приславший запрещённый тип в
    // обход композера, у остальных не показывается
    if (isHiddenByGroupPermissions(stored) || isForgedChatMode(stored, rawStored.origin)) {
      return;
    }
    if (isClearedForMe(stored)) {
      return;
    }
    // Если после unseal контент всё ещё зашифрован — расшифровать не удалось
    // (нет ключа/сессии, продвинутый ратчет). Не рисуем «🔒» и не роутим в
    // «Избранное» — просто пропускаем, чтобы не мусорить в переписке
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') {
      // Сообщение уже показано с содержимым (из кэша истории после перезагрузки),
      // а повторная строка сервера не расшифровалась — например, правка своего
      // исходящего, чей расшифрованный текст движок не успел сохранить до
      // перезагрузки. Заглушка затёрла бы настоящее содержимое: оставляем как есть
      // (заглушка прошлой попытки — не содержимое: её повторные попытки идут дальше)
      if (store.getMessageByUuid(stored.id) && !undecryptableUuids.has(stored.id)) {
        deps.log(`сообщение ${stored.id} не расшифровано повторно — оставлено показанное содержимое`);
        return;
      }
      undecryptableUuids.add(stored.id);
      deps.log(`сообщение ${stored.id} не расшифровано — показываем заглушку`);
      // Показываем видимую заглушку вместо пустоты: попытки расшифровать
      // продолжаются (курсор придерживается), и удачный проход заменит её
      // настоящим содержимым — `putMessage` кладёт по тому же uuid. В историю
      // заглушку НЕ пишем, чтобы она не пережила успешную расшифровку
      const placeholder = store.buildApiMessage(stored);
      store.putMessage(placeholder);
      deps.sendUpdate({
        '@type': 'newMessage', chatId: placeholder.chatId, id: placeholder.id, message: placeholder,
      });
      return;
    }
    if (handlePollContent(stored)) {
      return;
    }
    deps.media.rememberKeys(stored.content);
    const previousFlags = wireFlagsByUuid.get(stored.id);
    const flags = buildWireFlags(stored);
    wireFlagsByUuid.set(stored.id, flags);

    const isKnown = store.hasMessage(stored.id);
    // Пин по стору, а не только по прошлым wire-флагам: если предыдущих флагов
    // нет (сброс после ресинка/реконнекта), смена пина всё равно должна дойти
    // до pinnedIds — иначе у собеседника на сообщении иконка есть, а панели нет
    const wasPinned = previousFlags ? previousFlags.pinned : Boolean(store.getMessageByUuid(stored.id)?.isPinned);

    // Надгробие (deleted): сообщение просто исчезает. Раньше неизвестное стору
    // надгробие рисовалось новым сообщением «🗑 Сообщение удалено», а у автора
    // после собственного удаления оно так же воскресало из эха инбокса
    if (stored.deleted) {
      deps.localState.deleteHistoryRecord(stored.id);
      const existing = store.getMessageByUuid(stored.id);
      if (existing) {
        store.removeMessage(existing.chatId, existing.id);
        deps.sendUpdate({ '@type': 'deleteMessages', ids: [existing.id], chatId: existing.chatId });
      }
      return;
    }

    const message = store.buildApiMessage(stored);
    store.putMessage(message);
    // Кэш истории: живые строки и строки протокола v2 — восстановление из кэша
    // (shouldPersist=false) не переписывает само себя
    if (shouldPersist) persistHistory(stored);
    if (stored.content.kind === 'gif' && message.content.video) deps.rememberSavedGif(message.content.video);

    if (!isKnown) {
      if (!message.isOutgoing && stored.from) announcePeer(stored.from);
      const webPage = buildWebPage(stored);
      deps.sendUpdate({
        '@type': 'newMessage',
        chatId: message.chatId,
        id: message.id,
        message,
        webPages: webPage ? [webPage] : undefined,
        poll: stored.content.kind === 'poll' ? deps.polls.build(stored.id) : undefined,
      });
      if (!message.isOutgoing && store.isMentionOfSelf(message)) {
        pushMentionState(message.chatId);
      }
      // tt на newMessage с чужим senderId прибавляет +1 к непрочитанному;
      // служебное сообщение прочитать нельзя — счётчик к честному значению
      if (!message.isOutgoing && message.content.action) pushReadState(message.chatId);
      // Первичный sync: pinnedIds наполняется ТОЛЬКО через updatePinnedIds, а не
      // из message.isPinned — без этого закреплённые не восстанавливаются на
      // свежем входе (панель пинов пуста до нового пина). Эмитим для уже
      // закреплённых при первом появлении сообщения
      if (flags.pinned) {
        deps.sendUpdate({
          '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: true, messageIds: [message.id],
        });
      }
      if ((flags.read || isSelfChat(message.chatId)) && message.isOutgoing) noteReadOutbox(message);
      if (stored.content.ttl_secs) {
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, stored.content.ttl_secs);
      }
      return;
    }

    if ((!previousFlags || flags.snapshot !== previousFlags.snapshot) && !flags.deleted) {
      deps.sendUpdate({
        '@type': 'updateMessage', chatId: message.chatId, id: message.id, isFull: true, message,
      });
    }
    if (flags.pinned !== wasPinned) {
      deps.sendUpdate({
        '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: flags.pinned, messageIds: [message.id],
      });
    }
    if ((flags.read || isSelfChat(message.chatId)) && !previousFlags?.read && message.isOutgoing) {
      noteReadOutbox(message);
    }
  }

  // Строка кэша: расшифрованный stored без TTL и без tombstone
  function persistHistory(stored: WireStoredMessage) {
    if (stored.from === deps.getStore().self) deps.localState.updateOwnJournalEntry(stored);
    if (stored.content.ttl_secs) return;
    if (stored.deleted) {
      deps.localState.deleteHistoryRecord(stored.id);
      return;
    }
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') return;
    deps.localState.saveHistoryRecord(stored);
  }

  // Какие именно uuid не прочитались за проход: их заглушки заменяются
  // содержимым, когда расшифровка удаётся
  const undecryptableUuids = new Set<string>();

  // История — из локального кэша (расшифрованные строки) и журнала исходящих;
  // сервер v2 хранит только недоставленное, его отдаёт движок (`applyExternal`)
  async function restoreFromCache(): Promise<boolean> {
    if (!deps.getE2e()) return false;
    const records = await deps.localState.loadHistoryRecords();
    if (!records.length) return false;
    // «Избранное» без других устройств живёт ТОЛЬКО в журнале исходящих (на
    // сервер не уходит) — без подмешивания журнала чат пустел после reload
    const store = deps.getStore();
    const knownIds = new Set(records.map((record) => record.id));
    const savedNotes = (await deps.localState.readOwnJournal())
      .filter((message) => message.to === store.self && !knownIds.has(message.id));
    const ordered = records.concat(savedNotes)
      .sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));
    for (const stored of ordered) {
      await applyStoredUpdate(stored, false);
    }
    // Восстановление идёт апдейтами `newMessage`, а tt на каждое чужое сообщение
    // прибавляет «+1 непрочитанное». Если список чатов уже загружен (чат объявлен
    // раньше — например, записью о звонке из журнала состояния), исправить счётчик
    // больше некому: возвращаем его к честному значению по стору
    const restoredChatIds = new Set<string>();
    ordered.forEach((stored) => {
      const message = store.getMessageByUuid(stored.id);
      if (message && !message.isOutgoing) restoredChatIds.add(message.chatId);
    });
    restoredChatIds.forEach((chatId) => pushReadState(chatId));
    deps.log(`история восстановлена из кэша: ${records.length} сообщений`);
    return true;
  }

  async function runFullSync() {
    undecryptableUuids.clear();
    const store = deps.getStore();
    deps.groups.registerCachedV2?.();

    if (await restoreFromCache()) {
      isSynced = true;
      await resolveDisplayNames(store.getKnownUserAddresses().filter((address) => address !== store.self));
      return;
    }

    // Кэша нет (первый вход на устройстве): история — журнал исходящих; остальное
    // придёт инбоксом v2 и линковкой
    const journal = await deps.localState.readOwnJournal();
    const ordered = journal.sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));
    deps.log(`полный синк: из журнала ${journal.length}`);

    for (const stored of ordered) {
      if (handlePollContent(stored)) continue;
      if (isHiddenByGroupPermissions(stored) || isForgedChatMode(stored, stored.origin)) continue;
      if (isClearedForMe(stored)) continue;
      if (stored.deleted) {
        deps.localState.deleteHistoryRecord(stored.id);
        continue;
      }
      deps.media.rememberKeys(stored.content);
      wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
      const message = store.buildApiMessage(stored);
      store.putMessage(message);
      persistHistory(stored);
      if (message.isOutgoing && (stored.read || isSelfChat(message.chatId))) {
        const current = readOutboxMaxByChatId.get(message.chatId) || 0;
        if (message.id > current) readOutboxMaxByChatId.set(message.chatId, message.id);
      }
      if (stored.content.ttl_secs) {
        const remaining = stored.content.ttl_secs - (Math.floor(Date.now() / 1000) - stored.ts);
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, Math.max(0, remaining));
      }
    }

    const peerAddresses = new Set<string>();
    journal.forEach((message) => {
      if (message.to && !store.isGroupAddress(message.to)) peerAddresses.add(message.to);
    });
    peerAddresses.delete(store.self);
    deps.log('полный синк: история применена');
    await resolveDisplayNames(Array.from(peerAddresses));
    isSynced = true;
    deps.log('полный синк завершён');
  }

  function ensureSynced() {
    if (isSynced) return Promise.resolve();
    if (!syncPromise) {
      syncPromise = runFullSync().catch((error) => {
        syncPromise = undefined;
        throw error;
      });
    }
    return syncPromise;
  }

  function handleInboxFrame(payload: string) {
    let event: WireEvent<{
      message?: WireStoredMessage; message_id?: string; cleared?: { message_ids?: string[] };
    }>;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const cleared = event.payload?.cleared?.message_ids;
    if (Array.isArray(cleared) && cleared.length) {
      forgetMessages(cleared.filter((uuid): uuid is string => typeof uuid === 'string'));
      return;
    }
    const read = (event.payload as { read?: string[] } | undefined)?.read;
    if (Array.isArray(read) && read.length) {
      markUuidsRead(read.filter((uuid): uuid is string => typeof uuid === 'string'));
      return;
    }
    const notify = (event.payload as { notify?: string } | undefined)?.notify;
    if (typeof notify === 'string' && notify) {
      applyNotifySettings(notify);
      return;
    }
    const stored = event.payload?.message;
    if (!stored) return;
    void applyStoredUpdate(stored, true).catch((error) => {
      deps.log(`входящее сообщение не применено: ${String(error)}`);
    });
  }

  // Непрочитанные упоминания чата: id входящих без read-флага с '@self'
  function collectUnreadMentions(chatId: string) {
    const store = deps.getStore();
    return store.getMessages(chatId)
      .filter((message) => store.isMentionOfSelf(message) && isUnreadIncoming(chatId, message))
      .map((message) => message.id);
  }

  function pushMentionState(chatId: string) {
    const unreadMentions = collectUnreadMentions(chatId);
    deps.sendUpdate({
      '@type': 'updateThreadReadState',
      chatId,
      threadId: MAIN_THREAD_ID,
      readState: { unreadMentionsCount: unreadMentions.length, unreadMentions },
    });
  }

  // Протокол v2 (spec 007): строка, собранная из события движка, — тот же
  // конвейер отображения, без v1-подтверждений (у v2 свой ack журнала).
  // Движок сохраняет свой курсор инбокса сразу после возврата отсюда и запись
  // повторно не отдаст, поэтому сообщение к этому моменту обязано лежать в кэше
  // истории на диске: запись в IndexedDB под нагрузкой на диск идёт секундами, и
  // перезагрузка вкладки в это окно теряла сообщение навсегда (стикер с desktop в
  // `cross_client` по v2). `isBulk` — пакетный перенос истории: один сброс в конце
  async function applyExternal(stored: WireStoredMessage, isBulk?: boolean) {
    await applyStoredUpdate({ ...stored, origin: 'v2' }, false, true);
    if (!isBulk) await deps.localState.flushHistoryNow();
  }

  return {
    applyExternal,
    announcePeer,
    collectUnreadMentions,
    ensureSynced,
    forgetMessages,
    pushMentionState,
    announceKeyChange,
    getFlags: (uuid: string) => wireFlagsByUuid.get(uuid),
    getReadOutboxMax: (chatId: string) => readOutboxMaxByChatId.get(chatId),
    handleInboxFrame,
    hasReportedRead: (uuid: string) => reportedReadUuids.has(uuid),
    isSynced: () => isSynced,
    isUnreadIncoming,
    pushReadState,
    markDeleted: (uuid: string) => {
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) flags.deleted = true;
    },
    markReportedRead: (uuid: string) => {
      reportedReadUuids.add(uuid);
      persistReadUuids();
    },
    reset,
    resetPromise,
    resolveDisplayNames,
  };
}
