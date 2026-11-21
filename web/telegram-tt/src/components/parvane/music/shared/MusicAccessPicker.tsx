import { memo } from '../../../../lib/teact/teact';

import type { MusicPlaylistAccess } from './musicShared';

import useLang from '../../../../hooks/useLang';

import PvSegment from '../../notes/PvSegment';

import styles from './MusicShared.module.scss';

type OwnProps = {
  value: MusicPlaylistAccess;
  // Без «Только я» (общий плейлист: «Сделать личным» — отдельный пункт)
  noPersonal?: boolean;
  onChange: (value: MusicPlaylistAccess) => void;
};

const ACCESS_VALUES: MusicPlaylistAccess[] = ['me', 'members', 'server'];
const LABEL_KEYS = {
  me: 'MusicAccessMe',
  members: 'MusicAccessMembers',
  server: 'MusicAccessServer',
} as const;
const HINT_KEYS = {
  me: 'MusicAccessMeHint',
  members: 'MusicAccessMembersHint',
  server: 'MusicAccessServerHint',
} as const;

// Parvane (spec 041, доски `RpMusicB`, `ZdMusicX`): «Кто видит» плейлист — «Только я» (личный, на устройствах),
// «Выбранные люди» (общий, только участники), «Все на сервере» (общий, в общем разделе сервера)
const MusicAccessPicker = ({ value, noPersonal, onChange }: OwnProps) => {
  const lang = useLang();
  const items = ACCESS_VALUES.filter((item) => !noPersonal || item !== 'me')
    .map((item) => ({ value: item, label: lang(LABEL_KEYS[item]) }));
  return (
    <div className={styles.access} data-music-access={value}>
      <span className={styles.fieldLabel}>{lang('MusicAccessLabel')}</span>
      <PvSegment items={items} value={value} label={lang('MusicAccessLabel')} onChange={onChange} />
      <span className={styles.hint}>{lang(HINT_KEYS[value])}</span>
      {value !== 'me' && <span className={styles.hint}>{lang('MusicAccessLater')}</span>}
    </div>
  );
};

export default memo(MusicAccessPicker);
