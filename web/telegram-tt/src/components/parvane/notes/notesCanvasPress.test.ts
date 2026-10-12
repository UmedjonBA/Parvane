import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasNode } from './notesCanvas';

import { groupAtPoint, pressAction } from './notesCanvasPress';

function node(id: string, type: string, x: number, y: number, width: number, height: number): CanvasNode {
  return {
    id, type, x, y, width, height,
  };
}

function docOf(...nodes: CanvasNode[]): CanvasDoc {
  return { nodes, edges: [] };
}

describe('groupAtPoint', () => {
  const outer = node('outer', 'group', 0, 0, 400, 300);
  const inner = node('inner', 'group', 50, 50, 100, 100);
  const card = node('card', 'text', 200, 200, 100, 60);

  it('находит группу, внутри которой лежит точка', () => {
    expect(groupAtPoint(docOf(outer, card), { x: 10, y: 10 })?.id).toBe('outer');
  });

  it('вне групп — ничего', () => {
    expect(groupAtPoint(docOf(outer, card), { x: 500, y: 10 })).toBeUndefined();
    expect(groupAtPoint(docOf(card), { x: 210, y: 210 })).toBeUndefined();
  });

  it('граница группы считается её частью', () => {
    expect(groupAtPoint(docOf(outer), { x: 400, y: 300 })?.id).toBe('outer');
    expect(groupAtPoint(docOf(outer), { x: 401, y: 300 })).toBeUndefined();
  });

  it('из вложенных групп берётся внутренняя, в каком бы порядке они ни лежали в файле', () => {
    expect(groupAtPoint(docOf(outer, inner), { x: 60, y: 60 })?.id).toBe('inner');
    expect(groupAtPoint(docOf(inner, outer), { x: 60, y: 60 })?.id).toBe('inner');
    expect(groupAtPoint(docOf(inner, outer), { x: 300, y: 60 })?.id).toBe('outer');
  });

  it('из одинаковых групп берётся нарисованная выше', () => {
    const twin = { ...outer, id: 'twin' };
    expect(groupAtPoint(docOf(outer, twin), { x: 10, y: 10 })?.id).toBe('twin');
  });

  it('карточки группой не считаются', () => {
    expect(groupAtPoint(docOf(outer, card), { x: 210, y: 210 })?.id).toBe('outer');
  });
});

describe('pressAction', () => {
  it('пустое место вне групп двигает поле', () => {
    expect(pressAction({})).toEqual({ kind: 'board' });
  });

  it('пустое место внутри группы двигает эту группу', () => {
    expect(pressAction({ groupId: 'g' })).toEqual({ kind: 'group', id: 'g' });
  });

  it('с Shift и в режиме выбора внутри группы рисуется рамка выделения, а не двигается группа', () => {
    expect(pressAction({ groupId: 'g', isAdditive: true })).toEqual({ kind: 'marquee' });
    expect(pressAction({ isAdditive: true })).toEqual({ kind: 'marquee' });
  });

  it('средняя кнопка и пробел двигают поле и над группой, и над карточкой', () => {
    expect(pressAction({ isPanForced: true, groupId: 'g' })).toEqual({ kind: 'pan' });
    expect(pressAction({ isPanForced: true, nodeId: 'n', handle: 'se' })).toEqual({ kind: 'pan' });
  });

  it('карточка внутри группы берётся сама', () => {
    expect(pressAction({ nodeId: 'card', groupId: 'g' })).toEqual({ kind: 'node', id: 'card' });
    expect(pressAction({ nodeId: 'card', groupId: 'g', isAdditive: true })).toEqual({ kind: 'node', id: 'card' });
  });

  it('ручка размера и точка стрелки старше сдвига узла', () => {
    expect(pressAction({ nodeId: 'g', handle: 'se', groupId: 'g' })).toEqual({ kind: 'resize', id: 'g', handle: 'se' });
    expect(pressAction({ nodeId: 'n', port: 'right' })).toEqual({ kind: 'arrow', id: 'n', side: 'right' });
    expect(pressAction({ nodeId: 'n', port: 'right', handle: 'e' })).toEqual({ kind: 'arrow', id: 'n', side: 'right' });
  });

  it('стрелка внутри группы выбирается, а не двигает группу', () => {
    expect(pressAction({ edgeId: 'e', groupId: 'g' })).toEqual({ kind: 'edge', id: 'e' });
    expect(pressAction({ edgeId: 'e', isAdditive: true })).toEqual({ kind: 'edge', id: 'e' });
  });

  it('в режиме «Связать» нажатие выбирает вторую карточку либо отменяет режим', () => {
    expect(pressAction({ isLinking: true, nodeId: 'n' })).toEqual({ kind: 'link', id: 'n' });
    expect(pressAction({ isLinking: true, groupId: 'g' })).toEqual({ kind: 'link', id: undefined });
    expect(pressAction({ isLinking: true, nodeId: 'n', port: 'top' })).toEqual({ kind: 'arrow', id: 'n', side: 'top' });
  });
});
