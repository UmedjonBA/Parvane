import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useMemo,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiUser, ApiUserStatus } from '../../../api/types';
import { LeftColumnContent, StoryViewerOrigin } from '../../../types';

import { sortUserIds } from '../../../global/helpers';
import { filterPeersByQuery } from '../../../global/helpers/peers';
import { getIsContactsFromProfile } from '../../../util/parvaneSection';

import useAppLayout from '../../../hooks/useAppLayout';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useInfiniteScroll from '../../../hooks/useInfiniteScroll';
import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import PrivateChatInfo from '../../common/PrivateChatInfo';
import FloatingActionButton from '../../ui/FloatingActionButton';
import InfiniteScroll from '../../ui/InfiniteScroll';
import ListItem from '../../ui/ListItem';
import Loading from '../../ui/Loading';
import ContactListRemote from './ContactListRemote';

import styles from './ContactList.module.scss';

export type OwnProps = {
  filter: string;
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  usersById: Record<string, ApiUser>;
  userStatusesById: Record<string, ApiUserStatus>;
  contactIds?: string[];
};

const ContactList: FC<OwnProps & StateProps> = ({
  isActive,
  filter,
  usersById,
  userStatusesById,
  contactIds,
  onReset,
}) => {
  const {
    openChat,
    openNewContactDialog,
    loadContactList,
    openLeftColumnContent,
  } = getActions();

  // Parvane: первая загрузка списка (Main, по isSynced) могла сорваться при
  // обрыве соединения — экран крутил спиннер до reload. Повторяем при открытии
  useEffect(() => {
    if (!contactIds) loadContactList();
  }, [contactIds, loadContactList]);

  const lang = useOldLang();
  const langNew = useLang();
  const { isMobile } = useAppLayout();
  // Доска `ZpChat2`: «Новое сообщение» — над контактами «Новая группа» и «Новый канал», ниже — ник с другого
  // сервера; «Контакты» из «Профиля» — только список с числом и пояснением
  const isNewMessage = !getIsContactsFromProfile();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const handleClick = useCallback((id: string) => {
    openChat({ id, shouldReplaceHistory: true });
  }, [openChat]);

  const listIds = useMemo(() => {
    if (!contactIds) {
      return undefined;
    }

    const filteredIds = filterPeersByQuery({ ids: contactIds, query: filter, type: 'user' });

    return sortUserIds(filteredIds, usersById, userStatusesById);
  }, [contactIds, filter, usersById, userStatusesById]);

  const [viewportIds, getMore] = useInfiniteScroll(undefined, listIds, Boolean(filter));
  const contactCount = listIds?.length || 0;

  const handleNewGroup = useCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewGroupStep1 });
  }, [openLeftColumnContent]);

  const handleNewChannel = useCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.NewChannelStep1 });
  }, [openLeftColumnContent]);

  return (
    <InfiniteScroll items={viewportIds} onLoadMore={getMore} className="chat-list custom-scroll">
      {isNewMessage && !filter && (
        <div key="create" className={styles.create}>
          <ListItem icon="group" className="chat-item-clickable" onClick={handleNewGroup}>
            {lang('NewGroup')}
          </ListItem>
          <ListItem icon="channel" className="chat-item-clickable" onClick={handleNewChannel}>
            {lang('NewChannel')}
          </ListItem>
        </div>
      )}
      {Boolean(contactCount) && (
        <div key="caption" className={styles.caption}>
          {langNew('ParvaneContactsCount', { count: contactCount }, { pluralValue: contactCount })}
        </div>
      )}
      {viewportIds?.length ? (
        viewportIds.map((id) => (
          <ListItem
            key={id}
            className="chat-item-clickable contact-list-item"
            onClick={() => handleClick(id)}
          >
            <PrivateChatInfo
              userId={id}
              forceShowSelf
              avatarSize="large"
              withStory
              storyViewerOrigin={StoryViewerOrigin.ChatList}
              ripple={!isMobile}
            />
          </ListItem>
        ))
      ) : viewportIds && !viewportIds.length ? (
        <p className="no-results" key="no-results" dir="auto">
          {filter.length ? lang('ParvaneContactsNoMatch') : lang('ParvaneContactsEmpty')}
        </p>
      ) : (
        <Loading key="loading" />
      )}
      {isNewMessage ? <ContactListRemote key="remote" /> : (
        <p key="hint" className={styles.hint}>{langNew('ParvaneContactsHint')}</p>
      )}
      <FloatingActionButton
        key="create-new-contact"
        isShown
        onClick={openNewContactDialog}
        ariaLabel={lang('CreateNewContact')}
        iconName="add-user-filled"
      />
    </InfiniteScroll>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { userIds: contactIds } = global.contactList || {};
    const { byId: usersById, statusesById: userStatusesById } = global.users;

    return {
      usersById,
      userStatusesById,
      contactIds,
    };
  },
)(ContactList));
