// Parvane (доска `ZdNav`, «Вы вышли на этом компьютере»): это устройство отозвано другим устройством аккаунта.
// Провайдер стирает данные аккаунта, ставит отметку и перезагружает страницу; экран входа показывает итог, пока его
// не закроют «Войти заново». Отметка пишется ПОСЛЕ стирания (стирание убрало бы её вместе с `parvane:*`)

const SIGNED_OUT_KEY = 'parvane:signed-out';

export type SignedOutInfo = {
  atMs: number;
};

export function markSignedOut(atMs: number) {
  try {
    localStorage.setItem(SIGNED_OUT_KEY, JSON.stringify({ atMs } satisfies SignedOutInfo));
  } catch {
    // Хранилище недоступно — вход без объяснения, как раньше
  }
}

export function readSignedOut(): SignedOutInfo | undefined {
  try {
    const saved = localStorage.getItem(SIGNED_OUT_KEY);
    if (!saved) return undefined;
    const info = JSON.parse(saved) as Partial<SignedOutInfo>;
    return typeof info.atMs === 'number' ? { atMs: info.atMs } : undefined;
  } catch {
    return undefined;
  }
}

export function clearSignedOut() {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Нечего снимать
  }
}
