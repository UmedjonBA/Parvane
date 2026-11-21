import { memo, useMemo } from '../../../lib/teact/teact';

import type { KnowledgeView } from '../../../util/parvaneSection';
import type { PvSegmentItem } from './PvSegment';

import { getKnowledgeView, setKnowledgeView } from '../../../util/parvaneSection';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';

import PvSegment from './PvSegment';

type OwnProps = {
  className?: string;
};

// Виды модуля «Заметки» на телефоне: список, граф связей, холст. Без значков — по доске `PhNotesMore` (более
// поздней, чем `Notes`, где значки были)
const KnowledgeTabs = ({ className }: OwnProps) => {
  const view = useDerivedState(getKnowledgeView);

  const lang = useLang();

  const items = useMemo((): PvSegmentItem<KnowledgeView>[] => [
    { value: 'notes', label: lang('KnowledgeList') },
    { value: 'graph', label: lang('KnowledgeGraph') },
    { value: 'canvas', label: lang('KnowledgeCanvas') },
  ], [lang]);

  return (
    <PvSegment
      className={className}
      items={items}
      value={view}
      label={lang('KnowledgeViewLabel')}
      isTabs
      onChange={setKnowledgeView}
    />
  );
};

export default memo(KnowledgeTabs);
