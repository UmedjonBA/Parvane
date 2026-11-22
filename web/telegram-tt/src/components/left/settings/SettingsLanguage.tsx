import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { AccountSettings, TimeFormat } from '../../../types';
import type { FirstWeekday } from '../../../util/weekStart';
import { SettingsScreens } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_TRANSLATION_SUPPORTED } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import {
  getIsSpellcheckOn, getIsSystemLanguage, setIsSystemLanguage, setSpellcheckOn,
} from '../../../util/languagePrefs';
import { findLanguage, getBrowserLanguageCode, LANGUAGES } from '../../../util/localization/languages';
import { FIRST_WEEKDAYS, getFirstWeekday, setFirstWeekday } from '../../../util/weekStart';

import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ItemPicker, { type ItemPickerOption } from '../../common/pickers/ItemPicker';
import Island, { IslandDescription } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import ProfileChoiceSheet from './profile/ProfileChoiceSheet';
import ProfileIcon from './profile/ProfileIcon';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<SharedSettings, 'language' | 'timeFormat'>
  & Pick<AccountSettings, 'canTranslate' | 'doNotTranslate'>;

type Sheet = 'time' | 'week';

const SYSTEM_VALUE = 'system';
const WEEKDAY_TITLES = {
  1: 'ParvaneWeekStartMonday',
  0: 'ParvaneWeekStartSunday',
  6: 'ParvaneWeekStartSaturday',
} as const satisfies Record<FirstWeekday, string>;

// Parvane (доски `RpProfileA`, `ZdProfileX`): «Профиль → Язык». «Язык интерфейса» — «Как в системе · сейчас: …» и
// языки реестра; «Форматы» — время 12 / 24 часа и первый день недели (строки со шторкой выбора), единицы (только
// метрические: разбор записей «Здоровья» движком понимает килограммы и сантиметры), проверка орфографии. Ниже —
// перевод встроенным переводчиком браузера (spec 024): текст не уходит в сеть
const SettingsLanguage = ({
  isActive,
  language,
  timeFormat,
  canTranslate,
  doNotTranslate,
  onReset,
}: OwnProps & StateProps) => {
  const {
    setSharedSettingOption,
    setSettingOption,
    openSettingsScreen,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();
  const [isSystem, setIsSystem] = useState(getIsSystemLanguage);
  const [isSpellcheckOn, setIsSpellcheckOn] = useState(getIsSpellcheckOn);
  const [sheet, setSheet] = useState<Sheet>();
  const firstWeekday = useDerivedState(getFirstWeekday);

  useHistoryBack({ isActive, onBack: onReset });

  const handleShouldTranslateChange = useLastCallback((newValue: boolean) => {
    setSettingOption({ canTranslate: newValue });
  });

  const handleDoNotSelectOpen = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.DoNotTranslate });
  });

  const doNotTranslateText = useMemo(() => {
    if (!IS_TRANSLATION_SUPPORTED || !doNotTranslate.length) return undefined;
    if (doNotTranslate.length === 1) {
      return new Intl.DisplayNames([language], { type: 'language' }).of(doNotTranslate[0]);
    }
    return oldLang('Languages', doNotTranslate.length);
  }, [doNotTranslate, oldLang, language]);

  // Строки нового языка подгружает обработчик смены настройки (`changeLanguage`)
  const handleChange = useLastCallback((value: string) => {
    const isSystemValue = value === SYSTEM_VALUE;
    setIsSystemLanguage(isSystemValue);
    setIsSystem(isSystemValue);
    if (!isSystemValue) setSharedSettingOption({ language: value });
  });

  const options = useMemo(() => {
    const names = new Intl.DisplayNames([lang.code], { type: 'language' });
    // Имя языка системы — на языке интерфейса и в его регистре: «English», «английский»
    const systemCode = findLanguage(getBrowserLanguageCode())?.code;
    const systemName = systemCode ? names.of(systemCode) || '' : '';
    return [
      {
        value: SYSTEM_VALUE,
        label: lang('ParvaneLanguageSystem'),
        subLabel: lang('ParvaneLanguageSystemNow', { language: systemName }),
      },
      ...LANGUAGES.map(({ code, nativeName }) => ({
        value: code,
        label: nativeName,
        subLabel: names.of(code) || code,
      })),
    ] satisfies ItemPickerOption[];
  }, [lang]);

  const handleSelect = useLastCallback((value: string) => {
    if (sheet === 'time') {
      setSharedSettingOption({ timeFormat: value as TimeFormat, wasTimeFormatSetManually: true });
    } else {
      setFirstWeekday(Number(value) as FirstWeekday);
    }
  });

  const handleSpellcheck = useLastCallback((isOn: boolean) => {
    setSpellcheckOn(isOn);
    setIsSpellcheckOn(isOn);
  });

  const closeSheet = useLastCallback(() => setSheet(undefined));

  const sheetOptions = useMemo(() => (sheet === 'time'
    ? [
      { value: '24h', label: lang('SettingsTimeFormat24') },
      { value: '12h', label: lang('SettingsTimeFormat12') },
    ]
    : FIRST_WEEKDAYS.map((day) => ({ value: String(day), label: lang(WEEKDAY_TITLES[day]) }))), [sheet, lang]);

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <div className={buildClassName('settings-content settings-language custom-scroll', styles.screen)}>
      <div className={styles.caption}>{oldLang('Localization.InterfaceLanguage')}</div>
      <div className={styles.hint}>{lang('ParvaneLanguageInstant')}</div>
      <Island>
        <ItemPicker
          items={options}
          selectedValue={isSystem ? SYSTEM_VALUE : language}
          forceRenderAllItems
          onSelectedValueChange={handleChange}
          itemInputType="radio"
          className="settings-picker"
        />
      </Island>
      <div className={styles.hint}>{lang('ParvaneLanguageModulesHint')}</div>

      <div className={styles.caption}>{lang('ParvaneLanguageFormat')}</div>
      <div className={styles.group}>
        <button
          type="button"
          className={rowClass}
          data-language-time-format={timeFormat}
          onClick={() => setSheet('time')}
        >
          <span className={styles.setTitle}>{lang('ParvaneLanguageTime')}</span>
          <span className={styles.menuValue}>
            {lang(timeFormat === '12h' ? 'SettingsTimeFormat12' : 'SettingsTimeFormat24')}
          </span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <button
          type="button"
          className={rowClass}
          data-language-week-start={firstWeekday}
          onClick={() => setSheet('week')}
        >
          <span className={styles.setTitle}>{lang('ParvaneLanguageWeekStart')}</span>
          <span className={styles.menuValue}>{lang(WEEKDAY_TITLES[firstWeekday])}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <div className={styles.setRow} data-language-units>
          <span className={styles.setTitle}>{lang('ParvaneLanguageUnits')}</span>
          <span className={styles.menuValue}>{lang('ParvaneLanguageUnitsMetric')}</span>
        </div>
        <ProfileSwitchRow
          title={lang('ParvaneLanguageSpellcheck')}
          isOn={isSpellcheckOn}
          onChange={handleSpellcheck}
          data-language-spellcheck
        />
      </div>
      <div className={styles.hint}>{lang('ParvaneLanguageInputHint')}</div>

      {/* Parvane: перевод только встроенным переводчиком браузера (spec 024) — текст не уходит в сеть */}
      <div className={styles.caption}>{lang('ParvaneLanguageTranslate')}</div>
      {IS_TRANSLATION_SUPPORTED ? (
        <>
          <Island>
            <Checkbox
              label={oldLang('ShowTranslateButton')}
              checked={canTranslate}
              onCheck={handleShouldTranslateChange}
            />
            {canTranslate && (
              <ListItem narrow onClick={handleDoNotSelectOpen}>
                {oldLang('DoNotTranslate')}
                <span className="settings-item__current-value">{doNotTranslateText}</span>
              </ListItem>
            )}
          </Island>
          <IslandDescription>{lang('ParvaneTranslateAbout')}</IslandDescription>
        </>
      ) : (
        <IslandDescription>{lang('ParvaneTranslateUnavailable')}</IslandDescription>
      )}

      <ProfileChoiceSheet
        isOpen={Boolean(sheet)}
        title={lang(sheet === 'week' ? 'ParvaneLanguageWeekStart' : 'ParvaneLanguageTime')}
        options={sheetOptions}
        selected={sheet === 'week' ? String(firstWeekday) : timeFormat}
        onSelect={handleSelect}
        onClose={closeSheet}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { language, timeFormat } = selectSharedSettings(global);
    const { canTranslate, doNotTranslate } = global.settings.byKey;

    return {
      language,
      timeFormat,
      canTranslate,
      doNotTranslate,
    };
  },
)(SettingsLanguage));
