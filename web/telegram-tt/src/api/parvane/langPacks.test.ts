import { describe, expect, it } from 'vitest';

import { parseLanguageStrings } from '../../util/localization/languages';
import { buildOldLangPack, OLD_LANG_PACK_EN, OLD_LANG_PACK_RU } from './oldLangPack';

import enText from '../../assets/localization/fallback.strings?raw';
import ruText from '../../assets/localization/ru.strings?raw';

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

function oldPlaceholdersOf(value: unknown) {
  const texts = typeof value === 'string' ? [value] : Object.values(value as Record<string, string>);
  return texts.map((text) => (text.match(/%(?:\d\$)?[sd@]/g) || []).length);
}

// Общая сверка языков с базой (лишние ключи, переменные, формы числа) — `util/localization/languages.test.ts`
describe('Русский языковой пакет', () => {
  const en = parseLanguageStrings(enText);
  const ru = parseLanguageStrings(ruText);

  it('переводит все собственные ключи форка (ни одного EN-only)', () => {
    const forkKeysEn = Object.keys(en).filter(isForkKey);
    // Набор не должен опустеть от опечатки в префиксах — иначе тест ничего не проверяет
    expect(forkKeysEn.length).toBeGreaterThan(30);
    const untranslated = forkKeysEn.filter((key) => !(key in ru));
    expect(untranslated).toEqual([]);
  });
});

describe('Перевод экранов настроек', () => {
  const en = parseLanguageStrings(enText);
  const ru = parseLanguageStrings(ruText);

  it('не оставляет английских строк', () => {
    const sources = Object.entries(SETTINGS_SOURCES).filter(([path]) => !EXCLUDED_SETTINGS_FILES.test(path));
    expect(sources.length).toBeGreaterThan(30);
    const untranslated = new Set<string>();
    sources.forEach(([, source]) => {
      (source.match(/'[A-Za-z][A-Za-z0-9_.]*'/g) || []).forEach((literal) => {
        const key = literal.slice(1, -1);
        if (key in en && !(key in ru) && !EXCLUDED_SETTINGS_KEYS.has(key)) untranslated.add(key);
      });
    });
    expect([...untranslated].sort()).toEqual([]);
  });

  it('заглушка неподдерживаемого сообщения не советует обновить приложение', () => {
    expect(en.MessageUnsupported).toMatch(/not supported in this version of Parvane/);
    expect(en.MessageUnsupported).not.toMatch(/update/i);
    expect(ru.MessageUnsupported).toMatch(/в этой версии Parvane/);
    expect(ru.MessageUnsupported).not.toMatch(/обновите/i);
  });
});

describe('Старый лангпак (useOldLang)', () => {
  it('несёт дни недели и месяцы календаря на обоих языках', () => {
    const ru = buildOldLangPack('ru');
    const en = buildOldLangPack('en');
    // Язык без своего словаря получает только имена дней и месяцев — остальное берётся из его файла строк
    expect(Object.keys(buildOldLangPack('de')).some((key) => key in OLD_LANG_PACK_EN)).toBe(false);
    expect(buildOldLangPack('de').lng_month10).toBe('Oktober');
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
