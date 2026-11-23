import { getActions } from '../../../../global';

import type { MusicCatalogTrack, MusicFetchJob } from '../../../../api/parvane/musicApi';

import { APP_NAME } from '../../../../config';
import { getTranslationFn } from '../../../../util/localization';
import { showMusicTrackNotification } from '../../../../util/pageNotify';
import { ACCOUNT_WIPED_EVENT } from '../../../../util/parvaneEvents';
import { createSignal } from '../../../../util/signals';
import { buildNotifyTitle } from '../../../../util/systemNotify';
import { callMusic, loadMusicInfo } from '../musicPlayer';

// Parvane (spec 039 этап B, spec 041): «Найти и скачать» и свои файлы — задачи пользователя на сервере («Загрузки на
// сервер»). Что считать тем самым треком, решает сервер; здесь — опрос, пока есть идущие задачи (на любом экране),
// запуск, выбор файла, отмена и уведомление, когда задача закончилась

const POLL_MS = 2000;
// Пока что-то качается — чаще: ход в процентах
const POLL_PROGRESS_MS = 1000;
const ICON = 'icon-192x192.png';

const [getFetchJobs, setFetchJobs] = createSignal<MusicFetchJob[]>([]);

export { getFetchJobs };

let pollTimer: number | undefined;
// Задачи, которые на глазах пользователя шли: о конце только их и сообщаем
const seenActive = new Set<string>();

if (typeof window !== 'undefined') {
  window.addEventListener(ACCOUNT_WIPED_EVENT, () => {
    window.clearTimeout(pollTimer);
    seenActive.clear();
    setFetchJobs([]);
  });
}

/** Ключ трека для сопоставления строки каталога с её задачей. */
export function catalogKey(track: Pick<MusicCatalogTrack, 'artist' | 'title'>) {
  return `${track.artist}\n${track.title}`.toLowerCase();
}

export function isJobActive(job: MusicFetchJob) {
  return job.state === 'queued' || job.state === 'searching' || job.state === 'downloading';
}

/** Доля загрузки 0…100; `undefined` — сервер не знает размера. */
export function getJobPercent(job: MusicFetchJob) {
  if (!job.bytesTotal) return undefined;
  return Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100));
}

function countSettled(jobs: MusicFetchJob[]) {
  return jobs.filter((job) => job.state === 'done' || job.state === 'failed').length;
}

/** Задача пришла от сервера либо из загрузки своего файла: заменить прежнюю с тем же id. */
export function putJob(job: MusicFetchJob) {
  setFetchJobs([job, ...getFetchJobs().filter((item) => item.jobId !== job.jobId)]);
  if (isJobActive(job)) seenActive.add(job.jobId);
  schedulePoll();
}

/** Ход своего файла, пока байты идут на сервер (сервер о них ещё не знает). */
export function patchJob(jobId: string, patch: Partial<MusicFetchJob>) {
  setFetchJobs(getFetchJobs().map((job) => (job.jobId === jobId ? { ...job, ...patch } : job)));
}

function schedulePoll() {
  window.clearTimeout(pollTimer);
  const jobs = getFetchJobs();
  if (!jobs.some(isJobActive)) return;
  const delay = jobs.some((job) => job.state === 'downloading') ? POLL_PROGRESS_MS : POLL_MS;
  pollTimer = window.setTimeout(() => {
    void refreshFetchJobs();
  }, delay);
}

/** Перечитать задачи с сервера; закончилась хоть одна — обновить лимиты и сообщить. */
export async function refreshFetchJobs() {
  const before = getFetchJobs();
  const jobs = await callMusic('parvaneMusicFetchStatus').catch(() => undefined);
  if (jobs) {
    // Свой файл, который ещё отправляется, сервер видит без хода — оставить ход отправки
    const merged = jobs.map((job) => {
      const known = before.find((item) => item.jobId === job.jobId);
      return known && job.uploadName && known.bytesDone > job.bytesDone ? { ...job, bytesDone: known.bytesDone } : job;
    });
    setFetchJobs(merged);
    notifyFinished(merged);
    if (countSettled(before) !== countSettled(merged)) void loadMusicInfo();
  }
  schedulePoll();
}

function notifyFinished(jobs: MusicFetchJob[]) {
  jobs.forEach((job) => {
    if (isJobActive(job)) {
      seenActive.add(job.jobId);
      return;
    }
    if (!seenActive.delete(job.jobId) || job.state === 'choice') return;
    const lang = getTranslationFn();
    const name = job.uploadName || job.track.title || job.query || '';
    const text = job.state === 'done'
      ? lang('MusicFetchDoneNotice', { name })
      : lang('MusicFetchFailedNotice', { name });
    getActions().showNotification({ message: text });
    if (job.state === 'done') {
      // Доска `ZpSystem`: «Parvane · Музыка — Трек скачан на сервер» с «Слушать»
      showMusicTrackNotification({
        jobId: job.jobId, trackId: job.trackId, title: name, artist: job.uploadName ? undefined : job.track.artist,
      });
      return;
    }
    void showSystemNotice(buildNotifyTitle(APP_NAME, lang('MusicFetchUploadsTitle')), text, job.jobId);
  });
}

// Окно скрыто — системное уведомление (если разрешены); на экране хватает строки в приложении
async function showSystemNotice(title: string, body: string, jobId: string) {
  if (document.visibilityState === 'visible' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.showNotification(title, {
      body, tag: `music-fetch:${jobId}`, icon: ICON, badge: ICON,
    });
  } catch {
    // Уведомление просто не покажется: задача видна в «Загрузках на сервер»
  }
}

type StartResult = 'ok' | 'limit' | 'duplicate' | 'failed';

function failureOf(err: unknown): StartResult {
  const text = String(err);
  if (text.includes('LIMIT')) return 'limit';
  if (text.includes('DUPLICATE')) return 'duplicate';
  return 'failed';
}

/** Скачать трек по эталону каталога. */
export async function startFetch(track: MusicCatalogTrack): Promise<StartResult> {
  try {
    putJob(await callMusic('parvaneMusicFetchStart', { track }));
    return 'ok';
  } catch (err) {
    return failureOf(err);
  }
}

/** Альбом каталога целиком: на сервер — треки, которых там нет. */
export async function startFetchAlbum(albumRef: string): Promise<StartResult> {
  try {
    (await callMusic('parvaneMusicFetchAlbum', { albumRef })).forEach(putJob);
    return 'ok';
  } catch (err) {
    return failureOf(err);
  }
}

/** «Найти и скачать «запрос»»: эталон сервер выбирает сам. */
export async function startFetchByQuery(query: string): Promise<StartResult> {
  try {
    putJob(await callMusic('parvaneMusicFetchQuery', { query }));
    return 'ok';
  } catch (err) {
    return failureOf(err);
  }
}

/** Продолжить задачу выбранным файлом. */
export async function chooseFetchCandidate(jobId: string, candidateId: string) {
  const job = await callMusic('parvaneMusicFetchChoose', { jobId, candidateId }).catch(() => undefined);
  if (job) putJob(job);
  return Boolean(job);
}

/** Отменить идущую задачу либо убрать законченную из списка. */
export async function cancelFetchJob(jobId: string) {
  const isDone = await callMusic('parvaneMusicFetchCancel', { jobId }).catch(() => false);
  if (isDone) {
    seenActive.delete(jobId);
    setFetchJobs(getFetchJobs().filter((job) => job.jobId !== jobId));
    void loadMusicInfo();
  }
  return isDone;
}

/** «Повторить» неудачную задачу: та же строка запроса либо тот же эталон. */
export async function retryFetchJob(job: MusicFetchJob) {
  await cancelFetchJob(job.jobId);
  return job.query ? startFetchByQuery(job.query) : startFetch(job.track);
}
