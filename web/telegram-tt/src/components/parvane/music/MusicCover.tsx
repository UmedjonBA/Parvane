import { memo } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { coverTone } from './musicFormat';
import { coverUrl } from './musicPlayer';

import ParvaneIcon from '../../main/ParvaneIcon';

import styles from './Music.module.scss';

type OwnProps = {
  // Обложка альбома; нет — цветная заглушка с нотой
  coverId?: string;
  // Чем красить заглушку: id альбома либо трека
  toneId: string;
  size: number;
  className?: string;
};

// Parvane (spec 039): обложка трека или альбома. Картинку отдаёт сервер по подписанной ссылке; под ней всегда
// лежит заглушка — её видно, пока картинка грузится и когда её нет
const MusicCover = ({
  coverId, toneId, size, className,
}: OwnProps) => {
  const url = coverUrl(coverId, size * 2);
  return (
    <span className={buildClassName(styles.cover, className)} style={`--cover-tone: ${coverTone(toneId)}`}>
      <ParvaneIcon name="music" isSmall />
      {url && <img className={styles.coverImage} src={url} alt="" loading="lazy" draggable={false} />}
    </span>
  );
};

export default memo(MusicCover);
