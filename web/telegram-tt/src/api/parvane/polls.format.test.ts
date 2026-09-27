import { describe, expect, it } from 'vitest';

import { readPollFields } from './polls';

// spec 005: опросы читаются в обоих форматах (web и desktop); android пишет оба.
describe('readPollFields', () => {
  it('reads the web format', () => {
    const f = readPollFields({
      kind: 'poll', question: 'Q', options: ['a', 'b'], is_public: true, is_multiple: true, is_quiz: false,
    });
    expect(f.options).toEqual(['a', 'b']);
    expect(f.isPublic && f.isMultiple && !f.isQuiz).toBe(true);
  });
  it('reads the desktop format', () => {
    const f = readPollFields({
      kind: 'poll', question: 'Q', answers: ['x', 'y', 'z'], public: false, multiple: false, quiz: true,
      correct: [2], solution: 's',
    });
    expect(f.options).toEqual(['x', 'y', 'z']);
    expect(f.isQuiz).toBe(true);
    expect(f.isPublic).toBe(false);
    expect(f.correct).toEqual([2]);
    expect(f.solution).toBe('s');
  });
  it('prefers explicit web names when both are present', () => {
    const f = readPollFields({ options: ['a'], answers: ['b'], is_quiz: false, quiz: true });
    expect(f.options).toEqual(['a']);
    expect(f.isQuiz).toBe(false);
  });
});
