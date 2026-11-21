import { describe, expect, it } from 'vitest';

import { splitRecoveryKey } from './recoveryKeyPrint';

describe('splitRecoveryKey', () => {
  it('splits groups into two lines', () => {
    expect(splitRecoveryKey('K7QF-2M9D-XT4H-PW3N')).toEqual(['K7QF-2M9D', 'XT4H-PW3N']);
    expect(splitRecoveryKey('AAAA-BBBB-CCCC')).toEqual(['AAAA-BBBB', 'CCCC']);
  });

  it('keeps a key without groups whole', () => {
    expect(splitRecoveryKey(' ABCD ')).toEqual(['ABCD']);
  });
});
