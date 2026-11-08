//! PV-010 / OPT-002: входящая сторона v2-сессии с бюджетом в БАЙТАХ. Раньше входящая очередь была ограничена только
//! числом кадров (512 по 4 МиБ): пока цикл `serve` стоял (полная исходящая очередь до 10 с, проверка Auth, reauth),
//! читатель принимал со скоростью сети — сотни мегабайт на соединение, и до входа тоже. Запросы, ушедшие в
//! задачи, вообще ничем не ограничивались, кроме корзин частоты.
//!
//! Каждый принятый кадр занимает свой размер в бюджете сессии и в общем бюджете процесса. Разрешение едет с
//! кадром: через очередь в `serve` и дальше в задачу запроса, и освобождается, когда запрос отвечен (или кадр
//! разобран без запроса). Пока места нет, читатель не читает сокет — обратное давление уходит в TCP.
//!
//! До входа (канал ID без `AuthOk`) бюджет сессии мал (`PRE_AUTH_BUDGET`): кадр больше `PRE_AUTH_MAX_FRAME`
//! ждёт входа несколько секунд (`PRE_AUTH_BIG_FRAME_WAIT`), потом соединение закрывается. Методы до входа (`session.issue`,
//! регистрация, описатель) — единицы килобайт. Анонимный канал получает полный бюджет сразу после Hello: его
//! запросы (запечатанная доставка) крупные, а входа у него не бывает.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

/// Бюджет сессии по умолчанию (`PARVANE_GATEWAY_IN_BUDGET_BYTES`): кадры в очереди + тела запросов в полёте.
pub(crate) const IN_BUDGET_BYTES: usize = 8 * 1024 * 1024;
/// Общий бюджет процесса по умолчанию (`PARVANE_GATEWAY_IN_GLOBAL_BYTES`) — у контейнера gateway `mem_limit 1g`.
pub(crate) const IN_GLOBAL_BYTES: usize = 256 * 1024 * 1024;
/// До входа: кадр не больше 64 КиБ, всего — 4 таких кадра.
pub(crate) const PRE_AUTH_MAX_FRAME: usize = 64 * 1024;
pub(crate) const PRE_AUTH_BUDGET: usize = 4 * PRE_AUTH_MAX_FRAME;
/// Ёмкость канала кадров (число кадров; основной предел — байты). Глубокая очередь перед последовательным
/// циклом `serve` ничего не даёт.
pub(crate) const IN_FRAMES: usize = 64;

fn env_bytes(name: &str, default: usize, min: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| *v >= min)
        .unwrap_or(default)
        .min(u32::MAX as usize)
}

pub(crate) fn in_budget_bytes() -> usize {
    // Не меньше одного кадра наибольшего размера, иначе такой кадр не прошёл бы никогда
    env_bytes("PARVANE_GATEWAY_IN_BUDGET_BYTES", IN_BUDGET_BYTES, crate::MAX_FRAME_BYTES)
}

pub(crate) fn in_global_bytes() -> usize {
    env_bytes("PARVANE_GATEWAY_IN_GLOBAL_BYTES", IN_GLOBAL_BYTES, crate::MAX_FRAME_BYTES)
}

/// Общий бюджет входящих байтов всех сессий процесса.
pub(crate) fn global_budget(bytes: usize) -> Arc<Semaphore> {
    Arc::new(Semaphore::new(bytes.clamp(1, u32::MAX as usize)))
}

/// Разрешение на байты кадра (сессия + процесс). Освобождается при удалении.
pub(crate) struct InPermit {
    _session: Option<OwnedSemaphorePermit>,
    _global: Option<OwnedSemaphorePermit>,
}

pub(crate) struct InFrame {
    pub bytes: Vec<u8>,
    pub permit: InPermit,
}

/// Бюджет одной сессии. Читатель берёт разрешение на каждый кадр (`admit`), `serve` открывает полный бюджет
/// после входа или Hello анонимного канала (`open`).
#[derive(Clone)]
pub(crate) struct InBudget {
    session: Arc<Semaphore>,
    global: Arc<Semaphore>,
    full: Arc<watch::Sender<bool>>,
    max: usize,
    global_max: usize,
    auth_wait: Duration,
}

impl InBudget {
    pub(crate) fn new(max: usize, global: Arc<Semaphore>, global_max: usize, auth_wait: Duration) -> Self {
        let max = max.clamp(PRE_AUTH_BUDGET, u32::MAX as usize);
        let (full, _) = watch::channel(false);
        Self {
            session: Arc::new(Semaphore::new(PRE_AUTH_BUDGET)),
            global,
            full: Arc::new(full),
            max,
            global_max: global_max.clamp(1, u32::MAX as usize),
            auth_wait,
        }
    }

    /// Сессия вошла (или это анонимный канал): полный бюджет. Повторный вызов ничего не меняет.
    pub(crate) fn open(&self) {
        if !self.full.send_replace(true) {
            self.session.add_permits(self.max - PRE_AUTH_BUDGET);
        }
    }

    pub(crate) fn is_open(&self) -> bool {
        *self.full.borrow()
    }

    /// Разрешение на кадр длиной `len`. Ждёт места (обратное давление); `None` — сессию закрыть: кадр до входа
    /// больше `PRE_AUTH_MAX_FRAME`, а вход не состоялся за `auth_wait`, либо бюджет закрыт.
    pub(crate) async fn admit(&self, len: usize) -> Option<InPermit> {
        if len > PRE_AUTH_MAX_FRAME && !self.is_open() {
            // Клиент мог прислать запрос сразу за Auth, не дожидаясь AuthOk: ждём входа, но недолго
            let mut rx = self.full.subscribe();
            if !matches!(tokio::time::timeout(self.auth_wait, rx.wait_for(|f| *f)).await, Ok(Ok(_))) {
                return None;
            }
        }
        let s = self.session.clone().acquire_many_owned(len.clamp(1, self.max) as u32).await.ok()?;
        let g = self.global.clone().acquire_many_owned(len.clamp(1, self.global_max) as u32).await.ok()?;
        Some(InPermit { _session: Some(s), _global: Some(g) })
    }

    /// Конец сессии: ждущий места читатель просыпается с отказом.
    pub(crate) fn close(&self) {
        self.session.close();
    }

    /// Байтов сессии занято сейчас (кадры в очереди и запросы в полёте).
    #[cfg(test)]
    pub(crate) fn used(&self) -> usize {
        let cap = if self.is_open() { self.max } else { PRE_AUTH_BUDGET };
        cap - self.session.available_permits()
    }
}
