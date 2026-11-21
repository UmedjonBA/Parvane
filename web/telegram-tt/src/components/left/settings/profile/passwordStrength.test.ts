import { describe, expect, it } from 'vitest';

import { measurePassword } from './passwordStrength';

describe('measurePassword', () => {
  it('отмечает короткий пароль', () => {
    expect(measurePassword('abc12').level).toBe('short');
  });

  it('средний — длинный, но одного вида знаков или короче 12', () => {
    expect(measurePassword('abcdefghijklmn').level).toBe('fair');
    expect(measurePassword('abcdef12').level).toBe('fair');
  });

  it('надёжный — от 12 знаков и не меньше двух видов', () => {
    const strength = measurePassword('пример-пароль-42');
    expect(strength.level).toBe('strong');
    expect(strength.hasDigits).toBe(true);
    expect(strength.hasSymbols).toBe(true);
  });

  it('считает знаки, а не единицы UTF-16', () => {
    expect(measurePassword('😀😀😀😀😀😀😀😀').length).toBe(8);
  });
});
