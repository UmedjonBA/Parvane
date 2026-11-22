import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import ModuleLoading from './ModuleLoading';

// Parvane (spec 041): модуль «Музыка» — из бандла `Parvane`, вне критического пути старта
const MusicAsync = () => {
  const Music = useModuleLoader(Bundles.Parvane, 'Music', undefined, true);

  return Music ? <Music /> : <ModuleLoading id="ParvaneMusic" />;
};

export default MusicAsync;
