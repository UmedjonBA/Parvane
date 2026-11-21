import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  beforeAll, describe, expect, it,
} from 'vitest';

import { engineStatic, loadProtocol } from '../../../api/parvane/v2/engine';
import { groupByLetter, groupOffline, mergePage } from './musicLibrary';

type Case = { title: string; call: string; args: unknown; expect: unknown };

const CASES = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/music-library/cases.json'), 'utf8'),
) as Case[];

describe('Списки библиотеки «Музыки» (MUSIC-4)', () => {
  beforeAll(async () => {
    await loadProtocol();
  });

  it('движок web отвечает по общему образцу', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
    CASES.forEach((item) => {
      expect(engineStatic(item.call, item.args), item.title).toEqual(item.expect);
    });
  });

  it('обёртки экранов передают вход как есть', () => {
    expect(groupByLetter([{ id: 'a1', name: 'lampa' }])).toEqual([{ letter: 'L', ids: ['a1'] }]);
    expect(mergePage([{ id: 't1' }], [{ id: 't1' }, { id: 't2' }])).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(groupOffline([{ id: 't1', bytes: 10 }], { playlists: {}, albums: {} }, [])).toEqual([
      {
        kind: 'tracks', id: '', trackIds: ['t1'], bytes: 10,
      },
    ]);
  });
});
