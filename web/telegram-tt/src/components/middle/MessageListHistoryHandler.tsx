import { memo, useEffect } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { MessageList as GlobalMessageList } from '../../types';

import { selectTabState } from '../../global/selectors';
import { createLocationHash, dropChatLocationHash } from '../../util/routing';

import useHistoryBack from '../../hooks/useHistoryBack';

const HASH_SETTLE_MS = 700;

type StateProps = {
  messageLists?: GlobalMessageList[];
};

// Actual `MessageList` components are unmounted when deep in the history,
// so we need a separate component just for handling history
const MessageListHistoryHandler = ({ messageLists }: StateProps) => {
  const { openChat } = getActions();

  // Parvane: чатов на экране нет — номер последнего чата из адреса убирается (с задержкой: очередь
  // истории браузера отрабатывает не сразу, а чат мог закрыться ради открытия другого)
  const hasChats = Boolean(messageLists?.length);
  useEffect(() => {
    if (hasChats) return undefined;
    const timeout = window.setTimeout(dropChatLocationHash, HASH_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [hasChats]);

  const closeChat = () => {
    openChat({ id: undefined }, { forceSyncOnIOs: true });
  };

  return (
    <div>
      {messageLists?.map((messageList, i) => (
        <MessageHistoryRecord
          key={`${messageList.chatId}_${messageList.threadId}_${messageList.type}_${i}`}
          {...messageList}
          onBack={closeChat}
        />
      ))}
    </div>
  );
};

const MessageHistoryRecord = ({
  chatId, type, threadId, onBack,
}: GlobalMessageList & { onBack: NoneToVoidFunction }) => {
  useHistoryBack({
    isActive: true,
    hash: createLocationHash(chatId, type, threadId),
    onBack,
  });

  return undefined;
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      messageLists: selectTabState(global).messageLists,
    };
  },
)(MessageListHistoryHandler));
