import { describe, expect, it } from 'vitest';

import type { CanvasDoc } from './notesCanvas';
import type { GraphNoteInput } from './notesGraph';

import { parseCanvas, serializeCanvas } from './notesCanvas';
import {
  canvasFromGraph, freeCanvasTitle, GRAPH_CANVAS_CARD_HEIGHT, GRAPH_CANVAS_GAP,
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
