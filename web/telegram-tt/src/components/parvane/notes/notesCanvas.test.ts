import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasNode } from './notesCanvas';

import {
  addEdge, addNode, boundsOf, CANVAS_DEFAULT_NODE_HEIGHT, CANVAS_DEFAULT_NODE_WIDTH, CANVAS_FIT_MAX_SCALE,
  CANVAS_MAX_SCALE, CANVAS_MIN_SCALE, clampCanvasScale, createEmptyCanvas, edgeAnchors, findNode, firstGroupView,
  fitView, isCanvasNodeType, isCanvasPresetColor, moveNode, newCanvasId, nodesInGroup, parseCanvas, removeEdge,
  removeNode, serializeCanvas, sidePoint, updateEdge, updateNode,
} from './notesCanvas';

// Похоже на файл из Obsidian: группа с двумя карточками внутри, заметка, ссылка, стрелки с подписями
const SAMPLE = JSON.stringify({
  nodes: [
    {
      id: 'a1b2c3d4e5f60718', type: 'group', x: -40, y: -60, width: 640, height: 420, color: '5', label: 'Спека 016',
    },
    {
      id: '0f1e2d3c4b5a6978', type: 'text', x: 0, y: 0, width: 250, height: 120, text: '# Облако\n- папки\n- корзина',
    },
    {
      id: '1122334455667788',
      type: 'file',
      x: 300,
      y: 20,
      width: 260,
      height: 300,
      file: 'Проект Парванэ.md',
      subpath: '#Облако',
      color: '3',
    },
    {
      id: '99aabbccddeeff00', type: 'link', x: 700, y: 40, width: 320, height: 200, url: 'https://jsoncanvas.org',
    },
    {
      id: 'deadbeefdeadbeef', type: 'text', x: 700, y: 400, width: 250, height: 60, text: 'снаружи', color: '#ff8800',
    },
  ],
  edges: [
    {
      id: 'e000000000000001',
      fromNode: '0f1e2d3c4b5a6978',
      fromSide: 'right',
      toNode: '1122334455667788',
      toSide: 'left',
      label: 'описано в',
    },
    {
      id: 'e000000000000002',
      fromNode: '1122334455667788',
      toNode: '99aabbccddeeff00',
      toEnd: 'arrow',
      color: '2',
      label: 'формат',
    },
  ],
}, undefined, '\t');

function sample() {
  return parseCanvas(SAMPLE).doc;
}

function rect(id: string, x: number, y: number, width: number, height: number, type = 'text'): CanvasNode {
  return {
    id, type, x, y, width, height,
  };
}

// Группа g (0,0 400×300): внутри a и вложенная группа g2 с b; c пересекает границу, d снаружи
function grouped(): CanvasDoc {
  return {
    nodes: [
      rect('g', 0, 0, 400, 300, 'group'),
      rect('a', 0, 0, 100, 50),
      rect('g2', 200, 100, 200, 200, 'group'),
      rect('b', 220, 120, 100, 50),
      rect('c', 350, 10, 100, 50),
      rect('d', 600, 600, 100, 50),
    ],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'd', label: 'ведёт' },
      { id: 'e3', fromNode: 'c', toNode: 'd' },
    ],
  };
}

function sequence(...ids: string[]) {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)];
}

describe('холст: разбор', () => {
  it('настоящий файл: группа, текст, заметка, ссылка, стрелки с подписями', () => {
    const { doc, error, dropped } = parseCanvas(SAMPLE);
    expect(error).toBeUndefined();
    expect(dropped).toEqual({ nodes: 0, edges: 0 });
    expect(doc.nodes.map((node) => node.type)).toEqual(['group', 'text', 'file', 'link', 'text']);
    expect(doc.nodes[0]).toEqual({
      id: 'a1b2c3d4e5f60718', type: 'group', x: -40, y: -60, width: 640, height: 420, color: '5', label: 'Спека 016',
    });
    expect(doc.nodes[1].text).toBe('# Облако\n- папки\n- корзина');
    expect(doc.nodes[2]).toMatchObject({ file: 'Проект Парванэ.md', subpath: '#Облако', color: '3' });
    expect(doc.nodes[3].url).toBe('https://jsoncanvas.org');
    expect(doc.nodes[4].color).toBe('#ff8800');
    expect(doc.edges).toEqual([
      {
        id: 'e000000000000001',
        fromNode: '0f1e2d3c4b5a6978',
        fromSide: 'right',
        toNode: '1122334455667788',
        toSide: 'left',
        label: 'описано в',
      },
      {
        id: 'e000000000000002',
        fromNode: '1122334455667788',
        toNode: '99aabbccddeeff00',
        toEnd: 'arrow',
        color: '2',
        label: 'формат',
      },
    ]);
    expect(doc.extra).toBeUndefined();
  });

  it('незнакомые типы узлов и незнакомые поля сохраняются при записи и повторном разборе', () => {
    const source = JSON.stringify({
      nodes: [
        {
          id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'т', zIndex: 3, styleAttributes: { a: 1 },
        },
        {
          id: 'n2', type: 'mindmap', x: 10, y: 20, width: 30, height: 40, branches: ['x', 'y'],
        },
      ],
      edges: [{
        id: 'e1', fromNode: 'n1', toNode: 'n2', pathfindingMethod: 'square', styleAttributes: { arrow: 'thin' },
      }],
      metadata: { version: '1.0-1.0', frontmatter: {} },
    });
    const { doc, error } = parseCanvas(source);
    expect(error).toBeUndefined();
    expect(doc.nodes[0].zIndex).toBe(3);
    expect(doc.nodes[1]).toMatchObject({ type: 'mindmap', branches: ['x', 'y'] });
    expect(isCanvasNodeType(doc.nodes[1].type)).toBe(false);
    expect(doc.edges[0].pathfindingMethod).toBe('square');
    expect(doc.extra).toEqual({ metadata: { version: '1.0-1.0', frontmatter: {} } });

    const text = serializeCanvas(doc);
    expect(JSON.parse(text)).toEqual(JSON.parse(source));
    expect(parseCanvas(text).doc).toEqual(doc);
  });

  it('числа приводятся, нет размера — размер по умолчанию', () => {
    const { doc, dropped } = parseCanvas(JSON.stringify({
      nodes: [
        {
          id: 1, type: 'text', x: '12.5', y: '-7', width: '300', height: 80,
        },
        {
          id: 'b', type: 'text', x: 'abc', y: undefined, width: 0, height: -5,
        },
        { id: 'c', type: 'file', file: 'Заметка' },
      ],
      edges: [{ id: 7, fromNode: 1, toNode: 'b' }],
    }));
    expect(dropped).toEqual({ nodes: 0, edges: 0 });
    expect(doc.nodes[0]).toEqual({
      id: '1', type: 'text', x: 12.5, y: -7, width: 300, height: 80,
    });
    expect(doc.nodes[1]).toMatchObject({
      x: 0, y: 0, width: CANVAS_DEFAULT_NODE_WIDTH, height: CANVAS_DEFAULT_NODE_HEIGHT,
    });
    expect(doc.nodes[2]).toMatchObject({
      x: 0, y: 0, width: CANVAS_DEFAULT_NODE_WIDTH, height: CANVAS_DEFAULT_NODE_HEIGHT, file: 'Заметка',
    });
    expect(doc.edges).toEqual([{ id: '7', fromNode: '1', toNode: 'b' }]);
  });

  it('узлы без id или типа и связи без концов выбрасываются и считаются', () => {
    const { doc, error, dropped } = parseCanvas(JSON.stringify({
      nodes: [
        { type: 'text', x: 0, y: 0 },
        { id: 'x', x: 0, y: 0 },
        { id: '', type: 'text' },
        'строка',
        undefined,
        { id: 'ok', type: 'text' },
        { id: 'ok', type: 'group' },
      ],
      edges: [
        { id: 'e1', fromNode: 'ok' },
        { fromNode: 'ok', toNode: 'ok' },
        42,
        { id: 'e2', fromNode: 'ok', toNode: 'нет такого' },
        { id: 'e2', fromNode: 'ok', toNode: 'ok' },
      ],
    }));
    expect(error).toBeUndefined();
    expect(dropped).toEqual({ nodes: 6, edges: 4 });
    expect(doc.nodes.map((node) => [node.id, node.type])).toEqual([['ok', 'text']]);
    // связь на отсутствующий узел остаётся в файле: рисовать её нечем, но и терять нельзя
    expect(doc.edges).toEqual([{ id: 'e2', fromNode: 'ok', toNode: 'нет такого' }]);
  });

  it('битый JSON и не-объект — пустой документ с ошибкой', () => {
    expect(parseCanvas('{"nodes":[')).toEqual({
      doc: { nodes: [], edges: [] }, error: 'json', dropped: { nodes: 0, edges: 0 },
    });
    expect(parseCanvas('не json').error).toBe('json');
    ['[]', '42', '"текст"', 'null', '{"nodes":{}}', '{"nodes":[],"edges":"нет"}'].forEach((text) => {
      const result = parseCanvas(text);
      expect(result.error).toBe('shape');
      expect(result.doc).toEqual(createEmptyCanvas());
    });
  });

  it('пустой файл и {} — новый пустой холст без ошибки; одного массива достаточно', () => {
    ['', '  \n', '{}'].forEach((text) => {
      expect(parseCanvas(text)).toEqual({ doc: { nodes: [], edges: [] }, dropped: { nodes: 0, edges: 0 } });
    });
    const { doc, error } = parseCanvas('{"nodes":[{"id":"a","type":"text","x":1,"y":2,"width":3,"height":4}]}');
    expect(error).toBeUndefined();
    expect(doc.nodes).toHaveLength(1);
    expect(doc.edges).toEqual([]);
  });
});

describe('холст: запись', () => {
  it('порядок ключей постоянный и не зависит от порядка полей в объекте', () => {
    const doc: CanvasDoc = {
      extra: { zeta: 1, alpha: 2 },
      edges: [{
        label: 'подпись', toNode: 'b', zzz: 1, id: 'e', color: '1', fromNode: 'a', toSide: 'left', fromSide: 'right',
      }],
      nodes: [{
        label: 'л', zeta: true, text: 'т', height: 4, color: '2', width: 3, alpha: 'x', y: 2, x: 1, type: 'text',
        id: 'a',
      }],
    };
    expect(serializeCanvas(doc)).toBe([
      '{',
      '\t"nodes": [',
      '\t\t{',
      '\t\t\t"id": "a",',
      '\t\t\t"type": "text",',
      '\t\t\t"x": 1,',
      '\t\t\t"y": 2,',
      '\t\t\t"width": 3,',
      '\t\t\t"height": 4,',
      '\t\t\t"color": "2",',
      '\t\t\t"text": "т",',
      '\t\t\t"label": "л",',
      '\t\t\t"alpha": "x",',
      '\t\t\t"zeta": true',
      '\t\t}',
      '\t],',
      '\t"edges": [',
      '\t\t{',
      '\t\t\t"id": "e",',
      '\t\t\t"fromNode": "a",',
      '\t\t\t"fromSide": "right",',
      '\t\t\t"toNode": "b",',
      '\t\t\t"toSide": "left",',
      '\t\t\t"color": "1",',
      '\t\t\t"label": "подпись",',
      '\t\t\t"zzz": 1',
      '\t\t}',
      '\t],',
      '\t"alpha": 2,',
      '\t"zeta": 1',
      '}',
    ].join('\n'));
  });

  it('повторная запись не меняет текст', () => {
    const first = serializeCanvas(sample());
    const second = serializeCanvas(parseCanvas(first).doc);
    expect(second).toBe(first);
    expect(JSON.parse(first)).toEqual(JSON.parse(SAMPLE));
    // правка и её отмена возвращают тот же текст
    const moved = moveNode(moveNode(sample(), 'deadbeefdeadbeef', 15, -5), 'deadbeefdeadbeef', -15, 5);
    expect(serializeCanvas(moved)).toBe(first);
  });

  it('пустой холст и поля со значением undefined', () => {
    expect(serializeCanvas(createEmptyCanvas())).toBe('{\n\t"nodes": [],\n\t"edges": []\n}');
    const doc: CanvasDoc = {
      nodes: [{ ...rect('a', 0, 0, 1, 1), color: undefined }], edges: [], extra: { nodes: 'чужое' },
    };
    expect(JSON.parse(serializeCanvas(doc))).toEqual({ nodes: [rect('a', 0, 0, 1, 1)], edges: [] });
  });
});

describe('холст: правки', () => {
  it('ни одна правка не меняет исходный документ', () => {
    const doc = grouped();
    const snapshot = JSON.stringify(doc);
    addNode(doc, rect('new', 1, 1, 1, 1));
    updateNode(doc, 'a', { color: '1' });
    removeNode(doc, 'b');
    addEdge(doc, 'a', 'd', 'x');
    updateEdge(doc, 'e1', { label: 'y' });
    removeEdge(doc, 'e1');
    moveNode(doc, 'g', 10, 10);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('addNode: в конец списка; занятый или пустой id — документ прежний', () => {
    const doc = grouped();
    const next = addNode(doc, { ...rect('new', 5, 6, 7, 8), text: 'привет', color: undefined });
    expect(next.nodes).toHaveLength(7);
    expect(next.nodes[6]).toEqual({ ...rect('new', 5, 6, 7, 8), text: 'привет' });
    expect('color' in next.nodes[6]).toBe(false);
    expect(next.edges).toBe(doc.edges);
    expect(addNode(doc, rect('a', 0, 0, 1, 1))).toBe(doc);
    expect(addNode(doc, rect('', 0, 0, 1, 1))).toBe(doc);
  });

  it('updateNode: правит поля, undefined убирает поле, id не меняется', () => {
    const doc = updateNode(grouped(), 'a', { text: 'новый', color: '4', custom: 1 });
    expect(findNode(doc, 'a')).toEqual({
      ...rect('a', 0, 0, 100, 50), text: 'новый', color: '4', custom: 1,
    });
    const cleared = updateNode(doc, 'a', { color: undefined, id: 'другой' });
    expect(findNode(cleared, 'a')).toEqual({ ...rect('a', 0, 0, 100, 50), text: 'новый', custom: 1 });
    expect(findNode(cleared, 'другой')).toBeUndefined();
    const same = grouped();
    expect(updateNode(same, 'нет', { text: 'x' })).toBe(same);
  });

  it('removeNode: убирает узел и все его связи', () => {
    const doc = removeNode(grouped(), 'b');
    expect(doc.nodes.map((node) => node.id)).toEqual(['g', 'a', 'g2', 'c', 'd']);
    expect(doc.edges.map((edge) => edge.id)).toEqual(['e3']);
    // удаление группы не трогает содержимое
    expect(removeNode(grouped(), 'g').nodes.map((node) => node.id)).toEqual(['a', 'g2', 'b', 'c', 'd']);
    const same = grouped();
    expect(removeNode(same, 'нет')).toBe(same);
  });

  it('addEdge: новая стрелка с подписью; без дублей, петель и несуществующих узлов', () => {
    const doc = grouped();
    const next = addEdge(doc, 'a', 'd', 'зависит', () => 'new-edge');
    expect(next.edges[3]).toEqual({
      id: 'new-edge', fromNode: 'a', toNode: 'd', label: 'зависит',
    });
    expect(addEdge(doc, 'a', 'c', undefined, () => 'x').edges[3]).toEqual({ id: 'x', fromNode: 'a', toNode: 'c' });
    expect(addEdge(doc, 'a', 'c', '', () => 'x').edges[3]).toEqual({ id: 'x', fromNode: 'a', toNode: 'c' });

    expect(addEdge(doc, 'a', 'b', 'дубль')).toBe(doc);
    expect(addEdge(doc, 'a', 'a')).toBe(doc);
    expect(addEdge(doc, 'a', 'нет')).toBe(doc);
    expect(addEdge(doc, 'нет', 'a')).toBe(doc);
    // обратная стрелка — другая связь
    expect(addEdge(doc, 'b', 'a', undefined, () => 'back').edges).toHaveLength(4);
  });

  it('addEdge: id по умолчанию — 16 знаков; занятый id перевыбирается', () => {
    const doc = grouped();
    expect(addEdge(doc, 'a', 'd').edges[3].id).toMatch(/^[0-9a-f]{16}$/);
    expect(addEdge(doc, 'a', 'd', undefined, sequence('e1', 'e2', 'free')).edges[3].id).toBe('free');
    expect(addEdge(doc, 'a', 'd', undefined, () => 'e1')).toBe(doc);
  });

  it('updateEdge и removeEdge', () => {
    const doc = updateEdge(grouped(), 'e1', { label: 'подпись', color: '3', fromNode: 'd' });
    expect(doc.edges[0]).toEqual({
      id: 'e1', fromNode: 'a', toNode: 'b', label: 'подпись', color: '3',
    });
    expect(updateEdge(doc, 'e1', { label: '' }).edges[0]).toEqual({
      id: 'e1', fromNode: 'a', toNode: 'b', color: '3',
    });
    expect(updateEdge(doc, 'e2', { label: undefined }).edges[1]).toEqual({ id: 'e2', fromNode: 'b', toNode: 'd' });
    expect(updateEdge(doc, 'нет', { label: 'x' })).toBe(doc);

    expect(removeEdge(doc, 'e2').edges.map((edge) => edge.id)).toEqual(['e1', 'e3']);
    expect(removeEdge(doc, 'e2').nodes).toBe(doc.nodes);
    expect(removeEdge(doc, 'нет')).toBe(doc);
  });

  it('nodesInGroup: только то, что целиком внутри, включая вложенные группы', () => {
    const doc = grouped();
    expect(nodesInGroup(doc, 'g').map((node) => node.id)).toEqual(['a', 'g2', 'b']);
    expect(nodesInGroup(doc, 'g2').map((node) => node.id)).toEqual(['b']);
    expect(nodesInGroup(doc, 'a')).toEqual([]);
    expect(nodesInGroup(doc, 'нет')).toEqual([]);
  });

  it('moveNode: обычный узел едет один, координаты целые', () => {
    const doc = moveNode(grouped(), 'a', 10.4, -20.6);
    expect(findNode(doc, 'a')).toMatchObject({ x: 10, y: -21 });
    expect(doc.nodes.filter((node) => node.id !== 'a')).toEqual(grouped().nodes.filter((node) => node.id !== 'a'));
    const same = grouped();
    expect(moveNode(same, 'a', 0, 0)).toBe(same);
    expect(moveNode(same, 'нет', 5, 5)).toBe(same);
  });

  it('moveNode: группа тянет за собой всё, что внутри; пересекающее границу и внешнее остаётся', () => {
    const doc = moveNode(grouped(), 'g', 100, 50);
    const at = (id: string) => [findNode(doc, id)!.x, findNode(doc, id)!.y];
    expect(at('g')).toEqual([100, 50]);
    expect(at('a')).toEqual([100, 50]);
    expect(at('g2')).toEqual([300, 150]);
    expect(at('b')).toEqual([320, 170]);
    expect(at('c')).toEqual([350, 10]);
    expect(at('d')).toEqual([600, 600]);
    expect(doc.edges).toEqual(grouped().edges);
    // состав группы после сдвига прежний
    expect(nodesInGroup(doc, 'g').map((node) => node.id)).toEqual(['a', 'g2', 'b']);
  });

  it('moveNode: состав группы определяется на момент сдвига', () => {
    // группа наезжает на d — следующим сдвигом d всё ещё не внутри; после переноса d внутрь — едет
    const step = moveNode(grouped(), 'g', 300, 400);
    expect(nodesInGroup(step, 'g').map((node) => node.id)).toEqual(['a', 'g2', 'b', 'd']);
    const next = moveNode(step, 'g', -300, -400);
    expect(findNode(next, 'd')).toMatchObject({ x: 300, y: 200 });

    // вложенная группа двигает только своё
    const inner = moveNode(grouped(), 'g2', -50, 0);
    expect(findNode(inner, 'b')).toMatchObject({ x: 170, y: 120 });
    expect(findNode(inner, 'a')).toMatchObject({ x: 0, y: 0 });
    expect(findNode(inner, 'g')).toMatchObject({ x: 0, y: 0 });
  });
});

describe('холст: геометрия', () => {
  it('boundsOf: охватывающий прямоугольник', () => {
    expect(boundsOf(createEmptyCanvas())).toBeUndefined();
    expect(boundsOf(grouped())).toEqual({
      x: 0, y: 0, width: 700, height: 650,
    });
    expect(boundsOf(sample())).toEqual({
      x: -40, y: -60, width: 1060, height: 520,
    });
  });

  it('fitView: содержимое по центру, масштаб по тесной стороне', () => {
    const bounds = {
      x: 100, y: 200, width: 1000, height: 500,
    };
    const view = fitView(bounds, { width: 580, height: 800 }, 40);
    expect(view.scale).toBeCloseTo(0.5);
    // центр содержимого (600, 450) попадает в центр окна (290, 400)
    expect(600 * view.scale + view.x).toBeCloseTo(290);
    expect(450 * view.scale + view.y).toBeCloseTo(400);
    // края содержимого — ровно на полях
    expect(100 * view.scale + view.x).toBeCloseTo(40);
    expect(1100 * view.scale + view.x).toBeCloseTo(540);

    const tall = fitView({
      x: 0, y: 0, width: 100, height: 2000,
    }, { width: 1000, height: 500 }, 50);
    expect(tall.scale).toBeCloseTo(0.2);
    expect(tall.y).toBeCloseTo(50);
    expect(2000 * tall.scale + tall.y).toBeCloseTo(450);
  });

  it('fitView: пределы масштаба, пустой холст, поля по умолчанию', () => {
    const viewport = { width: 1000, height: 800 };
    const small = fitView({
      x: 0, y: 0, width: 10, height: 10,
    }, viewport);
    expect(small.scale).toBe(CANVAS_FIT_MAX_SCALE);
    expect(5 * small.scale + small.x).toBeCloseTo(500);

    const huge = fitView({
      x: 0, y: 0, width: 1_000_000, height: 10,
    }, viewport);
    expect(huge.scale).toBe(CANVAS_MIN_SCALE);

    const point = fitView({
      x: 30, y: 40, width: 0, height: 0,
    }, viewport);
    expect(point).toEqual({ scale: CANVAS_FIT_MAX_SCALE, x: 500 - 30 * 1.2, y: 400 - 40 * 1.2 });

    expect(fitView(undefined, viewport)).toEqual({ scale: 1, x: 500, y: 400 });

    const padded = fitView({
      x: 0, y: 0, width: 920, height: 100,
    }, viewport);
    expect(padded.scale).toBeCloseTo(1);
    expect(padded.x).toBeCloseTo(40);

    // окно меньше полей — масштаб не уходит в ноль и не становится отрицательным
    expect(fitView({
      x: 0, y: 0, width: 100, height: 100,
    }, { width: 20, height: 20 }).scale).toBe(CANVAS_MIN_SCALE);
    expect(clampCanvasScale(10)).toBe(CANVAS_MAX_SCALE);
    expect(clampCanvasScale(0)).toBe(CANVAS_MIN_SCALE);
  });

  it('firstGroupView: телефон открывает первую группу крупно', () => {
    const phone = { width: 390, height: 700 };
    const view = firstGroupView(sample(), phone);
    // группа 640×420 от (-40, -60): ширина 310 на 640
    expect(view.scale).toBeCloseTo(310 / 640);
    expect(-40 * view.scale + view.x).toBeCloseTo(40);
    expect((-60 + 210) * view.scale + view.y).toBeCloseTo(350);
    expect(view.scale).toBeGreaterThan(fitView(boundsOf(sample()), phone).scale);
    expect(firstGroupView(sample(), phone, 0).scale).toBeCloseTo(390 / 640);
  });

  it('firstGroupView: без групп — весь холст, пустой холст — вид по умолчанию', () => {
    const viewport = { width: 800, height: 600 };
    const doc: CanvasDoc = { nodes: [rect('a', 0, 0, 100, 100), rect('b', 900, 0, 100, 100)], edges: [] };
    expect(firstGroupView(doc, viewport)).toEqual(fitView(boundsOf(doc), viewport));
    expect(firstGroupView(createEmptyCanvas(), viewport)).toEqual({ scale: 1, x: 400, y: 300 });
  });

  it('sidePoint: середины сторон', () => {
    const box = rect('a', 10, 20, 100, 40);
    expect(sidePoint(box, 'top')).toEqual({ x: 60, y: 20 });
    expect(sidePoint(box, 'bottom')).toEqual({ x: 60, y: 60 });
    expect(sidePoint(box, 'left')).toEqual({ x: 10, y: 40 });
    expect(sidePoint(box, 'right')).toEqual({ x: 110, y: 40 });
  });

  it('edgeAnchors: стороны по взаимному положению', () => {
    const a = rect('a', 0, 0, 100, 50);
    expect(edgeAnchors(a, rect('b', 300, 0, 100, 50))).toEqual({
      from: { x: 100, y: 25, side: 'right' },
      to: { x: 300, y: 25, side: 'left' },
    });
    expect(edgeAnchors(a, rect('b', -300, 10, 100, 50))).toMatchObject({
      from: { x: 0, y: 25, side: 'left' },
      to: { x: -200, y: 35, side: 'right' },
    });
    expect(edgeAnchors(a, rect('b', 0, 200, 100, 50))).toEqual({
      from: { x: 50, y: 50, side: 'bottom' },
      to: { x: 50, y: 200, side: 'top' },
    });
    expect(edgeAnchors(a, rect('b', 20, -200, 100, 50))).toMatchObject({
      from: { side: 'top' }, to: { side: 'bottom' },
    });
    // широкая карточка: сосед по диагонали ниже диагонали прямоугольника — выход вниз
    const wide = rect('w', 0, 0, 400, 40);
    expect(edgeAnchors(wide, rect('b', 250, 300, 100, 40)).from.side).toBe('bottom');
    expect(edgeAnchors(wide, rect('b', 900, 60, 100, 40)).from.side).toBe('right');
  });

  it('edgeAnchors: стороны из связи важнее положения; совпавшие узлы не ломают расчёт', () => {
    const a = rect('a', 0, 0, 100, 50);
    const b = rect('b', 300, 0, 100, 50);
    expect(edgeAnchors(a, b, { fromSide: 'top', toSide: 'bottom' })).toEqual({
      from: { x: 50, y: 0, side: 'top' },
      to: { x: 350, y: 50, side: 'bottom' },
    });
    expect(edgeAnchors(a, b, { toSide: 'top' })).toMatchObject({ from: { side: 'right' }, to: { side: 'top' } });
    expect(edgeAnchors(a, b, sample().edges[0])).toMatchObject({ from: { side: 'right' }, to: { side: 'left' } });
    expect(edgeAnchors(a, b, { fromSide: 'вбок' as never }).from.side).toBe('right');

    const same = edgeAnchors(a, a);
    expect(Number.isFinite(same.from.x + same.from.y + same.to.x + same.to.y)).toBe(true);
  });
});

describe('холст: идентификаторы и проверки значений', () => {
  it('newCanvasId: 16 шестнадцатеричных знаков, генератор подставляется', () => {
    expect(newCanvasId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newCanvasId()).not.toBe(newCanvasId());
    expect(newCanvasId(() => 0)).toBe('0000000000000000');
    expect(newCanvasId(() => 0.999999)).toBe('ffffffffffffffff');
    expect(newCanvasId(() => 1)).toBe('ffffffffffffffff');
    let step = 0;
    expect(newCanvasId(() => (step++ % 16) / 16)).toBe('0123456789abcdef');
  });

  it('известные типы узлов и цвета палитры', () => {
    expect(['text', 'file', 'group', 'link'].every(isCanvasNodeType)).toBe(true);
    expect(isCanvasNodeType('mindmap')).toBe(false);
    expect(isCanvasPresetColor('1') && isCanvasPresetColor('6')).toBe(true);
    expect(isCanvasPresetColor('7')).toBe(false);
    expect(isCanvasPresetColor('#ff0000')).toBe(false);
    expect(isCanvasPresetColor(undefined)).toBe(false);
  });
});

describe('холст: адрес карточки-ссылки', () => {
  it('негодный адрес из файла отбрасывается, http(s) остаётся', () => {
    const text = JSON.stringify({
      nodes: [
        { id: 'a', type: 'link', url: 'javascript:alert(1)' },
        { id: 'b', type: 'link', url: 'https://example.org/x' },
      ],
    });
    const { nodes } = parseCanvas(text).doc;
    expect(nodes[0].url).toBeUndefined();
    expect(nodes[1].url).toBe('https://example.org/x');
  });

  it('границы сотен тысяч прямоугольников считаются без RangeError', () => {
    const nodes = Array.from({ length: 300000 }, (_, i) => ({
      id: String(i), type: 'text', x: i, y: 0, width: 5, height: 5,
    }));
    expect(() => boundsOf({ nodes, edges: [] })).not.toThrow();
  });
});
