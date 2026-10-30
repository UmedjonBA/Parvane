// ID-03: копия корня для администратора — только под ключом, закреплённым в сборке
// (`VITE_PARVANE_ESCROW_PUBLIC_KEY`). Объявленный сервером ключ принимается лишь при совпадении:
// без закрепления сервер мог бы подставить свой ключ и получить корень личности.

/** Ключ для копии корня (base64) либо пусто — копию не делать. */
export function pickEscrowKey(pinned: string, announced: string) {
  // Ключ сравнивается как байты: `escrow_admin keygen` печатает base64url без `=`, сервер объявляет стандартный base64
  const norm = (value: string) => value.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const want = norm(pinned);
  return want && norm(announced) === want ? announced.trim() : '';
}
