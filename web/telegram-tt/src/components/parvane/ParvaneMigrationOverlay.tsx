// spec 035 T115: экран хода разового переноса данных устройства (формат хранилища, состояние клиента в модели
// движка). Перенос идёт в провайдере; экран слушает `parvane-migration` (`api/parvane/migrationProgress.ts`) и
// показывается, пока перенос идёт дольше мгновения; сбой — короткое сообщение (перенос повторится при запуске).
import { memo, useEffect, useState } from '../../lib/teact/teact';

import type { MigrationProgress } from '../../api/parvane/migrationProgress';

import { MIGRATION_EVENT } from '../../api/parvane/migrationProgress';

import useLang from '../../hooks/useLang';

import Spinner from '../ui/Spinner';

import styles from './ParvaneMigrationOverlay.module.scss';

// Короткий перенос (несколько записей) экран не мигает
const SHOW_DELAY_MS = 400;
const ERROR_SHOW_MS = 8000;

const ParvaneMigrationOverlay = () => {
  const lang = useLang();
  const [progress, setProgress] = useState<MigrationProgress | undefined>();
  const [isShown, setIsShown] = useState(false);

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const onProgress = (e: Event) => {
      const next = (e as CustomEvent<MigrationProgress>).detail;
      setProgress(next);
      if (hideTimer) clearTimeout(hideTimer);
      if (next.active) {
        showTimer ||= setTimeout(() => setIsShown(true), SHOW_DELAY_MS);
        return;
      }
      if (showTimer) clearTimeout(showTimer);
      showTimer = undefined;
      if (next.error) {
        setIsShown(true);
        hideTimer = setTimeout(() => setIsShown(false), ERROR_SHOW_MS);
      } else {
        setIsShown(false);
      }
    };
    window.addEventListener(MIGRATION_EVENT, onProgress);
    return () => {
      window.removeEventListener(MIGRATION_EVENT, onProgress);
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!isShown || !progress) return undefined;

  const step = progress.phase === 'storage' ? lang('ParvaneMigrationStorage') : lang('ParvaneMigrationEngine');
  const percent = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <div className={styles.overlay} role="dialog" aria-live="polite" data-parvane-migration={progress.phase}>
      <div className={styles.card}>
        {!progress.error && <Spinner />}
        <h3 className={styles.title}>{lang('ParvaneMigrationTitle')}</h3>
        <p className={styles.step}>{step}</p>
        {progress.error ? (
          <p className={styles.error}>{lang('ParvaneMigrationFailed')}</p>
        ) : (
          <>
            <div className={styles.bar}>
              <div className={styles.fill} style={`width: ${percent}%`} />
            </div>
            <p className={styles.hint}>{lang('ParvaneMigrationKeepOpen')}</p>
          </>
        )}
      </div>
    </div>
  );
};

export default memo(ParvaneMigrationOverlay);
