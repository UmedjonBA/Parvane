import type { ApiMessage, ApiUpdate, ApiVideo } from '../types';
import type { GatewayConnection } from './gateway';
import type { RowMeta } from './historyRows';
import type { PollStore } from './polls';
import type { TaskOfferStore } from './taskOffers';
import { MAIN_THREAD_ID } from '../types';

import { getLangStringByKey } from '../../util/localization';
import { diagLog } from '../../util/parvaneDiag';
import { markKeyChanged } from '../../util/parvaneKeyChange';
import { nonCountedKinds, rowTsMs } from './v2/historyModel';
import { createBatchedResolver } from './batchedResolver';
import { readPollFields } from './polls';
import { buildWebPage, compareStoredOrder, type ParvaneStore } from './store';
import {
  TOPIC_IDENTITY_RESOLVE,
  type WireGroupInfo,
  type WireMessageContent,
  type WireStoredMessage,
  type WireUserInfo,
} from './wire';

type SyncDependencies = {
  getConnection: () => GatewayConnection | undefined;
  // Профиля адреса нет — проверить, не удалён ли аккаунт (spec 027)
  checkPeerDeleted?: (address: string) => void;
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
    markChatDeleted: (address: string) => void;
    loadClearedUntil?: () => Record<string, number>;
    removeOwnJournalEntries: (uuids: string[]) => Promise<void>;
    scheduleTtlDeletion: (chatId: string, messageId: number, ttlSecs: number) => void;
    isBlocked: (address: string) => boolean;
    // Блок-лист целиком — раз на проход восстановления (perf A3)
    loadBlocked?: () => string[];
    loadNotifyExceptions: () => Record<string, Record<string, unknown>>;
    saveNotifyExceptions: (map: Record<string, Record<string, unknown>>) => void;
    loadNotifyDefaults: () => Record<string, Record<string, unknown>>;
    saveNotifyDefaults: (map: Record<string, Record<string, unknown>>) => void;
  };
  // Журнал истории (spec 033, READ-2): непрочитанное — от маркера «прочитано до» чата (движок)
  history?: {
    ensureMarks: () => Promise<void>;
    /** Непрочитанное по модели (spec 036 E4, `unread_changed`): число, маркер, упоминания. */
    unreadOf?: (address: string) => { count: number; lastReadId?: string; mentions: string[] } | undefined;
  };
  // Строки истории — в модели движка (spec 035 T114): показ после перезагрузки, строки вне журнала, очистка
  rows?: {
    loadStored: () => Promise<{ rows: WireStoredMessage[]; known: Set<string>; isReady: boolean }>;
    /** Строки одного чата (ленивый показ, spec 036 T015); нет — модель не открыта. */
    loadChat: (address: string) => Promise<{ rows: WireStoredMessage[]; known: Set<string> } | undefined>;
    /** Последние строки чатов списка модели (`chatList`); нет — модель не открыта. */
    lastRows: () => Promise<WireStoredMessage[] | undefined>;
    persistLocal: (stored: WireStoredMessage) => Promise<WireStoredMessage>;
    forget: (uuids: string[]) => Promise<void>;
  };
  media: { rememberKeys: (content: WireMessageContent) => void };
  polls: PollStore;
  refreshPollMessage: (uuid: string) => void;
  // POLL-1: у автора анонимного опроса изменились голоса — опубликовать итоги (с задержкой и сверкой)
  onAnonymousVote?: (uuid: string) => void;
  // spec 011: задания в чат — карточки и решения (восстанавливаются из кэша истории)
  taskOffers: TaskOfferStore;
  refreshTaskOfferMessage: (uuid: string) => void;
  rememberSavedGif: (gif: ApiVideo) => void;
  // perf A2: индекс строк истории по uuid для мутаций v2 — наполняется здесь
  rememberStored?: (stored: WireStoredMessage) => void;
  // GROUP-2: скрыть ли сообщение группы правами по типу содержимого (решает модель движка; нет модели — нет)
  groupContentHidden?: (groupAddress: string, author: string, content: WireMessageContent) => boolean;
  sendUpdate: (update: ApiUpdate) => void;
  log: (message: string) => void;
};

type WireFlags = { read: boolean; deleted: boolean; pinned: boolean; snapshot: string };
const MS_IN_SECOND = 1000;
const V2_GROUP_PREFIX = 'v2g:';
// perf A3: имена и профили — одним запросом списком за окно сбора, с памятью
const NAMES_BATCH_DELAY_MS = 200;
const NAMES_TTL_MS = 10 * 60 * 1000;
const NAMES_CHUNK = 100;

export function createSyncController(deps: SyncDependencies) {
  let isSynced = false;
  let syncPromise: Promise<void> | undefined;
  // Показ начался без модели (вход без сети до первого подключения): её строки — когда она откроется
  let isRestorePending = false;
  // spec 036 T015: история показывается лениво — при запуске в сторе только последние строки чатов (и «Избранное»),
  // чат целиком — при первом обращении (`ensureChatLoaded`: открытие, поиск, закреплённые, очистка)
  const loadedChatIds = new Set<string>();
  const chatLoads = new Map<string, Promise<void>>();
  // Чтение чата из модели асинхронно: изменения модели, пришедшие между чтением и показом, не должны теряться —
  // снятое (надгробие, «удалить у себя» из журнала) не возвращается, изменённое строкой старше показанного в ещё не
  // прочитанном чате (правка, реакция) показывается последней версией
  const tombstonedUuids = new Set<string>();
  const heldBehind = new Map<string, WireStoredMessage>();
  const wireFlagsByUuid = new Map<string, WireFlags>();
  const readOutboxMaxByChatId = new Map<string, number>();
  // Автор, время (мс), вид и чат строки по uuid — для подсчёта непрочитанного от маркера (READ-2)
  const rowMetaByUuid = new Map<string, RowMeta>();
  // Строки группы v2, которую устройство ещё не знает (журнал истории раньше журнала группы): лежат в кэше и
  // показываются, когда группа появится, — иначе легли бы в чат с «адресом» группы
  const rowsAwaitingGroup = new Map<string, WireStoredMessage[]>();

  function holdForGroup(stored: WireStoredMessage) {
    const store = deps.getStore();
    if (!stored.to.startsWith(V2_GROUP_PREFIX) || store.isGroupAddress(stored.to)) return false;
    const list = rowsAwaitingGroup.get(stored.to) || [];
    rowsAwaitingGroup.set(stored.to, [...list.filter((m) => m.id !== stored.id), stored]);
    return true;
  }

  /** Группа v2 появилась: строки, ждавшие её, — на экран. */
  async function releaseGroupRows(address: string) {
    const list = rowsAwaitingGroup.get(address);
    if (!list || !deps.getStore().isGroupAddress(address)) return;
    rowsAwaitingGroup.delete(address);
    for (const stored of list) await applyStoredUpdate(stored);
    const chatId = deps.getStore().getIdForAddress(address, 'group');
    pushReadState(chatId);
  }
  const announcedThreadChatIds = new Set<string>();
  // Собеседники, уже объявленные UI (updateUser/updateChat) в этой сессии
  const announcedPeers = new Set<string>();
  const names = createBatchedResolver({
    delayMs: NAMES_BATCH_DELAY_MS, ttlMs: NAMES_TTL_MS, chunk: NAMES_CHUNK, resolve: fetchProfiles,
  });

  const buildWireFlags = (stored: WireStoredMessage): WireFlags => ({
    read: Boolean(stored.read),
    deleted: Boolean(stored.deleted),
    pinned: Boolean(stored.pinned),
    snapshot: JSON.stringify([stored.content, stored.reactions, stored.pinned, stored.edited]),
  });

  function rememberWebPage(stored: WireStoredMessage) {
    const webPage = buildWebPage(stored);
    if (webPage) deps.getStore().rememberWebPage(webPage);
    return webPage;
  }

  function reset() {
    isSynced = false;
    syncPromise = undefined;
    wireFlagsByUuid.clear();
    announcedThreadChatIds.clear();
    announcedPeers.clear();
    names.reset();
    inFlightByUuid.clear();
    readOutboxMaxByChatId.clear();
    rowMetaByUuid.clear();
    rowsAwaitingGroup.clear();
    isRestorePending = false;
    loadedChatIds.clear();
    chatLoads.clear();
    tombstonedUuids.clear();
    heldBehind.clear();
  }

  function rememberRowMeta(stored: WireStoredMessage) {
    rowMetaByUuid.set(stored.id, {
      id: stored.id,
      chat: deps.getStore().resolveChatAddress(stored),
      from: stored.from,
      tsMs: rowTsMs(stored),
      kind: stored.content.kind,
    });
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
          closeAt: fields.closeAt,
          createdAt: stored.ts * 1000,
          noRevote: fields.noRevote,
          shuffle: fields.shuffle,
          hideResults: fields.hideResults,
          isGroup: deps.getStore().isGroupAddress(stored.to),
        },
      );
      return false;
    }
    if (content.kind === 'poll_vote') {
      const pollUuid = content.poll;
      const options = (content.options || []).map(Number).filter((idx) => !Number.isNaN(idx));
      if (!pollUuid || !stored.from) return true;
      const store = deps.getStore();
      const atMs = stored.ts ? stored.ts * 1000 : undefined;
      const inChat = deps.polls.isInChat(pollUuid, pollChatIdOf(stored));
      // POLL-1: итоги анонимного опроса — только от автора опроса и только из его группы
      if (content.tally) {
        if (inChat && deps.polls.applyTally(
          pollUuid, stored.from, content.counts || [], Number(content.voters) || 0,
        )) {
          deps.refreshPollMessage(pollUuid);
        }
        return true;
      }
      // P-44: голос — только из чата опроса (иначе участник другого чата
      // голосовал бы в чужом опросе по uuid)
      if (inChat) {
        // POLL-1: участник анонимного опроса группы считает только свой голос; чужие — в итогах автора
        if (deps.polls.isTallyOnly(pollUuid) && stored.from !== store.self) return true;
        deps.polls.applyVote(pollUuid, stored.from, options, atMs);
        deps.refreshPollMessage(pollUuid);
        if (deps.polls.getAuthor(pollUuid) === store.self) deps.onAnonymousVote?.(pollUuid);
        return true;
      }
      // POLL-1: голос анонимного опроса группы — личное сообщение автору (адреса автора голоса группа не видит)
      if (deps.polls.isAnonymousGroup(pollUuid)) {
        const author = deps.polls.getAuthor(pollUuid);
        const groupChatId = deps.polls.getChatId(pollUuid);
        const groupAddress = groupChatId ? store.getAddressForId(groupChatId) : undefined;
        const info = groupAddress ? store.getGroupInfo(groupAddress) : undefined;
        const toAddress = store.canonicalAddress(stored.to);
        if (stored.from === store.self && author && toAddress === store.canonicalAddress(author)) {
          // Свой голос (повтор из журнала или с другого устройства)
          deps.polls.applyVote(pollUuid, store.self, options, atMs);
          deps.refreshPollMessage(pollUuid);
        } else if (author === store.self && toAddress === store.canonicalAddress(store.self)
          && info?.members.some((m) => m.role !== 'banned'
            && store.canonicalAddress(m.address) === store.canonicalAddress(stored.from))) {
          deps.polls.applyVote(pollUuid, stored.from, options, atMs);
          deps.refreshPollMessage(pollUuid);
          deps.onAnonymousVote?.(pollUuid);
        }
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

  // Задание в чат (spec 011): карточка регистрируется, решение применяется к ней;
  // обе строки дальше идут обычным конвейером сообщений (в кэш истории тоже)
  function handleTaskOfferContent(stored: WireStoredMessage) {
    const content = stored.content;
    if (content.kind === 'task_offer') {
      deps.taskOffers.register(stored.id, pollChatIdOf(stored), content, stored.from);
      return;
    }
    if (content.kind === 'task_response' && content.offer && stored.from) {
      deps.taskOffers.applyResponse(
        content.offer, stored.from, Boolean(content.accepted), stored.ts, pollChatIdOf(stored),
      );
      deps.refreshTaskOfferMessage(content.offer);
    }
  }

  // Чат, к которому относится сообщение (для опросов: группа или 1-1 собеседник)
  function pollChatIdOf(stored: WireStoredMessage) {
    const store = deps.getStore();
    const chatAddress = store.isGroupAddress(stored.to) ? stored.to
      : (stored.from && stored.from !== store.self ? stored.from : stored.to);
    return store.getIdForAddress(chatAddress, store.isGroupAddress(chatAddress) ? 'group' : 'user');
  }

  /** Имена и профили адресов: пачкой за окно сбора, повтор не раньше TTL
   * (`force` — профиль открыт, перечитать сейчас). Ответ не критичен. */
  function resolveDisplayNames(addresses: string[], force?: boolean) {
    const store = deps.getStore();
    return names.request(addresses.filter((address) => !store.isGroupAddress(address)), force);
  }

  async function fetchProfiles(addresses: string[]) {
    if (!addresses.length) return;
    const connection = deps.getConnection();
    if (!connection) return;
    const raw = await connection.request(
      TOPIC_IDENTITY_RESOLVE,
      JSON.stringify({ usernames: addresses }),
    );
    try {
      const asked = new Set(addresses);
      // Применяем только то, что спрашивали: сервер identity не вправе подсунуть профили чужих адресов
      const users = ((JSON.parse(raw) as { users?: WireUserInfo[] }).users || [])
        .filter((userInfo) => asked.has(userInfo.username));
      const store = deps.getStore();
      const found = new Set(users.map((u) => u.username));
      const missing = addresses.filter((address) => !found.has(address) && address !== store.self);
      if (missing.length) deps.log(`профили не найдены: ${missing.length} — проверка удалённых аккаунтов`);
      missing.forEach((address) => deps.checkPeerDeleted?.(address));
      users.forEach((userInfo) => {
        if (store.clearUserDeleted(userInfo.username)) {
          const restored = store.buildApiUser(userInfo.username);
          deps.sendUpdate({ '@type': 'updateUser', id: restored.id, user: restored });
        }
        const previousName = store.getPublicDisplayName(userInfo.username);
        store.setDisplayName(userInfo.username, userInfo.display_name || userInfo.username);
        // Имя сменилось (или только что узнали): список чатов и шапки берут
        // его из объекта пользователя — раньше список ждал этот ответ целиком,
        // теперь он не блокирует старт, а имя доезжает апдейтом
        if (store.getPublicDisplayName(userInfo.username) !== previousName) {
          const user = store.buildApiUser(userInfo.username);
          deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        }
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
      // Ответ не разобран — имена не критичны, показываем локальную часть адреса
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
    markKeyChanged(chatId);
    deps.log(`ключ безопасности ${address} изменился`);
  }

  // Смена ника собеседником (spec 026): чат прежний (стор свёл адреса к одному id), в UI — новый ник и
  // служебное сообщение
  function announceRename(oldAddress: string, newAddress: string) {
    const store = deps.getStore();
    const chatId = store.getIdForAddress(newAddress);
    announcedPeers.delete(newAddress);
    announcePeer(newAddress);
    const ts = Math.floor(Date.now() / 1000);
    const id = store.allocateMessageId(chatId, `rename:${newAddress}:${ts}`, ts);
    const template = getLangStringByKey('ParvaneUserRenamed') || '{user} changed nickname to @{nick}';
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
          message: template.replace('{user}', store.getDisplayName(newAddress))
            .replace('{nick}', newAddress.split('@')[0]),
        },
      },
    };
    store.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId, id, message });
    deps.log(`собеседник сменил ник: ${oldAddress.split('@')[0]} → ${newAddress.split('@')[0]}`);
  }

  // Собеседник в UI: объекты пользователя и чата, тред — один раз за сессию
  // (perf A3; раньше — на каждое входящее, с запросом имени по сети)
  function announcePeer(address: string) {
    const store = deps.getStore();
    if (store.isGroupAddress(address) || announcedPeers.has(address)) return;
    announcedPeers.add(address);
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

  // `isReplace` — история заменяется точкой журнала (HIST-2): чаты не помечаются удалёнными
  async function forgetMessages(uuids: string[], isReplace?: boolean) {
    const store = deps.getStore();
    const idsByChatId = new Map<string, number[]>();
    await deps.rows?.forget(uuids);
    uuids.forEach((uuid) => {
      wireFlagsByUuid.delete(uuid);
      const message = store.getMessageByUuid(uuid);
      if (!message) return;
      store.removeMessage(message.chatId, message.id);
      const ids = idsByChatId.get(message.chatId) || [];
      ids.push(message.id);
      idsByChatId.set(message.chatId, ids);
    });
    idsByChatId.forEach((ids, chatId) => {
      deps.sendUpdate({ '@type': 'deleteMessages', ids, chatId });
      if (!store.getMessages(chatId).length && !isReplace) {
        const address = store.getAddressForId(chatId);
        if (address && !store.isGroupAddress(address)) deps.localState.markChatDeleted(address);
        deps.sendUpdate({ '@type': 'deleteHistory', chatId });
      }
    });
    // Строки модели (выше) и журнал исходящих — сразу: reload сразу после удаления не должен воскресить очищенное
    await deps.localState.removeOwnJournalEntries(uuids);
  }

  // Чат очищен «у себя» (T145) позже этого сообщения. Сервер v1 очищенное не
  // присылает сам, а копия v2 (эхо своего сообщения, повтор доставки) приходит
  // мимо него — без отсева она воскрешала только что удалённый чат
  function isClearedForMe(stored: WireStoredMessage, clearedUntil = deps.localState.loadClearedUntil?.()) {
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
    // GROUP-2 (spec 035 T114): роль автора, права группы и вид содержимого сверяет движок (`contentHidden` модели)
    if (!deps.groupContentHidden?.(stored.to, stored.from, stored.content)) return false;
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
  // (provider), пересчёта после прочтения и упоминаний. Записи о звонках и служебные
  // сообщения (без uuid) прочитаны всегда (бейдж «1» на чате, где последним был звонок, 10 сен 2026).
  // С spec 033 (READ-2) — от маркера «прочитано до» чата; с spec 036 (T014) маркер и счётчик ведёт модель
  // (`unread_changed`): непрочитанные — последние по ленте `count` считаемых входящих (строки после маркера —
  // всегда самые новые), своей копии маркеров и своего сравнения с ними у web нет
  function isUnreadIncoming(chatId: string, message: ApiMessage) {
    return unreadIdsOf(chatId).has(message.id);
  }

  /** Непрочитанные входящие чата в сторе (id) — по счётчику модели. */
  function unreadIdsOf(chatId: string): Set<number> {
    const store = deps.getStore();
    const address = store.getAddressForId(chatId);
    const fromModel = address && !isSelfChat(chatId) ? deps.history?.unreadOf?.(address) : undefined;
    const ids = new Set<number>();
    let left = fromModel?.count ?? 0;
    const list = store.getMessages(chatId);
    for (let i = list.length - 1; i >= 0 && left > 0; i--) {
      if (isCountedIncoming(chatId, list[i])) {
        ids.add(list[i].id);
        left -= 1;
      }
    }
    return ids;
  }

  // Входящее, которое движок считает непрочитанным после маркера: не своё, с автором, не служебное и не вида,
  // который движок не считает (`historyUnreadKinds`)
  function isCountedIncoming(chatId: string, message: ApiMessage) {
    if (message.isOutgoing || !message.senderId || message.content.action) return false;
    const uuid = store_().getUuidForMessage(chatId, message.id);
    const meta = uuid ? rowMetaByUuid.get(uuid) : undefined;
    return Boolean(meta && !nonCountedKinds().has(meta.kind));
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
    const unread = unreadIdsOf(chatId);
    store.getMessages(chatId).forEach((message) => {
      if (message.isOutgoing || !message.senderId) return;
      if (unread.has(message.id)) {
        unreadCount += 1;
      } else if (message.id > lastReadInbox) {
        lastReadInbox = message.id;
      }
    });
    const address = store.getAddressForId(chatId);
    const fromModel = address && !isSelfChat(chatId) ? deps.history?.unreadOf?.(address) : undefined;
    if (fromModel) {
      unreadCount = fromModel.count;
      const readMsg = fromModel.lastReadId ? store.getMessageByUuid(fromModel.lastReadId) : undefined;
      if (readMsg) lastReadInbox = Math.max(lastReadInbox, readMsg.id);
    }
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

  // Показ строки (вид модели либо строка вне модели) — по одной на uuid
  function applyStoredUpdate(rawStored: WireStoredMessage): Promise<void> {
    const previous = inFlightByUuid.get(rawStored.id) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => applyStoredUpdateUnserialized(rawStored));
    inFlightByUuid.set(rawStored.id, next);
    void next.finally(() => {
      if (inFlightByUuid.get(rawStored.id) === next) inFlightByUuid.delete(rawStored.id);
    }).catch(() => undefined);
    return next;
  }

  // Строка уже расшифрована (движок v2 либо кэш истории): автора проверил
  // движок (E2E-1 в v2 — сертификат устройства и подпись записи)
  function applyStoredUpdateUnserialized(stored: WireStoredMessage) {
    const store = deps.getStore();
    // Снятое моделью идущее чтение чата из модели не вернёт (`freshOf`) — до любых отсевов ниже
    if (stored.deleted) {
      tombstonedUuids.add(stored.id);
      heldBehind.delete(stored.id);
    }
    if (holdForGroup(stored)) return;
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
    // Шифртекст v1 (Olm/Megolm) читать нечем с T110: такая строка (прежняя
    // локальная история) пропускается, в историю не пишется
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') {
      deps.log(`сообщение ${stored.id} в формате v1 — пропущено`);
      return;
    }
    if (handlePollContent(stored)) {
      return;
    }
    handleTaskOfferContent(stored);
    deps.media.rememberKeys(stored.content);
    deps.rememberStored?.(stored);
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
      // Надгробие хранит модель (удалённое не воскресает ни из какого источника, HIST-1)
      const existing = store.getMessageByUuid(stored.id);
      if (existing) {
        store.removeMessage(existing.chatId, existing.id);
        deps.sendUpdate({ '@type': 'deleteMessages', ids: [existing.id], chatId: existing.chatId });
      }
      return;
    }

    const message = store.buildApiMessage(stored);
    // spec 036 T015: строка модели старше показанного в чате, который ещё не прочитан целиком (история с другого
    // устройства, правка или реакция старого сообщения), — не «новое сообщение»: её покажет чтение чата
    if (!isKnown && isBehindLazyChat(stored, message)) {
      heldBehind.set(stored.id, stored);
      return;
    }
    store.putMessage(message);
    rememberRowMeta(stored);
    if (stored.content.kind === 'gif' && message.content.video) deps.rememberSavedGif(message.content.video);

    if (!isKnown) {
      if (!message.isOutgoing && stored.from) announcePeer(stored.from);
      const webPage = rememberWebPage(stored);
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

  // История — из модели движка (расшифрованные строки) и журнала исходящих; сервер v2 хранит только недоставленное,
  // его отдаёт движок (`applyExternal`). perf A3: строки кладутся прямо в стор, без `newMessage` на каждую — список
  // чатов, последние сообщения и счётчики UI забирает `fetchChats`/`fetchMessages` из стора (как и Telegram).
  // spec 036 T015: при запуске — только последняя строка каждого чата (`chatList`) и «Избранное» целиком; остальное —
  // чатом при первом обращении (`ensureChatLoaded`), поэтому запуск не зависит от длины истории
  async function restoreFromCache(): Promise<boolean> {
    const last = await deps.rows?.lastRows();
    if (deps.rows && !last) isRestorePending = true;
    const store = deps.getStore();
    const nowSecs = Math.floor(Date.now() / 1000);
    // «Избранное» без других устройств живёт и в журнале исходящих: чат с собой — целиком, с подмешанными заметками
    const selfChatId = store.self ? store.getIdForAddress(store.self, 'user') : undefined;
    const isSelfLoaded = Boolean(last && selfChatId) && await loadChatRows(selfChatId!, true);
    const records = freshOf(last || []);
    if (!records.length && !isSelfLoaded) return false;
    const blocked = new Set(deps.localState.loadBlocked?.() || []);
    const clearedUntil = deps.localState.loadClearedUntil?.();
    const restoredChatIds = new Set<string>();
    records.forEach((stored) => {
      const message = restoreStored(stored, blocked, clearedUntil, nowSecs);
      if (message && !message.isOutgoing) restoredChatIds.add(message.chatId);
    });
    // Чат мог быть объявлен раньше восстановления (запись о звонке из журнала
    // состояния) — его счётчик приводим к честному значению, по разу на чат
    restoredChatIds.forEach((chatId) => pushReadState(chatId));
    deps.log(`история восстановлена из модели: последних строк ${records.length}`);
    return true;
  }

  /** Прочитанные из модели строки к показу: без уже показанных и снятых после чтения; изменённые после чтения — их
   * последней версией. По месту в ленте (ORDER-1). */
  function freshOf(records: WireStoredMessage[]) {
    const store = deps.getStore();
    return records
      .filter((stored) => !tombstonedUuids.has(stored.id) && !store.hasMessage(stored.id))
      .map((stored) => {
        const newer = heldBehind.get(stored.id);
        heldBehind.delete(stored.id);
        return newer || stored;
      })
      .sort(compareStoredOrder);
  }

  function isBehindLazyChat(stored: WireStoredMessage, message: ApiMessage) {
    if (!stored.inModel || !deps.rows || loadedChatIds.has(message.chatId)) return false;
    const shown = deps.getStore().getMessages(message.chatId);
    const newest = shown[shown.length - 1];
    return Boolean(newest && message.id < newest.id);
  }

  /** Чат целиком в стор (ленивый показ истории, spec 036 T015): строки модели, которых в сторе нет, — без апдейтов
   * UI (их забирает `fetchMessages`); у «Избранного» — и заметки журнала исходящих, которых модель не знает. */
  function ensureChatLoaded(chatId: string): Promise<void> {
    if (loadedChatIds.has(chatId) || !deps.rows) return Promise.resolve();
    let pending = chatLoads.get(chatId);
    if (!pending) {
      pending = loadChatRows(chatId).then(() => undefined).finally(() => chatLoads.delete(chatId));
      chatLoads.set(chatId, pending);
    }
    return pending;
  }

  /** Все чаты целиком (глобальный поиск по сообщениям). */
  async function ensureAllLoaded() {
    for (const chatId of deps.getStore().getChatIds()) await ensureChatLoaded(chatId);
  }

  async function loadChatRows(chatId: string, isStartup?: boolean): Promise<boolean> {
    const store = deps.getStore();
    const address = store.getAddressForId(chatId);
    const loaded = address ? await deps.rows?.loadChat(address).catch((e: unknown) => {
      deps.log(`история: чат не прочитан из модели: ${String(e)}`);
      return undefined;
    }) : undefined;
    if (!loaded) return false;
    loadedChatIds.add(chatId);
    let records = loaded.rows;
    if (address === store.self) {
      const knownIds = new Set([...records.map((record) => record.id), ...loaded.known]);
      const savedNotes = (await deps.localState.readOwnJournal())
        .filter((message) => message.to === store.self && !knownIds.has(message.id));
      records = records.concat(savedNotes);
    }
    const fresh = freshOf(records);
    if (!fresh.length) return isStartup ? records.length > 0 : true;
    const blocked = new Set(deps.localState.loadBlocked?.() || []);
    const clearedUntil = deps.localState.loadClearedUntil?.();
    const nowSecs = Math.floor(Date.now() / 1000);
    fresh.forEach((stored) => restoreStored(stored, blocked, clearedUntil, nowSecs));
    if (!isStartup) {
      // Закреплённые и упоминания прочитанной сейчас части чата — в UI (при запуске их отдаёт fetchChats)
      const pinned = fresh.filter((stored) => stored.pinned && !stored.deleted)
        .map((stored) => store.getMessageByUuid(stored.id)?.id)
        .filter((id): id is number => id !== undefined);
      if (pinned.length) {
        deps.sendUpdate({ '@type': 'updatePinnedIds', chatId, isPinned: true, messageIds: pinned });
      }
      pushMentionState(chatId);
      // Граница прочитанного — по сообщению маркера, которое теперь в сторе
      pushReadState(chatId);
    }
    deps.log(`история: чат прочитан из модели (${fresh.length} строк)`);
    return true;
  }

  // Строка кэша — в стор (без апдейтов UI). Возвращает сообщение либо undefined,
  // если строка скрыта (блок, права, очистка, надгробие, служебная)
  function restoreStored(
    stored: WireStoredMessage, blocked: Set<string>, clearedUntil: Record<string, number> | undefined, nowSecs: number,
  ): ApiMessage | undefined {
    const store = deps.getStore();
    if (holdForGroup(stored)) return undefined;
    if (!store.isGroupAddress(stored.to) && stored.from && stored.from !== store.self && blocked.has(stored.from)) {
      return undefined;
    }
    if (isHiddenByGroupPermissions(stored) || isForgedChatMode(stored, stored.origin)) return undefined;
    if (isClearedForMe(stored, clearedUntil)) return undefined;
    if (stored.content.kind === 'encrypted' || stored.content.kind === 'group_encrypted') return undefined;
    if (handlePollContent(stored)) return undefined;
    handleTaskOfferContent(stored);
    deps.media.rememberKeys(stored.content);
    deps.rememberStored?.(stored);
    wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
    if (stored.deleted) return undefined;
    const message = store.buildApiMessage(stored);
    store.putMessage(message);
    rememberRowMeta(stored);
    rememberWebPage(stored);
    if (stored.content.kind === 'gif' && message.content.video) deps.rememberSavedGif(message.content.video);
    if (message.isOutgoing && (stored.read || isSelfChat(message.chatId))) {
      const current = readOutboxMaxByChatId.get(message.chatId) || 0;
      if (message.id > current) readOutboxMaxByChatId.set(message.chatId, message.id);
    }
    if (stored.content.ttl_secs) {
      const remaining = stored.content.ttl_secs - (nowSecs - stored.ts);
      deps.localState.scheduleTtlDeletion(message.chatId, message.id, Math.max(0, remaining));
    }
    return message;
  }

  async function runFullSync() {
    const store = deps.getStore();
    deps.groups.registerCachedV2?.();
    // Маркеры «прочитано до» — до первого подсчёта непрочитанного
    await deps.history?.ensureMarks().catch(() => undefined);

    if (await restoreFromCache()) {
      isSynced = true;
      // Имена — в фоне: список чатов сети не ждёт, имя доедет апдейтом
      void resolveDisplayNames(store.getKnownUserAddresses().filter((address) => address !== store.self));
      return;
    }

    // Кэша нет (первый вход на устройстве): история — журнал исходящих; остальное
    // придёт инбоксом v2 и линковкой
    const journal = await deps.localState.readOwnJournal();
    const ordered = journal.sort(compareStoredOrder);
    deps.log(`полный синк: из журнала ${journal.length}`);

    for (const stored of ordered) {
      if (handlePollContent(stored)) continue;
      handleTaskOfferContent(stored);
      if (isHiddenByGroupPermissions(stored) || isForgedChatMode(stored, stored.origin)) continue;
      if (isClearedForMe(stored)) continue;
      if (stored.deleted) continue;
      deps.media.rememberKeys(stored.content);
      wireFlagsByUuid.set(stored.id, buildWireFlags(stored));
      const message = store.buildApiMessage(stored);
      store.putMessage(message);
      rememberRowMeta(stored);
      rememberWebPage(stored);
      void deps.rows?.persistLocal(stored)
        .catch((e: unknown) => deps.log(`строка ${stored.id} не записана: ${String(e)}`));
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
    void resolveDisplayNames(Array.from(peerAddresses));
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
    const address = store.getAddressForId(chatId);
    const fromModel = address ? deps.history?.unreadOf?.(address) : undefined;
    if (fromModel) {
      return fromModel.mentions
        .map((uuid) => store.getMessageByUuid(uuid)?.id)
        .filter((id): id is number => id !== undefined);
    }
    const unread = unreadIdsOf(chatId);
    return store.getMessages(chatId)
      .filter((message) => store.isMentionOfSelf(message) && unread.has(message.id))
      .map((message) => message.id);
  }

  function pushMentionState(chatId: string) {
    const unreadMentions = collectUnreadMentions(chatId);
    // Число — модели (spec 036 T015: в сторе может быть ещё не весь чат), id — прочитанных в стор
    const address = deps.getStore().getAddressForId(chatId);
    const fromModel = address ? deps.history?.unreadOf?.(address) : undefined;
    deps.sendUpdate({
      '@type': 'updateThreadReadState',
      chatId,
      threadId: MAIN_THREAD_ID,
      readState: {
        unreadMentionsCount: Math.max(unreadMentions.length, fromModel?.mentions.length ?? 0),
        unreadMentions,
      },
    });
  }

  // Протокол v2 (spec 007): строка вне журнала истории (заглушка, служебное о режиме L2, самоуничтожение),
  // собранная из события движка, — строкой модели (её пачка ложится на диск раньше курсора инбокса, SYNC-1), показ —
  // из представления модели. Нет модели — только показ
  async function applyExternal(stored: WireStoredMessage) {
    const next: WireStoredMessage = { ...stored, origin: 'v2' };
    if (deps.rows) await deps.rows.persistLocal(next);
    else await applyStoredUpdate(next);
  }

  // Модель открылась позже начала показа: её строки — на экран обычным путём (с апдейтами UI)
  // (spec 036 T015: последние строки чатов; чат целиком — при обращении, как после обычного запуска)
  async function restoreLate() {
    if (!isRestorePending || !isSynced || !deps.rows) return;
    const last = await deps.rows.lastRows();
    if (!last) return;
    isRestorePending = false;
    // Чаты, уже прочитанные без модели (журнал исходящих), — заново целиком при обращении
    loadedChatIds.clear();
    const fresh = freshOf(last);
    for (const stored of fresh) await applyStoredUpdate(stored);
    deps.log(`история из модели показана после её открытия: последних строк ${fresh.length}`);
  }

  // Строка модели (spec 033, spec 035 T114): её уже записала модель — только показ
  function showRow(stored: WireStoredMessage) {
    return applyStoredUpdate(stored);
  }

  /** Сообщения участника группы скрыты либо снова показаны у себя (REPORT-3; решает приёмный фильтр модели):
   * скрытые уходят из стора и с экрана (строки модели остаются), показанные снова читаются из модели — экран
   * забирает их `fetchMessages`. */
  async function applyMemberHidden(chatId: string, author: string, isHidden: boolean) {
    const store = deps.getStore();
    if (!isHidden) {
      loadedChatIds.delete(chatId);
      await ensureChatLoaded(chatId);
      return;
    }
    const ids = store.getMessages(chatId)
      .filter((message) => message.senderId && store.getAddressForId(message.senderId) === author)
      .map(({ id }) => id);
    ids.forEach((id) => store.removeMessage(chatId, id));
    if (ids.length) deps.sendUpdate({ '@type': 'deleteMessages', ids, chatId });
  }

  return {
    applyExternal,
    applyMemberHidden,
    showRow,
    restoreLate,
    ensureChatLoaded,
    ensureAllLoaded,
    releaseGroupRows,
    announcePeer,
    collectUnreadMentions,
    ensureSynced,
    forgetMessages,
    pushMentionState,
    announceKeyChange,
    announceRename,
    getReadOutboxMax: (chatId: string) => readOutboxMaxByChatId.get(chatId),
    rowMeta: (uuid: string) => rowMetaByUuid.get(uuid),
    isSynced: () => isSynced,
    isUnreadIncoming,
    unreadIdsOf,
    pushReadState,
    markDeleted: (uuid: string) => {
      const flags = wireFlagsByUuid.get(uuid);
      if (flags) flags.deleted = true;
    },
    reset,
    resetPromise,
    resolveDisplayNames,
  };
}
