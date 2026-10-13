import '../../global/actions/all';

import {
  beginHeavyAnimation,
  memo, useEffect, useLayoutEffect,
  useRef, useState,
} from '../../lib/teact/teact';
import { addExtraClass } from '../../lib/teact/teact-dom';
import { getActions, getGlobal, withGlobal } from '../../global';

import type { ApiChatFolder, ApiLimitTypeWithModal, ApiStarGiftAuctionState, ApiUser } from '../../api/types';
import type { TabState } from '../../global/types';
import type { ThemeKey } from '../../types';
import { LeftColumnContent, SettingsScreens } from '../../types';

import {
  DARK_THEME_PATTERN_COLOR, DEBUG, DEFAULT_PATTERN_COLOR, FOLDERS_POSITION_LEFT,
  INACTIVE_MARKER,
} from '../../config';
import { requestNextMutation } from '../../lib/fasterdom/fasterdom';
import {
  selectAreFoldersPresent,
  selectCanAnimateInterface,
  selectChatFolder,
  selectChatMessage,
  selectCurrentMessageList,
  selectIsCurrentUserFrozen,
  selectIsCurrentUserPremium,
  selectIsForwardModalOpen,
  selectIsMediaViewerOpen,
  selectIsReactionPickerOpen,
  selectIsRightColumnShown,
  selectIsServiceChatReady,
  selectIsStoryViewerOpen,
  selectLeftColumnContentKey,
  selectPerformanceSettingsValue,
  selectSettingsScreen,
  selectTabSelectedGiftAuction,
  selectTabState,
  selectTheme,
  selectThemeValues,
  selectUser,
} from '../../global/selectors';
import { selectSharedSettings } from '../../global/selectors/sharedState';
import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_ANDROID, IS_MAC_OS, IS_WAVE_TRANSFORM_SUPPORTED } from '../../util/browser/windowEnvironment';
import buildClassName from '../../util/buildClassName';
import buildStyle from '../../util/buildStyle';
import { getColorScheme, getSchemeChatColors } from '../../util/colorScheme';
import { waitForTransitionEnd } from '../../util/cssAnimationEndListeners';
import { processDeepLink } from '../../util/deeplink';
import * as mediaLoader from '../../util/mediaLoader';
import { Bundles, loadBundle } from '../../util/moduleLoader';
import { oldTranslate } from '../../util/oldLangProvider';
import {
  markMediaTampered, migrateCustomBackgrounds, purgePlaintextMediaCaches,
} from '../../util/parvaneMediaIntegrity';
import { getKnowledgeView, getParvaneSection } from '../../util/parvaneSection';
import { isUploadedWallpaper } from '../../util/parvaneWallpaper';
import {
  consumePendingInvite,
  getInitialLocationHash,
  parseInitialLocationHash,
  parseLocationHash,
  peekPendingInvite,
  resetLocationHash,
} from '../../util/routing';
import updateIcon from '../../util/updateIcon';
import { callApi } from '../../api/gramjs';

import useInterval from '../../hooks/schedulers/useInterval';
import useTimeout from '../../hooks/schedulers/useTimeout';
import useTauriEvent from '../../hooks/tauri/useTauriEvent';
import useAppLayout from '../../hooks/useAppLayout';
import useCustomBackground from '../../hooks/useCustomBackground';
import useDerivedState from '../../hooks/useDerivedState';
import useForceUpdate from '../../hooks/useForceUpdate';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import usePrevDuringAnimation from '../../hooks/usePrevDuringAnimation';
import usePreventPinchZoomGesture from '../../hooks/usePreventPinchZoomGesture';
import useShowTransition from '../../hooks/useShowTransition';
import useSyncEffect from '../../hooks/useSyncEffect';
import useBackgroundMode from '../../hooks/window/useBackgroundMode';
import useBeforeUnload from '../../hooks/window/useBeforeUnload';
import { useFullscreenStatus } from '../../hooks/window/useFullscreen';

import ActiveCallHeader from '../calls/ActiveCallHeader.async';
import GroupCall from '../calls/group/GroupCall.async';
import PhoneCall from '../calls/phone/PhoneCall.async';
import RatePhoneCallModal from '../calls/phone/RatePhoneCallModal.async';
import CustomEmojiSetsModal from '../common/CustomEmojiSetsModal.async';
import DeleteMessageModal from '../common/DeleteMessageModal.async';
import StickerSetModal from '../common/StickerSetModal.async';
import UnreadCount from '../common/UnreadCounter';
import LeftColumn from '../left/LeftColumn';
import MediaViewer from '../mediaViewer/MediaViewer.async';
import ReactionPicker from '../middle/message/reactions/ReactionPicker.async';
import MessageListHistoryHandler from '../middle/MessageListHistoryHandler';
import MiddleColumn from '../middle/MiddleColumn';
import AudioPlayer from '../middle/panes/AudioPlayer';
import ModalContainer from '../modals/ModalContainer';
import Cloud from '../parvane/Cloud.async';
import CloudChatDialogs from '../parvane/cloud/CloudChatDialogs';
import Knowledge from '../parvane/Knowledge.async';
import ParvanePalette from '../parvane/palette/ParvanePalette.async';
import Planner from '../parvane/Planner.async';
import PaymentModal from '../payment/PaymentModal.async';
import ReceiptModal from '../payment/ReceiptModal.async';
import RightColumn from '../right/RightColumn';
import StoryViewer from '../story/StoryViewer.async';
import AttachBotRecipientPicker from './AttachBotRecipientPicker.async';
import BotTrustModal from './BotTrustModal.async';
import DeleteFolderDialog from './DeleteFolderDialog.async';
import Dialogs from './Dialogs';
import DownloadManager from './DownloadManager';
import DraftRecipientPicker from './DraftRecipientPicker.async';
import FoldersSidebar from './FoldersSidebar';
import ForwardRecipientPicker from './ForwardRecipientPicker.async';
import GameModal from './GameModal';
import HistoryCalendar from './HistoryCalendar.async';
import NewContactModal from './NewContactModal.async';
import ParvaneBugReportModal from './ParvaneBugReportModal';
import ParvaneTabBar from './ParvaneTabBar';
import PremiumLimitReachedModal from './premium/common/PremiumLimitReachedModal.async';
import GiveawayModal from './premium/GiveawayModal.async';
import PremiumMainModal from './premium/PremiumMainModal.async';
import StarsGiftingPickerModal from './premium/StarsGiftingPickerModal.async';
import ConfettiContainer from './visualEffects/ConfettiContainer';
import SnapEffectContainer from './visualEffects/SnapEffectContainer';
import WaveContainer from './visualEffects/WaveContainer';

import './Main.scss';
import backgroundStyles from '../../styles/_patternBackground.module.scss';

export interface OwnProps {
  isMobile?: boolean;
}

type StateProps = {
  isMasterTab?: boolean;
  currentUserId?: string;
  isLeftColumnOpen: boolean;
  isMiddleColumnOpen: boolean;
  isRightColumnOpen: boolean;
  isOwnProfileOpen: boolean;
  isMediaViewerOpen: boolean;
  isStoryViewerOpen: boolean;
  isForwardModalOpen: boolean;
  isHistoryCalendarOpen: boolean;
  shouldSkipHistoryAnimations?: boolean;
  openedStickerSetShortName?: string;
  openedCustomEmojiSetIds?: string[];
  activeGroupCallId?: string;
  isServiceChatReady?: boolean;
  wasTimeFormatSetManually?: boolean;
  isPhoneCallActive?: boolean;
  addedSetIds?: string[];
  addedCustomEmojiIds?: string[];
  newContactUserId?: string;
  newContactByPhoneNumber?: boolean;
  openedGame?: TabState['openedGame'];
  gameTitle?: string;
  isRatePhoneCallModalOpen?: boolean;
  isPremiumModalOpen?: boolean;
  botTrustRequest?: TabState['botTrustRequest'];
  botTrustRequestBot?: ApiUser;
  requestedAttachBotInChat?: TabState['requestedAttachBotInChat'];
  requestedBotStartGroup?: TabState['requestedBotStartGroup'];
  requestedDraft?: TabState['requestedDraft'];
  limitReached?: ApiLimitTypeWithModal;
  deleteFolderDialog?: ApiChatFolder;
  isPaymentModalOpen?: boolean;
  isReceiptModalOpen?: boolean;
  isReactionPickerOpen: boolean;
  isGiveawayModalOpen?: boolean;
  isDeleteMessageModalOpen?: boolean;
  isStarsGiftingPickerModal?: boolean;
  isCurrentUserPremium?: boolean;
  noRightColumnAnimation?: boolean;
  withInterfaceAnimations?: boolean;
  isSynced?: boolean;
  isAccountFrozen?: boolean;
  isAppConfigLoaded?: boolean;
  isFoldersSidebarShown: boolean;
  leftColumnContentKey: LeftColumnContent;
  settingsScreen: SettingsScreens;
  diceEmojies?: string[];
  selectedGiftAuction?: ApiStarGiftAuctionState;
  theme: ThemeKey;
  customBackground?: string;
  backgroundColor?: string;
  patternColor?: string;
  isBackgroundBlurred?: boolean;
};

// Parvane: сколько ждать синка с открытой ссылкой-приглашением, прежде чем
// сказать пользователю, что связи нет (вступление ждёт синка)
const INVITE_OFFLINE_NOTICE_MS = 15000;
const APP_OUTDATED_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const CALL_BUNDLE_LOADING_DELAY_MS = 5000; // 5 sec
// Parvane (B2): разделы и палитра — вне критического пути старта, но заранее: первый переход без ожидания
const PARVANE_BUNDLE_LOADING_DELAY_MS = 3000;
const OWN_PROFILE_CLOSE_DURATION = 450;

let DEBUG_isLogged = false;

const Main = ({
  isMobile,
  isLeftColumnOpen,
  isMiddleColumnOpen,
  isRightColumnOpen,
  isOwnProfileOpen,
  isMediaViewerOpen,
  isStoryViewerOpen,
  isForwardModalOpen,
  activeGroupCallId,
  isHistoryCalendarOpen,
  shouldSkipHistoryAnimations,
  limitReached,
  openedStickerSetShortName,
  openedCustomEmojiSetIds,
  isServiceChatReady,
  withInterfaceAnimations,
  wasTimeFormatSetManually,
  addedSetIds,
  addedCustomEmojiIds,
  isPhoneCallActive,
  newContactUserId,
  newContactByPhoneNumber,
  openedGame,
  gameTitle,
  isRatePhoneCallModalOpen,
  botTrustRequest,
  botTrustRequestBot,
  requestedAttachBotInChat,
  requestedBotStartGroup,
  requestedDraft,
  isPremiumModalOpen,
  isGiveawayModalOpen,
  isDeleteMessageModalOpen,
  isStarsGiftingPickerModal,
  isPaymentModalOpen,
  isReceiptModalOpen,
  isReactionPickerOpen,
  isCurrentUserPremium,
  deleteFolderDialog,
  isMasterTab,
  noRightColumnAnimation,
  isSynced,
  currentUserId,
  isAccountFrozen,
  isAppConfigLoaded,
  isFoldersSidebarShown,
  leftColumnContentKey,
  settingsScreen,
  diceEmojies,
  selectedGiftAuction,
  theme,
  customBackground,
  backgroundColor,
  patternColor,
  isBackgroundBlurred,
}: OwnProps & StateProps) => {
  const {
    initMain,
    loadBirthdayNumbersStickers,
    loadRestrictedEmojiStickers,
    loadNotificationSettings,
    updateIsOnline,
    onTabFocusChange,
    openSettingsScreen,
    loadCountryList,
    loadAvailableReactions,
    loadStickerSets,
    loadDiceStickers,
    loadMyUniqueGifts,
    loadAddedStickers,
    loadFavoriteStickers,
    loadDefaultStatusIcons,
    ensureTimeFormat,
    closeStickerSetModal,
    closeCustomEmojiSets,
    checkVersionNotification,
    loadAppConfig,
    loadContactList,
    loadCustomEmojis,
    closePaymentModal,
    clearReceipt,
    checkAppVersion,
    openThread,
    toggleLeftColumn,
    loadRecentEmojiStatuses,
    updatePageTitle,
    loadAuthorizations,
    loadPasswordInfo,
    loadBotFreezeAppeal,
    loadGiftAuction,
    openChatByUsername,
    checkChatInvite,
    showNotification,
    showDialog,
  } = getActions();

  if (DEBUG && !DEBUG_isLogged) {
    DEBUG_isLogged = true;
    // eslint-disable-next-line no-console
    console.log('>>> RENDER MAIN');
  }

  const lang = useLang();

  // Preload Calls bundle to initialize sounds for iOS
  useTimeout(() => {
    void loadBundle(Bundles.Calls);
  }, CALL_BUNDLE_LOADING_DELAY_MS);

  useTimeout(() => {
    void loadBundle(Bundles.Parvane);
  }, PARVANE_BUNDLE_LOADING_DELAY_MS);

  const containerRef = useRef<HTMLDivElement>();
  const leftColumnRef = useRef<HTMLDivElement>();

  const { isDesktop } = useAppLayout();
  useEffect(() => {
    if (!isLeftColumnOpen && !isMiddleColumnOpen && !isDesktop) {
      // Always display at least one column
      toggleLeftColumn();
    } else if (isLeftColumnOpen && isMiddleColumnOpen && isMobile) {
      // Can't have two active columns at the same time
      toggleLeftColumn();
    }
  }, [isDesktop, isLeftColumnOpen, isMiddleColumnOpen, isMobile, toggleLeftColumn]);

  useEffect(() => {
    if (IS_TAURI && IS_MAC_OS) {
      window.tauri?.markTitleBarOverlay(true, isMobile);
    }
  }, [isMobile]);

  useInterval(checkAppVersion, isMasterTab ? APP_OUTDATED_TIMEOUT_MS : undefined, true);

  // Initial API calls
  // Parvane (B5): после синка tt запускал ~40 загрузчиков Telegram (stories, промо, подарки, Stars, реакции-теги,
  // боты, эффекты, часовые пояса…) — у провайдера Parvane этих методов нет, каждый вызов был холостым проходом
  // через `callApi` с записью «метод не реализован» в журнал. Остались только те, что провайдер отвечает
  useEffect(() => {
    if (isMasterTab && isSynced) {
      updateIsOnline({ isOnline: true });
      loadAppConfig();
      initMain();
      loadContactList();
      checkAppVersion();
      loadAuthorizations();
      loadPasswordInfo();
    }
  }, [isMasterTab, isSynced]);

  useEffect(() => {
    if (isMasterTab && isSynced && isAppConfigLoaded && !isAccountFrozen) {
      loadNotificationSettings();
      loadAvailableReactions();
      loadMyUniqueGifts();
      loadBirthdayNumbersStickers();
      loadRestrictedEmojiStickers();
    }
  }, [isMasterTab, isSynced, isAppConfigLoaded, isAccountFrozen]);

  // Initial Premium API calls
  useEffect(() => {
    if (isMasterTab && isCurrentUserPremium && isAppConfigLoaded && !isAccountFrozen) {
      loadDefaultStatusIcons();
      loadRecentEmojiStatuses();
    }
  }, [isCurrentUserPremium, isMasterTab, isAppConfigLoaded, isAccountFrozen]);

  // Language-based API calls (B5: словарь эмодзи `loadEmojiKeywords` провайдер не отдаёт — не запрашиваем)
  useEffect(() => {
    if (isMasterTab) {
      loadCountryList({ langCode: lang.code });
    }
  }, [lang.code, isMasterTab]);

  // Re-fetch cached saved emoji for `localDb`
  useEffect(() => {
    if (isMasterTab) {
      loadCustomEmojis({
        ids: Object.keys(getGlobal().customEmojis.byId),
        ignoreCache: true,
      });
    }
  }, [isMasterTab]);

  // Sticker sets
  useEffect(() => {
    if (isMasterTab && isSynced && isAppConfigLoaded && !isAccountFrozen) {
      if (!addedSetIds || !addedCustomEmojiIds) {
        loadStickerSets();
        loadFavoriteStickers();
      }

      if (addedSetIds && addedCustomEmojiIds) {
        loadAddedStickers();
      }
    }
  }, [addedSetIds, addedCustomEmojiIds, isMasterTab, isSynced, isAppConfigLoaded, isAccountFrozen]);

  useEffect(() => {
    if (isMasterTab && isSynced && isAppConfigLoaded && !isAccountFrozen && diceEmojies) {
      loadDiceStickers();
    }
  }, [isMasterTab, isSynced, isAppConfigLoaded, isAccountFrozen, diceEmojies]);

  useEffect(() => {
    loadBotFreezeAppeal();
  }, [isAppConfigLoaded]);

  // Check version when service chat is ready
  useEffect(() => {
    if (isServiceChatReady && isMasterTab) {
      checkVersionNotification();
    }
  }, [isServiceChatReady, isMasterTab]);

  // Ensure time format
  useEffect(() => {
    if (!wasTimeFormatSetManually) {
      ensureTimeFormat();
    }
  }, [wasTimeFormatSetManually]);

  // Parvane: gateway ограничил частоту (флуд сообщениями/загрузками)
  useEffect(() => {
    const handleRateLimited = () => {
      showNotification({ message: oldTranslate('ParvaneRateLimited') });
    };
    window.addEventListener('parvane-rate-limited', handleRateLimited);
    return () => window.removeEventListener('parvane-rate-limited', handleRateLimited);
  }, [showNotification]);

  // Parvane: состав своих устройств изменился — открытый экран «Устройства» перечитывает список
  useEffect(() => {
    const handleDevicesChanged = () => loadAuthorizations();
    window.addEventListener('parvane-devices-changed', handleDevicesChanged);
    return () => window.removeEventListener('parvane-devices-changed', handleDevicesChanged);
  }, [loadAuthorizations]);

  // Parvane: в журнале устройств появилось новое своё устройство (spec 007)
  useEffect(() => {
    const handleNewDevice = () => {
      showNotification({ message: oldTranslate('ParvaneNewDevice') });
    };
    window.addEventListener('parvane-new-device', handleNewDevice);
    return () => window.removeEventListener('parvane-new-device', handleNewDevice);
  }, [showNotification]);

  // Parvane: отозвано устройство, державшее ключ подписи устройств — его надо
  // обновить ключом восстановления (Settings → Devices)
  useEffect(() => {
    const handleSskRotation = () => {
      showNotification({ message: oldTranslate('ParvaneSskRotationNotice') });
    };
    window.addEventListener('parvane-ssk-rotation', handleSskRotation);
    return () => window.removeEventListener('parvane-ssk-rotation', handleSskRotation);
  }, [showNotification]);

  // Parvane: это устройство ещё не привязано к аккаунту (вход с нового устройства
  // или после полного выхода): без привязки оно не получает сообщений — сразу
  // ведём на экран «Устройства» (код для другого устройства, ключ восстановления)
  useEffect(() => {
    const handleNeedsLinking = () => {
      openSettingsScreen({ screen: SettingsScreens.ActiveSessions });
      showNotification({ message: oldTranslate('ParvaneNeedsLinkingNotice') });
    };
    void (callApi as unknown as (name: string) => Promise<{ canRecover?: boolean } | undefined>)('parvaneGetLinkStatus')
      .then((status) => {
        if (status?.canRecover) handleNeedsLinking();
      });
    window.addEventListener('parvane-needs-linking', handleNeedsLinking);
    return () => window.removeEventListener('parvane-needs-linking', handleNeedsLinking);
  }, [openSettingsScreen, showNotification]);

  // Parvane: сервер не принимает эту версию протокола — нативный диалог ошибки
  useEffect(() => {
    const handleUpgradeRequired = () => {
      showDialog({ data: { type: 'localized', text: { key: 'ParvaneUpgradeRequired' } } });
    };
    void (callApi as unknown as (name: string) => Promise<boolean | undefined>)('parvaneIsUpgradeRequired')
      .then((isRequired) => {
        if (isRequired) handleUpgradeRequired();
      });
    window.addEventListener('parvane-upgrade-required', handleUpgradeRequired);
    return () => window.removeEventListener('parvane-upgrade-required', handleUpgradeRequired);
  }, [showDialog]);

  // Parvane: ключ восстановления корня (spec 007, D-12) — показать один раз
  useEffect(() => {
    const handleRecoveryKey = async () => {
      const result = await (callApi as unknown as (name: string) => Promise<{
        recoveryKey: string; hasEscrow?: boolean;
      } | undefined>)('parvaneTakeRecoveryKey');
      if (!result) return;
      // Окно показывается, только когда ключ не ушёл владельцу в Telegram (spec 015). Сервер
      // держит копию корня для администратора — потерянный ключ выпишут заново
      const variables = { key: result.recoveryKey };
      showDialog({
        data: {
          type: 'localized',
          text: result.hasEscrow
            ? { key: 'ParvaneRecoveryKeyAdmin', variables }
            : { key: 'ParvaneRecoveryKey', variables },
        },
      });
    };
    // Ключ мог появиться до монтирования Main
    void handleRecoveryKey();
    window.addEventListener('parvane-recovery-key', handleRecoveryKey);
    return () => window.removeEventListener('parvane-recovery-key', handleRecoveryKey);
  }, [showDialog]);

  // Parvane: сервер скоро отключит эту версию (E6) — мягкое напоминание
  useEffect(() => {
    const handleUpgradeAvailable = () => {
      showNotification({ message: oldTranslate('ParvaneUpgradeAvailable') });
    };
    window.addEventListener('parvane-upgrade-available', handleUpgradeAvailable);
    return () => window.removeEventListener('parvane-upgrade-available', handleUpgradeAvailable);
  }, [showNotification]);

  // Parvane: перенести старые открытые обои в шифрованное хранилище. Только
  // после синка — до него провайдер не знает пользователя, запись не пройдёт,
  // и кэш (единственная копия картинки) остался бы удалённым впустую
  useEffect(() => {
    if (!isSynced) return;
    void migrateCustomBackgrounds();
  }, [isSynced]);

  // Parvane: файл не прошёл проверку целостности — пометить и сообщить
  useEffect(() => {
    void purgePlaintextMediaCaches();
    const handleIntegrity = (event: Event) => {
      const fileId = (event as CustomEvent<{ fileId?: string }>).detail?.fileId;
      if (!fileId) return;
      markMediaTampered(fileId);
      // Расшифрованные байты этого файла больше не отдавать ни из какого кэша
      mediaLoader.unloadByFileId(fileId);
      showNotification({ message: oldTranslate('ParvaneMediaTampered') });
    };
    window.addEventListener('parvane-media-integrity', handleIntegrity);
    return () => window.removeEventListener('parvane-media-integrity', handleIntegrity);
  }, [showNotification]);

  // Parvane: целостность файла проверить не удалось (шард недоступен, долгий
  // офлайн). Это НЕ подмена: окна уже сыграли непроверенными, и промолчать
  // значило бы выдать файл за проверенный вопреки FR-022 — но и рвать
  // воспроизведение из-за обрыва сети нельзя, поэтому только предупреждение
  useEffect(() => {
    const handleUnverifiable = () => {
      showNotification({ message: oldTranslate('ParvaneMediaUnverified') });
    };
    window.addEventListener('parvane-media-unverifiable', handleUnverifiable);
    return () => window.removeEventListener('parvane-media-unverifiable', handleUnverifiable);
  }, [showNotification]);

  // Parvane: групповой звонок не получил доступ к микрофону/камере
  useEffect(() => {
    const handleCallMediaError = () => {
      showNotification({ message: oldTranslate('ParvaneCallNoDevice') });
    };
    window.addEventListener('parvane-call-media-error', handleCallMediaError);
    return () => window.removeEventListener('parvane-call-media-error', handleCallMediaError);
  }, [showNotification]);

  // Parvane: вызов по v2 не ушёл (собеседник ещё не отвечал — нет ключа доступа)
  useEffect(() => {
    const handleCallUnavailable = (event: Event) => {
      const detail = (event as CustomEvent<{ isNotContact?: boolean; isRateLimited?: boolean }>).detail;
      const key = detail?.isRateLimited ? 'ParvaneCallRateLimited'
        : detail?.isNotContact ? 'ParvaneCallNotContact' : 'ParvaneCallNotSent';
      showNotification({ message: oldTranslate(key) });
    };
    window.addEventListener('parvane-call-unavailable', handleCallUnavailable);
    return () => window.removeEventListener('parvane-call-unavailable', handleCallUnavailable);
  }, [showNotification]);

  // Parvane: в групповом звонке больше участников, чем тянет mesh
  useEffect(() => {
    const handleTooMany = (event: Event) => {
      const limit = (event as CustomEvent<{ limit?: number }>).detail?.limit;
      showNotification({ message: oldTranslate('ParvaneCallTooManyMembers', limit) });
    };
    window.addEventListener('parvane-call-too-many', handleTooMany);
    return () => window.removeEventListener('parvane-call-too-many', handleTooMany);
  }, [showNotification]);

  // Parvane: ссылка-приглашение открыта, но синка нет (gateway недоступен).
  // Вступление заперто за isSynced, поэтому без этого пользователь видел бы
  // бесконечное «соединение» и ни одной ошибки — FAIL-1 такое запрещает.
  // Токен при этом НЕ расходуется: после восстановления связи вступление
  // пройдёт само, а перезагрузка страницы повторит попытку
  useEffect(() => {
    if (isSynced || !peekPendingInvite()) return undefined;
    const timer = window.setTimeout(() => {
      showNotification({ message: oldTranslate('ParvaneInviteOffline') });
    }, INVITE_OFFLINE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [isSynced, showNotification]);

  // Parvane: отказ вступления по ссылке-приглашению (бан, битая ссылка, сеть)
  useEffect(() => {
    const keys: Record<string, string> = {
      invalid: 'ParvaneInviteInvalid',
      banned: 'ParvaneInviteBanned',
      revoked: 'ParvaneInviteRevoked',
      expired: 'ParvaneInviteExpired',
      exhausted: 'ParvaneInviteExhausted',
      requested: 'ParvaneInviteRequested',
      declined: 'ParvaneInviteDeclined',
      editUnsupported: 'ParvaneInviteEditUnsupported',
      failed: 'ParvaneInviteFailed',
      linkFailed: 'ParvaneInviteLinkFailed',
    };
    const handleInviteError = (event: Event) => {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code || 'failed';
      // Лимит запросов gateway показывает своим тостом (`parvane-rate-limited`
      // ниже) — второй про «не удалось вступить» был бы дублем
      if (code === 'rateLimited') return;
      showNotification({ message: oldTranslate(keys[code] || keys.failed) });
    };
    window.addEventListener('parvane-invite-error', handleInviteError);
    return () => window.removeEventListener('parvane-invite-error', handleInviteError);
  }, [showNotification]);

  // Parvane: identity отклонил запись профиля целиком (пустое или слишком
  // длинное имя, протухший токен) — молча оставлять экран с непринятыми
  // значениями нельзя
  useEffect(() => {
    const handleProfileError = () => {
      showNotification({ message: oldTranslate('ParvaneProfileSaveFailed') });
    };
    window.addEventListener('parvane-profile-error', handleProfileError);
    return () => window.removeEventListener('parvane-profile-error', handleProfileError);
  }, [showNotification]);

  // Parse deep link
  useEffect(() => {
    if (!isSynced) return;
    updatePageTitle();

    // Parvane: ссылка на пользователя `<origin>/#@<ник>` (QR-код профиля)
    const userLinkMatch = getInitialLocationHash().match(/^#@([A-Za-z0-9_.@-]+)$/);
    if (userLinkMatch) {
      resetLocationHash();
      openChatByUsername({ username: userLinkMatch[1] });
      return;
    }

    // Parvane: ссылка-приглашение в адресной строке `<origin>/#+<токен>`;
    // токен, пришедший до входа, пережил перезагрузку в sessionStorage
    // Как t.me/+hash: сперва превью группы (нативная модалка с «Join» /
    // «Request to Join»); участнику сразу открывается чат (spec 003)
    const pendingInvite = consumePendingInvite();
    if (pendingInvite) {
      resetLocationHash();
      checkChatInvite({ hash: pendingInvite });
      return;
    }

    const parsedInitialLocationHash = parseInitialLocationHash();
    if (parsedInitialLocationHash?.tgaddr) {
      processDeepLink(decodeURIComponent(parsedInitialLocationHash.tgaddr), { type: 'inner' });
    }
  }, [isSynced]);

  // Parvane: `#+<токен>` вставлен в адрес уже открытой вкладки (перехват —
  // в popstate useHistoryBack, до очистки хэша). Токен лежит в sessionStorage:
  // пока синк не закончен, вступление ждёт эффекта ниже
  useEffect(() => {
    const handleInviteHash = () => {
      if (!getGlobal().isSynced) return;
      const token = consumePendingInvite();
      if (!token) return;
      resetLocationHash();
      checkChatInvite({ hash: token });
    };
    window.addEventListener('parvane-invite-hash', handleInviteHash);
    return () => window.removeEventListener('parvane-invite-hash', handleInviteHash);
  }, []);

  useTauriEvent<string>('deeplink', (event) => {
    try {
      const url = event.payload || '';
      const decodedUrl = decodeURIComponent(url);
      processDeepLink(decodedUrl, { type: 'inner' });
    } catch (e) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('Failed to process deep link', e);
      }
    }
  });

  useEffect(() => {
    const parsedLocationHash = parseLocationHash(currentUserId);
    if (!parsedLocationHash) return;

    openThread({
      chatId: parsedLocationHash.chatId,
      threadId: parsedLocationHash.threadId,
      type: parsedLocationHash.type,
    });
  }, [currentUserId]);

  // Refresh gift auction subscription
  const auctionTimeout = selectedGiftAuction?.state.type === 'active' ? selectedGiftAuction?.timeout : undefined;
  const auctionGiftId = selectedGiftAuction?.gift.id;
  useInterval(() => {
    if (auctionGiftId) {
      loadGiftAuction({ giftId: auctionGiftId });
    }
  }, auctionTimeout ? auctionTimeout * 1000 : undefined);

  // Restore Transition slide class after async rendering
  useLayoutEffect(() => {
    const container = containerRef.current!;
    if (container.parentNode!.childElementCount === 1) {
      addExtraClass(container, 'Transition_slide-active');
    }
  }, []);

  useShowTransition({
    ref: containerRef,
    isOpen: isLeftColumnOpen,
    noCloseTransition: shouldSkipHistoryAnimations,
    prefix: 'left-column-',
  });
  const willAnimateLeftColumnRef = useRef(false);
  const forceUpdate = useForceUpdate();

  // Handle opening middle column
  useSyncEffect(([prevIsLeftColumnOpen]) => {
    if (prevIsLeftColumnOpen === undefined || isLeftColumnOpen === prevIsLeftColumnOpen || !withInterfaceAnimations) {
      return;
    }

    willAnimateLeftColumnRef.current = true;

    if (IS_ANDROID) {
      requestNextMutation(() => {
        document.body.classList.toggle('android-left-blackout-open', !isLeftColumnOpen);
      });
    }

    const endHeavyAnimation = beginHeavyAnimation();

    waitForTransitionEnd(document.getElementById('MiddleColumn')!, () => {
      endHeavyAnimation();
      willAnimateLeftColumnRef.current = false;
      forceUpdate();
    });
  }, [isLeftColumnOpen, withInterfaceAnimations, forceUpdate]);

  useShowTransition({
    ref: containerRef,
    isOpen: isRightColumnOpen,
    noMountTransition: true,
    noCloseTransition: shouldSkipHistoryAnimations,
    prefix: 'right-column-',
  });
  const willAnimateRightColumnRef = useRef(false);
  const [isNarrowMessageList, setIsNarrowMessageList] = useState(isRightColumnOpen);

  const isFullscreen = useFullscreenStatus();

  // Handle opening right column
  useSyncEffect(([prevIsMiddleColumnOpen, prevIsRightColumnOpen]) => {
    if (prevIsRightColumnOpen === undefined || isRightColumnOpen === prevIsRightColumnOpen) {
      return;
    }

    if (!prevIsMiddleColumnOpen || noRightColumnAnimation) {
      setIsNarrowMessageList(isRightColumnOpen);
      return;
    }

    willAnimateRightColumnRef.current = true;

    const endHeavyAnimation = beginHeavyAnimation();

    waitForTransitionEnd(document.getElementById('RightColumn')!, () => {
      endHeavyAnimation();
      willAnimateRightColumnRef.current = false;
      forceUpdate();
      setIsNarrowMessageList(isRightColumnOpen);
    });
  }, [isMiddleColumnOpen, isRightColumnOpen, noRightColumnAnimation, forceUpdate]);

  const customBackgroundValue = useCustomBackground(theme, customBackground);

  const bgClassName = buildClassName(
    backgroundStyles.background,
    !noRightColumnAnimation && backgroundStyles.withTransition,
    customBackground && backgroundStyles.customBgImage,
    backgroundColor && backgroundStyles.customBgColor,
    isUploadedWallpaper(customBackground) && isBackgroundBlurred && backgroundStyles.blurred,
    isRightColumnOpen && backgroundStyles.withRightColumn,
  );

  // Parvane (spec 009): боковая панель видна всегда (кроме телефона), раздел выбирается в её нижней части
  const isAppSidebarShown = !isMobile;
  const parvaneSection = useDerivedState(getParvaneSection);
  // Parvane (spec 019): фон чата и узор берутся из цветовой схемы, пока пользователь не выбрал свои
  const schemeChatColors = getSchemeChatColors(useDerivedState(getColorScheme), theme);
  const hasOwnPattern = Boolean(patternColor) && patternColor !== DEFAULT_PATTERN_COLOR
    && patternColor !== DARK_THEME_PATTERN_COLOR;
  const chatPatternColor = schemeChatColors && !hasOwnPattern ? schemeChatColors.pattern : patternColor;
  const chatBackgroundColor = backgroundColor || schemeChatColors?.background;
  const isPlannerOpen = parvaneSection === 'planner';
  const isCloudOpen = parvaneSection === 'cloud';
  const knowledgeView = useDerivedState(getKnowledgeView);
  // «Файлы» раздела «Знания» рисует прежнее «Облако», остальные вкладки — `Knowledge`
  const isCloudFilesOpen = isCloudOpen && knowledgeView === 'files';
  const isKnowledgeOpen = isCloudOpen && !isCloudFilesOpen;
  // Parvane (E1): «План», «Знания» и «Облако» после первого показа остаются смонтированными и скрываются
  // (`Main.scss`), как колонки мессенджера под другими разделами, — возврат не строит раздел заново и не
  // теряет выбранный день, папку, заметку, положение списка. Запрос «новая запись» делят два раздела: окно
  // поверх «Знаний» (`PlannerQuickHost`, `isInPlace`) «План» не трогает; слушатели клавиш холста и графа
  // сверяются с `getIsParvaneScreenShown('knowledge')`
  const isPlannerMountedRef = useRef(false);
  const shouldMountPlanner = isPlannerOpen || isPlannerMountedRef.current;
  isPlannerMountedRef.current = shouldMountPlanner;
  const isCloudMountedRef = useRef(false);
  const shouldMountCloud = isCloudFilesOpen || isCloudMountedRef.current;
  isCloudMountedRef.current = shouldMountCloud;
  const isKnowledgeMountedRef = useRef(false);
  const shouldMountKnowledge = isKnowledgeOpen || isKnowledgeMountedRef.current;
  isKnowledgeMountedRef.current = shouldMountKnowledge;
  // Parvane: на телефоне разделы переключаются нижней панелью. В мессенджере она видна на списке чатов
  // и главном экране настроек («Профиль»), в открытом чате, поиске и вложенных настройках — нет
  const isSettingsMainOpen = leftColumnContentKey === LeftColumnContent.Settings
    && settingsScreen === SettingsScreens.Main;
  const isTabBarShown = Boolean(isMobile) && (parvaneSection !== 'messenger' || (!isMiddleColumnOpen
    && (leftColumnContentKey === LeftColumnContent.ChatList || isSettingsMainOpen)));

  // Parvane: «Мой профиль» на телефоне открыт поверх чата «Избранное». Пока профиль показан и пока он
  // закрывается, сам чат скрыт — иначе при возврате в список чатов он мелькал под уезжающим профилем
  const isMiddleColumnHidden = usePrevDuringAnimation(isOwnProfileOpen || undefined, OWN_PROFILE_CLOSE_DURATION);

  const className = buildClassName(
    isMiddleColumnHidden && 'own-profile-shown',
    willAnimateLeftColumnRef.current && 'left-column-animating',
    willAnimateRightColumnRef.current && 'right-column-animating',
    isNarrowMessageList && 'narrow-message-list',
    shouldSkipHistoryAnimations && 'history-animation-disabled',
    isFullscreen && 'is-fullscreen',
    isAppSidebarShown && 'folders-sidebar-visible',
    isPlannerOpen && 'section-planner',
    isCloudOpen && 'section-cloud',
    isCloudFilesOpen && 'section-cloud-files',
    isKnowledgeOpen && 'section-knowledge',
    isTabBarShown && 'parvane-tab-bar-shown',
  );

  const handleBlur = useLastCallback(() => {
    onTabFocusChange({ isBlurred: true });
  });

  const handleFocus = useLastCallback(() => {
    onTabFocusChange({ isBlurred: false });

    if (!document.title.includes(INACTIVE_MARKER)) {
      updatePageTitle();
    }

    updateIcon(false);
  });

  const handleStickerSetModalClose = useLastCallback(() => {
    closeStickerSetModal();
  });

  const handleCustomEmojiSetsModalClose = useLastCallback(() => {
    closeCustomEmojiSets();
  });

  // Online status and browser tab indicators
  useBackgroundMode(handleBlur, handleFocus, IS_TAURI);
  useBeforeUnload(handleBlur);
  usePreventPinchZoomGesture(isMediaViewerOpen || isStoryViewerOpen);

  return (
    <div
      ref={containerRef}
      id="Main"
      className={className}
      style={buildStyle(
        chatPatternColor && `--pattern-color: ${chatPatternColor}`,
        chatBackgroundColor && `--theme-background-color: ${chatBackgroundColor}`,
      )}
    >
      <div
        className={bgClassName}
        style={customBackgroundValue ? `--custom-background: ${customBackgroundValue}` : undefined}
      />
      {IS_TAURI && IS_MAC_OS && (
        <div className="tauri-drag-region" data-tauri-drag-region />
      )}
      <FoldersSidebar isMobile={isMobile} isActive={isAppSidebarShown} withFolders={isFoldersSidebarShown} />
      {shouldMountPlanner && <Planner />}
      {shouldMountCloud && <Cloud isMobile={isMobile} />}
      {shouldMountKnowledge && <Knowledge />}
      {isTabBarShown && <ParvaneTabBar section={parvaneSection} isSettingsOpen={isSettingsMainOpen} />}
      <CloudChatDialogs />
      {/* Parvane: общий поиск по Ctrl+K — заметки, записи «Плана», чаты, команды */}
      <ParvanePalette />
      <LeftColumn ref={leftColumnRef} isFoldersSidebarShown={isFoldersSidebarShown} />
      <MiddleColumn leftColumnRef={leftColumnRef} isMobile={isMobile} />
      <RightColumn isMobile={isMobile} />
      <MediaViewer isOpen={isMediaViewerOpen} />
      <StoryViewer isOpen={isStoryViewerOpen} />
      <ForwardRecipientPicker isOpen={isForwardModalOpen} />
      <DraftRecipientPicker requestedDraft={requestedDraft} />
      <Dialogs />
      <AudioPlayer noUi />
      <ModalContainer />
      <HistoryCalendar isOpen={isHistoryCalendarOpen} />
      <StickerSetModal
        isOpen={Boolean(openedStickerSetShortName)}
        onClose={handleStickerSetModalClose}
        stickerSetShortName={openedStickerSetShortName}
      />
      <CustomEmojiSetsModal
        customEmojiSetIds={openedCustomEmojiSetIds}
        onClose={handleCustomEmojiSetsModalClose}
      />
      {activeGroupCallId && <GroupCall groupCallId={activeGroupCallId} />}
      <ActiveCallHeader isActive={Boolean(activeGroupCallId || isPhoneCallActive)} />
      <NewContactModal
        isOpen={Boolean(newContactUserId || newContactByPhoneNumber)}
        userId={newContactUserId}
        isByPhoneNumber={newContactByPhoneNumber}
      />
      <GameModal openedGame={openedGame} gameTitle={gameTitle} />
      <DownloadManager />
      <ParvaneBugReportModal />
      <ConfettiContainer />
      {IS_WAVE_TRANSFORM_SUPPORTED && <WaveContainer />}
      <SnapEffectContainer />
      <PhoneCall isActive={isPhoneCallActive} />
      <UnreadCount isForAppBadge />
      <RatePhoneCallModal isOpen={isRatePhoneCallModalOpen} />
      <BotTrustModal
        bot={botTrustRequestBot}
        type={botTrustRequest?.type}
        shouldRequestWriteAccess={botTrustRequest?.shouldRequestWriteAccess}
      />
      <AttachBotRecipientPicker
        requestedAttachBotInChat={requestedAttachBotInChat}
        requestedBotStartGroup={requestedBotStartGroup}
      />
      <MessageListHistoryHandler />
      <PremiumMainModal isOpen={isPremiumModalOpen} />
      <GiveawayModal isOpen={isGiveawayModalOpen} />
      <StarsGiftingPickerModal isOpen={isStarsGiftingPickerModal} />
      <PremiumLimitReachedModal limit={limitReached} />
      <PaymentModal isOpen={isPaymentModalOpen} onClose={closePaymentModal} />
      <ReceiptModal isOpen={isReceiptModalOpen} onClose={clearReceipt} />
      <DeleteFolderDialog folder={deleteFolderDialog} />
      <ReactionPicker isOpen={isReactionPickerOpen} />
      <DeleteMessageModal isOpen={isDeleteMessageModalOpen} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { isMobile }): Complete<StateProps> => {
    const {
      currentUserId,
    } = global;

    const {
      botTrustRequest,
      requestedAttachBotInChat,
      requestedBotStartGroup,
      requestedDraft,
      openedStickerSetShortName,
      openedCustomEmojiSetIds,
      shouldSkipHistoryAnimations,
      openedGame,
      isLeftColumnShown,
      historyCalendarSelectedAt,
      newContact,
      ratingPhoneCall,
      premiumModal,
      giveawayModal,
      deleteMessageModal,
      starsGiftingPickerModal,
      isMasterTab,
      payment,
      limitReachedModal,
      deleteFolderDialogModal,
    } = selectTabState(global);

    const selectedGiftAuction = selectTabSelectedGiftAuction(global);

    const { wasTimeFormatSetManually, foldersPosition } = selectSharedSettings(global);

    const gameMessage = openedGame && selectChatMessage(global, openedGame.chatId, openedGame.messageId);
    const gameTitle = gameMessage?.content.game?.title;
    const { chatId } = selectCurrentMessageList(global) || {};
    const noRightColumnAnimation = !selectPerformanceSettingsValue(global, 'rightColumnAnimations')
      || !selectCanAnimateInterface(global);

    const deleteFolderDialog = deleteFolderDialogModal ? selectChatFolder(global, deleteFolderDialogModal) : undefined;
    const isAccountFrozen = selectIsCurrentUserFrozen(global);
    const theme = selectTheme(global);
    const themeValues = selectThemeValues(global, theme);

    return {
      currentUserId,
      isLeftColumnOpen: isLeftColumnShown,
      isMiddleColumnOpen: Boolean(chatId),
      isRightColumnOpen: selectIsRightColumnShown(global, isMobile),
      isOwnProfileOpen: Boolean(
        isMobile && selectIsRightColumnShown(global, isMobile) && selectTabState(global).chatInfo.isOwnProfile,
      ),
      isMediaViewerOpen: selectIsMediaViewerOpen(global),
      isStoryViewerOpen: selectIsStoryViewerOpen(global),
      isForwardModalOpen: selectIsForwardModalOpen(global),
      isReactionPickerOpen: selectIsReactionPickerOpen(global),
      isHistoryCalendarOpen: Boolean(historyCalendarSelectedAt),
      shouldSkipHistoryAnimations,
      openedStickerSetShortName,
      openedCustomEmojiSetIds,
      isServiceChatReady: selectIsServiceChatReady(global),
      activeGroupCallId: isMasterTab ? global.groupCalls.activeGroupCallId : undefined,
      withInterfaceAnimations: selectCanAnimateInterface(global),
      wasTimeFormatSetManually,
      isPhoneCallActive: isMasterTab ? Boolean(global.phoneCall) : undefined,
      addedSetIds: global.stickers.added.setIds,
      addedCustomEmojiIds: global.customEmojis.added.setIds,
      newContactUserId: newContact?.userId,
      newContactByPhoneNumber: newContact?.isByPhoneNumber,
      openedGame,
      gameTitle,
      isRatePhoneCallModalOpen: Boolean(ratingPhoneCall),
      botTrustRequest,
      botTrustRequestBot: botTrustRequest && selectUser(global, botTrustRequest.botId),
      requestedAttachBotInChat,
      requestedBotStartGroup,
      isCurrentUserPremium: selectIsCurrentUserPremium(global),
      isPremiumModalOpen: premiumModal?.isOpen,
      isGiveawayModalOpen: giveawayModal?.isOpen,
      isDeleteMessageModalOpen: Boolean(deleteMessageModal),
      isStarsGiftingPickerModal: starsGiftingPickerModal?.isOpen,
      limitReached: limitReachedModal?.limit,
      isPaymentModalOpen: payment.isPaymentModalOpen,
      isReceiptModalOpen: Boolean(payment.receipt),
      deleteFolderDialog,
      isMasterTab,
      requestedDraft,
      noRightColumnAnimation,
      isSynced: global.isSynced,
      isAccountFrozen,
      isAppConfigLoaded: global.isAppConfigLoaded,
      isFoldersSidebarShown: foldersPosition === FOLDERS_POSITION_LEFT && !isMobile && selectAreFoldersPresent(global),
      leftColumnContentKey: selectLeftColumnContentKey(global),
      settingsScreen: selectSettingsScreen(global),
      diceEmojies: global.appConfig?.diceEmojies,
      selectedGiftAuction,
      theme,
      customBackground: themeValues?.background,
      backgroundColor: themeValues?.backgroundColor,
      patternColor: themeValues?.patternColor,
      isBackgroundBlurred: themeValues?.isBlurred,
    };
  },
)(Main));
