import { getActions, getGlobal } from '../global';

import { selectSharedSettings } from '../global/selectors/sharedState';
import { getBrowserLanguageCode } from './localization/languages';

// «Язык» (доски `RpProfileA`, `ZdProfileX`): «Как в системе» — язык интерфейса берётся из языка браузера и следит за
// его сменой; «Проверка орфографии» — атрибут `spellcheck` у корня документа (его наследуют композер, заметки и
// прочие поля, которые не задают его сами). Обе — настройки устройства
const SYSTEM_KEY = 'parvane:language-system';
const SPELLCHECK_KEY = 'parvane:spellcheck';

let isWatching = false;

export function getIsSystemLanguage() {
  return readFlag(SYSTEM_KEY, false);
}

export function setIsSystemLanguage(isOn: boolean) {
  writeFlag(SYSTEM_KEY, isOn);
  if (isOn) applySystemLanguage();
}

export function getIsSpellcheckOn() {
  return readFlag(SPELLCHECK_KEY, true);
}

export function setSpellcheckOn(isOn: boolean) {
  writeFlag(SPELLCHECK_KEY, isOn);
  applySpellcheck();
}

/** При запуске: проверка орфографии и язык «как в системе» (с отслеживанием смены языка браузера). */
export function startLanguagePrefs() {
  applySpellcheck();
  applySystemLanguage();
  if (isWatching) return;
  isWatching = true;
  window.addEventListener('languagechange', applySystemLanguage);
}

function applySystemLanguage() {
  if (!getIsSystemLanguage()) return;
  const code = getBrowserLanguageCode();
  if (selectSharedSettings(getGlobal()).language !== code) getActions().setSharedSettingOption({ language: code });
}

function applySpellcheck() {
  document.documentElement.spellcheck = getIsSpellcheckOn();
}

function readFlag(key: string, fallback: boolean) {
  try {
    const value = localStorage.getItem(key);
    return value ? value === '1' : fallback;
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, isOn: boolean) {
  try {
    localStorage.setItem(key, isOn ? '1' : '0');
  } catch {
    // Настройка действует до перезагрузки
  }
}
