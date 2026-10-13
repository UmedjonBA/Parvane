import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

import { createBlobConnPool } from './blobConns';

type FakeConn = { id: number; isOpen: boolean; close: () => void; onClose?: () => void };

function createFakeOpener() {
  const opened: FakeConn[] = [];
  const open = () => {
    const conn: FakeConn = {
      id: opened.length + 1,
      isOpen: true,
      close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.onClose?.();
      },
    };
    opened.push(conn);
    return Promise.resolve(conn);
  };
  return { open, opened, openCount: () => opened.length };
}

describe('соединения для блобов: серия, окна одного файла, простой', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('серия: все запросы — по одному соединению, конец серии закрывает его', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open });
    const used: number[] = [];
    await pool.withSeries(async (key) => {
      await Promise.all(Array.from({ length: 30 }, () => pool.run(key, (conn) => {
        used.push(conn.id);
        return Promise.resolve();
      })));
      await pool.run(key, (conn) => {
        used.push(conn.id);
        return Promise.resolve();
      });
    });
    expect(opener.openCount()).toBe(1);
    expect(new Set(used).size).toBe(1);
    expect(opener.opened[0].isOpen).toBe(false);
    expect(pool.size()).toBe(0);
  });

  it('вне серии: окна одного файла — одно соединение, разные файлы — разные', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open });
    for (let window = 0; window < 4; window++) {
      await pool.run('file:a', () => Promise.resolve());
    }
    await pool.run('file:b', () => Promise.resolve());
    expect(opener.openCount()).toBe(2);
    expect(pool.size()).toBe(2);
  });

  it('простой закрывает соединение, следующий запрос открывает новое', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open, idleMs: 100 });
    await pool.run('file:a', () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(50);
    await pool.run('file:a', () => Promise.resolve());
    expect(opener.openCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(opener.opened[0].isOpen).toBe(false);
    expect(pool.size()).toBe(0);
    await pool.run('file:a', () => Promise.resolve());
    expect(opener.openCount()).toBe(2);
  });

  it('лимит запросов на соединение: переоткрытие, занятый поток дорабатывает на старом', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open, maxUses: 3 });
    let releaseFirst: (() => void) | undefined;
    const first = pool.run('file:a', (conn) => new Promise<number>((resolve) => {
      releaseFirst = () => resolve(conn.id);
    }));
    await pool.run('file:a', () => Promise.resolve());
    await pool.run('file:a', () => Promise.resolve());
    // Четвёртый запрос — уже на новом соединении, старое ещё держит первый поток
    const fourth = await pool.run('file:a', (conn) => Promise.resolve(conn.id));
    expect(opener.openCount()).toBe(2);
    expect(fourth).toBe(2);
    expect(opener.opened[0].isOpen).toBe(true);
    releaseFirst!();
    expect(await first).toBe(1);
    await Promise.resolve();
    expect(opener.opened[0].isOpen).toBe(false);
  });

  it('умершее соединение переоткрывается, ошибка открытия отдаётся вызывающему', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open });
    await pool.run('file:a', () => Promise.resolve());
    opener.opened[0].isOpen = false;
    await pool.run('file:a', () => Promise.resolve());
    expect(opener.openCount()).toBe(2);
    const failing = createBlobConnPool({ open: () => Promise.reject(new Error('нет сети')) });
    await expect(failing.run('file:x', () => Promise.resolve())).rejects.toThrow('нет сети');
  });

  it('closeAll закрывает всё, что не занято', async () => {
    const opener = createFakeOpener();
    const pool = createBlobConnPool({ open: opener.open });
    await pool.run('file:a', () => Promise.resolve());
    await pool.run('file:b', () => Promise.resolve());
    pool.closeAll();
    await Promise.resolve();
    expect(opener.opened.every((c) => !c.isOpen)).toBe(true);
    expect(pool.size()).toBe(0);
  });
});
