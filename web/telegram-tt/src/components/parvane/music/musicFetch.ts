import type { MusicCatalogTrack, MusicFetchJob } from '../../../api/parvane/musicApi';

import { createSignal } from '../../../util/signals';
import { callMusic, loadMusicInfo } from './musicPlayer';

// Parvane (spec 039, этап B): «Найти и скачать» — задачи скачивания пользователя. Что считать тем самым
// треком, решает сервер; здесь — опрос состояния, пока есть идущие задачи, и запуск / выбор файла

const POLL_MS = 2000;

const [getFetchJobs, setFetchJobs] = createSignal<MusicFetchJob[]>([]);

export { getFetchJobs };

let pollTimer: number | undefined;

/** Ключ трека для сопоставления строки каталога с её задачей. */
export function catalogKey(track: Pick<MusicCatalogTrack, 'artist' | 'title'>) {
  return `${track.artist}\n${track.title}`.toLowerCase();
}

function hasActive(jobs: MusicFetchJob[]) {
  return jobs.some((job) => job.state === 'searching' || job.state === 'downloading');
}

function countSettled(jobs: MusicFetchJob[]) {
  return jobs.filter((job) => job.state === 'done' || job.state === 'failed').length;
}

function putJob(job: MusicFetchJob) {
  const key = catalogKey(job.track);
  const others = getFetchJobs().filter((item) => item.jobId !== job.jobId && catalogKey(item.track) !== key);
  setFetchJobs([job, ...others]);
  schedulePoll();
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  if (!hasActive(getFetchJobs())) return;
  pollTimer = window.setTimeout(() => {
    void refreshFetchJobs();
  }, POLL_MS);
}

/** Перечитать задачи с сервера; закончилась хоть одна — обновить лимиты. */
export async function refreshFetchJobs() {
  const before = getFetchJobs();
  const jobs = await callMusic('parvaneMusicFetchStatus').catch(() => undefined);
  if (jobs) {
    setFetchJobs(jobs);
    // Закончилась хоть одна задача — лимиты и расход изменились
    if (countSettled(before) !== countSettled(jobs)) void loadMusicInfo();
  }
  schedulePoll();
}

/** Скачать трек по эталону. Отказ сервера — код: `limit` (лимит на сутки либо место) или `failed`. */
export async function startFetch(track: MusicCatalogTrack): Promise<'ok' | 'limit' | 'failed'> {
  try {
    putJob(await callMusic('parvaneMusicFetchStart', { track }));
    return 'ok';
  } catch (err) {
    return String(err).includes('LIMIT') ? 'limit' : 'failed';
  }
}

/** Продолжить задачу выбранным файлом. */
export async function chooseFetchCandidate(jobId: string, candidateId: string) {
  const job = await callMusic('parvaneMusicFetchChoose', { jobId, candidateId }).catch(() => undefined);
  if (job) putJob(job);
  return Boolean(job);
}
