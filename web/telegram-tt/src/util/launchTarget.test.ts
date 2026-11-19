import { describe, expect, it } from 'vitest';

import type { ParvaneModuleId } from './parvaneModules';

import { parseLaunchTarget, stripLaunchParam } from './launchTarget';

const ALL_ON = () => true;

function onlyOff(off: ParvaneModuleId) {
  return (id: ParvaneModuleId) => id !== off;
}

describe('адрес запуска', () => {
  it('ярлыки манифеста ведут в свои модули', () => {
    expect(parseLaunchTarget('?open=compose', ALL_ON)).toBe('compose');
    expect(parseLaunchTarget('?open=today', ALL_ON)).toBe('today');
    expect(parseLaunchTarget('?open=new-note', ALL_ON)).toBe('newNote');
    expect(parseLaunchTarget('?open=music', ALL_ON)).toBe('music');
    expect(parseLaunchTarget('?open=share', ALL_ON)).toBe('share');
  });

  it('прежние ярлыки по-прежнему понимаются', () => {
    expect(parseLaunchTarget('?open=chats', ALL_ON)).toBe('chats');
    expect(parseLaunchTarget('?open=entry', ALL_ON)).toBe('entry');
    expect(parseLaunchTarget('?open=notes', ALL_ON)).toBe('notes');
    expect(parseLaunchTarget('?open=files', ALL_ON)).toBe('files');
  });

  it('ярлык в выключенный модуль открывает чаты, а не падает', () => {
    expect(parseLaunchTarget('?open=music', onlyOff('music'))).toBe('chats');
    expect(parseLaunchTarget('?open=today', onlyOff('plan'))).toBe('chats');
    expect(parseLaunchTarget('?open=new-note', onlyOff('notes'))).toBe('chats');
    expect(parseLaunchTarget('?open=share', onlyOff('music'))).toBe('share');
  });

  it('без параметра и с чужим значением — обычный экран', () => {
    expect(parseLaunchTarget('', ALL_ON)).toBeUndefined();
    expect(parseLaunchTarget('?open=', ALL_ON)).toBeUndefined();
    expect(parseLaunchTarget('?open=constructor', ALL_ON)).toBeUndefined();
    expect(parseLaunchTarget('?open=__proto__', ALL_ON)).toBeUndefined();
  });

  it('параметр убирается из адреса, остальное остаётся', () => {
    expect(stripLaunchParam('https://h.example/app/?open=today&x=1#y')).toBe('/app/?x=1#y');
    expect(stripLaunchParam('https://h.example/?open=share')).toBe('/');
  });
});
