import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { NoteEntry } from '../notes/notesStore';

import { SEARCH_FIELD_PROPS } from '../../../util/searchField';
import { callApi } from '../../../api/gramjs';
import { freeName } from '../cloud/cloudModel';
import { getCloudData, getNodes } from '../cloud/cloudStore';
import { embedBaseName, embedNames, renameEmbeds } from '../markdown/markdown';
import { resolveEmbed } from '../notes/notesEmbeds';
import { folderCaption } from '../notes/notesFolders';
import { previewOf } from '../notes/notesLook';
import { noteSearchText, parseNote } from '../notes/notesModel';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Loading from '../../ui/Loading';
import Modal from '../../ui/Modal';
import SearchForm from '../../ui/SearchForm';

import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
// Предел схемы `Article.media`
const ARTICLE_MEDIA_MAX = 32;

// «Статья» в меню вложений (ARTICLE-1): заметка «Знаний» уходит в чат целиком и открывается окном чтения
const ArticlePickerModal = ({ isOpen, chatId, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [sendingId, setSendingId] = useState<string>();
  const notes = useDerivedState(getNotes);
  const status = useDerivedState(getNotesStatus);

  // Пока окно открыто, заметки следят за облаком; хранилище само не создаётся
  useEffect(() => {
    if (!isOpen) return undefined;
    const release = retainNotes();
    void loadNotes(getGlobal().currentUserId);
    return () => {
      release();
      setQuery('');
    };
  }, [isOpen]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const sorted = [...notes].sort((a, b) => a.title.localeCompare(b.title));
    if (!words.length) return sorted;
    return sorted.filter((note) => {
      const text = `${note.title.toLowerCase().replace(/ё/g, 'е')} ${noteSearchText(note)}`;
      return words.every((word) => text.includes(word));
    });
  }, [notes, query]);

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback(async (note: NoteEntry) => {
    const chat = getGlobal().chats.byId[chatId];
    if (!chat || sendingId) return;
    setSendingId(note.id);
    try {
      const prepared = await prepareArticle(note);
      if (!prepared) {
        showNotification({ message: lang('ArticleSendFailed') });
        return;
      }
      const result = await callParvane('parvaneSendArticle', {
        chat, title: note.title, markdown: prepared.markdown, media: prepared.media,
      }).catch(() => undefined);
      if (result === true) {
        onClose();
        return;
      }
      showNotification({ message: lang(result === 'too-long' ? 'ArticleTooLong' : 'ArticleSendFailed') });
    } finally {
      setSendingId(undefined);
    }
  });

  const isLoading = status === 'loading' && !notes.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={lang('ArticlePickTitle')}
      hasCloseButton
      className={styles.picker}
    >
      <p className={styles.pickerHint}>{lang('ArticlePickHint')}</p>
      <SearchForm>
        <input
          {...SEARCH_FIELD_PROPS}
          className={styles.pickerSearch}
          value={query}
          placeholder={lang('ArticleSearch')}
          aria-label={lang('ArticleSearch')}
          data-article-search
          onChange={handleQuery}
        />
      </SearchForm>
      <div className={styles.pickerList} data-article-notes>
        {isLoading && <Loading />}
        {!isLoading && !notes.length && <p className={styles.pickerEmpty}>{lang('ArticleNoNotes')}</p>}
        {!isLoading && Boolean(notes.length) && !shown.length && (
          <p className={styles.pickerEmpty}>{lang('KnowledgeNothingFound')}</p>
        )}
        {shown.map((note) => (
          <button
            key={note.id}
            type="button"
            className={styles.pickerRow}
            disabled={Boolean(sendingId)}
            data-article-note={note.title}
            onClick={() => handlePick(note)}
          >
            <span className={styles.pickerTitle}>{note.title}</span>
            <span className={styles.pickerMeta}>
              {note.folder ? `${folderCaption(note.folder)} · ` : ''}
              {previewOf(note)}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
};

// Текст статьи и её файлы: встроенные файлы облака копируются во вложения; в тексте — имя без папок (два
// разных файла с одним именем различаются номером). Не найденные файлы остаются в тексте как есть
async function prepareArticle(note: NoteEntry) {
  let markdown = parseNote(note.text).body.trim();
  const cloud = getCloudData();
  const driveId = cloud?.rootId;
  const nodes = driveId ? getNodes(driveId, cloud) : [];
  const taken = new Set<string>();
  const byNode = new Map<string, string>();
  const rename = new Map<string, string>();
  const items: { node: string; name: string }[] = [];
  embedNames(markdown).forEach((name) => {
    const node = resolveEmbed(nodes, name, note.id);
    if (!node || (!byNode.has(node.id) && items.length >= ARTICLE_MEDIA_MAX)) return;
    let fileName = byNode.get(node.id);
    if (!fileName) {
      fileName = freeName(taken, embedBaseName(node.name));
      taken.add(fileName);
      byNode.set(node.id, fileName);
      items.push({ node: node.id, name: fileName });
    }
    rename.set(name, fileName);
  });
  if (!items.length) return { markdown, media: undefined };
  markdown = renameEmbeds(markdown, rename);
  const result = await callParvane('parvaneCloudArticleMedia', { container: driveId, items })
    .catch(() => undefined) as { ok: boolean; media?: unknown[] } | undefined;
  return result?.ok ? { markdown, media: result.media } : undefined;
}

export default memo(ArticlePickerModal);
