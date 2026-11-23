import {
  memo, useEffect, useState,
} from '../../../lib/teact/teact';

import type { MusicCatalogArtist } from '../../../api/parvane/musicApi';

import buildClassName from '../../../util/buildClassName';
import { coverTone } from './musicFormat';
import { getMusicMix, loadMusicMix, openMixSettings } from './musicMix';
import { callMusic } from './musicPlayer';
import { goBackMusic } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicMixArtists.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

const ARTISTS_MAX = 20;
const SEARCH_DELAY_MS = 300;

// Parvane (макет «Музыки» 23 ноя, доска `MusicHome-03`): «Сделано для вас · шаг 1 из 2» — «Кого вы любите слушать?»,
// круги исполнителей по три в ряд с отметкой выбранных и подписью «на сервере» / «каталог»; поле ищет по каталогу.
// Внизу «Выбрано N», «Пропустить», «Дальше» — сохраняет и открывает шаг 2, настройки микса
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
  const handleNext = useLastCallback(async () => {
    setIsSaving(true);
    await callMusic('parvaneMusicMixSettings', { artists: chosen }).catch(() => undefined);
    setIsSaving(false);
    void loadMusicMix();
    goBackMusic();
    openMixSettings();
  });

  function renderArtist(artist: MusicCatalogArtist) {
    const isChosen = chosenRefs.has(artist.ref);
    return (
      <button
        key={artist.ref}
        type="button"
        className={buildClassName(styles.artist, isChosen && styles.artistOn)}
        aria-pressed={isChosen}
        data-ref={artist.ref}
        data-music-mix-artist={artist.name}
        onClick={handleToggle}
      >
        <span className={styles.picture} style={`--artist-tone: ${coverTone(artist.ref || artist.name)}`}>
          <ParvaneIcon name="mic" isSmall className={styles.glyph} />
          {artist.pictureUrl && <img className={styles.image} src={artist.pictureUrl} alt="" loading="lazy" />}
          {isChosen && (
            <span className={styles.check} aria-hidden>
              <ParvaneIcon name="check" isSmall />
            </span>
          )}
        </span>
        <span className={styles.name}>{artist.name}</span>
        <span className={styles.where}>{lang(artist.isOnServer ? 'MusicOnServerShort' : 'MusicInCatalogShort')}</span>
      </button>
    );
  }

  // Выбранные — первыми, остальные в порядке подсказок
  const rest = (found || []).filter((artist) => !chosenRefs.has(artist.ref));
  const shown = [...chosen, ...rest];

  return (
    <div className={buildClassName(styles.root, isPhone && styles.rootPhone)} data-music-mix-artists>
      <div className={styles.bar}>
        <button type="button" className={kit.ib} aria-label={lang('Back')} data-music-back onClick={goBackMusic}>
          <ParvaneIcon name="left" />
        </button>
        <div className={styles.barTitles}>
          <span className={styles.barTitle}>{lang('MusicMadeForYou')}</span>
          <span className={styles.barSub}>{lang('MusicMixStep', { step: 1, total: 2 })}</span>
        </div>
      </div>
      <div className={styles.body}>
        <h2 className={styles.title}>{lang('MusicMixWhoTitle')}</h2>
        <p className={styles.hint}>{lang('MusicMixWhoHint')}</p>
        <input
          className={buildClassName(kit.input, styles.search)}
          value={query}
          placeholder={lang('MusicMixArtistsSearch')}
          aria-label={lang('MusicMixArtistsSearch')}
          data-music-mix-artists-search
          onChange={handleQuery}
        />
        {!found && !chosen.length && <PvSkeleton />}
        {found && !shown.length && <PvEmpty text={lang('MusicMixArtistsEmpty')} />}
        {Boolean(shown.length) && <div className={styles.grid}>{shown.map(renderArtist)}</div>}
      </div>
      <div className={styles.bottom}>
        <span className={styles.count}>{lang('MusicMixChosenCount', { count: chosen.length })}</span>
        <button type="button" className={buildClassName(kit.btn, styles.skip)} onClick={goBackMusic}>
          {lang('MusicMixSkip')}
        </button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!chosen.length || isSaving}
          data-music-mix-artists-done
          onClick={handleNext}
        >
          {lang('MusicMixNextStep')}
        </button>
      </div>
    </div>
  );
};

export default memo(MusicMixArtistsView);
