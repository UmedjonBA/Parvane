// Реестр языков интерфейса — единственное место, где перечислены языки.
// Добавить язык: положить `<код>.strings` в `src/assets/localization/` и дописать строку в `LANGUAGES`.
// Основной язык — английский (`fallback.strings`): его строкой показывается всё, чего нет в переводе.
// Письмо справа налево не поддерживается — такой язык в реестр не добавлять.

import type { LangPackStringValue, LangPackStringValuePlural } from '../../api/types';

import readStrings from '../data/readStrings';

export interface InterfaceLanguage {
  // Код языка: по нему ищется файл строк, сверяется язык браузера и работают правила `Intl`
  code: string;
  // Название на самом языке
  nativeName: string;
  // Название по-английски
  name: string;
}

export type LanguageStrings = Record<string, LangPackStringValue>;

export const BASE_LANGUAGE_CODE = 'en';
const BASE_STRINGS_FILE = 'fallback';

export const LANGUAGES: readonly InterfaceLanguage[] = [
  { code: BASE_LANGUAGE_CODE, nativeName: 'English', name: 'English' },
  { code: 'ru', nativeName: 'Русский', name: 'Russian' },
];

// Файлы строк — отдельные части сборки, грузится только выбранный язык и база
const STRING_FILE_LOADERS = import.meta.glob<string>('../../assets/localization/*.strings', {
  query: '?raw', import: 'default',
});

// Суффикс формы множественного числа распознаём только из списка CLDR —
// иначе ключи вида `lng_channel_add_users` разваливались на «lng»
const PLURAL_SUFFIX_REGEX = /^(.+)_(zero|one|two|few|many|other)$/;

const loadedStrings = new Map<string, Promise<LanguageStrings>>();

export function findLanguage(code: string) {
  return LANGUAGES.find((language) => language.code === code);
}

export function getStringsFileName(code: string) {
  return `${code === BASE_LANGUAGE_CODE ? BASE_STRINGS_FILE : code}.strings`;
}

// Язык по списку предпочтений браузера: первый, что есть в реестре, — точно («pt-br») либо по основной
// части («ru-RU» → «ru»); иначе основной
export function pickLanguageCode(preferredCodes: readonly string[]) {
  for (const preferredCode of preferredCodes) {
    const normalizedCode = preferredCode.toLowerCase().replace('_', '-');
    const language = findLanguage(normalizedCode) || findLanguage(normalizedCode.split('-')[0]);
    if (language) return language.code;
  }

  return BASE_LANGUAGE_CODE;
}

export function getBrowserLanguageCode() {
  if (typeof navigator === 'undefined') return BASE_LANGUAGE_CODE;
  return pickLanguageCode(navigator.languages?.length ? navigator.languages : [navigator.language || '']);
}

export function loadLanguageStrings(code: string) {
  let strings = loadedStrings.get(code);
  if (!strings) {
    const loadFile = STRING_FILE_LOADERS[`../../assets/localization/${getStringsFileName(code)}`];
    strings = loadFile().then(parseLanguageStrings);
    loadedStrings.set(code, strings);
    // Сорвавшаяся загрузка не запоминается — следующая попытка грузит заново
    strings.catch(() => loadedStrings.delete(code));
  }

  return strings;
}

export function parseLanguageStrings(fileData: string): LanguageStrings {
  const strings: LanguageStrings = {};

  Object.entries(readStrings(fileData)).forEach(([key, value]) => {
    const match = key.match(PLURAL_SUFFIX_REGEX);
    if (!match) {
      strings[key] = value;
      return;
    }

    const [, clearKey, pluralSuffix] = match;
    const knownValue = (strings[clearKey] || {}) as LangPackStringValuePlural;
    knownValue[pluralSuffix as keyof LangPackStringValuePlural] = value;
    strings[clearKey] = knownValue;
  });

  return strings;
}
