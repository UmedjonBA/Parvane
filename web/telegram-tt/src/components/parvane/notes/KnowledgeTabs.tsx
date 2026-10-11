import { memo, useMemo } from '../../../lib/teact/teact';

import { getKnowledgeView, KNOWLEDGE_VIEWS, setKnowledgeView } from '../../../util/parvaneSection';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import TabList from '../../ui/TabList';

type OwnProps = {
  className?: string;
};

const LABELS = {
  notes: 'KnowledgeNotes',
  graph: 'KnowledgeGraph',
  canvas: 'KnowledgeCanvas',
  files: 'KnowledgeFiles',
} as const;

// Вкладки раздела «Знания»: стоят в шапке и заметок, и «Файлов» (прежнее «Облако»)
const KnowledgeTabs = ({ className }: OwnProps) => {
  const view = useDerivedState(getKnowledgeView);

  const lang = useLang();

  const tabs = useMemo(() => KNOWLEDGE_VIEWS.map((item) => ({ title: lang(LABELS[item]) })), [lang]);

  const handleSwitch = useLastCallback((index: number) => {
    setKnowledgeView(KNOWLEDGE_VIEWS[index]);
  });

  return (
    <TabList
      className={className}
      tabs={tabs}
      activeTab={KNOWLEDGE_VIEWS.indexOf(view)}
      onSwitchTab={handleSwitch}
    />
  );
};

export default memo(KnowledgeTabs);
