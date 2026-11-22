import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import ModuleLoading from './ModuleLoading';

type OwnProps = {
  isMobile?: boolean;
};

// Parvane (B2): «Файлы» раздела «Знания» (облако) — из бандла `Parvane`
const CloudAsync = (props: OwnProps) => {
  const Cloud = useModuleLoader(Bundles.Parvane, 'Cloud', undefined, true);

  return Cloud ? <Cloud {...props} /> : <ModuleLoading id="ParvaneCloud" />;
};

export default CloudAsync;
