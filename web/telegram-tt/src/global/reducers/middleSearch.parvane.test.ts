import {
  describe, expect, it, vi,
} from 'vitest';

import { mergeWithChatMediaSearchSegment } from './middleSearch';

// Редьюсер тянет селекторы и хелперы, которые при импорте читают браузерные
// API (matchMedia, CSS.supports); сам merge их не использует
vi.mock('../selectors', () => ({ selectTabState: vi.fn() }));
vi.mock('../selectors/middleSearch', () => ({ selectChatMediaSearch: vi.fn() }));
vi.mock('../helpers', () => ({ buildChatThreadKey: vi.fn(), isMediaLoadableInViewer: vi.fn() }));
vi.mock('./tabs', () => ({ updateTabState: vi.fn() }));

// id сообщений Parvane — метки времени в мс, больше 2^32: Object.keys отдаёт их
// в порядке вставки (провайдер — от новых к старым), а не по возрастанию
const OLDER = 1789502127000;
const NEWER = 1789502154000;
const LOADING = { areAllItemsLoadedForwards: false, areAllItemsLoadedBackwards: false };

describe('mergeWithChatMediaSearchSegment with Parvane message ids', () => {
  it('keeps object key order of large ids unsorted (the root of the viewer search loop)', () => {
    const byId = { [NEWER]: {}, [OLDER]: {} };
    expect(Object.keys(byId).map(Number)).toEqual([NEWER, OLDER]);
  });

  it('sorts found ids ascending when the first segment is created', () => {
    const segment = mergeWithChatMediaSearchSegment([NEWER, OLDER], LOADING);
    expect(segment.foundIds).toEqual([OLDER, NEWER]);
  });

  it('does not mutate the caller array', () => {
    const found = [NEWER, OLDER];
    mergeWithChatMediaSearchSegment(found, LOADING);
    expect(found).toEqual([NEWER, OLDER]);
  });

  it('merges into an existing segment in ascending order', () => {
    const segment = mergeWithChatMediaSearchSegment([OLDER], LOADING);
    const merged = mergeWithChatMediaSearchSegment([NEWER + 1000, NEWER], LOADING, segment);
    expect(merged.foundIds).toEqual([OLDER, NEWER, NEWER + 1000]);
  });
});
