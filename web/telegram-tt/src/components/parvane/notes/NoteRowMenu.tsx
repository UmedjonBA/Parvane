import { memo, useLayoutEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { NoteMenuAnchor, NoteMenuItem } from './NoteMenu';
import type { NoteEntry } from './notesStore';

import { copyTextToClipboard } from '../../../util/clipboard';
import { getCloudData } from '../cloud/cloudStore';
import { isDayTitle } from './notesLook';
import { changeNotesMeta, getNotesMeta } from './notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ConfirmDialog from '../../ui/ConfirmDialog';
import CloudVersionsDialog from '../cloud/CloudVersionsDialog';
import NoteArticleDialog from './NoteArticleDialog';
import NoteCanvasSheet from './NoteCanvasSheet';
import NoteMenu from './NoteMenu';
import NoteRenameSheet from './NoteRenameSheet';

export type NoteRowKeyAction = 'rename' | 'delete';

type OwnProps = {
  // Заметка, по строке которой нажата правая кнопка; нет — меню закрыто
  note?: NoteEntry;
  // Компьютер: меню у курсора; без точки — шторка (телефон)
  anchor?: NoteMenuAnchor;
  // F2 / Del по строке: сразу окно пункта, без меню
  keyAction?: NoteRowKeyAction;
  onOpen: (noteId: string) => void;
  onOpenCanvas: (canvasId: string) => void;
  onRename: (noteId: string, title: string) => void;
  onPickFolder: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onClose: NoneToVoidFunction;
};

// Сочетания клавиш пунктов меню у строки (доска `ZdNotesX`): названия клавиш не переводятся
const KEY_HINTS: Record<string, string> = { open: 'Enter', rename: 'F2', delete: 'Del' };

// Окно, открытое пунктом меню: оно живёт дольше самого меню
type Pending = { kind: 'canvas' | 'article' | 'versions' | 'rename' | 'delete'; note: NoteEntry };

// Меню строки списка заметок на компьютере (доска `ZdNotesX`): те же действия, что в меню открытой заметки, без
// открытия заметки. Список и холст на компьютере рядом не стоят — заметку на холст кладут отсюда
const NoteRowMenu = ({
  note, anchor, keyAction, onOpen, onOpenCanvas, onRename, onPickFolder, onDelete, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [pending, setPending] = useState<Pending>();
  const pinned = useDerivedState(getNotesMeta).pinned;
  const driveId = useDerivedState(getCloudData)?.rootId;

  const isPinned = Boolean(note && pinned.includes(note.id));
  // Заметку дня не переименовывают и не переносят: её название — день, папка — папка дней
  const isDaily = Boolean(note?.isDaily && isDayTitle(note.title));

  const items = useMemo(() => {
    const list: NoteMenuItem[] = [{ action: 'open', label: lang('Open'), icon: 'open' }];
    if (!isDaily) {
      list.push({ action: 'rename', label: lang('KnowledgeFolderRename'), icon: 'edit' });
      list.push({ action: 'move', label: lang('KnowledgeMoveNote'), icon: 'folder' });
    }
    list.push({ action: 'pin', label: lang(isPinned ? 'KnowledgeUnpin' : 'KnowledgePin'), icon: 'up' });
    list.push({ action: 'copy', label: lang('KnowledgeCopyLink', { title: note?.title || '' }), icon: 'link' });
    // Меню у строки компьютера — «Отправить в чат…» (`ZdNotesX`), шторка телефона — «Отправить статьёй в чат»
    list.push({
      action: 'article', label: lang(anchor ? 'KnowledgeSendToChat' : 'KnowledgeSendArticle'), icon: 'chat',
    });
    list.push({ action: 'canvas', label: lang('KnowledgeAddToCanvas'), icon: 'board' });
    if (driveId) list.push({ action: 'versions', label: lang('ParvaneCloudVersions'), icon: 'restore' });
    list.push({
      action: 'delete', label: lang('KnowledgeDelete'), icon: 'trash', isDanger: true,
    });
    // Черта — перед ссылкой и перед корзиной, как на доске
    return list.map((item) => ({
      ...item, hint: KEY_HINTS[item.action], hasDivider: item.action === 'copy' || item.action === 'delete',
    }));
  }, [lang, isDaily, isPinned, driveId, anchor, note?.title]);

  const handlePick = useLastCallback((action: string) => {
    if (!note) return;
    switch (action) {
      case 'open':
        onOpen(note.id);
        break;
      case 'move':
        onPickFolder(note.id);
        break;
      case 'pin':
        void changeNotesMeta({ kind: 'pin', note: note.id, isPinned: !isPinned });
        break;
      case 'copy':
        copyTextToClipboard(`[[${note.title}]]`);
        showNotification({ message: lang('KnowledgeLinkCopied') });
        break;
      case 'rename':
      case 'article':
      case 'canvas':
      case 'versions':
      case 'delete':
        setPending({ kind: action, note });
        break;
      default:
        break;
    }
  });

  // F2 / Del: окно пункта открывается в том же кадре, что и нажатие (правило экрана), меню не показывается
  useLayoutEffect(() => {
    if (!note || !keyAction) return;
    if (keyAction === 'rename' && isDaily) {
      onClose();
      return;
    }
    setPending({ kind: keyAction, note });
    onClose();
  }, [note, keyAction, isDaily, onClose]);

  const closePending = useLastCallback(() => {
    setPending(undefined);
  });

  const handleDelete = useLastCallback(() => {
    const target = pending?.note;
    closePending();
    if (target) onDelete(target.id);
  });

  const pendingOf = (kind: Pending['kind']) => (pending?.kind === kind ? pending.note : undefined);

  return (
    <>
      <NoteMenu
        isOpen={Boolean(note) && !keyAction}
        title={note?.title || ''}
        items={items}
        isSheet={!anchor}
        anchor={anchor}
        onPick={handlePick}
        onClose={onClose}
      />
      <NoteCanvasSheet note={pendingOf('canvas')} onOpenCanvas={onOpenCanvas} onClose={closePending} />
      <NoteArticleDialog note={pendingOf('article')} onClose={closePending} />
      <NoteRenameSheet note={pendingOf('rename')} onRename={onRename} onClose={closePending} />
      <CloudVersionsDialog
        container={pending?.kind === 'versions' ? driveId : undefined}
        nodeId={pending?.note.id || ''}
        onClose={closePending}
      />
      <ConfirmDialog
        isOpen={pending?.kind === 'delete'}
        text={lang('KnowledgeDeleteConfirm', { name: pending?.note.title || '' })}
        confirmLabel={lang('KnowledgeDelete')}
        confirmIsDestructive
        confirmHandler={handleDelete}
        onClose={closePending}
      />
    </>
  );
};

export default memo(NoteRowMenu);
