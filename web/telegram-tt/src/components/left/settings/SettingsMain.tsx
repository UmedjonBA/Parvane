import { APP_REVISION } from 'virtual:git-info';
import type { FC } from '../../../lib/teact/teact';
import { memo, useEffect } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser } from '../../../api/types';
import type { ThemeKey } from '../../../types';
import type { ParvaneIconName } from '../../main/ParvaneIcon';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import { ALL_FOLDER_ID, APP_NAME, DEBUG, IS_BETA } from '../../../config';
import { getUserFullName } from '../../../global/helpers';
import { selectTheme, selectUser } from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { IS_MULTIACCOUNT_SUPPORTED } from '../../../util/browser/globalEnvironment';
import buildClassName from '../../../util/buildClassName';
import { getColorScheme } from '../../../util/colorScheme';
import {
  markContactsFromProfile, openKnowledgeView, openPlannerView, requestPlannerSettings,
} from '../../../util/parvaneSection';

import useDerivedState from '../../../hooks/useDerivedState';
import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import { SCHEME_NAMES } from '../../common/ColorSchemePicker';
import ParvaneIcon from '../../main/ParvaneIcon';
import ListItem from '../../ui/ListItem';
import SettingsAccounts from './SettingsAccounts';
import SettingsAppearanceModal from './SettingsAppearanceModal';
import SettingsMore from './SettingsMore';
import SettingsSignOut from './SettingsSignOut';

import styles from './SettingsMain.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  currentUserId?: string;
  currentUser?: ApiUser;
  // Названия папок чатов через запятую — подпись строки «Папки с чатами»
  folderNames?: string;
  theme: ThemeKey;
  shouldUseSystemTheme?: boolean;
  // Архив убран из списка чатов (настройка архива): тогда он открывается строкой здесь
  isArchiveHidden?: boolean;
};

const AVATAR_SIZE = 56;
const MAX_FOLDER_NAMES = 4;
const VERSION = IS_BETA ? `${APP_VERSION} Beta (${APP_REVISION})` : (DEBUG ? APP_REVISION : APP_VERSION);

// Parvane: «Профиль» — главный экран настроек по прототипу: карточка аккаунта, настройки мессенджера
// (прежние экраны Telegram) карточкой строк с плитками-значками и подписями, ниже карточка «Parvane».
// Сюда же перенесены пункты прежнего меню «☰» списка чатов: «Мой профиль» — карточка аккаунта, другие
// аккаунты — `SettingsAccounts`, «Избранное», «Архив» и «Контакты» — первые строки мессенджера, «Ещё» —
// `SettingsMore`, строка версии — внизу
const SettingsMain: FC<OwnProps & StateProps> = ({
  isActive,
  currentUserId,
  currentUser,
  folderNames,
  theme,
  shouldUseSystemTheme,
  isArchiveHidden,
  onReset,
}) => {
  const {
    loadAuthorizations,
    loadMoreProfilePhotos,
    openSettingsScreen,
    openChat,
    openChatWithInfo,
    openLeftColumnContent,
    closeForumPanel,
  } = getActions();

  const lang = useLang();
  const colorScheme = useDerivedState(getColorScheme);
  const [isAppearanceOpen, openAppearance, closeAppearance] = useFlag();

  useEffect(() => {
    if (currentUserId) {
      loadMoreProfilePhotos({ peerId: currentUserId, isPreload: true });
    }
  }, [currentUserId]);

  // Parvane: устройства могли добавиться/отозваться после старта приложения —
  // перечитываем список при каждом заходе в настройки
  useEffect(() => {
    if (isActive) {
      loadAuthorizations();
    }
  }, [isActive]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const handleOpenMyProfile = useLastCallback(() => {
    openChatWithInfo({ id: currentUserId, shouldReplaceHistory: true, isOwnProfile: true });
  });

  // Чат «Избранное» открывается вместе со списком чатов: на компьютере чат мог быть уже открыт справа, и
  // нажатие выглядело так, будто ничего не произошло
  const handleOpenSaved = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
    openChat({ id: currentUserId, shouldReplaceHistory: true });
  });

  const handleOpenArchived = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Archived });
    closeForumPanel();
  });

  const handleOpenContacts = useLastCallback(() => {
    markContactsFromProfile(true);
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleOpenPlannerSettings = useLastCallback(() => {
    requestPlannerSettings();
  });

  const handleOpenHealth = useLastCallback(() => {
    openPlannerView('health');
  });

  const handleOpenVault = useLastCallback(() => {
    openKnowledgeView('files');
  });

  // Адрес аккаунта — `имя@сервер`: в карточке он целиком, моноширинным
  const address = currentUserId?.includes('@') ? currentUserId : undefined;
  const modeName = lang(shouldUseSystemTheme ? 'ParvaneThemeSystem' : theme === 'dark'
    ? 'ParvaneThemeDark' : 'ParvaneThemeLight').toLowerCase();

  function renderRowContent(icon: ParvaneIconName, title: string, subtitle?: string) {
    return (
      <>
        <span className={styles.tile}><ParvaneIcon name={icon} isSmall /></span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{title}</span>
          {subtitle && <span className={styles.rowSubtitle}>{subtitle}</span>}
        </span>
        <ParvaneIcon name="right" isSmall className={styles.chevron} />
      </>
    );
  }

  // Строка настроек мессенджера: прежний `ListItem` (на нём стоят сценарии), вид — строки прототипа
  function renderListRow(icon: ParvaneIconName, title: string, onClick: NoneToVoidFunction, subtitle?: string) {
    return (
      <ListItem className={styles.screenRow} onClick={onClick}>
        {renderRowContent(icon, title, subtitle)}
      </ListItem>
    );
  }

  function renderScreenRow(icon: ParvaneIconName, title: string, screen: SettingsScreens, subtitle?: string) {
    return renderListRow(icon, title, () => openSettingsScreen({ screen }), subtitle);
  }

  function renderActionRow(icon: ParvaneIconName, title: string, subtitle: string, onClick: NoneToVoidFunction) {
    return (
      <button type="button" className={styles.row} onClick={onClick}>
        {renderRowContent(icon, title, subtitle)}
      </button>
    );
  }

  return (
    <div className={buildClassName(styles.root, 'settings-main-scroll', 'custom-scroll')}>
      <div className={styles.content}>
        <button
          type="button"
          className={buildClassName(styles.card, styles.account)}
          aria-label={lang('MenuMyProfile')}
          title={lang('MenuMyProfile')}
          onClick={handleOpenMyProfile}
        >
          {currentUser && <Avatar peer={currentUser} size={AVATAR_SIZE} className={styles.avatar} />}
          <span className={styles.accountInfo}>
            <span className={styles.accountName}>{currentUser ? getUserFullName(currentUser) : ''}</span>
            {address && <span className={styles.accountAddress}>{address}</span>}
          </span>
          <ParvaneIcon name="right" isSmall className={styles.chevron} />
        </button>
        {IS_MULTIACCOUNT_SUPPORTED && currentUser && <SettingsAccounts currentUser={currentUser} />}

        <div className={styles.caption}>{lang('ParvaneProfileMessenger')}</div>
        <div className={styles.card}>
          {renderListRow('star', lang('MenuSavedMessages'), handleOpenSaved)}
          {isArchiveHidden && renderListRow('folder', lang('MenuArchivedChats'), handleOpenArchived)}
          {renderListRow('users', lang('MenuContacts'), handleOpenContacts)}
          {renderScreenRow(
            'sliders', lang('TelegramGeneralSettingsViewController'), SettingsScreens.General,
            lang('ParvaneProfileGeneralHint'),
          )}
          {renderScreenRow('sun', lang('MenuAnimations'), SettingsScreens.Performance)}
          {renderScreenRow('bell', lang('Notifications'), SettingsScreens.Notifications)}
          {renderScreenRow('cloud', lang('DataSettings'), SettingsScreens.DataStorage, lang('ParvaneProfileDataHint'))}
          {renderScreenRow('user', lang('PrivacySettings'), SettingsScreens.Privacy, lang('ParvaneProfilePrivacyHint'))}
          {renderScreenRow('chat', lang('Filters'), SettingsScreens.Folders, folderNames)}
          {renderScreenRow(
            'link', lang('Devices'), SettingsScreens.ActiveSessions, lang('ParvaneProfileDevicesHint'),
          )}
          {renderScreenRow('book', lang('Language'), SettingsScreens.Language, lang.languageInfo.nativeName)}
          {renderScreenRow('smile', lang('MenuStickers'), SettingsScreens.Stickers)}
          {/* Parvane: Premium/Stars/Gram/подарки и справка Telegram (Ask a
              Question, FAQ, Privacy Policy) — инфраструктура Telegram, скрыты */}
        </div>

        <div className={styles.caption}>Parvane</div>
        <div className={styles.card}>
          {renderActionRow(
            'sliders', lang('PlannerSettings'), lang('ParvaneProfilePlanHint'), handleOpenPlannerSettings,
          )}
          {renderActionRow(
            'heart', lang('ParvaneProfileHealthGoals'), lang('ParvaneProfileHealthHint'), handleOpenHealth,
          )}
          {renderActionRow('cloud', lang('ParvaneProfileVault'), lang('ParvaneProfileVaultHint'), handleOpenVault)}
          {renderActionRow(
            'sun', lang('ParvaneAppearance'), `${SCHEME_NAMES[colorScheme]} · ${modeName}`, openAppearance,
          )}
        </div>

        <SettingsMore />
        <SettingsSignOut />
        <div className={styles.version}>{`${APP_NAME} ${VERSION}`}</div>
      </div>
      <SettingsAppearanceModal
        isOpen={isAppearanceOpen}
        theme={theme}
        shouldUseSystemTheme={shouldUseSystemTheme}
        onClose={closeAppearance}
      />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentUserId, chatFolders, archiveSettings } = global;
    const folderNames = chatFolders.orderedIds
      ?.filter((id) => id !== ALL_FOLDER_ID)
      .map((id) => chatFolders.byId[id]?.title.text)
      .filter(Boolean)
      .slice(0, MAX_FOLDER_NAMES)
      .join(', ');

    return {
      currentUserId,
      currentUser: currentUserId ? selectUser(global, currentUserId) : undefined,
      folderNames: folderNames || undefined,
      theme: selectTheme(global),
      shouldUseSystemTheme: selectSharedSettings(global).shouldUseSystemTheme,
      isArchiveHidden: archiveSettings.isHidden,
    };
  },
)(SettingsMain));
