import { memo, useEffect, useRef } from '../../lib/teact/teact';

import { createStyledQrCode } from '../../util/qrCode/buildStyledQrCode';

import useLang from '../../hooks/useLang';

import styles from './Auth.module.scss';

type OwnProps = {
  link: string;
};

const QR_SIZE = 200;

// QR экрана Telegram (доска `ZdAuthX`): та же ссылка на бота, что и «Открыть», — для Telegram на другом устройстве
// (телефоне). Показ переключает сам экран (чип «Показать QR» в строке шага 1 на компьютере, ссылка на телефоне);
// картинку рисует общий построитель QR (`util/qrCode`), как у окна QR мессенджера
const AuthTelegramQr = ({ link }: OwnProps) => {
  const lang = useLang();
  const containerRef = useRef<HTMLDivElement>();

  useEffect(() => {
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
  }, [link]);

  return (
    <div className={styles.qr}>
      <div
        ref={containerRef}
        className={styles.qrImage}
        data-telegram-qr-image
        aria-label={lang('ParvaneAuthTelegramQrHint')}
      />
    </div>
  );
};

export default memo(AuthTelegramQr);
