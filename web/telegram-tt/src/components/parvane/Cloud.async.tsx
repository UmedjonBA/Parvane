import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

type OwnProps = {
  isMobile?: boolean;
};

// Parvane (B2): «Файлы» раздела «Знания» (облако) — из бандла `Parvane`
const CloudAsync = (props: OwnProps) => {
  const Cloud = useModuleLoader(Bundles.Parvane, 'Cloud');

  return Cloud ? <Cloud {...props} /> : undefined;
};

export default CloudAsync;
