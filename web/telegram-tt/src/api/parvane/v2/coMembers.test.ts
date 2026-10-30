import { describe, expect, it } from 'vitest';

import { coMembersOf } from './coMembers';

const closed = { members: [{ user: 'me@x' }, { user: 'ann@x' }] };
const open = { publicName: 'town', members: [{ user: 'me@x' }, { user: 'bob@x' }] };
const foreign = { members: [{ user: 'cat@x' }, { user: 'dan@x' }] };

describe('участники общих групп', () => {
  it('для звонка — все участники своих групп', () => {
    expect([...coMembersOf([closed, open, foreign, undefined], 'me@x')].sort()).toEqual(['ann@x', 'bob@x']);
  });

  it('встречный ключ не отдаётся участникам публичных групп', () => {
    expect([...coMembersOf([closed, open], 'me@x', true)]).toEqual(['ann@x']);
  });

  it('удалённая группа не считается', () => {
    expect(coMembersOf([{ ...closed, deleted: true }], 'me@x').size).toBe(0);
  });
});
