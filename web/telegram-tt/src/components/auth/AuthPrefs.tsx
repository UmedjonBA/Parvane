import type { ChangeEvent } from 'react';
import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ThemeKey } from '../../types';

import { selectTheme } from '../../global/selectors';
import { selectSharedSettings } from '../../global/selectors/sharedState';
import buildClassName from '../../util/buildClassName';
import { LANGUAGES } from '../../util/localization/languages';
import { getSystemTheme } from '../../util/systemTheme';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import PvIcon from '../parvane/notes/PvIcon';

import styles from './Auth.module.scss';

type StateProps = {
  language: string;
  theme: ThemeKey;
  shouldUseSystemTheme?: boolean;
};

type ThemeMode = 'auto' | ThemeKey;

// Под формой входа: язык интерфейса, тема и страница приложения для телефона — настройки устройства,
// доступные до входа. Выбранный пункт помечается сам: значение списка, заданное раньше появления пунктов,
// не применяется
const AuthPrefs = ({ language, theme, shouldUseSystemTheme }: StateProps) => {
  const { setSharedSettingOption } = getActions();
  const lang = useLang();
  const mode: ThemeMode = shouldUseSystemTheme ? 'auto' : theme;

  const handleLanguageChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setSharedSettingOption({ language: e.target.value });
  });

  const handleThemeChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as ThemeMode;
    setSharedSettingOption({ theme: value === 'auto' ? getSystemTheme() : value });
    setSharedSettingOption({ shouldUseSystemTheme: value === 'auto' });
  });

  return (
    <div className={styles.prefs}>
      <select
        id="auth-language"
        className={styles.select}
        aria-label={lang('Language')}
        onChange={handleLanguageChange}
      >
        {LANGUAGES.map(({ code, nativeName }) => (
          <option key={code} value={code} selected={code === language}>{nativeName}</option>
        ))}
      </select>
      <select
        id="auth-theme"
        className={styles.select}
        aria-label={lang('Theme')}
        onChange={handleThemeChange}
      >
        <option value="auto" selected={mode === 'auto'}>{lang('ParvaneThemeSystem')}</option>
        <option value="light" selected={mode === 'light'}>{lang('ParvaneThemeLight')}</option>
        <option value="dark" selected={mode === 'dark'}>{lang('ParvaneThemeDark')}</option>
      </select>
      <a
        id="auth-app-download"
        className={buildClassName(styles.chip, styles.prefsLink)}
        href="./download"
        title={lang('ParvaneAppDownloadHint')}
      >
        <PvIcon name="download" isSmall />
        {lang('ParvaneAppDownload')}
      </a>
    </div>
  );
};

export default memo(withGlobal((global): Complete<StateProps> => {
  const { language, shouldUseSystemTheme } = selectSharedSettings(global);
  return { language, theme: selectTheme(global), shouldUseSystemTheme };
})(AuthPrefs));
