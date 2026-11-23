import type { MusicTrack } from '../../../api/parvane/musicApi';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import { MUSIC_LIBRARY_CHANGED_EVENT } from './musicAdded';

// Parvane (макет «Музыки» 23 ноя): какой экран правки файлов открыт — «Откуда файл», «Изменить трек / треки /
// альбом», «Объединить исполнителей», «Перенести треки». Открываются из меню трека, альбома, исполнителя и выбора
// нескольких, поэтому — сигнал, а рисует их одно место (`MusicFileSheets`)

export type MusicFileSheet =
  | { kind: 'info'; track: MusicTrack }
  | { kind: 'tracks'; tracks: MusicTrack[] }
  | { kind: 'album'; albumId: string; tracks: MusicTrack[] }
  | { kind: 'merge'; artistId: string; name: string }
  | { kind: 'move'; tracks: MusicTrack[] };

const [getMusicFileSheet, setMusicFileSheet] = createSignal<MusicFileSheet | undefined>(undefined);

export { getMusicFileSheet };

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => setMusicFileSheet(undefined));
}

export function openMusicFileSheet(sheet: MusicFileSheet) {
  setMusicFileSheet(sheet);
}

export function closeMusicFileSheet() {
  setMusicFileSheet(undefined);
}

/** Теги изменились: экраны «Музыки» перечитывают библиотеку. */
export function notifyMusicLibraryChanged() {
  window.dispatchEvent(new Event(MUSIC_LIBRARY_CHANGED_EVENT));
}

const COVER_SIZE = 600;
const COVER_QUALITY = 0.88;
const COVER_MAX_BYTES = 512 * 1024;

/** Картинка обложки → JPEG не больше 600 px и 512 КБ (столько принимает сервер за раз). */
export async function prepareCover(file: Blob): Promise<Uint8Array | undefined> {
  const bitmap = await createImageBitmap(file).catch(() => undefined);
  if (!bitmap) return undefined;
  const scale = Math.min(1, COVER_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | undefined>((resolve) => {
    canvas.toBlob((result) => resolve(result || undefined), 'image/jpeg', COVER_QUALITY);
  });
  if (!blob || blob.size > COVER_MAX_BYTES) return undefined;
  return new Uint8Array(await blob.arrayBuffer());
}
