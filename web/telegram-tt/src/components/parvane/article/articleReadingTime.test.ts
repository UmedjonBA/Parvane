// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { getReadingMinutes } from './articleReadingTime';

describe('Время чтения статьи', () => {
  it('короткий текст — минута, разметка словами не считается', () => {
    expect(getReadingMinutes('')).toBe(1);
    expect(getReadingMinutes('# Заголовок\n\n- **один** пункт')).toBe(1);
  });

  it('по 200 слов в минуту с округлением вверх', () => {
    expect(getReadingMinutes(Array(200).fill('слово').join(' '))).toBe(1);
    expect(getReadingMinutes(Array(201).fill('слово').join(' '))).toBe(2);
    expect(getReadingMinutes(Array(600).fill('word').join('\n'))).toBe(3);
  });
});
