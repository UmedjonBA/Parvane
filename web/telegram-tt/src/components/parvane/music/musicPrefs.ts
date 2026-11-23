import type { MusicStreamQuality } from '../../../api/parvane/musicApi';

import { createSignal } from '../../../util/signals';

// Parvane (макет «Музыки» 23 ноя, доска `MusicSettings-01` «Настройки музыки · для вас»): настройки этого
// устройства — качество по Wi-Fi и по мобильной сети, выравнивание громкости, поиск в каталоге

export type MusicPrefs = {
  wifiQuality: MusicStreamQuality;
  cellQuality: MusicStreamQuality;
  isNormalized: boolean;
  isCatalogSearch: boolean;
};

const KEY = 'parvane:music-prefs';
const DEFAULTS: MusicPrefs = {
  wifiQuality: 'original', cellQuality: 'opus', isNormalized: true, isCatalogSearch: true,
};

function read(): MusicPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<MusicPrefs> };
  } catch {
    return DEFAULTS;
  }
}

const [getMusicPrefs, setMusicPrefsSignal] = createSignal<MusicPrefs>(read());

export { getMusicPrefs };

export function setMusicPrefs(change: Partial<MusicPrefs>) {
  const next = { ...getMusicPrefs(), ...change };
  setMusicPrefsSignal(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Настройка просто не запомнится
  }
}
