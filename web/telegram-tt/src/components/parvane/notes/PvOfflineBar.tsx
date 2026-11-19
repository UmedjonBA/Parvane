import { memo, useEffect } from '../../../lib/teact/teact';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useBrowserOnline from '../../../hooks/window/useBrowserOnline';

import styles from './PvOfflineBar.module.scss';

type OwnProps = {
  // Что показано вместо свежего: «показан план, сохранённый на устройстве»
  text: string;
  onRetry: NoneToVoidFunction;
};

// При запуске с сетью сохранённое показывается секунду-другую до ответа сервера — полоса в это время не мигает
const SHOW_DELAY_MS = 1500;

// Parvane (spec 041 E6, доска `PhStates`): полоса «нет связи» под шапкой модуля — точка, что показано, «Повторить».
// Когда её показывать, решает модуль (свой статус синхронизации либо показ сохранённого на устройстве)
const PvOfflineBar = ({ text, onRetry }: OwnProps) => {
  const lang = useLang();
  const isOnline = useBrowserOnline();
  const [isDue, markDue] = useFlag();

  useEffect(() => {
    const timer = window.setTimeout(markDue, SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [markDue]);

  if (!isDue && isOnline) return undefined;

  return (
    <div className={styles.root} role="status" data-offline-bar>
      <span className={styles.dot} />
      <span className={styles.text}>{text}</span>
      <button type="button" className={styles.retry} onClick={onRetry}>{lang('PvOfflineRetry')}</button>
    </div>
  );
};

export default memo(PvOfflineBar);
