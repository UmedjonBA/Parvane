import type { MusicFetchJob } from '../../../../api/parvane/musicApi';

import { bytesToBase64 } from '../../../../api/parvane/v2/base64';
import { engineStatic } from '../../../../api/parvane/v2/engine';
import { callMusic, getMusicInfo, loadMusicInfo } from '../musicPlayer';
import { patchJob, putJob, refreshFetchJobs } from './musicFetch';

// Parvane (spec 041, доски `RpMusicB`, `ZdMusicX`): «Загрузить свои файлы» — свои аудиофайлы в общую библиотеку
// сервера. Теги читает общая библиотека на устройстве (`musicReadTags`, то же чтение, что у шарда), SHA-256 — для
// дедупликации; сервер выдаёт ссылку на один приём, байты уходят `PUT` мимо gateway (ход — по отправке). Лимиты те же,
// что у «Найти и скачать»; итог — задача в «Загрузках на сервер»

export type MusicFileTags = {
  format: 'mp3' | 'flac' | 'ogg' | 'm4a' | 'wav' | 'unknown';
  mime: string;
  title: string;
  artist: string;
  album: string;
  trackNo: number;
  year: number;
  durationSecs: number;
  fromName: boolean;
};

export type MusicUploadOutcome = 'ok' | 'duplicate' | 'not-audio' | 'too-big' | 'limit' | 'failed';

// Сколько начала файла нужно для тегов (как у шарда) и хвоста — для ID3v1
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 128;
const AUDIO_EXTENSIONS = ['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'wav'];

/** Подходит ли файл по имени (перетаскивание и выбор пропускают остальное). */
export function isAudioFileName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return Boolean(ext && name.includes('.') && AUDIO_EXTENSIONS.includes(ext));
}

/** Теги файла на устройстве. */
export async function readFileTags(file: File): Promise<MusicFileTags> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const tail = file.size > HEAD_BYTES ? new Uint8Array(await file.slice(file.size - TAIL_BYTES).arrayBuffer()) : head;
  return engineStatic<MusicFileTags>('musicReadTags', {
    head: bytesToBase64(head), tail: bytesToBase64(tail.slice(-TAIL_BYTES)), fileName: file.name,
  });
}

async function hashFile(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Отправить байты; ход — в задачу. Ответ — код HTTP (0 — сеть оборвалась). */
function putFile(url: string, file: File, jobId: string): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patchJob(jobId, { bytesDone: e.loaded, bytesTotal: e.total });
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.onabort = () => resolve(0);
    xhr.send(file);
  });
}

/** Загрузить один свой файл в библиотеку сервера. */
export async function uploadMusicFile(file: File): Promise<MusicUploadOutcome> {
  const info = getMusicInfo();
  if (info?.uploadMaxBytes && file.size > info.uploadMaxBytes) return 'too-big';
  let tags: MusicFileTags;
  try {
    tags = await readFileTags(file);
  } catch {
    return 'failed';
  }
  if (tags.format === 'unknown') return 'not-audio';
  let started: { job: MusicFetchJob; url: string };
  try {
    started = await callMusic('parvaneMusicUploadStart', {
      fileName: file.name,
      bytes: file.size,
      sha256: await hashFile(file),
      title: tags.title,
      artist: tags.artist,
      durationSecs: tags.durationSecs,
    });
  } catch (err) {
    return String(err).includes('ERROR_CODE_LIMIT') ? 'limit' : 'failed';
  }
  putJob(started.job);
  if (!started.url) return 'duplicate';
  const status = await putFile(started.url, file, started.job.jobId);
  void refreshFetchJobs();
  void loadMusicInfo();
  return status === 200 ? 'ok' : 'failed';
}

/** Несколько файлов подряд (по одному — не забивать канал); не аудио по имени пропускаются. */
export async function uploadMusicFiles(files: File[]) {
  const outcomes: MusicUploadOutcome[] = [];
  for (const file of files) {
    outcomes.push(isAudioFileName(file.name) ? await uploadMusicFile(file) : 'not-audio');
  }
  return outcomes;
}
