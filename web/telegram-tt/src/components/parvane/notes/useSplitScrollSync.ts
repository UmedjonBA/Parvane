import { useEffect } from '../../../lib/teact/teact';

type Anchor = { line: number; top: number };

// Пересчёт позиций после правки текста — не на каждое нажатие
const REMEASURE_DELAY_MS = 150;

/**
 * Правка заметки (отзыв 6 ноя 2026): прокрутка редактора и живого просмотра синхронна по строкам исходного текста.
 * Позиции строк редактора — по скрытому зеркалу textarea (та же ширина и шрифт, переносы учтены), позиции
 * просмотра — по блокам с `data-md-line` (номер строки текста заметки). Между соседними опорами — по пропорции,
 * поэтому таблица или картинка, занимающая в просмотре больше места, чем в тексте, не сбивает соответствие.
 */
export default function useSplitScrollSync(
  editorRef: { current?: HTMLTextAreaElement },
  previewRef: { current?: HTMLElement },
  text: string | undefined,
  isEnabled: boolean,
) {
  useEffect(() => {
    const editor = editorRef.current;
    const preview = previewRef.current;
    if (!isEnabled || !editor || !preview) return undefined;

    let editorLines: number[] = [];
    let previewAnchors: Anchor[] = [];
    // Область, которую двигаем сами: её событие прокрутки не должно двигать первую в ответ
    const driven = new Set<HTMLElement>();

    const measure = () => {
      editorLines = measureEditorLines(editor);
      previewAnchors = measurePreview(preview);
    };

    const handleEditorScroll = () => {
      if (driven.delete(editor)) return;
      const line = lineAt(editorLines, editor.scrollTop);
      scrollTo(preview, previewTopOf(previewAnchors, line, editorLines.length, preview));
    };
    const handlePreviewScroll = () => {
      if (driven.delete(preview)) return;
      const line = lineAtPreview(previewAnchors, preview.scrollTop, editorLines.length, preview);
      scrollTo(editor, topOfLine(editorLines, line, editor));
    };
    function scrollTo(element: HTMLElement, top: number) {
      const max = element.scrollHeight - element.clientHeight;
      const next = Math.max(0, Math.min(max, top));
      if (Math.abs(element.scrollTop - next) < 1) return;
      driven.add(element);
      element.scrollTop = next;
    }

    const timer = window.setTimeout(measure, REMEASURE_DELAY_MS);
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    observer.observe(preview);
    editor.addEventListener('scroll', handleEditorScroll, { passive: true });
    preview.addEventListener('scroll', handlePreviewScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      editor.removeEventListener('scroll', handleEditorScroll);
      preview.removeEventListener('scroll', handlePreviewScroll);
    };
  }, [editorRef, previewRef, text, isEnabled]);
}

/** Верх каждой строки текста в textarea (без прокрутки): зеркало с теми же шириной, шрифтом и переносами */
function measureEditorLines(editor: HTMLTextAreaElement) {
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth', 'boxSizing'] as const) {
    mirror.style[name] = style[name];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-10000px';
  mirror.style.width = `${editor.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  const lines = editor.value.split('\n');
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line || '​';
    fragment.appendChild(row);
  }
  mirror.appendChild(fragment);
  document.body.appendChild(mirror);
  const tops = Array.from(mirror.children, (row) => (row as HTMLElement).offsetTop);
  tops.push(mirror.scrollHeight);
  mirror.remove();
  return tops;
}

/** Опоры просмотра: строка текста → верх блока внутри прокрутки (только возрастающие по обоим) */
function measurePreview(preview: HTMLElement) {
  const base = preview.getBoundingClientRect().top - preview.scrollTop;
  const anchors: Anchor[] = [];
  preview.querySelectorAll<HTMLElement>('[data-md-line]').forEach((element) => {
    anchors.push({ line: Number(element.dataset.mdLine), top: element.getBoundingClientRect().top - base });
  });
  anchors.sort((a, b) => a.line - b.line || a.top - b.top);
  const result: Anchor[] = [];
  for (const anchor of anchors) {
    const last = result[result.length - 1];
    if (!last || (anchor.line > last.line && anchor.top > last.top)) result.push(anchor);
  }
  return result;
}

/** Номер строки (дробный) по прокрутке редактора */
function lineAt(tops: number[], scrollTop: number) {
  if (tops.length < 2) return 0;
  let low = 0;
  let high = tops.length - 2;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tops[mid] <= scrollTop) low = mid;
    else high = mid - 1;
  }
  const span = tops[low + 1] - tops[low];
  return low + (span > 0 ? Math.min(1, (scrollTop - tops[low]) / span) : 0);
}

/** Прокрутка редактора, при которой строка `line` (дробная) вверху */
function topOfLine(tops: number[], line: number, editor: HTMLElement) {
  if (tops.length < 2) return 0;
  const index = Math.max(0, Math.min(tops.length - 2, Math.floor(line)));
  const top = tops[index] + (tops[index + 1] - tops[index]) * (line - index);
  // Конец просмотра — конец редактора (последние строки могут не дотянуться до верха)
  return line >= tops.length - 1 ? editor.scrollHeight : top;
}

/** Прокрутка просмотра для строки `line`: между соседними опорами — по пропорции */
function previewTopOf(anchors: Anchor[], line: number, lineCount: number, preview: HTMLElement) {
  const points = withEnds(anchors, lineCount, preview);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (line <= b.line) return a.top + ((line - a.line) / Math.max(b.line - a.line, 1e-6)) * (b.top - a.top);
  }
  return preview.scrollHeight;
}

/** Строка текста по прокрутке просмотра */
function lineAtPreview(anchors: Anchor[], scrollTop: number, lineCount: number, preview: HTMLElement) {
  const points = withEnds(anchors, lineCount, preview);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (scrollTop <= b.top) return a.line + ((scrollTop - a.top) / Math.max(b.top - a.top, 1e-6)) * (b.line - a.line);
  }
  return lineCount;
}

function withEnds(anchors: Anchor[], lineCount: number, preview: HTMLElement): Anchor[] {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  return [
    ...(first && first.line === 0 ? [] : [{ line: 0, top: 0 }]),
    ...anchors,
    ...(last && last.line >= lineCount ? [] : [{ line: lineCount, top: preview.scrollHeight }]),
  ];
}
