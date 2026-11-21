import { memo } from '../../../../lib/teact/teact';

import buildClassName from '../../../../util/buildClassName';
import { forgetQuery, getRecentQueries } from './musicRecentQueries';

import useDerivedState from '../../../../hooks/useDerivedState';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import ParvaneIcon from '../../../main/ParvaneIcon';

import kit from '../../notes/PvKit.module.scss';
import styles from './MusicFetch.module.scss';

type OwnProps = {
  onPick: (query: string) => void;
};

// Parvane (spec 041, доска `ZpMusicX`): «Недавние запросы» на пустом поле поиска — нажатие ищет снова, крестик
// убирает запрос из памяти устройства
const MusicRecentQueries = ({ onPick }: OwnProps) => {
  const lang = useLang();
  const queries = useDerivedState(getRecentQueries);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    onPick(e.currentTarget.dataset.query!);
  });
  const handleForget = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    forgetQuery(e.currentTarget.dataset.query!);
  });

  if (!queries.length) return undefined;

  return (
    <section className={styles.recent} data-music-recent>
      <div className={kit.caps}>{lang('MusicRecentQueries')}</div>
      {queries.map((query) => (
        <div key={query} className={styles.line}>
          <button
            type="button"
            className={buildClassName(styles.recentItem, kit.grow)}
            data-query={query}
            onClick={handlePick}
          >
            <ParvaneIcon name="search" isSmall />
            <span className={styles.title}>{query}</span>
          </button>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('MusicRecentForget', { query })}
            data-query={query}
            onClick={handleForget}
          >
            <ParvaneIcon name="close" isSmall />
          </button>
        </div>
      ))}
    </section>
  );
};

export default memo(MusicRecentQueries);
