//! Звонки протокола v2 (spec 007, T078; класс 6, 11, 13; D-05, D-08).
//!
//! `call.signal_sealed` / `call.ring_sealed` (ANON; второй — первый сигнал
//! звонка, Offer, отдельным методом ради лимитов): сигналы (SDP/ICE/отбой) — содержимое
//! sealed-конвертов устройствам ОДНОГО адресата; сервер не видит ни типа
//! сигнала, ни SDP, ни отправителя. Подпись сигнала — SignedOp с
//! `target` = звонок (call_id) и `audience` = устройства адресата (класс 6),
//! её проверяет получатель.
//!
//! Решения:
//! - **Доставка — живым событием** в журналы устройств адресата
//!   (`v2.inbox.<token>`, `InboxRecord.seq = 0`), без записи в БД и без
//!   messenger. Сигнализация имеет смысл только в реальном времени: SDP-offer
//!   и десятки ICE-кандидатов в 30-дневном журнале раздували бы его и
//!   хранили бы на сервере тайминги звонков (D-08: серверной истории звонков
//!   в v2 нет — она в личном состоянии пользователя, R10). Офлайн-устройство
//!   звонок не получает; «пропущенный» звонивший фиксирует обычным
//!   sealed-сообщением (`msg.deliver_sealed`) — оно попадает в журнал.
//! - **Право доставки** — ключ доступа (delivery key) адресата, как у
//!   `msg.deliver_sealed` (сверка SHA-256 в identity, кэш 60 с). Слепые жетоны
//!   незнакомцев для звонков не принимаются (`FORBIDDEN`): жетон одноразовый,
//!   а звонок — это десятки сигналов; незнакомец сначала пишет сообщение, и
//!   адресат, ответив, передаёт ему ключ доступа (это и есть «звонки от
//!   контактов» по умолчанию; `calls_from = NOBODY` соблюдает клиент адресата).
//! - **Лимиты без знания отправителя** (P-35): cooldown вызова 5 с — на
//!   анонимное соединение в gateway (`call.ring_sealed`); «≤ 3 одновременных
//!   ringing» — на АДРЕСАТА: не больше 3 вызовов за окно 60 с
//!   (дольше клиент не звонит); общий поток сигналов адресату — token bucket.
//!   Состояние лимитов — только в памяти, ключ — адрес адресата.
//! - `call.ice_config` (ID): STUN/TURN с эфемерными кредами TURN REST, как v1.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_nats::Client;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::call::v2 as cpb;
use parvane_protocol::pb::parvane::core::v2::{
    sealed_envelope::Access, DeliveryKeyCheckRequest, DeliveryKeyCheckResponse, DevicesOfRequest, DevicesOfResponse,
    ErrorCode, SealedEnvelope, ShardRequest,
};
use parvane_protocol::pb::parvane::msg::v2::{inbox_record, InboxRecord};
use parvane_protocol::registry_gen::{inbox_subject, INTERNAL_DELIVERY_KEY_CHECK, INTERNAL_DEVICES_OF};
use parvane_protocol::schema::MethodInfo;
use parvane_v2rt::{body, BoxFut, Reply};
use prost::Message as _;
use sha2::{Digest, Sha256};
use tracing::{debug, error, info, warn};

use crate::IceConfig;

/// Окно «звонит» (клиент прекращает вызов раньше).
pub(crate) const RINGING_WINDOW: Duration = Duration::from_secs(60);
/// Одновременно звонящих одному адресату.
pub(crate) const MAX_RINGING_PER_RECIPIENT: usize = 3;
const DK_CACHE_TTL: Duration = Duration::from_secs(60);
const DEVICES_TTL: Duration = Duration::from_secs(30);
const MAX_CACHE: usize = 50_000;

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Лимиты на адресата (память).
pub(crate) struct RecipientLimits {
    burst: f64,
    per_sec: f64,
    map: HashMap<String, RecipientState>,
}

struct RecipientState {
    tokens: f64,
    at: Instant,
    rings: VecDeque<Instant>,
}

impl RecipientLimits {
    pub(crate) fn new(burst: f64, per_sec: f64) -> Self {
        Self { burst, per_sec, map: HashMap::new() }
    }

    pub(crate) fn from_env() -> Self {
        // ICE-кандидатов на звонок — десятки; всплеск с запасом на 3 звонка.
        Self::new(env_f64("PARVANE_CALL_V2_RECIPIENT_BURST", 200.0), env_f64("PARVANE_CALL_V2_RECIPIENT_PER_SEC", 20.0))
    }

    /// Допустить сигнал адресату `user`; `ring` — первый сигнал звонка.
    pub(crate) fn allow(&mut self, user: &str, ring: bool, now: Instant) -> Result<(), ErrorCode> {
        if self.map.len() > MAX_CACHE {
            let (burst, window) = (self.burst, RINGING_WINDOW);
            self.map.retain(|_, s| s.tokens < burst || s.rings.back().is_some_and(|t| now.saturating_duration_since(*t) < window));
        }
        let s = self.map.entry(user.to_string()).or_insert(RecipientState { tokens: self.burst, at: now, rings: VecDeque::new() });
        let dt = now.saturating_duration_since(s.at).as_secs_f64();
        s.tokens = (s.tokens + dt * self.per_sec).min(self.burst);
        s.at = now;
        while s.rings.front().is_some_and(|t| now.saturating_duration_since(*t) >= RINGING_WINDOW) {
            s.rings.pop_front();
        }
        if ring && s.rings.len() >= MAX_RINGING_PER_RECIPIENT {
            return Err(ErrorCode::RateLimited);
        }
        if s.tokens < 1.0 {
            return Err(ErrorCode::RateLimited);
        }
        s.tokens -= 1.0;
        if ring {
            s.rings.push_back(now);
        }
        Ok(())
    }
}

pub(crate) struct CallV2 {
    nc: Client,
    ice: Arc<IceConfig>,
    limits: Mutex<RecipientLimits>,
    dk_ok: Mutex<HashMap<(String, [u8; 32]), Instant>>,
    devices: Mutex<HashMap<String, (Instant, DevicesOfResponse)>>,
}

pub(crate) async fn run(nc: Client, ice: Arc<IceConfig>) -> anyhow::Result<()> {
    let ctx = Arc::new(CallV2 {
        nc: nc.clone(),
        ice,
        limits: Mutex::new(RecipientLimits::from_env()),
        dk_ok: Mutex::new(HashMap::new()),
        devices: Mutex::new(HashMap::new()),
    });
    let handler: parvane_v2rt::Handler = Arc::new(move |m: &'static MethodInfo, req: ShardRequest| -> BoxFut {
        let ctx = ctx.clone();
        Box::pin(async move { dispatch(&ctx, m, req).await })
    });
    let concurrency = std::env::var("PARVANE_HANDLER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(64);
    parvane_v2rt::serve(nc, "call", concurrency, handler).await?;
    info!("call: методы v2 подключены");
    Ok(())
}

async fn dispatch(ctx: &CallV2, m: &'static MethodInfo, req: ShardRequest) -> Reply {
    match m.name {
        "call.signal_sealed" | "call.ring_sealed" => {
            // ANON: личности в запросе нет по построению (gateway); если есть — отказ.
            if !req.user.is_empty() || !req.token.is_empty() {
                return Err(ErrorCode::Forbidden);
            }
            if m.name == "call.ring_sealed" {
                let r: cpb::RingSealedRequest = body(&req)?;
                let delivered = ctx.signal_sealed(r.envelopes, true).await?;
                Ok(cpb::RingSealedResponse { delivered }.encode_to_vec())
            } else {
                let r: cpb::SignalSealedRequest = body(&req)?;
                let delivered = ctx.signal_sealed(r.envelopes, false).await?;
                Ok(cpb::SignalSealedResponse { delivered }.encode_to_vec())
            }
        }
        "call.ice_config" => {
            if req.user.is_empty() || req.device_id.is_empty() {
                return Err(ErrorCode::Forbidden);
            }
            let _: cpb::IceConfigRequest = body(&req)?;
            Ok(ice_response(&ctx.ice, &req.user, crate::now_unix()).encode_to_vec())
        }
        _ => Err(ErrorCode::Unavailable),
    }
}

/// ICE-конфигурация v2 из v1-логики (STUN + эфемерные TURN-креды).
pub(crate) fn ice_response(ice: &IceConfig, user: &str, now: i64) -> cpb::IceConfigResponse {
    let v1 = ice.build_response(user, now);
    let servers = v1
        .ice_servers
        .into_iter()
        .take(8)
        .map(|s| cpb::IceServer { urls: s.urls.into_iter().take(8).collect(), username: s.username.unwrap_or_default(), credential: s.credential.unwrap_or_default() })
        .collect();
    cpb::IceConfigResponse { servers, expires_ms: (now + v1.ttl_secs as i64) * 1000 }
}

/// Домен этого сервера (`PARVANE_DOMAIN`, как в identity/messenger).
fn server_domain() -> String {
    std::env::var("PARVANE_DOMAIN")
        .ok()
        .map(|d| d.trim().trim_start_matches('@').to_lowercase())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "local".to_string())
}

/// Проверка запроса: один адресат, одно доказательство права (D-05).
pub(crate) fn check_envelopes(envs: &[SealedEnvelope]) -> Result<(String, Access), ErrorCode> {
    let first = envs.first().ok_or(ErrorCode::Invalid)?;
    let user = first.recipient.as_ref().ok_or(ErrorCode::Invalid)?.address.clone();
    let access = first.access.clone().ok_or(ErrorCode::Forbidden)?;
    for e in envs {
        let rc = e.recipient.as_ref().ok_or(ErrorCode::Invalid)?;
        parvane_protocol::address::check_device(rc).map_err(|_| ErrorCode::Invalid)?;
        if rc.address != user || e.access.as_ref() != Some(&access) {
            return Err(ErrorCode::Invalid);
        }
        if e.hpke_enc.len() != 32 || e.ciphertext.is_empty() {
            return Err(ErrorCode::Invalid);
        }
    }
    Ok((user, access))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl CallV2 {
    /// Опубликовать сигнал устройствам адресата; `ring` — первый сигнал звонка.
    async fn signal_sealed(&self, envelopes: Vec<SealedEnvelope>, ring: bool) -> Result<u32, ErrorCode> {
        let (user, access) = check_envelopes(&envelopes)?;
        let domain = parvane_protocol::address::address_domain(&user).ok_or(ErrorCode::Invalid)?;
        if domain != server_domain() {
            return Err(ErrorCode::FederationUnavailable);
        }
        // Право — до лимитов: без ключа нельзя выбрать чужой бюджет адресата.
        match access {
            Access::DeliveryKey(k) => self.check_delivery_key(&user, &k).await?,
            Access::AnonToken(_) => return Err(ErrorCode::Forbidden),
        }
        self.limits.lock().map_err(|_| ErrorCode::Unavailable)?.allow(&user, ring, Instant::now())?;
        let devs = self.devices_of(&user).await?;
        let mut delivered = 0u32;
        for mut e in envelopes {
            let Some(rc) = e.recipient.clone() else { continue };
            if !devs.v2_device_ids.contains(&rc.device_id) {
                continue;
            }
            // C2-03 (R7): ключ доставки проверен выше — в живое событие не уходит.
            e.access = None;
            let Ok(subject) = inbox_subject(&user, &rc.device_id) else { continue };
            // seq = 0: живое событие, в журнал не записано.
            let rec = InboxRecord { seq: 0, received_ms: now_ms(), item: Some(inbox_record::Item::Sealed(e)) };
            match self.nc.publish(subject, rec.encode_to_vec().into()).await {
                Ok(()) => delivered += 1,
                Err(e) => warn!("call v2: сигнал не опубликован: {}", e),
            }
        }
        debug!("call v2: сигнал опубликован на {} устройств", delivered);
        Ok(delivered)
    }

    async fn check_delivery_key(&self, user: &str, key: &[u8]) -> Result<(), ErrorCode> {
        if key.len() != 32 {
            return Err(ErrorCode::Invalid);
        }
        let hash: [u8; 32] = Sha256::digest(key).into();
        let ck = (user.to_string(), hash);
        if let Ok(g) = self.dk_ok.lock() {
            if g.get(&ck).is_some_and(|at| at.elapsed() < DK_CACHE_TTL) {
                return Ok(());
            }
        }
        let req = DeliveryKeyCheckRequest { user: user.to_string(), key_hash: hash.to_vec() }.encode_to_vec();
        let reply = tokio::time::timeout(Duration::from_secs(3), self.nc.request(INTERNAL_DELIVERY_KEY_CHECK.to_string(), req.into()))
            .await
            .map_err(|_| ErrorCode::Unavailable)?
            .map_err(|e| {
                error!("call v2: identity недоступен: {}", e);
                ErrorCode::Unavailable
            })?;
        let r = decode_checked::<DeliveryKeyCheckResponse>(&reply.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
        if !r.key_ok {
            return Err(ErrorCode::Forbidden);
        }
        if let Ok(mut g) = self.dk_ok.lock() {
            if g.len() > MAX_CACHE {
                g.clear();
            }
            g.insert(ck, Instant::now());
        }
        Ok(())
    }

    async fn devices_of(&self, user: &str) -> Result<DevicesOfResponse, ErrorCode> {
        if let Ok(g) = self.devices.lock() {
            if let Some((at, d)) = g.get(user) {
                if at.elapsed() < DEVICES_TTL {
                    return Ok(d.clone());
                }
            }
        }
        let req = DevicesOfRequest { user: user.to_string() }.encode_to_vec();
        let reply = tokio::time::timeout(Duration::from_secs(3), self.nc.request(INTERNAL_DEVICES_OF.to_string(), req.into()))
            .await
            .map_err(|_| ErrorCode::Unavailable)?
            .map_err(|e| {
                error!("call v2: identity недоступен: {}", e);
                ErrorCode::Unavailable
            })?;
        let d = decode_checked::<DevicesOfResponse>(&reply.payload, Origin::Server).map_err(|_| ErrorCode::Unavailable)?;
        if let Ok(mut g) = self.devices.lock() {
            if g.len() > MAX_CACHE {
                g.clear();
            }
            g.insert(user.to_string(), (Instant::now(), d.clone()));
        }
        Ok(d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parvane_protocol::pb::parvane::core::v2::DeviceRef;

    fn env(addr: &str, dev: &str, key: u8) -> SealedEnvelope {
        SealedEnvelope {
            recipient: Some(DeviceRef { address: addr.into(), device_id: dev.into() }),
            access: Some(Access::DeliveryKey(vec![key; 32])),
            hpke_enc: vec![1; 32],
            ciphertext: vec![2; 10],
        }
    }

    #[test]
    fn one_recipient_one_access() {
        assert_eq!(check_envelopes(&[env("bob@local", "d1", 1), env("bob@local", "d2", 1)]).map(|x| x.0), Ok("bob@local".to_string()));
        assert_eq!(check_envelopes(&[env("bob@local", "d1", 1), env("alice@local", "d1", 1)]).unwrap_err(), ErrorCode::Invalid);
        assert_eq!(check_envelopes(&[env("bob@local", "d1", 1), env("bob@local", "d2", 2)]).unwrap_err(), ErrorCode::Invalid);
        assert_eq!(check_envelopes(&[]).unwrap_err(), ErrorCode::Invalid);
        let mut bad = env("bob@local", "d1", 1);
        bad.hpke_enc = vec![1; 31];
        assert_eq!(check_envelopes(&[bad]).unwrap_err(), ErrorCode::Invalid);
        let mut inj = env("bob.*@local", "d1", 1);
        inj.recipient = Some(DeviceRef { address: "bob>@local".into(), device_id: "d1".into() });
        assert_eq!(check_envelopes(&[inj]).unwrap_err(), ErrorCode::Invalid);
        let mut none = env("bob@local", "d1", 1);
        none.access = None;
        assert_eq!(check_envelopes(&[none]).unwrap_err(), ErrorCode::Forbidden);
    }

    #[test]
    fn at_most_three_ringing_per_recipient() {
        let mut l = RecipientLimits::new(200.0, 20.0);
        let t0 = Instant::now();
        for _ in 0..MAX_RINGING_PER_RECIPIENT {
            assert_eq!(l.allow("bob@local", true, t0), Ok(()));
        }
        assert_eq!(l.allow("bob@local", true, t0), Err(ErrorCode::RateLimited));
        // Не-вызовы (ICE, ответ) того же адресата проходят; другой адресат — независим.
        assert_eq!(l.allow("bob@local", false, t0), Ok(()));
        assert_eq!(l.allow("carol@local", true, t0), Ok(()));
        // Окно истекло — снова можно.
        assert_eq!(l.allow("bob@local", true, t0 + RINGING_WINDOW), Ok(()));
    }

    #[test]
    fn signal_flood_per_recipient() {
        let mut l = RecipientLimits::new(10.0, 1.0);
        let t0 = Instant::now();
        for _ in 0..10 {
            assert_eq!(l.allow("bob@local", false, t0), Ok(()));
        }
        assert_eq!(l.allow("bob@local", false, t0), Err(ErrorCode::RateLimited));
        assert_eq!(l.allow("bob@local", false, t0 + Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn ice_v2_matches_v1() {
        let ice = IceConfig { stun_urls: vec!["stun:s:3478".into()], turn_urls: vec!["turn:t:3478".into()], turn_secret: Some("north".into()), ttl_secs: 600 };
        let r = ice_response(&ice, "alice@local", 1_700_000_000);
        assert_eq!(r.servers.len(), 2);
        assert_eq!(r.servers[1].username, "1700000600:alice@local");
        assert_eq!(r.servers[1].credential, crate::turn_rest_credential("north", "1700000600:alice@local"));
        assert_eq!(r.expires_ms, 1_700_000_600_000);
        assert!(r.servers[0].username.is_empty());
    }
}
