import {
  memo, useLayoutEffect, useMemo, useState,
} from '../../../lib/teact/teact';

import type { LangFn } from '../../../util/localization';
import type { CanvasSummary } from './notesCanvasList';
import type { CanvasEntry } from './notesStore';

import buildClassName from '../../../util/buildClassName';
import captureEscKeyListener from '../../../util/captureEscKeyListener';
import { getIsParvaneScreenShown } from '../../../util/parvaneSection';
import { isCanvasFound, summarizeCanvas } from './notesCanvasList';
import { colorStyle } from './notesCanvasLook';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvIcon from './PvIcon';

import styles from './CanvasParts.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  canvases: CanvasEntry[];
  isNarrow: boolean;
  hasNotes: boolean;
  // Поиск по холстам из шапки раздела: по названию холста и по его карточкам
  query: string;
  onOpen: (canvasId: string) => void;
  // «···» у строки на компьютере: переименовать и в корзину — теми же окнами, что меню открытого холста
  onRename: (canvasId: string) => void;
  onDelete: (canvasId: string) => void;
  onNew: NoneToVoidFunction;
  onFromGraph: NoneToVoidFunction;
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
  canvases, isNarrow, hasNotes, query, onOpen, onRename, onDelete, onNew, onFromGraph,
}: OwnProps) => {
  const lang = useLang();
  const [now] = useState(() => Date.now());
  const [menuId, setMenuId] = useState<string>();
  const [isMenuOpen, openMenu, closeMenu] = useFlag();

  const handleOpen = useLastCallback((e: React.MouseEvent<HTMLElement>) => {
    onOpen(e.currentTarget.dataset.canvasId!);
  });

  const handleMore = useLastCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const id = e.currentTarget.dataset.canvasId!;
    if (isMenuOpen && menuId === id) {
      closeMenu();
      return;
    }
    setMenuId(id);
    openMenu();
  });

  // Меню строки закрывается нажатием мимо него и Escape (общая очередь слушателей; скрытый раздел клавишу не берёт)
  useLayoutEffect(() => {
    if (!isMenuOpen) return undefined;
    const handleDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('[data-canvas-row-menu], [data-canvas-row-more]')) closeMenu();
    };
    document.addEventListener('pointerdown', handleDown);
    const releaseEsc = captureEscKeyListener(() => {
      if (!getIsParvaneScreenShown('notes')) return false;
      closeMenu();
      return undefined;
    });
    return () => {
      document.removeEventListener('pointerdown', handleDown);
      releaseEsc();
    };
  }, [isMenuOpen, closeMenu]);

  const handleRename = useLastCallback(() => {
    closeMenu();
    if (menuId) onRename(menuId);
  });

  const handleDelete = useLastCallback(() => {
    closeMenu();
    if (menuId) onDelete(menuId);
  });

  const allItems = useMemo(() => canvases.map((entry) => ({ entry, summary: summaryOf(entry) })), [canvases]);
  const items = useMemo(() => (
    query.trim() ? allItems.filter(({ entry, summary }) => isCanvasFound(entry.title, summary, query)) : allItems
  ), [allItems, query]);
  const isFiltered = Boolean(query.trim());

  function renderCounts(summary: CanvasSummary, withArrows?: boolean) {
    const cards = lang('KnowledgeCanvasCards', { count: summary.cards }, { pluralValue: summary.cards });
    if (!withArrows || !summary.arrows) return cards;
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
          <span className={kit.sub}>{`${renderCounts(summary)} · ${formatCanvasDay(lang, entry.updatedAt, now)}`}</span>
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
        <span className={buildClassName(kit.sub, styles.rowCounts)}>{renderCounts(summary, true)}</span>
        <span className={kit.sub}>{formatCanvasDay(lang, entry.updatedAt, now)}</span>
        <button type="button" className={kit.chip} data-canvas-id={entry.id} onClick={handleOpen}>
          {lang('KnowledgeCanvasOpen')}
        </button>
        <span className={styles.rowMore}>
          <button
            type="button"
            className={kit.ib}
            aria-label={lang('KnowledgeCanvasActions')}
            title={lang('KnowledgeCanvasActions')}
            aria-expanded={isMenuOpen && menuId === entry.id}
            data-canvas-id={entry.id}
            data-canvas-row-more
            onClick={handleMore}
          >
            <PvIcon name="dots" isSmall />
          </button>
          {isMenuOpen && menuId === entry.id && (
            <div className={styles.rowMenu} role="menu" data-canvas-row-menu>
              <button
                type="button"
                role="menuitem"
                className={styles.rowMenuItem}
                data-canvas-row-rename
                onClick={handleRename}
              >
                <PvIcon name="edit" isSmall />
                {lang('KnowledgeCanvasRename')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={buildClassName(styles.rowMenuItem, styles.rowMenuDanger)}
                data-canvas-row-delete
                onClick={handleDelete}
              >
                <PvIcon name="trash" isSmall />
                {lang('KnowledgeDelete')}
              </button>
            </div>
          )}
        </span>
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

  // Подсказка под списком: холстов нет вовсе либо поиск ничего не нашёл
  const emptyHint = !canvases.length ? (
    <p className={buildClassName(kit.sub, styles.hint)} data-canvas-empty-hint>
      {lang(hasNotes ? 'KnowledgeCanvasEmptyGraph' : 'KnowledgeCanvasEmpty')}
    </p>
  ) : isFiltered && !items.length ? (
    <p className={buildClassName(kit.sub, styles.hint)} data-canvas-nothing-found>
      {lang('KnowledgeCanvasNothingFound')}
    </p>
  ) : undefined;

  if (isNarrow) {
    return (
      <div className={styles.list} data-canvas-list data-notes-canvas={canvases.length ? 'list' : 'empty'}>
        <div className={styles.tiles}>
          {items.map(renderTile)}
          {!isFiltered && (
            <button type="button" className={styles.tileNew} data-canvas-new onClick={onNew}>
              <PvIcon name="plus" />
              {lang('KnowledgeCanvasNew')}
            </button>
          )}
        </div>
        {emptyHint}
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
      {items.length > 0 && <div className={buildClassName(kit.card, styles.rows)}>{items.map(renderRow)}</div>}
      {emptyHint}
      <p className={buildClassName(kit.sub, styles.hint)}>{lang('KnowledgeCanvasListHint')}</p>
      {fromGraph}
    </div>
  );
};

export default memo(CanvasList);

// Дата правки холста днём: «сегодня», «вчера», «10 ноября» (доски `RpNotes`, `ZdNotesX`)
function formatCanvasDay(lang: LangFn, updatedAt: number, now: number) {
  const date = new Date(updatedAt);
  const today = new Date(now);
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const daysAgo = Math.round((startOf(today) - startOf(date)) / DAY_MS);
  if (daysAgo <= 0) return lang('Today');
  if (daysAgo === 1) return lang('WeekdayYesterday').toLowerCase();
  const isSameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(lang.code, isSameYear
    ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}
