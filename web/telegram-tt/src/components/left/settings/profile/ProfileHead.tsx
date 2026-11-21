import { memo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import type { ApiUser } from '../../../../api/types';
import type { ProfileIconName } from './ProfileIcon';
import { LeftColumnContent, SettingsScreens } from '../../../../types';

import { getUserFullName } from '../../../../global/helpers';
import { selectUser, selectUserFullInfo } from '../../../../global/selectors';
import buildClassName from '../../../../util/buildClassName';
import { markContactsFromProfile } from '../../../../util/parvaneSection';
import { formatProfileAddress, getProfileServer } from './profileFormat';
import { openProfileWindow } from './profileRequests';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import Avatar from '../../../common/Avatar';
import ProfileIcon from './ProfileIcon';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Profile.module.scss';

type OwnProps = {
  // `phone` — шапка экрана «Профиль», `desk` — верх «Обзора», `nav` — верх колонки компьютера
  variant: 'phone' | 'desk' | 'nav';
};

type StateProps = {
  currentUserId?: string;
  currentUser?: ApiUser;
  bio?: string;
};

const AVATAR_SIZES = { phone: 60, desk: 72, nav: 48 };
const HEAD_CLASSES = { phone: styles.headPhone, desk: styles.headDesk, nav: styles.headNav };

const ProfileHead = ({
  variant, currentUserId, currentUser, bio,
}: OwnProps & StateProps) => {
  const {
    openSettingsScreen, openChat, openLeftColumnContent, closeForumPanel,
  } = getActions();
  const lang = useLang();

  // Компьютер — окно «Мой профиль» поверх «Обзора» (доска `RdProfile`), телефон — экран (`XpProfile`)
  const handleEdit = useLastCallback(() => {
    if (variant === 'desk') {
      openProfileWindow('edit');
      return;
    }
    openSettingsScreen({ screen: SettingsScreens.EditProfile });
  });

  // Чат «Избранное» открывается вместе со списком чатов: «Профиль» на компьютере занимает всё окно
  const handleOpenSaved = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.ChatList });
    openChat({ id: currentUserId, shouldReplaceHistory: true });
  });

  const handleOpenContacts = useLastCallback(() => {
    markContactsFromProfile(true);
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  const handleOpenArchived = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Archived });
    closeForumPanel();
  });

  const isDesk = variant === 'desk';
  const address = formatProfileAddress(currentUser?.usernames?.[0]?.username, getProfileServer());

  function renderTile(
    id: string, icon: ProfileIconName, tone: string, title: string, hint: string, onClick: NoneToVoidFunction,
  ) {
    return (
      <button type="button" className={styles.tile} data-profile-item={id} onClick={onClick}>
        <ProfileIcon name={icon} className={tone} />
        <span className={styles.tileTitle}>{title}</span>
        {isDesk && <span className={styles.tileHint}>{hint}</span>}
      </button>
    );
  }

  return (
    <div className={buildClassName(styles.head, HEAD_CLASSES[variant])} data-profile-head={variant}>
      <div className={styles.headTop}>
        {currentUser && <Avatar peer={currentUser} size={AVATAR_SIZES[variant]} className={styles.headAvatar} />}
        <div className={styles.headText}>
          <div className={styles.headName}>{currentUser ? getUserFullName(currentUser) : ''}</div>
          {address && <div className={styles.headAddress}>{address}</div>}
          {isDesk && bio && <div className={styles.headBio}>{lang('ParvaneProfileBio', { bio })}</div>}
        </div>
        {variant === 'phone' && (
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('ParvaneProfileEdit')}
            title={lang('ParvaneProfileEdit')}
            data-profile-edit
            onClick={handleEdit}
          >
            <ProfileIcon name="pen" className={styles.muted} />
          </button>
        )}
        {isDesk && (
          <button type="button" className={kit.btn} data-profile-edit onClick={handleEdit}>
            {lang('Edit')}
          </button>
        )}
      </div>
      {variant !== 'nav' && (
        <div className={styles.tiles}>
          {renderTile(
            'saved', 'star', styles.toneAccent, lang('MenuSavedMessages'), lang('ParvaneProfileSavedHint'),
            handleOpenSaved,
          )}
          {renderTile(
            'contacts', 'contacts', styles.toneBlue, lang('MenuContacts'), lang('ParvaneProfileContactsHint'),
            handleOpenContacts,
          )}
          {renderTile(
            'archive', 'archive', styles.muted, lang('MenuArchivedChats'), lang('ParvaneProfileArchiveHint'),
            handleOpenArchived,
          )}
        </div>
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentUserId } = global;
    return {
      currentUserId,
      currentUser: currentUserId ? selectUser(global, currentUserId) : undefined,
      bio: currentUserId ? selectUserFullInfo(global, currentUserId)?.bio : undefined,
    };
  },
)(ProfileHead));
