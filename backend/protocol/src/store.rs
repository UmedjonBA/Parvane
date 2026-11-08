//! Хранилище движка (spec 035, contracts/storage.md, FR-020…FR-028). sans-IO: движок не пишет и не
//! читает сам — выпускает пачки `StoreBatch` (одна атомарная транзакция хоста) и чтения `StoreReads`;
//! хост применяет пачку, сообщает `committed`, подаёт прочитанное `StoreLoaded`.
//!
//! - Запись `Stored{format, kind, generation, payload}`: AES-256-GCM на DEK поколения, AAD =
//!   `"parvane/store/v1\0" ‖ store_id ‖ u32be(format) ‖ kind ‖ "\0" ‖ u32be(generation) ‖ name`.
//! - Корень `Root` (ключ `root`, открытый): `store_id`, активное поколение, обёртки DEK, форматы видов.
//! - DEK под обёрткой: `device` (ключ устройства) или `pin` (PBKDF2-HMAC-SHA256). Установка/смена/снятие
//!   PIN — пачка только с корнем: записи данных не трогаются (FR-021).
//! - Перенос поколения P1–P6 — конечный автомат (`begin_rotation`, `rotation_next`): каждая точка
//!   переживает прерывание; активным всегда остаётся ровно одно поколение со всеми записями (FR-023).
//! - Формат новее известного (`root.kinds_max_format` или `Stored.format`) — `TooNew`: чтение известного
//!   можно, пачки не выпускаются (FR-025).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use prost::Message;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::codec::decode_checked;
use crate::error::{ProtoError, Result};
use crate::limits::Origin;
use crate::model::store_kinds;
use crate::pb::parvane::engine::v1::{
    wrap, DeviceWrap, KindFormat, MigrationProgress, PinWrap, Root, StoreBatch, StoreLoaded, StorePut, StoreReads, Stored, Wrap,
};

/// Ключ корня на носителе.
pub const ROOT_KEY: &str = "root";
/// Итерации PBKDF2 обёртки PIN выпуска.
pub const PIN_ITERATIONS: u32 = 310_000;
/// Нижняя граница итераций при открытии (тесты — от 1000).
pub const PIN_ITERATIONS_MIN: u32 = 1_000;
/// Верхняя граница итераций (испорченный корень не должен вешать устройство).
pub const PIN_ITERATIONS_MAX: u32 = 10_000_000;
/// Записей в одной пачке переноса поколения.
pub const ROTATION_BATCH: u32 = 256;

const AAD_RECORD: &[u8] = b"parvane/store/v1\0";
const AAD_WRAP: &[u8] = b"parvane/store/wrap/v1\0";
const PIN_CHECK: &[u8] = b"parvane/store/pin-check/v1\0";
const NONCE_LEN: usize = 12;
const PROGRESS_KIND: &str = "migration-progress";
const PROGRESS_NAME: &str = "rotation";

type Dek = Zeroizing<[u8; 32]>;

/// Ключ записи на носителе: `g<generation>/<kind>/<name>`.
pub fn record_key(generation: u32, kind: &str, name: &str) -> String {
    format!("g{generation}/{kind}/{name}")
}

/// Разобрать ключ записи; `None` — не ключ записи (например, `root`).
pub fn parse_key(key: &str) -> Option<(u32, &str, &str)> {
    let rest = key.strip_prefix('g')?;
    let (g, rest) = rest.split_once('/')?;
    if g.is_empty() || !g.bytes().all(|b| b.is_ascii_digit()) || (g.len() > 1 && g.starts_with('0')) {
        return None;
    }
    let (kind, name) = rest.split_once('/')?;
    Some((g.parse().ok()?, kind, name))
}

/// AAD записи (contracts/storage.md).
pub fn record_aad(store_id: &[u8], format: u32, kind: &str, generation: u32, name: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(AAD_RECORD.len() + store_id.len() + kind.len() + name.len() + 9);
    v.extend_from_slice(AAD_RECORD);
    v.extend_from_slice(store_id);
    v.extend_from_slice(&format.to_be_bytes());
    v.extend_from_slice(kind.as_bytes());
    v.push(0);
    v.extend_from_slice(&generation.to_be_bytes());
    v.extend_from_slice(name.as_bytes());
    v
}

fn wrap_aad(store_id: &[u8], generation: u32, tag: &str) -> Vec<u8> {
    let mut v = AAD_WRAP.to_vec();
    v.extend_from_slice(store_id);
    v.extend_from_slice(&generation.to_be_bytes());
    v.extend_from_slice(tag.as_bytes());
    v
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut b);
    b
}

fn seal(key: &[u8; 32], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let nonce = random::<NONCE_LEN>();
    let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad })
        .map_err(|_| ProtoError::Crypto)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err(ProtoError::Crypto);
    }
    let (n, ct) = sealed.split_at(NONCE_LEN);
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)).decrypt(Nonce::from_slice(n), Payload { msg: ct, aad }).map_err(|_| ProtoError::Crypto)
}

/// Зашифровать запись.
pub fn seal_record(dek: &[u8; 32], store_id: &[u8], format: u32, kind: &str, generation: u32, name: &str, plain: &[u8]) -> Result<Stored> {
    let payload = seal(dek, &record_aad(store_id, format, kind, generation, name), plain)?;
    Ok(Stored { format, kind: kind.to_string(), generation, payload })
}

/// Открыть запись, лежащую под ключом `g<generation>/<kind>/<name>`: заголовок записи обязан совпасть с
/// ключом, шифр — сойтись с AAD (чужое имя, вид, формат, поколение или профиль не открываются).
pub fn open_record(dek: &[u8; 32], store_id: &[u8], generation: u32, kind: &str, name: &str, stored: &Stored) -> Result<Vec<u8>> {
    if stored.kind != kind || stored.generation != generation {
        return Err(ProtoError::ContextMismatch);
    }
    open(dek, &record_aad(store_id, stored.format, kind, generation, name), &stored.payload)
}

/// KEK обёртки PIN: PBKDF2-HMAC-SHA256(PIN UTF-8, salt, iterations, 32 байта).
pub fn pin_kek(pin: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    type H = Hmac<Sha256>;
    // Один блок (dkLen = hLen): T1 = U1 ⊕ … ⊕ Uc, U1 = PRF(P, S ‖ INT(1)).
    let Ok(prf) = <H as Mac>::new_from_slice(pin.as_bytes()) else { return [0u8; 32] };
    let mut m = prf.clone();
    m.update(salt);
    m.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = m.finalize().into_bytes().into();
    let mut t = u;
    for _ in 1..iterations.max(1) {
        let mut m = prf.clone();
        m.update(&u);
        u = m.finalize().into_bytes().into();
        for (a, b) in t.iter_mut().zip(u.iter()) {
            *a ^= b;
        }
    }
    t
}

/// Запись проверки обёртки PIN: SHA-256("parvane/store/pin-check/v1\0" ‖ KEK)[0..16].
pub fn pin_check(kek: &[u8; 32]) -> [u8; 16] {
    let d = Sha256::new().chain_update(PIN_CHECK).chain_update(kek).finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&d[..16]);
    out
}

/// Чем обёрнут DEK у открытого хранилища (нужно, чтобы обернуть DEK нового поколения тем же).
enum Kek {
    Device(Zeroizing<[u8; 32]>),
    Pin { salt: Vec<u8>, iterations: u32, key: Zeroizing<[u8; 32]> },
}

impl Kek {
    fn wrap(&self, store_id: &[u8], generation: u32, dek: &[u8; 32]) -> Result<Wrap> {
        Ok(match self {
            Kek::Device(k) => Wrap {
                generation,
                kind: Some(wrap::Kind::Device(DeviceWrap { wrapped_dek: seal(k, &wrap_aad(store_id, generation, "device"), dek)? })),
            },
            Kek::Pin { salt, iterations, key } => Wrap {
                generation,
                kind: Some(wrap::Kind::Pin(PinWrap {
                    salt: salt.clone(),
                    iterations: *iterations,
                    wrapped_dek: seal(key, &wrap_aad(store_id, generation, "pin"), dek)?,
                    check: pin_check(key).to_vec(),
                })),
            },
        })
    }
}

fn unwrap_with(kek: &Kek, store_id: &[u8], w: &Wrap) -> Result<Dek> {
    let plain = match (kek, &w.kind) {
        (Kek::Device(k), Some(wrap::Kind::Device(d))) => open(k, &wrap_aad(store_id, w.generation, "device"), &d.wrapped_dek)?,
        (Kek::Pin { key, .. }, Some(wrap::Kind::Pin(p))) => {
            if p.check.as_slice() != pin_check(key).as_slice() {
                return Err(ProtoError::Crypto);
            }
            open(key, &wrap_aad(store_id, w.generation, "pin"), &p.wrapped_dek)?
        }
        _ => return Err(ProtoError::Crypto),
    };
    let arr: [u8; 32] = plain.as_slice().try_into().map_err(|_| ProtoError::Crypto)?;
    Ok(Zeroizing::new(arr))
}

/// Состояние открытия.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenState {
    Ready,
    /// DEK в памяти нет (PIN не введён / ключ устройства не подан).
    Locked,
    /// Формат новее известного: только чтение известных видов, пачек нет.
    TooNew,
}

/// Что хост должен сделать для переноса поколения.
#[derive(Debug, Clone, PartialEq)]
pub enum RotationAction {
    /// Прочитать и подать `rotation_loaded`.
    Read(StoreReads),
    /// Применить пачку одной транзакцией и подать `committed`.
    Write(StoreBatch),
    /// Шаг без ввода-вывода сделан — снова `rotation_next`.
    Continue,
    /// Перенос закончен (или не идёт).
    Done,
    /// Перенос остановлен: прежнее поколение активно, `pending` откатан; отчёт — ключи и причины.
    Aborted(Vec<String>),
}

/// Шаг автомата переноса.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// P1 → P2: удалить остатки нового поколения от прерванной попытки.
    Clear,
    /// P2: переписать записи g в g+1 пачками.
    Copy { after: String },
    /// P3: проверить g+1 — те же ключи, тот же открытый текст.
    Verify { after: String, count: usize },
    /// P4: переключить корень.
    Switch,
    /// P5: повторно открыть g+1 обёрткой из корня.
    Reopen,
    /// P6: удалить прежнее поколение пачками.
    Retire,
    /// Корень без уходящего поколения записан — конец.
    Finished,
    /// Остановлен: записать откат корня.
    Abort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiting {
    Nothing,
    Read(u64),
    Batch(u64),
}

struct Rotation {
    from: u32,
    to: u32,
    phase: Phase,
    waiting: Waiting,
    /// Готовая пачка, которую вернёт следующий `rotation_next`.
    outbox: Option<StoreBatch>,
    /// P2: `вид/имя` → SHA-256 открытого текста того, что должно лежать в g+1 (с учётом записей во время переноса).
    copied: std::collections::BTreeMap<String, [u8; 32]>,
    point: u8,
    errors: Vec<String>,
    aborted: bool,
}

impl Rotation {
    fn new(from: u32, to: u32, phase: Phase, point: u8) -> Rotation {
        Rotation {
            from,
            to,
            phase,
            waiting: Waiting::Nothing,
            outbox: None,
            copied: Default::default(),
            point,
            errors: vec![],
            aborted: false,
        }
    }
}

/// Открытое хранилище профиля.
pub struct Store {
    root: Root,
    state: OpenState,
    /// DEK по поколениям (активное и, при переносе, новое/уходящее).
    deks: Vec<(u32, Dek)>,
    kek: Option<Kek>,
    next_id: u64,
    batch_limit: u32,
    rotation: Option<Rotation>,
}

fn known_formats() -> Vec<KindFormat> {
    store_kinds::KINDS.iter().map(|(k, f)| KindFormat { kind: (*k).to_string(), format: *f }).collect()
}

fn too_new(root: &Root) -> bool {
    root.kinds_max_format.iter().any(|kf| store_kinds::format_of(&kf.kind).is_none_or(|known| kf.format > known))
}

fn plain_hash(plain: &[u8]) -> [u8; 32] {
    Sha256::digest(plain).into()
}

impl Store {
    /// Новый профиль: случайный `store_id`, поколение 1, новый DEK. Обёртку добавляет `wrap_device`.
    pub fn create() -> Store {
        Store {
            root: Root {
                store_id: random::<16>().to_vec(),
                active_generation: 1,
                pending_generation: 0,
                wraps: vec![],
                kinds_max_format: known_formats(),
                retiring_generation: 0,
            },
            state: OpenState::Ready,
            deks: vec![(1, Zeroizing::new(random::<32>()))],
            kek: None,
            next_id: 1,
            batch_limit: ROTATION_BATCH,
            rotation: None,
        }
    }

    /// Загрузить корень (байты записи `root`). Заблокировано до `unlock_*`; формат новее — `TooNew`.
    pub fn load(root_bytes: &[u8]) -> Result<Store> {
        let root: Root = decode_checked(root_bytes, Origin::Server)?;
        if root.store_id.len() != 16 || root.active_generation == 0 {
            return Err(ProtoError::Malformed);
        }
        let state = if too_new(&root) { OpenState::TooNew } else { OpenState::Locked };
        Ok(Store { root, state, deks: vec![], kek: None, next_id: 1, batch_limit: ROTATION_BATCH, rotation: None })
    }

    pub fn state(&self) -> OpenState {
        self.state
    }

    pub fn root(&self) -> &Root {
        &self.root
    }

    /// Записей в пачке переноса (тесты прерываний).
    pub fn set_batch_limit(&mut self, n: u32) {
        self.batch_limit = n.max(1);
    }

    fn dek(&self, generation: u32) -> Result<&[u8; 32]> {
        self.deks.iter().find(|(g, _)| *g == generation).map(|(_, d)| &**d).ok_or(ProtoError::Locked)
    }

    fn writable(&self) -> Result<()> {
        match self.state {
            OpenState::Ready => Ok(()),
            OpenState::TooNew => Err(ProtoError::TooNew),
            OpenState::Locked => Err(ProtoError::Locked),
        }
    }

    fn unlock(&mut self, kek: Kek) -> Result<()> {
        let mut deks = Vec::new();
        for w in &self.root.wraps {
            let live = w.generation == self.root.active_generation
                || (self.root.pending_generation != 0 && w.generation == self.root.pending_generation);
            if live {
                if let Ok(d) = unwrap_with(&kek, &self.root.store_id, w) {
                    deks.push((w.generation, d));
                }
            }
        }
        if !deks.iter().any(|(g, _)| *g == self.root.active_generation) {
            return Err(ProtoError::Crypto);
        }
        self.deks = deks;
        self.kek = Some(kek);
        if self.state == OpenState::Locked {
            self.state = OpenState::Ready;
        }
        self.resume_rotation();
        Ok(())
    }

    /// Открыть ключом устройства (обёртка `device`).
    pub fn unlock_device(&mut self, device_key: &[u8; 32]) -> Result<()> {
        self.unlock(Kek::Device(Zeroizing::new(*device_key)))
    }

    /// Открыть PIN (обёртка `pin`). Неверный PIN — `Crypto`.
    pub fn unlock_pin(&mut self, pin: &str) -> Result<()> {
        let w = self
            .root
            .wraps
            .iter()
            .find_map(|w| match &w.kind {
                Some(wrap::Kind::Pin(p)) if w.generation == self.root.active_generation => Some(p.clone()),
                _ => None,
            })
            .ok_or(ProtoError::Crypto)?;
        if !(PIN_ITERATIONS_MIN..=PIN_ITERATIONS_MAX).contains(&w.iterations) || w.salt.len() != 16 {
            return Err(ProtoError::Crypto);
        }
        let key = Zeroizing::new(pin_kek(pin, &w.salt, w.iterations));
        self.unlock(Kek::Pin { salt: w.salt, iterations: w.iterations, key })
    }

    /// Забыть DEK (блокировка).
    pub fn lock(&mut self) {
        self.deks.clear();
        self.kek = None;
        self.rotation = None;
        if self.state == OpenState::Ready {
            self.state = OpenState::Locked;
        }
    }

    fn batch(&mut self, puts: Vec<StorePut>, deletes: Vec<String>) -> StoreBatch {
        let id = self.next_id;
        self.next_id += 1;
        StoreBatch { batch_id: id, puts, deletes }
    }

    fn root_put(&self) -> StorePut {
        StorePut { key: ROOT_KEY.to_string(), value: self.root.encode_to_vec() }
    }

    /// Обёртки живых поколений новым KEK — пачка только с корнем.
    fn rewrap(&mut self, kek: Kek) -> Result<StoreBatch> {
        let mut wraps = Vec::new();
        for (g, d) in &self.deks {
            wraps.push(kek.wrap(&self.root.store_id, *g, d)?);
        }
        self.root.wraps = wraps;
        self.kek = Some(kek);
        let put = self.root_put();
        Ok(self.batch(vec![put], vec![]))
    }

    /// Обернуть DEK ключом устройства (новый профиль или снятие PIN) — пачка только с корнем.
    pub fn wrap_device(&mut self, device_key: &[u8; 32]) -> Result<StoreBatch> {
        self.writable()?;
        self.rewrap(Kek::Device(Zeroizing::new(*device_key)))
    }

    /// Установить или сменить PIN: обёртка `pin` вместо прежней — одной пачкой с корнем. Записи данных
    /// не трогаются (FR-021). Смена DEK поколением — `begin_rotation` следом (фоном).
    pub fn set_pin(&mut self, pin: &str) -> Result<StoreBatch> {
        self.set_pin_with_iterations(pin, PIN_ITERATIONS)
    }

    /// `set_pin` с числом итераций (тесты).
    pub fn set_pin_with_iterations(&mut self, pin: &str, iterations: u32) -> Result<StoreBatch> {
        self.writable()?;
        if pin.is_empty() || !(PIN_ITERATIONS_MIN..=PIN_ITERATIONS_MAX).contains(&iterations) {
            return Err(ProtoError::InvalidField("pin"));
        }
        let salt = random::<16>().to_vec();
        let key = Zeroizing::new(pin_kek(pin, &salt, iterations));
        self.rewrap(Kek::Pin { salt, iterations, key })
    }

    /// Снять PIN: обёртка `device` вместо `pin` — одной пачкой с корнем.
    pub fn remove_pin(&mut self, device_key: &[u8; 32]) -> Result<StoreBatch> {
        self.wrap_device(device_key)
    }

    /// Поколения, в которые пишется запись: активное и, при переносе (P1–P3), новое.
    fn write_generations(&self) -> Vec<u32> {
        let mut v = vec![self.root.active_generation];
        if self.root.pending_generation != 0 && self.dek(self.root.pending_generation).is_ok() {
            v.push(self.root.pending_generation);
        }
        v
    }

    fn sealed_put(&self, generation: u32, kind: &str, name: &str, plain: &[u8]) -> Result<StorePut> {
        let format = store_kinds::format_of(kind).ok_or(ProtoError::InvalidField("kind"))?;
        let st = seal_record(self.dek(generation)?, &self.root.store_id, format, kind, generation, name, plain)?;
        Ok(StorePut { key: record_key(generation, kind, name), value: st.encode_to_vec() })
    }

    /// Пачка записей и удалений (`(вид, имя, открытый текст)`, `(вид, имя)`). Во время переноса пишется
    /// в оба поколения — ничего не теряется при любом прерывании.
    pub fn write(&mut self, puts: &[(&str, &str, &[u8])], deletes: &[(&str, &str)]) -> Result<StoreBatch> {
        self.writable()?;
        let gens = self.write_generations();
        let mut p = Vec::new();
        let mut d = Vec::new();
        for g in &gens {
            for (kind, name) in deletes {
                d.push(record_key(*g, kind, name));
            }
            for (kind, name, plain) in puts {
                p.push(self.sealed_put(*g, kind, name, plain)?);
            }
        }
        if gens.len() > 1 {
            if let Some(r) = &mut self.rotation {
                for (kind, name) in deletes {
                    r.copied.remove(&format!("{kind}/{name}"));
                }
                for (kind, name, plain) in puts {
                    r.copied.insert(format!("{kind}/{name}"), plain_hash(plain));
                }
            }
        }
        Ok(self.batch(p, d))
    }

    /// Открыть запись по ключу носителя и значению.
    pub fn open(&self, key: &str, value: &[u8]) -> Result<Vec<u8>> {
        let (g, kind, name) = parse_key(key).ok_or(ProtoError::InvalidField("key"))?;
        let st: Stored = decode_checked(value, Origin::Server)?;
        let known = store_kinds::format_of(kind).ok_or(ProtoError::TooNew)?;
        if st.format > known {
            return Err(ProtoError::TooNew);
        }
        open_record(self.dek(g)?, &self.root.store_id, g, kind, name, &st)
    }

    /// Чтение записей активного поколения (страница после `after`, не больше `limit`).
    pub fn reads_active(&mut self, after: &str, limit: u32) -> StoreReads {
        let id = self.next_id;
        self.next_id += 1;
        StoreReads { read_id: id, keys: vec![], prefix: format!("g{}/", self.root.active_generation), after: after.to_string(), limit }
    }

    /// Хост зафиксировал пачку.
    pub fn committed(&mut self, batch_id: u64) -> Result<()> {
        if let Some(r) = &mut self.rotation {
            if r.waiting == Waiting::Batch(batch_id) {
                r.waiting = Waiting::Nothing;
            }
        }
        Ok(())
    }

    /// Хост не смог зафиксировать пачку (нет места, ошибка записи): перенос останавливается, активным
    /// остаётся прежнее поколение (FR-024). После переключения (P4–P6) удаление просто повторится.
    pub fn failed(&mut self, batch_id: u64, reason: &str) {
        if let Some(r) = &mut self.rotation {
            if r.waiting == Waiting::Batch(batch_id) {
                r.waiting = Waiting::Nothing;
                if r.point < 4 {
                    r.errors.push(format!("пачка {batch_id}: {reason}"));
                    r.phase = Phase::Abort;
                }
            }
        }
    }

    // ── перенос поколения ──────────────────────────────────────────────────────

    /// P1: новое поколение g+1 с новым DEK, его обёртка тем же ключом защиты — в корень.
    pub fn begin_rotation(&mut self) -> Result<StoreBatch> {
        self.writable()?;
        if self.root.pending_generation != 0 || self.root.retiring_generation != 0 {
            return Err(ProtoError::Duplicate);
        }
        let kek = self.kek.as_ref().ok_or(ProtoError::Locked)?;
        let from = self.root.active_generation;
        let to = from.checked_add(1).ok_or(ProtoError::InvalidField("generation"))?;
        let dek = Zeroizing::new(random::<32>());
        let w = kek.wrap(&self.root.store_id, to, &dek)?;
        self.root.wraps.retain(|x| x.generation != to);
        self.root.wraps.push(w);
        self.root.pending_generation = to;
        self.deks.retain(|(g, _)| *g != to);
        self.deks.push((to, dek));
        let puts = vec![self.root_put(), self.progress_put(from, to, 1, &[])?];
        let b = self.batch(puts, vec![]);
        let mut r = Rotation::new(from, to, Phase::Clear, 1);
        r.waiting = Waiting::Batch(b.batch_id);
        self.rotation = Some(r);
        Ok(b)
    }

    /// Номер точки (1–6), до которой перенос дошёл и которая зафиксирована у хоста; `None` — не идёт
    /// или ждёт хоста.
    pub fn rotation_point(&self) -> Option<u8> {
        self.rotation.as_ref().filter(|r| r.waiting == Waiting::Nothing && r.outbox.is_none() && !r.aborted).map(|r| r.point)
    }

    fn progress_put(&self, from: u32, to: u32, point: u32, errors: &[String]) -> Result<StorePut> {
        let p = MigrationProgress { from_generation: from, to_generation: to, point, errors: errors.iter().take(64).cloned().collect() };
        self.sealed_put(self.root.active_generation, PROGRESS_KIND, PROGRESS_NAME, &p.encode_to_vec())
    }

    /// После открытия: продолжить прерванный перенос (P1–P3 — заново с начала g+1, P4–P6 — удаление).
    fn resume_rotation(&mut self) {
        if self.state != OpenState::Ready {
            return;
        }
        let (active, pending, retiring) = (self.root.active_generation, self.root.pending_generation, self.root.retiring_generation);
        if pending != 0 {
            if self.dek(pending).is_ok() {
                self.rotation = Some(Rotation::new(active, pending, Phase::Clear, 1));
            } else {
                // Обёртка нового поколения не открылась: начать перенос заново (`begin_rotation`) — после
                // отката корня, который выпустит первый же `rotation_next`.
                let mut r = Rotation::new(active, pending, Phase::Abort, 1);
                r.errors.push(format!("g{pending}: обёртка не открывается"));
                self.rotation = Some(r);
            }
        } else if retiring != 0 {
            self.rotation = Some(Rotation::new(retiring, active, Phase::Retire, 5));
        }
    }

    fn rot(&mut self) -> Result<&mut Rotation> {
        self.rotation.as_mut().ok_or(ProtoError::InvalidField("rotation"))
    }

    fn queue(&mut self, puts: Vec<StorePut>, deletes: Vec<String>) -> Result<()> {
        let b = self.batch(puts, deletes);
        self.rot()?.outbox = Some(b);
        Ok(())
    }

    fn read(&mut self, prefix: String, after: String) -> Result<RotationAction> {
        let id = self.next_id;
        self.next_id += 1;
        let limit = self.batch_limit;
        self.rot()?.waiting = Waiting::Read(id);
        Ok(RotationAction::Read(StoreReads { read_id: id, keys: vec![], prefix, after, limit }))
    }

    fn abort_with(&mut self, errors: Vec<String>) -> Result<()> {
        let r = self.rot()?;
        r.errors.extend(errors);
        r.phase = Phase::Abort;
        Err(ProtoError::Crypto)
    }

    /// Следующее действие переноса.
    pub fn rotation_next(&mut self) -> Result<RotationAction> {
        let Some(r) = self.rotation.as_mut() else { return Ok(RotationAction::Done) };
        if r.waiting != Waiting::Nothing {
            return Err(ProtoError::InvalidField("rotation"));
        }
        if let Some(b) = r.outbox.take() {
            r.waiting = Waiting::Batch(b.batch_id);
            return Ok(RotationAction::Write(b));
        }
        if r.aborted {
            let errs = r.errors.clone();
            self.rotation = None;
            return Ok(RotationAction::Aborted(errs));
        }
        let (from, to, phase) = (r.from, r.to, r.phase.clone());
        match phase {
            Phase::Clear => self.read(format!("g{to}/"), String::new()),
            Phase::Copy { after } => self.read(format!("g{from}/"), after),
            Phase::Verify { after, .. } => self.read(format!("g{to}/"), after),
            Phase::Retire => self.read(format!("g{from}/"), String::new()),
            Phase::Switch => {
                // P4: атомарно — активное g+1, pending снят, уходящее g; обёртки — только g+1.
                self.root.active_generation = to;
                self.root.pending_generation = 0;
                self.root.retiring_generation = from;
                self.root.wraps.retain(|w| w.generation == to);
                let puts = vec![self.root_put(), self.progress_put(from, to, 4, &[])?];
                let r = self.rot()?;
                r.point = 4;
                r.phase = Phase::Reopen;
                self.queue(puts, vec![])?;
                self.rotation_next()
            }
            Phase::Reopen => {
                // P5: DEK нового поколения снова из обёртки корня — то же, что в памяти.
                let kek = self.kek.as_ref().ok_or(ProtoError::Locked)?;
                let w = self.root.wraps.iter().find(|w| w.generation == to).ok_or(ProtoError::Crypto)?;
                let again = unwrap_with(kek, &self.root.store_id, w)?;
                if again.as_slice() != self.dek(to)?.as_slice() {
                    return Err(ProtoError::Crypto);
                }
                let r = self.rot()?;
                r.point = 5;
                r.phase = Phase::Retire;
                Ok(RotationAction::Continue)
            }
            Phase::Finished => {
                self.rotation = None;
                Ok(RotationAction::Done)
            }
            Phase::Abort => {
                // Откат: прежнее поколение активно, pending и его обёртка сняты, скопированное удалено.
                self.root.pending_generation = 0;
                self.root.wraps.retain(|w| w.generation == from);
                self.deks.retain(|(g, _)| *g == from);
                let r = self.rot()?;
                let errs = r.errors.clone();
                let dels: Vec<String> = r.copied.keys().filter_map(|kn| kn.split_once('/')).map(|(k, n)| record_key(to, k, n)).collect();
                r.aborted = true;
                let puts = vec![self.root_put(), self.progress_put(from, to, 0, &errs)?];
                self.queue(puts, dels)?;
                self.rotation_next()
            }
        }
    }

    /// Прочитанное по последнему `Read` переноса.
    pub fn rotation_loaded(&mut self, loaded: StoreLoaded) -> Result<()> {
        let r = self.rot()?;
        if r.waiting != Waiting::Read(loaded.read_id) {
            return Err(ProtoError::InvalidField("read_id"));
        }
        r.waiting = Waiting::Nothing;
        let (from, to, phase) = (r.from, r.to, r.phase.clone());
        let full = loaded.entries.len() >= self.batch_limit as usize;
        let last = loaded.entries.last().map(|e| e.key.clone()).unwrap_or_default();
        match phase {
            Phase::Clear => {
                if loaded.entries.is_empty() {
                    let r = self.rot()?;
                    r.copied.clear();
                    r.phase = Phase::Copy { after: String::new() };
                } else {
                    // Удалённые ключи больше не прочитаются — следующая страница снова с начала.
                    self.queue(vec![], loaded.entries.into_iter().map(|e| e.key).collect())?;
                }
            }
            Phase::Copy { .. } => {
                let mut puts = Vec::new();
                let mut errors = Vec::new();
                let mut seen = Vec::new();
                for e in &loaded.entries {
                    let Some((_, kind, name)) = parse_key(&e.key) else { continue };
                    if kind == PROGRESS_KIND {
                        continue;
                    }
                    match self.open(&e.key, &e.value) {
                        Ok(plain) => {
                            seen.push((format!("{kind}/{name}"), plain_hash(&plain)));
                            puts.push(self.sealed_put(to, kind, name, &plain)?);
                        }
                        Err(err) => errors.push(format!("{}: {}", e.key, err.kind())),
                    }
                }
                if !errors.is_empty() {
                    return self.abort_with(errors);
                }
                let r = self.rot()?;
                r.copied.extend(seen);
                r.phase = if full { Phase::Copy { after: last } } else { Phase::Verify { after: String::new(), count: 0 } };
                if !puts.is_empty() {
                    r.point = r.point.max(2);
                    self.queue(puts, vec![])?;
                }
            }
            Phase::Verify { count, .. } => {
                let mut errors = Vec::new();
                let mut n = count;
                for e in &loaded.entries {
                    let Some((_, kind, name)) = parse_key(&e.key) else { continue };
                    if kind == PROGRESS_KIND {
                        continue;
                    }
                    n += 1;
                    let want = self.rotation.as_ref().and_then(|r| r.copied.get(&format!("{kind}/{name}"))).copied();
                    match (self.open(&e.key, &e.value), want) {
                        (Ok(plain), Some(h)) if h == plain_hash(&plain) => {}
                        (Err(err), _) => errors.push(format!("{}: {}", e.key, err.kind())),
                        _ => errors.push(format!("{}: не совпадает с g{from}", e.key)),
                    }
                }
                if !errors.is_empty() {
                    return self.abort_with(errors);
                }
                if full {
                    self.rot()?.phase = Phase::Verify { after: last, count: n };
                } else {
                    let expected = self.rot()?.copied.len();
                    if n != expected {
                        return self.abort_with(vec![format!("g{to}: записей {n}, ожидалось {expected}")]);
                    }
                    let r = self.rot()?;
                    r.point = r.point.max(3);
                    r.phase = Phase::Switch;
                }
            }
            Phase::Retire => {
                if loaded.entries.is_empty() {
                    self.root.retiring_generation = 0;
                    self.deks.retain(|(g, _)| *g == to);
                    let puts = vec![self.root_put(), self.progress_put(from, to, 6, &[])?];
                    self.rot()?.phase = Phase::Finished;
                    self.queue(puts, vec![])?;
                } else {
                    self.rot()?.point = 6;
                    self.queue(vec![], loaded.entries.into_iter().map(|e| e.key).collect())?;
                }
            }
            Phase::Switch | Phase::Reopen | Phase::Finished | Phase::Abort => return Err(ProtoError::InvalidField("rotation")),
        }
        Ok(())
    }
}
