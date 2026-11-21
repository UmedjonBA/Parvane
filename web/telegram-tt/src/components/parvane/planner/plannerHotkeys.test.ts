import { describe, expect, it } from 'vitest';

import { matchPlannerHotkey } from './plannerHotkeys';

function press(code: string, extra: Partial<KeyboardEvent> = {}) {
  return {
    code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra,
  };
}

describe('plannerHotkeys', () => {
  it('буквы в любой раскладке, стрелки и пробел', () => {
    expect(matchPlannerHotkey(press('KeyN'), false)).toBe('new');
    expect(matchPlannerHotkey(press('KeyT'), false)).toBe('today');
    expect(matchPlannerHotkey(press('ArrowLeft'), false)).toBe('prev');
    expect(matchPlannerHotkey(press('ArrowRight'), false)).toBe('next');
    expect(matchPlannerHotkey(press('Space'), false)).toBe('done');
  });

  it('в поле ввода и с модификатором — не наше', () => {
    expect(matchPlannerHotkey(press('KeyN'), true)).toBeUndefined();
    expect(matchPlannerHotkey(press('KeyN', { ctrlKey: true }), false)).toBeUndefined();
    expect(matchPlannerHotkey(press('KeyT', { shiftKey: true }), false)).toBeUndefined();
    expect(matchPlannerHotkey(press('KeyQ'), false)).toBeUndefined();
  });
});
