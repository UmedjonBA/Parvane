import { describe, expect, it } from 'vitest';

import { isEditableTarget, isPaletteHotkey, isPaletteSlashKey } from './paletteKeys';

function key(init: KeyboardEventInit, target: EventTarget | null = document.body) {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    altKey: Boolean(init.altKey),
    shiftKey: Boolean(init.shiftKey),
    isComposing: Boolean(init.isComposing),
    target,
  };
}

function make(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe('isEditableTarget', () => {
  it('поля ввода, списки и редактируемый текст — да; кнопка и документ — нет', () => {
    const host = make(`
      <input id="i"><textarea id="t"></textarea><select id="s"><option value="a">a</option></select>
      <div contenteditable="true"><span id="inner">текст</span></div>
      <div contenteditable="false"><span id="off">текст</span></div>
      <div role="textbox"><b id="box">x</b></div>
      <button id="b">Кнопка</button>
    `);
    const at = (id: string) => host.querySelector(`#${id}`);
    expect(isEditableTarget(at('i'))).toBe(true);
    expect(isEditableTarget(at('t'))).toBe(true);
    expect(isEditableTarget(at('s'))).toBe(true);
    expect(isEditableTarget(at('inner'))).toBe(true);
    expect(isEditableTarget(at('box'))).toBe(true);
    expect(isEditableTarget(at('off'))).toBe(false);
    expect(isEditableTarget(at('b'))).toBe(false);
    expect(isEditableTarget(document)).toBe(false);
    host.remove();
  });
});

describe('isPaletteSlashKey', () => {
  it('«/» вне поля открывает палитру, в том числе с Shift', () => {
    expect(isPaletteSlashKey(key({ key: '/' }))).toBe(true);
    expect(isPaletteSlashKey(key({ key: '/', shiftKey: true }))).toBe(true);
  });

  it('в поле ввода и в редактируемом тексте «/» печатается', () => {
    const host = make('<input id="i"><div contenteditable="true"><p id="p">x</p></div>');
    expect(isPaletteSlashKey(key({ key: '/' }, host.querySelector('#i')))).toBe(false);
    expect(isPaletteSlashKey(key({ key: '/' }, host.querySelector('#p')))).toBe(false);
    host.remove();
  });

  it('с Ctrl/Cmd/Alt, при наборе через IME и для других клавиш — нет', () => {
    expect(isPaletteSlashKey(key({ key: '/', ctrlKey: true }))).toBe(false);
    expect(isPaletteSlashKey(key({ key: '/', metaKey: true }))).toBe(false);
    expect(isPaletteSlashKey(key({ key: '/', altKey: true }))).toBe(false);
    expect(isPaletteSlashKey(key({ key: '/', isComposing: true }))).toBe(false);
    expect(isPaletteSlashKey(key({ key: '.' }))).toBe(false);
  });
});

describe('isPaletteHotkey', () => {
  it('Ctrl+K и Cmd+K, в том числе в русской раскладке по коду клавиши', () => {
    expect(isPaletteHotkey(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe(true);
    expect(isPaletteHotkey(key({ key: 'K', code: 'KeyK', metaKey: true }))).toBe(true);
    expect(isPaletteHotkey(key({ key: 'л', code: 'KeyK', ctrlKey: true }))).toBe(true);
  });

  it('без модификатора, с Shift или Alt и другие буквы — нет', () => {
    expect(isPaletteHotkey(key({ key: 'k', code: 'KeyK' }))).toBe(false);
    expect(isPaletteHotkey(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteHotkey(key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteHotkey(key({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe(false);
  });
});
