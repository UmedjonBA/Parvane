import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

// Parvane (spec 041): модуль «Музыка» — из бандла `Parvane`, вне критического пути старта
const MusicAsync = () => {
  const Music = useModuleLoader(Bundles.Parvane, 'Music');

  return Music ? <Music /> : undefined;
};

export default MusicAsync;
