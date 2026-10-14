// ID-03: копия корня для администратора — только под ключом, закреплённым в сборке
// (`VITE_PARVANE_ESCROW_PUBLIC_KEY`). Объявленный сервером ключ принимается лишь при совпадении:
// без закрепления сервер мог бы подставить свой ключ и получить корень личности.

/** Ключ для копии корня (base64) либо пусто — копию не делать. */
export function pickEscrowKey(pinned: string, announced: string) {
  const want = pinned.trim();
  return want && announced.trim() === want ? want : '';
}
