import type { TeactNode } from '../../lib/teact/teact';

import type { TimeFormat } from '../../types';
import type { LangKey, LangVariable } from '../../types/language';
import type { InterfaceLanguage, LanguageStrings } from './languages';
import {
  type AdvancedLangFnOptions,
  type AdvancedLangFnOptionsWithPlural,
  type AdvancedLangFnParameters,
  areAdvancedLangFnOptions,
  isDeletedLangString,
  isPluralLangString,
  type LangFn,
  type LangFnOptions,
  type LangFnOptionsWithPlural,
  type LangFnParameters,
  type LangFormatters,
  type RegularLangFnParameters,
} from './types';

import renderText, { type TextFilter } from '../../components/common/helpers/renderText';
import { IS_INTL_LIST_FORMAT_SUPPORTED } from '../browser/globalEnvironment';
import { getBasicListFormat } from '../browser/intlListFormat';
import { createCallbackManager } from '../callbacks';
import { unique } from '../iteratees';
import { replaceInStringsWithTeact } from '../replaceWithTeact';
import { fastRaf } from '../schedulers';
import { resetDateFormatCache } from './dateFormat';
import { BASE_LANGUAGE_CODE, findLanguage, loadLanguageStrings } from './languages';

import Deferred from '../Deferred';
import LimitedMap from '../primitives/LimitedMap';

import initialStrings from '../../assets/localization/initialStrings';

const STRING_CACHE_LIMIT = 400;
const TRANSLATION_CACHE = new LimitedMap<string, string>(STRING_CACHE_LIMIT);

let language: InterfaceLanguage | undefined;
let requestedLanguageCode: string | undefined;
let formatters: LangFormatters | undefined;

// Строки выбранного языка и основного (английского): вторые показываются вместо непереведённых
let languageStrings: LanguageStrings | undefined;
let baseStrings: LanguageStrings | undefined;
let currentTimeFormat: TimeFormat = '24h';

let translationFn = createTranslationFn();

const {
  addCallback,
  removeCallback,
  runCallbacks,
} = createCallbackManager();

let areCallbacksScheduled = false;
function scheduleCallbacks() {
  if (areCallbacksScheduled) return;
  areCallbacksScheduled = true;
  fastRaf(() => {
    runCallbacks();
    areCallbacksScheduled = false;
  });
}

const localizationReady = new Deferred<void>();

export async function initLocalization(langCode: string) {
  await changeLanguage(langCode);
  // Интерфейс не ждёт строк вечно: без файла языка показываются встроенные строки входа и ключи
  localizationReady.resolve();
}

// Код не из реестра (язык убрали из сборки) заменяется основным языком
export async function changeLanguage(langCode: string) {
  const newLanguage = findLanguage(langCode) || findLanguage(BASE_LANGUAGE_CODE)!;
  if (requestedLanguageCode === newLanguage.code) return;
  requestedLanguageCode = newLanguage.code;

  let newBaseStrings: LanguageStrings;
  let newLanguageStrings: LanguageStrings;
  try {
    [newBaseStrings, newLanguageStrings] = await Promise.all([
      loadLanguageStrings(BASE_LANGUAGE_CODE),
      loadLanguageStrings(newLanguage.code),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Failed to load language strings:', err);
    // Язык остаётся прежним, повторный выбор попробует загрузить снова
    if (requestedLanguageCode === newLanguage.code) requestedLanguageCode = language?.code;
    return;
  }
  // Пока файл грузился, выбрали другой язык
  if (requestedLanguageCode !== newLanguage.code) return;

  language = newLanguage;
  baseStrings = newBaseStrings;
  languageStrings = newLanguageStrings;
  TRANSLATION_CACHE.clear();
  createFormatters();
  translationFn = createTranslationFn();
  document.documentElement.lang = newLanguage.code;

  scheduleCallbacks();
}

function createFormatters() {
  const listFormatFallback = getBasicListFormat();

  function createListFormat(lang: string, type: 'conjunction' | 'disjunction') {
    return IS_INTL_LIST_FORMAT_SUPPORTED ? new Intl.ListFormat(lang, { type }) : listFormatFallback;
  }

  function createFormattersFor(locale: string): LangFormatters {
    return {
      pluralRules: new Intl.PluralRules(locale),
      region: new Intl.DisplayNames(locale, { type: 'region' }),
      conjunction: createListFormat(locale, 'conjunction'),
      disjunction: createListFormat(locale, 'disjunction'),
      number: new Intl.NumberFormat(locale),
      preciseNumber: new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 10,
      }),
    };
  }

  try {
    formatters = createFormattersFor(getLanguageCode());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Failed to create formatters:', err);
    formatters = createFormattersFor(BASE_LANGUAGE_CODE);
  }

  resetDateFormatCache();
}

function createTranslationFn(): LangFn {
  const fn: LangFn = ((
    key: LangKey,
    variables: Record<string, unknown> | undefined,
    options: LangFnOptions | AdvancedLangFnOptions | undefined,
  ) => {
    if (options && areAdvancedLangFnOptions(options)) {
      return processTranslationAdvanced(key, variables as Record<string, TeactNode>, options);
    }
    return processTranslation(key, variables as Record<string, string | number>, options);
  }) as LangFn;
  fn.rawCode = getLanguageCode();
  fn.code = fn.rawCode;
  fn.timeFormat = currentTimeFormat;
  fn.with = ({ key, variables, options }: LangFnParameters) => {
    if (options && areAdvancedLangFnOptions(options)) {
      return processTranslationAdvanced(key, variables as Record<string, TeactNode | undefined>, options);
    }
    return processTranslation(key, variables as Record<string, LangVariable>, options);
  };
  fn.withRegular = ({ key, variables, options }: RegularLangFnParameters) => {
    return processTranslation(key, variables, options);
  };
  fn.withAdvanced = ({ key, variables, options }: AdvancedLangFnParameters) => {
    return processTranslationAdvanced(key, variables, options);
  };
  fn.region = (code: string) => formatters?.region.of(code);
  fn.conjunction = (list: string[]) => formatters?.conjunction.format(list) || list.join(', ');
  fn.disjunction = (list: string[]) => formatters?.disjunction.format(list) || list.join(', ');
  fn.number = (value: number) => formatters?.number.format(value) || String(value);
  fn.preciseNumber = (value: number) => formatters?.preciseNumber.format(value) || String(value);
  fn.internalFormatters = formatters!;
  fn.languageInfo = language || findLanguage(BASE_LANGUAGE_CODE)!;
  return fn;
}

// Мост для старого lang-провайдера и провайдера API: строка по ключу с учётом текущего языка и формы
// множественного числа, без подстановок. `shouldSkipBase` — только перевод, без запасной английской строки
export function getLangStringByKey(key: string, count = 0, shouldSkipBase?: boolean): string | undefined {
  return getString(key as LangKey, count, shouldSkipBase);
}

export function getTranslationFn(): LangFn {
  return translationFn;
}

export function setTimeFormat(timeFormat: TimeFormat) {
  if (timeFormat === currentTimeFormat) {
    return;
  }

  currentTimeFormat = timeFormat;
  resetDateFormatCache();
  translationFn = createTranslationFn();
  scheduleCallbacks();
}

function getLanguageCode() {
  return language?.code || BASE_LANGUAGE_CODE;
}

function getString(langKey: LangKey, count: number, shouldSkipBase?: boolean) {
  let stringValue = languageStrings?.[langKey];
  if (!shouldSkipBase) {
    stringValue ||= baseStrings?.[langKey];
    stringValue ||= initialStrings[langKey];
  }

  if (!stringValue || isDeletedLangString(stringValue)) return undefined;

  const pluralSuffix = formatters?.pluralRules.select(count) || 'other';

  return isPluralLangString(stringValue)
    ? (stringValue[pluralSuffix] || stringValue.other)
    : stringValue;
}

function processTranslation(
  langKey: LangKey,
  variables?: Record<string, LangVariable | RegularLangFnParameters>,
  options?: LangFnOptions | LangFnOptionsWithPlural,
): string {
  const isCacheable = !options?.withNodes;
  const cacheKey = isCacheable ? `${langKey}-${JSON.stringify(variables)}-${JSON.stringify(options)}` : undefined;
  if (cacheKey) {
    if (TRANSLATION_CACHE.has(cacheKey)) {
      return TRANSLATION_CACHE.get(cacheKey)!;
    }
  }

  const pluralValue = options && 'pluralValue' in options ? Number(options.pluralValue) : 0;
  const string = getString(langKey, pluralValue);

  if (!string) return langKey;

  const variableEntries = variables ? Object.entries(variables) : [];
  const finalString = variableEntries.reduce((result, [key, value]) => {
    if (value === undefined) return result;
    if (typeof value === 'object') { // Allow recursive variables in basic `lang.with`
      value = processTranslation(value.key, value.variables, value.options);
    }

    const valueAsString = Number.isFinite(value) ? formatters!.number.format(value as number) : String(value);
    return result.replaceAll(`{${key}}`, valueAsString);
  }, string);

  if (cacheKey) {
    TRANSLATION_CACHE.set(cacheKey, finalString);
  }

  return finalString;
}

function processTranslationAdvanced(
  langKey: LangKey,
  variables?: Record<string, TeactNode | undefined>,
  options?: AdvancedLangFnOptions | AdvancedLangFnOptionsWithPlural,
): TeactNode {
  const pluralValue = options && 'pluralValue' in options ? Number(options.pluralValue) : 0;
  const string = getString(langKey, pluralValue);
  if (!string) return langKey;

  const variableEntries = variables ? Object.entries(variables) : [];

  let tempResult: TeactNode = string;
  if (options?.specialReplacement) {
    const specialReplacements = Object.entries(options.specialReplacement);
    tempResult = specialReplacements.reduce((acc, [key, value]) => {
      return replaceInStringsWithTeact(acc, key, value);
    }, tempResult as TeactNode);
  }

  const withRenderText = options?.withNodes;

  if (withRenderText) {
    const initialFilters: TextFilter[] = options.withMarkdown ? ['simple_markdown', 'emoji'] : ['emoji'];

    const filters = unique([...initialFilters, ...options.renderTextFilters || []]);

    const tempResultArray = Array.isArray(tempResult) ? tempResult : [tempResult];
    return tempResultArray.flatMap((curr: TeactNode) => {
      if (typeof curr !== 'string') {
        return curr;
      }

      return renderText(curr, filters, {
        markdownPostProcessor: (part: string) => {
          return variableEntries.reduce((result, [key, value]): TeactNode => {
            if (value === undefined) return result;

            const preparedValue = Number.isFinite(value) ? formatters!.number.format(value as number) : value;
            return replaceInStringsWithTeact(result, `{${key}}`, renderText(preparedValue));
          }, part as TeactNode);
        },
      });
    });
  }

  return variableEntries.reduce((result, [key, value]): TeactNode => {
    if (value === undefined) return result;

    const preparedValue = Number.isFinite(value) ? formatters!.number.format(value as number) : value;
    return replaceInStringsWithTeact(result, `{${key}}`, renderText(preparedValue));
  }, tempResult);
}

export const localizationReadyPromise = localizationReady.promise;

export {
  addCallback as addLocalizationCallback,
  removeCallback as removeLocalizationCallback,
};

export type {
  LangFn,
  LangFnParameters,
  RegularLangFnParameters,
  AdvancedLangFnParameters,
};
