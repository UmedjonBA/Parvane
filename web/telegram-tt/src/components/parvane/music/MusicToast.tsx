import { memo } from '../../../lib/teact/teact';

import { getMusicToast, hideMusicToast } from './musicToast';

import useDerivedState from '../../../hooks/useDerivedState';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import styles from './MusicToast.module.scss';

// Parvane (доска `RpMusicA-06`): «„Трек“ — в очереди следующим · Отменить» над мини-плеером
const MusicToast = () => {
  const lang = useLang();
  const toast = useDerivedState(getMusicToast);

  const handleUndo = useLastCallback(() => {
    toast?.onUndo?.();
    hideMusicToast();
  });

  if (!toast) return undefined;

  return (
    <div className={styles.root} role="status" data-music-toast>
      <span className={styles.text}>{toast.text}</span>
      {toast.onUndo && (
        <button type="button" className={styles.undo} data-music-toast-undo onClick={handleUndo}>
          {lang('MusicUndo')}
        </button>
      )}
    </div>
  );
};

export default memo(MusicToast);
