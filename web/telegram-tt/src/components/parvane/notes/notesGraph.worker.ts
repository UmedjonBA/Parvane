// Parvane, «Заметки»: раскладка большого графа во втором потоке (spec 040 T10). Свой экземпляр движка (WASM) —
// главный поток не замирает на ~1 с расчёта; вход и выход — тот же JSON, что у `layoutNotesGraph`

import init, { staticCall } from '../../../lib/parvane-protocol/parvane_protocol';
import wasmUrl from '../../../lib/parvane-protocol/parvane_protocol_bg.wasm?url';
import { createWorkerInterface } from '../../../util/createPostMessageInterface';

let loading: Promise<unknown> | undefined;

async function layoutGraph(argsJson: string) {
  loading ??= init({ module_or_path: wasmUrl });
  await loading;
  return staticCall('notesGraphLayout', argsJson);
}

const api = { layoutGraph };

createWorkerInterface(api);

export type NotesGraphWorkerApi = typeof api;
