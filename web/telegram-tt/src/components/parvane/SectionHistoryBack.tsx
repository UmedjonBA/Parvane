import { memo, useEffect, useState } from '../../lib/teact/teact';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLastCallback from '../../hooks/useLastCallback';

type OwnProps = {
  // Возвращает `true`, если шаг остался внутри раздела (тогда запись ставится заново)
  onBack: () => boolean;
};

// Parvane: системное «назад» (жест Android) внутри раздела — шаг вверх по разделу, а не выход из приложения.
// Раздел держит в истории браузера одну запись; `onBack` поднимается на уровень (папка → родительская,
// заметка → список, корень раздела → чаты); если раздел остался на экране, запись ставится заново.
// Стопка записей по уровням не годится: переходы между вкладками раздела закрывают одни записи и открывают
// другие в одном кадре, и одно «назад» снимало сразу две. Заново запись ставится следующей отрисовкой: новая
// запись, поставленная в том же кадре, что и снятие прежней, занимала её место и тут же закрывалась
const SectionHistoryBack = ({ onBack }: OwnProps) => {
  const [isArmed, setIsArmed] = useState(true);

  const handleBack = useLastCallback(() => {
    if (onBack()) setIsArmed(false);
  });

  useEffect(() => {
    if (!isArmed) setIsArmed(true);
  }, [isArmed]);

  useHistoryBack({ isActive: isArmed, onBack: handleBack });

  return undefined;
};

export default memo(SectionHistoryBack);
