import { memo, useLayoutEffect } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import { describeUpgradeProgress, getUpgradeState, postponeUpgrade } from '../../util/parvaneUpgrade';
import {
  getAppShellProgress, getCachedAppBuild, requestAppShellPrecacheNow,
} from '../../util/precacheAppShell';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Portal from '../ui/Portal';

import kit from '../parvane/notes/PvKit.module.scss';
import styles from './ParvaneShell.module.scss';

type StateProps = {
  isAppUpdateAvailable?: boolean;
};

// Сборка показывается так, как её пишет `version.txt`, но не длиннее хеша коммита
const BUILD_SHOWN_LENGTH = 12;

// Parvane (доска `ZdNav`, «Нужно обновить приложение»): сервер не принимает эту версию протокола. Версия этой
// сборки, требуемая (сервер её не называет — «новее»), ход скачивания новой сборки сервис-воркером, «Позже» —
// режим «читать можно, отправлять нельзя» (плашка вместо поля ввода, `MiddleColumn`), «Перезапустить и обновить»
const UpgradeRequired = ({ isAppUpdateAvailable }: StateProps) => {
  const lang = useLang();
  const state = useDerivedState(getUpgradeState);
  const progress = useDerivedState(getAppShellProgress);
  const cachedBuild = useDerivedState(getCachedAppBuild);
  const isOpen = state === 'dialog';

  // Новая сборка качается сразу, как окно открылось: «Перезапустить» откроет уже её
  useLayoutEffect(() => {
    if (isOpen) requestAppShellPrecacheNow();
  }, [isOpen]);

  useLayoutEffect(() => (isOpen ? captureKeyboardListeners({ onEsc: postponeUpgrade }) : undefined), [isOpen]);

  const handleRestart = useLastCallback(() => {
    window.location.reload();
  });

  if (!isOpen) return undefined;

  const status = describeUpgradeProgress(APP_BUILD, cachedBuild, progress, Boolean(isAppUpdateAvailable));
  const statusText = status.kind === 'ready' ? lang('ShellUpgradeReady')
    : status.kind === 'downloading' ? lang('ShellUpgradeDownloading')
      : status.kind === 'missing' ? lang('ShellUpgradeMissing') : lang('ShellUpgradeChecking');

  return (
    <Portal>
      <div className={buildClassName(styles.overlay, styles.overlayScrim)} data-upgrade-required>
        <div
          className={buildClassName(styles.dialog, styles.dialogMiddle)}
          role="dialog"
          aria-label={lang('ShellUpgradeTitle')}
        >
          <div>
            <h1 className={styles.title}>{lang('ShellUpgradeTitle')}</h1>
            <p className={styles.text}>{lang('ShellUpgradeText')}</p>
          </div>
          <div className={styles.card}>
            <div className={styles.row}>
              <span className={styles.rowText}>{lang('ShellUpgradeYours')}</span>
              <span className={buildClassName(styles.rowValue, styles.mono)} data-upgrade-build>
                {APP_BUILD.slice(0, BUILD_SHOWN_LENGTH)}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowText}>{lang('ShellUpgradeNeeded')}</span>
              <span className={buildClassName(styles.rowValue, styles.mono)}>{lang('ShellUpgradeNewer')}</span>
            </div>
            <div className={styles.row} data-upgrade-status={status.kind}>
              <span className={styles.dot} />
              <span className={styles.rowText}>{statusText}</span>
              {status.kind === 'downloading' && (
                <span className={buildClassName(styles.rowValue, styles.mono)}>{`${status.percent}%`}</span>
              )}
            </div>
          </div>
          <p className={styles.foot}>{lang('ShellUpgradeReadOnly')}</p>
          <div className={buildClassName(styles.buttons, styles.buttonsStack)}>
            <button type="button" className={kit.btn} data-upgrade-later onClick={postponeUpgrade}>
              {lang('ShellUpgradeLater')}
            </button>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnAcc)}
              data-upgrade-restart
              onClick={handleRestart}
            >
              {lang('ShellUpgradeRestart')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default memo(withGlobal((global): Complete<StateProps> => ({
  isAppUpdateAvailable: global.isAppUpdateAvailable,
}))(UpgradeRequired));
