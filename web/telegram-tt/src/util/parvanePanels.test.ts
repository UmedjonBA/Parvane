import { describe, expect, it } from 'vitest';

import { clampPanelWidth, parsePanelWidths } from './parvanePanels';

describe('ширина панелей разделов', () => {
  it('держится в пределах панели', () => {
    expect(clampPanelWidth(100, 220, 560, 1920)).toBe(220);
    expect(clampPanelWidth(400.4, 220, 560, 1920)).toBe(400);
    expect(clampPanelWidth(900, 220, 560, 1920)).toBe(560);
  });

  it('не занимает больше 60 % окна, но и не уже своего минимума', () => {
    expect(clampPanelWidth(900, 320, 900, 1000)).toBe(600);
    expect(clampPanelWidth(900, 320, 900, 400)).toBe(320);
  });

  it('сохранённое читается терпимо: мусор и негодные числа отброшены', () => {
    expect(parsePanelWidths(undefined)).toEqual({});
    expect(parsePanelWidths('не json')).toEqual({});
    expect(parsePanelWidths('[1,2]')).toEqual({});
    expect(parsePanelWidths('{"notes-list":300,"graph-note":"x","planner-side":-5}')).toEqual({ 'notes-list': 300 });
  });
});
