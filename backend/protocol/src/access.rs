//! Право доставки на стороне клиента (T075, T120, T121, T124; R6, R7; D-05,
//! D-06, D-11). Всё без ввода-вывода: решения принимает ядро, хост только
//! открывает соединения и передаёт байты.
//!
//! - [`OwnDeliveryKey`] — свой ключ доступа к доставке, его поколение и учёт,
//!   кому из собеседников раздано текущее поколение. Ротация (отзыв
//!   устройства, блокировка) → новое поколение, раздача только оставшимся.
//! - [`TokenStock`] — запас слепых жетонов: срок по ключу выпуска, трата из
//!   запаса, пополнение партией раз в сутки со случайной задержкой (не по
//!   требованию перед отправкой незнакомцу — иначе выдача связывается с
//!   тратой по времени).
//! - [`AnonPlanner`] — какому запросу анонимного канала какое соединение:
//!   одно соединение — один получатель (серия ≤ 60 с), копии своим
//!   устройствам и публичные запросы — отдельными соединениями, без
//!   TLS-resumption с идентифицированной сессией.

use std::collections::BTreeMap;

use prost::Message;

use crate::error::{ProtoError, Result};
use crate::pb::parvane::core::v2::{AnonToken, TokenKey};
use crate::pb::parvane::msg::v2 as mpb;

pub const DAY_MS: i64 = 86_400_000;

fn rand_u64() -> u64 {
    rand::RngCore::next_u64(&mut rand::rngs::OsRng)
}

fn rand32() -> [u8; 32] {
    let mut k = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k);
    k
}

// ── ключ доступа к доставке (T075) ──────────────────────────────────────────

/// Свой ключ доступа к доставке (общий для устройств пользователя).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnDeliveryKey {
    key: [u8; 32],
    generation: u64,
    /// Собеседник → поколение, которое ему раздано.
    shared: BTreeMap<String, u64>,
}

impl Default for OwnDeliveryKey {
    fn default() -> Self {
        Self::new()
    }
}

impl OwnDeliveryKey {
    pub fn new() -> Self {
        Self { key: rand32(), generation: 1, shared: BTreeMap::new() }
    }

    /// Восстановить (экспорт состояния / грант линковки).
    pub fn from_parts(key: [u8; 32], generation: u64, shared: BTreeMap<String, u64>) -> Self {
        Self { key, generation, shared }
    }

    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn shared(&self) -> &BTreeMap<String, u64> {
        &self.shared
    }

    /// Собеседнику нужно раздать текущее поколение.
    pub fn needs_share(&self, peer: &str) -> bool {
        self.shared.get(peer) != Some(&self.generation)
    }

    pub fn mark_shared(&mut self, peer: &str) {
        self.shared.insert(peer.to_string(), self.generation);
    }

    /// Больше не раздавать (блокировка, удаление контакта).
    pub fn forget(&mut self, peer: &str) {
        self.shared.remove(peer);
    }

    /// Новый ключ (D-11: отозванное устройство знало старый). Возвращает
    /// собеседников, которым раздавалось прежнее поколение, кроме
    /// `exclude`, — им новый ключ раздаётся сразу, остальным — с первым
    /// сообщением.
    pub fn rotate(&mut self, exclude: &[String]) -> Vec<String> {
        self.key = rand32();
        self.generation += 1;
        for e in exclude {
            self.shared.remove(e);
        }
        self.shared.keys().cloned().collect()
    }

    /// Принять ключ от своего другого устройства (более новое поколение).
    pub fn adopt(&mut self, key: &[u8], generation: u64) -> bool {
        let Ok(k) = <[u8; 32]>::try_from(key) else { return false };
        if generation <= self.generation {
            return false;
        }
        self.key = k;
        self.generation = generation;
        true
    }
}

// ── запас жетонов (T075, T121) ──────────────────────────────────────────────

/// Порог «жетонов мало» (UI/диагностика; пополнение всё равно по расписанию).
pub const LOW_WATERMARK: usize = 10;
/// Максимальная случайная задержка суточной партии.
pub const REFILL_JITTER_MAX_MS: i64 = 6 * 3_600_000;
/// Жетон, истекающий раньше этого запаса, не тратится (не успеет дойти).
pub const EXPIRY_MARGIN_MS: i64 = 60_000;

/// Время следующей партии: начало следующих суток (UTC) + случайная задержка
/// `jitter_ms` (приводится в `[0, REFILL_JITTER_MAX_MS)`).
pub fn next_refill_at(now_ms: i64, jitter_ms: i64) -> i64 {
    let next_day = (now_ms.div_euclid(DAY_MS) + 1) * DAY_MS;
    next_day + jitter_ms.rem_euclid(REFILL_JITTER_MAX_MS)
}

/// Случайная задержка партии.
pub fn random_jitter() -> i64 {
    i64::try_from(rand_u64() % REFILL_JITTER_MAX_MS.unsigned_abs()).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
struct Stocked {
    token: AnonToken,
    valid_until_ms: i64,
}

/// Запас слепых жетонов клиента.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TokenStock {
    tokens: Vec<Stocked>,
    /// Время следующей партии (None — ещё не получали: первая партия сразу).
    next_refill_ms: Option<i64>,
}

impl TokenStock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Добавить партию, действующую до `valid_until_ms` (срок ключа выпуска).
    pub fn add(&mut self, tokens: Vec<AnonToken>, valid_until_ms: i64) {
        self.tokens.extend(tokens.into_iter().map(|token| Stocked { token, valid_until_ms }));
    }

    /// Жетоны с их сроком (для экспорта).
    pub fn entries(&self) -> impl Iterator<Item = (&AnonToken, i64)> {
        self.tokens.iter().map(|s| (&s.token, s.valid_until_ms))
    }

    /// Выбросить истёкшие.
    pub fn prune(&mut self, now_ms: i64) {
        self.tokens.retain(|s| s.valid_until_ms > now_ms.saturating_add(EXPIRY_MARGIN_MS));
    }

    /// Выбросить жетоны ключей, которых нет в списке, полученном анонимно
    /// (ключ выведен сервером из приёма).
    pub fn retain_keys(&mut self, keys: &[TokenKey]) {
        self.tokens.retain(|s| keys.iter().any(|k| k.key_id == s.token.key_id));
    }

    /// Действующих жетонов.
    pub fn len(&self, now_ms: i64) -> usize {
        self.tokens.iter().filter(|s| s.valid_until_ms > now_ms.saturating_add(EXPIRY_MARGIN_MS)).count()
    }

    pub fn is_empty(&self, now_ms: i64) -> bool {
        self.len(now_ms) == 0
    }

    pub fn is_low(&self, now_ms: i64) -> bool {
        self.len(now_ms) < LOW_WATERMARK
    }

    /// Потратить жетон: сначала истекающий раньше.
    pub fn take(&mut self, now_ms: i64) -> Option<AnonToken> {
        self.prune(now_ms);
        let idx = self.tokens.iter().enumerate().min_by_key(|(_, s)| s.valid_until_ms).map(|(i, _)| i)?;
        Some(self.tokens.swap_remove(idx).token)
    }

    /// Вернуть жетон, который не ушёл (запрос не отправлен вовсе). Жетон,
    /// дошедший до сервера, не возвращается: повтор — DUPLICATE.
    pub fn put_back(&mut self, token: AnonToken, valid_until_ms: i64) {
        self.tokens.push(Stocked { token, valid_until_ms });
    }

    /// Пора получать партию (хост вызывает по таймеру, не перед отправкой).
    pub fn refill_due(&self, now_ms: i64) -> bool {
        self.next_refill_ms.is_none_or(|t| now_ms >= t)
    }

    pub fn next_refill_ms(&self) -> Option<i64> {
        self.next_refill_ms
    }

    /// Партия получена (или попытка провалилась) — следующая через сутки со
    /// случайной задержкой.
    pub fn schedule_next(&mut self, now_ms: i64, jitter_ms: i64) -> i64 {
        let t = next_refill_at(now_ms, jitter_ms);
        self.next_refill_ms = Some(t);
        t
    }

    pub fn set_next_refill(&mut self, t: Option<i64>) {
        self.next_refill_ms = t;
    }

    /// Размер партии: вся суточная квота (одинаковая для всех аккаунтов).
    pub fn batch_size(&self) -> usize {
        crate::tokens::DAILY_LIMIT
    }
}

// ── соединения анонимного канала (T120) ─────────────────────────────────────

/// Сколько держать соединение для серии запросов одному получателю.
pub const ANON_SERIES_MS: i64 = 60_000;

/// Кому адресовано соединение анонимного канала.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnonTarget {
    /// Устройства одного пользователя (`msg.deliver_sealed`, звонки).
    User(String),
    /// Групповой конверт группы.
    Group(Vec<u8>),
    /// Публичный запрос (список ключей жетонов, бандл, журнал): одноразовое
    /// соединение, закрыть после ответа.
    Public,
}

/// Соединение, выбранное для запроса.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnonAssignment {
    /// Номер соединения (у хоста — своё WS-соединение ANONYMOUS_DELIVERY).
    pub conn: u64,
    /// Открыть новое соединение (без TLS-resumption/0-RTT, общих с
    /// идентифицированной сессией, и с фиксированным ClientInfo).
    pub open: bool,
    /// Закрыть сразу после ответа.
    pub close_after: bool,
}

#[derive(Debug, Clone)]
struct AnonConn {
    id: u64,
    target: AnonTarget,
    opened_ms: i64,
}

/// Планировщик соединений анонимного канала (sans-IO).
#[derive(Debug, Default)]
pub struct AnonPlanner {
    conns: Vec<AnonConn>,
    next_id: u64,
}

/// Получатель запроса анонимного канала по методу и телу.
pub fn anon_target(method: &str, body: &[u8]) -> Result<AnonTarget> {
    match method {
        "msg.deliver_sealed" => {
            let r = mpb::DeliverSealedRequest::decode(body).map_err(|_| ProtoError::Malformed)?;
            let first = r.envelopes.first().and_then(|e| e.recipient.as_ref()).ok_or(ProtoError::InvalidField("recipient"))?;
            // D-05: один пользователь-получатель на запрос.
            if r.envelopes.iter().any(|e| e.recipient.as_ref().map(|x| &x.address) != Some(&first.address)) {
                return Err(ProtoError::InvalidField("recipient"));
            }
            Ok(AnonTarget::User(first.address.clone()))
        }
        "msg.deliver_group" => {
            let r = mpb::DeliverGroupRequest::decode(body).map_err(|_| ProtoError::Malformed)?;
            let g = r.envelope.and_then(|e| e.group).ok_or(ProtoError::InvalidField("group"))?;
            Ok(AnonTarget::Group(g.id))
        }
        _ => Ok(AnonTarget::Public),
    }
}

impl AnonPlanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Соединение для запроса к `target` в момент `now_ms`. Соединение
    /// переиспользуется только тем же получателем и только в пределах серии
    /// (60 с с открытия); публичные запросы — всегда новое одноразовое.
    pub fn assign(&mut self, target: AnonTarget, now_ms: i64) -> AnonAssignment {
        if target != AnonTarget::Public {
            if let Some(c) = self.conns.iter().find(|c| c.target == target && now_ms - c.opened_ms < ANON_SERIES_MS) {
                return AnonAssignment { conn: c.id, open: false, close_after: false };
            }
        }
        self.next_id += 1;
        let id = self.next_id;
        let public = target == AnonTarget::Public;
        if !public {
            // Прежнее соединение этого получателя (серия истекла) не переиспользуется.
            self.conns.retain(|c| c.target != target);
            self.conns.push(AnonConn { id, target, opened_ms: now_ms });
        }
        AnonAssignment { conn: id, open: true, close_after: public }
    }

    /// Разложить запросы по соединениям. Идентифицированные запросы не
    /// принимаются (им здесь не место).
    pub fn plan(&mut self, reqs: &[(&'static str, &[u8])], now_ms: i64) -> Result<Vec<AnonAssignment>> {
        reqs.iter().map(|(m, b)| anon_target(m, b).map(|t| self.assign(t, now_ms))).collect()
    }

    /// Соединения, серия которых истекла, — хосту закрыть.
    pub fn expired(&mut self, now_ms: i64) -> Vec<u64> {
        let (old, keep): (Vec<_>, Vec<_>) = self.conns.drain(..).partition(|c| now_ms - c.opened_ms >= ANON_SERIES_MS);
        self.conns = keep;
        old.into_iter().map(|c| c.id).collect()
    }

    /// Хост сообщил о закрытии соединения (обрыв/таймаут).
    pub fn closed(&mut self, conn: u64) {
        self.conns.retain(|c| c.id != conn);
    }

    /// Открытых соединений (для тестов/диагностики).
    pub fn open_count(&self) -> usize {
        self.conns.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pb::parvane::core::v2::{DeviceRef, GroupEnvelope, Ref, SealedEnvelope};

    fn sealed_to(users: &[(&str, &str)]) -> Vec<u8> {
        mpb::DeliverSealedRequest {
            envelopes: users
                .iter()
                .map(|(u, d)| SealedEnvelope { recipient: Some(DeviceRef { address: (*u).into(), device_id: (*d).into() }), ..Default::default() })
                .collect(),
        }
        .encode_to_vec()
    }

    #[test]
    fn delivery_key_rotation_shares_to_remaining() {
        let mut k = OwnDeliveryKey::new();
        let old = *k.key();
        assert!(k.needs_share("bob@x"));
        k.mark_shared("bob@x");
        k.mark_shared("carol@x");
        assert!(!k.needs_share("bob@x"));
        let targets = k.rotate(&["carol@x".to_string()]);
        assert_ne!(*k.key(), old);
        assert_eq!(k.generation(), 2);
        assert_eq!(targets, vec!["bob@x".to_string()]);
        assert!(k.needs_share("bob@x"));
        // Своё другое устройство принимает только более новое поколение.
        let mut other = OwnDeliveryKey::from_parts(old, 1, BTreeMap::new());
        assert!(other.adopt(k.key(), 2));
        assert!(!other.adopt(&old, 1));
        assert_eq!(other.key(), k.key());
    }

    fn tok(n: u8) -> AnonToken {
        AnonToken { key_id: vec![n; 32], nonce: vec![n; 32], ..Default::default() }
    }

    #[test]
    fn token_stock_expiry_and_order() {
        let mut s = TokenStock::new();
        s.add(vec![tok(1), tok(1)], 10 * DAY_MS);
        s.add(vec![tok(2)], 2 * DAY_MS);
        assert_eq!(s.len(DAY_MS), 3);
        // Сначала истекающий раньше.
        assert_eq!(s.take(DAY_MS).unwrap().key_id, vec![2; 32]);
        // Истёкшие не тратятся.
        s.add(vec![tok(3)], DAY_MS + 1000);
        assert_eq!(s.take(DAY_MS).unwrap().key_id, vec![1; 32]);
        assert_eq!(s.len(DAY_MS), 1);
        assert!(s.is_low(DAY_MS));
        s.retain_keys(&[]);
        assert!(s.is_empty(DAY_MS));
        assert!(s.take(DAY_MS).is_none());
    }

    #[test]
    fn refill_once_a_day_with_jitter() {
        let mut s = TokenStock::new();
        let now = 100 * DAY_MS + 5 * 3_600_000;
        assert!(s.refill_due(now), "первая партия — сразу");
        let t = s.schedule_next(now, 1_234_567);
        assert_eq!(t, 101 * DAY_MS + 1_234_567);
        assert!(!s.refill_due(now + 3_600_000));
        assert!(!s.refill_due(101 * DAY_MS));
        assert!(s.refill_due(t));
        // Задержка всегда в пределах окна; разные клиенты — разное время.
        for _ in 0..100 {
            let j = random_jitter();
            assert!((0..REFILL_JITTER_MAX_MS).contains(&j));
            let at = next_refill_at(now, j);
            assert!((101 * DAY_MS..101 * DAY_MS + REFILL_JITTER_MAX_MS).contains(&at));
        }
        assert_eq!(next_refill_at(now, -1), 101 * DAY_MS + REFILL_JITTER_MAX_MS - 1);
        assert_eq!(s.batch_size(), crate::tokens::DAILY_LIMIT);
    }

    #[test]
    fn planner_connection_per_recipient() {
        let mut p = AnonPlanner::new();
        let bob = sealed_to(&[("bob@x", "b1"), ("bob@x", "b2")]);
        let own = sealed_to(&[("alice@x", "a2")]);
        let carol = sealed_to(&[("carol@x", "c1")]);
        let a = p.plan(&[("msg.deliver_sealed", &bob), ("msg.deliver_sealed", &own), ("msg.deliver_sealed", &carol)], 0).unwrap();
        // Разные получатели (в т.ч. свои устройства) — разные новые соединения.
        assert!(a.iter().all(|x| x.open && !x.close_after));
        assert_ne!(a[0].conn, a[1].conn);
        assert_ne!(a[1].conn, a[2].conn);
        assert_ne!(a[0].conn, a[2].conn);
        // Серия тому же получателю в пределах 60 с — то же соединение.
        let b = p.plan(&[("msg.deliver_sealed", &bob)], 59_999).unwrap();
        assert_eq!(b[0], AnonAssignment { conn: a[0].conn, open: false, close_after: false });
        // После 60 с — новое, старое закрывается.
        let c = p.plan(&[("msg.deliver_sealed", &bob)], 60_000).unwrap();
        assert!(c[0].open);
        assert_ne!(c[0].conn, a[0].conn);
        let exp = p.expired(60_000);
        assert!(exp.contains(&a[1].conn) && exp.contains(&a[2].conn));
        assert!(!exp.contains(&c[0].conn));
        assert_eq!(p.open_count(), 1);
        p.closed(c[0].conn);
        assert_eq!(p.open_count(), 0);
    }

    #[test]
    fn planner_rejects_mixed_recipients_and_isolates_public() {
        let mut p = AnonPlanner::new();
        let mixed = sealed_to(&[("bob@x", "b1"), ("alice@x", "a2")]);
        assert_eq!(p.plan(&[("msg.deliver_sealed", &mixed)], 0), Err(ProtoError::InvalidField("recipient")));
        let empty = sealed_to(&[]);
        assert!(p.plan(&[("msg.deliver_sealed", &empty)], 0).is_err());
        // Публичные запросы — каждый раз новое одноразовое соединение.
        let a = p.plan(&[("identity.tokens.key_list", &[]), ("identity.tokens.key_list", &[])], 0).unwrap();
        assert!(a.iter().all(|x| x.open && x.close_after));
        assert_ne!(a[0].conn, a[1].conn);
        assert_eq!(p.open_count(), 0);
        // Групповой конверт — соединение группы, не пользователя.
        let g = mpb::DeliverGroupRequest { envelope: Some(GroupEnvelope { group: Some(Ref { domain: "x".into(), id: vec![1; 32] }), ..Default::default() }) }.encode_to_vec();
        let bob = sealed_to(&[("bob@x", "b1")]);
        let r = p.plan(&[("msg.deliver_group", &g), ("msg.deliver_sealed", &bob), ("msg.deliver_group", &g)], 0).unwrap();
        assert_ne!(r[0].conn, r[1].conn);
        assert_eq!(r[0].conn, r[2].conn);
    }
}
