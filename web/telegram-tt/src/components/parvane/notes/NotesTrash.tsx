import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { CloudNode } from '../cloud/cloudModel';

import buildClassName from '../../../util/buildClassName';
import { openFiles } from '../../../util/parvaneSection';
import { trashDaysLeft, trashOf } from '../cloud/cloudModel';
import {
  getCloudData, getNodes, restoreCloudNodes, setCloudPlace,
} from '../cloud/cloudStore';
import { formatNoteEdited } from './notesList';
import { getVaultPlace } from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './NotesHelp.module.scss';
import kit from './PvKit.module.scss';

const NOTE_EXTENSION = '.md';
const CANVAS_EXTENSION = '.canvas';

// Корзина «Заметок» (пункт «Корзина» колонки, доска `ZdNotesX`): заметки, холсты и папки хранилища, положенные в
// корзину «Файлов», — 30 дней их можно вернуть. Корзина общая с «Файлами»: здесь только узлы папки хранилища
const NotesTrash = () => {
  const lang = useLang();
  const data = useDerivedState(getCloudData);
  const [now] = useState(() => Date.now());

  const { drive, items } = useMemo(() => {
    const place = getVaultPlace(data);
    if (!place.drive || !place.vault) return { drive: place.drive, items: [] as CloudNode[] };
    const nodes = getNodes(place.drive, data);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const isInVault = (node: CloudNode) => {
      let parent = node.parent;
      while (parent) {
        if (parent === place.vault) return true;
        parent = byId.get(parent)?.parent;
      }
      return false;
    };
    return { drive: place.drive, items: trashOf(nodes).filter(isInVault) };
  }, [data]);

  const handleRestore = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const node = items.find(({ id }) => id === e.currentTarget.dataset.id);
    if (drive && node) void restoreCloudNodes(drive, [node]);
  });

  const handleOpenFiles = useLastCallback(() => {
    setCloudPlace({ view: 'trash' });
    openFiles();
  });

  function nameOf(node: CloudNode) {
    if (node.name.endsWith(NOTE_EXTENSION)) return node.name.slice(0, -NOTE_EXTENSION.length);
    return node.name.endsWith(CANVAS_EXTENSION) ? node.name.slice(0, -CANVAS_EXTENSION.length) : node.name;
  }

  function iconOf(node: CloudNode) {
    if (node.kind === 'folder') return 'folder';
    return node.name.endsWith(CANVAS_EXTENSION) ? 'board' : 'note';
  }

  return (
    <section className={buildClassName(styles.root, styles.screen, 'custom-scroll')} data-notes-trash>
      <header className={styles.head}>
        <h1 className={styles.title}>{lang('KnowledgeTrash')}</h1>
        <span className={styles.subtitle}>{lang('KnowledgeTrashHint')}</span>
      </header>
      {items.length ? (
        <div className={kit.card}>
          {items.map((node) => {
            const daysLeft = trashDaysLeft(node, now);
            return (
              <div key={node.id} className={styles.trashRow} data-notes-trash-item={nameOf(node)}>
                <PvIcon name={iconOf(node)} className={styles.trashIcon} />
                <span className={styles.trashText}>
                  <span className={styles.trashName}>{nameOf(node)}</span>
                  <span className={styles.trashMeta}>
                    {node.trashedAt ? `${lang('KnowledgeTrashDeleted', {
                      when: formatNoteEdited(lang, node.trashedAt, now),
                    })} · ` : ''}
                    {lang('ParvaneCloudTrashDaysLeft', { count: daysLeft }, { pluralValue: daysLeft })}
                  </span>
                </span>
                <button
                  type="button"
                  className={kit.btn}
                  data-id={node.id}
                  data-notes-trash-restore
                  onClick={handleRestore}
                >
                  {lang('KnowledgeTrashRestore')}
                </button>
              </div>
            );
          })}
        </div>
      ) : <p className={styles.empty} data-notes-trash-empty>{lang('KnowledgeTrashEmpty')}</p>}
      <div className={styles.actions}>
        <button type="button" className={buildClassName(kit.btn, kit.btnGhost)} onClick={handleOpenFiles}>
          {lang('KnowledgeTrashOpenFiles')}
        </button>
      </div>
    </section>
  );
};

export default memo(NotesTrash);
