import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';

import buildClassName from '../../../util/buildClassName';
import { childrenOf, sortNodes } from '../cloud/cloudModel';
import { drivePathOf, formatCardSize } from './notesCanvasFiles';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';
import PvSheet from './PvSheet';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Узлы личного диска
  nodes: CloudNode[];
  onPick: (path: string) => void;
  onClose: NoneToVoidFunction;
};

const BY_NAME = { key: 'name', isDescending: false } as const;

// Выбор файла личного диска для карточки холста: папки открываются, файл выбирается нажатием
const CanvasFilePicker = ({
  isOpen, nodes, onPick, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [folderId, setFolderId] = useState<string>();
  const folder = folderId ? nodes.find(({ id }) => id === folderId && !trashedIn(nodes, id)) : undefined;
  // Папки идут первыми, корзина в список не попадает
  const rows = useMemo(() => sortNodes(childrenOf(nodes, folder?.id), BY_NAME), [nodes, folder]);

  const handleUp = useLastCallback(() => setFolderId(folder?.parent));

  const handleRow = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const node = nodes.find(({ id }) => id === e.currentTarget.dataset.id);
    if (!node) return;
    if (node.kind === 'folder') {
      setFolderId(node.id);
      return;
    }
    onPick(drivePathOf(nodes, node.id));
  });

  return (
    <PvSheet
      isOpen={isOpen}
      title={folder ? folder.name : lang('KnowledgeCanvasFileChoose')}
      headBefore={folder ? (
        <button type="button" className={kit.ib} aria-label={lang('Back')} onClick={handleUp}>
          <PvIcon name="left" />
        </button>
      ) : undefined}
      isTight
      onClose={onClose}
    >
      {!rows.length && <p className={styles.mutedLine}>{lang('KnowledgeCanvasFileEmpty')}</p>}
      {rows.map((node) => (
        <button
          key={node.id}
          type="button"
          className={kit.row}
          data-id={node.id}
          data-canvas-file-row={node.name}
          onClick={handleRow}
        >
          <span className={buildClassName(kit.ava, kit.avaM)}>
            <PvIcon name={node.kind === 'folder' ? 'folder' : 'file'} isSmall />
          </span>
          <span className={kit.rowText}>
            <span className={kit.ttl}>{node.name}</span>
            {node.kind === 'file' && <span className={kit.sub}>{formatCardSize(node.size)}</span>}
          </span>
          {node.kind === 'folder' && <PvIcon name="right" isSmall />}
        </button>
      ))}
    </PvSheet>
  );
};

// Папка сама либо любая из её родительских лежит в корзине
function trashedIn(nodes: CloudNode[], id: string) {
  let current = nodes.find((node) => node.id === id);
  for (let depth = 0; current && depth <= nodes.length; depth++) {
    if (current.trashed) return true;
    const parent = current.parent;
    current = parent ? nodes.find((node) => node.id === parent) : undefined;
  }
  return false;
}

export default memo(CanvasFilePicker);
