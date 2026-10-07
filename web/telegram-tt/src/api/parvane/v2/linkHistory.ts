import type { WireStoredMessage } from '../wire';

// LINK-1, п. 8 (spec 007, T138, SC-002): история v2-эпохи при линковке.
// Сообщения v2 запечатаны под устройства, существовавшие на момент отправки, —
// новому устройству сервер их не отдаст, а грант движка несёт только ключи.
// Поэтому старое устройство кладёт уже расшифрованные строки v2 в экспорт
// линковки (поле `v2History` рядом с `decCache`; тот же блоб под случайным
// ключом, координаты — в ECDH-боксе), а новое применяет их как строки v2.
// Формат строки — общий для клиентов: `{id, from, to, ts, content, reply_to?,
// edited?, reactions?, pinned?, read?}`; незнакомые поля игнорируются. `read` у
// своих исходящих — как знает старое устройство; входящие новое устройство
// считает прочитанными (это история, а не новые сообщения).

// Потолок числа строк в экспорте (берутся самые свежие)
export const V2_HISTORY_LIMIT = 20000;

function isExportable(message: WireStoredMessage) {
  if (message.origin !== 'v2' || message.deleted || !message.content) return false;
  if (message.content.ttl_secs) return false;
  const { kind } = message.content;
  return kind !== 'encrypted' && kind !== 'group_encrypted';
}

function byTime(left: WireStoredMessage, right: WireStoredMessage) {
  if (left.ts !== right.ts) return left.ts - right.ts;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Строки v2 для экспорта линковки: без дублей, по времени, не больше потолка. */
export function collectV2History(...sources: WireStoredMessage[][]): WireStoredMessage[] {
  const byId = new Map<string, WireStoredMessage>();
  sources.forEach((list) => {
    list.forEach((message) => {
      if (!isExportable(message) || byId.has(message.id)) return;
      const { origin: _origin, updated_at: _updatedAt, ...rest } = message;
      byId.set(message.id, rest);
    });
  });
  const ordered = Array.from(byId.values()).sort(byTime);
  return ordered.length > V2_HISTORY_LIMIT ? ordered.slice(ordered.length - V2_HISTORY_LIMIT) : ordered;
}

function isStoredMessage(value: unknown): value is WireStoredMessage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<WireStoredMessage>;
  return typeof row.id === 'string' && row.id.length > 0
    && typeof row.from === 'string' && row.from.length > 0
    && typeof row.to === 'string' && row.to.length > 0
    && typeof row.ts === 'number' && Number.isFinite(row.ts)
    && Boolean(row.content) && typeof row.content === 'object'
    && typeof row.content.kind === 'string';
}

/** Строки v2 из экспорта линковки; битые и шифрованные пропускаются. */
export function parseV2History(stateJson: string): WireStoredMessage[] {
  let rows: unknown;
  try {
    rows = (JSON.parse(stateJson) as { v2History?: unknown }).v2History;
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const byId = new Map<string, WireStoredMessage>();
  rows.slice(-V2_HISTORY_LIMIT).forEach((row) => {
    if (!isStoredMessage(row)) return;
    const stored: WireStoredMessage = { ...row, origin: 'v2' };
    if (isExportable(stored) && !byId.has(stored.id)) byId.set(stored.id, stored);
  });
  return Array.from(byId.values()).sort(byTime);
}
