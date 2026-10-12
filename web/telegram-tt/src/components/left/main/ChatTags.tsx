import { memo } from '@teact';

import { type ApiChatFolder, ApiMessageEntityTypes } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import { REM } from '../../common/helpers/mediaDimensions';
import { renderTextWithEntities } from '../../common/helpers/renderTextWithEntities';

import { getPeerColorClass } from '../../../hooks/usePeerColor';

import styles from './ChatTags.module.scss';

const MAX_VISIBLE_TAGS = 3;
// Parvane: метка стоит в строке названия чата, места там на одну папку — остальные счётчиком «+N»
const MAX_VISIBLE_INLINE_TAGS = 1;
const CUSTOM_EMOJI_SIZE = 0.875 * REM;

type OwnProps = {
  orderedFolderIds?: number[];
  chatFoldersById?: Record<number, ApiChatFolder>;
  isFoldersSidebarShown?: boolean;
  itemClassName?: string;
  // Parvane: цвета папок, те же, что у чипов над списком (`util/folderColors.ts`); с ними метка рисуется
  // по прототипу — в строке названия, тоном папки
  colorsById?: Record<number, string>;
};

const ChatTags = ({
  orderedFolderIds,
  chatFoldersById,
  isFoldersSidebarShown,
  itemClassName,
  colorsById,
}: OwnProps) => {
  if (!orderedFolderIds) {
    return undefined;
  }

  const isInline = Boolean(colorsById);
  const visibleFolderIds = orderedFolderIds.slice(0, isInline ? MAX_VISIBLE_INLINE_TAGS : MAX_VISIBLE_TAGS);
  const remainingCount = orderedFolderIds.length - visibleFolderIds.length;

  function getFolderTitle(folder: ApiChatFolder) {
    let text = folder.title.text;
    let entities = folder.title.entities;

    if (isFoldersSidebarShown) {
      const currentCustomEmoji = folder.title.entities?.find(
        (entity) => entity.type === ApiMessageEntityTypes.CustomEmoji && entity.offset === 0);
      if (currentCustomEmoji) {
        const { offset, length } = currentCustomEmoji;

        text = folder.title.text.replace(folder.title.text.substring(offset, offset + length), '');
        entities = folder.title.entities?.filter((entity) => entity.offset !== offset).map((entity) => ({
          ...entity,
          offset: entity.offset - length,
        }));
      }
    }
    return renderTextWithEntities({
      text,
      entities,
      noCustomEmojiPlayback: folder.noTitleAnimations,
      emojiSize: CUSTOM_EMOJI_SIZE,
    });
  };

  return (
    <div className={buildClassName(styles.wrapper, isInline && styles.inline)}>
      {visibleFolderIds.map((folderId) => {
        const folder = chatFoldersById?.[folderId];
        return folder && (
          <div
            key={folder.id}
            className={buildClassName(
              styles.tag,
              !isInline && folder.color !== undefined && folder.color !== -1 && getPeerColorClass(folder.color),
              itemClassName,
            )}
            style={isInline ? `--tag-color: ${colorsById[folderId]}` : undefined}
            data-folder-tag={isInline ? folderId : undefined}
          >
            {getFolderTitle(folder)}
          </div>
        );
      })}
      {remainingCount > 0 && (
        <div className={buildClassName(styles.tag, styles.tagColorMore, itemClassName)}>
          +
          {remainingCount}
        </div>
      )}
    </div>
  );
};

export default memo(ChatTags);
