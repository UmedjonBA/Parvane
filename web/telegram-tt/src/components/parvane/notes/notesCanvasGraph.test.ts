import { describe, expect, it } from 'vitest';

import type { CanvasDoc, CanvasEdge, CanvasNode } from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { parseCanvas, serializeCanvas } from './notesCanvas';
import {
  canvasFromGraph, freeCanvasTitle, GRAPH_CANVAS_CARD_HEIGHT, GRAPH_CANVAS_GAP, GRAPH_EDGE_PREFIX,
  GRAPH_FOLDER_FIELD, GRAPH_GROUP_HEAD, GRAPH_NOTE_FIELD, GRAPH_SCOPE_FIELD, isCustomizedEdge, isGraphEdge,
  isInCanvasScope, refreshCanvasFromGraph, renameCanvasFolder, renameCanvasNote, scopeOfCanvas,
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

function groupsOf(doc: CanvasDoc) {
  return doc.nodes.filter(({ type }) => type === 'group');
}

function cardsOf(doc: CanvasDoc) {
  return doc.nodes.filter(({ type }) => type === 'file');
}

function contains(outer: CanvasNode, inner: CanvasNode) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

// Карточки, лежащие в группе целиком: названия файлов по алфавиту
function filesIn(doc: CanvasDoc, group: CanvasNode) {
  return cardsOf(doc).filter((node) => contains(group, node)).map(({ file }) => file).sort();
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
    // Взаимная ссылка Сервер ↔ Курс — одна стрелка с наконечниками с обеих сторон
    expect(edgeTitles(doc)).toEqual(['Сервер.md → Курс.md', 'Сервер.md → Блок питания.md']);
    expect(doc.edges.map(({ fromEnd }) => fromEnd)).toEqual(['arrow', undefined]);
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

    const cards = cardsOf(doc);
    expect(cards.length).toBe(3);
    expect(doc.edges.length).toBe(1);
    expect(doc.edges[0].toNode).toBe(cards[1].id);
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

  it('заметки папки обведены группой с её названием; заметки без папки — без группы', () => {
    const doc = canvasFromGraph([
      note('Корень', ['Сервер']),
      note('Сервер', ['Диск'], { folder: 'Железо' }),
      note('Диск', [], { folder: 'Железо' }),
      note('Рецепт', ['Корень'], { folder: 'Дом/Кухня' }),
    ], { makeId: counter() });

    const groups = groupsOf(doc);
    expect(groups.map(({ label }) => label)).toEqual(['Дом / Кухня', 'Железо']);
    expect(groups.map((group) => group[GRAPH_FOLDER_FIELD])).toEqual(['Дом/Кухня', 'Железо']);
    expect(filesIn(doc, groups[0])).toEqual(['Рецепт.md']);
    expect(filesIn(doc, groups[1])).toEqual(['Диск.md', 'Сервер.md']);
    // Группы лежат под карточками, карточки идут в порядке входа
    expect(doc.nodes.map(({ type }) => type)).toEqual(['group', 'group', 'file', 'file', 'file', 'file']);
    expect(cardsOf(doc).map(({ file }) => file)).toEqual(['Корень.md', 'Сервер.md', 'Диск.md', 'Рецепт.md']);
    // Ссылки между папками остаются стрелками
    expect(edgeTitles(doc).sort()).toEqual(['Корень.md → Сервер.md', 'Рецепт.md → Корень.md', 'Сервер.md → Диск.md']);
    // Своя подпись группы
    const named = canvasFromGraph([note('A', [], { folder: 'x/y' })], { folderLabel: (path) => `[${path}]` });
    expect(groupsOf(named)[0].label).toBe('[x/y]');
  });

  it('группы папок не наезжают ни друг на друга, ни на чужие карточки; над рамкой есть место шапке', () => {
    const folders = ['', 'Работа', 'Дом', 'Учёба', 'Архив'];
    const notes = Array.from({ length: 45 }, (_, i) => note(`Заметка ${i}`, [
      `Заметка ${(i + 5) % 45}`, `Заметка ${(i * 7) % 45}`,
    ], { folder: folders[i % folders.length] }));
    const doc = canvasFromGraph(notes, { makeId: counter() });

    const groups = groupsOf(doc);
    const cards = cardsOf(doc);
    expect(groups.length).toBe(4);
    expect(cards.length).toBe(45);
    expect(overlaps({ nodes: cards, edges: [] }, GRAPH_CANVAS_GAP - 2)).toBe(0);
    // Рамка вместе с шапкой над ней
    const withHead = groups.map((group) => ({
      ...group, y: group.y - GRAPH_GROUP_HEAD, height: group.height + GRAPH_GROUP_HEAD,
    }));
    expect(overlaps({ nodes: withHead, edges: [] }, GRAPH_CANVAS_GAP - 2)).toBe(0);
    cards.forEach((node) => {
      const folder = notes.find(({ id }) => id === node[GRAPH_NOTE_FIELD])!.folder;
      withHead.forEach((group) => {
        if (group[GRAPH_FOLDER_FIELD] === folder) expect(contains(group, node)).toBe(true);
        else expect(overlaps({ nodes: [group, node], edges: [] })).toBe(0);
      });
    });
    expect(Math.min(...doc.nodes.map(({ x }) => x))).toBe(0);
    expect(Math.min(...doc.nodes.map(({ y }) => y))).toBe(0);
    expect(canvasFromGraph(notes, { makeId: counter() })).toEqual(doc);
  });

  it('набор заметок: только выбранные папки и без заметок дней; набор записан в холст', () => {
    const notes = [
      note('Корень', ['Сервер', 'Чужая']),
      note('Сервер', ['Чужая'], { folder: 'Железо' }),
      note('Чужая', ['Корень'], { folder: 'Архив' }),
      note('2026-10-12', ['Корень'], { folder: 'Ежедневные', isDaily: true }),
    ];
    const doc = canvasFromGraph(notes, {
      scope: { folders: ['Железо', '', 'Железо'], days: false }, makeId: counter(),
    });
    expect(cardsOf(doc).map(({ file }) => file)).toEqual(['Корень.md', 'Сервер.md']);
    expect(groupsOf(doc).map(({ label }) => label)).toEqual(['Железо']);
    // Ссылки на заметки вне набора стрелок не дают
    expect(edgeTitles(doc)).toEqual(['Корень.md → Сервер.md']);
    expect(doc.extra).toEqual({ [GRAPH_SCOPE_FIELD]: { folders: ['', 'Железо'], days: false } });
    expect(scopeOfCanvas(doc)).toEqual({ folders: ['', 'Железо'], days: false });
    expect(scopeOfCanvas(parseCanvas(serializeCanvas(doc)).doc)).toEqual({ folders: ['', 'Железо'], days: false });

    // Папки выбраны, дни включены: заметок дней выбор папок не касается
    const withDays = canvasFromGraph(notes, { scope: { folders: ['Железо'] }, makeId: counter() });
    expect(cardsOf(withDays).map(({ file }) => file)).toEqual(['Сервер.md', '2026-10-12.md']);
    // Набор без ограничений в холст не пишется; пустой итог набор помнит
    expect(canvasFromGraph(notes, { scope: {} }).extra).toBeUndefined();
    expect(canvasFromGraph(notes, { scope: { days: true } }).extra).toBeUndefined();
    expect(canvasFromGraph(notes, { scope: { folders: ['Нет такой'], days: false } })).toEqual({
      nodes: [], edges: [], extra: { [GRAPH_SCOPE_FIELD]: { folders: ['Нет такой'], days: false } },
    });
  });

  it('набор заметок холста: негодная запись в файле — набора нет', () => {
    const doc = (value: unknown): CanvasDoc => ({ nodes: [], edges: [], extra: { [GRAPH_SCOPE_FIELD]: value } });
    expect(scopeOfCanvas({ nodes: [], edges: [] })).toBeUndefined();
    expect(scopeOfCanvas(doc('все'))).toBeUndefined();
    expect(scopeOfCanvas(doc({ folders: 'Железо', days: 1 }))).toBeUndefined();
    expect(scopeOfCanvas(doc({ folders: ['б', 5, 'а'] }))).toEqual({ folders: ['а', 'б'] });
    expect(isInCanvasScope({ folder: 'Архив' }, undefined)).toBe(true);
    expect(isInCanvasScope({ folder: 'Архив' }, { folders: [] })).toBe(false);
    expect(isInCanvasScope({ folder: 'Архив', isDaily: true }, { folders: [] })).toBe(true);
    expect(isInCanvasScope({ folder: 'Архив', isDaily: true }, { days: false })).toBe(false);
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

  it('новая заметка папки встаёт в группу этой папки, рамка растёт за ней; остальное не трогается', () => {
    const notes = [
      note('Корень', ['Сервер']),
      note('Сервер', ['Диск'], { folder: 'Железо' }),
      note('Диск', [], { folder: 'Железо' }),
      note('Рецепт', [], { folder: 'Кухня' }),
    ];
    const doc = canvasFromGraph(notes, { makeId: counter() });
    const more = [
      ...notes,
      note('Сеть', ['Сервер'], { folder: 'Железо' }),
      note('Питание', [], { folder: 'Железо' }),
      note('Суп', [], { folder: 'Кухня' }),
    ];
    const result = refreshCanvasFromGraph(doc, more, { makeId: counter() });

    expect(filesOf(result.doc, result.added.cards).sort()).toEqual(['Питание.md', 'Сеть.md', 'Суп.md']);
    const [hardware, kitchen] = groupsOf(result.doc);
    expect(filesIn(result.doc, hardware)).toEqual(['Диск.md', 'Питание.md', 'Сервер.md', 'Сеть.md']);
    expect(filesIn(result.doc, kitchen)).toEqual(['Рецепт.md', 'Суп.md']);
    // Группы остались на своих слоях, прежние карточки — те же объекты
    expect(result.doc.nodes.slice(0, 2).map(({ id }) => id)).toEqual(doc.nodes.slice(0, 2).map(({ id }) => id));
    doc.nodes.slice(2).forEach((node, i) => expect(result.doc.nodes[i + 2]).toBe(node));
    expect(groupsOf(result.doc).map(({ label }) => label)).toEqual(['Железо', 'Кухня']);
    // Ничего не наложилось: карточки между собой, группы (с шапкой) между собой и с чужими карточками
    const cards = cardsOf(result.doc);
    expect(overlaps({ nodes: cards, edges: [] })).toBe(0);
    const withHead = groupsOf(result.doc).map((group) => ({
      ...group, y: group.y - GRAPH_GROUP_HEAD, height: group.height + GRAPH_GROUP_HEAD,
    }));
    expect(overlaps({ nodes: withHead, edges: [] })).toBe(0);
    expect(overlaps({ nodes: [withHead[0], cards.find(({ file }) => file === 'Корень.md')!], edges: [] })).toBe(0);
    expect(edgeTitles(result.doc)).toContain('Сеть.md → Сервер.md');
    // Повторное обновление менять нечего
    expect(refreshCanvasFromGraph(result.doc, more).doc).toBe(result.doc);
  });

  it('группу папки удалили — её новая заметка встаёт как любая другая, новой группы нет', () => {
    const notes = [note('Сервер', [], { folder: 'Железо' }), note('Диск', [], { folder: 'Железо' })];
    const built = canvasFromGraph(notes, { makeId: counter() });
    const doc = { ...built, nodes: cardsOf(built) };
    const result = refreshCanvasFromGraph(doc, [...notes, note('Сеть', ['Диск'], { folder: 'Железо' })], {
      makeId: counter(),
    });
    expect(groupsOf(result.doc)).toEqual([]);
    expect(filesOf(result.doc, result.added.cards)).toEqual(['Сеть.md']);
    doc.nodes.forEach((node, i) => expect(result.doc.nodes[i]).toBe(node));
    expect(overlaps(result.doc)).toBe(0);
  });

  it('группа без пути папки (своя) и группа другой папки новую заметку не забирают', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'own', type: 'group', x: -20, y: -20, width: 290, height: 180, label: 'Железо' },
        card('Сервер', 0, 0),
        {
          id: 'other', type: 'group', x: 480, y: -20, width: 290, height: 180, [GRAPH_FOLDER_FIELD]: 'Кухня',
        },
      ],
      edges: [],
    };
    const result = refreshCanvasFromGraph(doc, [
      note('Сервер', [], { folder: 'Железо' }), note('Диск', [], { folder: 'Железо' }),
    ], { makeId: counter() });
    doc.nodes.forEach((node, i) => expect(result.doc.nodes[i]).toBe(node));
    const added = result.doc.nodes[3];
    expect(added.file).toBe('Диск.md');
    expect(overlaps({ nodes: [doc.nodes[2], added], edges: [] })).toBe(0);
  });

  it('холст с набором заметок: обновление берёт новые заметки только из набора', () => {
    const notes = [note('Сервер', [], { folder: 'Железо' }), note('Чужая', [], { folder: 'Архив' })];
    const doc = canvasFromGraph(notes, { scope: { folders: ['Железо'], days: false }, makeId: counter() });
    expect(cardsOf(doc).map(({ file }) => file)).toEqual(['Сервер.md']);
    expect(refreshCanvasFromGraph(doc, notes).doc).toBe(doc);

    const more = [
      ...notes,
      note('Диск', ['Чужая', 'Сервер'], { folder: 'Железо' }),
      note('Новая чужая', ['Сервер'], { folder: 'Архив' }),
      note('Без папки', ['Сервер']),
      note('2026-10-12', ['Сервер'], { folder: 'Ежедневные', isDaily: true }),
    ];
    const result = refreshCanvasFromGraph(doc, more, { makeId: counter() });
    expect(filesOf(result.doc, result.added.cards)).toEqual(['Диск.md']);
    expect(edgeTitles(result.doc)).toEqual(['Диск.md → Сервер.md']);
    expect(result.missing.cards).toEqual([]);
    expect(scopeOfCanvas(result.doc)).toEqual({ folders: ['Железо'], days: false });

    // Карточку заметки вне набора положили руками: она своя — не «пропавшая», стрелки по ссылкам к ней идут
    const manual: CanvasDoc = { ...result.doc, nodes: [...result.doc.nodes, card('Чужая', 2000, 2000)] };
    const again = refreshCanvasFromGraph(manual, more, { makeId: counter() });
    expect(again.added.cards).toEqual([]);
    expect(again.missing.cards).toEqual([]);
    expect(edgeTitles(again.doc)).toContain('Диск.md → Чужая.md');

    // Совсем пустой холст с набором заполняется только набором
    const empty: CanvasDoc = { nodes: [], edges: [], extra: doc.extra };
    const filled = refreshCanvasFromGraph(empty, more, { makeId: counter() });
    expect(cardsOf(filled.doc).map(({ file }) => file)).toEqual(['Сервер.md', 'Диск.md']);
    expect(filled.added.cards.length).toBe(2);
    expect(scopeOfCanvas(filled.doc)).toEqual({ folders: ['Железо'], days: false });
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

  it('встречные свои стрелки сливаются в одну двустороннюю; ответная ссылка делает стрелку двусторонней', () => {
    const base = canvasFromGraph([note('A', ['B']), note('B')], { makeId: counter() });
    const [a, b] = base.nodes;
    const doc = {
      ...base,
      edges: [...base.edges, { id: `${GRAPH_EDGE_PREFIX}back`, fromNode: b.id, toNode: a.id }],
    };
    const result = refreshCanvasFromGraph(doc, [note('A', ['B']), note('B', ['A'])], { makeId: counter() });
    expect(result.removed.edges).toEqual([`${GRAPH_EDGE_PREFIX}back`]);
    expect(result.doc.edges).toEqual([{ ...base.edges[0], fromEnd: 'arrow' }]);

    const answered = refreshCanvasFromGraph(base, [note('A', ['B']), note('B', ['A'])], { makeId: counter() });
    expect(answered.added.edges).toEqual([]);
    expect(answered.doc.edges).toEqual([{ ...base.edges[0], fromEnd: 'arrow' }]);

    // Обратную ссылку убрали — наконечник в начале снимается; убрали прямую — стрелка разворачивается
    const oneWay = refreshCanvasFromGraph(result.doc, [note('A', ['B']), note('B')], { makeId: counter() });
    expect(oneWay.doc.edges).toEqual([{ ...base.edges[0], fromEnd: undefined }]);
    const reversed = refreshCanvasFromGraph(result.doc, [note('A'), note('B', ['A'])], { makeId: counter() });
    expect(edgeTitles(reversed.doc)).toEqual(['B.md → A.md']);
    expect(reversed.doc.edges[0].fromEnd).toBeUndefined();
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
    // Наконечник в начале у своей стрелки — знак взаимной ссылки, не правка: без ссылок стрелка уходит
    const mutual: CanvasEdge = { ...auto, id: `${GRAPH_EDGE_PREFIX}mutual`, fromEnd: 'arrow' };
    const doc = { ...base, edges: [...kept, plain, mutual] };
    const result = refreshCanvasFromGraph(doc, [note('A'), note('B')], { makeId: counter() });

    expect(kept.filter((edge) => isGraphEdge(edge)).every(isCustomizedEdge)).toBe(true);
    expect(isCustomizedEdge(plain)).toBe(false);
    expect(isCustomizedEdge(auto)).toBe(false);
    expect(isCustomizedEdge(mutual)).toBe(false);
    expect(result.removed.edges).toEqual([plain.id, mutual.id]);
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
    // A, B, C, петля, A ↔ B одной стрелкой, A → C
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.added.edges.every((id) => id.startsWith(GRAPH_EDGE_PREFIX))).toBe(true);
    const parsed = parseCanvas(serializeCanvas(result.doc));
    expect(parsed.error).toBeUndefined();
    expect(parsed.dropped).toEqual({ nodes: 0, edges: 0 });
    expect(parsed.doc).toEqual(result.doc);
  });
});

describe('renameCanvasFolder', () => {
  const made = () => canvasFromGraph([
    note('A', [], { folder: 'Дом' }), note('B', [], { folder: 'Дом/Кухня' }), note('C', [], { folder: 'Домики' }),
  ], { scope: { folders: ['Дом', 'Дом/Кухня', 'Домики'] }, makeId: counter() });

  it('путь папки и подпапок меняется в наборе заметок и у групп, соседняя папка с тем же началом — нет', () => {
    const doc = renameCanvasFolder(made(), 'Дом', 'Квартира');
    expect(scopeOfCanvas(doc)?.folders).toEqual(['Домики', 'Квартира', 'Квартира/Кухня']);
    const groups = doc.nodes.filter(({ type }) => type === 'group');
    expect(groups.map((group) => group[GRAPH_FOLDER_FIELD]).sort()).toEqual(['Домики', 'Квартира', 'Квартира/Кухня']);
    expect(groups.map(({ label }) => label).sort()).toEqual(['Домики', 'Квартира', 'Квартира / Кухня']);
    // Новая заметка переименованной папки после обновления попадает в набор
    expect(isInCanvasScope({ folder: 'Квартира', isDaily: false }, scopeOfCanvas(doc))).toBe(true);
  });

  it('свою подпись группы человек сохраняет; нечего менять — прежний документ', () => {
    const base = made();
    const custom = {
      ...base,
      nodes: base.nodes.map((node) => (node[GRAPH_FOLDER_FIELD] === 'Дом' ? { ...node, label: 'Моё' } : node)),
    };
    const doc = renameCanvasFolder(custom, 'Дом', 'Квартира');
    expect(doc.nodes.find((node) => node[GRAPH_FOLDER_FIELD] === 'Квартира')?.label).toBe('Моё');
    expect(renameCanvasFolder(base, 'Нет такой', 'Другая')).toBe(base);
    expect(renameCanvasFolder(base, 'Дом', 'Дом')).toBe(base);
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
