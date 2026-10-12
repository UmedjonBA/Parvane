import { memo } from '../../../lib/teact/teact';

import type { KnowledgeView } from '../../../util/parvaneSection';

import buildClassName from '../../../util/buildClassName';
import { getKnowledgeView, KNOWLEDGE_VIEWS, setKnowledgeView } from '../../../util/parvaneSection';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from './PvKit.module.scss';

type OwnProps = {
  className?: string;
};

const LABELS = {
  notes: 'KnowledgeNotes',
  graph: 'KnowledgeGraph',
  canvas: 'KnowledgeCanvas',
  files: 'KnowledgeFiles',
} as const;

// Вкладки раздела «Знания»: стоят в шапке и заметок, и «Файлов» (прежнее «Облако»).
// На компьютере — сегменты в шапке острова, на телефоне — подчёркнутые вкладки во всю ширину
const KnowledgeTabs = ({ className }: OwnProps) => {
  const view = useDerivedState(getKnowledgeView);

  const lang = useLang();

  const handleSwitch = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setKnowledgeView(e.currentTarget.dataset.view as KnowledgeView);
  });

  return (
    <div className={buildClassName(kit.seg, className)} role="tablist">
      {KNOWLEDGE_VIEWS.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={item === view}
          className={buildClassName(kit.segItem, item === view && kit.segItemOn)}
          data-view={item}
          onClick={handleSwitch}
        >
          {lang(LABELS[item])}
        </button>
      ))}
    </div>
  );
};

export default memo(KnowledgeTabs);
