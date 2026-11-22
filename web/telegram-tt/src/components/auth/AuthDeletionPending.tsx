import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { ParvaneDeletionPending } from '../../api/parvane/authApi';

import buildClassName from '../../util/buildClassName';
import { requestExportAfterLogin } from '../../util/parvaneExportAfterLogin';
import { fetchParvaneDeletionPending, leaveParvaneDeletionPending } from '../../api/parvane/authApi';
import { countDaysLeft } from './authFormat';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import PvIcon from '../parvane/notes/PvIcon';

import styles from './Auth.module.scss';

const DATE_OPTIONS = { day: 'numeric', month: 'long' } as const;

// Parvane (доска `RpProfileC` «Вход в аккаунт, который ждёт удаления»; spec 027): пароль верен, но сессию сервер
// выдаёт только с отменой удаления. Экран вместо формы входа: когда удалится и когда запрошено, сколько дней
// осталось, «Восстановить аккаунт», «Выгрузить мои данные» (выгрузка идёт в приложении — вход отменяет удаление,
// об этом сказано до входа; после входа сразу открывается выгрузка) и «Выйти, удаление продолжится»
const AuthDeletionPending = () => {
  const { parvaneRestoreAccount, clearAuthErrorKey } = getActions();
  const lang = useLang();
  const [pending, setPending] = useState<ParvaneDeletionPending | undefined>();
  const [isExportAsked, askExport] = useFlag();

  useEffect(() => {
    void fetchParvaneDeletionPending().then(setPending);
  }, []);

  const handleRestore = useLastCallback(() => {
    parvaneRestoreAccount();
  });

  const handleExport = useLastCallback(() => {
    requestExportAfterLogin();
    parvaneRestoreAccount();
  });

  const handleLeave = useLastCallback(() => {
    clearAuthErrorKey();
    void leaveParvaneDeletionPending();
  });

  const formatDate = (atMs: number) => new Date(atMs).toLocaleDateString(lang.code, DATE_OPTIONS);

  function renderDates(info: ParvaneDeletionPending) {
    const date = formatDate(info.atMs);
    const days = countDaysLeft(info.atMs, Date.now());
    const text = info.requestedAtMs
      ? lang('ParvaneDeletionText', { requested: formatDate(info.requestedAtMs), date })
      : lang('ParvaneDeletionTextNoRequested', { date });
    return (
      <>
        <div>
          <h2 className={styles.headTitle}>
            {lang('ParvaneDeletionTitle', { date })}
          </h2>
          <p className={styles.muted}>{text}</p>
        </div>
        <div className={styles.deletionDays} data-deletion-days={days}>
          <span className={styles.deletionCount}>
            {lang('ParvaneDeletionDays', { count: days }, { pluralValue: days })}
          </span>
          <span className={styles.small}>{lang('ParvaneDeletionDaysHint')}</span>
        </div>
      </>
    );
  }

  return (
    <div className={styles.form} data-deletion-pending role="alert">
      <span className={styles.deletionIcon} aria-hidden>
        <PvIcon name="trash" />
      </span>
      {pending && renderDates(pending)}
      {isExportAsked && <p className={styles.small} data-deletion-export-note>{lang('ParvaneDeletionExportNote')}</p>}
      <div className={styles.deletionButtons}>
        <span className={styles.deletionRestore} data-restore-account>
          <button type="button" className={buildClassName(styles.button, styles.grow)} onClick={handleRestore}>
            {lang('ParvaneRestoreAccount')}
          </button>
        </span>
        {isExportAsked ? (
          <button
            type="button"
            className={buildClassName(styles.button, styles.buttonQuiet)}
            data-deletion-export-confirm
            onClick={handleExport}
          >
            {lang('ParvaneDeletionExportConfirm')}
          </button>
        ) : (
          <button
            type="button"
            className={buildClassName(styles.button, styles.buttonQuiet)}
            data-deletion-export
            onClick={askExport}
          >
            {lang('ParvaneExportData')}
          </button>
        )}
        <button type="button" className={styles.link} data-deletion-leave onClick={handleLeave}>
          {lang('ParvaneDeletionLeave')}
        </button>
      </div>
    </div>
  );
};

export default memo(AuthDeletionPending);
