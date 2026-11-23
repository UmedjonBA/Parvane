import { createSignal } from '../../../util/signals';

// Parvane (макет «Музыки» 23 ноя, доска `RpMusicA-06`): строка внизу «Музыки» — что сделано, и «Отменить»

export type MusicToast = { id: number; text: string; onUndo?: NoneToVoidFunction };

const TOAST_MS = 4000;

const [getMusicToast, setMusicToast] = createSignal<MusicToast | undefined>(undefined);

export { getMusicToast };

let timer: number | undefined;

export function showMusicToast(text: string, onUndo?: NoneToVoidFunction) {
  window.clearTimeout(timer);
  const toast = { id: Date.now(), text, onUndo };
  setMusicToast(toast);
  timer = window.setTimeout(() => {
    if (getMusicToast()?.id === toast.id) setMusicToast(undefined);
  }, TOAST_MS);
}

export function hideMusicToast() {
  window.clearTimeout(timer);
  setMusicToast(undefined);
}
