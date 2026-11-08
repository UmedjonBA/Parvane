//! Рантайм методов протокола v2 для шардов (E1). Шард подписывается на
//! subject'ы своих методов из реестра (`parvane_protocol::schema::METHODS`,
//! shard == имя роли), получает `ShardRequest` от gateway, отвечает
//! `ShardResponse`. Текста ошибок клиенту нет — только `ErrorCode`
//! (инвариант 18); подробности — в `tracing` шарда.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use parvane_protocol::codec::decode_checked;
use parvane_protocol::limits::Origin;
use parvane_protocol::pb::parvane::core::v2::{shard_response, Error, ErrorCode, ShardRequest, ShardResponse};
use parvane_protocol::schema::{self, MethodInfo};
use prost::Message;
use tracing::{debug, error, warn};

/// Результат обработчика: байты ответа (тип — по реестру) или код ошибки.
pub type Reply = Result<Vec<u8>, ErrorCode>;
pub type BoxFut = Pin<Box<dyn Future<Output = Reply> + Send>>;
/// Обработчик: (метод, запрос) → ответ.
pub type Handler = Arc<dyn Fn(&'static MethodInfo, ShardRequest) -> BoxFut + Send + Sync>;

/// Свой домен сервера (`PARVANE_DOMAIN`, как у шардов: без `@`, нижний регистр, по умолчанию `local`).
pub fn own_domain() -> &'static str {
    static D: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    D.get_or_init(|| {
        let d = std::env::var("PARVANE_DOMAIN").unwrap_or_default().trim().trim_start_matches('@').to_lowercase();
        if d.is_empty() {
            "local".into()
        } else {
            d
        }
    })
}

fn domain_of(address: &str) -> String {
    address.rsplit_once('@').map(|(_, d)| d.to_ascii_lowercase()).unwrap_or_default()
}

/// S7-20 (защита в глубину): запрос, пересланный чужим сервером (`origin_domain` не пуст), — только метод с
/// `federated`, домен-источник не свой, а пользователь (если есть) — пользователь домена-источника. Иначе
/// взломанный шард federation действовал бы от имени наших пользователей, просто подставив `user`.
/// Остаток: запрос без `origin_domain` шард от запроса gateway не отличает (одна роль публикует оба вида) — это
/// закрыли бы только отдельные subject'ы для пересланных запросов.
pub fn check_origin(m: &MethodInfo, req: &ShardRequest, own: &str) -> Result<(), ErrorCode> {
    let origin = req.origin_domain.trim().to_ascii_lowercase();
    if origin.is_empty() {
        return Ok(());
    }
    if !m.federated || origin == own.to_ascii_lowercase() || req.operator || req.reauth_fresh || !req.token.is_empty() || !req.client_ip.is_empty() {
        return Err(ErrorCode::Forbidden);
    }
    if !req.user.is_empty() && domain_of(&req.user) != origin {
        return Err(ErrorCode::Forbidden);
    }
    Ok(())
}

/// Ключ доли обработчиков (CLD-05): у пересланного чужим сервером запроса адрес `user` придумывает тот сервер —
/// доля считается на весь домен-источник (S7-24).
pub fn slot_owner(req: &ShardRequest) -> String {
    if req.origin_domain.is_empty() {
        req.user.clone()
    } else {
        format!("@{}", req.origin_domain.to_ascii_lowercase())
    }
}

/// Методы роли `shard` из реестра.
pub fn methods_of(shard: &str) -> Vec<&'static MethodInfo> {
    schema::METHODS.iter().filter(|m| m.shard == shard).collect()
}

pub fn error_reply(code: ErrorCode) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Error(Error { code: code as i32, retry_after_ms: 0 })) }.encode_to_vec()
}

pub fn ok_reply(body: Vec<u8>) -> Vec<u8> {
    ShardResponse { result: Some(shard_response::Result::Ok(body)) }.encode_to_vec()
}

/// Разобрать тело запроса типа `M` с проверкой лимитов схемы.
pub fn body<M: Message + prost::Name + Default>(req: &ShardRequest) -> Result<M, ErrorCode> {
    decode_checked::<M>(&req.body, Origin::Client).map_err(|e| e.code())
}

/// Отказ по частоте с подсказкой, когда повторить.
pub fn rate_limited_reply(retry_after_ms: u32) -> Vec<u8> {
    ShardResponse {
        result: Some(shard_response::Result::Error(Error { code: ErrorCode::RateLimited as i32, retry_after_ms })),
    }
    .encode_to_vec()
}

/// Через сколько повторить запрос сверх доли владельца.
pub const OWNER_BUSY_RETRY_MS: u32 = 300;

/// CLD-05: справедливая доля обработчиков шарда — не больше `per_owner` запросов одного пользователя разом.
/// Без неё один-два аккаунта занимали все слоты (`concurrency`), и остальные ждали. Запрос сверх доли сразу
/// получает `RATE_LIMITED` (клиент повторяет), а не стоит в очереди. Анонимные запросы (пустой `user`)
/// долей не считаются — у них свои пределы (gateway по IP, слоты потоков ссылок).
pub struct OwnerSlots {
    per_owner: usize,
    busy: Mutex<HashMap<String, usize>>,
}

/// Занятый слот владельца; освобождается при удалении.
pub struct OwnerSlot {
    slots: Arc<OwnerSlots>,
    owner: String,
}

impl OwnerSlots {
    pub fn new(per_owner: usize) -> Arc<Self> {
        Arc::new(Self { per_owner: per_owner.max(1), busy: Mutex::new(HashMap::new()) })
    }

    /// Занять слот; `None` — доля владельца исчерпана. Для анонимного запроса — всегда `Some`.
    pub fn try_acquire(self: &Arc<Self>, owner: &str) -> Option<Option<OwnerSlot>> {
        if owner.is_empty() {
            return Some(None);
        }
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let n = busy.entry(owner.to_string()).or_insert(0);
        if *n >= self.per_owner {
            return None;
        }
        *n += 1;
        Some(Some(OwnerSlot { slots: self.clone(), owner: owner.to_string() }))
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.busy.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for OwnerSlot {
    fn drop(&mut self) {
        let mut busy = self.slots.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = busy.get_mut(&self.owner) {
            *n -= 1;
            if *n == 0 {
                busy.remove(&self.owner);
            }
        }
    }
}

/// Сколько запрос ждёт свободного места шарда и сколько живёт обработчик (зависший вызов не держит место вечно).
const PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
const HANDLER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// OPT-003: запросов в работе и в ожидании места на шард (`PARVANE_SHARD_QUEUE_TASKS`, по умолчанию — 4 × concurrency)
/// и их байтов (`PARVANE_SHARD_QUEUE_BYTES`, 64 МиБ). Сверх — сразу `RATE_LIMITED` из диспетчера, задача не создаётся.
const QUEUE_BYTES_DEFAULT: usize = 64 * 1024 * 1024;

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<usize>().ok()).filter(|v| *v > 0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// OPT-003: срок запроса истёк — отправитель (gateway, federation) ответа уже не ждёт. `deadline_ms = 0` — срока нет.
pub fn deadline_passed(req: &ShardRequest, now_ms: u64) -> bool {
    req.deadline_ms != 0 && now_ms >= req.deadline_ms
}

/// Сколько ещё можно ждать места для запроса: до его срока, но не дольше `cap`.
pub fn wait_budget(req: &ShardRequest, now_ms: u64, cap: std::time::Duration) -> std::time::Duration {
    if req.deadline_ms == 0 {
        return cap;
    }
    cap.min(std::time::Duration::from_millis(req.deadline_ms.saturating_sub(now_ms)))
}

/// OPT-003: допуск ДО `spawn` — сколько запросов шарда в работе и в ожидании и сколько в них байтов. Раньше задача
/// создавалась на каждое сообщение шины, и под перегрузкой в памяти копились тела запросов (до 4 МиБ каждое).
pub struct Admission {
    max_tasks: usize,
    max_bytes: usize,
    used: Mutex<(usize, usize)>,
}

/// Место запроса в допуске; освобождается, когда задача запроса закончилась.
pub struct Ticket {
    adm: Arc<Admission>,
    bytes: usize,
}

impl Admission {
    pub fn new(max_tasks: usize, max_bytes: usize) -> Arc<Self> {
        Arc::new(Self { max_tasks: max_tasks.max(1), max_bytes: max_bytes.max(1), used: Mutex::new((0, 0)) })
    }

    /// Пределы из окружения для шарда с `concurrency` обработчиками.
    pub fn from_env(concurrency: usize) -> Arc<Self> {
        let tasks = env_usize("PARVANE_SHARD_QUEUE_TASKS").unwrap_or(concurrency.max(1).saturating_mul(4));
        let bytes = env_usize("PARVANE_SHARD_QUEUE_BYTES").unwrap_or(QUEUE_BYTES_DEFAULT);
        Self::new(tasks, bytes)
    }

    /// Занять место; `None` — шард полон (задач или байтов). Запрос крупнее всего бюджета допускается только в
    /// пустой шард (иначе он не прошёл бы никогда).
    pub fn try_admit(self: &Arc<Self>, bytes: usize) -> Option<Ticket> {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        let (tasks, held) = *used;
        if tasks >= self.max_tasks || (held > 0 && held.saturating_add(bytes) > self.max_bytes) {
            return None;
        }
        *used = (tasks + 1, held.saturating_add(bytes));
        Some(Ticket { adm: self.clone(), bytes })
    }

    /// (запросов, байтов) в работе и в ожидании.
    pub fn in_use(&self) -> (usize, usize) {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut used = self.adm.used.lock().unwrap_or_else(|e| e.into_inner());
        used.0 = used.0.saturating_sub(1);
        used.1 = used.1.saturating_sub(self.bytes);
    }
}

/// Подписаться на все методы роли и обслуживать их параллельно (≤ `concurrency`).
pub async fn serve(nc: async_nats::Client, shard: &'static str, concurrency: usize, handler: Handler) -> Result<(), async_nats::SubscribeError> {
    serve_with(nc, shard, concurrency, None, handler).await
}

/// Обработать один допущенный запрос: место шарда (не дольше срока запроса), доля владельца, обработчик.
/// `None` — отвечать некому: срок истёк, пока запрос ждал места (OPT-003).
async fn run_request(
    m: &'static MethodInfo,
    req: ShardRequest,
    sem: Arc<tokio::sync::Semaphore>,
    owner_slots: Option<Arc<OwnerSlots>>,
    handler: Handler,
) -> Option<Vec<u8>> {
    let permit = match tokio::time::timeout(wait_budget(&req, now_ms(), PERMIT_WAIT), sem.acquire_owned()).await {
        Ok(Ok(p)) => p,
        Ok(Err(_)) => return None,
        Err(_) if deadline_passed(&req, now_ms()) => {
            debug!("v2 {}: срок запроса истёк в ожидании места — не выполняется", m.name);
            return None;
        }
        Err(_) => return Some(rate_limited_reply(OWNER_BUSY_RETRY_MS)),
    };
    let _permit = permit;
    if deadline_passed(&req, now_ms()) {
        debug!("v2 {}: срок запроса истёк до начала работы — не выполняется", m.name);
        return None;
    }
    if req.method != m.name {
        return Some(error_reply(ErrorCode::Invalid));
    }
    if check_origin(m, &req, own_domain()).is_err() {
        warn!("v2 {}: пересланный запрос не от пользователя домена-источника", m.name);
        return Some(error_reply(ErrorCode::Forbidden));
    }
    let slot = match &owner_slots {
        Some(slots) => slots.try_acquire(&slot_owner(&req)),
        None => Some(None),
    };
    let Some(_slot) = slot else {
        return Some(rate_limited_reply(OWNER_BUSY_RETRY_MS));
    };
    Some(match tokio::time::timeout(HANDLER_TIMEOUT, handler(m, req)).await {
        Ok(Ok(b)) => ok_reply(b),
        Ok(Err(code)) => error_reply(code),
        Err(_) => {
            error!("v2 {}: обработчик не уложился в {} с", m.name, HANDLER_TIMEOUT.as_secs());
            error_reply(ErrorCode::Unavailable)
        }
    })
}

/// То же с долей владельца (`OwnerSlots`, CLD-05).
pub async fn serve_with(
    nc: async_nats::Client,
    shard: &'static str,
    concurrency: usize,
    owner_slots: Option<Arc<OwnerSlots>>,
    handler: Handler,
) -> Result<(), async_nats::SubscribeError> {
    let mut streams = Vec::new();
    for m in methods_of(shard) {
        let sub = nc.subscribe(m.subject.to_string()).await?;
        streams.push(sub.map(move |msg| (m, msg)).boxed());
    }
    let mut all = futures::stream::select_all(streams);
    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
    let admission = Admission::from_env(concurrency);
    tokio::spawn(async move {
        while let Some((m, msg)) = all.next().await {
            let Some(reply) = msg.reply.clone() else {
                warn!("v2 {}: запрос без reply", m.name);
                continue;
            };
            let req = match decode_checked::<ShardRequest>(&msg.payload, Origin::Server) {
                Ok(req) => req,
                Err(e) => {
                    warn!("v2 {}: битый ShardRequest: {e}", m.name);
                    if let Err(e) = nc.publish(reply, error_reply(ErrorCode::Invalid).into()).await {
                        error!("v2 {}: ответ не отправлен: {e}", m.name);
                    }
                    continue;
                }
            };
            // OPT-003: отправитель уже не ждёт — ни задачи, ни ответа
            if deadline_passed(&req, now_ms()) {
                debug!("v2 {}: запрос пришёл после своего срока — отброшен", m.name);
                continue;
            }
            // OPT-003: допуск до spawn — сверх предела задач/байтов шарда сразу отказ, тело не копится в памяти
            let Some(ticket) = admission.try_admit(msg.payload.len()) else {
                warn!("v2 {}: шард перегружен — отказ до постановки в очередь", m.name);
                if let Err(e) = nc.publish(reply, rate_limited_reply(OWNER_BUSY_RETRY_MS).into()).await {
                    error!("v2 {}: ответ не отправлен: {e}", m.name);
                }
                continue;
            };
            drop(msg);
            let (sem, nc, handler, owner_slots) = (sem.clone(), nc.clone(), handler.clone(), owner_slots.clone());
            // Место ждём в задаче запроса, а не в диспетчере: один занятый шард не блокирует приём остальных
            // подписок; ожидание ограничено (сроком запроса и PERMIT_WAIT), потом RATE_LIMITED (A0022-1)
            tokio::spawn(async move {
                let _ticket = ticket;
                let Some(out) = run_request(m, req, sem, owner_slots, handler).await else { return };
                if let Err(e) = nc.publish(reply, out.into()).await {
                    error!("v2 {}: ответ не отправлен: {e}", m.name);
                }
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_slots_cap_each_owner_and_free_on_drop() {
        let slots = OwnerSlots::new(2);
        let a1 = slots.try_acquire("a@x").expect("первый слот");
        let a2 = slots.try_acquire("a@x").expect("второй слот");
        assert!(slots.try_acquire("a@x").is_none(), "третий запрос того же владельца — отказ");
        assert!(slots.try_acquire("b@x").is_some(), "у другого владельца своя доля");
        assert!(matches!(slots.try_acquire(""), Some(None)), "анонимный запрос долей не считается");
        drop(a1);
        assert!(slots.try_acquire("a@x").is_some(), "освобождённый слот снова доступен");
        drop(a2);
        assert_eq!(slots.tracked(), 0, "свободные владельцы не копятся в памяти");
    }

    #[test]
    fn admission_caps_tasks_and_bytes_and_frees_on_drop() {
        // OPT-003: допуск до spawn — не больше задач и байтов, чем задано; место возвращается по концу задачи
        let adm = Admission::new(2, 1000);
        let a = adm.try_admit(600).expect("первый");
        assert!(adm.try_admit(600).is_none(), "сверх бюджета байтов");
        let b = adm.try_admit(300).expect("в бюджете");
        assert!(adm.try_admit(1).is_none(), "сверх числа задач");
        assert_eq!(adm.in_use(), (2, 900));
        drop(a);
        drop(b);
        assert_eq!(adm.in_use(), (0, 0));
        let big = adm.try_admit(5000).expect("крупный запрос допускается в пустой шард");
        assert!(adm.try_admit(1).is_none());
        drop(big);
    }

    #[test]
    fn deadline_helpers() {
        let mut r = ShardRequest::default();
        assert!(!deadline_passed(&r, 10_000), "без срока не истекает");
        assert_eq!(wait_budget(&r, 10_000, std::time::Duration::from_secs(10)), std::time::Duration::from_secs(10));
        r.deadline_ms = 10_500;
        assert!(!deadline_passed(&r, 10_000));
        assert!(deadline_passed(&r, 10_500));
        assert_eq!(wait_budget(&r, 10_000, std::time::Duration::from_secs(10)), std::time::Duration::from_millis(500));
        assert_eq!(wait_budget(&r, 20_000, std::time::Duration::from_secs(10)), std::time::Duration::ZERO);
    }

    fn counting_handler(calls: Arc<std::sync::atomic::AtomicUsize>) -> Handler {
        Arc::new(move |_m: &'static MethodInfo, _r: ShardRequest| -> BoxFut {
            let calls = calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec![1])
            })
        })
    }

    /// OPT-003: шард не выполняет запрос, срок которого истёк, пока он ждал места, и не ждёт места дольше срока.
    #[tokio::test]
    async fn expired_request_is_not_executed() {
        let m = methods_of("identity").into_iter().next().expect("метод identity");
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let req = |deadline_ms: u64| ShardRequest { method: m.name.into(), deadline_ms, ..Default::default() };
        // Место занято: срок 300 мс — ждём не дольше срока, обработчик не зовётся, ответа нет
        let busy = Arc::new(tokio::sync::Semaphore::new(0));
        let t0 = std::time::Instant::now();
        let out = run_request(m, req(now_ms() + 300), busy.clone(), None, counting_handler(calls.clone())).await;
        assert!(out.is_none(), "отвечать некому");
        assert!(t0.elapsed() < std::time::Duration::from_secs(2), "ждали места дольше срока: {:?}", t0.elapsed());
        // Срок уже истёк — даже при свободном месте не выполняется
        let free = Arc::new(tokio::sync::Semaphore::new(1));
        assert!(run_request(m, req(now_ms().saturating_sub(1)), free.clone(), None, counting_handler(calls.clone())).await.is_none());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        // Срок не истёк / срока нет — выполняется
        assert!(run_request(m, req(now_ms() + 5_000), free.clone(), None, counting_handler(calls.clone())).await.is_some());
        assert!(run_request(m, req(0), free, None, counting_handler(calls.clone())).await.is_some());
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    fn method(name: &str) -> &'static MethodInfo {
        schema::METHODS.iter().find(|m| m.name == name).expect(name)
    }

    /// S7-20: пересланный запрос с `user` нашего домена (или домена, отличного от источника) — отказ во всех шардах;
    /// пользователь домена-источника и запрос без источника — как раньше.
    #[test]
    fn forwarded_request_must_come_from_origin_users() {
        let fed = method("domain.container.list");
        assert!(fed.federated);
        let req = |user: &str, origin: &str| ShardRequest { method: fed.name.into(), user: user.into(), origin_domain: origin.into(), ..Default::default() };
        assert_eq!(check_origin(fed, &req("alice@ours.example", "x.example"), "ours.example"), Err(ErrorCode::Forbidden), "наш пользователь от чужого сервера");
        assert_eq!(check_origin(fed, &req("bob@y.example", "x.example"), "ours.example"), Err(ErrorCode::Forbidden), "пользователь третьего домена");
        assert_eq!(check_origin(fed, &req("bob@ours.example", "ours.example"), "ours.example"), Err(ErrorCode::Forbidden), "источник — свой домен");
        assert_eq!(check_origin(fed, &req("bob@X.example", "x.example"), "ours.example"), Ok(()));
        assert_eq!(check_origin(fed, &req("", "x.example"), "ours.example"), Ok(()), "анонимный федеративный метод");
        assert_eq!(check_origin(fed, &req("alice@ours.example", ""), "ours.example"), Ok(()), "запрос gateway");
        let local_only = schema::METHODS.iter().find(|m| !m.federated && m.channel == 2).unwrap();
        let r = ShardRequest { method: local_only.name.into(), user: "bob@x.example".into(), origin_domain: "x.example".into(), ..Default::default() };
        assert_eq!(check_origin(local_only, &r, "ours.example"), Err(ErrorCode::Forbidden), "нефедеративный метод");
        let mut op = req("bob@x.example", "x.example");
        op.operator = true;
        assert_eq!(check_origin(fed, &op, "ours.example"), Err(ErrorCode::Forbidden), "права оператора с чужого сервера");
        // Доля обработчиков пересланного запроса — на домен-источник
        assert_eq!(slot_owner(&req("a1@x.example", "X.example")), "@x.example");
        assert_eq!(slot_owner(&req("a1@ours.example", "")), "a1@ours.example");
    }
}
