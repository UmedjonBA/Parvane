import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import { LeftColumnContent } from '../../../types';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../../parvane/notes/PvEmpty';

import styles from './ChatListEmpty.module.scss';

// Parvane (spec 041 E6): чатов нет вовсе — «пусто» по образцу модулей (доска `PhStates`): призрак, заголовок,
// пояснение и «Новое сообщение» — тот же переход, что пункт меню «Написать»
const ChatListEmpty = () => {
  const { openLeftColumnContent } = getActions();
  const lang = useLang();

  const handleNewMessage = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
  });

  return (
    <PvEmpty
      className={styles.root}
      title={lang('PvChatsEmptyTitle')}
      text={lang('PvChatsEmptyText')}
      actionText={lang('NewMessageTitle')}
      data-chats-empty
      onAction={handleNewMessage}
    />
  );
};

export default memo(ChatListEmpty);
