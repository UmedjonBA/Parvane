import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { WireCallSignal } from './callengine';
import type { WireGroupInvite } from './groupcall';

import { initSync, runConformanceVectors } from '../../lib/parvane-protocol/parvane_protocol';
import {
  callSignalFromV2, callSignalToV2, groupCallIdFromV2, groupInviteFromV2, type V2CallSignal,
} from './v2/callMap';
import { v2Class, type V2Content, v2ToWire } from './v2/contentMap';
import { decodeIceCandidate } from './iceCandidate';
import { linkCommitment, sasCodeV2 } from './linking';

// Протокол v2 (spec 007, T081/T085/T088): векторы proto/parvane/vectors/**
// прогоняются тем же WASM-движком, что работает в клиенте. Логика сверки —
// в движке (`parvane_protocol::conformance`), общая для всех обвязок.
const REPO_ROOT = path.resolve(process.cwd(), '../..');
const VECTORS = path.join(REPO_ROOT, 'proto/parvane/vectors');
const WASM = path.join(process.cwd(), 'src/lib/parvane-protocol/parvane_protocol_bg.wasm');

// Набор, файл, наименьшее число случаев (журналы — один случай из нескольких шагов)
const SUITES: [string, string, number][] = [
  ['seal/sealed', 'seal/sealed.json', 3],
  ['seal/group', 'seal/group.json', 3],
  ['invite/links', 'invite/links.json', 3],
  ['content/kinds', 'content/kinds.json', 3],
  ['l2/mode', 'l2/mode.json', 3],
  // T136: наборы, которые раньше гонял только движок
  ['codec/frames', 'codec/frames.json', 20],
  ['sign/ops', 'sign/ops.json', 10],
  ['device_log/alice', 'device_log/alice.json', 1],
  ['group_log/group', 'group_log/group.json', 1],
  ['content_guard/content', 'content_guard/content.json', 10],
  ['legacy_v1/messages', 'legacy_v1/messages.json', 40],
  ['call/signals', 'call/signals.json', 30],
  ['link/sas', 'link/sas.json', 5],
];

type CallCase = {
  name: string;
  input: {
    direction: 'to_v2' | 'from_v2';
    v1?: WireCallSignal | WireGroupInvite;
    v2?: V2CallSignal;
    group_call_id?: string;
  };
  expect: {
    v1?: Record<string, unknown> | null;
    v2?: V2CallSignal | null;
    group_call_id?: string;
    ice?: { candidate: string; mid: string; index: number };
  };
};

type LinkCase = {
  name: string;
  input: { new_pub_b64: string; old_pub_b64: string };
  expect: { commitment_of_new_b64: string; sas: string };
};

type ContentCase = {
  name: string;
  expect: { content?: V2Content; disposition?: string };
  client?: { class: string; v1?: Record<string, unknown> };
};

describe('векторы протокола v2 через WASM-движок', () => {
  initSync({ module: readFileSync(WASM) });

  it.each(SUITES)('%s', (suite, file, least) => {
    const cases = runConformanceVectors(suite, readFileSync(path.join(VECTORS, file), 'utf8'));
    expect(cases).toBeGreaterThanOrEqual(least);
  });

  // T085: перекладка содержимого движка в содержимое UI — та же для всех
  // клиентов (desktop/android сверяют тот же файл через parvane-core)
  describe('content/kinds → содержимое UI', () => {
    const file = JSON.parse(readFileSync(path.join(VECTORS, 'content/kinds.json'), 'utf8')) as { cases: ContentCase[] };
    const cases = file.cases.filter((c) => c.client);

    it('векторы с ожиданием клиента есть', () => {
      expect(cases.length).toBeGreaterThan(30);
    });

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const content = c.expect.content!;
      // движок велел показать заглушку — клиент содержимое не разбирает
      const got = c.expect.disposition === 'stub' ? 'stub' : v2Class(content);
      expect(got).toBe(c.client!.class);
      if (c.client!.class === 'message') {
        expect(v2ToWire(content)).toMatchObject(c.client!.v1!);
      } else if (c.expect.disposition !== 'stub') {
        expect(v2ToWire(content)).toBeUndefined();
      }
    });
  });

  // T136: перекладка сигнала звонка v1 ↔ v2 — та же, что в parvane-core
  // (`v2_content.cpp`); proto3-JSON этих же векторов движок сверяет со схемой
  describe('call/signals → перекладка клиента', () => {
    const file = JSON.parse(readFileSync(path.join(VECTORS, 'call/signals.json'), 'utf8')) as { cases: CallCase[] };

    it.each(file.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      if (c.input.direction === 'to_v2') {
        const got = callSignalToV2(c.input.v1!, c.input.group_call_id);
        if (c.expect.v2) expect(got).toEqual(c.expect.v2);
        else expect(got).toBeUndefined();
        return;
      }
      const v2 = c.input.v2!;
      const isGroupInvite = c.expect.v1?.type === 'group_invite';
      const got = isGroupInvite ? groupInviteFromV2(v2) : callSignalFromV2(v2);
      if (!c.expect.v1) {
        expect(got).toBeUndefined();
        return;
      }
      expect(got).toMatchObject(c.expect.v1);
      if (!isGroupInvite) expect(groupCallIdFromV2(v2)).toBe(c.expect.group_call_id);
      if (c.expect.ice) {
        const candidate = decodeIceCandidate((got as { candidate: string }).candidate);
        expect(candidate?.candidate).toBe(c.expect.ice.candidate);
        expect(candidate?.sdpMid || '').toBe(c.expect.ice.mid);
        expect(candidate?.sdpMLineIndex || 0).toBe(c.expect.ice.index);
      }
    });
  });

  // T136 (T050): векторы LINK-1 — обязательство и код сверки
  describe('link/sas → линковка клиента', () => {
    const file = JSON.parse(readFileSync(path.join(VECTORS, 'link/sas.json'), 'utf8')) as { cases: LinkCase[] };

    it.each(file.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
      expect(await linkCommitment(c.input.new_pub_b64)).toBe(c.expect.commitment_of_new_b64);
      expect(await sasCodeV2(c.input.new_pub_b64, c.input.old_pub_b64)).toBe(c.expect.sas);
    });
  });
});
