// C7-2 (ревью 7 ноя 2026): удаление, реакция и закреп из v2-события проверяют, что известная цель — сообщение ЭТОГО
// чата (как правка, WEB-08). Без проверки участник общей группы личным сообщением удалял у жертвы сообщения группы.
// Поведение хранилища строк — `historyRows.test.ts` («C7-2»); здесь — что ветки контроллера её вызывают.
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(__dirname, 'controller.ts'), 'utf8');

function branch(marker: string) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf('\n        return;\n      }', start);
  return source.slice(start, end);
}

describe('C7-2: мутации v2 — только по сообщениям своего чата', () => {
  it.each([
    ['удаление', 'if (c.delete?.targets) {'],
    ['реакция', 'if (c.reaction?.target) {'],
    ['закреп', 'if (c.pin?.target) {'],
  ])('%s сверяет чат цели до записи в журнал истории', (_, marker) => {
    const body = branch(marker);
    const check = body.indexOf('isOtherChatTarget(target, inThisChat)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(body.indexOf('history.ingest('));
  });

  it('проверка пропускает сироту и сообщение своего чата', () => {
    const start = source.indexOf('async function isOtherChatTarget');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('known.hs && !known.hs.row');
    expect(body).toContain('inThisChat(known)');
  });
});
