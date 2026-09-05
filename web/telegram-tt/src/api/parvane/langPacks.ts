// Языковые пакеты Parvane. У tt переводы приезжают с серверов Telegram
// (langpack.*); у нас они лежат в сборке: `fallback.strings` (английский) и
// `ru.strings`. Версия пакета — хэш содержимого файла, поэтому правка строк
// автоматически обновляет кэш IndexedDB клиента через fetchLangDifference.

import type { ApiLanguage, LangPack } from '../types';

import { parseLangPackStrings } from '../../util/data/readFallbackStrings';

interface BundledLanguage {
  language: Omit<ApiLanguage, 'stringsCount' | 'translatedCount'>;
  load: () => Promise<string>;
}

const BUNDLED: Record<string, BundledLanguage> = {
  en: {
    language: {
      langCode: 'en',
      name: 'English',
      nativeName: 'English',
      pluralCode: 'en',
      isOfficial: true,
      translationsUrl: '',
    },
    load: () => import('../../assets/localization/fallback.strings?raw').then((m) => m.default),
  },
  ru: {
    language: {
      langCode: 'ru',
      name: 'Russian',
      nativeName: 'Русский',
      pluralCode: 'ru',
      isOfficial: true,
      translationsUrl: '',
    },
    load: () => import('../../assets/localization/ru.strings?raw').then((m) => m.default),
  },
};

const packCache = new Map<string, Promise<LangPack>>();

// FNV-1a 32 бит: детерминированная «версия» пакета из текста файла
export function hashLangPackText(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Версия должна быть положительной и отличаться от FALLBACK_VERSION (0)
  return (hash % 0x7ffffffe) + 1;
}

export function buildLangPackFromText(langCode: string, text: string): LangPack {
  return {
    langCode,
    version: hashLangPackText(text),
    strings: parseLangPackStrings(text),
  };
}

function normalizeLangCode(langCode: string) {
  const short = langCode.toLowerCase().replace('-raw', '').split(/[-_]/)[0];
  return BUNDLED[short] ? short : undefined;
}

export function getBundledLanguageCodes() {
  return Object.keys(BUNDLED);
}

export function loadBundledLangPack(langCode: string): Promise<LangPack> | undefined {
  const code = normalizeLangCode(langCode);
  if (!code) return undefined;
  let cached = packCache.get(code);
  if (!cached) {
    cached = BUNDLED[code].load().then((text) => buildLangPackFromText(code, text));
    packCache.set(code, cached);
  }
  return cached;
}

async function buildApiLanguage(code: string): Promise<ApiLanguage> {
  const pack = await loadBundledLangPack(code);
  const stringsCount = pack ? Object.keys(pack.strings).length : 0;
  return {
    ...BUNDLED[code].language,
    stringsCount,
    translatedCount: stringsCount,
  };
}

// Методы провайдера с интерфейсом gramjs (langpack.*)
export const langPackMethods = {
  fetchLanguages(): Promise<ApiLanguage[]> {
    return Promise.all(getBundledLanguageCodes().map(buildApiLanguage));
  },

  fetchLanguage({ langCode }: { langPack: string; langCode: string }): Promise<ApiLanguage | undefined> {
    const code = normalizeLangCode(langCode);
    return code ? buildApiLanguage(code) : Promise.resolve(undefined);
  },

  async fetchLangPack({ langCode }: { langPack: string; langCode: string }) {
    const pack = await loadBundledLangPack(langCode);
    if (!pack) return undefined;
    return { version: pack.version, strings: pack.strings, keysToRemove: [] as string[] };
  },

  async fetchLangDifference({ langCode, fromVersion }: { langPack: string; langCode: string; fromVersion: number }) {
    const pack = await loadBundledLangPack(langCode);
    if (!pack || pack.version === fromVersion) return undefined;
    return { version: pack.version, strings: pack.strings, keysToRemove: [] as string[] };
  },
};
