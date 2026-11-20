import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadProtocol } from '../../../api/parvane/v2/engine';
import { getCallSasWords } from './callSas';

type Case = { name: string; local: string; remote: string; words?: string[] };

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../conformance/call-sas/cases.json'), 'utf8'),
) as { cases: Case[] };

describe('Сверка ключей звонка словами (CALL-3)', () => {
  it('движок web отвечает по общему образцу', async () => {
    await loadProtocol();
    expect(SAMPLE.cases.length).toBeGreaterThanOrEqual(6);
    SAMPLE.cases.forEach((sample) => {
      expect(getCallSasWords([sample.local, sample.remote]), sample.name)
        .toEqual(sample.words || undefined);
    });
  });

  it('порядок сторон не важен: у собеседника те же слова', async () => {
    await loadProtocol();
    const [sample] = SAMPLE.cases;
    expect(getCallSasWords([sample.remote, sample.local])).toEqual(sample.words);
  });
});
