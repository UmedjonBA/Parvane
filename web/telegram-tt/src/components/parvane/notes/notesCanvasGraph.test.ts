import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasEdge, CanvasNode } from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { parseCanvas, serializeCanvas } from './notesCanvas';
import {
  canvasFromGraph, freeCanvasTitle, GRAPH_CANVAS_CARD_HEIGHT, GRAPH_CANVAS_GAP, GRAPH_EDGE_PREFIX,
  GRAPH_NOTE_FIELD, isCustomizedEdge, isGraphEdge, refreshCanvasFromGraph, renameCanvasNote,
} from './notesCanvasGraph';

function note(title: string, links: string[] = [], extra: Partial<GraphNoteInput> = {}): GraphNoteInput {
  return {
    id: `id-${title}`, title, folder: '', links, ...extra,
  };
}

function counter() {
  let n = 0;
  return () => (++n).toString(16).padStart(16, '0');
}

function overlaps(doc: CanvasDoc, gap = 0) {
  let count = 0;
  doc.nodes.forEach((a, i) => doc.nodes.slice(i + 1).forEach((b) => {
    const isApartX = a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x;
    const isApartY = a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y;
    if (!isApartX && !isApartY) count++;
  }));
  return count;
}

function edgeTitles(doc: CanvasDoc) {
  const fileOf = (id: string) => doc.nodes.find((node) => node.id === id)!.file;
  return doc.edges.map((edge) => `${fileOf(edge.fromNode)} → ${fileOf(edge.toNode)}`);
}

describe('canvasFromGraph', () => {
  it('пустой список заметок — пустой холст', () => {
    expect(canvasFromGraph([])).toEqual({ nodes: [], edges: [] });
  });

  it('карточка на каждую заметку в порядке входа, стрелка на каждую ссылку', () => {
    const doc = canvasFromGraph([
      note('Сервер', ['Курс', 'Блок питания']),
      note('Курс', ['Сервер']),
      note('Блок питания'),
      note('Одна'),
    ], { makeId: counter() });

    expect(doc.nodes.map((node) => [node.type, node.file])).toEqual([
      ['file', 'Сервер.md'], ['file', 'Курс.md'], ['file', 'Блок питания.md'], ['file', 'Одна.md'],
    ]);
    expect(edgeTitles(doc)).toEqual([
      'Сервер.md → Курс.md', 'Сервер.md → Блок питания.md', 'Курс.md → Сервер.md',
    ]);
  });

  it('ссылки на несуществующую заметку, на себя и повторные стрелок не дают; регистр названия не важен', () => {
    const doc = canvasFromGraph([
      note('A', ['b', 'B', ' b ', 'A', 'Нет такой']),
      note('B'),
    ], { makeId: counter() });

    expect(doc.nodes.length).toBe(2);
    expect(edgeTitles(doc)).toEqual(['A.md → B.md']);
  });

  it('ежедневные заметки тоже получают карточки, одноимённые — по карточке, ссылка ведёт к первой', () => {
    const doc = canvasFromGraph([
      note('2026-10-12', ['План'], { isDaily: true }),
      note('План', [], { id: 'first' }),
      note('План', [], { id: 'second', folder: 'Архив' }),
      note('План', [], { id: 'first' }),
    ], { makeId: counter() });

    expect(doc.nodes.length).toBe(3);
    expect(doc.edges.length).toBe(1);
    expect(doc.edges[0].toNode).toBe(doc.nodes[1].id);
  });

  it('карточки настоящего размера не накладываются и стоят с просветом', () => {
    const titles = Array.from({ length: 40 }, (_, i) => `Заметка ${i}`);
    // Звезда, цепочка, плотный клубок и одиночки
    const notes = titles.map((title, i) => note(title, [
      ...(i < 12 ? ['Заметка 0'] : []),
      ...(i >= 12 && i < 24 ? [titles[i - 1]] : []),
      ...(i >= 24 && i < 32 ? titles.slice(24, 32) : []),
    ]));
    const doc = canvasFromGraph(notes, { makeId: counter() });

    expect(doc.nodes.length).toBe(40);
    expect(doc.nodes.every((node) => node.width === 250 && node.height === GRAPH_CANVAS_CARD_HEIGHT)).toBe(true);
    expect(overlaps(doc)).toBe(0);
    // Округление координат может съесть не больше пикселя просвета
    expect(overlaps(doc, GRAPH_CANVAS_GAP - 2)).toBe(0);
    expect(Math.min(...doc.nodes.map(({ x }) => x))).toBe(0);
    expect(Math.min(...doc.nodes.map(({ y }) => y))).toBe(0);
  });

  it('заметки без единой ссылки тоже расходятся', () => {
    const doc = canvasFromGraph(Array.from({ length: 9 }, (_, i) => note(`N${i}`)), { makeId: counter() });
    expect(overlaps(doc)).toBe(0);
  });

  it('свой размер карточки и просвет учитываются', () => {
    const doc = canvasFromGraph([note('A', ['B']), note('B', ['C']), note('C')], {
      cardWidth: 400, cardHeight: 300, gap: 100, makeId: counter(),
    });
    expect(doc.nodes.every((node) => node.width === 400 && node.height === 300)).toBe(true);
    expect(overlaps(doc, 98)).toBe(0);
  });

  it('один вход и одно зерно — один результат; идентификаторы не повторяются', () => {
    const notes = [note('A', ['B', 'C']), note('B', ['C']), note('C', ['A'])];
    const first = canvasFromGraph(notes, { makeId: counter() });
    expect(canvasFromGraph(notes, { makeId: counter() })).toEqual(first);
    const ids = [...first.nodes, ...first.edges].map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    // Генератор, выдающий одно и то же, не ломает холст
    const stuck = canvasFromGraph(notes, { makeId: () => 'same' });
    const stuckIds = [...stuck.nodes, ...stuck.edges].map(({ id }) => id);
    expect(new Set(stuckIds).size).toBe(stuckIds.length);
  });

  it('результат — обычный файл JSON Canvas: запись и разбор ничего не теряют', () => {
    const doc = canvasFromGraph([note('A', ['B']), note('B')], { makeId: counter() });
    const parsed = parseCanvas(serializeCanvas(doc));
    expect(parsed.error).toBeUndefined();
    expect(parsed.dropped).toEqual({ nodes: 0, edges: 0 });
    expect(parsed.doc).toEqual(doc);
  });
});

describe('freeCanvasTitle', () => {
  it('свободное название остаётся как есть', () => {
    expect(freeCanvasTitle('Граф связей', ['Холст 1'])).toBe('Граф связей');
  });

  it('занятое получает следующий свободный номер, регистр не важен', () => {
    expect(freeCanvasTitle('Граф связей', ['граф связей'])).toBe('Граф связей 2');
    expect(freeCanvasTitle('Граф связей', ['Граф связей', 'Граф связей 2', 'Граф связей 4'])).toBe('Граф связей 3');
  });
});

describe('refreshCanvasFromGraph', () => {
  const CARD = { width: 250, height: GRAPH_CANVAS_CARD_HEIGHT };
  const card = (title: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
    id: `card-${title}`, type: 'file', x, y, ...CARD, file: `${title}.md`, ...extra,
  });
  const fileOf = (doc: CanvasDoc, id: string) => doc.nodes.find((node) => node.id === id)?.file;
  const filesOf = (doc: CanvasDoc, ids: string[]) => ids.map((id) => fileOf(doc, id));

  it('холст из графа и те же заметки — менять нечего, документ тот же', () => {
    const notes = [note('A', ['B']), note('B', ['C']), note('C'), note('2026-10-12', ['A'], { isDaily: true })];
    const doc = canvasFromGraph(notes, { makeId: counter() });
    const result = refreshCanvasFromGraph(doc, notes, { makeId: counter() });
    expect(result.doc).toBe(doc);
    expect(result).toMatchObject({
      added: { cards: [], edges: [] }, removed: { edges: [] }, renamed: { cards: [] }, missing: { cards: [] },
    });
  });

  it('стрелки холста из графа узнаются по началу идентификатора, карточки несут идентификатор заметки', () => {
    const doc = canvasFromGraph([note('A', ['B']), note('B')], { makeId: counter() });
    expect(doc.edges.every(isGraphEdge)).toBe(true);
    expect(doc.edges[0].id.startsWith(GRAPH_EDGE_PREFIX)).toBe(true);
    expect(doc.nodes.map((node) => node[GRAPH_NOTE_FIELD])).toEqual(['id-A', 'id-B']);
    expect(doc.nodes.some(({ id }) => id.startsWith(GRAPH_EDGE_PREFIX))).toBe(false);
  });

  it('сделанное руками не трогается: узлы те же объекты в том же порядке, свои стрелки на месте', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'g', type: 'group', x: -40, y: -60, width: 700, height: 400, label: 'Железо', color: '4' },
        card('A', 0, 0, { color: '2', width: 320, height: 200 }),
        { id: 't', type: 'text', x: 360, y: 0, width: 250, height: 60, text: 'Своя пометка' },
        { id: 'l', type: 'link', x: 0, y: 500, width: 300, height: 160, url: 'https://example.org' },
        { id: 'f', type: 'file', x: 400, y: 500, ...CARD, file: 'Фото/схема.png' },
        { id: 'x', type: 'future', x: 900, y: 0, width: 100, height: 100, custom: { a: 1 } },
      ],
      edges: [{ id: 'mine', fromNode: 't', toNode: 'card-A', label: 'см.' }],
      extra: { version: 2 },
    };
    const result = refreshCanvasFromGraph(doc, [note('A', ['B']), note('B')], { makeId: counter() });

    expect(result.doc.nodes.slice(0, doc.nodes.length)).toEqual(doc.nodes);
    doc.nodes.forEach((node, i) => expect(result.doc.nodes[i]).toBe(node));
    expect(result.doc.edges[0]).toBe(doc.edges[0]);
    expect(result.doc.extra).toEqual({ version: 2 });
    expect(filesOf(result.doc, result.added.cards)).toEqual(['B.md']);
    expect(result.added.edges.length).toBe(1);
    expect(result.doc.nodes.length).toBe(doc.nodes.length + 1);
    expect(overlaps({ ...result.doc, nodes: result.doc.nodes.slice(1) })).toBe(0);
    // Новая карточка — обычного размера холста из графа и поверх остальных
    const added = result.doc.nodes[result.doc.nodes.length - 1];
    expect([added.width, added.height, added[GRAPH_NOTE_FIELD]]).toEqual([250, GRAPH_CANVAS_CARD_HEIGHT, 'id-B']);
    // И не внутри группы
    const group = doc.nodes[0];
    expect(added.x >= group.x + group.width || added.x + added.width <= group.x
      || added.y >= group.y + group.height || added.y + added.height <= group.y).toBe(true);
  });

  it('новая карточка встаёт рядом со связанной и не задевает ни одного узла, включая группы', () => {
    const doc: CanvasDoc = {
      nodes: [
        card('A', 0, 0),
        // Вокруг занято: текст снизу, группа справа, карточка сверху
        { id: 't', type: 'text', x: 0, y: 200, width: 250, height: 60, text: 'занято' },
        { id: 'g', type: 'group', x: 300, y: -100, width: 400, height: 400 },
        card('C', 0, -200),
      ],
      edges: [],
    };
    const notes = [note('A', ['B']), note('B'), note('C')];
    const result = refreshCanvasFromGraph(doc, notes, { makeId: counter() });

    expect(filesOf(result.doc, result.added.cards)).toEqual(['B.md']);
    expect(overlaps(result.doc)).toBe(0);
    // С просветом в половину обычного
    expect(overlaps(result.doc, GRAPH_CANVAS_GAP / 2 - 1)).toBe(0);
    const added = result.doc.nodes.find(({ id }) => id === result.added.cards[0])!;
    // Свободно только слева: там она и стоит, рядом со связанной карточкой
    expect([added.x, added.y]).toEqual([-320, 0]);
    expect(refreshCanvasFromGraph(doc, notes, { makeId: counter() })).toEqual(result);
  });

  it('свободное место ищется наружу: сначала под связанной карточкой, затем дальше', () => {
    const alone = refreshCanvasFromGraph({ nodes: [card('A', 0, 0)], edges: [] }, [note('A'), note('B', ['A'])], {
      makeId: counter(),
    });
    const first = alone.doc.nodes[1];
    expect([first.x, first.y]).toEqual([0, 200]);
    // Несколько новых у одной карточки не накладываются друг на друга
    const many = refreshCanvasFromGraph(
      { nodes: [card('A', 0, 0)], edges: [] },
      [note('A'), ...Array.from({ length: 12 }, (_, i) => note(`N${i}`, ['A']))],
      { makeId: counter() },
    );
    expect(many.added.cards.length).toBe(12);
    expect(many.added.edges.length).toBe(12);
    expect(overlaps(many.doc, GRAPH_CANVAS_GAP / 2 - 1)).toBe(0);
    expect(many.doc.nodes[0]).toEqual(card('A', 0, 0));
  });

  it('заметка между двумя связанными встаёт у середины их рамки', () => {
    const result = refreshCanvasFromGraph(
      { nodes: [card('A', 0, 0), card('C', 800, 0)], edges: [] },
      [note('A', ['B']), note('B', ['C']), note('C')],
      { makeId: counter() },
    );
    const added = result.doc.nodes[2];
    expect([added.x, added.y]).toEqual([400, 0]);
    expect(edgeTitles(result.doc)).toEqual(['A.md → B.md', 'B.md → C.md']);
  });

  it('новая заметка, связанная только с другой новой, встаёт рядом с ней', () => {
    const result = refreshCanvasFromGraph(
      { nodes: [card('A', 0, 0)], edges: [] },
      // «Дальняя» идёт раньше своей опоры и ждёт следующего прохода
      [note('Дальняя', ['Ближняя']), note('A'), note('Ближняя', ['A'])],
      { makeId: counter() },
    );
    expect(filesOf(result.doc, result.added.cards)).toEqual(['Ближняя.md', 'Дальняя.md']);
    const [, near, far] = result.doc.nodes;
    expect(Math.abs(far.x - near.x) + Math.abs(far.y - near.y)).toBeLessThanOrEqual(520);
    expect(overlaps(result.doc, GRAPH_CANVAS_GAP / 2 - 1)).toBe(0);
  });

  it('несвязанные заметки — ровным блоком справа от холста, у широкого холста — под ним', () => {
    const lonely = Array.from({ length: 5 }, (_, i) => note(`Одна ${i}`));
    const tall: CanvasDoc = {
      nodes: [card('A', 0, 0), { id: 'g', type: 'group', x: -100, y: -100, width: 500, height: 900 }],
      edges: [],
    };
    const right = refreshCanvasFromGraph(tall, [note('A'), ...lonely], { makeId: counter() });
    // Столбец в высоту холста: четыре карточки, пятая — в следующем столбце
    expect(right.doc.nodes.slice(2).map(({ x, y }) => [x, y])).toEqual([
      [520, -100], [520, 100], [520, 300], [520, 500], [830, -100],
    ]);
    expect(right.added.edges).toEqual([]);
    expect(overlaps(right.doc)).toBe(1); // только карточка A внутри своей группы

    const wide: CanvasDoc = { nodes: [card('A', 0, 0), card('C', 1500, 0)], edges: [] };
    const below = refreshCanvasFromGraph(wide, [note('A'), note('C'), ...lonely], { makeId: counter() });
    expect(below.doc.nodes.slice(2).map(({ x, y }) => [x, y])).toEqual([
      [0, 260], [310, 260], [620, 260], [930, 260], [1240, 260],
    ]);
    expect(overlaps(below.doc)).toBe(0);
  });

  it('ежедневные заметки получают карточки, как на холсте из графа', () => {
    const result = refreshCanvasFromGraph(
      { nodes: [card('A', 0, 0)], edges: [] },
      [note('A'), note('2026-10-12', ['A'], { isDaily: true })],
      { makeId: counter() },
    );
    expect(filesOf(result.doc, result.added.cards)).toEqual(['2026-10-12.md']);
    expect(edgeTitles(result.doc)).toEqual(['2026-10-12.md → A.md']);
  });

  it('стрелка на ссылку ставится, только если между карточками её ещё нет в эту сторону', () => {
    const doc: CanvasDoc = {
      nodes: [card('A', 0, 0), card('B', 400, 0), card('C', 800, 0)],
      // Нарисованная руками A → B и обратная C → A
      edges: [
        { id: 'mine', fromNode: 'card-A', toNode: 'card-B' }, { id: 'back', fromNode: 'card-C', toNode: 'card-A' },
      ],
    };
    const result = refreshCanvasFromGraph(
      doc, [note('A', ['B', 'C', 'a', 'Нет такой']), note('B'), note('C')], { makeId: counter() },
    );
    expect(result.added.cards).toEqual([]);
    expect(edgeTitles(result.doc)).toEqual(['A.md → B.md', 'C.md → A.md', 'A.md → C.md']);
    expect(result.added.edges.length).toBe(1);
    expect(isGraphEdge(result.doc.edges[2])).toBe(true);
    expect(result.doc.nodes).toEqual(doc.nodes);
    // Повтор ничего не добавляет
    const again = refreshCanvasFromGraph(result.doc, [note('A', ['B', 'C']), note('B'), note('C')]);
    expect(again.doc).toBe(result.doc);
  });

  it('путь карточки с папками и другим регистром — та же заметка; копия карточки второй не требует', () => {
    const doc: CanvasDoc = {
      nodes: [
        card('A', 0, 0, { file: 'Знания/Проекты/a.MD' }), card('B', 400, 0), card('B', 400, 300, { id: 'copy' }),
      ],
      edges: [{ id: 'mine', fromNode: 'card-A', toNode: 'copy' }],
    };
    const result = refreshCanvasFromGraph(doc, [note('A', ['B']), note('B')], { makeId: counter() });
    // Стрелка к копии карточки той же заметки уже есть
    expect(result.doc).toBe(doc);
  });

  it('своя стрелка исчезнувшей ссылки убирается, карточки остаются', () => {
    const notes = [note('A', ['B', 'C']), note('B'), note('C')];
    const doc = canvasFromGraph(notes, { makeId: counter() });
    const result = refreshCanvasFromGraph(doc, [note('A', ['C']), note('B'), note('C')], { makeId: counter() });

    expect(result.removed.edges).toEqual([doc.edges[0].id]);
    expect(edgeTitles(result.doc)).toEqual(['A.md → C.md']);
    expect(result.doc.nodes).toEqual(doc.nodes);
    expect(result.added).toEqual({ cards: [], edges: [] });
  });

  it('правленая своя стрелка и нарисованная руками не убираются', () => {
    const base = canvasFromGraph([note('A', ['B']), note('B')], { makeId: counter() });
    const [a, b] = base.nodes;
    const auto = base.edges[0];
    const kept: CanvasEdge[] = [
      { ...auto, id: `${GRAPH_EDGE_PREFIX}label`, label: 'ведёт' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}color`, color: '3' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}side`, fromSide: 'top' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}to-side`, toSide: 'left' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}ends`, fromEnd: 'arrow' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}no-ends`, toEnd: 'none' },
      { ...auto, id: `${GRAPH_EDGE_PREFIX}extra`, weight: 2 },
      { id: 'drawn', fromNode: a.id, toNode: b.id },
      // Стрелка холста, созданного до появления обновления: без приставки, значит своя пользователя
      { id: '00000000000000aa', fromNode: b.id, toNode: a.id },
    ];
    // Значения по умолчанию, записанные явно, правкой не считаются
    const plain: CanvasEdge = {
      ...auto, id: `${GRAPH_EDGE_PREFIX}plain`, toEnd: 'arrow', fromEnd: 'none', label: '',
    };
    const doc = { ...base, edges: [...kept, plain] };
    const result = refreshCanvasFromGraph(doc, [note('A'), note('B')], { makeId: counter() });

    expect(kept.filter((edge) => isGraphEdge(edge)).every(isCustomizedEdge)).toBe(true);
    expect(isCustomizedEdge(plain)).toBe(false);
    expect(isCustomizedEdge(auto)).toBe(false);
    expect(result.removed.edges).toEqual([plain.id]);
    expect(result.doc.edges).toEqual(kept);
  });

  it('карточка удалённой заметки остаётся вместе со своими стрелками и числится пропавшей', () => {
    const notes = [note('A', ['B']), note('B', ['A', 'C']), note('C')];
    const doc = canvasFromGraph(notes, { makeId: counter() });
    const cardB = doc.nodes[1];
    // B удалена; A по-прежнему ссылается на неё в тексте
    const result = refreshCanvasFromGraph(doc, [note('A', ['B']), note('C')], { makeId: counter() });
    expect(result.missing.cards).toEqual([cardB.id]);
    expect(result.doc).toBe(doc);

    // Ссылку на удалённую заметку убрали из текста — своя стрелка к её карточке уходит, от неё — остаются
    const cleaned = refreshCanvasFromGraph(doc, [note('A'), note('C')], { makeId: counter() });
    expect(cleaned.missing.cards).toEqual([cardB.id]);
    expect(edgeTitles(cleaned.doc)).toEqual(['B.md → A.md', 'B.md → C.md']);
    expect(cleaned.doc.nodes).toEqual(doc.nodes);
  });

  it('переименованная заметка: карточка с её идентификатором идёт за новым названием', () => {
    const doc = canvasFromGraph([note('A', ['Старое']), note('Старое')], { makeId: counter() });
    const moved = { ...doc, nodes: doc.nodes.map((node) => ({ ...node, file: `Папка/${node.file}` })) };
    const renamed = [note('A', ['Новое']), note('Новое', [], { id: 'id-Старое' })];
    const result = refreshCanvasFromGraph(moved, renamed, { makeId: counter() });

    expect(result.renamed.cards).toEqual([doc.nodes[1].id]);
    expect(result.doc.nodes[1]).toEqual({ ...moved.nodes[1], file: 'Папка/Новое.md' });
    expect(result.doc.nodes[0]).toBe(moved.nodes[0]);
    expect(result.added).toEqual({ cards: [], edges: [] });
    expect(result.removed.edges).toEqual([]);
    expect(result.missing.cards).toEqual([]);
    expect(result.doc.edges).toEqual(doc.edges);
  });

  it('карточка без идентификатора заметки после переименования остаётся пропавшей, новая получает свою', () => {
    const doc: CanvasDoc = {
      nodes: [card('A', 0, 0), card('Старое', 400, 0)],
      edges: [{ id: `${GRAPH_EDGE_PREFIX}1`, fromNode: 'card-A', toNode: 'card-Старое' }],
    };
    const result = refreshCanvasFromGraph(doc, [note('A', ['Новое']), note('Новое')], { makeId: counter() });
    expect(result.renamed.cards).toEqual([]);
    expect(result.missing.cards).toEqual(['card-Старое']);
    expect(filesOf(result.doc, result.added.cards)).toEqual(['Новое.md']);
    expect(result.removed.edges).toEqual([`${GRAPH_EDGE_PREFIX}1`]);
    expect(edgeTitles(result.doc)).toEqual(['A.md → Новое.md']);
    expect(result.doc.nodes.slice(0, 2)).toEqual(doc.nodes);
  });

  it('заметка с тем же названием, что у карточки с чужим идентификатором, карточку не уводит', () => {
    const doc: CanvasDoc = { nodes: [card('План', 0, 0, { [GRAPH_NOTE_FIELD]: 'old' })], edges: [] };
    const result = refreshCanvasFromGraph(doc, [note('План'), note('Иное', [], { id: 'old' })], {
      makeId: counter(),
    });
    expect(result.renamed.cards).toEqual([]);
    expect(result.doc.nodes[0]).toBe(doc.nodes[0]);
    expect(filesOf(result.doc, result.added.cards)).toEqual(['Иное.md']);
  });

  it('одноимённые заметки получают по карточке; заметка без названия пропускается', () => {
    const notes = [
      note('План', [], { id: 'first' }),
      note('План', [], { id: 'second', folder: 'Архив' }),
      note(' ', [], { id: 'blank' }),
    ];
    const result = refreshCanvasFromGraph({ nodes: [card('План', 0, 0)], edges: [] }, notes, { makeId: counter() });
    expect(filesOf(result.doc, result.added.cards)).toEqual(['План.md']);
    expect(result.doc.nodes[1][GRAPH_NOTE_FIELD]).toBe('second');
    expect(refreshCanvasFromGraph(result.doc, notes).doc).toBe(result.doc);
  });

  it('совсем пустой холст заполняется раскладкой графа; без заметок остаётся пустым', () => {
    const notes = [note('A', ['B']), note('B')];
    const empty: CanvasDoc = { nodes: [], edges: [], extra: { version: 1 } };
    const result = refreshCanvasFromGraph(empty, notes, { makeId: counter() });
    const built = canvasFromGraph(notes, { makeId: counter() });
    expect(result.doc).toEqual({ ...built, extra: { version: 1 } });
    expect(result.added).toEqual({ cards: built.nodes.map(({ id }) => id), edges: built.edges.map(({ id }) => id) });
    expect(refreshCanvasFromGraph(empty, []).doc).toBe(empty);
  });

  it('холст только с текстом: заметки встают блоком рядом, текст на месте', () => {
    const text: CanvasNode = {
      id: 't', type: 'text', x: 0, y: 0, width: 250, height: 60, text: 'Заголовок',
    };
    const result = refreshCanvasFromGraph(
      { nodes: [text], edges: [] }, [note('A', ['B']), note('B')], { makeId: counter() },
    );
    expect(result.doc.nodes[0]).toBe(text);
    expect(result.added.cards.length).toBe(2);
    expect(overlaps(result.doc)).toBe(0);
    expect(edgeTitles(result.doc)).toEqual(['A.md → B.md']);
  });

  it('идентификаторы не повторяются даже у залипшего генератора; файл остаётся обычным JSON Canvas', () => {
    const doc: CanvasDoc = {
      nodes: [card('A', 0, 0, { id: 'same' })],
      edges: [{ id: `${GRAPH_EDGE_PREFIX}same`, fromNode: 'same', toNode: 'same', label: 'петля' }],
    };
    const result = refreshCanvasFromGraph(doc, [note('A', ['B', 'C']), note('B', ['A']), note('C')], {
      makeId: () => 'same',
    });
    const ids = [...result.doc.nodes, ...result.doc.edges].map(({ id }) => id);
    expect(ids.length).toBe(7);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.added.edges.every((id) => id.startsWith(GRAPH_EDGE_PREFIX))).toBe(true);
    const parsed = parseCanvas(serializeCanvas(result.doc));
    expect(parsed.error).toBeUndefined();
    expect(parsed.dropped).toEqual({ nodes: 0, edges: 0 });
    expect(parsed.doc).toEqual(result.doc);
  });
});

describe('renameCanvasNote', () => {
  it('карточки заметки указывают на новое название, папки пути и остальное остаются', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'a', type: 'file', x: 0, y: 0, width: 250, height: 140, file: 'Старое.md', color: '2' },
        { id: 'b', type: 'file', x: 300, y: 0, width: 250, height: 140, file: 'Знания/старое.md' },
        { id: 'c', type: 'file', x: 600, y: 0, width: 250, height: 140, file: 'Старое.png' },
        { id: 'd', type: 'text', x: 900, y: 0, width: 250, height: 60, text: '[[Старое]]', file: 'Старое.md' },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    };
    const renamed = renameCanvasNote(doc, ' старое ', 'Новое');
    expect(renamed.nodes.map(({ file }) => file)).toEqual(['Новое.md', 'Знания/Новое.md', 'Старое.png', 'Старое.md']);
    expect(renamed.nodes[0]).toEqual({ ...doc.nodes[0], file: 'Новое.md' });
    expect(renamed.nodes[2]).toBe(doc.nodes[2]);
    expect(renamed.edges).toBe(doc.edges);
  });

  it('нет таких карточек или пустое название — прежний документ', () => {
    const doc: CanvasDoc = {
      nodes: [{ id: 'a', type: 'file', x: 0, y: 0, width: 250, height: 140, file: 'A.md' }], edges: [],
    };
    expect(renameCanvasNote(doc, 'B', 'C')).toBe(doc);
    expect(renameCanvasNote(doc, 'A', ' ')).toBe(doc);
    expect(renameCanvasNote(doc, '', 'C')).toBe(doc);
  });
});
