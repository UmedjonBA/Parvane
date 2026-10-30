import { memo, useEffect, useRef } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { GlobalState } from '../../global/types';
import type { FolderEditDispatch } from '../../hooks/reducers/useFoldersReducer';

import buildClassName from '../../util/buildClassName';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';
import useScrolledState from '../../hooks/useScrolledState';
import useShowTransitionDeprecated from '../../hooks/useShowTransitionDeprecated';

import Button from '../ui/Button';
import DropdownMenu from '../ui/DropdownMenu';
import MenuItem from '../ui/MenuItem';
import ChatList from './main/ChatList';

import './ArchivedChats.scss';

export type OwnProps = {
  isActive: boolean;
  archiveSettings: GlobalState['archiveSettings'];
  onReset: () => void;
  foldersDispatch: FolderEditDispatch;
};

const ArchivedChats = ({
  isActive,
  archiveSettings,
  onReset,
  foldersDispatch,
}: OwnProps) => {
  const { updateArchiveSettings } = getActions();
  const containerRef = useRef<HTMLDivElement>();
  const lang = useOldLang();
  const { isAtBeginning, handleScroll, updateScrollState } = useScrolledState();
  const isScrolled = !isAtBeginning;

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const handleDisplayArchiveInChats = useLastCallback(() => {
    updateArchiveSettings({ isHidden: false });
  });

  const {
    shouldRender: shouldRenderTitle,
    transitionClassNames: titleClassNames,
  } = useShowTransitionDeprecated(true, undefined, undefined, false);

  useEffect(() => {
    if (!isActive) return;

    const chatList = containerRef.current?.querySelector<HTMLElement>('.chat-list') ?? undefined;
    updateScrollState(chatList);
  }, [isActive, updateScrollState]);

  return (
    <div ref={containerRef} className="ArchivedChats">
      <div
        className={buildClassName(
          'left-header',
          isScrolled && 'left-header-shadow',
        )}
      >
        {lang.isRtl && <div className="DropdownMenuFiller" />}
        <Button
          round
          size="smaller"
          color="translucent"
          onClick={onReset}
          ariaLabel="Return to chat list"
          className={buildClassName(
            lang.isRtl && 'rtl',
          )}
          iconName="arrow-left"
        />
        {shouldRenderTitle && <h3 className={titleClassNames}>{lang('ArchivedChats')}</h3>}
        {archiveSettings.isHidden && (
          <DropdownMenu
            className="archived-chats-more-menu"
            positionX="right"
          >
            <MenuItem icon="archive-from-main" onClick={handleDisplayArchiveInChats}>
              {lang('lng_context_archive_to_list')}
            </MenuItem>
          </DropdownMenu>
        )}
      </div>
      <div
        className={buildClassName(
          'chat-list-wrapper',
        )}
      >
        <ChatList
          folderType="archived"
          isActive={isActive}
          isMainList
          foldersDispatch={foldersDispatch}
          archiveSettings={archiveSettings}
          onScroll={handleScroll}
        />
      </div>
    </div>
  );
};

export default memo(ArchivedChats);
