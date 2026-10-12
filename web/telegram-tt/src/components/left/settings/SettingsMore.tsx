import type { TeactNode } from '../../../lib/teact/teact';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AnimationLevel, ThemeKey } from '../../../types';
import type { ParvaneIconName } from '../../main/ParvaneIcon';

import {
  ANIMATION_LEVEL_MAX, ANIMATION_LEVEL_MIN, BETA_CHANGELOG_URL, IS_BETA,
} from '../../../config';
import {
  INITIAL_PERFORMANCE_STATE_MAX,
  INITIAL_PERFORMANCE_STATE_MED,
  INITIAL_PERFORMANCE_STATE_MIN,
} from '../../../global/initialState';
import { selectTabState, selectTheme } from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { getPromptInstall } from '../../../util/installPrompt';
import { openBugReport } from '../../../util/parvaneDiag';
import { getSystemTheme } from '../../../util/systemTheme';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import ListItem from '../../ui/ListItem';
import Switcher from '../../ui/Switcher';
import Toggle from '../../ui/Toggle';

import styles from './SettingsMain.module.scss';

type StateProps = {
  animationLevel: AnimationLevel;
  theme: ThemeKey;
  canInstall: boolean;
};

// Parvane: прежнее подменю «Ещё» меню «☰» списка чатов — последняя карточка «Профиля»
const SettingsMore = ({ animationLevel, theme, canInstall }: StateProps) => {
  const { setSharedSettingOption, updatePerformanceSettings } = getActions();

  const lang = useLang();

  const animationLevelValue = animationLevel === ANIMATION_LEVEL_MIN ? 'min'
    : animationLevel === ANIMATION_LEVEL_MAX ? 'max' : 'mid';

  const handleDarkModeToggle = useLastCallback(() => {
    const newTheme = theme === 'light' ? 'dark' : 'light';

    setSharedSettingOption({ theme: newTheme });
    setSharedSettingOption({ shouldUseSystemTheme: newTheme === getSystemTheme() });
  });

  const handleAnimationLevelChange = useLastCallback(() => {
    const newLevel = animationLevel === ANIMATION_LEVEL_MAX ? ANIMATION_LEVEL_MIN : animationLevel + 1;
    const performanceSettings = newLevel === ANIMATION_LEVEL_MIN
      ? INITIAL_PERFORMANCE_STATE_MIN
      : (newLevel === ANIMATION_LEVEL_MAX ? INITIAL_PERFORMANCE_STATE_MAX : INITIAL_PERFORMANCE_STATE_MED);

    setSharedSettingOption({ animationLevel: newLevel as AnimationLevel, wasAnimationLevelSetManually: true });
    updatePerformanceSettings(performanceSettings);
  });

  const handleChangelogClick = useLastCallback(() => {
    window.open(BETA_CHANGELOG_URL, '_blank', 'noopener,noreferrer');
  });

  const handleInstallClick = useLastCallback(() => {
    void getPromptInstall()();
  });

  function renderRow(icon: ParvaneIconName, title: string, onClick: NoneToVoidFunction, trailing?: TeactNode) {
    return (
      <ListItem className={styles.screenRow} onClick={onClick}>
        <span className={styles.tile}><ParvaneIcon name={icon} isSmall /></span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{title}</span>
        </span>
        {trailing}
      </ListItem>
    );
  }

  return (
    <>
      <div className={styles.caption}>{lang('MenuMore')}</div>
      <div className={styles.card}>
        {renderRow('sun', lang('MenuNightMode'), handleDarkModeToggle, (
          <Switcher
            label={lang(theme === 'dark' ? 'AriaMenuDisableNightMode' : 'AriaMenuEnableNightMode')}
            checked={theme === 'dark'}
            inactive
            noAnimation
          />
        ))}
        {renderRow('sliders', lang('MenuUIFeaturesSwitch'), handleAnimationLevelChange, (
          <Toggle value={animationLevelValue} />
        ))}
        {/* Report a Bug — НАШ (`util/parvaneDiag`): описание и журнал действий уходят сообщением на адрес
            отчётов. ВРЕМЕННО */}
        {renderRow('warn', lang('MenuReportBug'), openBugReport)}
        {IS_BETA && renderRow('note', lang('MenuBetaChangelog'), handleChangelogClick)}
        {canInstall && renderRow('plus', lang('MenuInstallApp'), handleInstallClick)}
      </div>
    </>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    animationLevel: selectSharedSettings(global).animationLevel,
    theme: selectTheme(global),
    canInstall: Boolean(selectTabState(global).canInstall),
  }),
)(SettingsMore));
