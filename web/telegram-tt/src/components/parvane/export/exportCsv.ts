// CSV разделов выгрузки (доски `PhProfileB`, `DkSettingsB`: «План и здоровье — записи в JSON и CSV», «Контакты — список
// в CSV»): таблицы для электронных таблиц рядом с JSON. RFC 4180: поля с запятой, кавычкой или переводом строки — в
// кавычках, строки через CRLF; в начале — метка UTF-8, чтобы таблицы не путали кириллицу

import type { PlannerState } from '../planner/plannerModel';
import type { EngineState } from '../planner/plannerSync';
import type { ExportContact } from './exportModel';

import { fromEngineState } from '../planner/plannerSync';

type Cell = string | number | boolean | undefined;

// Запись «Здоровья» в JSON движка (`entriesJson`): лишние поля выгрузке не нужны
export type ExportHealthEntry = {
  kind: string;
  day: string;
  atMs: number;
  endMs?: number;
  value?: number;
  value2?: number;
  unit?: string;
  name?: string;
  tag?: string;
  note?: string;
  parts?: Record<string, number>;
};

const BOM = '﻿';
const NEEDS_QUOTES = /[",\r\n]/;

export function toCsv(rows: Cell[][]): string {
  return BOM + rows.map((row) => row.map(formatCell).join(',')).join('\r\n') + '\r\n';
}

export function buildPlannerCsv(raw: string): { tasks: string; events: string } | undefined {
  let state: PlannerState;
  try {
    // Снимок «Плана» на устройстве бывает неполным (нет списков, настроек) — недостающее пустым
    const parsed = JSON.parse(raw) as Partial<EngineState>;
    state = fromEngineState({
      tasks: [], events: [], lists: [], headSeq: 0, sizeBytes: 0, ...parsed, settings: parsed.settings,
    } as EngineState);
  } catch {
    return undefined;
  }
  const tasks = toCsv([
    ['id', 'name', 'status', 'list', 'day', 'start', 'minutes', 'due', 'repeat', 'description'],
    ...state.tasks.map((task) => [
      task.id, task.name, task.status, task.project, task.day, task.start, task.minutes, task.due, task.repeat?.kind,
      task.description,
    ]),
  ]);
  const events = toCsv([
    ['id', 'name', 'day', 'start', 'end', 'all_day', 'repeat', 'group', 'description'],
    ...state.events.map((event) => [
      event.id, event.name, event.day, event.start, event.end, Boolean(event.isAllDay), event.repeat?.kind,
      event.project, event.description,
    ]),
  ]);
  return { tasks, events };
}

export function buildHealthCsv(entries: ExportHealthEntry[]): string {
  const partNames = [...new Set(entries.flatMap((entry) => Object.keys(entry.parts || {})))].sort();
  return toCsv([
    ['day', 'time', 'kind', 'value', 'value2', 'unit', 'name', 'tag', 'note', 'end', ...partNames],
    ...entries.map((entry) => [
      entry.day, formatIso(entry.atMs), entry.kind, entry.value, entry.value2, entry.unit, entry.name, entry.tag,
      entry.note, entry.endMs && entry.endMs !== entry.atMs ? formatIso(entry.endMs) : undefined,
      ...partNames.map((part) => entry.parts?.[part]),
    ]),
  ]);
}

export function buildContactsCsv(contacts: ExportContact[]): string {
  return toCsv([
    ['name', 'address', 'added'],
    ...contacts.map((contact) => [contact.name, contact.address, contact.isExplicit]),
  ]);
}

function formatCell(cell: Cell) {
  if (cell === undefined) return '';
  const text = String(cell);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatIso(ms: number) {
  return new Date(ms).toISOString();
}
