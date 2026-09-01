import type { ApiMessage, ApiUpdate, ApiVideo } from '../types';
import type { E2eEngine, WireDeviceBundle } from './e2e';
import type { GatewayConnection } from './gateway';
import type { PollStore } from './polls';
import { MAIN_THREAD_ID } from '../types';

import { buildWebPage, type ParvaneStore } from './store';
import {
  buildWireEvent,
  TOPIC_GROUP_LIST,
  TOPIC_IDENTITY_RESOLVE,
  TOPIC_MSG_ACK,
  TOPIC_MSG_SYNC_REQUEST,
  TOPIC_PREKEYS_FETCH,
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
    refreshMemberships: () => Promise<void>;
  };
  localState: {
    readOwnJournal: () => WireStoredMessage[];
    scheduleTtlDeletion: (chatId: string, messageId: number, ttlSecs: number) => void;
    isBlocked: (address: string) => boolean;
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
type SenderCheck = { claimedFrom: string; senderIdentity: string };
type UnsealResult = {
  stored: WireStoredMessage; wasSealed: boolean; hidden?: boolean; verify?: SenderCheck;
};

const SYNC_TIMEOUT_MS = 15000;

export function createSyncController(deps: SyncDependencies) {
  let isSynced = false;
  let syncPromise: Promise<void> | undefined;
  let deltaSyncPromise: Promise<void> | undefined;
  let lastSeenUuid = '';
  let sinceUpdated = 0;
  const wireFlagsByUuid = new Map<string, WireFlags>();
  const readOutboxMaxByChatId = new Map<string, number>();
  const reportedReadUuids = new Set<string>();
  const checkedGroupCandidates = new Set<string>();

  function buildSyncPayload(lastSeenId: string, updatedSince: number) {
    const e2e = deps.getE2e();
    const signedPayload = `sync:${lastSeenId}:${updatedSince}`;
    // Авто-линковка: доказательства владения ключами прежних устройств —
    // сервер включает в выдачу их sealed-исходящие
    const extraSigning = e2e?.signExtraSync(signedPayload);
    return {
      last_seen_id: lastSeenId,
      since_updated: updatedSince,
      device_id: e2e?.deviceId || '',
      sender_signing_key: e2e?.signingKey,
      signature: e2e?.signCallData(signedPayload),
      extra_signing: extraSigning?.length ? extraSigning : undefined,
    };
  }

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

  const buildWireFlags = (stored: WireStoredMessage): WireFlags => ({
    read: Boolean(stored.read),
    deleted: Boolean(stored.deleted),
    pinned: Boolean(stored.pinned),
    snapshot: JSON.stringify([stored.content, stored.reactions, stored.pinned, stored.edited]),
  });

  function reset() {
    isSynced = false;
    syncPromise = undefined;
    deltaSyncPromise = undefined;
    lastSeenUuid = '';
    sinceUpdated = 0;
    wireFlagsByUuid.clear();
    readOutboxMaxByChatId.clear();
    reportedReadUuids.clear();
    checkedGroupCandidates.clear();
  }

  function resetPromise() {
    syncPromise = undefined;
    deltaSyncPromise = undefined;
  }

  function trackCursors(stored: WireStoredMessage) {
    if (stored.id > lastSeenUuid) lastSeenUuid = stored.id;
    const updatedAt = stored.updated_at || 0;
    if (updatedAt > sinceUpdated) sinceUpdated = updatedAt;
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
      if (cached && (!stored.edited || cached.from === store.self)) {
        deps.media.rememberKeys(cached.content as WireMessageContent);
        return { stored: { ...stored, content: cached.content as WireMessageContent }, wasSealed: true };
      }
      if (!e2e || !content.ciphertext || !content.group || !content.sender_identity) {
        return { stored, wasSealed: false };
      }
      const plain = e2e.groupDecrypt(content.group, content.sender_identity, content.ciphertext);
      if (!plain) return { stored, wasSealed: false };
      try {
        const inner = JSON.parse(plain) as WireMessageContent;
        e2e.cacheInner(stored.id, { from: stored.from, content: inner });
        deps.media.rememberKeys(inner);
        return { stored: { ...stored, content: inner }, wasSealed: true };
      } catch {
        return { stored, wasSealed: false };
      }
    }

    if (content.kind !== 'encrypted') return { stored, wasSealed: false };
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
          ? { claimedFrom: cached.from, senderIdentity: cached.senderIdentity }
          : undefined,
      };
    }
    if (!e2e || !content.ciphertext || !content.sender_identity) return { stored, wasSealed: false };

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
        if (inner.from) e2e.rememberContactIdentity(inner.from, content.sender_identity);
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

  // Подтверждение принадлежности sender_identity заявленному отправителю по
  // каталогу identity (анти-имперсонация). Известные устройства проверяются
  // синхронно из локального каталога; неизвестные — с дозапросом бандла
  async function fetchBundleForVerify(user: string) {
    const engine = deps.getE2e();
    const raw = await deps.getConnection()!.request(TOPIC_PREKEYS_FETCH, JSON.stringify({
      token: deps.getToken(), user, known_devices: engine?.getKnownDeviceIds(user) || [],
    }));
    return JSON.parse(raw) as {
      ok: boolean; identity_key?: string; signed_prekey?: string;
      one_time?: string; devices?: WireDeviceBundle[];
    };
  }

  async function verifySender(check: SenderCheck): Promise<'ok' | 'spoofed' | 'unknown'> {
    const engine = deps.getE2e();
    if (!engine) return 'unknown';
    try {
      return await engine.verifySenderIdentity(check.claimedFrom, check.senderIdentity, fetchBundleForVerify);
    } catch {
      return 'unknown';
    }
  }

  function handlePollContent(stored: WireStoredMessage) {
    const content = stored.content;
    const store = deps.getStore();
    if (content.kind === 'poll') {
      const chatAddress = store.isGroupAddress(stored.to) ? stored.to
        : (stored.from && stored.from !== store.self ? stored.from : stored.to);
      const chatId = store.getIdForAddress(
        chatAddress,
        store.isGroupAddress(chatAddress) ? 'group' : 'user',
      );
      deps.polls.register(
        stored.id,
        chatId,
        content.question || '',
        (content.options || []).map(String),
        {
          isPublic: Boolean(content.is_public),
          isMultiple: Boolean(content.is_multiple),
          isQuiz: Boolean(content.is_quiz),
          correct: content.correct,
          solution: content.solution,
        },
      );
      return false;
    }
    if (content.kind === 'poll_vote') {
      const pollUuid = content.poll;
      const options = (content.options || []).map(Number).filter((idx) => !Number.isNaN(idx));
      if (pollUuid && stored.from) {
        deps.polls.applyVote(pollUuid, stored.from, options);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    if (content.kind === 'poll_close') {
      const pollUuid = content.poll;
      if (pollUuid) {
        deps.polls.close(pollUuid);
        deps.refreshPollMessage(pollUuid);
      }
      return true;
    }
    return false;
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

  function announcePeer(address: string) {
    const store = deps.getStore();
    if (store.isGroupAddress(address)) return;
    const user = store.buildApiUser(address);
    deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
    deps.sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
    void resolveDisplayNames([address]);
  }

  function sendAck(messageId: string, sealedSender: string) {
    const store = deps.getStore();
    const ack = buildWireEvent(store.self, deps.getToken(), { message_id: messageId, sender: sealedSender });
    try {
      deps.getConnection()?.publish(TOPIC_MSG_ACK, JSON.stringify(ack));
    } catch {
      // Без ACK сервер повторит доставку; UUID-дедупликация погасит повтор.
    }
  }

  async function refreshGroupsIfUnknownChat(stored: WireStoredMessage) {
    const store = deps.getStore();
    if (!stored.to || stored.to === store.self || stored.from === store.self
      || store.isGroupAddress(stored.to) || checkedGroupCandidates.has(stored.to)) {
      return;
    }
    checkedGroupCandidates.add(stored.to);
    try {
      const raw = await deps.getConnection()!.request(
        TOPIC_GROUP_LIST,
        JSON.stringify({ token: deps.getToken() }),
      );
      const groups = (JSON.parse(raw) as { groups?: WireGroupInfo[] }).groups || [];
      groups.forEach((info) => {
        const isNew = !store.isGroupAddress(info.group_id);
        deps.groups.register(info);
        if (isNew) {
          const chat = store.buildApiChatForGroup(info);
          deps.sendUpdate({ '@type': 'updateChat', id: chat.id, chat });
        }
      });
    } catch {
      // Список групп догоним следующим синком.
    }
    // Если группа так и не нашлась (гонка с фан-аутом членства или сбой
    // запроса), кандидата нужно проверять снова — иначе чат не появится
    // до перезахода
    if (!store.isGroupAddress(stored.to)) {
      checkedGroupCandidates.delete(stored.to);
    }
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

  async function applyStoredUpdate(rawStored: WireStoredMessage, shouldAckIncoming: boolean) {
    trackCursors(rawStored);
    const { stored, wasSealed, hidden, verify } = unsealStored(rawStored);
    const store = deps.getStore();
    if (hidden) {
      if (shouldAckIncoming) sendAck(rawStored.id, stored.from);
      return;
    }
    if (verify) {
      const verdict = await verifySender(verify);
      if (verdict === 'spoofed') {
        // Подмена отправителя: расшифровалось, но sender_identity не принадлежит
        // заявленному адресу. НЕ показываем и НЕ роутим в его чат. Подтверждаем
        // приём (anonymous ack), чтобы сервер не гонял повтор
        deps.log(`ОТКЛОНЕНО: подмена отправителя ${verify.claimedFrom} в ${rawStored.id}`);
        if (shouldAckIncoming) sendAck(rawStored.id, '');
        return;
      }
      if (verdict === 'unknown') {
        // Каталог отправителя недоступен — подтвердить нельзя. Показываем, но
        // помечаем в логе; не запоминаем связку contact↔identity до подтверждения
        deps.log(`не подтверждён отправитель ${verify.claimedFrom} в ${rawStored.id} (каталог недоступен)`);
      } else if (verify.claimedFrom !== store.self) {
        deps.getE2e()?.rememberContactIdentity(verify.claimedFrom, verify.senderIdentity);
      }
    }
    // Заблокированный контакт: входящее личное сообщение не показываем и не
    // роутим в его чат (в группах блок участника так не работает — только 1-1).
    // Приём подтверждаем, чтобы сервер не гонял повтор
    if (!store.isGroupAddress(stored.to) && stored.from && stored.from !== store.self
      && deps.localState.isBlocked(stored.from)) {
      if (shouldAckIncoming) sendAck(rawStored.id, wasSealed ? stored.from : '');
      return;
    }
    // Если после unseal контент всё ещё зашифрован — расшифровать не удалось
    // (нет ключа/сессии, продвинутый ратчет). Не рисуем «🔒» и не роутим в
    // «Избранное» — просто пропускаем, чтобы не мусорить в переписке
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') {
      deps.log(`сообщение ${stored.id} не расшифровано — пропущено`);
      if (shouldAckIncoming) sendAck(rawStored.id, wasSealed ? stored.from : '');
      return;
    }
    await refreshGroupsIfUnknownChat(stored);
    if (handlePollContent(stored)) {
      if (shouldAckIncoming && stored.from !== store.self) {
        sendAck(rawStored.id, wasSealed ? stored.from : '');
      }
      return;
    }
    deps.media.rememberKeys(stored.content);
    const previousFlags = wireFlagsByUuid.get(stored.id);
    const flags = buildWireFlags(stored);
    wireFlagsByUuid.set(stored.id, flags);

    const isKnown = store.hasMessage(stored.id);
    const message = store.buildApiMessage(stored);
    store.putMessage(message);
    if (stored.content.kind === 'gif' && message.content.video) deps.rememberSavedGif(message.content.video);
    if (!message.isOutgoing && shouldAckIncoming) sendAck(stored.id, wasSealed ? stored.from : '');

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
      // Первичный sync: pinnedIds наполняется ТОЛЬКО через updatePinnedIds, а не
      // из message.isPinned — без этого закреплённые не восстанавливаются на
      // свежем входе (панель пинов пуста до нового пина). Эмитим для уже
      // закреплённых при первом появлении сообщения
      if (flags.pinned) {
        deps.sendUpdate({
          '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: true, messageIds: [message.id],
        });
      }
      if (flags.read && message.isOutgoing) noteReadOutbox(message);
      if (stored.content.ttl_secs) {
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, stored.content.ttl_secs);
      }
      return;
    }

    if (flags.deleted && !previousFlags?.deleted) {
      deps.sendUpdate({ '@type': 'deleteMessages', ids: [message.id], chatId: message.chatId });
      return;
    }
    if ((!previousFlags || flags.snapshot !== previousFlags.snapshot) && !flags.deleted) {
      deps.sendUpdate({
        '@type': 'updateMessage', chatId: message.chatId, id: message.id, isFull: true, message,
      });
    }
    if (previousFlags && flags.pinned !== previousFlags.pinned) {
      deps.sendUpdate({
        '@type': 'updatePinnedIds', chatId: message.chatId, isPinned: flags.pinned, messageIds: [message.id],
      });
    }
    if (flags.read && !previousFlags?.read && message.isOutgoing) noteReadOutbox(message);
  }

  async function runFullSync() {
    const store = deps.getStore();
    const connection = deps.getConnection()!;
    const token = deps.getToken();
    const groupsRaw = await connection.request(TOPIC_GROUP_LIST, JSON.stringify({ token }));
    const groups = (JSON.parse(groupsRaw) as { groups?: WireGroupInfo[] }).groups || [];
    groups.forEach(deps.groups.register);

    const syncEvent = buildWireEvent(store.self, token, buildSyncPayload('0', 0));
    const syncRaw = await connection.request(
      TOPIC_MSG_SYNC_REQUEST,
      JSON.stringify(syncEvent),
      SYNC_TIMEOUT_MS,
    );
    const parsed = JSON.parse(syncRaw) as WireEvent<{ messages?: WireStoredMessage[] }>;
    const serverMessages = parsed.payload?.messages || [];
    serverMessages.forEach(trackCursors);
    const knownIds = new Set(serverMessages.map((message) => message.id));
    const journal = deps.localState.readOwnJournal().filter((message) => !knownIds.has(message.id));
    const ordered = serverMessages.concat(journal)
      .sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));

    ordered.forEach((stored) => {
      if (stored.content.kind === 'encrypted') unsealStored(stored);
    });
    for (const rawStored of ordered) {
      const { stored, hidden, verify } = unsealStored(rawStored);
      if (hidden || handlePollContent(stored)) continue;
      // Нерасшифрованное (нет ключа этого устройства) не рисуем и в стор не
      // кладём — как в applyStoredUpdate, вместо «🔒»-заглушки
      if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') {
        deps.log(`сообщение ${stored.id} не расшифровано — пропущено (full sync)`);
        continue;
      }
      if (verify) {
        const verdict = await verifySender(verify);
        if (verdict === 'spoofed') {
          deps.log(`ОТКЛОНЕНО (full sync): подмена отправителя ${verify.claimedFrom} в ${stored.id}`);
          continue;
        }
        if (verdict === 'ok' && verify.claimedFrom !== store.self) {
          deps.getE2e()?.rememberContactIdentity(verify.claimedFrom, verify.senderIdentity);
        }
      }
      deps.media.rememberKeys(stored.content);
      wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
      const message = store.buildApiMessage(stored);
      store.putMessage(message);
      if (message.isOutgoing && stored.read) {
        const current = readOutboxMaxByChatId.get(message.chatId) || 0;
        if (message.id > current) readOutboxMaxByChatId.set(message.chatId, message.id);
      }
      if (!message.isOutgoing && stored.read) reportedReadUuids.add(stored.id);
      if (stored.content.ttl_secs) {
        const remaining = stored.content.ttl_secs - (Math.floor(Date.now() / 1000) - stored.ts);
        deps.localState.scheduleTtlDeletion(message.chatId, message.id, Math.max(0, remaining));
      }
    }

    const peerAddresses = new Set<string>();
    serverMessages.concat(journal).forEach((message) => {
      if (message.from && !store.isGroupAddress(message.from)) peerAddresses.add(message.from);
      if (message.to && !store.isGroupAddress(message.to)) peerAddresses.add(message.to);
    });
    groups.forEach((group) => group.members.forEach(({ address }) => peerAddresses.add(address)));
    peerAddresses.delete(store.self);
    await resolveDisplayNames(Array.from(peerAddresses));
    isSynced = true;
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

  async function runDeltaSync() {
    const connection = deps.getConnection();
    if (!connection || !isSynced) return;
    await deps.groups.refreshMemberships();
    let messages: WireStoredMessage[];
    try {
      const store = deps.getStore();
      const syncEvent = buildWireEvent(
        store.self,
        deps.getToken(),
        buildSyncPayload(lastSeenUuid || '0', sinceUpdated),
      );
      const raw = await connection.request(
        TOPIC_MSG_SYNC_REQUEST,
        JSON.stringify(syncEvent),
        SYNC_TIMEOUT_MS,
      );
      const parsed = JSON.parse(raw) as WireEvent<{ messages?: WireStoredMessage[] }>;
      messages = parsed.payload?.messages || [];
    } catch {
      return;
    }
    const sorted = messages.sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1));
    for (const stored of sorted) await applyStoredUpdate(stored, true);
  }

  function requestDeltaSync() {
    if (deltaSyncPromise) return;
    deltaSyncPromise = runDeltaSync()
      .catch((error) => deps.log(`дельта-синк не выполнен: ${String(error)}`))
      .finally(() => {
        deltaSyncPromise = undefined;
      });
  }

  function handleInboxFrame(payload: string) {
    let event: WireEvent<{ message?: WireStoredMessage; message_id?: string }>;
    try {
      event = JSON.parse(payload);
    } catch {
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
      .filter((message) => {
        if (message.isOutgoing || !message.senderId) return false;
        if (!store.isMentionOfSelf(message)) return false;
        const uuid = store.getUuidForMessage(chatId, message.id);
        if (!uuid) return true;
        return !wireFlagsByUuid.get(uuid)?.read && !reportedReadUuids.has(uuid);
      })
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

  return {
    announcePeer,
    collectUnreadMentions,
    ensureSynced,
    pushMentionState,
    getFlags: (uuid: string) => wireFlagsByUuid.get(uuid),
    getReadOutboxMax: (chatId: string) => readOutboxMaxByChatId.get(chatId),
    handleInboxFrame,
    hasReportedRead: (uuid: string) => reportedReadUuids.has(uuid),
    isSynced: () => isSynced,
    markDeleted: (uuid: string) => {
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) flags.deleted = true;
    },
    markReportedRead: (uuid: string) => reportedReadUuids.add(uuid),
    requestDeltaSync,
    reset,
    resetPromise,
    resolveDisplayNames,
  };
}
