import type { MusicMixToday } from '../../../api/parvane/musicApi';

import { createSignal } from '../../../util/signals';
import { callMusic } from './musicPlayer';

// «Микс дня»: что ответил сервер о сегодняшнем миксе. Пока он собирается (каталог отвечает секунды), спрашиваем
// снова; один запрос за раз — главная и экран микса делят его
const POLL_MS = 2000;
const POLL_TRIES = 30;

const [getMusicMix, setMusicMix] = createSignal<MusicMixToday | undefined>(undefined);
const [getIsMusicMixFailed, setMusicMixFailed] = createSignal(false);

export { getIsMusicMixFailed, getMusicMix };

let loading: Promise<void> | undefined;

/** Перечитать сегодняшний микс; собирается — ждать, пока соберётся. */
export function loadMusicMix() {
  loading ||= poll().finally(() => {
    loading = undefined;
  });
  return loading;
}

async function poll() {
  for (let attempt = 0; attempt < POLL_TRIES; attempt++) {
    const today = await callMusic('parvaneMusicMixToday').catch(() => undefined);
    if (!today) {
      setMusicMixFailed(true);
      return;
    }
    setMusicMixFailed(false);
    setMusicMix(today);
    if (!today.isBuilding) return;
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_MS);
    });
  }
}

/** «Другой микс»: собрать заново и дождаться. */
export async function rebuildMusicMix() {
  const current = getMusicMix();
  if (current) setMusicMix({ ...current, isBuilding: true });
  await callMusic('parvaneMusicMixRebuild').catch(() => undefined);
  return loadMusicMix();
}

// Лист «настройки микса» (доска `MusicHome-04`): открыт с экрана микса либо шагом 2 после выбора исполнителей
const [getIsMixSettingsOpen, setIsMixSettingsOpen] = createSignal(false);

export { getIsMixSettingsOpen };

export function openMixSettings() {
  setIsMixSettingsOpen(true);
}

export function closeMixSettings() {
  setIsMixSettingsOpen(false);
}
