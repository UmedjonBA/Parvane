import { memo, useState } from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { coverTone } from './musicFormat';
import { coverUrl } from './musicPlayer';

import ParvaneIcon from '../../main/ParvaneIcon';

import styles from './Music.module.scss';
import screen from './MusicPlayerScreen.module.scss';

type OwnProps = {
  // Обложка альбома; нет — цветная заглушка с нотой
  coverId?: string;
  // Чем красить заглушку: id альбома либо трека
  toneId: string;
  size: number;
  className?: string;
  isLarge?: boolean;
};

// Parvane (spec 039): обложка трека или альбома. Картинку отдаёт сервер по подписанной ссылке; под ней всегда
// лежит заглушка — её видно, пока картинка грузится и когда её нет
const MusicCover = ({
  coverId, toneId, size, className, isLarge,
}: OwnProps) => {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = coverUrl(coverId, size * 2);
  return (
    <span className={buildClassName(styles.cover, className)} style={`--cover-tone: ${coverTone(toneId)}`}>
      <ParvaneIcon name="music" isSmall={!isLarge} className={isLarge ? screen.artNote : undefined} />
      {url && url !== failedUrl && (
        <img
          className={styles.coverImage}
          src={url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailedUrl(url)}
        />
      )}
    </span>
  );
};

export default memo(MusicCover);
