import { memo, useMemo } from '../../../lib/teact/teact';

import { openNote } from '../../../util/parvaneSection';
import { splitNameLinks } from './plannerLinks';

import useLastCallback from '../../../hooks/useLastCallback';

import styles from './Planner.module.scss';

type OwnProps = {
  name: string;
};

// Название записи: `[[Заметка]]` и `[[Заметка|подпись]]` — ссылки, открывающие заметку в «Знаниях».
// Название стоит внутри кнопок рядов и блоков, поэтому ссылка — не кнопка и не отдаёт нажатие ряду
const PlannerName = ({ name }: OwnProps) => {
  const parts = useMemo(() => splitNameLinks(name), [name]);

  const handleClick = useLastCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    e.preventDefault();
    openNote(e.currentTarget.dataset.noteLink!);
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.stopPropagation();
    e.preventDefault();
    openNote(e.currentTarget.dataset.noteLink!);
  });

  return (
    <>
      {parts.map((part) => (part.note === undefined ? part.text : (
        <span
          className={styles.nameLink}
          role="link"
          tabIndex={0}
          data-note-link={part.note}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          {part.text}
        </span>
      )))}
    </>
  );
};

export default memo(PlannerName);
