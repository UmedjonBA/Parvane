import { describe, expect, it } from 'vitest';

import { getSwipeDelta, isSwipeBlocked } from './plannerSwipe';

describe('планировщик: листание дней жестом', () => {
  it('палец влево — следующий день, вправо — предыдущий', () => {
    expect(getSwipeDelta({ x: 300, y: 400 }, { x: 200, y: 400 })).toBe(1);
    expect(getSwipeDelta({ x: 100, y: 400 }, { x: 220, y: 380 })).toBe(-1);
  });

  it('короткий жест — не листание', () => {
    expect(getSwipeDelta({ x: 300, y: 400 }, { x: 241, y: 400 })).toBe(0);
    expect(getSwipeDelta({ x: 300, y: 400 }, { x: 240, y: 400 })).toBe(1);
    expect(getSwipeDelta({ x: 300, y: 400 }, { x: 300, y: 400 })).toBe(0);
  });

  it('прокрутка по вертикали и жест по диагонали — не листание', () => {
    expect(getSwipeDelta({ x: 300, y: 100 }, { x: 290, y: 500 })).toBe(0);
    expect(getSwipeDelta({ x: 300, y: 100 }, { x: 200, y: 180 })).toBe(0);
    // Небольшой уход по вертикали листанию не мешает
    expect(getSwipeDelta({ x: 300, y: 100 }, { x: 200, y: 170 })).toBe(1);
    expect(getSwipeDelta({ x: 300, y: 100 }, { x: 200, y: 30 })).toBe(1);
  });
});

describe('планировщик: где жест листания не начинается', () => {
  function build() {
    const root = document.createElement('div');
    root.innerHTML = '<section><div class="scroller"><button class="block"></button></div>'
      + '<div class="plain"><span class="text"></span><input class="field" /></div></section>';
    document.body.append(root);
    return root;
  }

  function setScroll(element: Element, scrollWidth: number, clientWidth: number, overflowX: string) {
    Object.defineProperty(element, 'scrollWidth', { value: scrollWidth });
    Object.defineProperty(element, 'clientWidth', { value: clientWidth });
    (element as HTMLElement).style.overflowX = overflowX;
  }

  it('внутри ребёнка, который листается вбок, жест принадлежит ему', () => {
    const root = build();
    setScroll(root.querySelector('.scroller')!, 900, 300, 'auto');
    expect(isSwipeBlocked(root.querySelector('.block')!, root)).toBe(true);
    expect(isSwipeBlocked(root.querySelector('.scroller')!, root)).toBe(true);
    expect(isSwipeBlocked(root.querySelector('.text')!, root)).toBe(false);
  });

  it('ребёнок, которому листать нечего либо нельзя, жесту не мешает', () => {
    const root = build();
    setScroll(root.querySelector('.scroller')!, 300, 300, 'auto');
    expect(isSwipeBlocked(root.querySelector('.block')!, root)).toBe(false);
    setScroll(root.querySelector('.plain')!, 900, 300, 'hidden');
    expect(isSwipeBlocked(root.querySelector('.text')!, root)).toBe(false);
  });

  it('прокрутка самого экрана и его предков не в счёт; поле ввода жест не начинает', () => {
    const root = build();
    setScroll(root, 900, 300, 'auto');
    expect(isSwipeBlocked(root.querySelector('.text')!, root)).toBe(false);
    expect(isSwipeBlocked(root.querySelector('.field')!, root)).toBe(true);
  });
});
