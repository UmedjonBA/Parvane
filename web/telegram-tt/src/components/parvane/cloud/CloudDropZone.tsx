import { memo } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';

import PvIcon from '../notes/PvIcon';

import styles from './CloudDrag.module.scss';

type OwnProps = {
  // Куда лягут файлы: «Мой диск / Сервер»
  place: string;
  count: number;
};

// Файлы с компьютера тащат над окном (доска `ZdMisc`): куда они загрузятся и сколько их. Размер браузер
// сообщает только при отпускании, поэтому в подписи — число файлов
const CloudDropZone = ({ place, count }: OwnProps) => {
  const lang = useLang();

  return (
    <div className={styles.zone} data-cloud-drop-zone>
      <PvIcon name="upload" className={styles.zoneIcon} />
      <div className={styles.zoneTitle}>{lang('ParvaneCloudDropRelease', { place })}</div>
      {count > 0 && (
        <div className={styles.zoneText}>{lang('ParvaneCloudDropFiles', { count }, { pluralValue: count })}</div>
      )}
    </div>
  );
};

export default memo(CloudDropZone);
