// Правки планировщика копятся до отправки и уходят одной операцией с одной меткой. Две правки одного
// поля под одной меткой движок сводит по байтам, а не по порядку — поздняя могла проиграть ранней
// (вода, записанная сразу после еды, пропадала). Поэтому перед отправкой правки одного объекта
// склеиваются: поздние поля заменяют ранние, списки по ключу — тоже.

type Change = Record<string, unknown>;
type Body = Record<string, unknown>;

const KEYED_LISTS: Record<string, { field: string; key: string }> = {
  task: { field: 'occurrences', key: 'day' },
  event: { field: 'occurrences', key: 'day' },
  nutritionDay: { field: 'entries', key: 'id' },
};

function kindOf(change: Change) {
  return Object.keys(change)[0];
}

// Объект правки: у дня питания ключ — день, у настроек и целей объект один, у остальных — id
function targetOf(kind: string, body: Body) {
  if (kind === 'nutritionDay') return `${kind}:${String(body.day)}`;
  if (kind === 'settings' || kind === 'goals' || kind === 'migration') return kind;
  return `${kind}:${String(body.id)}`;
}

function mergeKeyed(before: unknown, after: unknown, key: string) {
  const items = new Map<unknown, Body>();
  [...(Array.isArray(before) ? before : []), ...(Array.isArray(after) ? after : [])].forEach((item: Body) => {
    items.set(item[key], item);
  });
  return [...items.values()];
}

export function coalesceChanges(changes: unknown[]): unknown[] {
  const result: Change[] = [];
  const indexByTarget = new Map<string, number>();
  (changes as Change[]).forEach((change) => {
    const kind = kindOf(change);
    const body = change[kind];
    if (!kind || !body || typeof body !== 'object' || kind === 'migration') {
      result.push(change);
      return;
    }
    const target = targetOf(kind, body as Body);
    const index = indexByTarget.get(target);
    if (index === undefined) {
      indexByTarget.set(target, result.length);
      result.push(change);
      return;
    }
    const before = result[index][kind] as Body;
    const after = body as Body;
    // Удаление заменяет всё прежнее; правка после удаления — новая запись целиком
    if (after.deleted || before.deleted) {
      result[index] = change;
      return;
    }
    const merged: Body = { ...before, ...after };
    const list = KEYED_LISTS[kind];
    if (list && (before[list.field] || after[list.field])) {
      merged[list.field] = mergeKeyed(before[list.field], after[list.field], list.key);
    }
    result[index] = { [kind]: merged };
  });
  return result;
}
