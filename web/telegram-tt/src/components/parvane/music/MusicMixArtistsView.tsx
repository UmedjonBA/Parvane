import {
  memo, useEffect, useState,
} from '../../../lib/teact/teact';

import type { MusicCatalogArtist } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { getMusicMix, loadMusicMix } from './musicMix';
import { callMusic } from './musicPlayer';
import { goBackMusic } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicSectionHead from './MusicSectionHead';

import kit from '../notes/PvKit.module.scss';
import styles from './Music.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

const ARTISTS_MAX = 20;
const SEARCH_DELAY_MS = 300;

// Любимые исполнители для «Микса дня» (как в HomeMusic): подсказки — самые частые исполнители библиотеки сервера и
// чарт каталога; поле ищет по каталогу. Выбранные — наверху, до 20; «Готово» сохраняет и собирает микс
const MusicMixArtistsView = ({ isPhone }: OwnProps) => {
  const lang = useLang();
  const today = useDerivedState(getMusicMix);
  const [chosen, setChosen] = useState<MusicCatalogArtist[]>(() => today?.settings.artists || []);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<MusicCatalogArtist[]>();
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      setFound(undefined);
      void callMusic('parvaneMusicMixArtists', { query: query.trim() }).catch(() => []).then((artists) => {
        if (isCurrent) setFound(artists);
      });
    }, query.trim() ? SEARCH_DELAY_MS : 0);
    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const chosenRefs = new Set(chosen.map((artist) => artist.ref));

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));
  const handleToggle = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const ref = e.currentTarget.dataset.ref!;
    const artist = [...chosen, ...(found || [])].find((item) => item.ref === ref);
    if (!artist) return;
    setChosen((previous) => (previous.some((item) => item.ref === ref)
      ? previous.filter((item) => item.ref !== ref)
      : previous.length < ARTISTS_MAX ? [...previous, artist] : previous));
  });
  const handleDone = useLastCallback(async () => {
    setIsSaving(true);
    await callMusic('parvaneMusicMixSettings', { artists: chosen }).catch(() => undefined);
    setIsSaving(false);
    void loadMusicMix();
    goBackMusic();
  });

  function renderArtist(artist: MusicCatalogArtist) {
    const isChosen = chosenRefs.has(artist.ref);
    return (
      <button
        key={artist.ref}
        type="button"
        className={buildClassName(styles.mixArtist, isChosen && styles.mixArtistOn)}
        aria-pressed={isChosen}
        data-ref={artist.ref}
        data-music-mix-artist={artist.name}
        onClick={handleToggle}
      >
        <span className={styles.mixArtistPicture}>
          {artist.pictureUrl && <img src={artist.pictureUrl} alt="" loading="lazy" />}
          {isChosen && (
            <span className={styles.mixArtistCheck} aria-hidden>
              <ParvaneIcon name="check" isSmall />
            </span>
          )}
        </span>
        <span className={styles.mixArtistName}>{artist.name}</span>
      </button>
    );
  }

  const rest = (found || []).filter((artist) => !chosenRefs.has(artist.ref));

  return (
    <div className={styles.view} data-music-mix-artists>
      <MusicSectionHead
        title={lang('MusicMixArtistsTitle')}
        subtitle={lang('MusicMixArtistsChosen', { count: chosen.length })}
        actions={(
          <button
            type="button"
            className={buildClassName(kit.btn, kit.btnAcc)}
            disabled={!chosen.length || isSaving}
            data-music-mix-artists-done
            onClick={handleDone}
          >
            {lang('MusicMixArtistsDone')}
          </button>
        )}
        isPhone={isPhone}
        barTitle={lang('MusicMixArtistsTitle')}
        onBack={goBackMusic}
      />
      <input
        className={kit.input}
        value={query}
        placeholder={lang('MusicMixArtistsSearch')}
        aria-label={lang('MusicMixArtistsSearch')}
        data-music-mix-artists-search
        onChange={handleQuery}
      />
      {Boolean(chosen.length) && <div className={styles.mixArtists}>{chosen.map(renderArtist)}</div>}
      {!found && <PvSkeleton />}
      {found && !rest.length && <PvEmpty text={lang('MusicMixArtistsEmpty')} />}
      {Boolean(rest.length) && <div className={styles.mixArtists}>{rest.map(renderArtist)}</div>}
    </div>
  );
};

export default memo(MusicMixArtistsView);
