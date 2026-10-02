//! Эфемерные каналы v2 в gateway (T077, T122; FR-013, R12, D-07; класс 2).
//!
//! Каналы — секретные 128-битные id (движок `parvane_protocol::ephemeral`),
//! payload запечатан на ключ канала; gateway пересылает байты, не зная ни
//! автора, ни содержимого. Права:
//! - `ephemeral.typing` (ID): знание id = право (id выводят только участники
//!   чата). Публиковать typing в канал, занятый чьим-то присутствием, нельзя
//!   (`FORBIDDEN`) — пространства не смешиваются;
//! - `ephemeral.presence` (ID): только в СВОЙ канал. Решение — правило «первая
//!   публикация связывает канал с пользователем» (в памяти, TTL 24 ч с
//!   последней публикации, ≤ 4 канала на пользователя для ротации). Почему не
//!   отдельный метод регистрации: gateway и так видит, кто публикует в канал
//!   (остаточная утечка R12), метод реестра добавил бы серверу знание канала
//!   ДО первой публикации и потребовал бы нового вызова во всех клиентах, а
//!   связывание по первой публикации даёт то же свойство — чужой (контакт,
//!   знающий id) опубликовать «присутствие» за владельца не может. После
//!   рестарта gateway связь строится заново; если канал успел занять
//!   контакт, клиент владельца получает `FORBIDDEN` и ротирует поколение
//!   канала (`EphChannel::presence(dk, generation + 1)`);
//! - `ephemeral.group_typing` (ANON): подпись ключом отправки ТЕКУЩЕЙ эпохи
//!   группы (запрос к messenger `v2.internal.messenger.group_epoch`), эпоха не
//!   устарела (после бана/исключения до новой эпохи — `EXPIRED`), nonce не
//!   повторялся. Посторонний (не участник эпохи) ключа не имеет → `FORBIDDEN`.
//!
//! Связи «канал → пользователь» хранятся только как ключевой хэш адреса
//! (SipHash со случайным ключом процесса), только в памяти, в журнал не пишутся.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::BuildHasher;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use parvane_protocol::pb::parvane::core::v2::ErrorCode;

/// Связь канала присутствия с владельцем живёт с последней публикации.
pub(crate) const PRESENCE_TTL: Duration = Duration::from_secs(24 * 3600);
/// Каналов присутствия на пользователя (текущий + ротации).
pub(crate) const MAX_PRESENCE_PER_USER: usize = 4;
/// Потолок таблиц (память gateway).
const MAX_BINDINGS: usize = 200_000;
/// Окно отказа повтора «печатает» группы.
pub(crate) const GROUP_NONCE_TTL: Duration = Duration::from_secs(120);
const MAX_NONCES: usize = 200_000;

type Owner = u64;

#[derive(Default)]
struct Inner {
    presence: HashMap<[u8; 16], (Owner, Instant)>,
    nonces: HashMap<Vec<u8>, Instant>,
}

/// Состояние эфемерных каналов gateway (общее на все сессии).
#[derive(Default)]
pub(crate) struct EphState {
    inner: Mutex<Inner>,
    keyed: RandomState,
}

fn channel(id: &[u8]) -> Result<[u8; 16], ErrorCode> {
    id.try_into().map_err(|_| ErrorCode::Invalid)
}

impl EphState {
    /// Публикация присутствия `user` в канал `id`.
    pub(crate) fn presence_publish(&self, id: &[u8], user: &str, now: Instant) -> Result<(), ErrorCode> {
        let id = channel(id)?;
        let me = self.keyed.hash_one(user);
        let mut g = self.inner.lock().map_err(|_| ErrorCode::Unavailable)?;
        match g.presence.get(&id) {
            Some((o, at)) if now.saturating_duration_since(*at) < PRESENCE_TTL => {
                if *o != me {
                    return Err(ErrorCode::Forbidden);
                }
            }
            _ => {
                // Новая связь: потолок на пользователя и на таблицу.
                let mine = g.presence.values().filter(|(o, at)| *o == me && now.saturating_duration_since(*at) < PRESENCE_TTL).count();
                if mine >= MAX_PRESENCE_PER_USER {
                    return Err(ErrorCode::Limit);
                }
                if g.presence.len() >= MAX_BINDINGS {
                    g.presence.retain(|_, (_, at)| now.saturating_duration_since(*at) < PRESENCE_TTL);
                    if g.presence.len() >= MAX_BINDINGS {
                        return Err(ErrorCode::Limit);
                    }
                }
            }
        }
        g.presence.insert(id, (me, now));
        Ok(())
    }

    /// Публикация «печатает» в канал `id`: не в чужой канал присутствия.
    pub(crate) fn typing_publish(&self, id: &[u8], now: Instant) -> Result<(), ErrorCode> {
        let id = channel(id)?;
        let g = self.inner.lock().map_err(|_| ErrorCode::Unavailable)?;
        match g.presence.get(&id) {
            Some((_, at)) if now.saturating_duration_since(*at) < PRESENCE_TTL => Err(ErrorCode::Forbidden),
            _ => Ok(()),
        }
    }

    /// Отказ повтора (группа, nonce) «печатает» группы в окне `GROUP_NONCE_TTL`.
    pub(crate) fn group_nonce_fresh(&self, group_id: &[u8], nonce: &[u8], now: Instant) -> Result<(), ErrorCode> {
        let mut key = group_id.to_vec();
        key.push(0);
        key.extend_from_slice(nonce);
        let mut g = self.inner.lock().map_err(|_| ErrorCode::Unavailable)?;
        if let Some(at) = g.nonces.get(&key) {
            if now.saturating_duration_since(*at) < GROUP_NONCE_TTL {
                return Err(ErrorCode::Duplicate);
            }
        }
        if g.nonces.len() >= MAX_NONCES {
            g.nonces.retain(|_, at| now.saturating_duration_since(*at) < GROUP_NONCE_TTL);
            if g.nonces.len() >= MAX_NONCES {
                return Err(ErrorCode::RateLimited);
            }
        }
        g.nonces.insert(key, now);
        Ok(())
    }
}
