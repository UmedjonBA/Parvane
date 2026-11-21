import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AnimationLevel } from '../../../types';
import { SettingsScreens } from '../../../types';

import { ANIMATION_LEVEL_MAX, ANIMATION_LEVEL_MIN } from '../../../config';
import { INITIAL_PERFORMANCE_STATE_MAX, INITIAL_PERFORMANCE_STATE_MIN } from '../../../global/initialState';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import buildClassName from '../../../util/buildClassName';
import { getIsChatListDense, setChatListDense } from '../../../util/chatListDensity';

import useAppLayout from '../../../hooks/useAppLayout';
import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import PvSwitch from '../../parvane/notes/PvSwitch';
import AppearanceBackgroundRow from './profile/AppearanceBackgroundRow';
import ProfileAppearance from './profile/ProfileAppearance';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type StateProps = {
  animationLevel: AnimationLevel;
  canDisplayChatInTitle?: boolean;
};

// Parvane (spec 041 E3): «Профиль → Оформление». Телефон — доска `PhProfileA`: подпись «Режим» и сегмент во всю
// ширину, группа «Текст и чаты» (размер текста «− 15 +», фон строкой со шторкой выбора, «Анимации»). Компьютер —
// доска `DkSettingsA`: одна карточка без подписи (режим, «Размер текста 15 px − +», фон сегментом, «Анимации и
// производительность» с выключателем). Нажатие на текст строки анимаций открывает прежний подробный экран. «Название
// чата в заголовке окна» — настройка окна, перенесена сюда из «Конфиденциальности»
const SettingsAppearance = ({
  isActive, animationLevel, canDisplayChatInTitle, onReset,
}: OwnProps & StateProps) => {
  const { openSettingsScreen, setSharedSettingOption, updatePerformanceSettings } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const { isDesktop } = useAppLayout();
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

  const handleChatInTitleChange = useLastCallback((isOn: boolean) => {
    setSharedSettingOption({ canDisplayChatInTitle: isOn });
  });

  const animationsTitle = lang(isDesktop ? 'MenuAnimations' : 'MenuUIFeaturesSwitch');

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-appearance>
      <div className={styles.caption}>{lang('ParvaneColorScheme')}</div>
      <div className={styles.schemes}>
        <ProfileAppearance part="schemes" />
      </div>
      {!isDesktop && (
        <>
          <div className={styles.caption}>{lang('ParvaneAppearanceMode')}</div>
          <div className={styles.modeWide}>
            <ProfileAppearance part="mode" />
          </div>
          <div className={styles.caption}>{lang('ParvaneAppearanceTextAndChats')}</div>
        </>
      )}
      <div className={styles.group}>
        <ProfileAppearance part={isDesktop ? 'rows' : 'size'} />
        <AppearanceBackgroundRow isCompact={!isDesktop} />
        <div className={styles.setRow} data-appearance-row="animations">
          <button
            type="button"
            className={styles.setTextButton}
            data-appearance-row="performance"
            onClick={handleOpenPerformance}
          >
            <span className={styles.setTitle}>{animationsTitle}</span>
            <span className={styles.setHint}>
              {lang(isAnimated ? 'ParvaneAppearanceAnimationsOn' : 'ParvaneAppearanceAnimationsOff')}
            </span>
          </button>
          <PvSwitch isOn={isAnimated} label={animationsTitle} onChange={handleAnimationToggle} />
        </div>
        <ProfileSwitchRow
          title={lang('ParvaneAppearanceDense')}
          hint={lang('ParvaneAppearanceDenseHint')}
          isOn={isDense}
          onChange={setChatListDense}
          data-appearance-row="dense"
        />
        <ProfileSwitchRow
          title={oldLang('lng_settings_title_chat_name')}
          isOn={Boolean(canDisplayChatInTitle)}
          onChange={handleChatInTitleChange}
          data-appearance-row="title"
        />
      </div>
      <div className={styles.hint}>{lang('ParvaneAppearanceFontHint')}</div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { animationLevel, canDisplayChatInTitle } = selectSharedSettings(global);
    return { animationLevel, canDisplayChatInTitle };
  },
)(SettingsAppearance));
