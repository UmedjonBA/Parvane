import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './Permission.module.scss';

type OwnProps = {
  isOpen: boolean;
  onAllow: NoneToVoidFunction;
  onClose: NoneToVoidFunction;
};

// «Доступ к геопозиции» (доска `ZpSysGen`): зачем нужен, до системного запроса. «Разрешить» — запрос браузера,
// «Не сейчас» — место можно ввести вручную
const LocationAskSheet = ({ isOpen, onAllow, onClose }: OwnProps) => {
  const lang = useLang();

  return (
    <PvSheet isOpen={isOpen} title={lang('PvSysLocationAskTitle')} onClose={onClose}>
      <div className={styles.body} data-location-ask-sheet>
        <p className={styles.text}>{lang('PvSysLocationAskText')}</p>
        <div className={styles.buttons}>
          <button type="button" className={kit.btn} data-location-ask="later" onClick={onClose}>
            {lang('PvSysNotNow')}
          </button>
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            data-location-ask="allow"
            onClick={onAllow}
          >
            {lang('PvSysAllow')}
          </button>
        </div>
      </div>
    </PvSheet>
  );
};

export default memo(LocationAskSheet);
