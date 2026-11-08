import { describe, expect, it } from 'vitest';

import {
  contactNameOverride, contactsFromState, contactsToState, mergeContactsLocalWins, withContactName, withContactNote,
} from './contactInfo';
import { ParvaneStore } from './store';

describe('contact name and note (CONTACT-1)', () => {
  it('a form prefilled with the peer’s own name does not pin it', () => {
    expect(contactNameOverride('Mira Stone', 'Mira Stone', '')).toBeUndefined();
    expect(contactNameOverride('Mira Stone', '  ', undefined)).toBeUndefined();
    expect(contactNameOverride('Mira Stone', 'Mira', 'Stone')).toEqual({ firstName: 'Mira', lastName: 'Stone' });
    expect(contactNameOverride('Mira Stone', 'Neighbour', '')).toEqual({ firstName: 'Neighbour', lastName: undefined });
  });

  it('own contact name replaces the public one in buildApiUser and titles, not in the wire name', () => {
    const store = new ParvaneStore();
    store.self = 'me@local';
    store.setDisplayName('mira@local', 'Mira Stone');
    store.addContact('mira@local');
    store.setContactName('mira@local', { firstName: 'Neighbour', lastName: 'Mira' });
    const user = store.buildApiUser('mira@local');
    expect(user.firstName).toBe('Neighbour');
    expect(user.lastName).toBe('Mira');
    expect(store.buildApiChatForUser('mira@local').title).toBe('Neighbour Mira');
    expect(store.getPublicDisplayName('mira@local')).toBe('Mira Stone');
    // Не контакт — своё имя не действует
    store.removeContact('mira@local');
    expect(store.buildApiUser('mira@local').firstName).toBe('Mira Stone');
    expect(store.buildApiUser('mira@local').lastName).toBeUndefined();
  });

  it('journal entries round-trip names and notes; empty info is dropped', () => {
    const info = {
      'mira@local': withContactNote(withContactName(undefined, { firstName: 'Neighbour' }), ' plays cello ')!,
    };
    const state = contactsToState(['mira@local', 'otto@local', 'mira@local'], info);
    expect(state).toEqual([
      { user: { address: 'mira@local' }, first_name: 'Neighbour', last_name: undefined, note: 'plays cello' },
      { user: { address: 'otto@local' }, first_name: undefined, last_name: undefined, note: undefined },
    ]);
    const back = contactsFromState(state);
    expect(back.addresses).toEqual(['mira@local', 'otto@local']);
    expect(back.info).toEqual({ 'mira@local': { firstName: 'Neighbour', note: 'plays cello' } });
    expect(withContactNote({ note: 'x' }, '')).toBeUndefined();
  });

  it('offline edits are merged over the journal without removing contacts from other devices', () => {
    const merged = mergeContactsLocalWins(
      [{ user: { address: 'a@x' }, first_name: 'Old' }, { user: { address: 'b@x' } }],
      [{ user: { address: 'a@x' }, first_name: 'New' }, { user: { address: 'c@x' } }],
    );
    expect(merged.map((c) => [c.user?.address, c.first_name])).toEqual([
      ['a@x', 'New'], ['b@x', undefined], ['c@x', undefined],
    ]);
  });
});
