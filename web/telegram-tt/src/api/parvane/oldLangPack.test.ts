import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiOldLangString } from '../types';

import { buildLangPackFromText } from './langPacks';
import { OLD_LANG_PACK_EN, OLD_LANG_PACK_RU } from './oldLangPack';

import enText from '../../assets/localization/fallback.strings?raw';
import ruText from '../../assets/localization/ru.strings?raw';

// Сторож старого lang-провайдера (useOldLang / getTranslationFn / oldTranslate): ключ, которого нет ни в
// синтезированном пакете, ни в новых словарях, выводится на экран как есть, а ключ без русского значения —
// по-английски. Обходим исходники и требуем значение на обоих языках для каждого литерального вызова.

const SRC = path.join(process.cwd(), 'src');
// Дни недели и месяцы синтезируются из Intl в buildOldLangPack
const SYNTHESIZED = /^(Weekday\.|Month\.|lng_weekday\d|lng_month\d)/;
// Позиционные `%@`/`%1$s` и именованные `%USERNAMES%`, которые место вызова заменяет само
const PLACEHOLDER = /%\d?\$?[sdf@]|%[A-Z_]+%/;

type Call = { key: string; file: string; args: string };

function walk(dir: string, out: string[] = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  });
  return out;
}

// Текст аргументов после ключа до закрывающей скобки вызова
function argsAfterKey(source: string, start: number) {
  let depth = 1;
  let i = start;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
  }
  return source.slice(start, i - 1).replace(/\s+/g, ' ').trim();
}

function collectCalls(): Call[] {
  const calls: Call[] = [];
  walk(SRC).forEach((file) => {
    const source = readFileSync(file, 'utf8');
    const names = new Set(['oldTranslate']);
    for (const match of source.matchAll(/const (\w+) = (?:useOldLang|getTranslationFn)\(\)/g)) names.add(match[1]);
    if (/\boldLang\b/.test(source) && /useOldLang|OldLangFn/.test(source)) names.add('oldLang');
    if (names.size === 1 && !source.includes('oldTranslate(')) return;
    names.forEach((name) => {
      for (const match of source.matchAll(new RegExp(`\\b${name}\\(\\s*'([^']+)'`, 'g'))) {
        const key = match[1];
        if (SYNTHESIZED.test(key)) continue;
        calls.push({
          key,
          file: path.relative(SRC, file),
          args: argsAfterKey(source, match.index + match[0].length),
        });
      }
    });
  });
  return calls;
}

describe('Старый лангпак: сторож сырых ключей', () => {
  const calls = collectCalls();
  const en = buildLangPackFromText('en', enText).strings;
  const ru = buildLangPackFromText('ru', ruText).strings;

  it('находит вызовы старого провайдера', () => {
    // Защита от поломки обхода: без вызовов тест ничего бы не проверял
    expect(calls.length).toBeGreaterThan(1000);
  });

  it('у каждого ключа есть значение на английском и на русском', () => {
    const missing = new Set<string>();
    calls.forEach(({ key, file }) => {
      if (!(key in OLD_LANG_PACK_EN) && !(key in en)) missing.add(`${key} [нет EN] ${file}`);
      if (!(key in OLD_LANG_PACK_RU) && !(key in ru)) missing.add(`${key} [нет RU] ${file}`);
    });
    expect([...missing].sort()).toEqual([]);
  });

  it('строки с подстановкой содержат плейсхолдер, формы числа — только при числовом вызове', () => {
    const problems = new Set<string>();
    calls.forEach(({ key, file, args }) => {
      const values: [string, ApiOldLangString | undefined][] = [
        ['EN', OLD_LANG_PACK_EN[key]], ['RU', OLD_LANG_PACK_RU[key]],
      ];
      values.forEach(([lang, langValue]) => {
        if (!langValue) return;
        // `lang('Key', x)` со строкой: значение подставляется, значит плейсхолдер обязателен. Формы числа
        // могут число не показывать («Удалить это сообщение?»)
        const passesValue = args.startsWith(',') && !/^,\s*undefined\b/.test(args);
        if (passesValue && typeof langValue === 'string' && !PLACEHOLDER.test(langValue)) {
          problems.add(`${key} (${lang}): нет плейсхолдера, а значение передаётся — ${file}`);
        }
        // Объект форм без значения в вызове не находит формы и показывает хвост ключа
        if (typeof langValue !== 'string' && !passesValue) {
          problems.add(`${key} (${lang}): формы числа, но вызов без значения — ${file}`);
        }
      });
    });
    expect([...problems].sort()).toEqual([]);
  });

  it('русские формы числа полные', () => {
    const incomplete = Object.entries(OLD_LANG_PACK_RU)
      .filter(([, value]) => value && typeof value !== 'string')
      .filter(([, value]) => ['oneValue', 'fewValue', 'manyValue', 'otherValue']
        .some((form) => !(value as Record<string, string>)[form]))
      .map(([key]) => key);
    expect(incomplete).toEqual([]);
  });
});
