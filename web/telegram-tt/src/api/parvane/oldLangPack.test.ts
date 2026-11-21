import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiOldLangString } from '../types';

import { parseLanguageStrings } from '../../util/localization/languages';
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

// Место первой запятой вне скобок и строк; `-1` — аргумент один
function findTopLevelComma(text: string) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = '';
    } else if (char === '\'' || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    } else if (char === ',' && depth === 0) {
      return i;
    }
  }
  return -1;
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
      // Ключ выбирается условием: `lang(isOn ? 'A' : 'B', …)` — проверяются обе ветви
      for (const match of source.matchAll(new RegExp(`\\b${name}\\((?!\\s*')`, 'g'))) {
        const all = argsAfterKey(source, match.index + match[0].length);
        const firstArgEnd = findTopLevelComma(all);
        const firstArg = firstArgEnd < 0 ? all : all.slice(0, firstArgEnd);
        if (!firstArg.includes('?')) continue;
        // Висячая запятая после единственного аргумента значением не считается
        const rest = firstArgEnd < 0 ? '' : all.slice(firstArgEnd);
        const args = /^,\s*$/.test(rest) ? '' : rest;
        for (const branch of firstArg.matchAll(/[?:]\s*'([^']+)'/g)) {
          if (SYNTHESIZED.test(branch[1])) continue;
          calls.push({
            key: branch[1],
            file: path.relative(SRC, file),
            args,
          });
        }
      }
    });
  });
  return calls;
}

describe('Старый лангпак: сторож сырых ключей', () => {
  const calls = collectCalls();
  const en = parseLanguageStrings(enText);
  const ru = parseLanguageStrings(ruText);

  it('находит вызовы старого провайдера', () => {
    // Защита от поломки обхода: без вызовов тест ничего бы не проверял
    expect(calls.length).toBeGreaterThan(900);
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
