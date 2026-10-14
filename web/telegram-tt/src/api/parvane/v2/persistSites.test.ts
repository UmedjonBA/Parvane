import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Сторож perf A1: `persistNow()` пишет только помеченное `persist()`. После изменения движка запись «сейчас» —
// `persistUrgent()`, иначе снимок не попадает на диск: сброс личности на месте оставлял прежнюю, и перезапуск
// принимал её за сброс «другим устройством» (relink, 15 окт 2026)
const source = readFileSync(join(__dirname, 'controller.ts'), 'utf8');

function body(name: string) {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const next = source.indexOf('\n  async function ', start + 1);
  return source.slice(start, next > 0 ? next : undefined);
}

describe('запись состояния движка v2', () => {
  it('persistNow — только дописать помеченное: перед чтением с диска, при остановке, перед экспортом', () => {
    expect(source.match(/await persistNow\(\)/g)?.length).toBe(3);
    expect(body('exportBackup')).toContain('await persistNow()');
  });

  it('сброс личности на месте и вступление в журнал пишут состояние сразу', () => {
    expect(body('resetWorkingIdentity')).toContain('await persistUrgent()');
    expect(body('resetWorkingIdentity')).not.toContain('persistNow()');
  });
});
