import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import ModuleLoading from './ModuleLoading';

// Parvane (B2): раздел «Знания» (заметки, граф, холст) — из бандла `Parvane`
const KnowledgeAsync = () => {
  const Knowledge = useModuleLoader(Bundles.Parvane, 'Knowledge', undefined, true);

  return Knowledge ? <Knowledge /> : <ModuleLoading id="ParvaneKnowledge" />;
};

export default KnowledgeAsync;
