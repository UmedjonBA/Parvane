import { describe, expect, it } from 'vitest';

import { buildLangPackFromText, hashLangPackText, langPackMethods } from './langPacks';
import { OLD_LANG_PACK_EN, OLD_LANG_PACK_RU } from './oldLangPack';

import enText from '../../assets/localization/fallback.strings?raw';
import ruText from '../../assets/localization/ru.strings?raw';

const PLURAL_FORMS_RU = ['one', 'few', 'many', 'other'] as const;

function placeholdersOf(text: string) {
  return new Set(text.match(/\{[A-Za-z0-9_]+\}/g) || []);
}

function oldPlaceholdersOf(value: unknown) {
  const texts = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
  return texts.map((text) => (text.match(/%(?:\d\$)?[sd@]/g) || []).length);
}

describe('Русский языковой пакет', () => {
  const en = buildLangPackFromText('en', enText);
  const ru = buildLangPackFromText('ru', ruText);

  it('содержит только ключи из английского пакета', () => {
    const unknown = Object.keys(ru.strings).filter((key) => !(key in en.strings));
    expect(unknown).toEqual([]);
  });

  it('сохраняет плейсхолдеры и полные формы множественного числа', () => {
    const problems: string[] = [];
    Object.entries(ru.strings).forEach(([key, value]) => {
      const reference = en.strings[key];
      if (typeof value === 'string') {
        const referenceText = typeof reference === 'string' ? reference : undefined;
        if (!referenceText) {
          problems.push(`${key}: в английском это plural`);
          return;
        }
        const expected = placeholdersOf(referenceText);
        const actual = placeholdersOf(value);
        if ([...expected].some((v) => !actual.has(v)) || [...actual].some((v) => !expected.has(v))) {
          problems.push(`${key}: плейсхолдеры ${[...actual].join(',')} ≠ ${[...expected].join(',')}`);
        }
        return;
      }
      if (typeof reference === 'string') {
        problems.push(`${key}: в английском это не plural`);
        return;
      }
      PLURAL_FORMS_RU.forEach((form) => {
        if (!(value as Record<string, string>)[form]) problems.push(`${key}: нет формы ${form}`);
      });
      const expected = placeholdersOf((reference as Record<string, string>).other || '');
      Object.values(value as Record<string, string>).forEach((text) => {
        const actual = placeholdersOf(text);
        // В русском «1 минуту назад» — {count} допустимо опускать только там,
        // где английская форма one тоже без него
        [...actual].forEach((v) => {
          if (!expected.has(v)) problems.push(`${key}: лишний плейсхолдер ${v}`);
        });
      });
    });
    expect(problems).toEqual([]);
  });

  it('версия пакета — детерминированный хэш файла', () => {
    expect(hashLangPackText(ruText)).toBe(ru.version);
    expect(hashLangPackText(ruText)).not.toBe(hashLangPackText(enText));
    expect(ru.version).toBeGreaterThan(0);
  });

  it('методы провайдера отдают оба языка и различие по версии', async () => {
    const languages = await langPackMethods.fetchLanguages();
    expect(languages.map((l) => l.langCode).sort()).toEqual(['en', 'ru']);
    const pack = await langPackMethods.fetchLangPack({ langPack: 'weba', langCode: 'ru' });
    expect(pack?.strings.Settings).toBe('Настройки');
    const same = await langPackMethods.fetchLangDifference({
      langPack: 'weba', langCode: 'ru', fromVersion: pack!.version,
    });
    expect(same).toBeUndefined();
    const stale = await langPackMethods.fetchLangDifference({ langPack: 'weba', langCode: 'ru', fromVersion: 1 });
    expect(stale?.version).toBe(pack!.version);
    expect(await langPackMethods.fetchLanguage({ langPack: 'weba', langCode: 'ru-RU' }))
      .toMatchObject({ langCode: 'ru' });
    expect(await langPackMethods.fetchLanguage({ langPack: 'weba', langCode: 'de' })).toBeUndefined();
  });
});

describe('Старый лангпак (useOldLang)', () => {
  it('русский словарь покрывает все английские ключи с теми же подстановками', () => {
    const missing = Object.keys(OLD_LANG_PACK_EN).filter((key) => !(key in OLD_LANG_PACK_RU));
    expect(missing).toEqual([]);
    const extra = Object.keys(OLD_LANG_PACK_RU).filter((key) => !(key in OLD_LANG_PACK_EN));
    expect(extra).toEqual([]);
    const mismatched = Object.keys(OLD_LANG_PACK_EN).filter((key) => {
      const enCounts = oldPlaceholdersOf(OLD_LANG_PACK_EN[key]);
      const ruCounts = oldPlaceholdersOf(OLD_LANG_PACK_RU[key]);
      return Math.max(...enCounts) !== Math.max(...ruCounts);
    });
    expect(mismatched).toEqual([]);
  });
});
