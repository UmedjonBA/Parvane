import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { MusicAlbum, MusicArtist, MusicTrack } from '../../../api/parvane/musicApi';
import type { MusicFileInfo, MusicTagField, MusicTags } from '../../../api/parvane/musicFilesApi';
import type { MusicFileSheet } from './musicFiles';

import buildClassName from '../../../util/buildClassName';
import {
  closeMusicFileSheet, formatFileQuality, formatFileSource, getMusicFileSheet, notifyMusicLibraryChanged,
  openMusicFileSheet, prepareCover,
} from './musicFiles';
import { formatMusicDate } from './musicFormat';
import { callMusic } from './musicPlayer';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSheet from '../notes/PvSheet';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import { formatMusicSize } from './MusicSize';

import styles from './MusicFileSheets.module.scss';

type Form = Partial<Record<MusicTagField, string>>;

const RELEASE_TYPES = ['album', 'single', 'ep', 'compilation'] as const;
const RELEASE_KEYS = {
  album: 'MusicKindAlbum', single: 'MusicKindSingleTitle', ep: 'MusicKindEp', compilation: 'MusicKindCompile',
} as const;
const ARTIST_SUGGESTIONS = 4;

// Parvane (макет «Музыки» 23 ноя, доски `ZpMusicX`, `ZdMusicX`, `RpMusicA`): экраны правки файлов библиотеки —
// «Откуда файл», «Изменить трек / N треков / альбом» (меняются только тронутые поля; у нескольких «Разные» — значения
// не совпадают), «Объединить исполнителей», «Перенести треки». Телефон — страницей, компьютер — окном
const MusicFileSheets = () => {
  const sheet = useDerivedState(getMusicFileSheet);
  if (!sheet) return undefined;
  switch (sheet.kind) {
    case 'info':
      return <FileInfoSheet track={sheet.track} />;
    case 'merge':
      return <MergeArtistsSheet artistId={sheet.artistId} name={sheet.name} />;
    case 'move':
      return <MoveTracksSheet tracks={sheet.tracks} />;
    default:
      return <TagEditorSheet sheet={sheet} />;
  }
};

// «Откуда файл»: источник, кто добавил, файл, путь на сервере, теги, «Вернуть исходные теги», версии
const FileInfoSheet = memo(({ track }: { track: MusicTrack }) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [info, setInfo] = useState<MusicFileInfo>();
  const [isFailed, setIsFailed] = useState(false);

  const load = useLastCallback(() => {
    void callMusic('parvaneMusicFileInfo', { trackId: track.id }).then(setInfo, () => setIsFailed(true));
  });
  useEffect(() => load(), [track.id, load]);

  const handleRestore = useLastCallback(async () => {
    const isDone = await callMusic('parvaneMusicFileRestoreTags', { trackId: track.id }).then(() => true, () => false);
    showNotification({ message: lang(isDone ? 'MusicTagsRestored' : 'MusicPlaylistFailed') });
    if (isDone) {
      notifyMusicLibraryChanged();
      load();
    }
  });
  const handleRefetch = useLastCallback(async () => {
    if (!info) return;
    const url = info.sourceRef.startsWith('https://') ? info.sourceRef : undefined;
    const job = url
      ? await callMusic('parvaneMusicFetchLink', { url, asVersion: true }).catch(() => undefined)
      : await callMusic('parvaneMusicFetchQuery', { query: `${track.artist} ${track.title}` }).catch(() => undefined);
    showNotification({ message: lang(job ? 'MusicRefetchStarted' : 'MusicFetchFailedShort') });
    closeMusicFileSheet();
  });
  const handleEdit = useLastCallback(() => openMusicFileSheet({ kind: 'tracks', tracks: [track] }));

  function renderRow(label: string, value: string, isMono?: boolean) {
    return (
      <div className={styles.infoRow}>
        <span className={styles.infoLabel}>{label}</span>
        <span className={buildClassName(styles.infoValue, isMono && styles.mono)}>{value}</span>
      </div>
    );
  }

  function renderBody() {
    if (!info) return isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton />;
    const source = formatFileSource(lang, info, true);
    const fileLine = [formatFileQuality(lang, info), formatMusicSize(lang, info.bytes)].filter(Boolean).join(' · ');
    return (
      <div className={styles.info} data-music-file-info>
        <div className={styles.infoCard}>
          {renderRow(lang('MusicFileSource'), source)}
          {info.adder && renderRow(lang('MusicFileAdded'), `${info.adder} · ${formatMusicDate(lang, info.addedMs)}`)}
          {renderRow(lang('MusicFileFile'), fileLine)}
          {renderRow(lang('MusicFileOnServer'), info.path, true)}
          {renderRow(
            lang('MusicFileTags'),
            info.editedMs
              ? lang('MusicFileTagsEdited', { name: info.editedBy, date: formatMusicDate(lang, info.editedMs) })
              : lang('MusicFileTagsOriginal'),
          )}
        </div>
        <div className={styles.actionList}>
          {info.canEdit && (
            <button type="button" className={styles.action} onClick={handleEdit}>
              <ParvaneIcon name="pen" isSmall />
              {lang('MusicEditTags')}
            </button>
          )}
          {info.canEdit && info.hasOriginalTags && (
            <button type="button" className={styles.action} data-music-restore-tags onClick={handleRestore}>
              <ParvaneIcon name="refresh" isSmall />
              {lang('MusicRestoreTags')}
            </button>
          )}
          <button type="button" className={styles.action} onClick={handleRefetch}>
            <ParvaneIcon name="cloudDown" isSmall />
            {lang('MusicRefetch')}
          </button>
        </div>
        {Boolean(info.versions.length) && (
          <div className={styles.infoCard} data-music-versions>
            <div className={styles.caps}>{lang('MusicOtherVersions', { count: info.versions.length })}</div>
            {info.versions.map((version) => (
              <div key={version.id} className={styles.versionRow}>
                <MusicCover
                  coverId={version.coverId}
                  toneId={version.albumId || version.id}
                  size={36}
                  className={styles.versionCover}
                />
                <span className={styles.versionText}>
                  <span>{version.title}</span>
                  <span className={styles.muted}>{[version.artist, version.adder].filter(Boolean).join(' · ')}</span>
                </span>
                {Boolean(version.version && version.version > 1) && (
                  <span className={styles.tag}>{`v${version.version}`}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className={styles.note}>{lang('MusicFileNote')}</p>
      </div>
    );
  }

  return (
    <PvSheet
      isOpen
      isPage
      startClose="back"
      title={lang('MusicFileOrigin')}
      subtitle={`${track.title} · ${track.artist}`}
      onClose={closeMusicFileSheet}
    >
      {renderBody()}
    </PvSheet>
  );
});

// «Изменить трек / N треков / альбом»
const TagEditorSheet = memo(({ sheet }: { sheet: Extract<MusicFileSheet, { kind: 'tracks' | 'album' }> }) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const fileRef = useRef<HTMLInputElement>();
  const { tracks } = sheet;
  const isAlbum = sheet.kind === 'album';
  const isMany = !isAlbum && tracks.length > 1;
  const first = tracks[0];
  // Начальные значения: общие у всех треков; не совпадают — пусто с подсказкой «Разные»
  const initial = useMemo<Form>(() => {
    const common = (pick: (track: MusicTrack) => string) => {
      const values = new Set(tracks.map(pick));
      return values.size === 1 ? [...values][0] : undefined;
    };
    return {
      title: isMany ? undefined : first?.title,
      artist: common((track) => track.artist),
      album: common((track) => track.album),
      year: common((track) => (track.year ? String(track.year) : '')),
    };
  }, [tracks, isMany, first]);
  const [form, setForm] = useState<Form>(initial);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [cover, setCover] = useState<{ bytes?: Uint8Array; url?: string; preview?: string }>();
  const [artists, setArtists] = useState<MusicArtist[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const artistQuery = touched.has('artist') ? (form.artist || '').trim() : '';

  useEffect(() => {
    if (artistQuery.length < 2) {
      setArtists([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void callMusic('parvaneMusicSearch', { query: artistQuery })
        .then((found) => setArtists(found.artists.slice(0, ARTIST_SUGGESTIONS)), () => setArtists([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [artistQuery]);

  const handleInput = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.currentTarget;
    setForm((previous) => ({ ...previous, [name]: value }));
    setTouched((previous) => new Set(previous).add(name));
  });
  const handleType = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const value = e.currentTarget.dataset.value!;
    setForm((previous) => ({ ...previous, release_type: value }));
    setTouched((previous) => new Set(previous).add('release_type'));
  });
  const handlePickArtist = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const name = e.currentTarget.dataset.name!;
    setForm((previous) => ({ ...previous, artist: name }));
    setArtists([]);
  });
  const handlePickCover = useLastCallback(() => fileRef.current?.click());
  const handleCoverFile = useLastCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const bytes = await prepareCover(file);
    if (!bytes) {
      showNotification({ message: lang('MusicCoverTooBig') });
      return;
    }
    setCover({ bytes, preview: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })) });
  });
  const handleCatalogCover = useLastCallback(async () => {
    const query = `${form.artist || first?.artist || ''} ${form.album || first?.album || ''}`.trim();
    const found = await callMusic('parvaneMusicCatalogSearch', { query }).catch(() => undefined);
    const url = found?.albums.find((album) => album.coverUrl)?.coverUrl;
    if (url) setCover({ url, preview: url });
    else showNotification({ message: lang('MusicCoverNotInCatalog') });
  });
  const handleMerge = useLastCallback(() => {
    if (first?.artistId) openMusicFileSheet({ kind: 'merge', artistId: first.artistId, name: first.artist });
  });
  const handleMove = useLastCallback(() => openMusicFileSheet({ kind: 'move', tracks }));

  const handleSave = useLastCallback(async () => {
    const fields = [...touched].filter((field) => field !== 'release_type' || isAlbum) as MusicTagField[];
    // Альбом: исполнитель альбома — и у треков, название — поле альбома
    const tags: Partial<MusicTags> = {
      title: form.title,
      artist: form.artist,
      album: form.album,
      albumArtist: isAlbum ? form.artist : undefined,
      year: Number(form.year) || 0,
      genre: form.genre,
      releaseType: form.release_type,
    };
    if (isAlbum && touched.has('artist')) fields.push('album_artist');
    if (!fields.length && !cover) {
      closeMusicFileSheet();
      return;
    }
    setIsSaving(true);
    const result = await callMusic('parvaneMusicFileTags', {
      trackIds: tracks.map((track) => track.id),
      tags,
      fields,
      coverUrl: cover?.url,
      cover: cover?.bytes,
    }).catch(() => undefined);
    setIsSaving(false);
    if (!result) {
      showNotification({ message: lang('MusicTagsForbidden') });
      return;
    }
    showNotification({ message: lang('MusicTagsSaved', { count: result.changed }, { pluralValue: result.changed }) });
    notifyMusicLibraryChanged();
    closeMusicFileSheet();
  });

  function renderField(name: MusicTagField | 'year', label: string, isShort?: boolean) {
    const placeholder = initial[name] === undefined && isMany ? lang('MusicTagsMixed') : undefined;
    return (
      <label className={buildClassName(styles.field, isShort && styles.fieldShort)}>
        <span className={styles.fieldLabel}>{label}</span>
        <input
          className={styles.input}
          name={name}
          value={form[name] || ''}
          placeholder={placeholder}
          inputMode={name === 'year' ? 'numeric' : undefined}
          onChange={handleInput}
        />
      </label>
    );
  }

  const title = isAlbum ? lang('MusicEditAlbum') : isMany
    ? lang('MusicEditTracks', { count: tracks.length }, { pluralValue: tracks.length })
    : lang('MusicEditTrack');
  const subtitle = isMany ? tracks.map((track) => track.title).slice(0, 3).join(', ') : first?.title;

  return (
    <PvSheet
      isOpen
      isPage
      startClose="back"
      title={title}
      subtitle={subtitle}
      headAfter={(
        <button type="button" className={styles.save} disabled={isSaving} data-music-tags-save onClick={handleSave}>
          {lang('Save')}
        </button>
      )}
      onClose={closeMusicFileSheet}
    >
      <div className={styles.editor} data-music-tag-editor={sheet.kind}>
        {isAlbum && (
          <div className={styles.coverRow}>
            {cover?.preview ? (
              <img className={styles.coverImage} src={cover.preview} alt="" />
            ) : (
              <MusicCover
                coverId={first?.coverId}
                toneId={sheet.albumId}
                size={100}
                glyph="disc"
                className={styles.coverImage}
              />
            )}
            <div className={styles.coverActions}>
              <button type="button" className={styles.pill} onClick={handlePickCover}>
                {lang('MusicChangeCover')}
              </button>
              <button type="button" className={styles.link} onClick={handleCatalogCover}>
                {lang('MusicCoverFromCatalog')}
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className={styles.hidden} onChange={handleCoverFile} />
          </div>
        )}
        {isMany && <p className={styles.note}>{lang('MusicTagsManyHint')}</p>}
        {!isMany && renderField(isAlbum ? 'album' : 'title', lang(isAlbum ? 'MusicTagAlbumName' : 'MusicTagTitle'))}
        {renderField('artist', lang(isAlbum ? 'MusicTagAlbumArtist' : 'MusicTagArtist'))}
        {Boolean(artists.length) && (
          <div className={styles.suggest}>
            <div className={styles.caps}>{lang('MusicTagInLibrary')}</div>
            {artists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                className={styles.suggestRow}
                data-name={artist.name}
                onClick={handlePickArtist}
              >
                <ParvaneIcon name="mic" isSmall />
                <span className={styles.suggestName}>{artist.name}</span>
                <span className={styles.muted}>
                  {lang('MusicTracksCount', { count: artist.trackCount }, { pluralValue: artist.trackCount })}
                </span>
              </button>
            ))}
          </div>
        )}
        {isMany && renderField('album', lang('MusicTagAlbum'))}
        <div className={styles.fieldPair}>
          {renderField('year', lang('MusicTagYear'), true)}
          {renderField('genre', lang('MusicTagGenre'))}
        </div>
        {isAlbum && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{lang('MusicTagType')}</span>
            <div className={styles.segment} role="radiogroup">
              {RELEASE_TYPES.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={form.release_type === value}
                  className={buildClassName(styles.segmentItem, form.release_type === value && styles.segmentOn)}
                  data-value={value}
                  onClick={handleType}
                >
                  {lang(RELEASE_KEYS[value])}
                </button>
              ))}
            </div>
          </div>
        )}
        {isAlbum && (
          <div className={styles.actionList}>
            <button type="button" className={styles.action} onClick={handleMerge}>
              <ParvaneIcon name="merge" isSmall />
              {lang('MusicMergeArtistsAction')}
            </button>
            <button type="button" className={styles.action} onClick={handleMove}>
              <ParvaneIcon name="swap" isSmall />
              {lang('MusicMoveTracksAction')}
            </button>
          </div>
        )}
        <p className={styles.note}>{lang('MusicTagsRightsNote')}</p>
      </div>
    </PvSheet>
  );
});

// «Объединить исполнителей»: написания одного имени — треки выбранного переезжают к оставленному
const MergeArtistsSheet = memo(({ artistId, name }: { artistId: string; name: string }) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [candidates, setCandidates] = useState<MusicArtist[]>();
  const [target, setTarget] = useState<string>(artistId);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const word = name.split(/[\s&,]+/)[0] || name;
    void callMusic('parvaneMusicSearch', { query: word }).then((found) => {
      const lower = word.toLowerCase();
      setCandidates(found.artists.filter((artist) => artist.name.toLowerCase().includes(lower)));
    }, () => setCandidates([]));
  }, [name]);

  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setTarget(e.currentTarget.dataset.id!);
  });
  const handleMerge = useLastCallback(async () => {
    const keep = candidates?.find((artist) => artist.id === target);
    const others = candidates?.filter((artist) => artist.id !== target) || [];
    if (!keep || !others.length) return;
    setIsSaving(true);
    const tracks = (await Promise.all(others.map((artist) => loadArtistTracks(artist.id)))).flat();
    const result = tracks.length ? await callMusic('parvaneMusicFileTags', {
      trackIds: tracks.map((track) => track.id), tags: { artist: keep.name }, fields: ['artist'],
    }).catch(() => undefined) : { changed: 0, failed: 0 };
    setIsSaving(false);
    showNotification({
      message: result ? lang('MusicMerged', { name: keep.name }) : lang('MusicTagsForbidden'),
    });
    if (result) notifyMusicLibraryChanged();
    closeMusicFileSheet();
  });

  const keep = candidates?.find((artist) => artist.id === target);
  const moving = candidates?.filter((artist) => artist.id !== target) || [];
  const movingTracks = moving.reduce((sum, artist) => sum + artist.trackCount, 0);

  return (
    <PvSheet isOpen isPage startClose="back" title={lang('MusicMergeArtists')} onClose={closeMusicFileSheet}>
      <div className={styles.editor} data-music-merge>
        <p className={styles.note}>{lang('MusicMergeHint')}</p>
        {!candidates ? <PvSkeleton /> : (
          <div className={styles.choiceList} role="radiogroup">
            {candidates.map((artist) => (
              <button
                key={artist.id}
                type="button"
                role="radio"
                aria-checked={artist.id === target}
                className={styles.choice}
                data-id={artist.id}
                onClick={handlePick}
              >
                <span className={buildClassName(styles.radio, artist.id === target && styles.radioOn)} />
                <MusicCover
                  coverId={artist.coverId}
                  toneId={artist.id}
                  size={40}
                  glyph="mic"
                  isRound
                  className={styles.choiceCover}
                />
                <span className={styles.versionText}>
                  <span>{artist.name}</span>
                  <span className={styles.muted}>
                    {lang('MusicTracksCount', { count: artist.trackCount }, { pluralValue: artist.trackCount })}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {keep && Boolean(moving.length) && (
          <p className={styles.summary}>
            {lang('MusicMergeSummary', { count: movingTracks, name: keep.name }, { pluralValue: movingTracks })}
          </p>
        )}
        <button
          type="button"
          className={styles.primary}
          disabled={!keep || !moving.length || isSaving}
          data-music-merge-apply
          onClick={handleMerge}
        >
          {lang('MusicMergeInto', { name: keep?.name || '' })}
        </button>
      </div>
    </PvSheet>
  );
});

// «Перенести треки» в другой альбом либо новый
const MoveTracksSheet = memo(({ tracks }: { tracks: MusicTrack[] }) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [query, setQuery] = useState('');
  const [albums, setAlbums] = useState<MusicAlbum[]>();
  const [target, setTarget] = useState<string>();
  const [newName, setNewName] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const artist = tracks[0]?.artist || '';

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void callMusic('parvaneMusicSearch', { query: query.trim() || artist })
        .then((found) => setAlbums(found.albums), () => setAlbums([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, artist]);

  const handleQuery = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value));
  const handlePick = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setTarget(e.currentTarget.dataset.id);
    setNewName(undefined);
  });
  const handleNew = useLastCallback(() => {
    setTarget(undefined);
    setNewName(query.trim() || '');
  });
  const handleNewName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setNewName(e.currentTarget.value));
  const handleMove = useLastCallback(async () => {
    const album = albums?.find((item) => item.id === target);
    const name = album?.title || newName?.trim();
    if (!name) return;
    setIsSaving(true);
    const result = await callMusic('parvaneMusicFileTags', {
      trackIds: tracks.map((track) => track.id),
      tags: { album: name, albumArtist: album?.artist || artist, year: album?.year || 0 },
      fields: album?.year ? ['album', 'album_artist', 'year'] : ['album', 'album_artist'],
    }).catch(() => undefined);
    setIsSaving(false);
    showNotification({ message: result ? lang('MusicMoved', { name }) : lang('MusicTagsForbidden') });
    if (result) notifyMusicLibraryChanged();
    closeMusicFileSheet();
  });

  return (
    <PvSheet
      isOpen
      isPage
      startClose="back"
      title={lang('MusicMoveTracks')}
      subtitle={lang('MusicTracksCount', { count: tracks.length }, { pluralValue: tracks.length })}
      onClose={closeMusicFileSheet}
    >
      <div className={styles.editor} data-music-move>
        <input
          className={styles.input}
          type="search"
          value={query}
          placeholder={lang('MusicFindAlbum')}
          aria-label={lang('MusicFindAlbum')}
          onChange={handleQuery}
        />
        {!albums ? <PvSkeleton /> : (
          <div className={styles.choiceList} role="radiogroup">
            {albums.map((album) => (
              <button
                key={album.id}
                type="button"
                role="radio"
                aria-checked={album.id === target}
                className={styles.choice}
                data-id={album.id}
                onClick={handlePick}
              >
                <span className={buildClassName(styles.radio, album.id === target && styles.radioOn)} />
                <MusicCover
                  coverId={album.coverId}
                  toneId={album.id}
                  size={40}
                  glyph="disc"
                  className={styles.choiceCover}
                />
                <span className={styles.versionText}>
                  <span>{album.title}</span>
                  <span className={styles.muted}>
                    {[album.artist, album.year || undefined,
                      lang('MusicTracksCount', { count: album.trackCount }, { pluralValue: album.trackCount })]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {newName === undefined ? (
          <button type="button" className={styles.newAlbum} onClick={handleNew}>
            <ParvaneIcon name="plus" isSmall />
            {lang('MusicNewAlbum')}
          </button>
        ) : (
          <input
            className={styles.input}
            value={newName}
            placeholder={lang('MusicTagAlbumName')}
            aria-label={lang('MusicTagAlbumName')}
            onChange={handleNewName}
          />
        )}
        <button
          type="button"
          className={styles.primary}
          disabled={(!target && !newName?.trim()) || isSaving}
          data-music-move-apply
          onClick={handleMove}
        >
          {lang('MusicMoveN', { count: tracks.length }, { pluralValue: tracks.length })}
        </button>
      </div>
    </PvSheet>
  );
});

/** Треки исполнителя по его альбомам. */
async function loadArtistTracks(artistId: string) {
  const { albums } = await callMusic('parvaneMusicArtist', { artistId });
  const parts = await Promise.all(albums.map((album) => callMusic('parvaneMusicAlbum', { albumId: album.id })
    .then((reply) => reply.tracks).catch((): MusicTrack[] => [])));
  return parts.flat();
}

export default memo(MusicFileSheets);
