import { memo, useLayoutEffect, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { MusicTrack } from '../../../api/parvane/musicApi';
import type { ApiChat } from '../../../api/types';

import {
  getHasAdminRight, isChatChannel, isChatGroup,
} from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import {
  createSharedPlaylist, ensureJoinKey, initialsOf, inviteToShared, toTrackInput,
} from './shared/musicShared';
import { getCurrentTrack, getMusicPlayer } from './musicPlayer';
import { actOnPlaylists, addTracksToPlaylist } from './musicPlaylists';
import { closeNewPlaylist, getNewPlaylist, openMusicView } from './musicView';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import ParvaneIcon from '../../main/ParvaneIcon';
import PvSegment from '../notes/PvSegment';
import PvSheet from '../notes/PvSheet';
import PvSwitch from '../notes/PvSwitch';

import kit from '../notes/PvKit.module.scss';
import styles from './MusicNewPlaylist.module.scss';

type Whose = 'mine' | 'shared' | 'group';
type Adding = 'all' | 'me';

const NAME_MAX = 120;
const NICK_MAX = 64;
const WHOSE_VALUES: Whose[] = ['mine', 'shared', 'group'];
const WHOSE_KEYS = { mine: 'MusicWhoseMine', shared: 'MusicWhoseShared', group: 'MusicWhoseGroups' } as const;
const ADDING_VALUES: Adding[] = ['all', 'me'];
const ADDING_KEYS = { all: 'MusicAddingAll', me: 'MusicAddingMe' } as const;

const callParvane = callApi as unknown as (method: string, args: unknown) => Promise<unknown>;

// Parvane (макет «Музыки» 23 ноя, доска `MusicPlaylist-05`): окно «Новый плейлист» — из «+» модуля, «+» у
// плейлистов, «Новый…» в меню трека. Название; «Чей»: «Мой» (личный, на устройствах), «Общий» (на сервере: «С кем» —
// люди по нику, «Все добавляют / Только я»), «Группы» (общий плейлист, привязанный к группе записью её журнала);
// «Сразу добавить «трек»» — трек из меню либо играющий сейчас
const MusicNewPlaylist = () => {
  const { showNotification } = getActions();
  const lang = useLang();
  const request = useDerivedState(getNewPlaylist);
  const player = useDerivedState(getMusicPlayer);
  const [name, setName] = useState('');
  const [whose, setWhose] = useState<Whose>('mine');
  const [people, setPeople] = useState<string[]>([]);
  const [nick, setNick] = useState<string>();
  const [adding, setAdding] = useState<Adding>('all');
  const [groupId, setGroupId] = useState<string>();
  const [shouldAdd, setShouldAdd] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const track = request?.track || getCurrentTrack(player);
  const isFromTrack = Boolean(request?.track);
  const isOpen = Boolean(request);

  // Окно открывается пустым — в кадр появления
  useLayoutEffect(() => {
    if (!request) return;
    setName('');
    setWhose('mine');
    setPeople([]);
    setNick(undefined);
    setAdding('all');
    setGroupId(undefined);
    setShouldAdd(true);
  }, [request]);

  // Группы, к которым можно привязать плейлист: вправе менять сведения группы
  const groups = useMemo(() => {
    if (!isOpen) return [];
    return Object.values(getGlobal().chats.byId).filter((chat: ApiChat) => (
      isChatGroup(chat) && !isChatChannel(chat) && !chat.isNotJoined
      && (chat.isCreator || getHasAdminRight(chat, 'changeInfo'))
    ));
  }, [isOpen]);

  const handleName = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setName(e.currentTarget.value));
  const handleNick = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => setNick(e.currentTarget.value));
  const handleStartNick = useLastCallback(() => setNick(''));
  const handleAddNick = useLastCallback(() => {
    const value = (nick || '').trim().replace(/^@/, '');
    setNick(undefined);
    if (value && !people.includes(value)) setPeople([...people, value]);
  });
  const handleNickKey = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    handleAddNick();
  });
  const handleRemovePerson = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const value = e.currentTarget.dataset.person!;
    setPeople(people.filter((item) => item !== value));
  });
  const handleGroup = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    setGroupId(e.currentTarget.dataset.chat);
  });

  const isReady = Boolean(name.trim()) && !isBusy && (whose !== 'group' || Boolean(groupId));

  const handleCreate = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!isReady) return;
    setIsBusy(true);
    const tracks = track && shouldAdd ? [track] : [];
    const isDone = whose === 'mine' ? await createMine(trimmed, tracks) : await createShared(trimmed, tracks);
    setIsBusy(false);
    if (!isDone) {
      showNotification({ message: lang('MusicPlaylistFailed') });
      return;
    }
    closeNewPlaylist();
    if (isFromTrack) showNotification({ message: lang('MusicPlaylistCreatedWith', { name: trimmed }) });
    else openMusicView(isDone);
  });

  async function createMine(trimmed: string, tracks: MusicTrack[]) {
    const created = await actOnPlaylists({ action: 'create', name: trimmed });
    if (!created?.id) return undefined;
    if (tracks.length) await addTracksToPlaylist(created.id, tracks);
    return { kind: 'playlist' as const, id: created.id };
  }

  // Общий плейлист (MUSIC-3) — на сервере, сразу с треком. «Только я» — позванные слушают
  async function createShared(trimmed: string, tracks: MusicTrack[]) {
    const shared = await createSharedPlaylist(trimmed, 'members', tracks.map(toTrackInput));
    if (!shared) return undefined;
    const role = adding === 'all' ? 'editor' : 'listener';
    for (const person of people) {
      const result = await inviteToShared(shared.id, person, role);
      if (result === 'unknown') showNotification({ message: lang('MusicInviteUnknownNick', { nick: person }) });
    }
    const chat = whose === 'group' && groupId ? getGlobal().chats.byId[groupId] : undefined;
    if (chat) {
      const key = await ensureJoinKey(shared.id);
      const isBound = key && await callParvane('parvaneSetGroupPlaylist', {
        chat, playlistId: shared.id, playlistKey: key,
      }).catch(() => undefined);
      if (!isBound) showNotification({ message: lang('ParvaneGroupSharedFailed') });
    }
    return { kind: 'shared' as const, id: shared.id };
  }

  function renderPeople() {
    return (
      <div className={styles.block}>
        <span className={styles.label}>{lang('MusicWithWhom')}</span>
        <div className={kit.chips} data-music-new-people>
          {people.map((person) => (
            <button
              key={person}
              type="button"
              className={kit.chip}
              aria-label={lang('MusicRemovePerson', { nick: person })}
              data-person={person}
              onClick={handleRemovePerson}
            >
              <span className={styles.avatar} aria-hidden>{initialsOf(person)}</span>
              {person}
            </button>
          ))}
          {nick === undefined ? (
            <button
              type="button"
              className={buildClassName(kit.chip, styles.add)}
              data-music-new-person
              onClick={handleStartNick}
            >
              <ParvaneIcon name="plus" isSmall />
              {lang('MusicWithAdd')}
            </button>
          ) : (
            <input
              className={buildClassName(kit.input, styles.nick)}
              value={nick}
              maxLength={NICK_MAX}
              placeholder={lang('MusicNickPlaceholder')}
              aria-label={lang('MusicNickPlaceholder')}
              autoFocus
              data-music-new-nick
              onChange={handleNick}
              onKeyDown={handleNickKey}
              onBlur={handleAddNick}
            />
          )}
        </div>
        <PvSegment
          items={ADDING_VALUES.map((value) => ({ value, label: lang(ADDING_KEYS[value]) }))}
          value={adding}
          label={lang('MusicWhoAdds')}
          onChange={setAdding}
        />
      </div>
    );
  }

  function renderGroups() {
    return (
      <div className={styles.block}>
        <span className={styles.label}>{lang('MusicGroupLabel')}</span>
        {!groups.length && <span className={styles.hint}>{lang('MusicNoGroups')}</span>}
        <div className={kit.chips} role="radiogroup" data-music-new-groups>
          {groups.map((chat) => (
            <button
              key={chat.id}
              type="button"
              role="radio"
              aria-checked={chat.id === groupId}
              className={buildClassName(kit.chip, chat.id === groupId && kit.chipOn)}
              data-chat={chat.id}
              onClick={handleGroup}
            >
              <ParvaneIcon name="chat" isSmall />
              {chat.title}
            </button>
          ))}
        </div>
        <span className={styles.hint}>{lang('MusicGroupPlaylistHint')}</span>
      </div>
    );
  }

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('MusicPlaylistNew')}
      onClose={closeNewPlaylist}
      onEnter={handleCreate}
    >
      <form className={styles.form} data-music-new-playlist-form data-whose={whose} onSubmit={handleCreate}>
        <label className={styles.block}>
          <span className={styles.label}>{lang('MusicPlaylistNameLabel')}</span>
          <input
            className={kit.input}
            value={name}
            maxLength={NAME_MAX}
            placeholder={lang('MusicPlaylistNamePlaceholder')}
            aria-label={lang('MusicPlaylistNameLabel')}
            autoFocus
            onChange={handleName}
          />
        </label>
        <div className={styles.block}>
          <span className={styles.label}>{lang('MusicWhoseLabel')}</span>
          <PvSegment
            items={WHOSE_VALUES.map((value) => ({ value, label: lang(WHOSE_KEYS[value]) }))}
            value={whose}
            label={lang('MusicWhoseLabel')}
            onChange={setWhose}
          />
        </div>
        {whose === 'shared' && renderPeople()}
        {whose === 'group' && renderGroups()}
        {track && (
          <PvSwitch isOn={shouldAdd} data-music-add-current onChange={setShouldAdd}>
            <span className={styles.switchText}>
              <span>{lang('MusicPlaylistAddTrack', { name: track.title })}</span>
              {!isFromTrack && <span className={styles.hint}>{lang('MusicPlaylistAddPlaying')}</span>}
            </span>
          </PvSwitch>
        )}
        <button type="submit" className={buildClassName(kit.btn, kit.btnAcc, styles.create)} disabled={!isReady}>
          {lang('MusicPlaylistCreate')}
        </button>
      </form>
    </PvSheet>
  );
};

export default memo(MusicNewPlaylist);
