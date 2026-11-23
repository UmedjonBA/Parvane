import { memo } from '../../../lib/teact/teact';

import { requestMusicAdd } from './musicView';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import MenuItem from '../../ui/MenuItem';

import styles from './MusicAddMenuItems.module.scss';

// Parvane (макет «Музыки» 23 ноя, доски `MusicHome`, `DeskMusic`): пункты «+» в «Музыке» — «Найти в каталоге»,
// «Вставить ссылку», «Загрузить файл», «Новый плейлист», у каждого подпись, что это даёт
const MusicAddMenuItems = () => {
  const lang = useLang();

  const handleFind = useLastCallback(() => requestMusicAdd('fetch'));
  const handleLink = useLastCallback(() => requestMusicAdd('link'));
  const handleFile = useLastCallback(() => requestMusicAdd('file'));
  const handlePlaylist = useLastCallback(() => requestMusicAdd('playlist'));

  function renderText(title: string, sub: string) {
    return (
      <span className={styles.text}>
        <span>{title}</span>
        <span className={styles.sub}>{sub}</span>
      </span>
    );
  }

  return (
    <>
      <MenuItem icon="search" onClick={handleFind}>
        {renderText(lang('MusicFindInCatalog'), lang('MusicAddFindSub'))}
      </MenuItem>
      <MenuItem icon="link" onClick={handleLink}>
        {renderText(lang('MusicAddLink'), lang('MusicAddLinkSub'))}
      </MenuItem>
      <MenuItem icon="download" onClick={handleFile}>
        {renderText(lang('MusicAddFile'), lang('MusicAddFileSub'))}
      </MenuItem>
      <MenuItem icon="add" onClick={handlePlaylist}>
        {renderText(lang('MusicPlaylistNew'), lang('MusicAddPlaylistSub'))}
      </MenuItem>
    </>
  );
};

export default memo(MusicAddMenuItems);
