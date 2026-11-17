import type { ApiOldLangPack, ApiOldLangString } from '../api/types';
import type { TimeFormat } from '../types';

import { buildOldLangPack, OLD_LANG_PACK_EN } from '../api/parvane/oldLangPack';
import { createCallbackManager } from './callbacks';
import { addLocalizationCallback, getLangStringByKey, getTranslationFn as getNewTranslationFn } from './localization';
import { formatInteger } from './textFormat';

export interface LangFn {
  (key: string, value?: any, format?: 'i', pluralValue?: number): string;

  // Письмо справа налево не поддерживается: флаг никогда не выставляется, остался для разметки форка
  isRtl?: boolean;
  code?: string;
  timeFormat?: TimeFormat;
}

const SUBSTITUTION_REGEX = /%\d?\$?[sdf@]/g;
const PLURAL_OPTIONS = {
  zero: 'zeroValue',
  one: 'oneValue',
  two: 'twoValue',
  few: 'fewValue',
  many: 'manyValue',
  other: 'otherValue',
} as const;

const cache = new Map<string, string>();

let langPack: ApiOldLangPack | undefined;

const {
  addCallback,
  removeCallback,
  runCallbacks,
} = createCallbackManager();

export { addCallback, removeCallback };

let currentLangCode: string | undefined;
let currentTimeFormat: TimeFormat | undefined;
let pluralRules: Intl.PluralRules | undefined;

function createLangFn() {
  return (key: string, value?: any, format?: 'i', pluralValue?: number) => {
    if (value !== undefined) {
      const cacheValue = Array.isArray(value) ? JSON.stringify(value) : value;
      const cached = cache.get(`${key}_${cacheValue}_${format}${pluralValue ? `_${pluralValue}` : ''}`);
      if (cached) {
        return cached;
      }
    }

    // Порядок: словарь старых ключей своего языка, перевод из файла строк языка, английский словарь старых
    // ключей, английская база. Так язык без своего словаря переводит старые ключи прямо в `<код>.strings`
    const langString = langPack?.[key]
      || bridgeFromNewLangPack(key, value, pluralValue, true)
      || OLD_LANG_PACK_EN[key]
      || bridgeFromNewLangPack(key, value, pluralValue);
    if (!langString) {
      return key;
    }

    return processTranslation(langString, key, value, format, pluralValue);
  };
}

// Строка нового пакета для старого ключа. Плейсхолдеры `{name}` превращаем в
// позиционные `%@`, форму множественного числа выбирает новый провайдер
function bridgeFromNewLangPack(
  key: string, value?: any, pluralValue?: number, shouldSkipBase?: boolean,
): string | undefined {
  const count = pluralValue ?? (typeof value === 'number' ? value : 0);
  const bridged = getLangStringByKey(key, count, shouldSkipBase);
  if (!bridged) return undefined;
  return bridged.replace(/\{[A-Za-z0-9_]+\}/g, '%@');
}

let translationFn: LangFn = createLangFn();

// Язык ведёт новый провайдер (`changeLanguage`): по его оповещению пересобираем словарь старых ключей,
// сбрасываем кэш мостовых строк и перерисовываем компоненты на `useOldLang`
addLocalizationCallback(() => {
  cache.clear();
  syncLanguage();
  runCallbacks();
});

function syncLanguage() {
  const langCode = getNewTranslationFn().rawCode;
  if (langCode === currentLangCode) return;

  cache.clear();
  currentLangCode = langCode;
  langPack = buildOldLangPack(langCode);
  pluralRules = new Intl.PluralRules(langCode);

  translationFn = createLangFn();
  translationFn.code = langCode;
  translationFn.timeFormat = currentTimeFormat;
}

/**
 * @deprecated Do not translate inside non-reactive contexts. Pass parameters to the component instead
 */
export function oldTranslate(...args: Parameters<LangFn>) {
  return getTranslationFn()(...args);
}

export function getTranslationFn(): LangFn {
  // Оповещение нового провайдера приходит со следующим кадром — сверяем язык и при прямом обращении
  syncLanguage();
  return translationFn;
}

export function setTimeFormat(timeFormat: TimeFormat) {
  if (timeFormat && timeFormat === currentTimeFormat) {
    return;
  }

  currentTimeFormat = timeFormat;
  translationFn.timeFormat = timeFormat;

  runCallbacks();
}

function getPluralOption(amount: number) {
  return PLURAL_OPTIONS[pluralRules?.select(amount) || 'other'];
}

function processTemplate(template: string, value: any) {
  value = Array.isArray(value) ? value : [value];
  const translationSlices = template.split(SUBSTITUTION_REGEX);
  const initialValue = translationSlices.shift();

  return translationSlices.reduce((result, str, index) => {
    return `${result}${String(value[index] ?? '')}${str}`;
  }, initialValue || '');
}

function processTranslation(
  langString: ApiOldLangString | undefined, key: string, value?: any, format?: 'i', pluralValue?: number,
) {
  const hasPluralValue = typeof value === 'number' || pluralValue !== undefined;
  const template = typeof langString === 'string'
    ? langString
    : hasPluralValue && typeof langString === 'object'
      ? langString[getPluralOption(pluralValue ?? value)] || langString.otherValue
      : undefined;

  if (!template?.trim()) {
    const parts = key.split('.');

    return parts[parts.length - 1];
  }

  if (value !== undefined) {
    const formattedValue = format === 'i' ? formatInteger(value) : value;
    const result = processTemplate(template, formattedValue);
    const cacheValue = Array.isArray(value) ? JSON.stringify(value) : value;
    cache.set(`${key}_${cacheValue}_${format}${pluralValue ? `_${pluralValue}` : ''}`, result);
    return result;
  }

  return template;
}
