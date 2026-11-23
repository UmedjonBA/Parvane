import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import { callMusic } from './musicPlayer';
import { goBackMusic } from './musicView';
import useMusicData from './useMusicData';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvEmpty from '../notes/PvEmpty';
import PvSkeleton from '../notes/PvSkeleton';
import MusicCover from './MusicCover';
import MusicSectionHead from './MusicSectionHead';

import styles from './MusicLibrary.module.scss';
import select from './MusicSelect.module.scss';

type OwnProps = {
  isPhone?: boolean;
};

// Parvane (макет «Музыки» 23 ноя, доски `MusicLibrary-10`, `ZdMusicX-05`): корзина — удалённое лежит 30 дней,
// «Вернуть» возвращает файл на сервер. Человек видит своё; администратор — всю корзину сервера, «Удалить навсегда»
// и «Очистить»
const MusicTrashView = ({ isPhone }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { data, isFailed, reload, patch } = useMusicData('trash', () => callMusic('parvaneMusicTrashList'));

  const handleRestore = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const { id } = e.currentTarget.dataset;
    patch((previous) => ({ ...previous, items: previous.items.filter((item) => item.id !== id) }));
    const isDone = await callMusic('parvaneMusicTrashRestore', { id: id! }).then(() => true, () => false);
    showNotification({ message: lang(isDone ? 'MusicRestored' : 'MusicPlaylistFailed') });
    if (!isDone) reload();
  });
  const handlePurge = useLastCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    const { id } = e.currentTarget.dataset;
    patch((previous) => ({ ...previous, items: previous.items.filter((item) => item.id !== id) }));
    await callMusic('parvaneMusicTrashPurge', { id }).catch(() => reload());
  });
  const handleClear = useLastCallback(async () => {
    patch((previous) => ({ ...previous, items: [] }));
    await callMusic('parvaneMusicTrashPurge', { isAll: true }).catch(() => reload());
  });

  function renderBody() {
    if (!data) return isFailed ? <div role="alert">{lang('MusicLoadFailed')}</div> : <PvSkeleton onRetry={reload} />;
    if (!data.items.length) return <PvEmpty text={lang('MusicTrashEmpty')} data-music-empty="trash" />;
    return (
      <div className={styles.list} data-music-trash={data.items.length}>
        {data.items.map((item) => (
          <div key={item.id} className={styles.row}>
            <MusicCover toneId={item.id} size={46} className={styles.rowCover} />
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.rowSub}>
                {[
                  item.artist,
                  item.version > 1 ? `v${item.version}` : undefined,
                  lang('MusicTrashDeletedBy', { name: item.deletedBy }),
                  lang('MusicTrashDaysLeft', { count: item.daysLeft }, { pluralValue: item.daysLeft }),
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button type="button" className={styles.rowAction} data-id={item.id} onClick={handleRestore}>
              {lang('MusicRestore')}
            </button>
            {data.isAdmin && !isPhone && (
              <button type="button" className={select.textButton} data-id={item.id} onClick={handlePurge}>
                {lang('MusicPurge')}
              </button>
            )}
          </div>
        ))}
        {!data.isAdmin && <p className={styles.trashNote}>{lang('MusicTrashNote')}</p>}
      </div>
    );
  }

  return (
    <div className={styles.page} data-music-view-trash>
      <MusicSectionHead
        title={lang('MusicTrash')}
        barSubtitle={lang('MusicTrashHint')}
        subtitle={isPhone ? undefined : lang('MusicTrashHint')}
        isPhone={isPhone}
        barActions={data?.isAdmin && Boolean(data.items.length) && (
          <button type="button" className={select.textButton} data-music-trash-clear onClick={handleClear}>
            {lang('MusicClear')}
          </button>
        )}
        actions={!isPhone && data?.isAdmin && Boolean(data.items.length) && (
          <button type="button" className={select.textButton} data-music-trash-clear onClick={handleClear}>
            {lang('MusicClear')}
          </button>
        )}
        onBack={goBackMusic}
      />
      {renderBody()}
    </div>
  );
};

export default memo(MusicTrashView);
