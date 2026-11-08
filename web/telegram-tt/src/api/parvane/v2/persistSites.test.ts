import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Сторож perf A1: `persist()` — отложенная запись, `persistUrgent()` — на диске до возврата: сброс личности на месте
// без немедленной записи оставлял прежнюю, и перезапуск принимал её за сброс «другим устройством» (relink, 15 окт
// 2026). spec 035 (T113): состояние клиента пишет модель движка — `persist()` ставит её отложенную запись,
// `persistNow()`/`persistUrgent()` пишут изменённое модели сразу (`host.flush()`), снимков клиента хост не делает.
const source = readFileSync(join(__dirname, 'controller.ts'), 'utf8');

function body(name: string) {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(0);
  const next = source.indexOf('\n  async function ', start + 1);
  return source.slice(start, next > 0 ? next : undefined);
}

describe('запись состояния движка v2', () => {
  it('запись — модель: отложенная и немедленная, без снимков клиента в хосте', () => {
    expect(source).toContain('host?.scheduleFlush();');
    expect(body('persistNow')).toContain('await host.flush();');
    expect(source).not.toMatch(/stateWriter|client\.export\(storageKey\)\s*\}/);
    expect(body('exportBackup')).toContain('await persistNow()');
  });

  it('сброс личности на месте и вступление в журнал пишут состояние сразу', () => {
    expect(body('resetWorkingIdentity')).toContain('await persistUrgent()');
    expect(body('resetWorkingIdentity')).not.toContain('persistNow()');
  });
});
