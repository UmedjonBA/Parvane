import { memo } from '../../../lib/teact/teact';

import { formatFileSize } from '../../../util/textFormat';

import useLang from '../../../hooks/useLang';

import PvIcon from '../notes/PvIcon';

import styles from './CloudDrag.module.scss';

type OwnProps = {
  // Куда лягут файлы: «Мой диск / Сервер»
  place: string;
  count: number;
  // Файлы уже отпущены: их общий размер (браузер сообщает его только при отпускании)
  bytes?: number;
};

// Файлы с компьютера тащат над окном (доска `ZdMisc`): куда они загрузятся и сколько их; после отпускания зона
// ещё мгновение стоит с размером — «3 файла · 48 МБ · шифруются на этом устройстве»
const CloudDropZone = ({ place, count, bytes }: OwnProps) => {
  const lang = useLang();

  return (
    <div className={styles.zone} data-cloud-drop-zone>
      <PvIcon name="upload" className={styles.zoneIcon} />
      <div className={styles.zoneTitle}>{lang('ParvaneCloudDropRelease', { place })}</div>
      {count > 0 && (
        <div className={styles.zoneText} data-drop-bytes={bytes}>
          {bytes !== undefined
            ? lang('ParvaneCloudDropFilesSize', { count, size: formatFileSize(lang, bytes) }, { pluralValue: count })
            : lang('ParvaneCloudDropFiles', { count }, { pluralValue: count })}
        </div>
      )}
    </div>
  );
};

export default memo(CloudDropZone);
