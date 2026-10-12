import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasNode } from './notesCanvas';

import { findNode, nodesInGroup, parseCanvas, serializeCanvas } from './notesCanvas';
import {
  CANVAS_CARD_MIN, CANVAS_EMPTY_SELECTION, CANVAS_GROUP_MIN, CANVAS_GROUP_PADDING, canvasShortcut, clipBounds,
  colorOfSelection, connectNodes, copyNodes, curvePoint, distanceToCurve, edgeAt, edgeCurve, fitGroupToContent,
  growGroups, isSelectionEmpty, moveNodes, nearestSide, nextEdgeEnds, nodeAtPoint, nodesInRect, normalizeCanvasUrl,
  oppositeSide, parsePasted, pasteClip, placeNode, pruneSelection, recolorSelection, rectOfPoints, removeSelection,
  reorderNodes, resizeNode, resizeRect, selectAll, selectionBounds, serializeClip, snapDelta, snapTo, toggleSelected,
  wrapInGroup,
} from './notesCanvasEdit';

function node(id: string, x: number, y: number, width = 100, height = 60, type = 'text'): CanvasNode {
  return {
    id, type, x, y, width, height,
  };
}

// Группа `g` (0,0 400×300) с карточками `a` и `b` внутри, карточка `c` снаружи; стрелки a→b и b→c
function sample(): CanvasDoc {
  return {
    nodes: [
      node('g', 0, 0, 400, 300, 'group'),
      node('a', 20, 20),
      node('b', 200, 100),
      node('c', 600, 100),
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c', label: 'дальше' },
    ],
  };
}

function rectOf(doc: CanvasDoc, id: string) {
  const {
    x, y, width, height,
  } = findNode(doc, id)!;
  return {
    x, y, width, height,
  };
}

function counter(prefix = 'n') {
  let count = 0;
  return () => `${prefix}${++count}`;
}

describe('сетка', () => {
  it('значение встаёт на ближайшую линию; сетка 1 — целое', () => {
    expect(snapTo(14)).toBe(10);
    expect(snapTo(15)).toBe(20);
    expect(snapTo(-14)).toBe(-10);
    expect(snapTo(14.4, 1)).toBe(14);
    expect(snapTo(33, 22)).toBe(44);
  });

  it('сдвиг ставит угол на сетку, даже если узел стоял не на ней', () => {
    expect(snapDelta({ x: 13, y: 27 }, 4, 4)).toEqual({ dx: 7, dy: 3 });
    expect(snapDelta({ x: 10, y: 20 }, 26, -4)).toEqual({ dx: 30, dy: 0 });
    expect(snapDelta({ x: 13, y: 27 }, 4.4, 4.6, 1)).toEqual({ dx: 4, dy: 5 });
  });
});

describe('размер', () => {
  const rect = {
    x: 0, y: 0, width: 200, height: 100,
  };

  it('угловая ручка двигает две стороны, противоположный угол стоит', () => {
    expect(resizeRect(rect, 'se', 33, 48)).toEqual({
      x: 0, y: 0, width: 230, height: 150,
    });
    expect(resizeRect(rect, 'nw', -33, -48)).toEqual({
      x: -30, y: -50, width: 230, height: 150,
    });
  });

  it('боковая ручка двигает одну сторону', () => {
    expect(resizeRect(rect, 'e', 51, 500)).toEqual({
      x: 0, y: 0, width: 250, height: 100,
    });
    expect(resizeRect(rect, 'n', 500, 21)).toEqual({
      x: 0, y: 20, width: 200, height: 80,
    });
  });

  it('меньше наименьшего размера не становится, противоположная сторона не едет', () => {
    expect(resizeRect(rect, 'se', -500, -500)).toEqual({
      x: 0, y: 0, width: CANVAS_CARD_MIN.width, height: CANVAS_CARD_MIN.height,
    });
    expect(resizeRect(rect, 'nw', 500, 500)).toEqual({
      x: 200 - CANVAS_CARD_MIN.width,
      y: 100 - CANVAS_CARD_MIN.height,
      width: CANVAS_CARD_MIN.width,
      height: CANVAS_CARD_MIN.height,
    });
  });

  it('без сетки размер меняется по пикселю', () => {
    expect(resizeRect(rect, 'se', 3.4, 7.6, CANVAS_CARD_MIN, 1)).toEqual({
      x: 0, y: 0, width: 203, height: 108,
    });
  });

  it('у группы меняется рамка, содержимое остаётся на месте', () => {
    const doc = sample();
    const next = resizeNode(doc, 'g', 'se', 200, 100);
    expect(rectOf(next, 'g')).toEqual({
      x: 0, y: 0, width: 600, height: 400,
    });
    expect(rectOf(next, 'a')).toEqual(rectOf(doc, 'a'));
    expect(rectOf(next, 'b')).toEqual(rectOf(doc, 'b'));
    // Наименьший размер группы больше, чем у карточки
    expect(rectOf(resizeNode(doc, 'g', 'se', -900, -900), 'g')).toEqual({ x: 0, y: 0, ...CANVAS_GROUP_MIN });
  });

  it('нет узла или размер тот же — документ прежний', () => {
    const doc = sample();
    expect(placeNode(doc, 'a', rectOf(doc, 'a'))).toBe(doc);
    expect(rectOf(placeNode(doc, 'a', {
      x: 1, y: 2, width: 3, height: 4,
    }), 'a')).toEqual({
      x: 1, y: 2, width: 3, height: 4,
    });
    expect(resizeNode(doc, 'нет', 'se', 10, 10)).toBe(doc);
    expect(resizeNode(doc, 'a', 'se', 2, 2)).toBe(doc);
  });
});

describe('сдвиг нескольких узлов', () => {
  it('группа тянет содержимое; узел, выбранный вместе с группой, сдвигается один раз', () => {
    const doc = sample();
    const next = moveNodes(doc, ['g', 'a', 'c'], 10, 20);
    expect(rectOf(next, 'g')).toMatchObject({ x: 10, y: 20 });
    expect(rectOf(next, 'a')).toMatchObject({ x: 30, y: 40 });
    expect(rectOf(next, 'b')).toMatchObject({ x: 210, y: 120 });
    expect(rectOf(next, 'c')).toMatchObject({ x: 610, y: 120 });
  });

  it('нулевой сдвиг и незнакомые id — документ прежний', () => {
    const doc = sample();
    expect(moveNodes(doc, ['a'], 0, 0)).toBe(doc);
    expect(moveNodes(doc, ['нет'], 5, 5)).toBe(doc);
  });
});

describe('рамка группы при сдвиге', () => {
  it('карточка выступила меньше чем наполовину — рамка растёт до неё с полем', () => {
    const doc = sample();
    // `b` (200…300 по x) уезжает к 340…440: за рамкой 40 из 100
    const next = growGroups(doc, moveNodes(doc, ['b'], 140, 0));
    expect(rectOf(next, 'g')).toEqual({
      x: 0, y: 0, width: 440 + CANVAS_GROUP_PADDING, height: 300,
    });
    expect(nodesInGroup(next, 'g').map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('рамка растёт и влево, и вверх', () => {
    const doc = sample();
    const next = growGroups(doc, moveNodes(doc, ['a'], -30, -20));
    expect(rectOf(next, 'g')).toEqual({
      x: -10 - CANVAS_GROUP_PADDING, y: -CANVAS_GROUP_PADDING, width: 430, height: 320,
    });
  });

  it('карточка выступила больше чем наполовину — вышла из группы, рамка прежняя', () => {
    const doc = sample();
    const next = growGroups(doc, moveNodes(doc, ['b'], 260, 0));
    expect(rectOf(next, 'g')).toEqual(rectOf(doc, 'g'));
    expect(nodesInGroup(next, 'g').map(({ id }) => id)).toEqual(['a']);
  });

  it('карточка, не лежавшая в группе, рамку не растягивает', () => {
    const doc = sample();
    // `c` заезжает на рамку, но в группе не была
    const next = growGroups(doc, moveNodes(doc, ['c'], -250, 0));
    expect(rectOf(next, 'g')).toEqual(rectOf(doc, 'g'));
  });

  it('сдвиг самой группы и сдвиг внутри рамки ничего не растягивают', () => {
    const doc = sample();
    const moved = moveNodes(doc, ['g'], 500, 500);
    expect(growGroups(doc, moved)).toBe(moved);
    const inside = moveNodes(doc, ['a'], 10, 10);
    expect(growGroups(doc, inside)).toBe(inside);
  });

  it('выросшая вложенная группа растягивает внешнюю', () => {
    const doc: CanvasDoc = {
      nodes: [
        node('outer', 0, 0, 400, 400, 'group'),
        node('inner', 50, 50, 300, 200, 'group'),
        node('card', 220, 100),
      ],
      edges: [],
    };
    // Карточка наполовину выезжает за внутреннюю рамку (350), оставаясь во внешней (400)
    const next = growGroups(doc, moveNodes(doc, ['card'], 80, 0));
    expect(rectOf(next, 'inner')).toEqual({
      x: 50, y: 50, width: 370, height: 200,
    });
    expect(rectOf(next, 'outer')).toEqual({
      x: 0, y: 0, width: 440, height: 400,
    });
  });

  it('увеличенная карточка внутри группы тоже растягивает рамку', () => {
    const doc = sample();
    const next = growGroups(doc, resizeNode(doc, 'b', 'se', 150, 0));
    expect(rectOf(next, 'b').width).toBe(250);
    expect(rectOf(next, 'g').width).toBe(450 + CANVAS_GROUP_PADDING);
  });
});

describe('«по содержимому» и «обернуть в группу»', () => {
  it('рамка — границы содержимого плюс поле', () => {
    const doc = sample();
    expect(rectOf(fitGroupToContent(doc, 'g'), 'g')).toEqual({
      x: 0, y: 0, width: 320, height: 180,
    });
    expect(rectOf(fitGroupToContent(doc, 'g', 5), 'g')).toEqual({
      x: 15, y: 15, width: 290, height: 150,
    });
  });

  it('пустая группа и не-группа не меняются', () => {
    const doc: CanvasDoc = { nodes: [node('g', 0, 0, 400, 300, 'group'), node('c', 600, 0)], edges: [] };
    expect(fitGroupToContent(doc, 'g')).toEqual(doc);
    expect(fitGroupToContent(doc, 'c')).toEqual(doc);
  });

  it('новая группа охватывает узлы с полем и лежит в списке перед первым из них', () => {
    const doc = sample();
    const { doc: next, id } = wrapInGroup(doc, ['b', 'c'], counter('w'));
    expect(id).toBe('w1');
    expect(next.nodes.map((item) => item.id)).toEqual(['g', 'a', 'w1', 'b', 'c']);
    expect(findNode(next, 'w1')).toEqual({
      id: 'w1', type: 'group', x: 180, y: 80, width: 540, height: 100,
    });
    expect(nodesInGroup(next, 'w1').map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('нечего оборачивать — документ прежний', () => {
    const doc = sample();
    expect(wrapInGroup(doc, [])).toEqual({ doc });
    expect(wrapInGroup(doc, ['нет'])).toEqual({ doc });
  });
});

describe('выделение', () => {
  it('добавить и убрать', () => {
    const one = toggleSelected(CANVAS_EMPTY_SELECTION, 'nodes', 'a');
    expect(one).toEqual({ nodes: ['a'], edges: [] });
    const two = toggleSelected(toggleSelected(one, 'nodes', 'b'), 'edges', 'ab');
    expect(two).toEqual({ nodes: ['a', 'b'], edges: ['ab'] });
    expect(toggleSelected(two, 'nodes', 'a')).toEqual({ nodes: ['b'], edges: ['ab'] });
    expect(isSelectionEmpty(CANVAS_EMPTY_SELECTION)).toBe(true);
    expect(isSelectionEmpty(two)).toBe(false);
  });

  it('всё', () => {
    expect(selectAll(sample())).toEqual({ nodes: ['g', 'a', 'b', 'c'], edges: ['ab', 'bc'] });
  });

  it('исчезнувшее из выделения убирается; ничего не исчезло — тот же объект', () => {
    const doc = sample();
    const selection = { nodes: ['a', 'нет'], edges: ['ab', 'нет'] };
    expect(pruneSelection(doc, selection)).toEqual({ nodes: ['a'], edges: ['ab'] });
    const same = { nodes: ['a'], edges: [] };
    expect(pruneSelection(doc, same)).toBe(same);
  });

  it('рамка: карточка — если задета, группа — только целиком', () => {
    const doc = sample();
    expect(rectOfPoints({ x: 250, y: 150 }, { x: 10, y: 10 })).toEqual({
      x: 10, y: 10, width: 240, height: 140,
    });
    // Рамка внутри группы задевает обе карточки, но не выделяет саму группу
    expect(nodesInRect(doc, rectOfPoints({ x: 10, y: 10 }, { x: 250, y: 150 }))).toEqual(['a', 'b']);
    expect(nodesInRect(doc, rectOfPoints({ x: -10, y: -10 }, { x: 410, y: 310 }))).toEqual(['g', 'a', 'b']);
    expect(nodesInRect(doc, rectOfPoints({ x: 450, y: 0 }, { x: 500, y: 50 }))).toEqual([]);
  });

  it('границы выделенного', () => {
    expect(selectionBounds(sample(), ['a', 'c'])).toEqual({
      x: 20, y: 20, width: 680, height: 140,
    });
    expect(selectionBounds(sample(), [])).toBeUndefined();
  });

  it('удаление: узлы со своими связями, выбранные связи, содержимое группы остаётся', () => {
    const doc = sample();
    const next = removeSelection(doc, { nodes: ['g', 'c'], edges: ['ab'] });
    expect(next.nodes.map((item) => item.id)).toEqual(['a', 'b']);
    expect(next.edges).toEqual([]);
    expect(removeSelection(doc, { nodes: ['a'], edges: [] }).edges.map((edge) => edge.id)).toEqual(['bc']);
    expect(removeSelection(doc, CANVAS_EMPTY_SELECTION)).toBe(doc);
  });

  it('цвет всему выделенному и снятие цвета', () => {
    const doc = sample();
    const selection = { nodes: ['a', 'b'], edges: ['ab'] };
    const painted = recolorSelection(doc, selection, '4');
    expect(findNode(painted, 'a')!.color).toBe('4');
    expect(findNode(painted, 'c')!.color).toBeUndefined();
    expect(painted.edges[0].color).toBe('4');
    expect(colorOfSelection(painted, selection)).toBe('4');
    expect(colorOfSelection(painted, { nodes: ['a', 'c'], edges: [] })).toBeUndefined();
    expect(recolorSelection(painted, selection, '4')).toBe(painted);
    const cleared = recolorSelection(painted, selection);
    expect('color' in findNode(cleared, 'a')!).toBe(false);
    expect(serializeCanvas(cleared)).toBe(serializeCanvas(doc));
  });
});

describe('копии', () => {
  it('в снимок идут узлы, содержимое групп и связи между ними', () => {
    const doc = sample();
    const clip = copyNodes(doc, ['g']);
    expect(clip.nodes.map((item) => item.id)).toEqual(['g', 'a', 'b']);
    expect(clip.edges.map((edge) => edge.id)).toEqual(['ab']);
    expect(copyNodes(doc, ['b']).edges).toEqual([]);
    expect(clipBounds(clip)).toEqual({
      x: 0, y: 0, width: 400, height: 300,
    });
    expect(clipBounds(copyNodes(doc, []))).toBeUndefined();
  });

  it('вставка даёт новые id и переводит концы связей на новые узлы', () => {
    const doc = sample();
    const { doc: next, ids } = pasteClip(doc, copyNodes(doc, ['a', 'b']), 20, 30, counter());
    expect(ids).toEqual(['n1', 'n2']);
    expect(next.nodes).toHaveLength(6);
    expect(rectOf(next, 'n1')).toEqual({
      x: 40, y: 50, width: 100, height: 60,
    });
    expect(next.edges[2]).toEqual({ id: 'n3', fromNode: 'n1', toNode: 'n2' });
    // Прежние узлы и связи не тронуты
    expect(next.nodes.slice(0, 4)).toEqual(doc.nodes);
    expect(next.edges.slice(0, 2)).toEqual(doc.edges);
  });

  it('вставка сохраняет поля узлов и связей, файл остаётся JSON Canvas', () => {
    const doc: CanvasDoc = {
      nodes: [{ ...node('a', 0, 0), color: '3', text: 'текст' }, { ...node('b', 200, 0), custom: 1 }],
      edges: [{
        id: 'ab', fromNode: 'a', toNode: 'b', fromSide: 'right', toEnd: 'none', label: 'подпись',
      }],
    };
    const { doc: next } = pasteClip(doc, copyNodes(doc, ['a', 'b']), 0, 100, counter());
    expect(next.nodes[2]).toMatchObject({ color: '3', text: 'текст', y: 100 });
    expect(next.nodes[3]).toMatchObject({ custom: 1 });
    expect(next.edges[1]).toMatchObject({ fromSide: 'right', toEnd: 'none', label: 'подпись' });
    const reparsed = parseCanvas(serializeCanvas(next));
    expect(reparsed.dropped).toEqual({ nodes: 0, edges: 0 });
    expect(reparsed.doc).toEqual(next);
  });

  it('занятый id не выдаётся повторно; пустой снимок — документ прежний', () => {
    const doc = sample();
    const ids = ['a', 'x1', 'x2'];
    const { doc: next } = pasteClip(doc, copyNodes(doc, ['a']), 10, 10, () => ids.shift() || 'z');
    expect(next.nodes[4].id).toBe('x1');
    expect(pasteClip(doc, { nodes: [], edges: [] }, 10, 10)).toEqual({ doc, ids: [] });
  });
});

describe('буфер обмена', () => {
  it('снимок уходит текстом JSON Canvas и возвращается узлами', () => {
    const doc = sample();
    const clip = copyNodes(doc, ['a', 'b']);
    const pasted = parsePasted(serializeClip(clip));
    expect(pasted).toEqual({ kind: 'nodes', clip });
  });

  it('адрес http(s) — ссылка, прочее — текст', () => {
    expect(parsePasted(' https://jsoncanvas.org/spec \n'))
      .toEqual({ kind: 'link', url: 'https://jsoncanvas.org/spec' });
    expect(parsePasted('example.com')).toEqual({ kind: 'text', text: 'example.com' });
    expect(parsePasted('см. https://example.com')).toEqual({ kind: 'text', text: 'см. https://example.com' });
    expect(parsePasted('{"не": "холст"}')).toEqual({ kind: 'text', text: '{"не": "холст"}' });
    expect(parsePasted('{"nodes": []}')).toEqual({ kind: 'text', text: '{"nodes": []}' });
    expect(parsePasted('javascript:alert(1)')).toEqual({ kind: 'text', text: 'javascript:alert(1)' });
    expect(parsePasted('   ')).toBeUndefined();
    expect((parsePasted('я'.repeat(30000)) as { text: string }).text).toHaveLength(20000);
  });
});

describe('слои', () => {
  it('на передний и на задний план', () => {
    const doc = sample();
    expect(reorderNodes(doc, ['a'], 'front').nodes.map((item) => item.id)).toEqual(['g', 'b', 'c', 'a']);
    expect(reorderNodes(doc, ['c', 'b'], 'back').nodes.map((item) => item.id)).toEqual(['b', 'c', 'g', 'a']);
    expect(reorderNodes(doc, ['c'], 'front')).toBe(doc);
    expect(reorderNodes(doc, ['нет'], 'front')).toBe(doc);
  });
});

describe('стрелки', () => {
  const rect = {
    x: 0, y: 0, width: 200, height: 100,
  };

  it('ближайшая сторона — внутри и снаружи прямоугольника', () => {
    expect(nearestSide(rect, { x: 100, y: 5 })).toBe('top');
    expect(nearestSide(rect, { x: 190, y: 50 })).toBe('right');
    expect(nearestSide(rect, { x: 100, y: 95 })).toBe('bottom');
    expect(nearestSide(rect, { x: 10, y: 50 })).toBe('left');
    expect(nearestSide(rect, { x: -50, y: 50 })).toBe('left');
    expect(nearestSide(rect, { x: 100, y: 300 })).toBe('bottom');
    expect(oppositeSide('left')).toBe('right');
    expect(oppositeSide('top')).toBe('bottom');
  });

  it('карточка под точкой: верхняя, группы не считаются', () => {
    const doc: CanvasDoc = {
      nodes: [node('g', 0, 0, 400, 300, 'group'), node('a', 20, 20), node('b', 60, 40)],
      edges: [],
    };
    expect(nodeAtPoint(doc, { x: 70, y: 50 })?.id).toBe('b');
    expect(nodeAtPoint(doc, { x: 70, y: 50 }, 'b')?.id).toBe('a');
    expect(nodeAtPoint(doc, { x: 300, y: 250 })).toBeUndefined();
  });

  it('стрелка с выбранными сторонами; повторная и петля не создаются', () => {
    const doc = sample();
    const next = connectNodes(doc, 'a', 'c', { fromSide: 'bottom', toSide: 'left' }, counter('e'));
    expect(next.edges[2]).toEqual({
      id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'c', toSide: 'left',
    });
    expect(connectNodes(doc, 'a', 'b', { fromSide: 'top' })).toBe(doc);
    expect(connectNodes(doc, 'a', 'a', {})).toBe(doc);
    const { p, q } = edgeCurve(next, next.edges[2])!;
    expect(p).toEqual({ x: 70, y: 80, side: 'bottom' });
    expect(q).toEqual({ x: 600, y: 130, side: 'left' });
  });

  it('кривая начинается и кончается на сторонах узлов', () => {
    const doc = sample();
    const curve = edgeCurve(doc, doc.edges[1])!;
    expect(curvePoint(curve, 0)).toEqual({ x: curve.p.x, y: curve.p.y });
    expect(curvePoint(curve, 1)).toEqual({ x: curve.q.x, y: curve.q.y });
    expect(distanceToCurve(curve, curvePoint(curve, 0.5))).toBeLessThan(0.001);
    expect(edgeCurve(doc, { id: 'x', fromNode: 'a', toNode: 'нет' })).toBeUndefined();
  });

  it('стрелка под точкой: в пределах допуска, иначе ничего', () => {
    const doc = sample();
    const middle = curvePoint(edgeCurve(doc, doc.edges[1])!, 0.5);
    expect(edgeAt(doc, { x: middle.x, y: middle.y + 5 }, 8)).toBe('bc');
    expect(edgeAt(doc, { x: middle.x, y: middle.y + 30 }, 8)).toBeUndefined();
    expect(edgeAt(doc, { x: 1000, y: 1000 }, 8)).toBeUndefined();
  });

  it('виды концов идут по кругу, значения по умолчанию не пишутся', () => {
    const both = nextEdgeEnds({});
    expect(both).toEqual({ fromEnd: 'arrow', toEnd: undefined });
    const none = nextEdgeEnds(both);
    expect(none).toEqual({ fromEnd: undefined, toEnd: 'none' });
    expect(nextEdgeEnds(none)).toEqual({ fromEnd: undefined, toEnd: undefined });
    expect(nextEdgeEnds({ toEnd: 'arrow' })).toEqual(both);
  });
});

describe('адрес карточки-ссылки', () => {
  it('только http и https; без схемы — https', () => {
    expect(normalizeCanvasUrl(' https://jsoncanvas.org/spec ')).toBe('https://jsoncanvas.org/spec');
    expect(normalizeCanvasUrl('example.com/page?a=1')).toBe('https://example.com/page?a=1');
    expect(normalizeCanvasUrl('http://example.com')).toBe('http://example.com/');
  });

  it('иное отвергается', () => {
    ['', '   ', 'javascript:alert(1)', 'ftp://example.com', 'file:///etc/passwd', 'просто текст', 'два слова.com x',
      'data:text/html,hi', 'localhost'].forEach((text) => {
      expect(normalizeCanvasUrl(text)).toBeUndefined();
    });
  });
});

describe('клавиши', () => {
  const key = (code: string, mods: Partial<Parameters<typeof canvasShortcut>[0]> = {}) => canvasShortcut({
    key: code, code, ...mods,
  });

  it('с Ctrl или Cmd — по положению клавиши', () => {
    expect(canvasShortcut({ key: 'я', code: 'KeyZ', ctrlKey: true })).toBe('undo');
    expect(key('KeyZ', { metaKey: true })).toBe('undo');
    expect(key('KeyZ', { ctrlKey: true, shiftKey: true })).toBe('redo');
    expect(key('KeyY', { ctrlKey: true })).toBe('redo');
    expect(key('KeyA', { ctrlKey: true })).toBe('selectAll');
    expect(key('KeyD', { metaKey: true })).toBe('duplicate');
  });

  it('без модификаторов', () => {
    expect(key('Delete')).toBe('remove');
    expect(key('Backspace')).toBe('remove');
    expect(key('Enter')).toBe('edit');
    expect(key('F2')).toBe('edit');
    expect(key('ArrowLeft')).toBe('left');
    expect(key('ArrowDown', { shiftKey: true })).toBe('down');
  });

  it('чужие сочетания не перехватываются', () => {
    expect(key('KeyZ')).toBeUndefined();
    expect(key('KeyA')).toBeUndefined();
    // Копирование и вставка — события буфера обмена, клавиши не перехватываются
    expect(key('KeyC', { ctrlKey: true })).toBeUndefined();
    expect(key('KeyV', { ctrlKey: true })).toBeUndefined();
    expect(key('KeyA', { ctrlKey: true, shiftKey: true })).toBeUndefined();
    expect(key('KeyD', { ctrlKey: true, altKey: true })).toBeUndefined();
    expect(key('KeyS', { ctrlKey: true })).toBeUndefined();
    expect(key('Enter', { shiftKey: true })).toBeUndefined();
    expect(key('Delete', { ctrlKey: true })).toBeUndefined();
  });
});
