import { memo } from '../../lib/teact/teact';

import { Bundles, loadBundle } from '../../util/moduleLoader';

import useLastCallback from '../../hooks/useLastCallback';

import PvLoading from './notes/PvLoading';

type OwnProps = {
  // Идентификатор корня раздела: место в сетке окна и показ по активному разделу заданы для него в `Main.scss`
  id: string;
};

// Parvane (доски `PhStates`, `ZpStates`): раздел, чей код ещё не подгрузился (бандл `Parvane` грузится после старта).
// Без связи загрузка не приходит — вместо пустой области «Загрузка…», затем «Нет ответа от сервера · Повторить»
const ModuleLoading = ({ id }: OwnProps) => {
  const handleRetry = useLastCallback(() => {
    // Успех разойдётся слушателям загрузки бандла — обёртка раздела перерисуется сама
    void loadBundle(Bundles.Parvane).catch(() => undefined);
  });

  return (
    <div id={id} className="pv-module-loading" data-module-loading>
      <PvLoading onRetry={handleRetry} />
    </div>
  );
};

export default memo(ModuleLoading);
