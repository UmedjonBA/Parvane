// Parvane, «Заметки»: вызов раскладки графа во втором потоке (`notesGraph.worker.ts`). Нет поддержки воркеров
// (тесты) либо воркер не поднялся — `undefined`, и граф считается в главном потоке, как раньше

import type { Connector } from '../../../util/PostMessageConnector';
import type { NotesGraphWorkerApi } from './notesGraph.worker';
import type { NotesGraphInput, NotesGraphLayout } from './notesGraphEngine';

import { createConnector } from '../../../util/PostMessageConnector';
import { graphLayoutArgs } from './notesGraphEngine';

let connector: Connector<NotesGraphWorkerApi> | undefined;
let isBroken = false;

export async function layoutNotesGraphInWorker(input: NotesGraphInput): Promise<NotesGraphLayout | undefined> {
  if (isBroken || typeof Worker === 'undefined') return undefined;
  try {
    connector ??= createConnector<NotesGraphWorkerApi>(
      new Worker(new URL('./notesGraph.worker.ts', import.meta.url), { type: 'module' }),
    );
    const result = await connector.request({ name: 'layoutGraph', args: [JSON.stringify(graphLayoutArgs(input))] });
    return typeof result === 'string' ? JSON.parse(result) as NotesGraphLayout : undefined;
  } catch (err) {
    isBroken = true;
    return undefined;
  }
}
