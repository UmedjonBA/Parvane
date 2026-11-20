import {
  memo, useEffect, useLayoutEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { NoteEntry } from '../notes/notesStore';
import { MAIN_THREAD_ID } from '../../../api/types';

import { getChatTitle } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import buildAttachment from '../../middle/composer/helpers/buildAttachment';
import { folderCaption } from '../notes/notesFolders';
import { noteSearchText, parseNote } from '../notes/notesModel';
import {
  getNotes, getNotesStatus, loadNotes, retainNotes,
} from '../notes/notesStore';
import { ARTICLE_ERROR_KEYS, sendNoteArticle } from './articleSend';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import Loading from '../../ui/Loading';
import ChatScreen from '../chatScreen/ChatScreen';
import PvSegment from '../notes/PvSegment';

import screen from '../chatScreen/ChatScreen.module.scss';
import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

type SendMode = 'article' | 'file';

const MARKDOWN_MIME = 'text/markdown';
const FILE_NAME_MAX = 120;

// «Отправить заметку» (доска `RpPick`, ARTICLE-1): поиск, заметка с галочкой, «Статьёй» (копия заметки, окно
// чтения у получателя) либо «Файлом .md», кнопка «Отправить «название»»
const ArticlePickerModal = ({ isOpen, chatId, onClose }: OwnProps) => {
  const { showNotification, sendMessage } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  const [query, setQuery] = useState('');
  const [pickedId, setPickedId] = useState<string>();
  const [mode, setMode] = useState<SendMode>('article');
  const [isSending, setIsSending] = useState(false);
  const notes = useDerivedState(getNotes);
  const status = useDerivedState(getNotesStatus);

  useLayoutEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setPickedId(undefined);
    setMode('article');
  }, [isOpen]);

  // Пока экран открыт, заметки следят за облаком; хранилище само не создаётся
  useEffect(() => {
    if (!isOpen) return undefined;
    const release = retainNotes();
    void loadNotes(getGlobal().currentUserId);
    return release;
  }, [isOpen]);

  const chatTitle = useMemo(() => {
    if (!isOpen) return undefined;
    const chat = getGlobal().chats.byId[chatId];
    return chat ? getChatTitle(lang, chat) : undefined;
  }, [isOpen, chatId, lang]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean);
    const sorted = [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!words.length) return sorted;
    return sorted.filter((note) => {
      const text = `${note.title.toLowerCase().replace(/ё/g, 'е')} ${noteSearchText(note)}`;
      return words.every((word) => text.includes(word));
    });
  }, [notes, query]);

  const picked = pickedId ? notes.find((note) => note.id === pickedId) : undefined;

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.currentTarget.value);
  });

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setPickedId(e.currentTarget.dataset.noteId);
  });

  const handleSend = useLastCallback(async () => {
    const chat = getGlobal().chats.byId[chatId];
    if (!chat || !picked || isSending) return;
    if (mode === 'file') {
      onClose();
      await sendNoteFile(picked);
      return;
    }
    setIsSending(true);
    try {
      const result = await sendNoteArticle(chat, picked);
      if (result === 'sent') {
        onClose();
        return;
      }
      showNotification({ message: lang(ARTICLE_ERROR_KEYS[result]) });
    } finally {
      setIsSending(false);
    }
  });

  // Файлом — текст заметки как есть, обычным вложением чата
  async function sendNoteFile(note: NoteEntry) {
    const body = parseNote(note.text).body;
    const name = `${(note.title.trim() || 'note').replace(/[/\\\p{Cc}]/gu, '_').slice(0, FILE_NAME_MAX)}.md`;
    const attachment = await buildAttachment(name, new Blob([body], { type: MARKDOWN_MIME }));
    sendMessage({
      messageList: { chatId, threadId: MAIN_THREAD_ID, type: 'thread' },
      attachments: [attachment],
    });
  }

  const isLoading = status === 'loading' && !notes.length;
  const modeItems = [
    { value: 'article' as const, label: lang('NoteSendAsArticle') },
    { value: 'file' as const, label: lang('NoteSendAsFile') },
  ];

  const footer = (
    <button
      type="button"
      className={screen.btn}
      disabled={!picked || isSending}
      data-article-send
      onClick={handleSend}
    >
      {picked ? lang('NoteSendNamed', { title: picked.title }) : lang('NoteSendPick')}
    </button>
  );

  return (
    <ChatScreen
      isOpen={isOpen}
      title={lang('NoteSendTitle')}
      subtitle={chatTitle ? lang('NoteSendTo', { chat: chatTitle }) : undefined}
      footer={footer}
      onClose={onClose}
    >
      <div className={styles.pickTop}>
        <input
          className={screen.inp}
          type="search"
          value={query}
          placeholder={lang('ArticleSearch')}
          aria-label={lang('ArticleSearch')}
          data-article-search
          onChange={handleQuery}
        />
      </div>
      <div className={screen.grp} data-article-notes>
        {isLoading && <Loading />}
        {!isLoading && !notes.length && <p className={screen.hint}>{lang('ArticleNoNotes')}</p>}
        {!isLoading && Boolean(notes.length) && !shown.length && (
          <p className={screen.hint}>{lang('KnowledgeNothingFound')}</p>
        )}
        {shown.map((note) => {
          const isPicked = note.id === pickedId;
          return (
            <button
              key={note.id}
              type="button"
              className={buildClassName(screen.sr, screen.srButton, isPicked && styles.pickOn)}
              aria-pressed={isPicked}
              data-article-note={note.title}
              data-note-id={note.id}
              onClick={handlePick}
            >
              <span className={screen.srMain}>
                <span className={styles.pickTitle}>{note.title}</span>
                <span className={styles.pickMeta}>
                  {[note.folder ? folderCaption(note.folder) : lang('NoteSendNoFolder'),
                    note.updatedAt ? formatPastTimeShort(oldLang, note.updatedAt) : undefined]
                    .filter(Boolean).join(' · ')}
                </span>
              </span>
              {isPicked && (
                <svg className={styles.pickCheck} viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
      <div className={screen.cap}>{lang('NoteSendHow')}</div>
      <div className={styles.pickPad}>
        <PvSegment items={modeItems} value={mode} label={lang('NoteSendHow')} onChange={setMode} />
      </div>
      <div className={screen.hint}>{lang(mode === 'article' ? 'NoteSendArticleHint' : 'NoteSendFileHint')}</div>
    </ChatScreen>
  );
};

export default memo(ArticlePickerModal);
