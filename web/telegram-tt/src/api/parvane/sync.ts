import type { ApiMessage, ApiUpdate, ApiVideo } from '../types';
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
  type WireGroupInfo,
  type WireMessageContent,
  type WireStoredMessage,
  type WireUserInfo,
} from './wire';

type SyncDependencies = {
  getConnection: () => GatewayConnection | undefined;
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
const MS_IN_SECOND = 1000;

export function createSyncController(deps: SyncDependencies) {
  let isSynced = false;
  let syncPromise: Promise<void> | undefined;
  const wireFlagsByUuid = new Map<string, WireFlags>();
  const readOutboxMaxByChatId = new Map<string, number>();
  const reportedReadUuids = new Set<string>();
  const announcedThreadChatIds = new Set<string>();

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
    readOutboxMaxByChatId.clear();
    reportedReadUuids.clear();
    deps.localState.loadReadUuids().forEach((uuid) => reportedReadUuids.add(uuid));
  }

  function resetPromise() {
    syncPromise = undefined;
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

  // Строка уже расшифрована (движок v2 либо кэш истории): автора проверил
  // движок (E2E-1 в v2 — сертификат устройства и подпись записи)
  function applyStoredUpdateUnserialized(stored: WireStoredMessage, shouldPersist: boolean) {
    const store = deps.getStore();
    // Заблокированный контакт: входящее личное сообщение не показываем и не
    // роутим в его чат (в группах блок участника так не работает — только 1-1)
    if (!store.isGroupAddress(stored.to) && stored.from && stored.from !== store.self
      && deps.localState.isBlocked(stored.from)) {
      return;
    }
    // Права по типу содержимого (spec 003, FR-009): сервер видит шифртекст и
    // тип не проверяет — участник без роли, приславший запрещённый тип в
    // обход композера, у остальных не показывается
    if (isHiddenByGroupPermissions(stored) || isForgedChatMode(stored, stored.origin)) {
      return;
    }
    if (isClearedForMe(stored)) {
      return;
    }
    // Шифртекст v1 (Olm/Megolm) читать нечем с T110: такая строка (кадр
    // прежнего инбокса `LegacyV1`) пропускается, в историю не пишется
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') {
      deps.log(`сообщение ${stored.id} в формате v1 — пропущено`);
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

  // История — из локального кэша (расшифрованные строки) и журнала исходящих;
  // сервер v2 хранит только недоставленное, его отдаёт движок (`applyExternal`)
  async function restoreFromCache(): Promise<boolean> {
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
