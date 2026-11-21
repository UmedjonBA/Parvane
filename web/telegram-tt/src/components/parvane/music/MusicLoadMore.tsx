import { memo, useEffect, useRef } from '../../../lib/teact/teact';

import useLang from '../../../hooks/useLang';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  onMore: NoneToVoidFunction;
};

// Запас снизу: следующая страница читается чуть раньше, чем список кончится
const ROOT_MARGIN = '0px 0px 400px 0px';

// Parvane (spec 041): низ длинного списка — показался, значит пора читать следующую страницу
const MusicLoadMore = ({ onMore }: OwnProps) => {
  const ref = useRef<HTMLDivElement>();
  const lang = useLang();

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onMore();
    }, { rootMargin: ROOT_MARGIN });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMore]);

  return (
    <div ref={ref} className={`${styles.loadMore} ${kit.muted} ${kit.small}`} role="status" data-music-more>
      {lang('MusicLoadingMore')}
    </div>
  );
};

export default memo(MusicLoadMore);
