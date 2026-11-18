import { useEffect, useMemo, useState } from '../../../lib/teact/teact';

import type { NotesGraphInput, NotesGraphLayout } from './notesGraphEngine';

import { isProtocolLoaded, loadProtocol } from '../../../api/parvane/v2/engine';
import { layoutNotesGraph } from './notesGraphEngine';
import { NOTES_GRAPH_SYNC_NODES } from './notesGraphView';

type Deferred = { input: NotesGraphInput; layout: NotesGraphLayout };

// Раскладка графа от движка (NOTES-1). Вызов движка синхронный (~0,8 с на 1000 узлах): небольшой граф
// считается в том же кадре, большой — после кадра, в котором экран уже показал «Считаем раскладку…»
// (прежняя раскладка остаётся на поле). `isBusy` — раскладка для нынешнего входа ещё не готова
export default function useNotesGraphLayout(input: NotesGraphInput) {
  const size = input.notes.length + (input.withRecords ? input.records?.length || 0 : 0);
  const isSync = size <= NOTES_GRAPH_SYNC_NODES && isProtocolLoaded();
  const direct = useMemo(() => (isSync ? layoutNotesGraph(input) : undefined), [isSync, input]);
  const [deferred, setDeferred] = useState<Deferred>();

  useEffect(() => {
    if (isSync) return undefined;
    let isCancelled = false;
    let frame = 0;
    let timer = 0;
    void loadProtocol().then(() => {
      if (isCancelled) return;
      // Кадр — чтобы подпись успела нарисоваться, задача после него — сам расчёт
      frame = requestAnimationFrame(() => {
        timer = window.setTimeout(() => {
          if (!isCancelled) setDeferred({ input, layout: layoutNotesGraph(input) });
        }, 0);
      });
    });
    return () => {
      isCancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [isSync, input]);

  const layout = direct || deferred?.layout;
  const isBusy = !direct && deferred?.input !== input;
  return { layout, isBusy };
}
