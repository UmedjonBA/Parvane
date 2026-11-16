import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  describe, expect, it, vi,
} from 'vitest';

import { engineStatic, loadProtocol } from '../api/parvane/v2/engine';

type Case = {
  name: string; prefs: unknown; serverOff: unknown; available: unknown;
  order: string[]; off: string[]; healthBlocks: string[]; enabled: string[];
};

const SAMPLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../conformance/modules/cases.json'), 'utf8'),
) as { cases: Case[] };

const settle = () => new Promise((done) => {
  setTimeout(done, 0);
});

// Хранилище устройства — до загрузки модуля: он читает сохранённое при импорте
const localValues = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => localValues.get(key) ?? null, // eslint-disable-line no-null/no-null
  setItem: (key: string, value: string) => localValues.set(key, value),
  removeItem: (key: string) => localValues.delete(key),
});

describe('Модули (MODULES-1)', () => {
  it('движок web отвечает по общему образцу', async () => {
    await loadProtocol();
    expect(SAMPLE.cases.length).toBeGreaterThanOrEqual(5);
    SAMPLE.cases.forEach((sample) => {
      const view = engineStatic<{ prefs: Record<string, string[]>; enabled: string[] }>('modulesView', {
        prefs: sample.prefs, serverOff: sample.serverOff, available: sample.available,
      });
      expect(view.prefs.order, sample.name).toEqual(sample.order);
      expect(view.prefs.off, sample.name).toEqual(sample.off);
      expect(view.prefs.healthBlocks, sample.name).toEqual(sample.healthBlocks);
      expect(view.enabled, sample.name).toEqual(sample.enabled);
    });
  });

  it('настройки устройства: выключенное и порядок запоминаются, список сервера сильнее выбора', async () => {
    const {
      getModulesView, moveModule, setHealthBlockOn, setModuleOn, setServerOffModules,
    } = await import('./parvaneModules');
    await loadProtocol();
    await settle();
    expect(getModulesView().enabled).toEqual(['chats', 'plan', 'health', 'notes', 'files', 'music', 'profile']);

    setModuleOn('files', false);
    setModuleOn('chats', false);
    moveModule('health', 1);
    setHealthBlockOn('water', true);
    setServerOffModules(['notes', 'smarthome']);
    await settle();
    const view = getModulesView();
    expect(view.enabled).toEqual(['chats', 'health', 'plan', 'music', 'profile']);
    expect(view.prefs.healthBlocks).toEqual(['sleep', 'body', 'water']);
    expect(view.modules.find(({ id }) => id === 'notes')).toMatchObject({ isOn: false, isServerOff: true });
    expect(JSON.parse(localValues.get('parvane:modules')!)).toMatchObject({ off: ['files'] });
    expect(JSON.parse(localValues.get('parvane:modules-view')!).enabled).toEqual(view.enabled);
  });
});
