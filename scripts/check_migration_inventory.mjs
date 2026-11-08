#!/usr/bin/env node
// Сторож перечня хранимого (spec 035, T005; `specs/035-protocol-evolution/contracts/migration.md`).
// Достаёт из кода все места хранения и сверяет с `specs/035-protocol-evolution/migration-inventory.json`:
//   web      — ключи localStorage (`storageKey('…')`, литералы `parvane:…`/`parvane-…`), записи защищённого
//              хранилища IndexedDB (`saveRecord('…')`, константы `*_RECORD`/`*_PREFIX`), базы `createStore(db, store)`;
//   core     — `desktop/parvane-core/src/**` (общий для desktop и android): файлы `parvane-*`, файлы каталога
//              состояния (`dir + "/имя"`);
//   desktop  — `desktop/tdesktop/Telegram/SourceFiles/parvane/**`: то же;
//   android  — `android/libtd/src/main/**`, `android/jni/**`: то же + `File(dir, "имя")`, литералы `*.json|jsonl|txt`;
//   server   — таблицы `CREATE TABLE` применяемых миграций шардов (`migrations_v2/*.sql`; `migrations/*.sql` тех, что
//              их применяют).
// Провал: место хранения в коде без записи перечня (и не в `ignore`), запись перечня, которой нет в коде (кроме
// `manual: true`), запись без обязательных полей. `--print` — найденное с файлами и строками (для правки перечня).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_ARG = process.argv.indexOf('--inventory');
const INVENTORY = INVENTORY_ARG > 0 ? process.argv[INVENTORY_ARG + 1]
  : join(ROOT, 'specs/035-protocol-evolution/migration-inventory.json');
const FATES = new Set(['migrate', 'recompute', 'drop-derived', 'keep']);
const LAYERS = new Set(['web', 'core', 'desktop', 'android', 'server']);

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'build' || name === '.cxx' || name === 'gen') continue;
      walk(path, filter, out);
    } else if (filter(path)) {
      out.push(path);
    }
  }
  return out;
}

// Комментарии не храним: строки-комментарии (`//`, ` * `, `/* … */`) заменяются пустыми, номера строк сохраняются
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .split('\n').map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\s\/\/ .*$/, ''))).join('\n');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Шаблонная строка: всё после `${` — подстановка (`*`)
function normalizeLiteral(raw) {
  const cut = raw.indexOf('${');
  return cut >= 0 ? `${raw.slice(0, cut)}*` : raw;
}

const found = new Map(); // `${layer}\t${key}` → [{file, line}]

function note(layer, key, file, text, index) {
  const id = `${layer}\t${key}`;
  if (!found.has(id)) found.set(id, []);
  found.get(id).push({ file: relative(ROOT, file), line: lineOf(text, index) });
}

function scan(re, text, cb) {
  re.lastIndex = 0;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) cb(m);
}

// ── web ────────────────────────────────────────────────────────────────────────────────────────────────────────
const WEB_DIRS = ['web/telegram-tt/src/api/parvane', 'web/telegram-tt/src/components/parvane'];
const isWebSource = (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts');
const RECORD_CALL = /\.(?:save|load|delete)(?:Bytes)?Records?(?:ByPrefix)?\(\s*(['`])([^'`]*?)\1?[,)]/g;
const RECORD_CONST = /const ([A-Z][A-Z0-9_]*(?:RECORD|PREFIX|SECRETS)[A-Z0-9_]*)\s*=\s*(['`])([^'`]*)\2/g;
for (const file of WEB_DIRS.flatMap((d) => walk(join(ROOT, d), isWebSource))) {
  const text = stripComments(readFileSync(file, 'utf8'));
  scan(/storageKey\(\s*'([^']+)'/g, text, (m) => note('web', `localStorage:parvane:${m[1]}:*`, file, text, m.index));
  scan(/(['`])(parvane[:-][^'`\s]*)/g, text, (m) => {
    note('web', `literal:${normalizeLiteral(m[2])}`, file, text, m.index);
  });
  scan(RECORD_CONST, text, (m) => {
    const name = normalizeLiteral(m[3]);
    if (name !== '*' && !name.startsWith('parvane')) note('web', `record:${name}`, file, text, m.index);
  });
  scan(RECORD_CALL, text, (m) => {
    const name = normalizeLiteral(m[2]);
    if (name && name !== '*' && !name.startsWith('parvane')) note('web', `record:${name}`, file, text, m.index);
  });
  scan(/createStore\(\s*'([^']+)'\s*,\s*'([^']+)'/g, text, (m) => note('web', `idb:${m[1]}/${m[2]}`, file, text, m.index));
}

// ── desktop / core / android ───────────────────────────────────────────────────────────────────────────────────
const isNative = (p) => /\.(cpp|h|hpp|kt|java)$/.test(p) && !/TdApi\.java$/.test(p);
const NATIVE_DIRS = [
  ['core', 'desktop/parvane-core/src'],
  ['core', 'desktop/parvane-core/include'],
  ['desktop', 'desktop/tdesktop/Telegram/SourceFiles/parvane'],
  ['android', 'android/libtd/src/main'],
  ['android', 'android/jni'],
];
const DIR_JOIN = /(?:[A-Za-z_]*(?:Dir|dir|Path|path|Root|root|Prefix|prefix)[A-Za-z_0-9]*(?:\(\))?|cfg_\.stateDir|stateDir)\s*\+\s*(?:u)?"\/([^"]+)"/g;
for (const [layer, dir] of NATIVE_DIRS) {
  for (const file of walk(join(ROOT, dir), isNative)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    const isKotlin = /\.(kt|java)$/.test(file);
    scan(/"(parvane-[^"]*)"/g, text, (m) => note(layer, `file:${normalizeLiteral(m[1])}`, file, text, m.index));
    scan(DIR_JOIN, text, (m) => note(layer, `file:/${m[1]}`, file, text, m.index));
    scan(/(?:read|write)StateFile\(\s*"([^"]+)"/g, text, (m) => note(layer, `file:/${m[1]}`, file, text, m.index));
    if (isKotlin || layer === 'android') {
      scan(/File\([^,()]+,\s*"([^"$]+)/g, text, (m) => note(layer, `file:${m[1]}`, file, text, m.index));
      scan(/"([A-Za-z0-9_-]+\.(?:json|jsonl|txt))"/g, text, (m) => note(layer, `file:${m[1]}`, file, text, m.index));
    }
  }
}

// ── server ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Каталоги миграций, которые шард применяет при старте (`sqlx::migrate!`), — без calendar/notes (к UI не подключены)
const APPLIED = [
  'cloud/migrations', 'cloud/migrations_v2', 'domains/migrations_v2', 'federation/migrations', 'identity/migrations',
  'identity/migrations_v2', 'messenger/migrations_v2', 'preview/migrations', 'push/migrations', 'push/migrations_v2',
];
for (const sub of APPLIED) {
  const shard = sub.split('/')[0];
  const tables = new Map();
  const dir = join(ROOT, 'backend/shards', sub);
  for (const file of walk(dir, (p) => p.endsWith('.sql')).sort()) {
    const text = readFileSync(file, 'utf8');
    scan(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([A-Za-z_0-9]+)"?/gi, text, (m) => {
      tables.set(m[1], { file, text, index: m.index });
    });
    scan(/DROP TABLE(?: IF EXISTS)?\s+"?([A-Za-z_0-9]+)"?/gi, text, (m) => tables.delete(m[1]));
    scan(/ALTER TABLE\s+"?([A-Za-z_0-9]+)"?\s+RENAME TO\s+"?([A-Za-z_0-9]+)"?/gi, text, (m) => {
      const prev = tables.get(m[1]);
      tables.delete(m[1]);
      tables.set(m[2], prev || { file, text, index: m.index });
    });
  }
  for (const [table, at] of tables) note('server', `sqlite:${shard}/${table}`, at.file, at.text, at.index);
}

// ── сверка ─────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--print')) {
  [...found.keys()].sort().forEach((id) => {
    const where = found.get(id).slice(0, 3).map(({ file, line }) => `${file}:${line}`).join(' ');
    console.log(`${id}\t${where}`);
  });
  process.exit(0);
}

let inventory;
try {
  inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
} catch (e) {
  console.error(`migration-inventory: перечня нет или он не читается (${INVENTORY}): ${e.message}`);
  process.exit(1);
}
const problems = [];
const listed = new Map();
for (const entry of inventory.entries || []) {
  const id = `${entry.layer}\t${entry.key}`;
  if (listed.has(id)) problems.push(`дубль записи перечня: ${id.replace('\t', ' ')}`);
  listed.set(id, entry);
  if (!LAYERS.has(entry.layer)) problems.push(`неизвестный слой «${entry.layer}»: ${entry.key}`);
  if (!FATES.has(entry.fate)) problems.push(`неизвестная судьба «${entry.fate}»: ${entry.key}`);
  for (const field of ['place', 'kind', 'target', 'audit']) {
    if (typeof entry[field] !== 'string' || !entry[field]) problems.push(`нет поля ${field}: ${entry.layer} ${entry.key}`);
  }
}
const ignored = new Map((inventory.ignore || []).map((item) => [`${item.layer}\t${item.key}`, item]));
for (const item of inventory.ignore || []) {
  if (!item.why) problems.push(`ignore без причины: ${item.layer} ${item.key}`);
}

for (const [id, where] of found) {
  if (listed.has(id) || ignored.has(id)) continue;
  const at = where.slice(0, 2).map(({ file, line }) => `${file}:${line}`).join(', ');
  problems.push(`не в перечне: ${id.replace('\t', ' ')} (${at})`);
}
for (const [id, entry] of [...listed, ...ignored]) {
  if (!found.has(id) && !entry.manual) problems.push(`в перечне, но нет в коде: ${id.replace('\t', ' ')}`);
}

if (problems.length) {
  console.error(`migration-inventory: ${problems.length} расхождений\n  ${problems.join('\n  ')}`);
  console.error('Новое место хранения — запись в specs/035-protocol-evolution/migration-inventory.json '
    + '(layer, place, key, kind, fate, target, audit) либо в ignore с причиной.');
  process.exit(1);
}
console.log(`migration-inventory: ок (${listed.size} записей, ${ignored.size} исключений, найдено в коде ${found.size})`);
