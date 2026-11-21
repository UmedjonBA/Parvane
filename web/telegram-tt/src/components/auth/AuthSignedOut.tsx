import { memo, useState } from '../../lib/teact/teact';

import type { SignedOutInfo } from '../../util/parvaneSignedOut';

import buildClassName from '../../util/buildClassName';
import { clearSignedOut, readSignedOut } from '../../util/parvaneSignedOut';

import useAppLayout from '../../hooks/useAppLayout';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Portal from '../ui/Portal';

import styles from '../main/ParvaneShell.module.scss';
import kit from '../parvane/notes/PvKit.module.scss';

const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit' } as const;
const DATE_OPTIONS = { day: 'numeric', month: 'long' } as const;

// Parvane (доски `ZdNav`, `XpAuth`): «Вы вышли на этом компьютере / Это устройство вышло из аккаунта» — экран поверх
// формы входа после отзыва этого устройства другим устройством аккаунта. Провайдер к этому моменту стёр данные
// аккаунта и оставил отметку (`parvaneSignedOut.ts`); «Войти заново» снимает её. Какое устройство отозвало, сервер
// этому устройству уже не скажет — в тексте только время
const AuthSignedOut = () => {
  const lang = useLang();
  const { isMobile } = useAppLayout();
  // Время показа запоминается вместе с отметкой: «сегодня» считается от него, а не на каждой перерисовке
  const [info, setInfo] = useState<(SignedOutInfo & { shownAtMs: number }) | undefined>(() => {
    const saved = readSignedOut();
    return saved && { ...saved, shownAtMs: Date.now() };
  });

  const handleSignIn = useLastCallback(() => {
    clearSignedOut();
    setInfo(undefined);
  });

  if (!info) return undefined;

  const at = new Date(info.atMs);
  const time = at.toLocaleTimeString(lang.code, TIME_OPTIONS);
  const isToday = at.toDateString() === new Date(info.shownAtMs).toDateString();
  const when = isToday ? lang('ShellWhenToday', { time })
    : lang('ShellWhenDate', { date: at.toLocaleDateString(lang.code, DATE_OPTIONS), time });
  const title = lang(isMobile ? 'ShellSignedOutTitle' : 'ShellSignedOutTitleDesktop');

  return (
    <Portal>
      <div className={buildClassName(styles.overlay, isMobile && styles.pageOverlay)} data-signed-out>
        <div
          className={buildClassName(isMobile ? styles.page : styles.dialog, !isMobile && styles.dialogNarrow)}
          role="dialog"
          aria-label={title}
        >
          <span className={styles.logo} aria-hidden>P</span>
          <div>
            <h1 className={buildClassName(styles.title, isMobile && styles.titleLarge)}>{title}</h1>
            <p className={styles.text}>{lang('ShellSignedOutText', { when })}</p>
          </div>
          <div className={styles.card}>
            <div className={styles.row}>
              <span className={styles.rowText}>{lang('ShellSignedOutWiped')}</span>
              <span className={styles.rowValue}>{lang('ShellSignedOutWipedValue')}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowText}>{lang('ShellSignedOutServer')}</span>
              <span className={styles.rowValue}>{lang('ShellSignedOutServerValue')}</span>
            </div>
          </div>
          <p className={styles.foot}>{lang('ShellSignedOutNotYou')}</p>
          {isMobile && <span className={styles.spacer} />}
          <div className={styles.buttons}>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc, isMobile && kit.btnWide)}
              data-signed-out-sign-in
              onClick={handleSignIn}
            >
              {lang('ShellSignedOutSignIn')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(AuthSignedOut);
