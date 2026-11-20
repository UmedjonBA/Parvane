import type { TeactNode } from '../../lib/teact/teact';
import {
  memo, useLayoutEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getGlobal, withGlobal } from '../../global';

import {
  getCanPostInChat, getChatTitle, getGroupStatus, getHasAdminRight, getUserFullName, getUserStatus, isChatChannel,
  isDeletedUser, isSystemBot,
} from '../../global/helpers';
import { filterPeersByQuery } from '../../global/helpers/peers';
import {
  selectChat, selectChatFullInfo, selectPeer, selectUser, selectUserStatus,
} from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { unique } from '../../util/iteratees';
import sortChatIds from '../common/helpers/sortChatIds';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';

import Avatar from '../common/Avatar';
import ChatScreen from '../parvane/chatScreen/ChatScreen';

import screen from '../parvane/chatScreen/ChatScreen.module.scss';
import styles from './SendRecipientScreen.module.scss';

export type SendPreview = {
  title: string;
  subtitle?: string;
};

type OwnProps = {
  isOpen: boolean;
  // Что отправляется — карточка над поиском
  preview?: SendPreview;
  // Строки над подписью: дополнительные настройки отправки
  options?: TeactNode;
  onSend: (chatIds: string[], caption: string) => void;
  onClose: NoneToVoidFunction;
};

const AVATAR_SIZE = 40;

type StateProps = {
  currentUserId?: string;
  activeListIds?: string[];
  contactIds?: string[];
};

// Выбор получателей с подписью (доска `RpPick`, «Кому отправить»): что отправляется, поиск, чаты с галочками,
// внизу «Подпись, по желанию» и «Отправить в N чатов». Общий для пересылки и «Отправить в чат» из «Файлов»
const SendRecipientScreen = ({
  isOpen, preview, options, currentUserId, activeListIds, contactIds, onSend, onClose,
}: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [caption, setCaption] = useState('');

  // Экран всякий раз открывается пустым — до первого кадра
  useLayoutEffect(() => {
    if (!isOpen) return;
    setSearch('');
    setSelected([]);
    setCaption('');
  }, [isOpen]);

  const ids = useMemo(() => {
    if (!isOpen) return [];
    const global = getGlobal();
    const all = unique([
      ...(currentUserId ? [currentUserId] : []),
      ...(activeListIds || []),
      ...(contactIds || []),
    ]).filter(canSendTo);
    return sortChatIds(filterPeersByQuery({ ids: all, query: search }), undefined, undefined, currentUserId);

    function canSendTo(id: string) {
      if (isSystemBot(id)) return false;
      const user = selectUser(global, id);
      if (user) return !isDeletedUser(user);
      const chat = selectChat(global, id);
      if (!chat) return false;
      if (isChatChannel(chat)) return getHasAdminRight(chat, 'postMessages');
      const fullInfo = selectChatFullInfo(global, id);
      return !fullInfo || getCanPostInChat(chat, undefined, undefined, fullInfo);
    }
  }, [isOpen, currentUserId, activeListIds, contactIds, search]);

  const handleSearchChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.currentTarget.value);
  });

  const handleCaptionChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCaption(e.currentTarget.value);
  });

  const handleToggle = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const id = e.currentTarget.dataset.peerId!;
    setSelected((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));
  });

  // Подпись из поля при Enter: нажатие сразу после ввода приходит раньше отрисовки с новым состоянием
  const handleSend = useLastCallback((typed?: string) => {
    if (!selected.length) return;
    onSend(selected, (typed ?? caption).trim());
  });

  const handleSendClick = useLastCallback(() => handleSend());

  const handleCaptionKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    handleSend(e.currentTarget.value);
  });

  const footer = (
    <>
      <input
        className={screen.inp}
        type="text"
        aria-label={lang('SendPickerCaption')}
        placeholder={lang('SendPickerCaption')}
        value={caption}
        data-send-caption
        onChange={handleCaptionChange}
        onKeyDown={handleCaptionKeyDown}
      />
      <button
        type="button"
        className={screen.btn}
        disabled={!selected.length}
        data-send-submit
        onClick={handleSendClick}
      >
        {selected.length
          ? lang('SendPickerSendTo', { count: selected.length }, { pluralValue: selected.length })
          : lang('SelectChats')}
      </button>
    </>
  );

  return (
    <ChatScreen
      isOpen={isOpen}
      title={lang('SendPickerTitle')}
      className={styles.root}
      footer={footer}
      onClose={onClose}
    >
      <div className={styles.top} data-send-picker>
        {preview && (
          <div className={styles.preview} data-send-preview>
            <span className={styles.previewTitle} dir="auto">{preview.title}</span>
            {preview.subtitle && <span className={styles.previewSub} dir="auto">{preview.subtitle}</span>}
          </div>
        )}
        <input
          className={screen.inp}
          type="search"
          aria-label={lang('SendPickerSearch')}
          placeholder={lang('SendPickerSearch')}
          value={search}
          data-send-search
          onChange={handleSearchChange}
        />
      </div>
      {options}
      <div className={styles.list} role="list">
        {ids.map((id) => renderRow(id))}
        {!ids.length && <div className={screen.hint}>{lang('SendPickerNothing')}</div>}
      </div>
    </ChatScreen>
  );

  function renderRow(id: string) {
    const global = getGlobal();
    const peer = selectPeer(global, id);
    if (!peer) return undefined;
    const isSelf = id === currentUserId;
    const chat = selectChat(global, id);
    const user = chat ? undefined : selectUser(global, id);
    const userTitle = isSelf ? lang('SavedMessages') : getUserFullName(user) || '';
    const title = chat ? getChatTitle(lang, chat, isSelf) : userTitle;
    const subtitle = isSelf ? oldLang('SavedMessagesInfo')
      : chat ? getGroupStatus(lang, chat)
        : user ? getUserStatus(oldLang, user, selectUserStatus(global, id)) : undefined;
    const isChecked = selected.includes(id);
    return (
      <label
        key={id}
        role="listitem"
        className={buildClassName(styles.row, isChecked && styles.rowOn)}
        data-send-row={id}
      >
        <Avatar peer={peer} isSavedMessages={isSelf} size={AVATAR_SIZE} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle} dir="auto">{title}</span>
          {subtitle && <span className={styles.rowSub}>{subtitle}</span>}
        </span>
        <input
          type="checkbox"
          className={styles.check}
          checked={isChecked}
          aria-label={title}
          data-peer-id={id}
          onChange={handleToggle}
        />
      </label>
    );
  }
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => ({
  currentUserId: global.currentUserId,
  activeListIds: global.chats.listIds.active,
  contactIds: global.contactList?.userIds,
}))(SendRecipientScreen));
