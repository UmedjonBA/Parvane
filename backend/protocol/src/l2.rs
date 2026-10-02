//! L2-режим чата (T076, R16 «уровни защиты метаданных»): выравнивание
//! размеров sealed/групповых конвертов по сетке 512/2048/8192/32768 и полное
//! отключение эфемерных каналов (typing/presence) в чате.
//!
//! ## Согласование участниками
//!
//! Флаг — в состоянии чата у каждого участника (`L2State`), источник —
//! подписанные E2E-операции участников (сервер режима не знает). Предпочтение
//! каждого участника — LWW по его собственной метке времени: чужое
//! предпочтение участник изменить не может (его операции подписаны его ключом,
//! вызывающий кладёт сюда только проверенные движком операции).
//!
//! - Личный чат: режим активен, если его включил ХОТЯ БЫ ОДИН участник.
//!   Выравнивание делает отправитель, а защищает оно получателя: если бы
//!   требовалось согласие обоих, собеседник мог бы в одностороннем порядке
//!   оставить размеры своих сообщений Бобу открытыми.
//! - Группа: режим задаёт политика группы (запись журнала состояния
//!   `GroupChange.set_privacy_mode`, право — как у изменения сведений группы;
//!   здесь — вход `group_policy`), плюс личное предпочтение участника действует на ЕГО
//!   исходящие (`must_pad`): он выравнивает свои конверты, даже если группа
//!   в обычном режиме. Эфемерные каналы в группе выключаются только
//!   политикой (иначе один участник гасил бы «печатает» всем).
//!
//! ## Серверное округление `received_at` (решение)
//!
//! Сервер не знает, в каком режиме чат, и не должен узнавать: поле «L2» в
//! запросе доставки выдало бы, какие получатели/группы защищаются (а по
//! таймингу — и отправителя). Поэтому решение: messenger округляет время
//! приёма ВСЕХ sealed- и групповых записей журнала вниз до минуты
//! (`round_received_ms`, `RECEIVED_ROUNDING_MS`) — и в БД (`inbox_log.
//! received_at`), и в живом событии (`InboxRecord.received_ms`). Цена нулевая:
//! порядок записей задаёт `seq`, время показа — подписанный `ts_ms` внутри
//! операции отправителя; `received_ms` клиенту нужен только как запасной
//! ориентир. Выигрыш — секундные метки в дампе БД перестают совпадать с
//! временем соединений анонимного канала (корреляция по таймингу, R16).
//!
//! ## Клиентское ядро (T079)
//!
//! Состояние чатов ведёт `client.rs`: личный чат — содержимое `ChatMode`
//! (`Client::l2_set_direct`, входящее применяется в `open_record` и отдаётся
//! хосту событием — это видимое служебное сообщение), группа — поле `l2`
//! состояния группы плюс личное предпочтение устройства
//! (`Client::l2_set_group_pref`). Исходящие выравниваются там же.

use std::collections::BTreeMap;

use prost::Message;

use crate::pb::parvane::core::v2::{GroupEnvelopeInner, SealedInner};
use crate::seal;

/// Шаг округления времени приёма sealed/групповых записей на сервере.
pub const RECEIVED_ROUNDING_MS: i64 = 60_000;

/// Округлить время приёма вниз до минуты (сервер, все sealed/group-записи).
pub fn round_received_ms(ms: i64) -> i64 {
    ms.div_euclid(RECEIVED_ROUNDING_MS) * RECEIVED_ROUNDING_MS
}

/// Вид чата для согласования.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatKind {
    Direct,
    Group,
}

/// Предпочтение одного участника (LWW по его метке времени).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct L2Pref {
    pub enabled: bool,
    pub ts_ms: i64,
}

impl L2Pref {
    /// Новее ли `other`; при равных метках выигрывает включение (безопасная сторона).
    fn superseded_by(&self, other: &L2Pref) -> bool {
        other.ts_ms > self.ts_ms || (other.ts_ms == self.ts_ms && other.enabled && !self.enabled)
    }
}

/// Состояние L2 одного чата у клиента.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct L2State {
    pub kind: ChatKind,
    prefs: BTreeMap<String, L2Pref>,
    group_policy: L2Pref,
}

impl L2State {
    pub fn new(kind: ChatKind) -> Self {
        Self { kind, prefs: BTreeMap::new(), group_policy: L2Pref::default() }
    }

    /// Применить проверенное предпочтение участника `user`. true — изменилось.
    pub fn set_pref(&mut self, user: &str, pref: L2Pref) -> bool {
        match self.prefs.get(user) {
            Some(cur) if !cur.superseded_by(&pref) => false,
            _ => {
                self.prefs.insert(user.to_string(), pref);
                true
            }
        }
    }

    /// Политика группы (из журнала состояния, подписана администратором).
    pub fn set_group_policy(&mut self, pref: L2Pref) -> bool {
        if self.group_policy.superseded_by(&pref) {
            self.group_policy = pref;
            true
        } else {
            false
        }
    }

    /// Все предпочтения участников (для сохранения состояния клиента).
    pub fn prefs(&self) -> impl Iterator<Item = (&str, L2Pref)> {
        self.prefs.iter().map(|(u, p)| (u.as_str(), *p))
    }

    pub fn group_policy(&self) -> L2Pref {
        self.group_policy
    }

    pub fn pref(&self, user: &str) -> L2Pref {
        self.prefs.get(user).copied().unwrap_or_default()
    }

    /// Режим чата активен. Для личного чата учитываются только текущие
    /// участники (`participants`): предпочтение постороннего не действует.
    pub fn active(&self, participants: &[&str]) -> bool {
        match self.kind {
            ChatKind::Direct => participants.iter().any(|u| self.pref(u).enabled),
            ChatKind::Group => self.group_policy.enabled,
        }
    }

    /// Выравнивать ли исходящие `me`.
    pub fn must_pad(&self, me: &str, participants: &[&str]) -> bool {
        self.active(participants) || self.pref(me).enabled
    }

    /// Разрешены ли typing/presence в этом чате.
    pub fn ephemeral_allowed(&self, participants: &[&str]) -> bool {
        crate::ephemeral::allowed(self.active(participants))
    }
}

/// Присутствие пользователя — одно на аккаунт: публикуется, только если ни
/// в одном его чате L2 не активен (иначе «онлайн» за секунду до сообщения
/// в защищённом чате выдаёт тайминг).
pub fn presence_allowed(any_chat_l2: bool) -> bool {
    crate::ephemeral::allowed(any_chat_l2)
}

/// Выравнивание личного конверта (внутренний слой sealed) — `seal::pad_l2`.
pub fn pad_direct(inner: &mut SealedInner) {
    seal::pad_l2(inner);
}

/// Выравнивание группового конверта: `GroupEnvelopeInner.padding` так, чтобы
/// сериализация попала точно в сетку L2 (AEAD эпохи добавляет фиксированный
/// тег — длины шифртекстов в одной корзине равны). Правило заполнения —
/// `seal::l2_padding_len`, общее с личным конвертом.
pub fn pad_group(inner: &mut GroupEnvelopeInner) {
    inner.padding.clear();
    inner.padding = vec![0u8; seal::l2_padding_len(inner.encoded_len())];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_any_participant_enables() {
        let mut s = L2State::new(ChatKind::Direct);
        let p = ["a@x", "b@x"];
        assert!(!s.active(&p));
        assert!(s.set_pref("b@x", L2Pref { enabled: true, ts_ms: 10 }));
        assert!(s.active(&p) && !s.ephemeral_allowed(&p));
        assert!(s.must_pad("a@x", &p), "отправитель выравнивает по просьбе получателя");
        // Устаревшее выключение не действует; более новое — действует.
        assert!(!s.set_pref("b@x", L2Pref { enabled: false, ts_ms: 5 }));
        assert!(s.active(&p));
        assert!(s.set_pref("b@x", L2Pref { enabled: false, ts_ms: 20 }));
        assert!(!s.active(&p) && s.ephemeral_allowed(&p));
        // Равные метки — выигрывает включение.
        assert!(s.set_pref("b@x", L2Pref { enabled: true, ts_ms: 20 }));
        assert!(!s.set_pref("b@x", L2Pref { enabled: false, ts_ms: 20 }));
        // Посторонний (не участник) режим не включает.
        let mut t = L2State::new(ChatKind::Direct);
        t.set_pref("eve@x", L2Pref { enabled: true, ts_ms: 1 });
        assert!(!t.active(&p));
    }

    #[test]
    fn group_policy_and_personal_pad() {
        let mut s = L2State::new(ChatKind::Group);
        let p = ["a@x", "b@x", "c@x"];
        s.set_pref("a@x", L2Pref { enabled: true, ts_ms: 1 });
        assert!(!s.active(&p), "личное предпочтение не включает L2 всей группе");
        assert!(s.must_pad("a@x", &p) && !s.must_pad("b@x", &p));
        assert!(s.ephemeral_allowed(&p));
        assert!(s.set_group_policy(L2Pref { enabled: true, ts_ms: 2 }));
        assert!(s.active(&p) && s.must_pad("b@x", &p) && !s.ephemeral_allowed(&p));
        assert!(!s.set_group_policy(L2Pref { enabled: false, ts_ms: 1 }));
        assert!(!presence_allowed(true) && presence_allowed(false));
    }

    #[test]
    fn group_padding_hits_grid() {
        use crate::group::seal_envelope;
        use crate::pb::parvane::core::v2::Ref;
        let on_grid = |len: usize| seal::L2_BUCKETS.contains(&len) || (len > 32768 && len % 32768 == 0);
        for n in (0usize..700).chain(1800..2100).chain(7900..8300).chain(16000..16500).chain(32500..33000).chain([40000, 65400, 300000]) {
            let mut inner = GroupEnvelopeInner { megolm_session_id: vec![1; 43], megolm_message: vec![7; n], padding: vec![] };
            pad_group(&mut inner);
            let len = inner.encoded_len();
            assert!(on_grid(len), "{n} → {len}");
            assert!(crate::codec::decode_checked::<GroupEnvelopeInner>(&inner.encode_to_vec(), crate::limits::Origin::Client).is_ok(), "{n}");
        }
        // Два сообщения разной длины в одной корзине — один размер шифртекста.
        let key = crate::sign::generate_signing_key();
        let g = Ref { domain: "local".into(), id: vec![3; 16] };
        let mut a = GroupEnvelopeInner { megolm_session_id: vec![1; 43], megolm_message: vec![1; 20], padding: vec![] };
        let mut b = GroupEnvelopeInner { megolm_session_id: vec![1; 43], megolm_message: vec![1; 350], padding: vec![] };
        pad_group(&mut a);
        pad_group(&mut b);
        let ea = seal_envelope(&key, &[9; 32], &g, 1, &a).unwrap();
        let eb = seal_envelope(&key, &[9; 32], &g, 1, &b).unwrap();
        assert_eq!(ea.epoch_aead_ciphertext.len(), eb.epoch_aead_ciphertext.len());
        // Личный конверт — через seal::pad_l2.
        let mut si = SealedInner { olm_message: vec![1; 100], ..Default::default() };
        pad_direct(&mut si);
        assert_eq!(si.encoded_len(), 512);
    }

    #[test]
    fn received_rounding() {
        assert_eq!(round_received_ms(1_700_000_059_999), 1_700_000_040_000);
        assert_eq!(round_received_ms(120_000), 120_000);
        assert_eq!(round_received_ms(0), 0);
        assert_eq!(round_received_ms(-1), -60_000);
    }
}
