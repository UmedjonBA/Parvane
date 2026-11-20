import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AnimationLevel } from '../../../types';
import { SettingsScreens } from '../../../types';

import { ANIMATION_LEVEL_MAX, ANIMATION_LEVEL_MIN } from '../../../config';
import { INITIAL_PERFORMANCE_STATE_MAX, INITIAL_PERFORMANCE_STATE_MIN } from '../../../global/initialState';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import buildClassName from '../../../util/buildClassName';
import { getIsChatListDense, setChatListDense } from '../../../util/chatListDensity';

import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSwitch from '../../parvane/notes/PvSwitch';
import AppearanceBackgroundRow from './profile/AppearanceBackgroundRow';
import ProfileAppearance from './profile/ProfileAppearance';
import ProfileIcon from './profile/ProfileIcon';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type StateProps = {
  animationLevel: AnimationLevel;
};

// Parvane (spec 041 E3): «Профиль → Оформление» (доски `PhProfileA`, `DkSettingsA`) — схема, режим, размер
// текста, фон чатов и анимации. Подробные выключатели анимаций — прежний экран «Анимации и производительность»
const SettingsAppearance = ({ isActive, animationLevel, onReset }: OwnProps & StateProps) => {
  const { openSettingsScreen, setSharedSettingOption, updatePerformanceSettings } = getActions();
  const lang = useLang();
  const isAnimated = animationLevel !== ANIMATION_LEVEL_MIN;
  const isDense = useDerivedState(getIsChatListDense);

  useHistoryBack({ isActive, onBack: onReset });

  const handleAnimationToggle = useLastCallback(() => {
    const level = isAnimated ? ANIMATION_LEVEL_MIN : ANIMATION_LEVEL_MAX;
    setSharedSettingOption({ animationLevel: level as AnimationLevel, wasAnimationLevelSetManually: true });
    updatePerformanceSettings(isAnimated ? INITIAL_PERFORMANCE_STATE_MIN : INITIAL_PERFORMANCE_STATE_MAX);
  });

  const handleOpenPerformance = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.Performance });
  });

  const rowClass = buildClassName(styles.setRow, styles.setRowAction);

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-appearance>
      <div className={styles.caption}>{lang('ParvaneColorScheme')}</div>
      <div className={styles.schemes}>
        <ProfileAppearance part="schemes" />
      </div>
      <div className={styles.caption}>{lang('ParvaneAppearanceTextAndChats')}</div>
      <div className={styles.group}>
        <ProfileAppearance part="rows" />
        <AppearanceBackgroundRow />
        <div className={styles.setRow}>
          <span className={styles.setText}>
            <span className={styles.setTitle}>{lang('MenuUIFeaturesSwitch')}</span>
            <span className={styles.setHint}>
              {lang(isAnimated ? 'ParvaneAppearanceAnimationsOn' : 'ParvaneAppearanceAnimationsOff')}
            </span>
          </span>
          <PvSwitch isOn={isAnimated} label={lang('MenuUIFeaturesSwitch')} onChange={handleAnimationToggle} />
        </div>
        <button type="button" className={rowClass} data-appearance-row="performance" onClick={handleOpenPerformance}>
          <span className={styles.setTitle}>{lang('MenuAnimations')}</span>
          <ProfileIcon name="right" isSmall className={styles.menuChevron} />
        </button>
        <ProfileSwitchRow
          title={lang('ParvaneAppearanceDense')}
          hint={lang('ParvaneAppearanceDenseHint')}
          isOn={isDense}
          onChange={setChatListDense}
          data-appearance-row="dense"
        />
      </div>
      <div className={styles.hint}>{lang('ParvaneAppearanceFontHint')}</div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({ animationLevel: selectSharedSettings(global).animationLevel }),
)(SettingsAppearance));
