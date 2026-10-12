import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ThemeKey } from '../../../types';

import buildClassName from '../../../util/buildClassName';
import { getSystemTheme } from '../../../util/systemTheme';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ColorSchemePicker from '../../common/ColorSchemePicker';
import Modal from '../../ui/Modal';

import styles from './SettingsAppearanceModal.module.scss';

export type AppearanceMode = 'auto' | 'light' | 'dark';

type OwnProps = {
  isOpen: boolean;
  theme: ThemeKey;
  shouldUseSystemTheme?: boolean;
  onClose: NoneToVoidFunction;
};

const MODES: AppearanceMode[] = ['auto', 'light', 'dark'];
const MODE_KEYS = {
  auto: 'ParvaneThemeSystem',
  light: 'ParvaneThemeLight',
  dark: 'ParvaneThemeDark',
} as const;

// Parvane: «Профиль → Оформление» — режим (как в системе / светлая / тёмная) и цветовая схема.
// На телефоне окно прижато к низу. Те же настройки остаются и в «Основных»
const SettingsAppearanceModal = ({
  isOpen, theme, shouldUseSystemTheme, onClose,
}: OwnProps) => {
  const { setSharedSettingOption } = getActions();

  const lang = useLang();
  const mode: AppearanceMode = shouldUseSystemTheme ? 'auto' : theme;

  const handleModeClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const value = e.currentTarget.dataset.mode as AppearanceMode;
    setSharedSettingOption({ theme: value === 'auto' ? getSystemTheme() : value });
    setSharedSettingOption({ shouldUseSystemTheme: value === 'auto' });
  });

  return (
    <Modal
      isOpen={isOpen}
      title={lang('ParvaneAppearance')}
      className={styles.root}
      hasCloseButton
      onClose={onClose}
    >
      <div className={styles.content}>
        <div className={styles.modes} role="radiogroup" aria-label={lang('Theme')}>
          {MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={value === mode}
              data-mode={value}
              className={buildClassName(styles.mode, value === mode && styles.modeActive)}
              onClick={handleModeClick}
            >
              {lang(MODE_KEYS[value])}
            </button>
          ))}
        </div>
        <div className={styles.label}>{lang('ParvaneColorScheme')}</div>
        <ColorSchemePicker theme={theme} />
        <div className={styles.hint}>{lang('ParvaneColorSchemeHint')}</div>
      </div>
    </Modal>
  );
};

export default memo(SettingsAppearanceModal);
