import { memo, useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import buildClassName from '../../../../util/buildClassName';
import { callApi } from '../../../../api/gramjs';

import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useOldLang from '../../../../hooks/useOldLang';

import PvSheet from '../../../parvane/notes/PvSheet';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './ProfileSignOutDialog.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

const callParvane = callApi as unknown as (name: string) => Promise<unknown>;

// Parvane (доска `PhProfileB`): выход — «Просто выйти» либо «Выйти и сменить ключи» (устройство могло попасть в
// чужие руки: до выхода оно меняет ключи, которые держало, и раздаёт их остальным своим устройствам). Выход с
// единственного устройства стирает ключи — тогда предупреждение про ключ восстановления, менять ключи некому
const ProfileSignOutDialog = ({ isOpen, onClose }: OwnProps) => {
  const { signOut } = getActions();
  const lang = useLang();
  const oldLang = useOldLang();
  // Пока ответ не пришёл (или запрос упал), показываем строгое предупреждение, а не обычное
  const [isLastDevice, setIsLastDevice] = useState(true);
  const [isRotating, markRotating, unmarkRotating] = useFlag();

  useEffect(() => {
    if (!isOpen) return;
    setIsLastDevice(true);
    unmarkRotating();
    void (callApi as unknown as (name: string) => Promise<boolean | undefined>)('parvaneIsLastDevice')
      .then((isLast) => setIsLastDevice(isLast !== false))
      .catch(() => undefined);
  }, [isOpen]);

  const handlePlain = useLastCallback(() => {
    onClose();
    signOut({ forceInitApi: true });
  });

  const handleRotate = useLastCallback(async () => {
    markRotating();
    await callParvane('parvaneLeaveWithKeyChange').catch(() => undefined);
    onClose();
    signOut({ forceInitApi: true });
  });

  return (
    <PvSheet isOpen={isOpen} title={lang('ShellSignOutTitle')} onClose={onClose}>
      <div className={styles.root} data-sign-out-sheet>
        <p className={styles.text}>
          {isLastDevice ? oldLang('ParvaneLogoutLastDevice') : lang('ShellSignOutText')}
        </p>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnDanger, kit.btnWide)}
          disabled={isRotating}
          data-sign-out-plain
          onClick={handlePlain}
        >
          {lang('ShellSignOutPlain')}
        </button>
        {!isLastDevice && (
          <>
            <button
              type="button"
              className={buildClassName(kit.btn, kit.btnWide)}
              disabled={isRotating}
              data-sign-out-rotate
              onClick={handleRotate}
            >
              {lang(isRotating ? 'ShellSignOutRotating' : 'ShellSignOutRotate')}
            </button>
            <p className={styles.hint}>{lang('ShellSignOutRotateHint')}</p>
          </>
        )}
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnGhost, kit.btnWide)}
          disabled={isRotating}
          onClick={onClose}
        >
          {lang('Cancel')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(ProfileSignOutDialog);
