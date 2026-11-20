import type { FC } from '../../../lib/teact/teact';
import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { AccountSettings, TimeFormat } from '../../../types';
import type { IRadioOption } from '../../ui/RadioGroup';
import { SettingsScreens } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_TRANSLATION_SUPPORTED } from '../../../util/browser/windowEnvironment';
import { LANGUAGES } from '../../../util/localization/languages';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ItemPicker, { type ItemPickerOption } from '../../common/pickers/ItemPicker';
import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<SharedSettings, 'language' | 'timeFormat'>
  & Pick<AccountSettings, 'canTranslate' | 'doNotTranslate'>;

const SettingsLanguage: FC<OwnProps & StateProps> = ({
  isActive,
  language,
  timeFormat,
  canTranslate,
  doNotTranslate,
  onReset,
}) => {
  const {
    setSharedSettingOption,
    setSettingOption,
    openSettingsScreen,
  } = getActions();

  const lang = useOldLang();
  const newLang = useLang();

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
    return lang('Languages', doNotTranslate.length);
  }, [doNotTranslate, lang, language]);

  // Строки нового языка подгружает обработчик смены настройки (`changeLanguage`)
  const handleChange = useLastCallback((langCode: string) => {
    setSharedSettingOption({ language: langCode });
  });

  // Parvane (spec 041, доска `RpProfileA`): «Формат» — время 12 / 24 часа (прежде в «Настройках мессенджера»).
  // Первого дня недели и единиц на доске нет функции: неделя «Плана» всегда с понедельника, единицы — метрические
  const timeFormatOptions: IRadioOption[] = useMemo(() => [
    { label: newLang('SettingsTimeFormat24'), value: '24h' },
    { label: newLang('SettingsTimeFormat12'), value: '12h' },
  ], [newLang]);

  const handleTimeFormatChange = useLastCallback((newTimeFormat: string) => {
    setSharedSettingOption({ timeFormat: newTimeFormat as TimeFormat });
    setSharedSettingOption({ wasTimeFormatSetManually: true });
  });

  const options = useMemo(() => LANGUAGES.map(({ code, nativeName, name }) => ({
    value: code,
    label: nativeName,
    subLabel: name,
  } satisfies ItemPickerOption)), []);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  return (
    <div className="settings-content settings-language custom-scroll">
      {/* Parvane: перевод только встроенным переводчиком браузера (spec 024) — текст не уходит в сеть */}
      {IS_TRANSLATION_SUPPORTED ? (
        <>
          <Island>
            <Checkbox
              label={lang('ShowTranslateButton')}
              checked={canTranslate}
              onCheck={handleShouldTranslateChange}
            />
            {canTranslate && (
              <ListItem narrow onClick={handleDoNotSelectOpen}>
                {lang('DoNotTranslate')}
                <span className="settings-item__current-value">{doNotTranslateText}</span>
              </ListItem>
            )}
          </Island>
          <IslandDescription>{newLang('ParvaneTranslateAbout')}</IslandDescription>
        </>
      ) : (
        <IslandDescription>{newLang('ParvaneTranslateUnavailable')}</IslandDescription>
      )}
      <IslandTitle>{lang('Localization.InterfaceLanguage')}</IslandTitle>
      <Island>
        <ItemPicker
          items={options}
          selectedValue={language}
          forceRenderAllItems
          onSelectedValueChange={handleChange}
          itemInputType="radio"
          className="settings-picker"
        />
      </Island>
      <IslandTitle>{newLang('ParvaneLanguageFormat')}</IslandTitle>
      <Island>
        <div data-language-time-format>
          <RadioGroup
            name="language-time-format"
            options={timeFormatOptions}
            selected={timeFormat}
            onChange={handleTimeFormatChange}
          />
        </div>
      </Island>
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
