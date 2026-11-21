import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiArticleMedia } from '../../../api/types';
import type { NoteMenuAnchor, NoteMenuItem } from '../notes/NoteMenu';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { getReadingMinutes } from './articleReadingTime';
import { saveArticleToNotes } from './articleSave';

import useAppLayout from '../../../hooks/useAppLayout';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import ChatScreen from '../chatScreen/ChatScreen';
import NoteMenu from '../notes/NoteMenu';
import PvIcon from '../notes/PvIcon';
import PvModuleOff from '../notes/PvModuleOff';
import ArticleBody from './ArticleBody';

import screen from '../chatScreen/ChatScreen.module.scss';
import kit from '../notes/PvKit.module.scss';
import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  title: string;
  markdown: string;
  media?: ApiArticleMedia[];
  // «от Тимура · Linux-чат» под названием экрана
  subtitle?: string;
  // Время отправки, секунды
  date?: number;
  onForward?: NoneToVoidFunction;
  // «Открыть в чате»: закрыть статью и показать сообщение в ленте
  onOpenInChat?: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
const MENU_WIDTH_PX = 264;

// Чтение статьи на весь экран (доска `XpChat`, ARTICLE-1): название, «3 минуты чтения · 14 ноября», текст заметки;
// внизу «В заметки» (копия ложится в «Заметки») и «Переслать»
const ArticleViewer = ({
  isOpen, title, markdown, media, subtitle, date, onForward, onOpenInChat, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<NoteMenuAnchor | undefined>();
  const { isMobile } = useAppLayout();

  // «Заметки» выключены на устройстве — кнопка ведёт в лист «Модуль выключен», как у карточки в чате;
  // выключены сервером — статья только читается
  const gate = useModuleGate('notes');
  const minutes = useMemo(() => getReadingMinutes(markdown), [markdown]);
  const canSave = gate.isOn || gate.canEnable;

  const handleSave = useLastCallback(async () => {
    setIsSaving(true);
    try {
      const saved = await saveArticleToNotes({ title, markdown, media }, lang);
      showNotification({ message: saved ? lang('ArticleSaved', { title: saved }) : lang('ArticleSaveFailed') });
    } finally {
      setIsSaving(false);
    }
  });

  const handleSaveClick = useLastCallback(() => gate.run(handleSave));

  // «Ещё» в шапке (доска `XpChat`): состав доской не задан — сохранить, переслать, скопировать текст, открыть в чате
  const menuItems: NoteMenuItem[] = [];
  if (canSave) menuItems.push({ action: 'save', label: lang('ArticleToNotes'), icon: 'noteNew' });
  if (onForward) menuItems.push({ action: 'forward', label: lang('Forward'), icon: 'arrow' });
  menuItems.push({ action: 'copy', label: lang('ArticleCopyText'), icon: 'copy' });
  if (onOpenInChat) menuItems.push({ action: 'chat', label: lang('ArticleOpenInChat'), icon: 'chat' });

  const handleMenuOpen = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAnchor({ x: rect.right - MENU_WIDTH_PX, y: rect.bottom });
  });
  const handleMenuClose = useLastCallback(() => setMenuAnchor(undefined));

  const handleMenuPick = useLastCallback((action: string) => {
    if (action === 'save') handleSaveClick();
    else if (action === 'forward') onForward?.();
    else if (action === 'chat') onOpenInChat?.();
    else if (action === 'copy') {
      copyTextToClipboard(`${title}\n\n${markdown}`);
      showNotification({ message: lang('ArticleTextCopied') });
    }
  });

  const moreButton = (
    <button
      type="button"
      className={kit.ib}
      aria-label={lang('ArticleMore')}
      title={lang('ArticleMore')}
      onClick={handleMenuOpen}
      data-article-more
    >
      <PvIcon name="dots" />
    </button>
  );

  const meta = [
    lang('ArticleReadingTime', { count: minutes }, { pluralValue: minutes }),
    date ? new Date(date * 1000).toLocaleDateString(lang.code, DATE_FORMAT) : undefined,
  ].filter(Boolean).join(' · ');

  const footer = (canSave || onForward) ? (
    <div className={screen.buttons}>
      {canSave && (
        <span className={styles.viewerAction} data-article-save>
          <button
            type="button"
            className={buildClassName(screen.btn, screen.buttonsItem)}
            disabled={isSaving}
            onClick={handleSaveClick}
          >
            {lang('ArticleToNotes')}
          </button>
        </span>
      )}
      {onForward && (
        <button
          type="button"
          className={buildClassName(screen.btn, screen.btnQuiet, screen.buttonsItem)}
          data-article-forward
          onClick={onForward}
        >
          {lang('Forward')}
        </button>
      )}
    </div>
  ) : undefined;

  return (
    <ChatScreen
      isOpen={isOpen}
      title={lang('ArticleLabel')}
      subtitle={subtitle}
      isBack
      className={styles.viewer}
      footer={footer}
      headAfter={moreButton}
      onClose={onClose}
    >
      <div className={styles.viewerPage} data-article-viewer>
        <h1 className={styles.viewerTitle} dir="auto">{title}</h1>
        <div className={styles.viewerMeta}>{meta}</div>
        <ArticleBody title={title} markdown={markdown} media={media} />
      </div>
      <NoteMenu
        isOpen={Boolean(menuAnchor)}
        title={title}
        items={menuItems}
        isSheet={isMobile}
        anchor={isMobile ? undefined : menuAnchor}
        onPick={handleMenuPick}
        onClose={handleMenuClose}
      />
      <PvModuleOff
        isOpen={gate.isAsked}
        module="notes"
        hint={lang('ModuleOffHintNote')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </ChatScreen>
  );
};

export default memo(ArticleViewer);
