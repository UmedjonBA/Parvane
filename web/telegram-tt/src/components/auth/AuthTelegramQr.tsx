import { memo, useEffect, useRef } from '../../lib/teact/teact';

import { createStyledQrCode } from '../../util/qrCode/buildStyledQrCode';

import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';

import styles from './Auth.module.scss';

type OwnProps = {
  link: string;
};

const QR_SIZE = 200;

// «Показать QR» экрана Telegram (доска `ZpAuthX`): та же ссылка на бота, что и «Открыть», — для Telegram на другом
// устройстве (телефоне). Картинку рисует общий построитель QR (`util/qrCode`), как у окна QR мессенджера
const AuthTelegramQr = ({ link }: OwnProps) => {
  const lang = useLang();
  const containerRef = useRef<HTMLDivElement>();
  const [isShown, show, hide] = useFlag();

  useEffect(() => {
    if (!isShown) return undefined;
    let isCancelled = false;
    void createStyledQrCode({ size: QR_SIZE }).then((qrCode) => {
      const container = containerRef.current;
      if (isCancelled || !container) return;
      qrCode.update({ data: link });
      container.replaceChildren();
      qrCode.append(container);
    }).catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [isShown, link]);

  return (
    <div className={styles.qr}>
      <button
        type="button"
        className={styles.linkInline}
        aria-expanded={isShown}
        data-telegram-qr
        onClick={isShown ? hide : show}
      >
        {lang(isShown ? 'ParvaneAuthTelegramQrHide' : 'ParvaneAuthTelegramQrShow')}
      </button>
      {isShown && <div ref={containerRef} className={styles.qrImage} aria-label={lang('ParvaneAuthTelegramQrHint')} />}
    </div>
  );
};

export default memo(AuthTelegramQr);
