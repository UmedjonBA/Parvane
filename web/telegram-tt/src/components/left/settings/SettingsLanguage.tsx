import type { FC } from '../../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { SharedSettings } from '../../../global/types';
import type { LangCode } from '../../../types';

import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { oldSetLanguage } from '../../../util/oldLangProvider';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import ItemPicker, { type ItemPickerOption } from '../../common/pickers/ItemPicker';
import Island, { IslandTitle } from '../../gili/layout/Island';
import Loading from '../../ui/Loading';
import Transition from '../../ui/Transition';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = Pick<SharedSettings, 'language' | 'languages'>;

const SettingsLanguage: FC<OwnProps & StateProps> = ({
  isActive,
  languages,
  language,
  onReset,
}) => {
  const {
    loadLanguages,
    setSharedSettingOption,
  } = getActions();

  const [selectedLanguage, setSelectedLanguage] = useState<string>(language);
  const [isLoading, markIsLoading, unmarkIsLoading] = useFlag();

  const lang = useOldLang();

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
      {/* Parvane: перевод сообщений (Telegram Translate) недоступен — только выбор языка */}
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

    return {
      languages,
      language,
    };
  },
)(SettingsLanguage));
