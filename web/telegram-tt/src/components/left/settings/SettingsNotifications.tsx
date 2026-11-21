import { memo, useEffect } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiNotifyPeerType, ApiPeerNotifySettings } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import {
  checkIfNotificationsSupported,
  checkIfOfflinePushFailed,
  playNotifySound,
} from '../../../util/notifications';
import { getNotifyPrefs, setNotifyModuleOn, updateNotifyPrefs } from '../../../util/notifyPrefs';
import { showPermissionDenied } from '../../../util/permissionPrompt';
import { buildMuteUntil } from '../../../util/systemNotify';
import { getHealthDays, watchHealthDays } from '../../parvane/health/healthStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useParvaneModules from '../../../hooks/useParvaneModules';
import useRunDebounced from '../../../hooks/useRunDebounced';

import RangeSlider from '../../ui/RangeSlider';
import ProfileSwitchRow from './profile/ProfileSwitchRow';

import styles from './profile/Profile.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  notifyDefaults?: Record<ApiNotifyPeerType, ApiPeerNotifySettings>;
  shouldNotifyAboutPinnedMessages: boolean;
  hasWebNotifications: boolean;
  hasPushNotifications: boolean;
  notificationSoundVolume: number;
};

const PEER_TYPES: ApiNotifyPeerType[] = ['users', 'groups', 'channels'];
const PEER_TYPE_TITLES = {
  users: 'NotificationsForPrivateChats',
  groups: 'NotificationsForGroups',
  channels: 'NotificationsForChannels',
} as const satisfies Record<ApiNotifyPeerType, string>;
// Громкость, с которой звук включается снова (как у новой установки)
const DEFAULT_SOUND_VOLUME = 5;
const MINUTES_IN_HOUR = 60;

// Parvane (spec 041 E3): «Профиль → Уведомления» по доскам `PhProfileA`, `DkSettingsB`. Выключатели по модулям и
// «Не беспокоить» — настройка устройства (`util/notifyPrefs.ts`), действуют и в service worker; показ текста, звук
// и типы чатов — прежние настройки (`notifyDefaults`, `settings.byKey`). «Здоровье» — напоминание об отбое (включается в
// «Целях здоровья»), «Файлы» — приглашение в общую папку и ссылка «Файлов» в чате, «Музыка» — «Трек скачан на
// сервер». «Не беспокоить» по умолчанию следует режиму сна из «Здоровья», пока часы не заданы вручную.
// «Не беспокоить 1 час / до утра» — пункты меню значка в трее с доски `ZdMisc` (трея у браузера нет)
const SettingsNotifications = ({
  isActive,
  onReset,
  notifyDefaults,
  shouldNotifyAboutPinnedMessages,
  hasPushNotifications,
  hasWebNotifications,
  notificationSoundVolume,
}: OwnProps & StateProps) => {
  const {
    loadNotificationSettings,
    setSettingOption,
    updateNotificationSettings,
    updateWebNotificationSettings,
  } = getActions();

  const lang = useLang();
  const prefs = useDerivedState(getNotifyPrefs);
  const { enabled } = useParvaneModules();
  const healthDays = useDerivedState(getHealthDays);
  const sleepBed = healthDays?.goals?.sleep_bed;
  const sleepWake = healthDays?.goals?.sleep_wake;

  useEffect(() => {
    loadNotificationSettings();
  }, [loadNotificationSettings]);

  useEffect(() => {
    if (isActive && enabled.includes('health')) watchHealthDays();
  }, [isActive, enabled]);

  // Режим сна «Здоровья» — часы «Не беспокоить» по умолчанию, пока их не меняли вручную
  useEffect(() => {
    if (prefs.isQuietCustom || sleepBed === undefined || sleepWake === undefined) return;
    if (prefs.quietFrom === sleepBed && prefs.quietTo === sleepWake) return;
    updateNotifyPrefs({ quietFrom: sleepBed, quietTo: sleepWake });
  }, [prefs, sleepBed, sleepWake]);

  useHistoryBack({ isActive, onBack: onReset });

  const runDebounced = useRunDebounced(500, true);

  const areNotificationsSupported = checkIfNotificationsSupported();
  const areOfflineNotificationsSupported = areNotificationsSupported && !checkIfOfflinePushFailed();
  const isSoundOn = notificationSoundVolume > 0;
  const isTextShown = PEER_TYPES.every((type) => notifyDefaults?.[type]?.shouldShowPreviews);

  const updatePeerType = useLastCallback((peerType: ApiNotifyPeerType, patch: {
    isMuted?: boolean; shouldShowPreviews?: boolean;
  }) => {
    const current = notifyDefaults?.[peerType];
    updateNotificationSettings({
      peerType,
      isMuted: patch.isMuted ?? Boolean(current?.mutedUntil),
      shouldShowPreviews: patch.shouldShowPreviews ?? Boolean(current?.shouldShowPreviews),
    });
  });

  const handleWebChange = useLastCallback((isOn: boolean) => {
    updateWebNotificationSettings({
      hasWebNotifications: isOn,
      hasPushNotifications: isOn ? undefined : false,
    });
  });

  const handleOfflineChange = useLastCallback((isOn: boolean) => {
    updateWebNotificationSettings({ hasPushNotifications: isOn });
  });

  const handleTextShownChange = useLastCallback((isOn: boolean) => {
    PEER_TYPES.forEach((peerType) => updatePeerType(peerType, { shouldShowPreviews: isOn }));
  });

  const handleSoundChange = useLastCallback((isOn: boolean) => {
    updateWebNotificationSettings({ notificationSoundVolume: isOn ? DEFAULT_SOUND_VOLUME : 0 });
  });

  const handleVolumeChange = useLastCallback((volume: number) => {
    updateWebNotificationSettings({ notificationSoundVolume: volume });
    runDebounced(() => playNotifySound(undefined, volume));
  });

  const handlePinnedChange = useLastCallback((isOn: boolean) => {
    setSettingOption({ shouldNotifyAboutPinnedMessages: isOn });
  });

  const handleQuietChange = useLastCallback((isOn: boolean) => {
    updateNotifyPrefs({ isQuietOn: isOn });
  });

  const handleQuietFromChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const minutes = parseTime(e.currentTarget.value);
    if (minutes !== undefined) updateNotifyPrefs({ quietFrom: minutes, isQuietCustom: true });
  });

  const handleQuietToChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const minutes = parseTime(e.currentTarget.value);
    if (minutes !== undefined) updateNotifyPrefs({ quietTo: minutes, isQuietCustom: true });
  });

  const handleMute = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const span = e.currentTarget.dataset.notifyMute;
    updateNotifyPrefs({
      muteUntil: span === 'hour' || span === 'morning' ? buildMuteUntil(span, prefs, new Date()) : 0,
    });
  });

  const isMuted = prefs.muteUntil > Date.now();
  // Браузер запомнил отказ: вместо повторного запроса — «Открыть настройки» с инструкцией (доска `ZpSysGen`)
  const isBrowserDenied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const handleOpenSettings = useLastCallback(() => showPermissionDenied('notifications'));

  const offlineHint = areOfflineNotificationsSupported
    ? lang('ParvaneNotifyOfflineHint')
    : lang('SettingsOfflineNotificationUnsupported');

  return (
    <div className={buildClassName('settings-content custom-scroll', styles.screen)} data-settings-notifications>
      <div className={styles.caption}>{lang('ParvaneNotifyBackground')}</div>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={lang('NotificationsWeb')}
          hint={lang(areNotificationsSupported ? 'ParvaneNotifyWebHint' : 'SettingsOfflineNotificationUnsupported')}
          isOn={hasWebNotifications}
          isDisabled={!areNotificationsSupported}
          onChange={handleWebChange}
          data-notify-row="web"
        />
        <ProfileSwitchRow
          title={lang('NotificationsOffline')}
          hint={offlineHint}
          isOn={hasPushNotifications}
          isDisabled={!hasWebNotifications || !areOfflineNotificationsSupported}
          onChange={handleOfflineChange}
          data-notify-row="offline"
        />
        {isBrowserDenied && (
          <button
            type="button"
            className={buildClassName(styles.setRow, styles.setRowAction)}
            data-notify-denied
            onClick={handleOpenSettings}
          >
            <span className={styles.setTitle}>{lang('PvSysNotifyDenied')}</span>
            <span className={styles.setValue}>{lang('PvSysOpenSettings')}</span>
          </button>
        )}
      </div>

      <div className={styles.caption}>{lang('ParvaneNotifyByModule')}</div>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={lang('ParvaneSectionMessenger')}
          hint={lang('ParvaneNotifyChatsHint')}
          isOn={!prefs.off.includes('chats')}
          onChange={(isOn) => setNotifyModuleOn('chats', isOn)}
          data-notify-module="chats"
        />
        {enabled.includes('plan') && (
          <ProfileSwitchRow
            title={lang('ParvaneSectionPlanner')}
            hint={lang('ParvaneNotifyPlanHint')}
            isOn={!prefs.off.includes('plan')}
            onChange={(isOn) => setNotifyModuleOn('plan', isOn)}
            data-notify-module="plan"
          />
        )}
        {enabled.includes('health') && (
          <ProfileSwitchRow
            title={lang('PlannerHealth')}
            hint={lang('ParvaneNotifyHealthHint')}
            isOn={!prefs.off.includes('health')}
            onChange={(isOn) => setNotifyModuleOn('health', isOn)}
            data-notify-module="health"
          />
        )}
        {enabled.includes('files') && (
          <ProfileSwitchRow
            title={lang('ParvaneModuleFiles')}
            hint={lang('ParvaneNotifyFilesHint')}
            isOn={!prefs.off.includes('files')}
            onChange={(isOn) => setNotifyModuleOn('files', isOn)}
            data-notify-module="files"
          />
        )}
        {enabled.includes('music') && (
          <ProfileSwitchRow
            title={lang('ParvaneModuleMusic')}
            hint={lang('PvSysNotifyMusicHint')}
            isOn={!prefs.off.includes('music')}
            onChange={(isOn) => setNotifyModuleOn('music', isOn)}
            data-notify-module="music"
          />
        )}
      </div>
      <div className={styles.hint}>{lang('ParvaneNotifyModulesHint')}</div>

      <div className={styles.caption}>{lang('ParvaneNotifyChatTypes')}</div>
      <div className={styles.group}>
        {PEER_TYPES.map((peerType) => (
          <ProfileSwitchRow
            key={peerType}
            title={lang(PEER_TYPE_TITLES[peerType])}
            isOn={!notifyDefaults?.[peerType]?.mutedUntil}
            onChange={(isOn) => updatePeerType(peerType, { isMuted: !isOn })}
            data-notify-peer={peerType}
          />
        ))}
        <ProfileSwitchRow
          title={lang('PinnedMessagesNotifications')}
          isOn={shouldNotifyAboutPinnedMessages}
          onChange={handlePinnedChange}
          data-notify-row="pinned"
        />
      </div>

      <div className={styles.caption}>{lang('ParvaneNotifyHow')}</div>
      <div className={styles.group}>
        <ProfileSwitchRow
          title={lang('ParvaneNotifySound')}
          isOn={isSoundOn}
          onChange={handleSoundChange}
          data-notify-row="sound"
        />
        {isSoundOn && (
          <div className={buildClassName(styles.setRow, styles.volumeRow)}>
            <RangeSlider
              label={lang('ParvaneNotifyVolume')}
              min={1}
              max={10}
              value={notificationSoundVolume}
              onChange={handleVolumeChange}
            />
          </div>
        )}
        <ProfileSwitchRow
          title={lang('ParvaneNotifyShowText')}
          hint={lang('ParvaneNotifyShowTextHint')}
          isOn={isTextShown}
          onChange={handleTextShownChange}
          data-notify-row="text"
        />
        <ProfileSwitchRow
          title={lang('ParvaneNotifyQuiet')}
          hint={prefs.isQuietOn ? `${formatTime(prefs.quietFrom)}–${formatTime(prefs.quietTo)}` : undefined}
          isOn={prefs.isQuietOn}
          onChange={handleQuietChange}
          data-notify-row="quiet"
        />
        {prefs.isQuietOn && (
          <div className={styles.setRow} data-notify-quiet-times>
            <label className={styles.timeField}>
              <span className={styles.setHint}>{lang('ParvaneNotifyQuietFrom')}</span>
              <input
                type="time"
                className={styles.timeInput}
                value={formatTime(prefs.quietFrom)}
                onChange={handleQuietFromChange}
                data-notify-quiet="from"
              />
            </label>
            <label className={styles.timeField}>
              <span className={styles.setHint}>{lang('ParvaneNotifyQuietTo')}</span>
              <input
                type="time"
                className={styles.timeInput}
                value={formatTime(prefs.quietTo)}
                onChange={handleQuietToChange}
                data-notify-quiet="to"
              />
            </label>
          </div>
        )}
        {isMuted ? (
          <button
            type="button"
            className={buildClassName(styles.setRow, styles.setRowAction)}
            data-notify-mute="off"
            onClick={handleMute}
          >
            <span className={styles.setTitle}>
              {lang('PvSysMutedUntil', { time: formatTime(minutesOfDay(prefs.muteUntil)) })}
            </span>
            <span className={styles.setValue}>{lang('PvSysMuteOff')}</span>
          </button>
        ) : (
          <>
            <button
              type="button"
              className={buildClassName(styles.setRow, styles.setRowAction)}
              data-notify-mute="hour"
              onClick={handleMute}
            >
              <span className={styles.setTitle}>{lang('PvSysMuteHour')}</span>
            </button>
            <button
              type="button"
              className={buildClassName(styles.setRow, styles.setRowAction)}
              data-notify-mute="morning"
              onClick={handleMute}
            >
              <span className={styles.setTitle}>{lang('PvSysMuteMorning')}</span>
            </button>
          </>
        )}
      </div>
      <div className={styles.hint}>{lang('ParvaneNotifyQuietHint')}</div>
    </div>
  );
};

function formatTime(minutes: number) {
  const hours = Math.floor(minutes / MINUTES_IN_HOUR);
  return `${String(hours).padStart(2, '0')}:${String(minutes % MINUTES_IN_HOUR).padStart(2, '0')}`;
}

function minutesOfDay(time: number) {
  const date = new Date(time);
  return date.getHours() * MINUTES_IN_HOUR + date.getMinutes();
}

function parseTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * MINUTES_IN_HOUR + Number(match[2]);
}

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      shouldNotifyAboutPinnedMessages: global.settings.byKey.shouldNotifyAboutPinnedMessages,
      hasWebNotifications: global.settings.byKey.hasWebNotifications,
      hasPushNotifications: global.settings.byKey.hasPushNotifications,
      notificationSoundVolume: global.settings.byKey.notificationSoundVolume,
      notifyDefaults: global.settings.notifyDefaults,
    };
  },
)(SettingsNotifications));
