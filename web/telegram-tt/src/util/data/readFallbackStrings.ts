import type {
  ApiLanguage, CachedLangData, LangPack, LangPackStringValuePlural,
} from '../../api/types';

import readStrings from './readStrings';

const FALLBACK_LANG_CODE = 'en';
const FALLBACK_VERSION = 0;
const FALLBACK_TRANSLATE_URL = `https://translations.telegram.org/${FALLBACK_LANG_CODE}/weba`;

export default async function readFallbackStrings(): Promise<CachedLangData> {
  const file = await import('../../assets/localization/fallback.strings?raw');
  return buildFallbackStrings(file.default);
}

// Parvane: суффикс формы множественного числа распознаём только из списка
// CLDR — иначе ключи вида `lng_channel_add_users` разваливались на «lng»
const PLURAL_SUFFIX_REGEX = /^(.+)_(zero|one|two|few|many|other)$/;

export function parseLangPackStrings(fileData: string): LangPack['strings'] {
  const rawStrings = readStrings(fileData);

  const strings: LangPack['strings'] = {};

  Object.entries(rawStrings).forEach(([key, value]) => {
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

export function buildFallbackStrings(fileData: string): CachedLangData {
  const strings = parseLangPackStrings(fileData);

  const langPack: LangPack = {
    langCode: FALLBACK_LANG_CODE,
    version: FALLBACK_VERSION,
    strings,
  };

  const stringsCount = Object.keys(strings).length;

  const language: ApiLanguage = {
    langCode: FALLBACK_LANG_CODE,
    name: 'English',
    nativeName: 'English',
    pluralCode: FALLBACK_LANG_CODE,
    stringsCount,
    translatedCount: stringsCount,
    translationsUrl: FALLBACK_TRANSLATE_URL,
  };

  return {
    langPack,
    language,
  };
}
