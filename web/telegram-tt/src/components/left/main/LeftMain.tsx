import type { Update } from '@tauri-apps/plugin-updater';
import type { FC } from '../../../lib/teact/teact';
import { memo, useEffect, useState } from '../../../lib/teact/teact';

import type { FolderEditDispatch } from '../../../hooks/reducers/useFoldersReducer';
import { LeftColumnContent } from '../../../types';

import { DEBUG } from '../../../config';
import { IS_TAURI } from '../../../util/browser/globalEnvironment';
import buildClassName from '../../../util/buildClassName';

import useInterval from '../../../hooks/schedulers/useInterval';
import useForumPanelRender from '../../../hooks/useForumPanelRender';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useShowTransitionDeprecated from '../../../hooks/useShowTransitionDeprecated';

import Button from '../../ui/Button';
import Transition from '../../ui/Transition';
import LeftSearch from '../search/LeftSearch.async';
import ChatFolders from './ChatFolders';
import ContactList from './ContactList.async';
import ForumPanel from './forum/ForumPanel';
import LeftMainHeader from './LeftMainHeader';

import './LeftMain.scss';

type OwnProps = {
  content: LeftColumnContent;
  searchQuery?: string;
  searchDate?: number;
  contactsFilter: string;
  shouldSkipTransition?: boolean;
  foldersDispatch: FolderEditDispatch;
  isAppUpdateAvailable?: boolean;
  isForumPanelOpen?: boolean;
  isClosingSearch?: boolean;
  onSearchQuery: (query: string) => void;
  onTopicSearch: NoneToVoidFunction;
  isAccountFrozen?: boolean;
  onReset: () => void;
  isFoldersSidebarShown?: boolean;
};

const TRANSITION_RENDER_COUNT = Object.keys(LeftColumnContent).length / 2;
const TAURI_CHECK_UPDATE_INTERVAL = 10 * 60 * 1000;

const LeftMain: FC<OwnProps> = ({
  content,
  searchQuery,
  searchDate,
  isClosingSearch,
  contactsFilter,
  shouldSkipTransition,
  foldersDispatch,
  isAppUpdateAvailable,
  isForumPanelOpen,
  onSearchQuery,
  onReset,
  onTopicSearch,
  isAccountFrozen,
  isFoldersSidebarShown,
}) => {
  const [tauriUpdate, setTauriUpdate] = useState<Update>();
  const [isTauriUpdateDownloading, setIsTauriUpdateDownloading] = useState(false);

  const {
    shouldRenderForumPanel, handleForumPanelAnimationEnd,
    handleForumPanelAnimationStart, isAnimationStarted,
  } = useForumPanelRender(isForumPanelOpen);
  const isForumPanelRendered = isForumPanelOpen && content === LeftColumnContent.ChatList;
  const isForumPanelVisible = isForumPanelRendered && isAnimationStarted;

  const {
    shouldRender: shouldRenderUpdateButton,
    transitionClassNames: updateButtonClassNames,
  } = useShowTransitionDeprecated(isAppUpdateAvailable || Boolean(tauriUpdate));

  const handleUpdateClick = useLastCallback(async () => {
    if (tauriUpdate) {
      try {
        setIsTauriUpdateDownloading(true);
        await tauriUpdate.downloadAndInstall();
        setIsTauriUpdateDownloading(false);

        await window.tauri?.relaunch();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to download and install Tauri update', e);
      } finally {
        setIsTauriUpdateDownloading(false);
      }
    } else {
      window.location.reload();
    }
  });

  const checkTauriUpdate = useLastCallback(() => {
    window.tauri?.checkUpdate()
      .then((update) => setTauriUpdate(update ?? undefined))
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('Tauri update check failed:', e);
      });
  });

  useEffect(() => {
    checkTauriUpdate();
  }, []);

  useInterval(
    checkTauriUpdate,
    (IS_TAURI && !DEBUG) ? TAURI_CHECK_UPDATE_INTERVAL : undefined,
  );

  const lang = useLang();

  return (
    <div id="LeftColumn-main">
      <LeftMainHeader
        shouldHideSearch={isForumPanelVisible}
        content={content}
        contactsFilter={contactsFilter}
        onSearchQuery={onSearchQuery}
        onReset={onReset}
        shouldSkipTransition={shouldSkipTransition}
        isClosingSearch={isClosingSearch}
        isFoldersSidebarShown={isFoldersSidebarShown}
      />
      <Transition
        name={shouldSkipTransition ? 'none' : 'zoomFade'}
        renderCount={TRANSITION_RENDER_COUNT}
        activeKey={content}
        shouldCleanup
        cleanupExceptionKey={LeftColumnContent.ChatList}
        shouldWrap
        wrapExceptionKey={LeftColumnContent.ChatList}
      >
        {(isActive) => {
          switch (content) {
            case LeftColumnContent.ChatList:
              return (
                <ChatFolders
                  foldersDispatch={foldersDispatch}
                  isForumPanelOpen={isForumPanelVisible}
                  isFoldersSidebarShown={isFoldersSidebarShown}
                />
              );
            case LeftColumnContent.GlobalSearch:
              return (
                <LeftSearch
                  searchQuery={searchQuery}
                  searchDate={searchDate}
                  isActive={isActive}
                  onReset={onReset}
                />
              );
            case LeftColumnContent.Contacts:
              return <ContactList filter={contactsFilter} isActive={isActive} onReset={onReset} />;
            default:
              return undefined;
          }
        }}
      </Transition>
      {shouldRenderUpdateButton && (
        <Button
          fluid
          badge
          className={buildClassName('btn-update', updateButtonClassNames)}
          onClick={handleUpdateClick}
          isLoading={isTauriUpdateDownloading}
        >
          {lang('UpdateTelegram')}
        </Button>
      )}
      {shouldRenderForumPanel && (
        <ForumPanel
          isOpen={isForumPanelOpen}
          isHidden={!isForumPanelRendered}
          onTopicSearch={onTopicSearch}
          onOpenAnimationStart={handleForumPanelAnimationStart}
          onCloseAnimationEnd={handleForumPanelAnimationEnd}
        />
      )}
      {/* Parvane: карандаша Telegram нет. Новое сообщение, группа, канал и запись в план — в меню «Написать»
          шапки списка (компьютер) и в меню «+» нижней панели (телефон) */}
    </div>
  );
};

export default memo(LeftMain);
