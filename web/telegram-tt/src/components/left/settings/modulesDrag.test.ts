import { describe, expect, it } from 'vitest';

import { findDropIndex, findKeyMoveIndex } from './modulesDrag';

describe('findDropIndex', () => {
  const middles = [28, 84, 140, 196];

  it('ставит строку выше первой, пока указатель над её серединой', () => {
    expect(findDropIndex(middles, 0)).toBe(0);
    expect(findDropIndex(middles, 28)).toBe(0);
  });

  it('считает строки, чья середина выше указателя', () => {
    expect(findDropIndex(middles, 29)).toBe(1);
    expect(findDropIndex(middles, 150)).toBe(3);
  });

  it('ниже последней строки — в конец', () => {
    expect(findDropIndex(middles, 500)).toBe(4);
    expect(findDropIndex([], 10)).toBe(0);
  });
});

describe('findKeyMoveIndex', () => {
  it('стрелки двигают на одну строку', () => {
    expect(findKeyMoveIndex(2, 'ArrowUp', 7)).toBe(1);
    expect(findKeyMoveIndex(2, 'ArrowDown', 7)).toBe(3);
  });

  it('у краёв и для других клавиш — на месте', () => {
    expect(findKeyMoveIndex(0, 'ArrowUp', 7)).toBeUndefined();
    expect(findKeyMoveIndex(6, 'ArrowDown', 7)).toBeUndefined();
    expect(findKeyMoveIndex(3, 'Enter', 7)).toBeUndefined();
  });
});
