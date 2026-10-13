import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

// Parvane (B2): раздел «Знания» (заметки, граф, холст) — из бандла `Parvane`
const KnowledgeAsync = () => {
  const Knowledge = useModuleLoader(Bundles.Parvane, 'Knowledge');

  return Knowledge ? <Knowledge /> : undefined;
};

export default KnowledgeAsync;
