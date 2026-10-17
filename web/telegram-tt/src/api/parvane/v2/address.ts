// Федерация (spec 028, правило FED-1): адрес и домен сервера объекта. Клиент ходит только к своему
// серверу; запрос объекту чужого домена несёт `dest_domain`, свой сервер пересылает его.

/** Домен адреса `ник@домен` (в нижнем регистре); не адрес — пусто. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : '';
}

/** Адресат запроса: домен, если он не свой; свой или пустой — `undefined` (обычный запрос). */
export function destFor(domain: string | undefined, own: string): string | undefined {
  const d = (domain || '').toLowerCase();
  return d && d !== own.toLowerCase() ? d : undefined;
}

/**
 * Адресат запроса по ссылке-приглашению. Ссылка, открытая в адресной строке, собрана из адреса
 * страницы (`routing.ts`): её хост — хост web этого сервера (на стенде `127.0.0.1`, через Tor —
 * `.onion`), а не домен сервера; такая ссылка — своя.
 */
export function destForInvite(domain: string | undefined, own: string, pageHost?: string): string | undefined {
  if (domain && pageHost && domain.toLowerCase() === pageHost.toLowerCase()) return undefined;
  return destFor(domain, own);
}

/** Адресат запроса о пользователе (журнал, бандл, жетоны его сервера). */
export function destForUser(address: string, own: string): string | undefined {
  return destFor(domainOf(address), own);
}

/** Пользователь другого сервера. */
export function isForeign(address: string, own: string): boolean {
  return destForUser(address, own) !== undefined;
}

// Коды отказов федерации → ключи словаря (EN+RU, FR-013)
const FEDERATION_REASONS: Record<string, string> = {
  ERROR_CODE_FEDERATION_UNAVAILABLE: 'ParvaneFederationDisabled',
  ERROR_CODE_DOMAIN_BLOCKED: 'ParvaneFederationDomainBlocked',
  ERROR_CODE_DOMAIN_REFUSED: 'ParvaneFederationRefused',
  ERROR_CODE_DOMAIN_UNREACHABLE: 'ParvaneFederationUnreachable',
  ERROR_CODE_SERVER_KEY_CHANGED: 'ParvaneFederationKeyChanged',
};

/** Ключ словаря с причиной отказа федерации; другая ошибка — `undefined`. */
export function federationReason(err: unknown): string | undefined {
  const code = typeof err === 'object' && err && 'code' in err ? String((err).code) : String(err);
  const found = Object.keys(FEDERATION_REASONS).find((c) => code.includes(c));
  return found ? FEDERATION_REASONS[found] : undefined;
}
