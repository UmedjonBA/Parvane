// Parvane: ссылка на пользователя ведёт в этот же веб-клиент
// (`<origin>/#@<ник>`), а не на t.me — QR-код и «копировать ссылку» в профиле
export function buildParvaneUserLink(username: string) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#@${username}`;
}

export default function formatUsername(username: string, asAbsoluteLink?: boolean) {
  return asAbsoluteLink ? buildParvaneUserLink(username) : `@${username}`;
}
