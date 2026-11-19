import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import styles from './Call.module.scss';

type OwnProps = {
  outputs: MediaDeviceInfo[];
  sinkId: string;
  onChoose: (id: string) => void;
  onClose: NoneToVoidFunction;
};

const CallOutputList = ({
  outputs, sinkId, onChoose, onClose,
}: OwnProps) => {
  const lang = useLang();
  const options = [{ deviceId: '', label: lang('ParvaneCallDefaultAudio') }, ...outputs];
  return (
    <div className={styles.outputList} role="group" aria-label={lang('ParvaneCallAudioOutput')}>
      <div className={styles.outputHeader}>
        {lang('ParvaneCallAudioOutput')}
        <button type="button" className={styles.outputClose} aria-label={lang('Close')} onClick={onClose}>
          <i className="icon icon-close" aria-hidden />
        </button>
      </div>
      {options.map(({ deviceId, label }, index) => (
        <button
          key={deviceId}
          type="button"
          className={buildClassName(styles.outputOption, deviceId === sinkId && styles.outputSelected)}
          aria-pressed={deviceId === sinkId}
          onClick={() => onChoose(deviceId)}
        >
          {label || lang('ParvaneCallAudioDevice', { number: index })}
        </button>
      ))}
    </div>
  );
};

export default memo(CallOutputList);
