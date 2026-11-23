import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicFileInfo } from '../../../api/parvane/musicFilesApi';
import type useLang from '../../../hooks/useLang';

import { ACCOUNT_WIPED_EVENT } from '../../../util/parvaneEvents';
import { createSignal } from '../../../util/signals';
import { announceLibraryRescan } from './musicAdded';

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

/** Теги изменились: экраны «Музыки» перечитывают библиотеку (сразу и после пересканирования). */
export function notifyMusicLibraryChanged() {
  announceLibraryRescan();
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

type Lang = ReturnType<typeof useLang>;

// Источники файлов сервера — их собственными именами
const SOURCE_NAMES: Record<string, string> = {
  hitmoz: 'hitmoz',
  hitmos_fm: 'hitmos.fm',
  youtube: 'YouTube',
  youtube_reupload: 'YouTube',
  soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp',
};

/** «Источник» файла: название источника (и ссылка, `withLink`) либо «свой файл «имя»». */
export function formatFileSource(lang: Lang, info: MusicFileInfo, withLink?: boolean) {
  if (info.source === 'upload') return lang('MusicSourceOwnFile', { name: info.sourceRef });
  const link = withLink && info.sourceRef.startsWith('https://') ? info.sourceRef : undefined;
  return [SOURCE_NAMES[info.source] || lang('MusicSourceUnknown'), link].filter(Boolean).join(' · ');
}

/** «Качество» файла: «FLAC · 16/44,1» либо «MP3 · 320 kbps». */
export function formatFileQuality(lang: Lang, info: MusicFileInfo) {
  return [
    info.codec.toUpperCase(),
    info.bits && info.sampleRate
      ? lang('MusicFileQuality', { bits: info.bits, khz: lang.number(info.sampleRate / 1000) }) : undefined,
    !info.bits && info.bitrateKbps ? `${info.bitrateKbps} kbps` : undefined,
  ].filter(Boolean).join(' · ');
}
