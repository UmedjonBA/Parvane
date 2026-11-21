import { memo } from '../../../lib/teact/teact';

import type { HealthSleepView } from './healthTypes';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Health.module.scss';

type OwnProps = {
  sleep: HealthSleepView;
  onBed: NoneToVoidFunction;
  onWake: NoneToVoidFunction;
  // «Другое» — дневной сон и прочее (доска `HealthSleep`)
  onOther?: NoneToVoidFunction;
};

// Parvane (spec 038, 041): «Ложусь / Встал» (и «Другое» на экране «Сон»). Пока отмечено «лёг» без «встал»,
// «Ложусь» недоступна, а «Встал» — основная
const HealthSleepButtons = ({
  sleep, onBed, onWake, onOther,
}: OwnProps) => {
  const lang = useLang();
  const isOpen = sleep.openStartMs !== undefined;

  return (
    <div className={styles.cardButtons}>
      <button
        type="button"
        className={buildClassName(kit.btn, !isOpen && kit.btnAcc, onOther && styles.sleepButton)}
        disabled={isOpen}
        data-health-action="bed"
        onClick={onBed}
      >
        {lang('HealthSleepBed')}
      </button>
      <button
        type="button"
        className={buildClassName(kit.btn, isOpen && kit.btnAcc, onOther && styles.sleepButton)}
        data-health-action="wake"
        onClick={onWake}
      >
        {lang('HealthSleepWake')}
      </button>
      {onOther && (
        <button
          type="button"
          className={buildClassName(kit.btn, styles.sleepButton)}
          data-health-action="nap"
          onClick={onOther}
        >
          {lang('HealthSleepOther')}
        </button>
      )}
    </div>
  );
};

export default memo(HealthSleepButtons);
