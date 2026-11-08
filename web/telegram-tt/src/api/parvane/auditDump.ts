// Выгрузка «ничего не потеряно» (spec 035, T007, `specs/035-protocol-evolution/contracts/migration.md`, раздел
// «Видимые значения»): канонический список того, что устройство хранит, в виде строк
// `{"kind", "key", "digest"}`, где digest — SHA-256 канонического JSON видимого значения. Снимается нынешним кодом
// ДО разового переноса (`audit-before.jsonl`) и движком после него (`audit-after.jsonl`); сверка —
// `scripts/migration_audit_diff.py`. Правила разбиения и ключей те же, что у ядра desktop/android
// (`desktop/parvane-core/src/audit_dump.cpp`): одинаковые данные аккаунта дают одинаковые строки во всех клиентах.
// Выгрузка только читает; вызывается лишь в диагностической сборке (метод провайдера `parvaneAuditDump`).

import type { HPeer, HReadMark, HRowState, HView } from './v2/historyModel';
import type { WireStoredMessage } from './wire';

export type AuditLine = { kind: string; key: string; digest: string };

// JSON движка несёт `null` наравне с отсутствующим полем
function isAbsent(value: unknown) {
  // eslint-disable-next-line no-null/no-null
  return value === undefined || value === null;
}

/** Канонический JSON: ключи объектов по возрастанию (UTF-16, как у ядра для ASCII-ключей), без пробелов;
 * `null` и отсутствующее поле в объекте — одно и то же (поле выбрасывается). */
export function canonicalJson(value: unknown): string {
  if (isAbsent(value)) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => !isAbsent(inner))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return 'null';
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Pending = { kind: string; key: string; value: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Ключ собеседника состояния (`parvane.state.v1.Peer`): `u:<адрес>` | `g:<id группы, base64>`. */
export function statePeerKey(peer: unknown): string | undefined {
  if (!isObject(peer)) return undefined;
  const user = peer.user as Record<string, unknown> | undefined;
  if (isObject(user) && typeof user.address === 'string') return `u:${user.address}`;
  const group = peer.group as Record<string, unknown> | undefined;
  if (isObject(group) && typeof group.id === 'string') return `g:${group.id}`;
  return undefined;
}

// Собственные id элемента сильнее собеседника: у одного собеседника бывает несколько отложенных и звонков
const ELEMENT_ID_FIELDS = ['id', 'op_id', 'call_id', 'link_id', 'set_id'];
const ELEMENT_NAME_FIELDS = ['list', 'day', 'key', 'address'];

function scalarField(element: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = element[field];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Ключ элемента списка: id-поля → собеседник → `user`/`group` → `ref` → поля-имена → `h:` + начало дайджеста. */
export async function elementKey(element: unknown): Promise<string> {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (isObject(element)) {
    const ref = element.ref as Record<string, unknown> | undefined;
    const key = scalarField(element, ELEMENT_ID_FIELDS)
      || statePeerKey(element.peer)
      || statePeerKey(element)
      || (isObject(ref) && typeof ref.id === 'string' ? `r:${ref.id}` : undefined)
      || scalarField(element, ELEMENT_NAME_FIELDS);
    if (key) return key;
  }
  return `h:${(await sha256Hex(canonicalJson(element))).slice(0, 16)}`;
}

// Поля снимка личного состояния со своим видом выгрузки; прочие — `state:<поле>`
const SNAPSHOT_KINDS: Record<string, string> = { drafts: 'draft', scheduled: 'scheduled' };
const GIF_PACK_PREFIX = 'g:';

async function pushSnapshot(out: Pending[], snapshotJson: string) {
  const snapshot = JSON.parse(snapshotJson) as Record<string, unknown>;
  for (const [field, value] of Object.entries(snapshot)) {
    if (isAbsent(value)) continue;
    if (Array.isArray(value)) {
      for (const element of value) {
        let kind = SNAPSHOT_KINDS[field] || `state:${field}`;
        if (field === 'sticker_packs') {
          const setId = isObject(element) ? element.set_id : undefined;
          kind = typeof setId === 'string' && setId.startsWith(GIF_PACK_PREFIX) ? 'saved-gif' : 'sticker-pack';
        }
        out.push({ kind, key: await elementKey(element), value: element });
      }
    } else {
      out.push({ kind: `state:${field}`, key: '_', value });
    }
  }
}

// Курсоры и счётчики — не данные пользователя
const PLANNER_SKIP = new Set(['headSeq', 'sizeBytes']);

async function pushPlanner(out: Pending[], plannerJson: string) {
  const planner = JSON.parse(plannerJson) as Record<string, unknown>;
  for (const [field, value] of Object.entries(planner)) {
    if (PLANNER_SKIP.has(field) || isAbsent(value)) continue;
    if (Array.isArray(value)) {
      for (const element of value) {
        out.push({ kind: `planner:${field}`, key: await elementKey(element), value: element });
      }
    } else {
      out.push({ kind: `planner:${field}`, key: '_', value });
    }
  }
}

export type AuditCloudContainer = {
  id: string; name?: string; owner?: string; role?: unknown; hasKey?: boolean; members?: unknown[];
};
const NOTE_SUFFIX = '.md';

function pushCloud(out: Pending[], container: AuditCloudContainer, stateJson: string | undefined) {
  const members = Array.isArray(container.members)
    ? [...container.members].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1)) : undefined;
  out.push({
    kind: 'cloud:container',
    key: container.id,
    value: {
      name: container.name, owner: container.owner, role: container.role, hasKey: container.hasKey, members,
    },
  });
  if (!stateJson) return;
  const state = JSON.parse(stateJson) as { nodes?: Record<string, unknown>[] };
  (state.nodes || []).forEach((node) => {
    const name = typeof node.name === 'string' ? node.name : '';
    const nodeKind = typeof node.kind === 'string' ? node.kind : 'null';
    const isNote = nodeKind !== 'folder' && name.toLowerCase().endsWith(NOTE_SUFFIX);
    const kind = isNote ? 'note' : `cloud:${nodeKind}`;
    out.push({ kind, key: `${container.id}/${String(node.id)}`, value: node });
  });
}

/** Вид строки истории без полей, уже вошедших в ключ (id, чат). */
export function messageValue(view: HView) {
  const {
    id: _id, chat: _chat, chatKey: _chatKey, ...rest
  } = view;
  return rest;
}

export type AuditSources = {
  /** Строки истории устройства сводимым состоянием движка (кэш прежних версий — переложенным в `RowState`). */
  rows: HRowState[];
  /** Маркеры «прочитано до» по чатам. */
  marks: HReadMark[];
  /** Своё исходящее, ещё не ставшее строкой истории (журнал исходящих `j:<uuid>`). */
  ownJournal: WireStoredMessage[];
  /** JSON снимка личного состояния движка (`PvState.snapshot()`). */
  stateSnapshot?: string;
  plannerState?: string;
  cloud: { container: AuditCloudContainer; state?: string }[];
  groups: { hex: string; info: unknown }[];
  deviceLogs: { user: string; version: number; devices: unknown }[];
  /** Наличие ключей аккаунта (только да/нет). */
  accountKeys: Record<string, boolean>;
  /** Функции движка истории (`historyView`, `historyChatKey`). */
  view: (state: HRowState) => HView;
  chatKey: (peer: HPeer) => string;
};

// Виды содержимого, которые устройство не смогло прочитать (шифртекст прежних версий, заглушки)
const UNREADABLE_KINDS = new Set(['encrypted', 'group_encrypted', 'unsupported']);

export async function buildAuditDump(src: AuditSources): Promise<AuditLine[]> {
  const out: Pending[] = [];
  const chats = new Map<string, { type: string }>();
  const readable = new Map<string, { rows: number; readable: number }>();
  const seenRows = new Set<string>();

  src.rows.forEach((state) => {
    const view = src.view(state);
    const chatKey = view.chatKey || src.chatKey(state.chat);
    if (!chatKey) return;
    const id = view.id || state.target;
    seenRows.add(id);
    chats.set(chatKey, { type: chatKey.startsWith('g:') ? 'group' : 'direct' });
    out.push({ kind: 'message', key: `${chatKey}/${id}`, value: messageValue(view) });
    if (view.visible) {
      const counts = readable.get(chatKey) || { rows: 0, readable: 0 };
      counts.rows += 1;
      const bodyKind = view.body?.kind;
      const kind = typeof bodyKind === 'string' ? bodyKind : bodyKind === undefined ? '' : canonicalJson(bodyKind);
      if (!UNREADABLE_KINDS.has(kind)) counts.readable += 1;
      readable.set(chatKey, counts);
    }
  });

  src.marks.forEach((mark) => {
    const chatKey = src.chatKey(mark.chat);
    if (!chatKey) return;
    out.push({
      kind: 'read-mark',
      key: chatKey,
      value: { up_to_ts_ms: String(mark.up_to_ts_ms ?? '0'), up_to_id: mark.up_to_id },
    });
  });

  src.ownJournal.filter((entry) => !seenRows.has(entry.id)).forEach((entry) => {
    out.push({
      kind: 'outbox',
      key: entry.id,
      value: {
        to: entry.to, ts: entry.ts, content: entry.content, reply_to: entry.reply_to,
      },
    });
  });

  if (src.stateSnapshot) await pushSnapshot(out, src.stateSnapshot);
  if (src.plannerState) await pushPlanner(out, src.plannerState);
  src.cloud.forEach(({ container, state }) => pushCloud(out, container, state));

  src.groups.forEach(({ hex, info }) => {
    chats.set(`g:${hex}`, { type: 'group' });
    // `epochStale` — отметка устройства «пора начать новую эпоху», не сведения группы
    const value = isObject(info) ? { ...info, epochStale: undefined } : info;
    out.push({ kind: 'group', key: `g:${hex}`, value });
  });

  src.deviceLogs.forEach(({ user, version, devices }) => {
    out.push({ kind: 'device-log-head', key: user, value: { version, devices } });
  });

  chats.forEach((value, key) => out.push({ kind: 'chat', key, value }));
  readable.forEach((value, key) => out.push({ kind: 'key-material', key, value }));
  out.push({ kind: 'key-material', key: 'account', value: src.accountKeys });

  const lines = await Promise.all(out.map(async ({ kind, key, value }) => ({
    kind, key, digest: await sha256Hex(canonicalJson(value)),
  })));
  return sortAuditLines(lines);
}

export function sortAuditLines(lines: AuditLine[]) {
  return [...lines].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });
}

/** JSONL выгрузки: строка — `{"kind","key","digest"}` в этом порядке полей. */
export function auditJsonl(lines: AuditLine[]) {
  return lines.map(({ kind, key, digest }) => JSON.stringify({ kind, key, digest })).join('\n')
    + (lines.length ? '\n' : '');
}
