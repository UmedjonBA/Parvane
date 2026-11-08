// Своё имя контакта и заметка (CONTACT-1, A8 ревью 7 ноя 2026): как `contacts.addContact` Telegram — имя видно
// только владельцу (подставляется в `buildApiUser`), между своими устройствами — журналом личного состояния
// (`state.v1.Contact`, вид `contacts`; сервер видит только шифртекст)

export type LocalContactInfo = { firstName?: string; lastName?: string; note?: string };

/** proto3-JSON `state.v1.Contact` (пустые строки движок опускает). */
export type SContact = { user?: { address?: string }; first_name?: string; last_name?: string; note?: string };

const MAX_NAME_BYTES = 256;
const MAX_NOTE_BYTES = 4096;

function clampBytes(value: string | undefined, maxBytes: number) {
  const text = (value || '').trim();
  if (!text) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = '';
  for (const char of text) {
    if (encoder.encode(out + char).length > maxBytes) break;
    out += char;
  }
  return out || undefined;
}

/**
 * Имя из формы «Новый контакт» / «Изменить»: совпадает с именем, которое собеседник задал сам, — своего имени нет
 * (иначе смена имени собеседником перестала бы быть видна только потому, что форма была предзаполнена).
 */
export function contactNameOverride(publicName: string, firstName?: string, lastName?: string) {
  const first = clampBytes(firstName, MAX_NAME_BYTES);
  const last = clampBytes(lastName, MAX_NAME_BYTES);
  if (!first && !last) return undefined;
  if (!last && first === publicName.trim()) return undefined;
  return { firstName: first || '', lastName: last };
}

export function withContactName(
  info: LocalContactInfo | undefined,
  name: { firstName: string; lastName?: string } | undefined,
): LocalContactInfo | undefined {
  return compact({ ...info, firstName: name?.firstName, lastName: name?.lastName });
}

export function withContactNote(info: LocalContactInfo | undefined, note: string | undefined) {
  return compact({ ...info, note: clampBytes(note, MAX_NOTE_BYTES) });
}

function compact(info: LocalContactInfo): LocalContactInfo | undefined {
  const out: LocalContactInfo = {};
  if (info.firstName) out.firstName = info.firstName;
  if (info.lastName) out.lastName = info.lastName;
  if (info.note) out.note = info.note;
  return Object.keys(out).length ? out : undefined;
}

/** Явно добавленные контакты и их сведения → записи журнала. */
export function contactsToState(explicit: string[], info: Record<string, LocalContactInfo>): SContact[] {
  return Array.from(new Set(explicit)).filter(Boolean).map((address) => {
    const entry = info[address] || {};
    return {
      user: { address },
      first_name: entry.firstName || undefined,
      last_name: entry.lastName || undefined,
      note: entry.note || undefined,
    };
  });
}

/** Записи журнала → список явных контактов и сведения по адресу. */
export function contactsFromState(list: SContact[] | undefined) {
  const addresses: string[] = [];
  const info: Record<string, LocalContactInfo> = {};
  (list || []).forEach((contact) => {
    const address = contact.user?.address;
    if (!address || addresses.includes(address)) return;
    addresses.push(address);
    const entry = compact({ firstName: contact.first_name, lastName: contact.last_name, note: contact.note });
    if (entry) info[address] = entry;
  });
  return { addresses, info };
}

/**
 * Правки, сделанные до подключения журнала: свои записи поверх журнала, но без удалений — журнал мог получить
 * контакты с других устройств, которых здесь ещё нет.
 */
export function mergeContactsLocalWins(current: SContact[] | undefined, local: SContact[]) {
  const byAddress = new Map<string, SContact>();
  (current || []).forEach((contact) => {
    if (contact.user?.address) byAddress.set(contact.user.address, contact);
  });
  local.forEach((contact) => {
    if (contact.user?.address) byAddress.set(contact.user.address, contact);
  });
  return Array.from(byAddress.values());
}
