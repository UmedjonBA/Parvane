import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiArticleMedia } from '../../../api/types';

import { saveArticleToNotes } from './articleSave';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useModuleGate from '../../../hooks/useModuleGate';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import PvModuleOff from '../notes/PvModuleOff';
import ArticleBody from './ArticleBody';

import styles from './Article.module.scss';

type OwnProps = {
  isOpen: boolean;
  title: string;
  markdown: string;
  media?: ApiArticleMedia[];
  onClose: NoneToVoidFunction;
};

// Окно чтения статьи (ARTICLE-1): текст заметки и «Сохранить в заметки» — копия ложится в «Знания»
const ArticleViewer = ({
  isOpen, title, markdown, media, onClose,
}: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);

  // «Заметки» выключены на устройстве — кнопка ведёт в лист «Модуль выключен», как у карточки в чате;
  // выключены сервером — статья только читается
  const gate = useModuleGate('notes');

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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      hasCloseButton
      className={styles.viewer}
      contentClassName={styles.viewerContent}
    >
      <div data-article-viewer>
        <ArticleBody title={title} markdown={markdown} media={media} />
        {(gate.isOn || gate.canEnable) && (
          <div className={styles.viewerActions} data-article-save>
            <Button size="smaller" noForcedUpperCase disabled={isSaving} onClick={handleSaveClick}>
              {lang('ArticleSaveToNotes')}
            </Button>
          </div>
        )}
      </div>
      <PvModuleOff
        isOpen={gate.isAsked}
        module="notes"
        hint={lang('ModuleOffHintNote')}
        onEnable={gate.enable}
        onClose={gate.dismiss}
      />
    </Modal>
  );
};

export default memo(ArticleViewer);
