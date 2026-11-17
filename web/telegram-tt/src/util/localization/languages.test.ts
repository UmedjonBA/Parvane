import { describe, expect, it } from 'vitest';

import type { LangPackStringValue } from '../../api/types';

import { OLD_LANG_PACK_EN } from '../../api/parvane/oldLangPack';
import {
  BASE_LANGUAGE_CODE, getStringsFileName, LANGUAGES, parseLanguageStrings, pickLanguageCode,
} from './languages';

// Сверка каждого языка реестра с основным (английским) файлом строк. Отсутствующий ключ — не ошибка
// (показывается английская строка), его число печатается; лишний ключ и расхождение переменных — ошибка

const STRING_FILES = import.meta.glob<string>('../../assets/localization/*.strings', {
  query: '?raw', import: 'default', eager: true,
});
// Языки с письмом справа налево не поддерживаются
const RTL_LANGUAGE_CODES = new Set([
  'ar', 'arc', 'ckb', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ps', 'sd', 'ug', 'ur', 'yi',
]);

const base = readLanguage(BASE_LANGUAGE_CODE);
const translations = LANGUAGES.filter(({ code }) => code !== BASE_LANGUAGE_CODE);

function readLanguage(code: string) {
  return parseLanguageStrings(STRING_FILES[`../../assets/localization/${getStringsFileName(code)}`]);
}

function listVariables(text: string) {
  return [...new Set(text.match(/\{[A-Za-z0-9_]+\}/g) || [])].sort();
}

// Переменные значения: у форм множественного числа — объединение по всем формам
function listValueVariables(value: LangPackStringValue) {
  const texts = typeof value === 'string' ? [value] : Object.values(value) as string[];
  return [...new Set(texts.flatMap(listVariables))].sort();
}

// Число позиционных подстановок (`%@`, `%1$s`) в строке старого ключа
function countOldPlaceholders(value: unknown) {
  const texts = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
  return Math.max(...texts.map((text) => (text.match(/%(?:\d\$)?[sd@]/g) || []).length));
}

describe('Реестр языков интерфейса', () => {
  it('совпадает с файлами строк: у каждого языка свой файл, лишних файлов нет', () => {
    const expectedFiles = LANGUAGES.map(({ code }) => `../../assets/localization/${getStringsFileName(code)}`);
    expect(Object.keys(STRING_FILES).sort()).toEqual(expectedFiles.sort());
  });

  it('начинается с основного языка, коды уникальны, письма справа налево нет', () => {
    const codes = LANGUAGES.map(({ code }) => code);
    expect(codes[0]).toBe(BASE_LANGUAGE_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    codes.forEach((code) => {
      expect(code).toBe(code.toLowerCase());
      expect(RTL_LANGUAGE_CODES.has(code.split('-')[0])).toBe(false);
      // Код обязан быть понятен `Intl`: по нему выбираются формы числа и форматы дат
      expect(Intl.PluralRules.supportedLocalesOf(code)).toHaveLength(1);
    });
    LANGUAGES.forEach(({ nativeName, name }) => {
      expect(nativeName).toBeTruthy();
      expect(name).toBeTruthy();
    });
  });

  it('язык при первом запуске — язык браузера из реестра, иначе основной', () => {
    expect(pickLanguageCode(['ru-RU', 'en-US'])).toBe('ru');
    expect(pickLanguageCode(['ru'])).toBe('ru');
    expect(pickLanguageCode(['RU_ru'])).toBe('ru');
    expect(pickLanguageCode(['en-GB'])).toBe(BASE_LANGUAGE_CODE);
    // Первый язык предпочтений, которого нет в реестре, пропускается
    expect(pickLanguageCode(['xx-XX', 'ru-RU'])).toBe('ru');
    expect(pickLanguageCode(['xx-XX'])).toBe(BASE_LANGUAGE_CODE);
    expect(pickLanguageCode([])).toBe(BASE_LANGUAGE_CODE);
    expect(pickLanguageCode([''])).toBe(BASE_LANGUAGE_CODE);
  });
});

describe.each(translations)('Полнота языка $code', ({ code }) => {
  const strings = readLanguage(code);
  const keys = Object.keys(strings);
  // Старые ключи (`useOldLang`) в базе могут отсутствовать: их основа — английский словарь `oldLangPack.ts`
  const extraKeys = keys.filter((key) => !(key in base) && !(key in OLD_LANG_PACK_EN));

  it('не содержит лишних ключей', () => {
    const missingCount = Object.keys(base).filter((key) => !(key in strings)).length;
    // eslint-disable-next-line no-console
    console.info(
      `[язык ${code}] ключей базы: ${Object.keys(base).length}, переведено: ${keys.length - extraKeys.length}, `
      + `отсутствует (показывается английский): ${missingCount}, лишних: ${extraKeys.length}`,
    );
    expect(extraKeys).toEqual([]);
  });

  it('сохраняет переменные базы и вид строки', () => {
    const problems: string[] = [];
    keys.forEach((key) => {
      const value = strings[key];
      const baseValue = base[key];
      if (baseValue === undefined) {
        const oldValue = OLD_LANG_PACK_EN[key];
        if (oldValue && countOldPlaceholders(value) !== countOldPlaceholders(oldValue)) {
          problems.push(`${key}: число подстановок старого ключа не совпадает с английским`);
        }
        return;
      }
      if ((typeof value === 'string') !== (typeof baseValue === 'string')) {
        problems.push(`${key}: в базе это ${typeof baseValue === 'string' ? 'обычная строка' : 'формы числа'}`);
        return;
      }
      const variables = listValueVariables(value);
      const baseVariables = listValueVariables(baseValue);
      if (variables.join() !== baseVariables.join()) {
        problems.push(`${key}: переменные ${variables.join(',') || '—'} ≠ ${baseVariables.join(',') || '—'}`);
      }
    });
    expect(problems).toEqual([]);
  });

  it('даёт все формы множественного числа своего языка', () => {
    const requiredForms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    const problems: string[] = [];
    Object.entries(strings).forEach(([key, value]) => {
      if (typeof value === 'string') return;
      const forms: Partial<Record<string, string>> = value;
      requiredForms.forEach((form) => {
        if (!forms[form]) problems.push(`${key}: нет формы ${form}`);
      });
    });
    expect(problems).toEqual([]);
  });
});
