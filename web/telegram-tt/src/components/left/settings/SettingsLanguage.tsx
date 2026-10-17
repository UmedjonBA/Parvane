import type { FC } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { AccountSettings, LangCode } from '../../../types';
import { SettingsScreens } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_TRANSLATION_SUPPORTED } from '../../../util/browser/windowEnvironment';
import { oldSetLanguage } from '../../../util/oldLangProvider';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ItemPicker, { type ItemPickerOption } from '../../common/pickers/ItemPicker';
import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import ListItem from '../../ui/ListItem';
import Loading from '../../ui/Loading';
import Transition from '../../ui/Transition';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<SharedSettings, 'language' | 'languages'>
  & Pick<AccountSettings, 'canTranslate' | 'doNotTranslate'>;

const SettingsLanguage: FC<OwnProps & StateProps> = ({
  isActive,
  languages,
  language,
  canTranslate,
  doNotTranslate,
  onReset,
}) => {
  const {
    loadLanguages,
    setSharedSettingOption,
    setSettingOption,
    openSettingsScreen,
  } = getActions();

  const [selectedLanguage, setSelectedLanguage] = useState<string>(language);
  const [isLoading, markIsLoading, unmarkIsLoading] = useFlag();

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

  useEffect(() => {
    if (!languages?.length) {
      loadLanguages();
    }
  }, [languages]);

  const handleChange = useLastCallback((langCode: string) => {
    setSelectedLanguage(langCode);
    markIsLoading();

    void oldSetLanguage(langCode as LangCode, () => {
      unmarkIsLoading();

      setSharedSettingOption({ language: langCode });
    });
  });

  const options = useMemo(() => {
    if (!languages) return undefined;
    const currentLangCode = (window.navigator.language || 'en').toLowerCase();
    const shortLangCode = currentLangCode.substr(0, 2);

    return languages.map(({ langCode, nativeName, name }) => ({
      value: langCode,
      label: nativeName,
      subLabel: name,
      isLoading: langCode === selectedLanguage && isLoading,
    } satisfies ItemPickerOption)).sort((a) => {
      return currentLangCode && (a.value === currentLangCode || a.value === shortLangCode) ? -1 : 0;
    });
  }, [isLoading, languages, selectedLanguage]);

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
      <Transition activeKey={options ? 1 : 0} name="fade" className="settings-language-transition">
        {options ? (
          <>
            <IslandTitle>{lang('Localization.InterfaceLanguage')}</IslandTitle>
            <Island>
              <ItemPicker
                items={options}
                selectedValue={selectedLanguage}
                forceRenderAllItems
                onSelectedValueChange={handleChange}
                itemInputType="radio"
                className="settings-picker"
              />
            </Island>
          </>
        ) : (
          <Loading />
        )}
      </Transition>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { language, languages } = selectSharedSettings(global);
    const { canTranslate, doNotTranslate } = global.settings.byKey;

    return {
      languages,
      language,
      canTranslate,
      doNotTranslate,
    };
  },
)(SettingsLanguage));
