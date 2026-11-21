import { createSignal } from './signals';

// Parvane (доска `ZpChat`): переписка с сервером собеседника выключена администратором своего сервера (отказ
// федерации `DOMAIN_BLOCKED` / `FEDERATION_UNAVAILABLE`) — постоянная плашка в чатах с этим сервером, и при
// следующем открытии чата, а не только причина под неотправленным. Своей проверки «сервер заблокирован» в протоколе
// нет: домен запоминается по первому отказу и снимается удачной отправкой туда. Память устройства (`parvane:*`)

const STORAGE_KEY = 'parvane:federation-blocked';
const BLOCKING_KEYS = new Set(['ParvaneFederationDomainBlocked', 'ParvaneFederationDisabled']);

type BlockedDomains = Record<string, string>;

const [getBlockedDomains, setBlockedDomains] = createSignal<BlockedDomains>(readStored());

export { getBlockedDomains };

/** Домен адреса `ник@домен`; у своего сервера и групп — `undefined`. */
export function getForeignDomain(address: string | undefined, ownDomain: string) {
  const at = address?.lastIndexOf('@') ?? -1;
  if (!address || at < 0) return undefined;
  const domain = address.slice(at + 1).toLowerCase();
  return domain && domain !== ownDomain.toLowerCase() ? domain : undefined;
}

export function noteFederationRefusal(domain: string | undefined, reasonKey: string | undefined) {
  if (!domain || !reasonKey || !BLOCKING_KEYS.has(reasonKey)) return;
  if (getBlockedDomains()[domain] === reasonKey) return;
  store({ ...getBlockedDomains(), [domain]: reasonKey });
}

export function clearFederationRefusal(domain: string | undefined) {
  if (!domain || !getBlockedDomains()[domain]) return;
  const { [domain]: removed, ...rest } = getBlockedDomains();
  store(rest);
}

function store(next: BlockedDomains) {
  setBlockedDomains(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Память устройства недоступна — плашка живёт до перезагрузки
  }
}

function readStored(): BlockedDomains {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as BlockedDomains);
    return Object.fromEntries(entries.filter(([, key]) => BLOCKING_KEYS.has(String(key))));
  } catch {
    return {};
  }
}
