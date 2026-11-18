import { memo, useMemo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ThemeKey } from '../../../../types';
import type { PvSegmentItem } from '../../../parvane/notes/PvSegment';

import { selectTheme } from '../../../../global/selectors';
import { selectSharedSettings } from '../../../../global/selectors/sharedState';
import { IS_IOS } from '../../../../util/browser/windowEnvironment';
import buildClassName from '../../../../util/buildClassName';
import { getSystemTheme } from '../../../../util/systemTheme';
import { clampMessageTextSize, MESSAGE_TEXT_SIZE_MAX, MESSAGE_TEXT_SIZE_MIN } from './profileFormat';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ColorSchemePicker from '../../../common/ColorSchemePicker';
import PvSegment from '../../../parvane/notes/PvSegment';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Profile.module.scss';

export type AppearanceMode = 'auto' | 'light' | 'dark';

type OwnProps = {
  // Какую часть показать: схемы, строки «Режим» и «Размер текста» либо всё вместе (карточка «Обзора»)
  part: 'schemes' | 'rows' | 'all';
};

type StateProps = {
  theme: ThemeKey;
  shouldUseSystemTheme?: boolean;
  messageTextSize: number;
};

// Parvane (spec 041 E3): цветовая схема, режим «как в системе / светлая / тёмная» и размер текста —
// общая часть экрана «Оформление» и карточки «Обзора» (доски `PhProfileA`, `DkSettingsA`, `DeskProfile`)
const ProfileAppearance = ({
  part, theme, shouldUseSystemTheme, messageTextSize,
}: OwnProps & StateProps) => {
  const { setSharedSettingOption } = getActions();
  const lang = useLang();
  const mode: AppearanceMode = shouldUseSystemTheme ? 'auto' : theme;

  const modes = useMemo<PvSegmentItem<AppearanceMode>[]>(() => [
    { value: 'auto', label: lang('ParvaneThemeSystem') },
    { value: 'light', label: lang('ParvaneThemeLight') },
    { value: 'dark', label: lang('ParvaneThemeDark') },
  ], [lang]);

  const handleModeChange = useLastCallback((value: AppearanceMode) => {
    setSharedSettingOption({ theme: value === 'auto' ? getSystemTheme() : value });
    setSharedSettingOption({ shouldUseSystemTheme: value === 'auto' });
  });

  const handleSizeClick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const size = clampMessageTextSize(messageTextSize + Number(e.currentTarget.dataset.step));
    const root = document.documentElement;
    root.style.setProperty('--composer-text-size', `${Math.max(size, IS_IOS ? 16 : 15)}px`);
    root.style.setProperty('--message-meta-height', `${Math.floor(size * 1.25)}px`);
    root.style.setProperty('--message-text-size', `${size}px`);
    root.setAttribute('data-message-text-size', size.toString());
    setSharedSettingOption({ messageTextSize: size });
  });

  function renderStep(step: number, label: string, isDisabled: boolean) {
    return (
      <button
        type="button"
        className={buildClassName(kit.btn, styles.stepButton)}
        aria-label={label}
        data-step={step}
        disabled={isDisabled}
        onClick={handleSizeClick}
      >
        {step < 0 ? '−' : '+'}
      </button>
    );
  }

  return (
    <>
      {part === 'schemes' && <ColorSchemePicker theme={theme} />}
      {part === 'all' && <div className={styles.cardSchemes}><ColorSchemePicker theme={theme} /></div>}
      {part !== 'schemes' && (
        <>
          <div className={buildClassName(styles.setRow, styles.setRowWrap)}>
            <span className={styles.setTitle}>{lang('ParvaneAppearanceMode')}</span>
            <PvSegment
              items={modes}
              value={mode}
              label={lang('ParvaneAppearanceMode')}
              className={styles.setSegment}
              onChange={handleModeChange}
            />
          </div>
          <div className={styles.setRow} data-text-size={messageTextSize}>
            <span className={styles.setTitle}>{lang('ParvaneAppearanceTextSize')}</span>
            <span className={styles.setValue}>{`${messageTextSize} px`}</span>
            {renderStep(-1, lang('ParvaneAppearanceSmaller'), messageTextSize <= MESSAGE_TEXT_SIZE_MIN)}
            {renderStep(1, lang('ParvaneAppearanceLarger'), messageTextSize >= MESSAGE_TEXT_SIZE_MAX)}
          </div>
        </>
      )}
    </>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { shouldUseSystemTheme, messageTextSize } = selectSharedSettings(global);
    return { theme: selectTheme(global), shouldUseSystemTheme, messageTextSize };
  },
)(ProfileAppearance));
