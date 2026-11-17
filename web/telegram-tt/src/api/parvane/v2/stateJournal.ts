// Протокол v2 (spec 007, T098, R10; spec 035 T114): папки, блок-лист, черновики, отложенные, архив и закреп —
// из журнала личного состояния `state.v2` (`state.ops.*`, шифртекст на ключе личного состояния). Журнал, сведение
// (регистры по полям, метки, множества) и разница по полям ведёт модель движка (`StateModel`, `v2/engine.ts`):
// здесь нет ни лампортов, ни сравнения меток (ENGINE-1). spec 036 T019: показ — объекты модели по видам
// (`viewStateJson`, значение — proto3-JSON сообщения вида) прямо в localState и нативные апдейты UI; правка
// пользователя в localState (рабочая копия UI, правленые виды переживают перезагрузку) → объекты своего вида →
// `stateSet` с показанным (`base`) / удаление показанного / `stateMark`. Промежуточного снимка формы `state.v1` нет.
// Первый запуск переносит локальные данные в журнал. Без v2-стека журнал не подключается — всё как раньше.

import type { ApiChatFolder, ApiDraft, ApiMessageEntity, ApiUpdate } from '../../types';
import type { LocalContactInfo, SContact } from '../contactInfo';
import type {
  createLocalState, JournalScheduled, LocalQuickReaction, LocalStateKind, LocalStickerPack,
} from '../localState';
import type { ParvaneStore } from '../store';
import type { WireCallRecord } from '../wire';
import type { CloudStateEntry } from './cloud';
import type { V2SharedInvite } from './controller';
import type { StateModel, StateModelView } from './engine';
import { MAIN_THREAD_ID } from '../../types';

import { ARCHIVED_FOLDER_ID } from '../../../config';
import { contactsFromState, contactsToState, mergeContactsLocalWins } from '../contactInfo';
import { apiEntitiesToWire, wireEntitiesToApi } from '../entities';
import { soundFromState, soundToState } from '../notifyDefaults';
import {
  b64ToUuid, contentOfWire, uuidToB64, type V2Content, type V2Text, wireOfContent,
} from './contentMap';
import { isV2GroupAddress } from './controller';
import { isTimerSyncMode, pollDelay } from './l2';
import {
  carriedObjects, favedOf, hasPersonalState, isScheduledSent, K, managedKinds, MARK_CHAT_CLEARED,
  MARK_SCHEDULED_SENT, markBytes, markValue, objectsOf, objectsOfKinds, peerKeyOf, peerOfKey, PIN_KEY_MAIN,
  planStateWrites, type StateMarkArgs, type StateObject, type StateSetArgs, valueOf,
} from './stateObjects';

/** Что журналу нужно от v2-стека (контроллер). */
export type StateJournalHost = {
  /** Модель личного состояния (undefined — нет ключа личного состояния). */
  openModel: () => Promise<StateModel | undefined>;
  encode: (type: string, json: string) => Uint8Array;
  decode: (type: string, bytes: Uint8Array) => string;
  domain: () => string;
  log: (message: string) => void;
};

type LocalState = ReturnType<typeof createLocalState>;

/** Избранный стикер из журнала. */
export type FavedSticker = { setId: string; stickerId: string; addedMs: number };

type Deps = {
  localState: LocalState;
  getStore: () => ParvaneStore;
  sendUpdate: (update: ApiUpdate) => void;
  /** История звонков из журнала (D-08: сервер её не ведёт) — записи в чаты. */
  applyCallRecords?: (records: WireCallRecord[]) => void;
  /** Чат очищен на другом своём устройстве: скрыть сообщения не позже границы (мс). */
  applyChatCleared?: (address: string, untilMs: number) => void;
  /** Ссылки-приглашения групп v2 (T160): действующие ссылки этого устройства и
   * приём ссылок, созданных другими своими устройствами. */
  sharedInvites?: {
    list: () => Promise<V2SharedInvite[]>;
    merge: (invites: V2SharedInvite[]) => Promise<void>;
  };
  /** Записи приняты сервером — другие вкладки этого браузера (то же устройство) догоняют сразу. */
  onAppended?: () => void;
  /** Свои наборы стикеров из журнала (PACK-3): установить недостающие, снять убранные (`removed`). */
  applyStickerPacks?: (packs: LocalStickerPack[], removed: string[]) => void;
  /** Контакты из журнала (CONTACT-1): явные контакты, их имена и заметки; `removed` — убранные из контактов. */
  applyContacts?: (addresses: string[], info: Record<string, LocalContactInfo>, removed: string[]) => void;
  /** Избранные стикеры из журнала (FR-075, `FAVED_STICKER`): новые сначала. */
  applyFavedStickers?: (faved: FavedSticker[]) => void;
  /** Журнал закрыт для записи более новой версией (критичный неизвестный вид, T117). */
  onWriteBlocked?: () => void;
  log: (message: string) => void;
};

// proto3-JSON `state.v1.*` (имена полей схемы, bytes — base64, int64 — строки)
type SPeer = { user?: { address: string }; group?: { domain: string; id: string } };
type SFolder = {
  id: number;
  title?: string;
  emoticon?: string;
  include_peers?: SPeer[];
  exclude_peers?: SPeer[];
  pinned_peers?: SPeer[];
  contacts?: boolean;
  non_contacts?: boolean;
  groups?: boolean;
  channels?: boolean;
  bots?: boolean;
  exclude_muted?: boolean;
  exclude_read?: boolean;
  exclude_archived?: boolean;
  color?: number;
};
type SDraft = { peer?: SPeer; text?: string; reply_to_op_id?: string; date_ms?: string };
type SScheduled = { op_id?: string; peer?: SPeer; send_at_ms?: string; content?: string };
type SPinned = { list?: string | number; peers?: SPeer[] };
type SCall = {
  call_id?: string;
  peer?: SPeer;
  outgoing?: boolean;
  video?: boolean;
  reason?: string | number;
  started_ms?: string;
  duration_s?: number;
};
// `state.v1.GroupInvite`: ссылка-приглашение группы v2 (bytes — base64)
type SInvite = {
  group_id?: string;
  link_id?: string;
  url?: string;
  created_ms?: string;
  title?: string;
  expires_ms?: string;
  usage_limit?: number;
  requires_approval?: boolean;
};
// `state.v1.QuickReaction`: эмодзи либо id собственного эмодзи; пусто — реакция по умолчанию
type SQuickReaction = { emoji?: string; custom_emoji_id?: string };
// `state.v1.NotifySettings`: без звука до момента (мс эпохи, int64 — строкой)
type SNotify = { mute_until_ms?: string; sound?: string; show_previews?: boolean; silent?: boolean };
// `state.v1.NotifyDefaults`: умолчания по типам чатов
type NotifyDefaults = { users?: SNotify; groups?: SNotify; channels?: SNotify };
// Локальный вид настроек уведомлений чата (поля ApiPeerNotifySettings)
type LocalNotify = Record<string, unknown>;
const NOTIFY_DEFAULT_TYPES = ['users', 'groups', 'channels'] as const;

const MANAGED_KINDS: LocalStateKind[] = [
  'folders', 'blocked', 'drafts', 'scheduled', 'archived', 'pinned', 'notify', 'unread', 'reaction', 'packs',
  'contacts',
];
// Виды, появившиеся в журнале позже первого переноса (миграция — один раз на вид)
// `contacts` переносится иначе — только недостающим (контакты разных устройств складываются, а не вытесняются)
const LATE_KINDS: LocalStateKind[] = ['notify', 'unread', 'reaction', 'packs', 'contacts'];
const PIN_LIST_MAIN = 'PIN_LIST_MAIN';
// Показ после изменения модели — пачкой (несколько изменений одного итога — один показ)
const PROJECT_DELAY_MS = 50;
// Причина завершения звонка (`call.v2.HangupReason`): имя и числовое значение
const HANGUP_NORMAL = 'HANGUP_REASON_NORMAL';
const HANGUP_DECLINED = 'HANGUP_REASON_DECLINED';
const HANGUP_BUSY = 'HANGUP_REASON_BUSY';
const HANGUP_MISSED = 'HANGUP_REASON_MISSED';
const HANGUP_BY_NUMBER = [undefined, HANGUP_NORMAL, HANGUP_DECLINED, HANGUP_BUSY, HANGUP_MISSED];
const NO_COLOR = -1;
const ALL_CHATS_FOLDER_ID = 0;

// Порядок папок с «Все чаты» (id 0) на месте index; 0 — первыми
function withAllFolder(ids: number[], index: number) {
  const out = ids.filter((id) => id !== ALL_CHATS_FOLDER_ID);
  out.splice(Math.min(Math.max(0, index), out.length), 0, ALL_CHATS_FOLDER_ID);
  return out;
}
const MS_IN_SECOND = 1000;
const FLUSH_DELAY_MS = 700;
// SC-009: правка с другого устройства видна ≤ 10 с (запись 0,7 с + синк). С spec 033 запись в журнал будит прочие
// свои устройства живым уведомлением (`JournalNotice{STATE}` → `syncNow`), опрос — только страховка (раз в минуту,
// как и в скрытой вкладке); при возврате на вкладку — сразу
const SYNC_INTERVAL_MS = 60000;
const SYNC_HIDDEN_MS = 60000;
const V2_GROUP_PREFIX = 'v2g:';
const UUID_HEX_LENGTH = 32;
// Контейнеры облака (spec 016): значения перечислений proto3-JSON (имя либо число)
const CLOUD_ROLE_NAMES = {
  root: 'CLOUD_CONTAINER_ROLE_ROOT', owned: 'CLOUD_CONTAINER_ROLE_OWNED', shared: 'CLOUD_CONTAINER_ROLE_SHARED',
} as const;
const CLOUD_STATUS_NAMES = {
  accepted: 'CLOUD_SHARE_STATUS_ACCEPTED', declined: 'CLOUD_SHARE_STATUS_DECLINED',
} as const;
const CLOUD_ROLES: Record<string, CloudStateEntry['role'] | undefined> = {
  [CLOUD_ROLE_NAMES.root]: 'root', 1: 'root',
  [CLOUD_ROLE_NAMES.owned]: 'owned', 2: 'owned',
  [CLOUD_ROLE_NAMES.shared]: 'shared', 3: 'shared',
};
const CLOUD_STATUSES: Record<string, CloudStateEntry['status']> = {
  [CLOUD_STATUS_NAMES.accepted]: 'accepted', 1: 'accepted',
  [CLOUD_STATUS_NAMES.declined]: 'declined', 2: 'declined',
};

export function createStateJournal(deps: Deps) {
  let host: StateJournalHost | undefined;
  let session: StateModel | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let isVisibilityListened = false;
  // Показ модели: сбрасывается при любом изменении журнала. Его читают по многу раз за опрос (контейнеры облака —
  // на каждый вызов `rootId`)
  let viewCache: StateModelView | undefined;
  let writeBlocked = false;
  let favedShown = '';
  // Показ модели без сети (T118): до подключения журнала — то, что модель свела в прошлый раз
  let offlineView: StateModelView | undefined;
  // Что localState показывал последним — объекты модели по видам: правка пользователя — разница с ними, а не со
  // сведённым, иначе устаревшая локальная копия откатила бы правку другого устройства, пришедшую после показа (US2);
  // удаляются только показанные объекты
  let shown: Map<string, StateObject[]> | undefined;
  let cloudEntriesCache: { view: StateModelView | undefined; entries: CloudStateEntry[] } | undefined;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  function invalidateView() {
    viewCache = undefined;
  }

  /** Записи объектов → модель (в журнал уходят только изменившиеся поля); другие вкладки догоняют сразу. */
  async function commit(sets: StateSetArgs[], marks: StateMarkArgs[]) {
    if (!session) return;
    await session.write({ sets, marks });
    invalidateView();
    deps.onAppended?.();
  }

  /** Явная запись объектов (звонок, ссылка, контейнер, отметки): новые и изменившиеся относительно модели;
   * `rewrite` — переписать целиком (новый ключ личного состояния). */
  async function put(objects: StateObject[], rewrite = false) {
    if (!session) return;
    const { sets, marks } = planStateWrites({ desired: objects, current: session.objects(), rewrite });
    await commit(sets, marks);
  }

  /** Виды localState → объекты своих видов модели. `fromShown` — правка пользователя: разница с показанным (с ним
   * же — что удалять), `prune` — удалить пропавшие из вида, `localWins` — контакты поверх модели без удалений. */
  async function writeKinds(
    kinds: LocalStateKind[], opts: { prune?: boolean; fromShown?: boolean; localWins?: boolean } = {},
  ) {
    if (!session || !kinds.length) return;
    const current = session.objects();
    const sets: StateSetArgs[] = [];
    const marks: StateMarkArgs[] = [];
    const written: [string[], StateObject[]][] = [];
    kinds.forEach((kind) => {
      let desired = localObjects(kind, current);
      if (kind === 'contacts' && opts.localWins) {
        const have = current.filter((o) => o.kind === K.contact).map((o) => valueOf(o) as SContact);
        desired = contactObjects(mergeContactsLocalWins(have, desired.map((o) => valueOf(o) as SContact)));
      }
      const modelKinds = Array.from(managedKinds([kind]));
      const base = opts.fromShown && shown && modelKinds.every((k) => shown!.has(k))
        ? modelKinds.flatMap((k) => shown!.get(k)!) : undefined;
      const plan = planStateWrites({
        desired, current, base, kinds: [kind], prune: opts.prune,
      });
      sets.push(...plan.sets);
      marks.push(...plan.marks);
      written.push([modelKinds, desired]);
    });
    await commit(sets, marks);
    if (!opts.fromShown) return;
    shown = shown || new Map();
    written.forEach(([modelKinds, desired]) => modelKinds.forEach((k) => {
      shown!.set(k, desired.filter((o) => o.kind === k));
    }));
  }

  function isHidden() {
    return typeof document !== 'undefined' && document.hidden;
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = undefined;
    if (!session) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void syncNow().catch((e: unknown) => deps.log(`v2: синк журнала состояния: ${String(e)}`));
    }, pollDelay(SYNC_INTERVAL_MS, SYNC_HIDDEN_MS, !isHidden()));
  }

  function listenVisibility() {
    if (isVisibilityListened || typeof document === 'undefined') return;
    isVisibilityListened = true;
    document.addEventListener('visibilitychange', () => {
      if (!session) return;
      // Режим L2: возврат на вкладку не должен вызывать опрос вне ритма таймера (spec 025)
      if (!document.hidden && !isTimerSyncMode()) {
        void syncNow().catch((e: unknown) => deps.log(`v2: синк журнала состояния: ${String(e)}`));
      } else {
        scheduleSync();
      }
    });
  }

  // Отметка переноса: '2' — локальное перенесено в журнал state.v2 (spec 035). Профиль с прежней отметкой '1'
  // (перенос в замороженный state.v1) переносит локальную копию ещё раз — в новый журнал; одинаковые значения с
  // других своих устройств сводятся без дублей. Разовый перенос замороженного журнала движком — с переходом web
  // целиком на модель (T115)
  const MIGRATED = '2';

  function migratedKey() {
    return `parvane:v2state-migrated:${deps.getStore().self}`;
  }

  function isMigrated() {
    try {
      return localStorage.getItem(migratedKey()) === MIGRATED;
    } catch {
      return false;
    }
  }

  // Вид `notify` (T132) появился позже первого переноса: на устройстве, уже
  // перенёсшем состояние, локальные настройки уведомлений уходят в журнал один
  // раз — иначе первая же проекция журнала (в нём их ещё нет) стёрла бы их
  function kindMigratedKey(kind: LocalStateKind) {
    return `${migratedKey()}:${kind}`;
  }

  function markKindMigrated(kind: LocalStateKind) {
    try {
      localStorage.setItem(kindMigratedKey(kind), MIGRATED);
    } catch {
      // приватный режим — перенос повторится и сойдётся (LWW)
    }
  }

  // Вид пуст в журнале — локальное значение уходит туда; иначе главнее журнал
  function isKindEmpty(kind: LocalStateKind) {
    const view = readView();
    if (kind === 'folders') return !objectsOf(view, K.folder).length;
    if (kind === 'scheduled') {
      return !objectsOf(view, K.scheduled).some((o) => !isScheduledSent(o) && Object.keys(valueOf(o)).length);
    }
    if (kind === 'pinned') {
      return !objectsOf(view, K.pinList).some((o) => (valueOf(o).peers as unknown[] | undefined)?.length);
    }
    return !Array.from(managedKinds([kind])).some((k) => objectsOf(view, k).length);
  }

  async function migrateLateKinds() {
    if (!session) return;
    const kinds = LATE_KINDS.filter((kind) => {
      try {
        return localStorage.getItem(kindMigratedKey(kind)) !== MIGRATED;
      } catch {
        return true; // приватный режим — переносим
      }
    });
    if (kinds.includes('contacts')) {
      await put(localObjects('contacts', []));
      deps.log('v2: контакты перенесены в журнал');
    }
    const empty = kinds.filter((kind) => kind !== 'contacts' && isKindEmpty(kind));
    if (empty.length) {
      await writeKinds(empty, { prune: true, fromShown: true });
      deps.log(`v2: ${empty.join(', ')} перенесены в журнал`);
    }
    kinds.forEach(markKindMigrated);
  }

  function markMigrated() {
    try {
      localStorage.setItem(migratedKey(), MIGRATED);
    } catch {
      // приватный режим — повторная миграция сходится (union по LWW)
    }
  }

  // `rekey` — ключ личного состояния сменён (отзыв устройства, D-16):
  // 'self' — этим устройством: сведённое состояние переносится записями под
  // новым ключом (старые записи новым ключом не читаются); 'peer' — другим
  // своим устройством: ждём его записей, локальное состояние не трогаем
  async function attach(nextHost: StateJournalHost, rekey?: 'self' | 'peer') {
    const carried = rekey === 'self' && session ? carriedObjects(readView()) : undefined;
    detach();
    const nextSession = await nextHost.openModel().catch((e: unknown) => {
      deps.log(`v2: модель личного состояния не открыта: ${String(e)}`);
      return undefined;
    });
    if (!nextSession) {
      deps.log('v2: журнал состояния недоступен — нет ключа личного состояния');
      return;
    }
    host = nextHost;
    session = nextSession;
    offlineView = undefined;
    session.onChange(onModelChange);
    await serial(async () => {
      // Ключи наборов стикеров и GIF (C7-3), черновики — в шифрованном хранилище: до загрузки снимок отдал бы
      // в журнал записи без них
      await deps.localState.hydrate().catch(() => undefined);
      const isReadable = await pullRemote();
      if (carried) {
        await put(carried, true);
        deps.log('v2: журнал состояния перенесён под новый ключ');
      } else if (rekey && !isReadable) {
        // Записей под новым ключом ещё нет: пустой снимок стёр бы локальные
        // папки и блок-лист — проекция после первого удачного синка
        return;
      }
      if (!isMigrated()) {
        // Первый запуск на v2: локальные данные — начальными записями журнала. Основа — уже сведённое моделью
        // (журнал сервера): время блокировки и прочие поля, которых нет в локальном виде, не перезаписываются
        // «сейчас» (spec 035 T109: после разового переноса блок-лист менял `blocked_at_ms`). Только виды, пустые в
        // журнале: другое своё устройство могло перенести раньше и править после — локальная копия этого
        // устройства старше (оно было выключено), и свежие метки переноса откатили бы те правки (spec 035 T142,
        // вариант month). Несохранённые правки этого устройства дописывает `flushDirty`; так же переносит движок
        // (`state::without_present`)
        const empty = MANAGED_KINDS.filter((kind) => !LATE_KINDS.includes(kind) && isKindEmpty(kind));
        if (empty.length) await writeKinds(empty, { prune: true });
        markMigrated();
        deps.log(empty.length
          ? `v2: локальное состояние перенесено в журнал (${empty.join(', ')})`
          : 'v2: журнал уже несёт личное состояние — локальная копия не переносится');
      }
      await migrateLateKinds();
      await flushDirty();
      show();
    }).catch((e: unknown) => deps.log(`v2: журнал состояния не прочитан: ${String(e)}`));
    deps.localState.setChangeListener(scheduleFlush);
    deps.localState.setScheduledHooks({ gate: canSendScheduled, sent: markScheduledSent });
    listenVisibility();
    scheduleSync();
    deps.log('v2: журнал состояния подключён');
  }

  function isAttached() {
    return Boolean(session);
  }

  /** Показ модели без сети (T118): журнал ещё не подключён — виды localState из сведённого в прошлый раз. */
  function showOffline(view: StateModelView | undefined) {
    if (session || !view) return;
    offlineView = view;
    invalidateView();
    show(true);
    deps.log('v2: личное состояние показано из модели без сети');
  }

  function detach() {
    if (flushTimer) clearTimeout(flushTimer);
    if (syncTimer) clearTimeout(syncTimer);
    if (showTimer) clearTimeout(showTimer);
    flushTimer = undefined;
    syncTimer = undefined;
    showTimer = undefined;
    deps.localState.setChangeListener(undefined);
    deps.localState.setScheduledHooks(undefined);
    session?.onChange(undefined);
    session?.close();
    session = undefined;
    host = undefined;
    invalidateView();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void serial(flushLocal).catch((e: unknown) => deps.log(`v2: запись журнала состояния: ${String(e)}`));
    }, FLUSH_DELAY_MS);
  }

  /** Модель сменила показ (свои и чужие операции, догон журнала по живому уведомлению): показ — заново и сразу,
   * вне обработчика изменений модели. Раньше показ ждал планового синка — правка другого устройства (снятая отметка
   * «непрочитано») показывалась позже 10 с. */
  function onModelChange() {
    invalidateView();
    if (showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = undefined;
      void serial(() => {
        // Своя правка ещё не в журнале — показ не трогаем: его обновит отправка правки (иначе показ модели поверх
        // набранного терял, например, заметку контакта)
        if (!session || deps.localState.loadDirtyKinds().length) return Promise.resolve();
        invalidateView();
        show();
        return Promise.resolve();
      }).catch((e: unknown) => deps.log(`v2: показ личного состояния не обновлён: ${String(e)}`));
    }, PROJECT_DELAY_MS);
  }

  function syncNow() {
    return serial(async () => {
      try {
        await flushLocal();
        await pullRemote();
        show();
      } finally {
        scheduleSync();
      }
    });
  }

  async function flushLocal() {
    if (!session) return;
    const revision = deps.localState.getDirtyRevision();
    // Виды журнала ещё не показаны (T118: на диске их нет) — пропавшее из localState не удалять
    const prune = deps.localState.isPersonalComplete();
    await writeKinds(MANAGED_KINDS, { prune, fromShown: true });
    deps.localState.clearDirtyKinds(revision);
  }

  // Подключение журнала: правки, сделанные до него (перед перезагрузкой, пока
  // v2 поднимался, без сети), уходят в журнал ДО проекции снимка — иначе снимок
  // их затрёт. Только несохранённые виды: остальные могли смениться на другом
  // устройстве, и локальная копия там устарела
  async function flushDirty() {
    if (!session) return;
    const kinds = deps.localState.loadDirtyKinds().filter((kind) => MANAGED_KINDS.includes(kind));
    if (!kinds.length) return;
    const revision = deps.localState.getDirtyRevision();
    // Правлено до показа модели (T118): значение вида могло не нести того, что уже в журнале, — без удалений
    const partial = deps.localState.loadPartialKinds();
    const prune = !kinds.some((kind) => partial.includes(kind));
    // Контакты: свои правки поверх журнала без удалений — там могут быть контакты с других устройств
    await writeKinds(kinds, { prune, fromShown: true, localWins: true });
    deps.localState.clearDirtyKinds(revision);
    deps.log(`v2: несохранённые правки (${kinds.join(', ')}) дописаны в журнал`);
  }

  /** Свои неотправленные — серверу, затем записи журнала после курсора (ведёт модель). true — в журнале под
   * текущим ключом что-то есть (после смены ключа другим устройством пустой показ не стирает локальное). */
  async function pullRemote() {
    if (!session) return false;
    await session.sync();
    invalidateView();
    return hasPersonalState(readView());
  }

  function readView(): StateModelView | undefined {
    if (!session) return offlineView;
    if (!viewCache) {
      try {
        viewCache = session.view();
      } catch (e) {
        deps.log(`v2: показ личного состояния: ${String(e)}`);
        return undefined;
      }
    }
    return viewCache;
  }

  /** Значения объектов вида в показе (proto3-JSON сообщения вида). */
  function valuesOf<T>(kind: string): T[] {
    return objectsOf(readView(), kind).map((o) => valueOf(o) as T);
  }

  // ── избранные стикеры (FR-075): объект FAVED_STICKER, правка — намерением модели ──────────────────────

  function favedStickers(): FavedSticker[] {
    return favedOf(readView())
      .map((f) => ({ setId: f.set_id, stickerId: f.sticker_id, addedMs: Number(f.added_ms || 0) }))
      .sort((a, b) => b.addedMs - a.addedMs);
  }

  /** «В избранное» / «Убрать из избранного». false — журнал не подключён. */
  function faveSticker(setId: string, stickerId: string, isFaved: boolean) {
    return serial(async () => {
      if (!session) return false;
      await session.submit({ fave_sticker: { set_id: setId, sticker_id: stickerId, on: isFaved } });
      invalidateView();
      deps.onAppended?.();
      showFaved();
      return true;
    });
  }

  function showFaved() {
    const list = favedStickers();
    const key = JSON.stringify(list);
    if (key === favedShown) return;
    favedShown = key;
    deps.applyFavedStickers?.(list);
  }

  function showWriteBlocked() {
    const isBlocked = Boolean(readView()?.write_blocked);
    if (isBlocked && !writeBlocked) deps.onWriteBlocked?.();
    writeBlocked = isBlocked;
  }

  // ── отложенные: отправляет первое устройство, заметившее срок ─────────────

  async function canSendScheduled(opId: string) {
    if (!session) return true;
    await syncNow().catch(() => undefined);
    return !isScheduledSent(objectsOf(readView(), K.scheduled).find((o) => o.key === scheduledKey(opId)));
  }

  function markScheduledSent(opId: string) {
    void serial(async () => {
      await put([{
        kind: K.scheduled, key: scheduledKey(opId), marks: [{ field: MARK_SCHEDULED_SENT, value: markBytes(1) }],
      }]);
    }).catch((e: unknown) => deps.log(`v2: отметка отправки отложенного: ${String(e)}`));
  }

  // ── контейнер планировщика (spec 010) ──────────────────────────────────────

  // Личный контейнер домена («План», «Здоровье» — spec 038): регистр своего вида, одна форма значения
  function personalContainer(kind: string): { domain: string; id: string } | undefined {
    const [container] = valuesOf<{ ref?: { domain?: string; id?: string } }>(kind);
    const ref = container?.ref;
    if (!ref?.domain || !ref.id) return undefined;
    return { domain: ref.domain, id: b64ToHex(ref.id) };
  }

  function recordPersonalContainer(kind: string, ref: { domain: string; id: string }) {
    void serial(async () => {
      await put([{ kind, key: '', value: { ref: { domain: ref.domain, id: hexToB64(ref.id) } } }]);
    }).catch((e: unknown) => deps.log(`v2: запись контейнера (${kind}) в журнал состояния: ${String(e)}`));
  }

  /** Контейнер планировщика, объявленный любым своим устройством: {domain, id(hex)}. */
  const plannerContainer = () => personalContainer(K.plannerContainer);
  /** Объявить свой контейнер планировщика (LWW-регистр, один на пользователя). */
  const recordPlannerContainer = (ref: { domain: string; id: string }) => (
    recordPersonalContainer(K.plannerContainer, ref)
  );
  const healthContainer = () => personalContainer(K.healthContainer);
  const recordHealthContainer = (ref: { domain: string; id: string }) => (
    recordPersonalContainer(K.healthContainer, ref)
  );
  const musicContainer = () => personalContainer(K.musicContainer);
  const recordMusicContainer = (ref: { domain: string; id: string }) => (
    recordPersonalContainer(K.musicContainer, ref)
  );

  // ── контейнеры облака (spec 016) ───────────────────────────────────────────

  /** Контейнеры облака из журнала: личный диск, свои и чужие совместные папки.
   * Пока показ не менялся, возвращается тот же массив (по нему кэшируется `rootId`). */
  function cloudEntries(): CloudStateEntry[] {
    const view = readView();
    if (cloudEntriesCache && cloudEntriesCache.view === view) return cloudEntriesCache.entries;
    const entries = parseCloudEntries();
    cloudEntriesCache = { view, entries };
    return entries;
  }

  function parseCloudEntries(): CloudStateEntry[] {
    const list = valuesOf<{
      ref?: { domain?: string; id?: string }; role?: string | number; status?: string | number;
      removed?: boolean; owner?: string;
    }>(K.cloudContainer);
    const out: CloudStateEntry[] = [];
    list.forEach((c) => {
      const role = CLOUD_ROLES[String(c.role)];
      if (!c.ref?.id || !role) return;
      out.push({
        id: b64ToHex(c.ref.id),
        domain: c.ref.domain || '',
        role,
        status: CLOUD_STATUSES[String(c.status)],
        isRemoved: Boolean(c.removed),
        owner: c.owner || undefined,
      });
    });
    return out;
  }

  /** Записать контейнер облака (множество по ссылке, запись целиком по метке). */
  function recordCloudEntry(entry: CloudStateEntry) {
    void serial(async () => {
      const id = hexToB64(entry.id);
      if (!id) return;
      await put([{
        kind: K.cloudContainer,
        key: `${entry.domain}:${b64ToHex(id)}`,
        value: {
          ref: { domain: entry.domain, id },
          role: CLOUD_ROLE_NAMES[entry.role],
          status: entry.status ? CLOUD_STATUS_NAMES[entry.status] : undefined,
          removed: Boolean(entry.isRemoved),
          owner: entry.owner || '',
        },
      }]);
    }).catch((e: unknown) => deps.log(`v2: запись контейнера облака в журнал состояния: ${String(e)}`));
  }

  // ── история звонков (D-08): явная запись, не разница снимков ──────────────

  /** Завершённый звонок по v2 — в журнал: виден на всех своих устройствах и после reload. */
  function recordCall(record: WireCallRecord) {
    void serial(async () => {
      const body = callToState(record);
      if (!body) return;
      await put([{ kind: K.call, key: b64ToHex(body.call_id || ''), value: body }]);
    }).catch((e: unknown) => deps.log(`v2: запись звонка в журнал состояния: ${String(e)}`));
  }

  // ── «удалить чат у себя» (T145): явная запись, граница только растёт ───────

  /** Чат очищен на этом устройстве — остальные свои скроют сообщения не позже `untilMs`. */
  function recordChatCleared(address: string, untilMs: number) {
    deps.localState.saveClearedUntil(address, untilMs);
    void serial(async () => {
      if (!session) return;
      const peer = peerOf(address);
      if (!peer || !(untilMs > 0)) return;
      await put([{
        kind: K.chatCleared, key: peerKeyOf(peer), marks: [{ field: MARK_CHAT_CLEARED, value: markBytes(untilMs) }],
      }]);
    }).catch((e: unknown) => deps.log(`v2: запись очистки чата в журнал состояния: ${String(e)}`));
  }

  // ── ссылки-приглашения групп v2 (T160) ─────────────────────────────────────
  // Секрет ссылки знает только создавшее её устройство: запись журнала делит
  // ссылку между своими устройствами (в v1 основная ссылка у аккаунта одна).

  function recordGroupInvite({ address, record }: V2SharedInvite) {
    void serial(async () => {
      if (!session || !isV2GroupAddress(address)) return;
      const invite = inviteToState(address, record);
      await put([{ kind: K.groupInvite, key: b64ToHex(invite.link_id || ''), value: invite }]);
    }).catch((e: unknown) => deps.log(`v2: запись ссылки-приглашения в журнал состояния: ${String(e)}`));
  }

  function removeGroupInvite(linkId: string) {
    void serial(async () => {
      if (!session) return;
      await commit([{ kind: K.groupInvite, key: linkId, delete: true }], []);
    }).catch((e: unknown) => deps.log(`v2: снятие ссылки-приглашения в журнале состояния: ${String(e)}`));
  }

  async function showInvites() {
    if (!deps.sharedInvites) return;
    const shared = valuesOf<SInvite>(K.groupInvite).map(inviteFromState)
      .filter((item): item is V2SharedInvite => Boolean(item));
    await deps.sharedInvites.merge(shared);
    // Ссылки этого устройства, которых в журнале ещё нет (созданы до T160)
    const known = new Set(shared.map(({ record }) => record.linkId));
    (await deps.sharedInvites.list()).filter(({ record }) => !known.has(record.linkId)).forEach(recordGroupInvite);
  }

  function showCleared() {
    objectsOf(readView(), K.chatCleared).forEach((o) => {
      const address = addressOf(peerOfKey(o.key) as SPeer | undefined);
      const untilMs = Number(markValue(o, MARK_CHAT_CLEARED));
      if (!address || !(untilMs > 0)) return;
      if (deps.localState.saveClearedUntil(address, untilMs)) deps.applyChatCleared?.(address, untilMs);
    });
  }

  function callToState(record: WireCallRecord): SCall | undefined {
    const self = deps.getStore().self;
    const isOutgoing = record.caller === self;
    const peer = peerOf(isOutgoing ? record.callee : record.caller);
    if (!peer?.user) return undefined;
    const isEnded = record.status === 'ended';
    return {
      call_id: uuidToB64(record.call_id),
      peer,
      outgoing: isOutgoing,
      video: record.media === 'video',
      reason: isEnded ? HANGUP_NORMAL : record.status === 'rejected' ? HANGUP_DECLINED : HANGUP_MISSED,
      started_ms: String(record.started_at * MS_IN_SECOND),
      duration_s: isEnded && record.ended_at ? Math.max(1, record.ended_at - record.started_at) : 0,
    };
  }

  function stateToCall(call: SCall): WireCallRecord | undefined {
    const callId = b64ToUuid(call.call_id);
    const peer = call.peer?.user?.address;
    if (!callId || !peer) return undefined;
    const self = deps.getStore().self;
    const reason = typeof call.reason === 'number' ? HANGUP_BY_NUMBER[call.reason] : call.reason;
    const startedAt = Math.floor(Number(call.started_ms || 0) / MS_IN_SECOND);
    const status = reason === HANGUP_MISSED ? 'missed'
      : (reason === HANGUP_DECLINED || reason === HANGUP_BUSY) ? 'rejected' : 'ended';
    return {
      call_id: callId,
      caller: call.outgoing ? self : peer,
      callee: call.outgoing ? peer : self,
      media: call.video ? 'video' : 'audio',
      status,
      started_at: startedAt,
      ended_at: status === 'ended' ? startedAt + (call.duration_s || 0) : undefined,
    };
  }

  function showCalls() {
    const records = valuesOf<SCall>(K.call).map(stateToCall).filter((r): r is WireCallRecord => Boolean(r));
    if (records.length) deps.applyCallRecords?.(records.sort((a, b) => a.started_at - b.started_at));
  }

  // ── правка UI: вид localState → объекты своего вида модели ──────────────

  /** Объекты видов модели, которыми управляет вид localState, — как их хочет UI (значение — proto3-JSON сообщения
   * вида). `current` — объекты модели сейчас: поля, которых нет в локальном виде (время блокировки), — оттуда. */
  function localObjects(kind: LocalStateKind, current: StateObject[]): StateObject[] {
    const { localState } = deps;
    switch (kind) {
      case 'folders': {
        const folders = localState.loadFolders() as unknown as ApiChatFolder[];
        return [
          ...folders.map(folderToState).filter((f): f is SFolder => Boolean(f))
            .map((f) => object(K.folder, String(Number(f.id)), f)),
          object(K.folderOrder, '', {
            ids: withAllFolder(folders.map(({ id }) => id), localState.loadAllFolderIndex()),
          }),
        ];
      }
      case 'blocked': {
        const blockedAt = new Map(current.filter((o) => o.kind === K.block)
          .map((o) => [o.key, valueOf(o).blocked_at_ms as string | undefined]));
        const now = String(Date.now());
        return localState.loadBlocked().map(peerOf).filter(isPeer).map((peer) => {
          const key = peerKeyOf(peer);
          return object(K.block, key, { peer, blocked_at_ms: blockedAt.get(key) || now });
        });
      }
      case 'drafts':
        return Object.entries(localState.loadDrafts()).map(([address, draft]) => draftToState(address, draft))
          .filter((d): d is SDraft => Boolean(d)).map((d) => object(K.draft, peerKeyOf(d.peer), d));
      case 'scheduled': {
        const store = deps.getStore();
        return localState.listJournalScheduled().map((entry) => scheduledToState(entry, store))
          .filter((x): x is SScheduled => Boolean(x)).map((x) => object(K.scheduled, b64ToHex(x.op_id || ''), x));
      }
      case 'archived':
        return localState.loadArchived().map(peerOf).filter(isPeer).map((peer) => object(K.archive, peerKeyOf(peer)));
      // Настройки уведомлений (FR-039): кто заглушён — только своим устройствам, сервер этого не видит
      case 'notify':
        return [
          ...Object.entries(localState.loadNotifyExceptions()).flatMap(([address, settings]) => {
            const peer = peerOf(address);
            return peer ? [object(K.peerNotify, peerKeyOf(peer), { peer, settings: notifyToState(settings) })] : [];
          }),
          object(K.notifyDefaults, '', notifyDefaultsToState(localState.loadNotifyDefaults())),
        ];
      case 'pinned':
        return [object(K.pinList, PIN_KEY_MAIN, {
          list: PIN_LIST_MAIN, peers: localState.loadPinned().map(peerOf).filter(isPeer),
        })];
      case 'unread':
        return localState.loadUnreadMarks().map(peerOf).filter(isPeer)
          .map((peer) => object(K.unreadMark, peerKeyOf(peer)));
      case 'reaction':
        return [object(K.quickReaction, '', reactionToState(localState.loadQuickReaction()))];
      case 'packs':
        return localState.loadStickerPacks().map((pack) => {
          const setId = typeof pack.set_id === 'string' ? pack.set_id : '';
          return object(setId.startsWith('g:') ? K.savedGif : K.stickerPack, setId, pack);
        });
      case 'contacts':
        return contactObjects(contactsToState(localState.loadContacts(), localState.loadContactInfo()));
      default:
        return [];
    }
  }

  function folderToState(folder: ApiChatFolder): SFolder | undefined {
    if (typeof folder.id !== 'number') return undefined;
    const title = folder.title as ApiChatFolder['title'] | string | undefined;
    return {
      id: folder.id,
      title: typeof title === 'string' ? title : title?.text || '',
      emoticon: folder.emoticon || '',
      include_peers: chatIdsToPeers(folder.includedChatIds),
      exclude_peers: chatIdsToPeers(folder.excludedChatIds),
      pinned_peers: chatIdsToPeers(folder.pinnedChatIds),
      contacts: Boolean(folder.contacts),
      non_contacts: Boolean(folder.nonContacts),
      groups: Boolean(folder.groups),
      channels: Boolean(folder.channels),
      bots: Boolean(folder.bots),
      exclude_muted: Boolean(folder.excludeMuted),
      exclude_read: Boolean(folder.excludeRead),
      exclude_archived: Boolean(folder.excludeArchived),
      color: folder.color ?? NO_COLOR,
    };
  }

  function draftToState(address: string, draft: Record<string, unknown>): SDraft | undefined {
    const peer = peerOf(address);
    const text = (draft as ApiDraft).text;
    if (!peer || !text?.text) return undefined;
    const v2Text = contentOfWire({ kind: 'text', text: text.text, entities: apiEntitiesToWire(text.entities) }).text;
    return {
      peer,
      text: bytesToB64(host!.encode('parvane.msg.v2.Text', JSON.stringify(v2Text || {}))),
      date_ms: String(((draft as ApiDraft).date || 0) * MS_IN_SECOND),
    };
  }

  function scheduledToState(entry: JournalScheduled, store: ParvaneStore): SScheduled | undefined {
    const address = store.getAddressForId(entry.chatId);
    const peer = address ? peerOf(address) : undefined;
    if (!peer) return undefined;
    // «Без звука» — `Content.silent` внутри сериализованного содержимого отложенного
    const content = contentOfWire({
      kind: 'text', text: entry.text || '', entities: apiEntitiesToWire(entry.entities), silent: entry.silent,
    });
    return {
      op_id: uuidToB64(entry.opId),
      peer,
      send_at_ms: String(entry.scheduledAt * MS_IN_SECOND),
      content: bytesToB64(host!.encode('parvane.msg.v2.Content', JSON.stringify(content))),
    };
  }

  // ── показ: объекты модели по видам → localState + нативные апдейты ──────

  // `offline` (T118): показ модели без сети до подключения журнала — виды с несохранёнными правками этого
  // устройства не трогаются (их значение главнее: оно уйдёт в журнал при подключении)
  function show(offline = false) {
    if (!session && !(offline && offlineView)) return;
    const view = readView();
    // Показанное по видам — основа следующей правки пользователя
    shown = new Map(Array.from(managedKinds(MANAGED_KINDS)).map((k) => [k, objectsOf(view, k)]));
    const dirty = offline ? deps.localState.loadDirtyKinds() : [];
    const runs = (kind: LocalStateKind) => !dirty.includes(kind);
    deps.localState.applyFromJournal(() => {
      if (runs('folders')) showFolders();
      if (runs('blocked')) showBlocked();
      if (runs('notify')) showNotify();
      if (runs('archived')) showArchived();
      if (runs('pinned')) showPinned();
      if (runs('drafts')) showDrafts();
      if (runs('unread')) showUnreadMarks();
      if (runs('reaction')) showQuickReaction();
      if (runs('packs')) showStickerPacks();
      if (runs('contacts')) showContacts();
    });
    if (runs('scheduled')) showScheduled();
    showFaved();
    deps.localState.markProjected(!offline);
    if (offline) return;
    showWriteBlocked();
    showCalls();
    showCleared();
    void showInvites()
      .catch((e: unknown) => deps.log(`v2: ссылки-приглашения из журнала состояния: ${String(e)}`));
  }

  /** Собеседники признаков (архив, «непрочитано») — из ключей объектов. */
  function addressesOfKeys(kind: string) {
    return objectsOf(readView(), kind).map((o) => addressOf(peerOfKey(o.key) as SPeer | undefined)).filter(isAddress);
  }

  function showFolders() {
    const { localState } = deps;
    const before = new Map((localState.loadFolders() as unknown as ApiChatFolder[]).map((f) => [f.id, f]));
    const [folderOrder] = valuesOf<{ ids?: number[] }>(K.folderOrder);
    const order = folderOrder?.ids || [];
    const rank = (id: number) => {
      const index = order.indexOf(id);
      return index < 0 ? order.length + id : index;
    };
    const next = valuesOf<SFolder>(K.folder).map(stateToFolder).sort((a, b) => rank(a.id) - rank(b.id));
    const beforeIds = Array.from(before.keys());
    const nextIds = next.map(({ id }) => id);
    // «Все чаты» — id 0 в общем порядке (его место выбрал пользователь на любом своём устройстве)
    const allAt = order.indexOf(ALL_CHATS_FOLDER_ID);
    const allIndex = allAt < 0 ? 0 : order.slice(0, allAt).filter((id) => nextIds.includes(id)).length;
    const isAllMoved = allIndex !== localState.loadAllFolderIndex();
    const isChanged = next.some((f) => JSON.stringify(before.get(f.id)) !== JSON.stringify(f))
      || beforeIds.some((id) => !nextIds.includes(id)) || beforeIds.join() !== nextIds.join();
    if (!isChanged && !isAllMoved) return;
    if (isAllMoved) localState.saveAllFolderIndex(allIndex);
    if (isChanged) {
      localState.saveFolders(next as unknown as { id: number }[]);
      next.forEach((folder) => {
        if (JSON.stringify(before.get(folder.id)) === JSON.stringify(folder)) return;
        deps.sendUpdate({ '@type': 'updateChatFolder', id: folder.id, folder });
      });
      beforeIds.filter((id) => !nextIds.includes(id)).forEach((id) => {
        deps.sendUpdate({ '@type': 'updateChatFolder', id, folder: undefined });
      });
    }
    deps.sendUpdate({ '@type': 'updateChatFoldersOrder', orderedIds: withAllFolder(nextIds, allIndex) });
  }

  function stateToFolder(f: SFolder): ApiChatFolder {
    return {
      id: f.id,
      title: { text: f.title || '' },
      emoticon: f.emoticon || undefined,
      includedChatIds: peersToChatIds(f.include_peers),
      excludedChatIds: peersToChatIds(f.exclude_peers),
      pinnedChatIds: f.pinned_peers?.length ? peersToChatIds(f.pinned_peers) : undefined,
      contacts: f.contacts ? true : undefined,
      nonContacts: f.non_contacts ? true : undefined,
      groups: f.groups ? true : undefined,
      channels: f.channels ? true : undefined,
      bots: f.bots ? true : undefined,
      excludeMuted: f.exclude_muted ? true : undefined,
      excludeRead: f.exclude_read ? true : undefined,
      excludeArchived: f.exclude_archived ? true : undefined,
      // Цвет 0 (первый, красный) движок в JSON не пишет — нулевое значение поля опускается, а «без
      // цвета» хранится явным -1. Раньше отсутствие поля читалось как «без цвета», и красный терялся
      color: f.color === NO_COLOR ? undefined : f.color ?? 0,
    };
  }

  // Настройки уведомлений из журнала: исключения по чатам и умолчания по типам
  function showNotify() {
    const { localState } = deps;
    const store = deps.getStore();
    const before = localState.loadNotifyExceptions();
    const next: Record<string, LocalNotify> = {};
    valuesOf<{ peer?: SPeer; settings?: SNotify }>(K.peerNotify).forEach((entry) => {
      const address = addressOf(entry.peer);
      if (address) next[address] = notifyFromState(entry.settings, before[address]);
    });
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      localState.saveNotifyExceptions(next);
      new Set([...Object.keys(before), ...Object.keys(next)]).forEach((address) => {
        if (JSON.stringify(before[address]) === JSON.stringify(next[address])) return;
        deps.sendUpdate({
          '@type': 'updateChatNotifySettings',
          chatId: store.getIdForAddress(address, store.isGroupAddress(address) ? 'group' : 'user'),
          settings: next[address] || { mutedUntil: 0 },
        });
      });
    }
    const defaultsBefore = localState.loadNotifyDefaults();
    const defaultsNext: Record<string, LocalNotify> = {};
    const [defaults] = valuesOf<NotifyDefaults>(K.notifyDefaults);
    NOTIFY_DEFAULT_TYPES.forEach((type) => {
      const settings = defaults?.[type];
      if (settings) defaultsNext[type] = notifyFromState(settings, defaultsBefore[type]);
    });
    if (defaults && JSON.stringify(defaultsBefore) !== JSON.stringify(defaultsNext)) {
      localState.saveNotifyDefaults(defaultsNext);
    }
  }

  function showBlocked() {
    const { localState } = deps;
    const store = deps.getStore();
    const before = localState.loadBlocked();
    const next = valuesOf<{ peer?: SPeer }>(K.block).map((b) => addressOf(b.peer)).filter(isAddress);
    if (sameSet(before, next)) return;
    localState.saveBlocked(next);
    diffSets(before, next).forEach(({ address, isAdded }) => {
      deps.sendUpdate({ '@type': 'updatePeerBlocked', id: store.getIdForAddress(address), isBlocked: isAdded });
    });
  }

  function showArchived() {
    const { localState } = deps;
    const before = localState.loadArchived();
    const next = addressesOfKeys(K.archive);
    if (sameSet(before, next)) return;
    localState.saveArchivedList(next);
    diffSets(before, next).forEach(({ address, isAdded }) => {
      deps.sendUpdate({
        '@type': 'updateChatListType', id: chatIdOf(address), folderId: isAdded ? ARCHIVED_FOLDER_ID : 0,
      });
    });
  }

  function showPinned() {
    const { localState } = deps;
    const before = localState.loadPinned();
    const main = objectsOf(readView(), K.pinList).find((o) => o.key === PIN_KEY_MAIN);
    const next = ((valueOf(main) as SPinned).peers || []).map(addressOf).filter(isAddress);
    if (before.join('\n') === next.join('\n')) return;
    localState.savePinnedList(next);
    deps.sendUpdate({ '@type': 'updatePinnedChatIds', ids: next.map(chatIdOf) });
  }

  // Отметка «непрочитано» с другого своего устройства — и её снятие открытием чата там
  function showUnreadMarks() {
    const { localState } = deps;
    const before = localState.loadUnreadMarks();
    const next = addressesOfKeys(K.unreadMark);
    if (sameSet(before, next)) return;
    localState.saveUnreadMarks(next);
    const changed = diffSets(before, next);
    const brief = changed.map((c) => `${c.isAdded ? '+' : '-'}${c.address}`).join(', ');
    deps.log(`v2: отметки «непрочитано» из журнала: ${brief}`);
    changed.forEach(({ address, isAdded }) => {
      deps.sendUpdate({
        '@type': 'updateThreadReadState',
        chatId: chatIdOf(address),
        threadId: MAIN_THREAD_ID,
        readState: { hasUnreadMark: isAdded || undefined },
      });
    });
  }

  function showStickerPacks() {
    const { localState } = deps;
    const before = localState.loadStickerPacks();
    const next = objectsOfKinds(readView(), [K.stickerPack, K.savedGif])
      .map((o) => valueOf(o) as unknown as LocalStickerPack).filter((p) => p?.set_id && p.ref?.file_id);
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    localState.saveStickerPacks(next);
    const kept = new Set(next.map((p) => p.set_id));
    deps.applyStickerPacks?.(next, before.filter((p) => !kept.has(p.set_id)).map((p) => p.set_id));
  }

  function showContacts() {
    const { localState } = deps;
    const before = localState.loadContacts();
    const beforeInfo = localState.loadContactInfo();
    const { addresses, info } = contactsFromState(valuesOf<SContact>(K.contact));
    const isSameList = JSON.stringify([...before].sort()) === JSON.stringify([...addresses].sort());
    if (isSameList && JSON.stringify(sortKeys(beforeInfo)) === JSON.stringify(sortKeys(info))) return;
    localState.saveContacts(addresses);
    localState.saveContactInfo(info);
    const kept = new Set(addresses);
    deps.applyContacts?.(addresses, info, before.filter((address) => !kept.has(address)));
  }

  function showQuickReaction() {
    const { localState } = deps;
    const [reaction] = valuesOf<SQuickReaction>(K.quickReaction);
    const next = reactionFromState(reaction);
    if (JSON.stringify(localState.loadQuickReaction()) === JSON.stringify(next)) return;
    localState.saveQuickReaction(next);
    // tt держит быструю реакцию в config — перечитать
    deps.sendUpdate({ '@type': 'updateConfig' });
  }

  function showDrafts() {
    const { localState } = deps;
    const before = localState.loadDrafts();
    const next: Record<string, Record<string, unknown>> = {};
    valuesOf<SDraft>(K.draft).forEach((d) => {
      const address = addressOf(d.peer);
      if (!address) return;
      const draft = stateToDraft(d);
      if (draft) next[address] = draft;
    });
    const addresses = new Set([...Object.keys(before), ...Object.keys(next)]);
    const changed = Array.from(addresses).filter((address) => (
      draftText(before[address]) !== draftText(next[address])
    ));
    if (!changed.length) return;
    // Совпадающие по тексту — локальные как есть (дата/ответ этого устройства)
    const merged = { ...next };
    Object.keys(next).forEach((address) => {
      if (!changed.includes(address) && before[address]) merged[address] = before[address];
    });
    localState.replaceDrafts(merged);
    const store = deps.getStore();
    changed.forEach((address) => {
      // Черновик из журнала у собеседника без истории: чат объявляется до черновика — tt отбрасывает черновик
      // неизвестного чата, а `updateChat` нелистингового чата перечитывает верх списка (черновик уже в кэше).
      // Иначе чат с одним черновиком, не успевшим на диск до перезагрузки, в список не попадал (e2e content_ux)
      if (merged[address] && !before[address] && !store.isGroupAddress(address)) {
        const user = store.buildApiUser(address);
        deps.sendUpdate({ '@type': 'updateUser', id: user.id, user });
        deps.sendUpdate({ '@type': 'updateChat', id: user.id, chat: store.buildApiChatForUser(address) });
      }
      deps.sendUpdate({
        '@type': 'draftMessage',
        chatId: chatIdOf(address),
        threadId: MAIN_THREAD_ID,
        draft: merged[address],
      });
    });
  }

  function stateToDraft(d: SDraft): Record<string, unknown> | undefined {
    if (!d.text) return undefined;
    const text = decodeText(d.text);
    if (!text?.text) return undefined;
    return { text, date: Math.floor(Number(d.date_ms || 0) / MS_IN_SECOND) };
  }

  function showScheduled() {
    const list: JournalScheduled[] = [];
    // Отправленное (отметка «отправлено») — уже не отложенное
    const pending = objectsOf(readView(), K.scheduled).filter((o) => !isScheduledSent(o))
      .map((o) => valueOf(o) as SScheduled);
    pending.forEach((s) => {
      const address = addressOf(s.peer);
      const opId = b64ToUuid(s.op_id);
      if (!address || !opId || !s.content) return;
      const content = decodeContent(s.content);
      if (!content) return;
      list.push({
        opId,
        chatId: chatIdOf(address),
        scheduledAt: Math.floor(Number(s.send_at_ms || 0) / MS_IN_SECOND),
        text: content.text,
        entities: content.entities,
        silent: content.silent,
      });
    });
    deps.localState.applyJournalScheduled(list);
  }

  // ── преобразования ───────────────────────────────────────────────────────

  function decodeText(b64: string): { text: string; entities?: ApiMessageEntity[] } | undefined {
    if (!host) return undefined;
    try {
      const v2Text = JSON.parse(host.decode('parvane.msg.v2.Text', b64ToBytes(b64))) as V2Text;
      const wire = wireOfContent({ text: v2Text });
      if (wire?.kind !== 'text' || !wire.text) return undefined;
      return { text: wire.text, entities: wireEntitiesToApi(wire.entities, wire.text.length) };
    } catch {
      return undefined;
    }
  }

  function decodeContent(b64: string) {
    if (!host) return undefined;
    try {
      const content = JSON.parse(host.decode('parvane.msg.v2.Content', b64ToBytes(b64))) as V2Content;
      const wire = wireOfContent(content);
      if (wire?.kind !== 'text' || !wire.text) return undefined;
      return {
        text: wire.text, entities: wireEntitiesToApi(wire.entities, wire.text.length), silent: wire.silent || undefined,
      };
    } catch {
      return undefined;
    }
  }

  function peerOf(address: string): SPeer | undefined {
    if (address.includes('@')) return { user: { address } };
    const hex = isV2GroupAddress(address) ? address.slice(V2_GROUP_PREFIX.length) : address.replace(/-/g, '');
    if (!/^[0-9a-f]+$/.test(hex) || hex.length !== UUID_HEX_LENGTH) return undefined;
    return { group: { domain: host!.domain(), id: hexToB64(hex) } };
  }

  // Группа v2 — зарегистрированная `v2g:<hex>`; иначе UUIDv7 группы v1
  function addressOf(peer?: SPeer): string | undefined {
    if (peer?.user?.address) return peer.user.address;
    if (!peer?.group?.id) return undefined;
    const hex = b64ToHex(peer.group.id);
    const v2Address = `${V2_GROUP_PREFIX}${hex}`;
    if (deps.getStore().isGroupAddress(v2Address)) return v2Address;
    const isUuidV7 = hex[12] === '7' && '89ab'.includes(hex[16]);
    return isUuidV7 ? b64ToUuid(peer.group.id) : v2Address;
  }

  function chatIdOf(address: string) {
    return deps.getStore().getIdForAddress(address, address.includes('@') ? 'user' : 'group');
  }

  function chatIdsToPeers(chatIds?: string[]) {
    const store = deps.getStore();
    return (chatIds || []).map((id) => store.getAddressForId(id)).filter(isAddress).map(peerOf).filter(isPeer);
  }

  function peersToChatIds(peers?: SPeer[]) {
    return (peers || []).map(addressOf).filter(isAddress).map(chatIdOf);
  }

  return {
    attach,
    isAttached,
    showOffline,
    recordCall,
    recordChatCleared,
    recordGroupInvite,
    removeGroupInvite,
    plannerContainer,
    recordPlannerContainer,
    healthContainer,
    recordHealthContainer,
    musicContainer,
    recordMusicContainer,
    cloudEntries,
    recordCloudEntry,
    reset: () => {
      detach();
      shown = undefined;
      offlineView = undefined;
    },
    syncNow,
    /** Показ личного состояния модели (объекты по видам, JSON) — для выгрузки «ничего не потеряно» (spec 035, T007),
     * только чтение. */
    stateJson: () => (session ? JSON.stringify(readView() || {}) : undefined),
    favedStickers,
    faveSticker,
    isWriteBlocked: () => writeBlocked,
  };
}

function object(kind: string, key: string, value: object = {}): StateObject {
  return { kind, key, value: value as Record<string, unknown> };
}

// Ключ отложенного у модели — hex его op_id
function scheduledKey(opId: string) {
  return b64ToHex(uuidToB64(opId));
}

function contactObjects(list: SContact[]): StateObject[] {
  return list.map((c) => object(K.contact, c.user?.address || '', c));
}

function sortKeys<T>(map: Record<string, T>) {
  return Object.keys(map).sort().map((key) => [key, map[key]]);
}

// Настройки уведомлений: локальный вид (секунды эпохи, поля tt) ↔ журнал
function notifyToState(settings: LocalNotify): SNotify {
  const mutedUntil = typeof settings.mutedUntil === 'number' ? settings.mutedUntil : 0;
  return {
    mute_until_ms: String(Math.max(0, mutedUntil) * 1000),
    show_previews: typeof settings.shouldShowPreviews === 'boolean' ? settings.shouldShowPreviews : undefined,
    silent: typeof settings.isSilentPosting === 'boolean' ? settings.isSilentPosting : undefined,
    sound: soundToState(settings.hasSound),
  };
}

function notifyFromState(settings: SNotify | undefined, previous: LocalNotify | undefined): LocalNotify {
  const out: LocalNotify = { ...previous, mutedUntil: Math.floor(Number(settings?.mute_until_ms || 0) / 1000) };
  if (typeof settings?.show_previews === 'boolean') out.shouldShowPreviews = settings.show_previews;
  if (typeof settings?.silent === 'boolean') out.isSilentPosting = settings.silent;
  const hasSound = soundFromState(settings?.sound);
  if (hasSound !== undefined) out.hasSound = hasSound;
  return out;
}

function notifyDefaultsToState(defaults: Record<string, LocalNotify>) {
  const out: NotifyDefaults = {};
  NOTIFY_DEFAULT_TYPES.forEach((type) => {
    if (defaults[type]) out[type] = notifyToState(defaults[type]);
  });
  return out;
}

function reactionToState(reaction: LocalQuickReaction | undefined): SQuickReaction {
  if (reaction?.documentId) return { custom_emoji_id: reaction.documentId };
  return reaction?.emoji ? { emoji: reaction.emoji } : {};
}

function reactionFromState(reaction: SQuickReaction | undefined): LocalQuickReaction | undefined {
  if (reaction?.custom_emoji_id) return { documentId: reaction.custom_emoji_id };
  return reaction?.emoji ? { emoji: reaction.emoji } : undefined;
}

function isPeer(peer: SPeer | undefined): peer is SPeer {
  return Boolean(peer);
}

function isAddress(address: string | undefined): address is string {
  return Boolean(address);
}

function draftText(draft?: Record<string, unknown>) {
  const text = (draft as ApiDraft | undefined)?.text;
  return text?.text ? `${text.text}\u0000${JSON.stringify(text.entities || [])}` : '';
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

function diffSets(before: string[], next: string[]) {
  return [
    ...next.filter((x) => !before.includes(x)).map((address) => ({ address, isAdded: true })),
    ...before.filter((x) => !next.includes(x)).map((address) => ({ address, isAdded: false })),
  ];
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s);
}

function b64ToBytes(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function inviteToState(address: string, record: V2SharedInvite['record']): SInvite {
  return {
    group_id: hexToB64(address.slice(V2_GROUP_PREFIX.length)),
    link_id: hexToB64(record.linkId),
    url: record.url,
    created_ms: String(record.date * MS_IN_SECOND),
    title: record.title,
    expires_ms: record.expiresAt ? String(record.expiresAt * MS_IN_SECOND) : undefined,
    usage_limit: record.usageLimit,
    requires_approval: record.isRequestNeeded,
  };
}

function inviteFromState(invite: SInvite): V2SharedInvite | undefined {
  if (!invite.group_id || !invite.link_id || !invite.url) return undefined;
  return {
    address: `${V2_GROUP_PREFIX}${b64ToHex(invite.group_id)}`,
    record: {
      url: invite.url,
      linkId: b64ToHex(invite.link_id),
      date: Math.floor(Number(invite.created_ms || 0) / MS_IN_SECOND),
      title: invite.title || undefined,
      expiresAt: Number(invite.expires_ms || 0) ? Math.floor(Number(invite.expires_ms) / MS_IN_SECOND) : undefined,
      usageLimit: invite.usage_limit || undefined,
      isRequestNeeded: invite.requires_approval || undefined,
    },
  };
}

function hexToB64(hex: string) {
  return btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

function b64ToHex(b64: string) {
  return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
