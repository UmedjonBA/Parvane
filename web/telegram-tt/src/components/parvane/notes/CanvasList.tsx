import { memo, useMemo, useState } from '../../../lib/teact/teact';

import type { CanvasSummary } from './notesCanvasList';
import type { CanvasEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import { summarizeCanvas } from './notesCanvasList';
import { colorStyle } from './notesCanvasLook';
import { formatNoteTime } from './notesList';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './CanvasParts.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  canvases: CanvasEntry[];
  isNarrow: boolean;
  hasNotes: boolean;
  onOpen: (canvasId: string) => void;
  onNew: NoneToVoidFunction;
  onFromGraph: NoneToVoidFunction;
};

// Сводка холста считается один раз на его текст: перерисовка списка файлы заново не разбирает
const summaries = new WeakMap<CanvasEntry, CanvasSummary>();

function summaryOf(entry: CanvasEntry) {
  let summary = summaries.get(entry);
  if (!summary) {
    summary = summarizeCanvas(entry.text);
    summaries.set(entry, summary);
  }
  return summary;
}

// Список холстов: на телефоне плитки с миниатюрой и «Новый холст» последней плиткой (доска `RpNotes`), на
// компьютере — строки «название · карточки и стрелки · дата · Открыть» (доска `ZdNotesX`)
const CanvasList = ({
  canvases, isNarrow, hasNotes, onOpen, onNew, onFromGraph,
}: OwnProps) => {
  const lang = useLang();
  const [now] = useState(() => Date.now());

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    onOpen(e.currentTarget.dataset.canvasId!);
  });

  const items = useMemo(() => canvases.map((entry) => ({ entry, summary: summaryOf(entry) })), [canvases]);

  function renderCounts(summary: CanvasSummary) {
    const cards = lang('KnowledgeCanvasCards', { count: summary.cards }, { pluralValue: summary.cards });
    if (!summary.arrows) return cards;
    return `${cards} · ${lang('KnowledgeCanvasArrows', { count: summary.arrows }, { pluralValue: summary.arrows })}`;
  }

  function renderTile({ entry, summary }: { entry: CanvasEntry; summary: CanvasSummary }) {
    return (
      <button
        key={entry.id}
        type="button"
        className={styles.tile}
        data-canvas-id={entry.id}
        data-canvas-tile={entry.title}
        onClick={handleOpen}
      >
        <span className={styles.tilePreview} aria-hidden>
          {summary.preview.map((card, i) => (
            <span
              // Миниатюра без своих id: порядок карточек в ней постоянен для одного текста
              key={`${entry.id}-${i}`}
              className={buildClassName(styles.tileCard, i === 0 && styles.tileCardLead)}
              style={`${colorStyle(card.color)}left: ${card.x * 100}%; top: ${card.y * 100}%; width: ${
                card.width * 100}%; height: ${card.height * 100}%`}
            />
          ))}
        </span>
        <span className={styles.tileText}>
          <span className={kit.ttl}>{entry.title}</span>
          <span className={kit.sub}>{`${renderCounts(summary)} · ${formatNoteTime(lang, entry.updatedAt, now)}`}</span>
        </span>
      </button>
    );
  }

  function renderRow({ entry, summary }: { entry: CanvasEntry; summary: CanvasSummary }) {
    return (
      <div key={entry.id} className={styles.row} data-canvas-tile={entry.title}>
        <PvIcon name="board" isSmall />
        <button type="button" className={styles.rowName} data-canvas-id={entry.id} onClick={handleOpen}>
          {entry.title}
        </button>
        <span className={buildClassName(kit.sub, styles.rowCounts)}>{renderCounts(summary)}</span>
        <span className={kit.sub}>{formatNoteTime(lang, entry.updatedAt, now)}</span>
        <button type="button" className={kit.chip} data-canvas-id={entry.id} onClick={handleOpen}>
          {lang('KnowledgeCanvasOpen')}
        </button>
      </div>
    );
  }

  const fromGraph = hasNotes && (
    <>
      <button
        type="button"
        className={buildClassName(kit.btn, styles.fromGraph)}
        data-canvas-from-graph
        onClick={onFromGraph}
      >
        <PvIcon name="graph" isSmall />
        {lang('KnowledgeCanvasFromGraph')}
      </button>
      <p className={buildClassName(kit.sub, styles.hint)}>{lang('KnowledgeCanvasFromGraphHint')}</p>
    </>
  );

  if (isNarrow) {
    return (
      <div className={styles.list} data-canvas-list data-notes-canvas={canvases.length ? 'list' : 'empty'}>
        <div className={styles.tiles}>
          {items.map(renderTile)}
          <button type="button" className={styles.tileNew} data-canvas-new onClick={onNew}>
            <PvIcon name="plus" />
            {lang('KnowledgeCanvasNew')}
          </button>
        </div>
        {fromGraph}
      </div>
    );
  }

  return (
    <div className={styles.list} data-canvas-list data-notes-canvas={canvases.length ? 'list' : 'empty'}>
      <div className={styles.listHead}>
        <div className={kit.grow}>
          <h2 className={styles.listTitle}>{lang('KnowledgeCanvasListTitle')}</h2>
          <p className={kit.sub}>{lang('KnowledgeCanvasListSubtitle')}</p>
        </div>
        <button type="button" className={buildClassName(kit.btn, kit.btnAcc)} data-canvas-new onClick={onNew}>
          {lang('KnowledgeCanvasNew')}
        </button>
      </div>
      {items.length ? (
        <div className={buildClassName(kit.card, styles.rows)}>{items.map(renderRow)}</div>
      ) : (
        <p className={buildClassName(kit.sub, styles.hint)}>
          {lang(hasNotes ? 'KnowledgeCanvasEmptyGraph' : 'KnowledgeCanvasEmpty')}
        </p>
      )}
      <p className={buildClassName(kit.sub, styles.hint)}>{lang('KnowledgeCanvasListHint')}</p>
      {fromGraph}
    </div>
  );
};

export default memo(CanvasList);
