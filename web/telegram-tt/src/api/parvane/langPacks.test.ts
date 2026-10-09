import { describe, expect, it } from 'vitest';

import { buildLangPackFromText, hashLangPackText, langPackMethods } from './langPacks';
import { buildOldLangPack, OLD_LANG_PACK_EN, OLD_LANG_PACK_RU } from './oldLangPack';

import enText from '../../assets/localization/fallback.strings?raw';
import ruText from '../../assets/localization/ru.strings?raw';

const PLURAL_FORMS_RU = ['one', 'few', 'many', 'other'] as const;

// Собственные ключи форка: их пишем сами, значит перевод обязателен в обе
// стороны. Остальной `fallback.strings` — снимок Web A, переведён частично,
// поэтому полное совпадение наборов требовать нельзя
const FORK_KEY_PREFIXES = ['Parvane', 'ProfileBirthday'];
const FORK_KEYS = [
  'SettingsBirthday', 'BirthdaySetupTitle', 'BirthdayInputDay', 'BirthdayInputMonth', 'BirthdayInputYear',
  'BirthdayRemove',
];

function isForkKey(key: string) {
  return FORK_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) || FORK_KEYS.includes(key);
}

// Экраны настроек: каждая строка, которую они называют, обязана быть переведена.
// Исходники читаем как текст — ключи лежат и в вызовах `lang('Key')`, и в константах
const SETTINGS_SOURCES = import.meta.glob<string>('../../components/left/settings/**/*.tsx', {
  query: '?raw', import: 'default', eager: true,
});
// Экраны функций, которых в Parvane нет (подарки, passkey Telegram, сайты ботов)
const EXCLUDED_SETTINGS_FILES
  = /(SettingsAcceptedGift|SettingsPasskeys|SettingsActiveWebsites?|PremiumStatusItem)\.tsx$/;
// Строки тех же функций на общих экранах — не показываются
const EXCLUDED_SETTINGS_KEYS = new Set([
  'ExceptionTitlePrivacyChargeForMessages', 'PrivacyChargeForMessages', 'PrivacyDescriptionChargeForMessages',
  'PrivacyDescriptionMessagesContactsAndPremium', 'RemoveFeeTitle', 'PrivacyDisplayGift',
  'PrivacyDisplayGiftIconInChats', 'PrivacyDisplayGiftsButton', 'PrivacyGifts', 'PrivacyGiftsInfo',
  'PrivacyGiftsTitle', 'PrivacyValueBots', 'PrivacySubscribeToTelegramPremium', 'SettingsPasskeyTitle',
]);

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

  it('переводит все собственные ключи форка (ни одного EN-only)', () => {
    const forkKeysEn = Object.keys(en.strings).filter(isForkKey);
    // Набор не должен опустеть от опечатки в префиксах — иначе тест ничего не проверяет
    expect(forkKeysEn.length).toBeGreaterThan(30);
    const untranslated = forkKeysEn.filter((key) => !(key in ru.strings));
    expect(untranslated).toEqual([]);
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

describe('Перевод экранов настроек', () => {
  const en = buildLangPackFromText('en', enText);
  const ru = buildLangPackFromText('ru', ruText);

  it('не оставляет английских строк', () => {
    const sources = Object.entries(SETTINGS_SOURCES).filter(([path]) => !EXCLUDED_SETTINGS_FILES.test(path));
    expect(sources.length).toBeGreaterThan(30);
    const untranslated = new Set<string>();
    sources.forEach(([, source]) => {
      (source.match(/'[A-Za-z][A-Za-z0-9_.]*'/g) || []).forEach((literal) => {
        const key = literal.slice(1, -1);
        if (key in en.strings && !(key in ru.strings) && !EXCLUDED_SETTINGS_KEYS.has(key)) untranslated.add(key);
      });
    });
    expect([...untranslated].sort()).toEqual([]);
  });

  it('заглушка неподдерживаемого сообщения не советует обновить приложение', () => {
    expect(en.strings.MessageUnsupported).toMatch(/not supported in this version of Parvane/);
    expect(en.strings.MessageUnsupported).not.toMatch(/update/i);
    expect(ru.strings.MessageUnsupported).toMatch(/в этой версии Parvane/);
    expect(ru.strings.MessageUnsupported).not.toMatch(/обновите/i);
  });
});

describe('Старый лангпак (useOldLang)', () => {
  it('несёт дни недели и месяцы календаря на обоих языках', () => {
    const ru = buildOldLangPack('ru');
    const en = buildOldLangPack('en');
    for (let day = 1; day <= 7; day++) {
      expect(ru[`lng_weekday${day}`]).toBeTruthy();
      expect(en[`lng_weekday${day}`]).toBeTruthy();
    }
    for (let month = 1; month <= 12; month++) {
      expect(ru[`lng_month${month}`]).toBeTruthy();
      expect(en[`lng_month${month}`]).toBeTruthy();
    }
    expect(en.lng_weekday1).toBe('Mon');
    expect(en.lng_weekday7).toBe('Sun');
    expect(ru.lng_weekday1).toBe('Пн');
    expect(ru.lng_month10).toBe('Октябрь');
    expect(en.lng_month10).toBe('October');
  });

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
