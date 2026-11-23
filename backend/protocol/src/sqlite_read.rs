//! Чтение файла базы SQLite 3 (только чтение, только таблицы): импорт выгрузок, которые приходят файлом SQLite
//! (Health Connect — `health_connect_export.db`). Разбор идёт на устройстве, в общей библиотеке, без зависимостей.
//!
//! Формат — https://www.sqlite.org/fileformat2.html: страницы B-дерева таблиц (внутренние 0x05, листья 0x0D),
//! переполнение длинных записей, формат записи (заголовок с типами, значения). Имена колонок — из `CREATE TABLE`
//! в `sqlite_master`; колонка `INTEGER PRIMARY KEY` хранится как rowid. Строка, записанная до `ALTER TABLE ADD
//! COLUMN`, короче схемы — недостающие значения NULL. Текст — только UTF-8 (у Android по умолчанию). Повреждённый
//! или зацикленный файл — ошибка, а не зависание: число посещённых страниц ограничено размером файла.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(n) => Some(*n),
            Self::Real(f) if f.is_finite() => Some(*f as i64),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Int(n) => Some(*n as f64),
            Self::Real(f) if f.is_finite() => Some(*f),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Self::Blob(b) => Some(b),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    NotSqlite,
    Unsupported(&'static str),
    Corrupt(&'static str),
}

pub struct Db<'a> {
    bytes: &'a [u8],
    page_size: usize,
    usable: usize,
    tables: HashMap<String, Table>,
}

#[derive(Clone, Debug)]
struct Table {
    root: u32,
    columns: Vec<String>,
    /// Колонка `INTEGER PRIMARY KEY` (её значение — rowid).
    rowid_alias: Option<usize>,
}

/// Строка таблицы: значения по порядку колонок.
pub struct Row<'t> {
    pub values: Vec<Value>,
    columns: &'t HashMap<String, usize>,
}

impl Row<'_> {
    pub fn get(&self, column: &str) -> &Value {
        const NULL: Value = Value::Null;
        self.columns.get(column).and_then(|&i| self.values.get(i)).unwrap_or(&NULL)
    }
}

const HEADER: &[u8] = b"SQLite format 3\0";

impl<'a> Db<'a> {
    pub fn open(bytes: &'a [u8]) -> Result<Self, Error> {
        if bytes.len() < 100 || &bytes[..16] != HEADER {
            return Err(Error::NotSqlite);
        }
        let page_size = match u16::from_be_bytes([bytes[16], bytes[17]]) {
            1 => 65_536,
            n if n >= 512 && n.is_power_of_two() => usize::from(n),
            _ => return Err(Error::Corrupt("размер страницы")),
        };
        let usable = page_size - usize::from(bytes[20]);
        if u32::from_be_bytes([bytes[56], bytes[57], bytes[58], bytes[59]]) > 1 {
            return Err(Error::Unsupported("текст не UTF-8"));
        }
        let mut db = Db { bytes, page_size, usable, tables: HashMap::new() };
        let mut tables = HashMap::new();
        let master = Table { root: 1, columns: ["type", "name", "tbl_name", "rootpage", "sql"].map(String::from).to_vec(), rowid_alias: None };
        db.scan_table(&master, &mut |values, _| {
            if values.first().and_then(Value::as_text) == Some("table") {
                if let (Some(name), Some(root), Some(sql)) = (values.get(1).and_then(Value::as_text), values.get(3).and_then(Value::as_i64), values.get(4).and_then(Value::as_text)) {
                    let (columns, rowid_alias) = parse_columns(sql);
                    if let Ok(root) = u32::try_from(root) {
                        tables.insert(name.to_string(), Table { root, columns, rowid_alias });
                    }
                }
            }
            Ok(())
        })?;
        db.tables = tables;
        Ok(db)
    }

    pub fn has_table(&self, name: &str) -> bool {
        self.tables.contains_key(name)
    }

    pub fn columns(&self, name: &str) -> Option<&[String]> {
        self.tables.get(name).map(|t| t.columns.as_slice())
    }

    /// Все строки таблицы по порядку rowid; таблицы нет — ничего.
    pub fn scan(&self, name: &str, each: &mut dyn FnMut(&Row) -> Result<(), Error>) -> Result<(), Error> {
        let Some(table) = self.tables.get(name) else { return Ok(()) };
        let index: HashMap<String, usize> = table.columns.iter().enumerate().map(|(i, c)| (c.clone(), i)).collect();
        self.scan_table(table, &mut |values, _| each(&Row { values, columns: &index }))
    }

    fn scan_table(&self, table: &Table, each: &mut dyn FnMut(Vec<Value>, i64) -> Result<(), Error>) -> Result<(), Error> {
        let pages = self.bytes.len() / self.page_size;
        let mut budget = pages + 1;
        let mut stack = vec![table.root];
        while let Some(page_no) = stack.pop() {
            budget = budget.checked_sub(1).ok_or(Error::Corrupt("цикл страниц"))?;
            let (page, header_at) = self.page(page_no)?;
            let kind = *page.get(header_at).ok_or(Error::Corrupt("страница"))?;
            let cells = usize::from(be16(page, header_at + 3)?);
            match kind {
                0x0D => {
                    for i in 0..cells {
                        let at = usize::from(be16(page, header_at + 8 + i * 2)?);
                        let (payload_len, n1) = varint(page, at)?;
                        let (rowid, n2) = varint(page, at + n1)?;
                        let payload = self.payload(page, at + n1 + n2, usize::try_from(payload_len).map_err(|_| Error::Corrupt("длина записи"))?)?;
                        let mut values = record(&payload)?;
                        if let Some(alias) = table.rowid_alias {
                            if values.len() <= alias {
                                values.resize(alias + 1, Value::Null);
                            }
                            if values[alias] == Value::Null {
                                values[alias] = Value::Int(rowid as i64);
                            }
                        }
                        if values.len() < table.columns.len() {
                            values.resize(table.columns.len(), Value::Null);
                        }
                        each(values, rowid as i64)?;
                    }
                }
                0x05 => {
                    // Правый потомок — последним в обходе: кладём его в стек первым
                    stack.push(be32(page, header_at + 8)?);
                    let mut children = Vec::with_capacity(cells);
                    for i in 0..cells {
                        let at = usize::from(be16(page, header_at + 12 + i * 2)?);
                        children.push(be32(page, at)?);
                    }
                    stack.extend(children.into_iter().rev());
                }
                _ => return Err(Error::Corrupt("не страница таблицы")),
            }
        }
        Ok(())
    }

    fn page(&self, page_no: u32) -> Result<(&'a [u8], usize), Error> {
        let index = usize::try_from(page_no).map_err(|_| Error::Corrupt("номер страницы"))?.checked_sub(1).ok_or(Error::Corrupt("номер страницы"))?;
        let start = index.checked_mul(self.page_size).ok_or(Error::Corrupt("номер страницы"))?;
        let page = self.bytes.get(start..start + self.page_size).ok_or(Error::Corrupt("страница за концом файла"))?;
        Ok((page, if page_no == 1 { 100 } else { 0 }))
    }

    /// Данные записи листа: локальная часть и страницы переполнения.
    fn payload(&self, page: &[u8], at: usize, total: usize) -> Result<Vec<u8>, Error> {
        let u = self.usable;
        let max_local = u - 35;
        let local = if total <= max_local {
            total
        } else {
            let min_local = (u - 12) * 32 / 255 - 23;
            let k = min_local + (total - min_local) % (u - 4);
            if k <= max_local { k } else { min_local }
        };
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(page.get(at..at + local).ok_or(Error::Corrupt("запись за концом страницы"))?);
        if local < total {
            let mut next = be32(page, at + local)?;
            let mut budget = self.bytes.len() / self.page_size + 1;
            while out.len() < total {
                budget = budget.checked_sub(1).ok_or(Error::Corrupt("цикл переполнения"))?;
                let (over, _) = self.page(next)?;
                next = be32(over, 0)?;
                let take = (total - out.len()).min(u - 4);
                out.extend_from_slice(over.get(4..4 + take).ok_or(Error::Corrupt("переполнение"))?);
            }
        }
        Ok(out)
    }
}

fn be16(b: &[u8], at: usize) -> Result<u16, Error> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).ok_or(Error::Corrupt("за концом страницы"))
}

fn be32(b: &[u8], at: usize) -> Result<u32, Error> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or(Error::Corrupt("за концом страницы"))
}

/// Число переменной длины SQLite (до 9 байт): значение и длина.
fn varint(b: &[u8], at: usize) -> Result<(u64, usize), Error> {
    let mut v: u64 = 0;
    for i in 0..9 {
        let byte = *b.get(at + i).ok_or(Error::Corrupt("число за концом"))?;
        if i == 8 {
            return Ok(((v << 8) | u64::from(byte), 9));
        }
        v = (v << 7) | u64::from(byte & 0x7F);
        if byte & 0x80 == 0 {
            return Ok((v, i + 1));
        }
    }
    unreachable!()
}

/// Значения записи по её заголовку типов.
fn record(p: &[u8]) -> Result<Vec<Value>, Error> {
    let (header_len, mut at) = varint(p, 0)?;
    let header_len = usize::try_from(header_len).map_err(|_| Error::Corrupt("заголовок записи"))?;
    if header_len > p.len() {
        return Err(Error::Corrupt("заголовок записи"));
    }
    let mut types = Vec::new();
    while at < header_len {
        let (t, n) = varint(p, at)?;
        types.push(t);
        at += n;
    }
    let mut data = header_len;
    let mut values = Vec::with_capacity(types.len());
    for t in types {
        let int = |len: usize, data: usize| -> Result<i64, Error> {
            let s = p.get(data..data + len).ok_or(Error::Corrupt("значение за концом"))?;
            let mut v: i64 = if s[0] & 0x80 != 0 { -1 } else { 0 };
            for &byte in s {
                v = (v << 8) | i64::from(byte);
            }
            Ok(v)
        };
        let (value, len) = match t {
            0 => (Value::Null, 0),
            1..=4 => {
                let len = t as usize;
                (Value::Int(int(len, data)?), len)
            }
            5 => (Value::Int(int(6, data)?), 6),
            6 => (Value::Int(int(8, data)?), 8),
            7 => {
                let s = p.get(data..data + 8).ok_or(Error::Corrupt("значение за концом"))?;
                (Value::Real(f64::from_be_bytes(s.try_into().unwrap_or([0; 8]))), 8)
            }
            8 => (Value::Int(0), 0),
            9 => (Value::Int(1), 0),
            10 | 11 => return Err(Error::Corrupt("служебный тип")),
            n => {
                let len = usize::try_from((n - 12) / 2).map_err(|_| Error::Corrupt("длина значения"))?;
                let s = p.get(data..data + len).ok_or(Error::Corrupt("значение за концом"))?;
                if n % 2 == 0 {
                    (Value::Blob(s.to_vec()), len)
                } else {
                    (Value::Text(String::from_utf8_lossy(s).into_owned()), len)
                }
            }
        };
        values.push(value);
        data += len;
    }
    Ok(values)
}

/// Имена колонок из `CREATE TABLE …(…)` и номер колонки `INTEGER PRIMARY KEY`.
fn parse_columns(sql: &str) -> (Vec<String>, Option<usize>) {
    let (Some(open), Some(close)) = (sql.find('('), sql.rfind(')')) else { return (Vec::new(), None) };
    let body = &sql[open + 1..close];
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in body.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&body[start..]);
    let mut columns = Vec::new();
    let mut alias = None;
    for part in parts {
        let def = part.trim();
        let upper = def.to_ascii_uppercase();
        if ["PRIMARY ", "FOREIGN ", "UNIQUE", "CHECK", "CONSTRAINT "].iter().any(|k| upper.starts_with(k)) {
            continue;
        }
        let name: String = def.split_whitespace().next().unwrap_or("").trim_matches(|c| matches!(c, '"' | '`' | '[' | ']' | '\'')).to_string();
        if name.is_empty() {
            continue;
        }
        if upper.contains("INTEGER PRIMARY KEY") {
            alias = Some(columns.len());
        }
        columns.push(name);
    }
    (columns, alias)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_from_create_table() {
        let (cols, alias) = parse_columns("CREATE TABLE t (row_id INTEGER PRIMARY KEY AUTOINCREMENT, \"name\" TEXT NOT NULL, v REAL, FOREIGN KEY (x) REFERENCES y(z), UNIQUE (name, v))");
        assert_eq!(cols, ["row_id", "name", "v"]);
        assert_eq!(alias, Some(0));
    }

    #[test]
    fn varints_and_records() {
        assert_eq!(varint(&[0x81, 0x00], 0).unwrap(), (128, 2));
        // Заголовок 4 байта: NULL, целое 1 байт, текст 3 байта; значения: -2, «abc»
        let rec = [4, 0, 1, 19, 0xFE, b'a', b'b', b'c'];
        assert_eq!(record(&rec).unwrap(), [Value::Null, Value::Int(-2), Value::Text("abc".into())]);
    }

    #[test]
    fn not_sqlite_is_refused() {
        assert_eq!(Db::open(b"PK\x03\x04 not a database at all, just bytes......................................................................").err(), Some(Error::NotSqlite));
    }
}
