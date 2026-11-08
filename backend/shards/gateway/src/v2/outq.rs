//! S7-13: исходящая очередь v2-сессии с бюджетом в БАЙТАХ. Раньше очередь была ограничена числом кадров
//! (512), а кадр потока скачивания — до ~700 КБ: нечитающий клиент копил в памяти gateway сотни мегабайт на
//! соединение, и несколько таких соединений доводили gateway до OOM.
//!
//! Каждый кадр занимает в очереди свой размер (разрешения семафора на байты) до тех пор, пока писатель не
//! допишет его в сокет. Места нет дольше `send_timeout` — клиент не читает: очередь закрывается, а вместе с
//! ней и сессия (`serve` ждёт `wait_closed`). Писатель закрывает очередь сам, если запись в сокет не
//! укладывается в `WRITE_TIMEOUT_SECS` или сокет закрылся.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tracing::warn;

/// Бюджет очереди сессии по умолчанию (`PARVANE_GATEWAY_OUT_BUDGET_BYTES`).
pub(crate) const OUT_BUDGET_BYTES: usize = 16 * 1024 * 1024;
/// Сколько писатель ждёт записи одного кадра в сокет, прежде чем закрыть сессию.
pub(crate) const WRITE_TIMEOUT_SECS: u64 = 15;

pub(crate) fn out_budget_bytes() -> usize {
    std::env::var("PARVANE_GATEWAY_OUT_BUDGET_BYTES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 64 * 1024)
        .unwrap_or(OUT_BUDGET_BYTES)
        .min(u32::MAX as usize)
}

/// Кадр в очереди: байты и занятая ими часть бюджета (освобождается, когда кадр дописан).
pub(crate) struct OutFrame {
    pub bytes: Vec<u8>,
    pub permit: OwnedSemaphorePermit,
}

pub(crate) struct OutCloser {
    budget: Arc<Semaphore>,
    closed: Arc<watch::Sender<bool>>,
}

impl OutCloser {
    pub(crate) fn close(&self) {
        self.closed.send_replace(true);
        self.budget.close();
    }
}

#[derive(Clone)]
pub(crate) struct OutQueue {
    tx: mpsc::Sender<OutFrame>,
    budget: Arc<Semaphore>,
    max: usize,
    send_timeout: Duration,
    closed: Arc<watch::Sender<bool>>,
}

/// Очередь и её приёмник (для писателя). `frames` — потолок числа кадров, `budget` — байтов.
pub(crate) fn out_queue(frames: usize, budget: usize, send_timeout: Duration) -> (OutQueue, mpsc::Receiver<OutFrame>) {
    let (tx, rx) = mpsc::channel(frames.max(1));
    let budget = budget.clamp(1, u32::MAX as usize);
    let (closed, _) = watch::channel(false);
    (OutQueue { tx, budget: Arc::new(Semaphore::new(budget)), max: budget, send_timeout, closed: Arc::new(closed) }, rx)
}

impl OutQueue {
    /// Поставить кадр. `false` — очередь закрыта (клиент не читал дольше `send_timeout`, сокет закрыт).
    pub(crate) async fn send(&self, bytes: Vec<u8>) -> bool {
        if self.is_closed() {
            return false;
        }
        // Кадр крупнее всего бюджета (не бывает: кадр ≤ 4 МиБ) занимает весь бюджет.
        let need = bytes.len().clamp(1, self.max) as u32;
        let put = async {
            let permit = self.budget.clone().acquire_many_owned(need).await.ok()?;
            self.tx.send(OutFrame { bytes, permit }).await.ok()
        };
        match tokio::time::timeout(self.send_timeout, put).await {
            Ok(Some(())) => true,
            Ok(None) => {
                self.close();
                false
            }
            Err(_) => {
                warn!("v2: клиент не читает — исходящая очередь сессии полна, сессия закрывается (S7-13)");
                self.close();
                false
            }
        }
    }

    pub(crate) fn close(&self) {
        self.closed.send_replace(true);
        // Ждущие места отправители просыпаются с отказом.
        self.budget.close();
    }

    pub(crate) fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Дождаться закрытия очереди.
    pub(crate) async fn wait_closed(&self) {
        let mut rx = self.closed.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    /// Закрыватель очереди для писателя: без отправителя канала — иначе писатель держал бы канал открытым
    /// и не замечал конца сессии.
    pub(crate) fn closer(&self) -> OutCloser {
        OutCloser { budget: self.budget.clone(), closed: self.closed.clone() }
    }

    /// Байтов в очереди (кадры, ещё не дописанные в сокет).
    #[cfg(test)]
    pub(crate) fn queued_bytes(&self) -> usize {
        self.max - self.budget.available_permits()
    }
}
