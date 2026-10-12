import { memo, useMemo } from '../../../lib/teact/teact';

import type { NotesIndex } from './notesModel';
import type { PlannedItem } from './notesPlanned';
import type { NoteEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { displayTitle, folderColor } from './notesLook';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './Knowledge.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  note: NoteEntry;
  index: NotesIndex;
  planned: PlannedItem[];
  className?: string;
  onOpenTitle: (title: string) => void;
};

type Point = {
  key: string;
  label: string;
  color: string;
  // Заметку можно открыть; запись «Плана» только показана
  title?: string;
  x: number;
  y: number;
};

const WIDTH = 320;
const HEIGHT = 240;
const RADIUS_X = 92;
const RADIUS_Y = 80;
const MAX_POINTS = 8;
const LABEL_MAX = 16;
const LABEL_BELOW = 18;
const LABEL_ABOVE = -10;

function shorten(text: string) {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

// «Связи» заметки: обратные ссылки и малый граф — заметка в центре, вокруг заметки, на которые она
// ссылается, заметки, ссылающиеся на неё, и записи «Плана» со ссылкой сюда
const NoteLinks = ({
  note, index, planned, className, onOpenTitle,
}: OwnProps) => {
  const lang = useLang();

  const backlinks = useMemo(() => index.backlinks(note.id), [index, note.id]);

  const points = useMemo(() => {
    const indexed = index.byId(note.id);
    const seen = new Set<string>([note.id]);
    const found: Omit<Point, 'x' | 'y'>[] = [];
    const addNote = (other?: NoteEntry | { id: string; title: string; folder: string; isDaily?: boolean }) => {
      if (!other || seen.has(other.id)) return;
      seen.add(other.id);
      found.push({
        key: other.id,
        label: displayTitle(lang, { title: other.title, isDaily: Boolean(other.isDaily) }),
        color: folderColor(other.folder, other.isDaily),
        title: other.title,
      });
    };
    (indexed?.linkedIds || []).forEach((id) => addNote(index.byId(id)));
    backlinks.forEach((other) => addNote(other));
    planned.forEach((item) => {
      if (seen.has(item.key)) return;
      seen.add(item.key);
      found.push({
        key: item.key,
        label: item.name,
        color: item.kind === 'task' ? 'var(--pv-task)' : 'var(--pv-event)',
      });
    });
    const shown = found.slice(0, MAX_POINTS);
    return shown.map((point, i): Point => {
      const angle = -Math.PI / 2 + (i / shown.length) * Math.PI * 2;
      return {
        ...point,
        x: WIDTH / 2 + Math.cos(angle) * RADIUS_X,
        y: HEIGHT / 2 + Math.sin(angle) * RADIUS_Y,
      };
    });
  }, [index, note.id, backlinks, planned, lang]);

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLElement | SVGElement>) => {
    const title = (e.currentTarget as HTMLElement).dataset.title;
    if (title) onOpenTitle(title);
  });

  return (
    <div className={buildClassName(styles.links, className)}>
      <section data-note-backlinks>
        <h3 className={buildClassName(kit.caps, styles.linksCaption)}>
          {lang('KnowledgeBacklinks', { count: backlinks.length })}
        </h3>
        {!backlinks.length && <p className={styles.mutedLine}>{lang('KnowledgeBacklinksEmpty')}</p>}
        {backlinks.map((other) => (
          <button
            key={other.id}
            type="button"
            className={kit.row}
            data-title={other.title}
            onClick={handleOpen}
          >
            <span className={buildClassName(kit.ava, kit.avaS)} style={`--c: ${folderColor(other.folder)}`}>
              <PvIcon name="note" isSmall />
            </span>
            <span className={buildClassName(kit.rowText, kit.ttl)}>{other.title}</span>
          </button>
        ))}
      </section>
      <section data-note-graph>
        <h3 className={buildClassName(kit.caps, styles.linksCaption)}>{lang('KnowledgeGraph')}</h3>
        <svg
          className={styles.miniGraph}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={lang('KnowledgeLocalGraph')}
        >
          {points.map((point) => (
            <line key={`l${point.key}`} x1={WIDTH / 2} y1={HEIGHT / 2} x2={point.x} y2={point.y} />
          ))}
          <circle className={styles.miniCenter} cx={WIDTH / 2} cy={HEIGHT / 2} r={9} />
          {points.map((point) => (
            <g
              key={point.key}
              className={point.title ? styles.miniNode : undefined}
              style={`--c: ${point.color}`}
              data-title={point.title}
              onClick={point.title ? handleOpen : undefined}
            >
              <circle cx={point.x} cy={point.y} r={6} />
              <text x={point.x} y={point.y + (point.y > HEIGHT / 2 ? LABEL_BELOW : LABEL_ABOVE)}>
                {shorten(point.label)}
              </text>
            </g>
          ))}
        </svg>
      </section>
    </div>
  );
};

export default memo(NoteLinks);
