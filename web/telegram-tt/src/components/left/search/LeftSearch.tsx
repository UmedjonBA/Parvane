import type { FC } from '../../../lib/teact/teact';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { RegularLangKey } from '../../../types/language';
import { type AnimationLevel, GlobalSearchContent } from '../../../types';

import { selectTabState } from '../../../global/selectors';
import { selectSharedSettings } from '../../../global/selectors/sharedState';
import { parseDateString } from '../../../util/dates/oldDateFormat';
import { resolveTransitionName } from '../../../util/resolveTransitionName';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useKeyboardListNavigation from '../../../hooks/useKeyboardListNavigation';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import SquareTabList from '../../ui/SquareTabList';
import Transition from '../../ui/Transition';
import AudioResults from './AudioResults';
import ChatMessageResults from './ChatMessageResults';
import ChatResults from './ChatResults';
import FileResults from './FileResults';
import LinkResults from './LinkResults';
import MediaResults from './MediaResults';

import './LeftSearch.scss';

export type OwnProps = {
  searchQuery?: string;
  searchDate?: number;
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  currentContent?: GlobalSearchContent;
  chatId?: string;
  animationLevel: AnimationLevel;
};

type TabInfo = {
  type: GlobalSearchContent;
  key: RegularLangKey;
};

const TABS: TabInfo[] = [
  { type: GlobalSearchContent.ChatList, key: 'SearchTabChats' },
  { type: GlobalSearchContent.ChannelList, key: 'SearchTabChannels' },
  // Parvane: вкладок «Приложения» (мини-приложения ботов) и «Публичные посты» нет — этих функций нет
  { type: GlobalSearchContent.Media, key: 'SearchTabMedia' },
  { type: GlobalSearchContent.Links, key: 'SearchTabLinks' },
  { type: GlobalSearchContent.Files, key: 'SearchTabFiles' },
  { type: GlobalSearchContent.Music, key: 'SearchTabMusic' },
  { type: GlobalSearchContent.Voice, key: 'SearchTabVoice' },
];

const CHAT_TABS: TabInfo[] = [
  { type: GlobalSearchContent.ChatList, key: 'SearchTabMessages' },
  ...TABS.slice(2), // Skip ChatList and ChannelList, replaced with All Messages
];

const LeftSearch: FC<OwnProps & StateProps> = ({
  searchQuery,
  searchDate,
  isActive,
  currentContent = GlobalSearchContent.ChatList,
  chatId,
  animationLevel,
  onReset,
}) => {
  const {
    setGlobalSearchContent,
    setGlobalSearchDate,
    checkSearchPostsFlood,
  } = getActions();

  const lang = useLang();
  const [activeTab, setActiveTab] = useState(currentContent);
  const dateSearchQuery = useMemo(() => parseDateString(searchQuery), [searchQuery]);

  useEffect(() => {
    if (isActive) {
      checkSearchPostsFlood({});
    }
  }, [isActive]);

  const tabs = useMemo(() => {
    const arr = chatId ? CHAT_TABS : TABS;
    return arr.map((tab) => ({
      ...tab,
      title: lang(tab.key),
    }));
  }, [chatId, lang]);

  const handleSwitchTab = useLastCallback((index: number) => {
    const tab = tabs[index];
    setGlobalSearchContent({ content: tab.type });
    setActiveTab(index);
  });

  const handleSearchDateSelect = useLastCallback((value: Date) => {
    setGlobalSearchDate({ date: value.getTime() / 1000 });
  });

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const containerRef = useRef<HTMLDivElement>();
  const handleKeyDown = useKeyboardListNavigation(containerRef, isActive, undefined, '.ListItem-button', true);

  return (
    <div className="LeftSearch" ref={containerRef} onKeyDown={handleKeyDown}>
      <SquareTabList activeTab={activeTab} tabs={tabs} onSwitchTab={handleSwitchTab} />
      <Transition
        name={resolveTransitionName('slideOptimized', animationLevel, undefined, lang.isRtl)}
        renderCount={tabs.length}
        activeKey={currentContent}
      >
        {(() => {
          switch (currentContent) {
            case GlobalSearchContent.ChatList:
            case GlobalSearchContent.ChannelList:
              if (chatId) {
                return (
                  <ChatMessageResults
                    searchQuery={searchQuery}
                    dateSearchQuery={dateSearchQuery}
                    onReset={onReset}
                    onSearchDateSelect={handleSearchDateSelect}
                  />
                );
              }
              return (
                <ChatResults
                  isChannelList={currentContent === GlobalSearchContent.ChannelList}
                  searchQuery={searchQuery}
                  searchDate={searchDate}
                  dateSearchQuery={dateSearchQuery}
                  onReset={onReset}
                  onSearchDateSelect={handleSearchDateSelect}
                />
              );
            case GlobalSearchContent.Media:
              return <MediaResults searchQuery={searchQuery} />;
            case GlobalSearchContent.Links:
              return <LinkResults searchQuery={searchQuery} />;
            case GlobalSearchContent.Files:
              return <FileResults searchQuery={searchQuery} />;
            case GlobalSearchContent.Music:
              return (
                <AudioResults
                  key="audio"
                  searchQuery={searchQuery}
                />
              );
            case GlobalSearchContent.Voice:
              return (
                <AudioResults
                  key="voice"
                  isVoice
                  searchQuery={searchQuery}
                />
              );
            default:
              return undefined;
          }
        })()}
      </Transition>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { currentContent, chatId } = selectTabState(global).globalSearch;
    const { animationLevel } = selectSharedSettings(global);

    return { currentContent, chatId, animationLevel };
  },
)(LeftSearch));
