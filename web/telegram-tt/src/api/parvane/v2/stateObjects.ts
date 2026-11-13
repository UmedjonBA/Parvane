// spec 036 T019 (ENGINE-1, web; как desktop `stateview` в parvane-core/state_model.cpp): личное состояние — объекты
// модели по видам. Показ — `viewStateJson` ({objects: [{kind, key, value — proto3-JSON сообщения вида, marks}],
// write_blocked}), правка — `stateSet` объекта (разницу по полям от показанного хостом считает модель, `base`) и
// `stateMark` отметки. Здесь — только выбор записей: объекты вида, которые хост хочет, против показанных и объектов
// модели сейчас (desktop `stateview::setsFor`). Ни сведения, ни лампортов: метки модель сравнивает сама; «отметка
// новее» — только чтобы не слать заведомо прежнюю. Промежуточного снимка формы `state.v1` нет.
// Раскладка ключей — как у движка (`state_v1_objects.rs`): `peer_key` (`u:<адрес>` | `g:<домен>:<hex id>`), папка —
// id десятичным, закреп — номер списка (1 основной, 2 архив), отложенное/звонок/ссылка — hex id, облако —
// `<домен>:<hex id>`; отметки — SCHEDULED 1 («отправлено»), CHAT_CLEARED 2 (граница очистки, мс).

/* eslint-disable no-null/no-null -- proto3-JSON: null = «поля нет» */

export type StateMark = { field: number; value: string };
/** Объект модели: `value` — proto3-JSON сообщения вида (у признаков — `{}`); `undefined` — только отметки. */
export type StateObject = { kind: string; key: string; value?: Record<string, unknown>; marks?: StateMark[] };
/** Ответ `viewStateJson`. */
export type StateViewJson = { objects?: StateObject[]; write_blocked?: boolean };
/** Аргументы `stateSet` / `stateMark`. */
export type StateSetArgs = {
  kind: string; key: string; value?: Record<string, unknown>; delete?: boolean; base?: Record<string, unknown>;
  rewrite?: boolean;
};
export type StateMarkArgs = { kind: string; key: string; field: number; value: string };
export type StateWrites = { sets: StateSetArgs[]; marks: StateMarkArgs[] };
export type FavedStickerJson = { set_id: string; sticker_id: string; added_ms: string };

type Json = Record<string, unknown>;
type Peer = { user?: { address?: string }; group?: { domain?: string; id?: string } };

export const MARK_SCHEDULED_SENT = 1;
export const MARK_CHAT_CLEARED = 2;
const PREFIX = 'OBJECT_KIND_';
// «Все чаты» и архив — не удаляются пропажей из желаемого (как мост движка)
const KEPT_FOLDERS = ['0', '1'];
/** Ключ основного списка закрепа (`PIN_LIST_MAIN`); список архива (2) web не правит. */
export const PIN_KEY_MAIN = '1';
// Виды-одиночки: ключ пустой
const SINGLETONS = ['FOLDER_ORDER', 'NOTIFY_DEFAULTS', 'PLANNER_CONTAINER', 'QUICK_REACTION']
  .map((k) => `${PREFIX}${k}`);

export const K = {
  folder: 'OBJECT_KIND_FOLDER',
  folderOrder: 'OBJECT_KIND_FOLDER_ORDER',
  block: 'OBJECT_KIND_BLOCK',
  peerNotify: 'OBJECT_KIND_PEER_NOTIFY',
  notifyDefaults: 'OBJECT_KIND_NOTIFY_DEFAULTS',
  draft: 'OBJECT_KIND_DRAFT',
  scheduled: 'OBJECT_KIND_SCHEDULED',
  archive: 'OBJECT_KIND_ARCHIVE',
  pinList: 'OBJECT_KIND_PIN_LIST',
  call: 'OBJECT_KIND_CALL',
  groupInvite: 'OBJECT_KIND_GROUP_INVITE',
  plannerContainer: 'OBJECT_KIND_PLANNER_CONTAINER',
  cloudContainer: 'OBJECT_KIND_CLOUD_CONTAINER',
  unreadMark: 'OBJECT_KIND_UNREAD_MARK',
  quickReaction: 'OBJECT_KIND_QUICK_REACTION',
  stickerPack: 'OBJECT_KIND_STICKER_PACK',
  savedGif: 'OBJECT_KIND_SAVED_GIF',
  contact: 'OBJECT_KIND_CONTACT',
  chatCleared: 'OBJECT_KIND_CHAT_CLEARED',
  favedSticker: 'OBJECT_KIND_FAVED_STICKER',
} as const;

/** Виды модели, которыми управляет имя вида localState (как `managed` моста движка). */
const MANAGED: Record<string, string[]> = {
  folders: [K.folder, K.folderOrder],
  blocked: [K.block],
  notify: [K.peerNotify, K.notifyDefaults],
  drafts: [K.draft],
  scheduled: [K.scheduled],
  archived: [K.archive],
  pinned: [K.pinList],
  unread: [K.unreadMark],
  reaction: [K.quickReaction],
  packs: [K.stickerPack, K.savedGif],
  contacts: [K.contact],
};

export function managedKinds(names: string[]) {
  return new Set(names.flatMap((n) => MANAGED[n] || []));
}

/** Полное имя вида (`FOLDER` → `OBJECT_KIND_FOLDER`). */
export function kindName(kind: string) {
  return kind.startsWith(PREFIX) ? kind : `${PREFIX}${kind.toUpperCase()}`;
}

// ── байты ────────────────────────────────────────────────────────────────

function b64ToHex(b64?: string) {
  if (!b64) return '';
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function hexToB64(hex: string) {
  if (!hex || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return '';
  return btoa(String.fromCharCode(...(hex.match(/../g) || []).map((h) => parseInt(h, 16))));
}

/** Число → base64 big-endian без ведущих нулей (как `be_min` движка). */
export function markBytes(value: number | bigint) {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    out.unshift(Number(v & BigInt(0xff)));
    v >>= BigInt(8);
  } while (v > BigInt(0));
  return btoa(String.fromCharCode(...out));
}

function markNumber(b64: string): bigint {
  let v = BigInt(0);
  try {
    Array.from(atob(b64)).forEach((c) => {
      v = (v << BigInt(8)) | BigInt(c.charCodeAt(0));
    });
  } catch {
    return BigInt(0);
  }
  return v;
}

/** Значение отметки числом; отметки нет — 0. */
export function markValue(object: StateObject | undefined, field: number) {
  const m = object?.marks?.find((x) => x.field === field);
  return m ? markNumber(m.value) : BigInt(0);
}

function hasMark(object: StateObject | undefined, field: number) {
  return Boolean(object?.marks?.some((x) => x.field === field));
}

// ── ключи ────────────────────────────────────────────────────────────────

/** Ключ собеседника как у модели (`state::peer_key`); '' — не собеседник. */
export function peerKeyOf(peer?: Peer | null) {
  if (peer?.user?.address) return `u:${peer.user.address}`;
  if (peer?.group?.id) {
    const hex = b64ToHex(peer.group.id);
    return hex ? `g:${peer.group.domain || ''}:${hex}` : '';
  }
  return '';
}

/** Собеседник из ключа (proto3-JSON Peer); undefined — не ключ собеседника. */
export function peerOfKey(key: string): Peer | undefined {
  if (key.startsWith('u:') && key.length > 2) return { user: { address: key.slice(2) } };
  if (!key.startsWith('g:')) return undefined;
  const colon = key.lastIndexOf(':');
  if (colon <= 1) return undefined;
  const id = hexToB64(key.slice(colon + 1));
  return id ? { group: { domain: key.slice(2, colon), id } } : undefined;
}

// ── показ: объекты модели по видам ───────────────────────────────────────

/** Объекты вида из ответа `viewStateJson` по порядку. */
export function objectsOf(view: StateViewJson | undefined, kind: string) {
  const want = kindName(kind);
  return (view?.objects || []).filter((o) => o.kind === want);
}

/** Объекты нескольких видов в порядке показа модели (наборы стикеров и GIF — один список). */
export function objectsOfKinds(view: StateViewJson | undefined, kinds: string[]) {
  const want = new Set(kinds.map(kindName));
  return (view?.objects || []).filter((o) => want.has(o.kind));
}

/** Значение объекта (proto3-JSON сообщения вида); у признака и пустого — `{}`. */
export function valueOf(object: StateObject | undefined): Json {
  return object?.value && typeof object.value === 'object' ? object.value : {};
}

/** Избранные стикеры (`FAVED_STICKER`) из показа. */
export function favedOf(view: StateViewJson | undefined): FavedStickerJson[] {
  return objectsOf(view, K.favedSticker).map((o) => {
    const v = valueOf(o) as Partial<FavedStickerJson>;
    return { set_id: v.set_id || '', sticker_id: v.sticker_id || '', added_ms: String(v.added_ms || '0') };
  });
}

/** Отложенное отправлено (отметка «отправлено» у объекта). */
export function isScheduledSent(object: StateObject | undefined) {
  return hasMark(object, MARK_SCHEDULED_SENT);
}

// Виды, которые web показывает и переносит под новый ключ (прочие виды модели ему не известны)
const KNOWN_KINDS = new Set<string>(Object.values(K));

/** В показе есть личное состояние web (после смены ключа другим устройством пустой показ не стирает локальное). */
export function hasPersonalState(view: StateViewJson | undefined) {
  return (view?.objects || []).some((o) => (
    KNOWN_KINDS.has(o.kind) && o.kind !== K.favedSticker
    && (o.kind !== K.chatCleared || markValue(o, MARK_CHAT_CLEARED) > BigInt(0))
  ));
}

/** Объекты для переноса под новый ключ личного состояния (как прежде): известные виды; у отправленного отложенного и
 * очистки чата — только отметки. */
export function carriedObjects(view: StateViewJson | undefined): StateObject[] {
  return (view?.objects || []).filter((o) => KNOWN_KINDS.has(o.kind)).map((o) => (
    o.kind === K.chatCleared || (o.kind === K.scheduled && isScheduledSent(o))
      ? { kind: o.kind, key: o.key, marks: o.marks || [] }
      : { kind: o.kind, key: o.key, value: valueOf(o), marks: o.marks || [] }
  )).filter((o) => {
    if (o.kind === K.chatCleared) return markValue(o, MARK_CHAT_CLEARED) > BigInt(0);
    if (o.kind === K.scheduled && !isScheduledSent(o)) return Object.keys(o.value || {}).length > 0;
    return true;
  });
}

// ── что переписать ───────────────────────────────────────────────────────

// Поле со значением по умолчанию proto3 (пусто, ноль, false, пустой список): показ модели (proto3-JSON) его опускает,
// желаемое хоста пишет явно — для сравнения это одно и то же
function isDefaultValue(v: unknown) {
  return v === undefined || v === null || v === '' || v === 0 || v === '0' || v === false
    || (Array.isArray(v) && v.length === 0);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Json;
    return `{${Object.keys(o).filter((k) => !isDefaultValue(o[k])).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Значения совпадают (порядок ключей и поля по умолчанию не важны: proto3-JSON модели их опускает). Каждая
 * отправка писала `stateSet PIN_LIST:1` — желаемое закрепа хоста с `peers: []` против показа модели без поля. */
export function sameValue(a: unknown, b: unknown) {
  return canonical(a ?? {}) === canonical(b ?? {});
}

function index(objects: StateObject[]) {
  return new Map(objects.map((o) => [`${o.kind}\u0000${o.key}`, o]));
}

/** Записи модели для объектов, которые хост хочет (`desired` — объекты видов как proto3-JSON, отметки — в `marks`):
 * `current` — объекты модели сейчас, `base` — что хост показывал, когда пользователь правил (разница с ним: правка
 * другого устройства после показа не откатывается и не удаляется), `kinds` — управляемые имена видов localState
 * (пусто — все объекты `desired`), `prune` — удалить объекты управляемых видов, которых нет в желаемом (с `base` —
 * только показанные), `rewrite` — переписать целиком (новый ключ личного состояния). Одинаковый (вид, ключ) —
 * последний; объект без ключа (кроме одиночек) пропускается. */
export function planStateWrites(opts: {
  desired: StateObject[]; current: StateObject[]; base?: StateObject[]; kinds?: string[]; prune?: boolean;
  rewrite?: boolean;
}): StateWrites {
  const { rewrite = false } = opts;
  const kinds = managedKinds(opts.kinds || []);
  const inScope = (kind: string) => !kinds.size || kinds.has(kind);
  const cur = index(opts.current);
  const base = opts.base ? index(opts.base) : undefined;
  const sets: StateSetArgs[] = [];
  const marks: StateMarkArgs[] = [];
  const seen = new Set<string>();
  const desired = index(opts.desired.filter((o) => o.key !== '' || SINGLETONS.includes(o.kind)));
  Array.from(desired.values()).filter((o) => inScope(o.kind)).forEach((o) => {
    const id = `${o.kind}\u0000${o.key}`;
    seen.add(id);
    const have = cur.get(id);
    // Отложенное уже отправлено — не трогать
    if (o.kind === K.scheduled && hasMark(have, MARK_SCHEDULED_SENT) && !o.marks?.length) return;
    const was = base?.get(id);
    if (o.value) {
      if (!have) {
        // Удалён на другом устройстве после показа — воскрешать, только если хост сам его правил
        if (rewrite || !was?.value || !sameValue(was.value, o.value)) {
          sets.push({ kind: o.kind, key: o.key, value: o.value });
        }
      } else if (rewrite) {
        sets.push({
          kind: o.kind, key: o.key, value: o.value, rewrite: true,
        });
      } else if (was?.value) {
        if (!sameValue(was.value, o.value)) {
          sets.push({
            kind: o.kind, key: o.key, value: o.value, base: was.value,
          });
        }
      } else if (base) {
        // Хост не показывал объект, а модель его уже держит: только поля хоста, без снятия прочих
        if (!sameValue(have.value, o.value)) {
          sets.push({
            kind: o.kind, key: o.key, value: o.value, base: {},
          });
        }
      } else if (!sameValue(have.value, o.value)) {
        sets.push({ kind: o.kind, key: o.key, value: o.value });
      }
    }
    (o.marks || []).forEach((m) => {
      if (rewrite || markNumber(m.value) > markValue(have, m.field) || !hasMark(have, m.field)) {
        marks.push({
          kind: o.kind, key: o.key, field: m.field, value: m.value,
        });
      }
    });
  });
  if (opts.prune && kinds.size) {
    opts.current.forEach((o) => {
      const id = `${o.kind}\u0000${o.key}`;
      if (!kinds.has(o.kind) || seen.has(id) || (base && !base.has(id))) return;
      // «Все чаты» и архив не удаляются; отправленное отложенное — только отметка; закреп архива web не правит
      if (o.kind === K.folder && KEPT_FOLDERS.includes(o.key)) return;
      if (o.kind === K.scheduled && o.marks?.length) return;
      if (o.kind === K.pinList && o.key !== PIN_KEY_MAIN) return;
      sets.push({ kind: o.kind, key: o.key, delete: true });
    });
  }
  return { sets, marks };
}
