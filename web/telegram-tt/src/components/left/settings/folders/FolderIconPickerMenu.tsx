import { memo } from '@teact';

import { FOLDER_ICON_EMOJIS } from '../../../../util/folderIconMap';

import useLastCallback from '../../../../hooks/useLastCallback';

import FolderIcon from '../../../common/FolderIcon';
import Menu from '../../../ui/Menu';

export type OwnProps = {
  isOpen: boolean;
  onEmojiSelect: (emoji: string) => void;
  onClose: () => void;
};

// Parvane: сетка значков Telegram Desktop. Собственных эмодзи в выборе нет: в личном состоянии у папки
// есть только `emoticon`, и собственный эмодзи не доехал бы до других устройств
const FolderIconPickerMenu = ({
  isOpen,
  onEmojiSelect,
  onClose,
}: OwnProps) => {
  const handleClick = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    onEmojiSelect(e.currentTarget.dataset.emoji!);
    onClose();
  });

  return (
    <Menu
      isOpen={isOpen}
      positionX="left"
      onClose={onClose}
      withPortal
      className="settings-folders-icon-picker-menu"
    >
      <div className="settings-folders-icon-picker-menu-folders" role="listbox">
        {FOLDER_ICON_EMOJIS.map((emoji) => (
          <div
            key={emoji}
            className="EmojiButton"
            role="option"
            aria-label={emoji}
            data-emoji={emoji}
            onClick={handleClick}
          >
            <FolderIcon emoji={emoji} />
          </div>
        ))}
      </div>
    </Menu>
  );
};

export default memo(FolderIconPickerMenu);
