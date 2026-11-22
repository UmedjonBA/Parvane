import {
  memo, useEffect, useMemo, useRef,
} from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import { copyTextToClipboard } from '../../../../util/clipboard';
import { createStyledQrCode } from '../../../../util/qrCode/buildStyledQrCode';

import useAppLayout from '../../../../hooks/useAppLayout';
import useFlag from '../../../../hooks/useFlag';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import PvSheet from '../../../parvane/notes/PvSheet';

import kit from '../../../parvane/notes/PvKit.module.scss';
import styles from './Profile.module.scss';

type OwnProps = {
  isOpen: boolean;
  fingerprint: string;
  onClose: NoneToVoidFunction;
};

const GROUP_LENGTH = 4;
const GROUPS_IN_ROW = 4;
const QR_SIZE = 200;

// Parvane (доска `RpProfileC`): «Ключ безопасности» — свой отпечаток группами по четыре знака, «Скопировать» и
// «Показать QR» (в QR тот же отпечаток). По нему собеседник убеждается, что пишет именно вам
const SecurityKeySheet = ({ isOpen, fingerprint, onClose }: OwnProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const { isMobile } = useAppLayout();
  const [isQrShown, showQr, hideQr] = useFlag();
  const qrRef = useRef<HTMLDivElement>();

  const rows = useMemo(() => {
    const groups = fingerprint.replace(/\s+/g, '').toUpperCase().match(new RegExp(`.{1,${GROUP_LENGTH}}`, 'g')) || [];
    const result: string[] = [];
    for (let index = 0; index < groups.length; index += GROUPS_IN_ROW) {
      result.push(groups.slice(index, index + GROUPS_IN_ROW).join(' '));
    }
    return result;
  }, [fingerprint]);

  useEffect(() => {
    if (!isOpen) hideQr();
  }, [isOpen, hideQr]);

  useEffect(() => {
    if (!isQrShown || !fingerprint) return undefined;
    let isCancelled = false;
    void createStyledQrCode({ size: QR_SIZE }).then((qrCode) => {
      const container = qrRef.current;
      if (isCancelled || !container) return;
      qrCode.update({ data: fingerprint });
      container.replaceChildren();
      qrCode.append(container);
    }).catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [isQrShown, fingerprint]);

  const handleCopy = useLastCallback(() => {
    copyTextToClipboard(fingerprint);
    showNotification({ message: lang('ParvanePrivacyKeyCopied') });
  });

  return (
    <PvSheet
      isOpen={isOpen}
      title={lang('ParvaneSecurityKeyTitle')}
      startClose={isMobile ? 'back' : undefined}
      isPage
      onClose={onClose}
    >
      <div className={styles.fieldHint}>{lang('ParvaneSecurityKeyScreenHint')}</div>
      <div className={styles.keyCode} data-security-key-code>
        {rows.map((row) => <div key={row}>{row}</div>)}
      </div>
      <div className={styles.keyButtons}>
        <button type="button" className={kit.btn} data-security-key-copy onClick={handleCopy}>
          {lang('Copy')}
        </button>
        <button type="button" className={kit.btn} data-security-key-qr onClick={isQrShown ? hideQr : showQr}>
          {lang(isQrShown ? 'ParvaneSecurityKeyHideQr' : 'ParvaneSecurityKeyShowQr')}
        </button>
      </div>
      {isQrShown && <div ref={qrRef} className={styles.keyQr} data-security-key-qr-image />}
      <div className={styles.fieldHint}>{lang('ParvaneSecurityKeyChangedHint')}</div>
    </PvSheet>
  );
};

export default memo(SecurityKeySheet);
