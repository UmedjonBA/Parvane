//! Тесты допуска v2 (T034 — reauth, класс 15; T035 — классы частоты; D-05 —
//! ANON только в анонимном канале).

use super::limits::{admit, Access, V2Rate};
use parvane_protocol::pb::parvane::core::v2::{Channel, ErrorCode};
use parvane_protocol::schema::method;

fn id_session(authed: bool) -> Access {
    Access { channel: Channel::Identified, authed, operator: false, reauth_until_ms: 0 }
}

#[test]
fn channels() {
    let pre = method("identity.session.issue").unwrap();
    let id = method("msg.inbox.sync").unwrap();
    let anon = method("msg.deliver_sealed").unwrap();
    let anon_sess = Access { channel: Channel::AnonymousDelivery, authed: false, operator: false, reauth_until_ms: 0 };
    assert_eq!(admit(pre, &id_session(false), 0), Ok(()));
    assert_eq!(admit(pre, &id_session(true), 0), Ok(()));
    assert_eq!(admit(id, &id_session(false), 0), Err(ErrorCode::Forbidden));
    assert_eq!(admit(id, &id_session(true), 0), Ok(()));
    // D-05: ANON-метод в идентифицированной сессии и наоборот.
    assert_eq!(admit(anon, &id_session(true), 0), Err(ErrorCode::Forbidden));
    assert_eq!(admit(anon, &anon_sess, 0), Ok(()));
    assert_eq!(admit(pre, &anon_sess, 0), Err(ErrorCode::Forbidden));
    assert_eq!(admit(id, &anon_sess, 0), Err(ErrorCode::Forbidden));
}

#[test]
fn reauth_required_for_dangerous_methods() {
    let revoke = method("identity.device.revoke").unwrap();
    let mut a = id_session(true);
    assert_eq!(admit(revoke, &a, 1_000), Err(ErrorCode::ReauthRequired));
    a.reauth_until_ms = 2_000;
    assert_eq!(admit(revoke, &a, 1_000), Ok(()));
    assert_eq!(admit(revoke, &a, 2_001), Err(ErrorCode::ReauthRequired));
    for name in ["identity.account.set_2fa", "identity.account.change_password", "identity.root.rotate"] {
        assert_eq!(admit(method(name).unwrap(), &id_session(true), 1), Err(ErrorCode::ReauthRequired), "{name}");
    }
}

#[test]
fn operator_only() {
    let stats = method("server.stats.versions").unwrap();
    let mut a = id_session(true);
    assert_eq!(admit(stats, &a, 0), Err(ErrorCode::Forbidden));
    a.operator = true;
    assert_eq!(admit(stats, &a, 0), Ok(()));
}

#[test]
fn rate_classes_burst_then_limit() {
    let mut r = V2Rate::from_env();
    // msg: всплеск 30.
    for _ in 0..30 {
        assert!(r.allow(1).is_ok());
    }
    let wait = r.allow(1).unwrap_err();
    assert!(wait > 0 && wait <= 1000);
    // Классы независимы.
    assert!(r.allow(3).is_ok());
    for _ in 0..60 {
        assert!(r.allow(4).is_ok());
    }
    assert!(r.allow(4).is_err());
}

// ── T070/T120: анонимный канал (D-05, инвариант 25) ─────────────────────────

mod anon_hygiene {
    use super::super::anon::{self, SessionIdentity, CH_ANON, CH_ID, CH_PRE, KIND_SUBSCRIBE};
    use parvane_protocol::pb::parvane::call::v2::{RingSealedRequest, SignalSealedRequest};
    use parvane_protocol::pb::parvane::core::v2::{sealed_envelope::Access, Channel, DeviceRef, ErrorCode, SealedEnvelope};
    use parvane_protocol::pb::parvane::msg::v2::DeliverSealedRequest;
    use parvane_protocol::schema::{method, METHODS};
    use prost::Message;

    /// Сессия, в которой «всё известно» — даже если бы код по ошибке
    /// заполнил личность анонимного соединения, в шину она не уйдёт.
    fn full() -> SessionIdentity<'static> {
        SessionIdentity { user: "alice@local", device: "d1", token: "eyJ.secret.jwt", client_ip: "203.0.113.7", reauth_fresh: true, operator: true }
    }

    #[test]
    fn anon_methods_carry_no_identity() {
        let anon: Vec<_> = METHODS.iter().filter(|m| m.channel == CH_ANON).collect();
        assert!(anon.iter().any(|m| m.name == "msg.deliver_sealed"));
        assert!(anon.iter().any(|m| m.name == "call.signal_sealed"));
        assert!(anon.iter().any(|m| m.name == "call.ring_sealed"));
        assert!(anon.iter().any(|m| m.name == "ephemeral.group_typing"));
        for m in anon {
            let r = anon::shard_request(m, &full(), vec![1, 2, 3]);
            assert!(r.user.is_empty() && r.device_id.is_empty() && r.token.is_empty() && r.client_ip.is_empty(), "{}", m.name);
            assert!(!r.reauth_fresh && !r.operator, "{}", m.name);
            // Сериализованный запрос не содержит ни токена, ни адреса, ни IP.
            let bytes = r.encode_to_vec();
            for needle in ["alice@local", "eyJ.secret.jwt", "203.0.113.7"] {
                assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()), "{} несёт {needle}", m.name);
            }
            assert_eq!(r.body, vec![1, 2, 3]);
        }
        // ID — личность есть, IP нет; PRE — только IP.
        let id = anon::shard_request(method("msg.inbox.sync").unwrap(), &full(), vec![]);
        assert_eq!((id.user.as_str(), id.device_id.as_str(), id.client_ip.as_str()), ("alice@local", "d1", ""));
        assert!(id.token.is_empty(), "токен сессии не уходит шарду messenger");
        let ident = METHODS.iter().find(|m| m.channel == CH_ID && m.shard == "identity").unwrap();
        assert!(!anon::shard_request(ident, &full(), vec![]).token.is_empty());
        let pre = METHODS.iter().find(|m| m.channel == CH_PRE).unwrap();
        let p = anon::shard_request(pre, &full(), vec![]);
        assert!(p.user.is_empty() && p.token.is_empty() && p.client_ip == "203.0.113.7");
        assert_eq!(CH_ID, 2);
        // S7-23: метку источника получают только сигналы звонка; сама shard_request её не ставит
        let sig: Vec<_> = METHODS.iter().filter(|m| anon::is_call_signal(m)).map(|m| m.name).collect();
        assert_eq!(sig, vec!["call.ring_sealed", "call.signal_sealed"].into_iter().filter(|n| sig.contains(n)).collect::<Vec<_>>());
        assert_eq!(sig.len(), 2);
        assert!(METHODS.iter().filter(|m| m.channel == CH_ANON).all(|m| anon::shard_request(m, &full(), vec![]).source_tag == 0));
    }

    #[test]
    fn no_events_in_anon_channel() {
        // В реестре нет ANON-подписок; сессия анонимного канала событий не получает.
        for m in METHODS.iter() {
            assert!(!(m.channel == CH_ANON && m.kind == KIND_SUBSCRIBE), "{}", m.name);
        }
        assert!(!anon::events_allowed(Channel::AnonymousDelivery));
        assert!(anon::events_allowed(Channel::Identified));
    }

    fn env(addr: &str, dev: &str, key: u8) -> SealedEnvelope {
        SealedEnvelope {
            recipient: Some(DeviceRef { address: addr.into(), device_id: dev.into() }),
            access: Some(Access::DeliveryKey(vec![key; 32])),
            hpke_enc: vec![1; 32],
            ciphertext: vec![2; 40],
        }
    }

    #[test]
    fn one_recipient_per_request() {
        let ds = method("msg.deliver_sealed").unwrap();
        let cs = method("call.signal_sealed").unwrap();
        let ok = DeliverSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("bob@local", "d2", 1)] };
        assert_eq!(anon::check_single_recipient(ds, &ok.encode_to_vec()), Ok(()));
        // Пакет «устройства Боба + свои устройства» → INVALID.
        let mixed = DeliverSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("alice@local", "d1", 1)] };
        assert_eq!(anon::check_single_recipient(ds, &mixed.encode_to_vec()), Err(ErrorCode::Invalid));
        // Разные доказательства права в одном запросе → INVALID.
        let keys = DeliverSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("bob@local", "d2", 2)] };
        assert_eq!(anon::check_single_recipient(ds, &keys.encode_to_vec()), Err(ErrorCode::Invalid));
        // Две копии одному устройству → INVALID; пустой запрос → INVALID.
        let dup = DeliverSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("bob@local", "d1", 1)] };
        assert_eq!(anon::check_single_recipient(ds, &dup.encode_to_vec()), Err(ErrorCode::Invalid));
        assert_eq!(anon::check_single_recipient(ds, &[]), Err(ErrorCode::Invalid));
        // То же для сигналов звонка.
        let call_mixed = SignalSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("carol@local", "d1", 1)] };
        assert_eq!(anon::check_single_recipient(cs, &call_mixed.encode_to_vec()), Err(ErrorCode::Invalid));
        let call_ok = SignalSealedRequest { envelopes: vec![env("bob@local", "d1", 1)] };
        assert_eq!(anon::check_single_recipient(cs, &call_ok.encode_to_vec()), Ok(()));
        let rs = method("call.ring_sealed").unwrap();
        let ring_mixed = RingSealedRequest { envelopes: vec![env("bob@local", "d1", 1), env("alice@local", "d1", 1)] };
        assert_eq!(anon::check_single_recipient(rs, &ring_mixed.encode_to_vec()), Err(ErrorCode::Invalid));
        assert!(anon::is_ring(rs));
        assert!(!anon::is_ring(cs) && !anon::is_ring(ds));
        // Прочие методы не затрагиваются.
        assert_eq!(anon::check_single_recipient(method("msg.inbox.sync").unwrap(), &[]), Ok(()));
    }

    #[test]
    fn anon_path_has_no_ip_logs_above_debug() {
        // Статическая проверка: в v2-коде gateway ни один info!/warn!/error!
        // не печатает client_ip/peer (IP журналируется только ниже info).
        for (name, src) in [("mod.rs", include_str!("mod.rs")), ("anon.rs", include_str!("anon.rs")), ("ephemeral.rs", include_str!("ephemeral.rs"))] {
            for line in src.lines() {
                let l = line.trim_start();
                if l.starts_with("info!") || l.starts_with("warn!") || l.starts_with("error!") {
                    assert!(!l.contains("client_ip") && !l.contains("peer") && !l.contains("addr"), "{name}: {l}");
                }
            }
        }
    }

    #[test]
    fn ring_cooldown_per_connection() {
        use super::super::limits::{RingCooldown, RING_COOLDOWN_MS};
        let mut r = RingCooldown::default();
        let t0 = std::time::Instant::now();
        assert!(r.allow(t0).is_ok());
        let wait = r.allow(t0 + std::time::Duration::from_millis(1000)).unwrap_err();
        assert!(wait > 0 && wait as u64 <= RING_COOLDOWN_MS);
        assert!(r.allow(t0 + std::time::Duration::from_millis(RING_COOLDOWN_MS)).is_ok());
    }
}

// ── T077/T122: эфемерные каналы ──────────────────────────────────────────────

mod eph {
    use super::super::ephemeral::{EphState, GROUP_NONCE_TTL, MAX_PRESENCE_PER_USER, PRESENCE_TTL};
    use super::super::limits::{admit, Access};
    use parvane_protocol::pb::parvane::core::v2::{Channel, ErrorCode};
    use parvane_protocol::schema::method;
    use std::time::{Duration, Instant};

    #[test]
    fn presence_only_own_channel() {
        let s = EphState::default();
        let now = Instant::now();
        let ch = [7u8; 16];
        assert_eq!(s.presence_publish(&ch, "alice@local", now), Ok(()));
        assert_eq!(s.presence_publish(&ch, "alice@local", now + Duration::from_secs(1)), Ok(()));
        // Контакт, знающий id, не публикует «присутствие» за владельца.
        assert_eq!(s.presence_publish(&ch, "mallory@local", now), Err(ErrorCode::Forbidden));
        // typing в чужой канал присутствия — отказ; в обычный канал — можно.
        assert_eq!(s.typing_publish(&ch, now), Err(ErrorCode::Forbidden));
        assert_eq!(s.typing_publish(&[8u8; 16], now), Ok(()));
        // После TTL связь истекает.
        assert_eq!(s.presence_publish(&ch, "mallory@local", now + PRESENCE_TTL + Duration::from_secs(2)), Ok(()));
        assert_eq!(s.presence_publish(&[1u8; 15], "alice@local", now), Err(ErrorCode::Invalid));
    }

    #[test]
    fn presence_released_on_revoke() {
        let s = EphState::default();
        let now = Instant::now();
        let ch = [7u8; 16];
        s.presence_publish(&ch, "alice@local", now).unwrap();
        assert_eq!(s.presence_publish(&ch, "alicia@local", now), Err(ErrorCode::Forbidden));
        // Смена ника: отзыв прежнего адреса освобождает его каналы
        s.release_presence("alice@local");
        assert_eq!(s.presence_publish(&ch, "alicia@local", now), Ok(()));
    }

    #[test]
    fn presence_cap_per_user() {
        let s = EphState::default();
        let now = Instant::now();
        for i in 0..MAX_PRESENCE_PER_USER {
            assert_eq!(s.presence_publish(&[i as u8 + 1; 16], "a@local", now), Ok(()));
        }
        assert_eq!(s.presence_publish(&[200u8; 16], "a@local", now), Err(ErrorCode::Limit));
        assert_eq!(s.presence_publish(&[200u8; 16], "b@local", now), Ok(()));
    }

    #[test]
    fn group_typing_nonce_replay() {
        let s = EphState::default();
        let now = Instant::now();
        assert_eq!(s.group_nonce_fresh(&[1; 16], &[9; 16], now), Ok(()));
        assert_eq!(s.group_nonce_fresh(&[1; 16], &[9; 16], now), Err(ErrorCode::Duplicate));
        assert_eq!(s.group_nonce_fresh(&[2; 16], &[9; 16], now), Ok(()), "другая группа");
        assert_eq!(s.group_nonce_fresh(&[1; 16], &[9; 16], now + GROUP_NONCE_TTL + Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn group_typing_is_anon_only() {
        // D-07: «печатает» в группе — только через анонимный канал.
        let gt = method("ephemeral.group_typing").unwrap();
        let id = Access { channel: Channel::Identified, authed: true, operator: false, reauth_until_ms: 0 };
        let an = Access { channel: Channel::AnonymousDelivery, authed: false, operator: false, reauth_until_ms: 0 };
        assert_eq!(admit(gt, &id, 0), Err(ErrorCode::Forbidden));
        assert_eq!(admit(gt, &an, 0), Ok(()));
        // Личные typing/presence — только в идентифицированной сессии.
        for n in ["ephemeral.typing", "ephemeral.presence", "ephemeral.subscribe"] {
            assert_eq!(admit(method(n).unwrap(), &an, 0), Err(ErrorCode::Forbidden), "{n}");
        }
    }
}

// ── T123 (D-08, D-17): лимит ANON на IP-источник ─────────────────────────────

mod anon_ip {
    use super::super::limits::{is_bundle_fetch, AnonIpLimits};
    use std::time::{Duration, Instant};

    #[test]
    fn bundle_bucket_per_source_and_separate_from_all() {
        let l = AnonIpLimits::new((10.0, 1.0), (3.0, 0.5));
        let t0 = Instant::now();
        let a = l.source_key("203.0.113.7");
        let b = l.source_key("203.0.113.8");
        assert_ne!(a, b);
        for _ in 0..3 {
            assert!(l.allow(a, "identity.device.fetch_bundle_anon", t0).is_ok());
        }
        let wait = l.allow(a, "identity.device.fetch_bundle_anon", t0).unwrap_err();
        assert!(wait > 0 && wait <= 2000, "{wait}");
        // Другие ANON-методы того же источника — своя (общая) корзина.
        assert!(l.allow(a, "msg.deliver_sealed", t0).is_ok());
        // Другой источник не затронут.
        assert!(l.allow(b, "identity.device.fetch_bundle_anon", t0).is_ok());
        // Пополнение: через 2 с — ещё один бандл.
        assert!(l.allow(a, "identity.device.fetch_bundle_anon", t0 + Duration::from_secs(2)).is_ok());
        assert!(is_bundle_fetch("identity.device.fetch_bundle_anon") && !is_bundle_fetch("cloud.blob.download_cap"));
    }

    #[test]
    fn all_anon_bucket_per_source_across_connections() {
        let l = AnonIpLimits::new((5.0, 0.0), (100.0, 0.0));
        let t0 = Instant::now();
        // Новое соединение с того же IP — тот же ключ: лимит не обходится
        // переподключением.
        for _ in 0..5 {
            let k = l.source_key("198.51.100.1");
            assert!(l.allow(k, "cloud.blob.download_cap", t0).is_ok());
        }
        let k = l.source_key("198.51.100.1");
        assert!(l.allow(k, "cloud.blob.download_cap", t0).is_err());
        // Бандл тоже упирается в общую корзину.
        assert!(l.allow(k, "identity.device.fetch_bundle_anon", t0).is_err());
    }

    #[test]
    fn ipv6_keyed_by_64_and_mapped_v4() {
        let l = AnonIpLimits::new((1.0, 0.0), (1.0, 0.0));
        assert_eq!(l.source_key("2001:db8:1:2::1"), l.source_key("2001:db8:1:2:ffff::9"));
        assert_ne!(l.source_key("2001:db8:1:2::1"), l.source_key("2001:db8:1:3::1"));
        assert_eq!(l.source_key("::ffff:192.0.2.1"), l.source_key("192.0.2.1"));
        // Ключ — не сам адрес: другой экземпляр (перезапуск) даёт другой ключ.
        let other = AnonIpLimits::new((1.0, 0.0), (1.0, 0.0));
        assert_ne!(l.source_key("192.0.2.1"), other.source_key("192.0.2.1"));
    }

    #[test]
    fn idle_sources_are_forgotten_when_full() {
        let l = AnonIpLimits::new((2.0, 1000.0), (2.0, 1000.0));
        let t0 = Instant::now();
        for i in 0..super::super::limits::ANON_IP_MAX_SOURCES {
            assert!(l.allow(i as u64, "msg.deliver_sealed", t0).is_ok());
        }
        assert_eq!(l.sources(), super::super::limits::ANON_IP_MAX_SOURCES);
        // Через секунду все корзины полны — записи вытесняются, новый источник проходит.
        assert!(l.allow(u64::MAX, "msg.deliver_sealed", t0 + Duration::from_secs(1)).is_ok());
        assert_eq!(l.sources(), 1);
    }
}

// ── S7-13: исходящая очередь с бюджетом в байтах и окна потоков ─────────────

mod out_budget {
    use super::super::outq::out_queue;
    use super::super::{stream_window, with_stream_window, SESSION_STREAM_CREDITS, STREAM_WINDOW};
    use parvane_protocol::pb::parvane::cloud::v1 as cl;
    use parvane_protocol::schema::METHODS;
    use prost::Message;
    use std::time::{Duration, Instant};

    const CHUNK: usize = 700 * 1024;
    const BUDGET: usize = 16 * 1024 * 1024;

    /// 600 кадров по 700 КБ в сессию, клиент не читает: в очереди не больше бюджета (раньше — 512 кадров,
    /// ≈ 358 МБ), сессия закрыта за 15 с, а ждущие отправители получают отказ.
    #[tokio::test]
    async fn unread_session_is_capped_by_bytes_and_closed() {
        let (q, _rx) = out_queue(512, BUDGET, Duration::from_secs(2));
        let started = Instant::now();
        let mut senders = Vec::new();
        for _ in 0..600 {
            let q = q.clone();
            senders.push(tokio::spawn(async move { q.send(vec![0u8; CHUNK]).await }));
        }
        let mut peak = 0;
        while !q.is_closed() && started.elapsed() < Duration::from_secs(15) {
            peak = peak.max(q.queued_bytes());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(q.is_closed(), "нечитающая сессия закрыта");
        assert!(started.elapsed() < Duration::from_secs(15));
        assert!(peak <= BUDGET && q.queued_bytes() <= BUDGET, "в очереди {peak} байт при бюджете {BUDGET}");
        let mut accepted = 0;
        for s in senders {
            accepted += usize::from(s.await.unwrap());
        }
        assert!(accepted * CHUNK <= BUDGET, "принято {accepted} кадров");
        // После закрытия кадры не принимаются
        assert!(!q.send(vec![1]).await);
        q.wait_closed().await;
    }

    /// Читающий клиент: место освобождается по мере записи, очередь живёт.
    #[tokio::test]
    async fn reading_session_frees_budget() {
        let (q, mut rx) = out_queue(512, BUDGET, Duration::from_secs(2));
        let reader = tokio::spawn(async move {
            let mut n = 0usize;
            while let Some(f) = rx.recv().await {
                n += f.bytes.len();
                drop(f.permit);
                if n >= 100 * CHUNK {
                    break;
                }
            }
            n
        });
        for _ in 0..100 {
            assert!(q.send(vec![0u8; CHUNK]).await);
        }
        assert_eq!(reader.await.unwrap(), 100 * CHUNK);
        assert!(!q.is_closed());
    }

    /// Каждый потоковый метод реестра скачивается окнами: окно переписывается, остальное тело — прежнее.
    #[test]
    fn every_stream_method_is_windowed() {
        for m in METHODS.iter().filter(|m| m.kind == 3) {
            let body = match m.name {
                "cloud.blob.download" => cl::DownloadRequest { file_id: "f".into(), first_chunk: 3, chunk_count: 200 }.encode_to_vec(),
                "cloud.blob.download_cap" => cl::DownloadCapRequest { file_id: "f".into(), capability: vec![7; 32], first_chunk: 3, chunk_count: 200 }.encode_to_vec(),
                "cloud.link.download" => cl::LinkDownloadRequest { link_id: "l".into(), file_id: "f".into(), first_chunk: 3, chunk_count: 200 }.encode_to_vec(),
                other => panic!("потоковый метод {other} без окна (S7-13): добавить в stream_window"),
            };
            assert_eq!(stream_window(m.name, &body), Some((3, 200)), "{}", m.name);
            let w = with_stream_window(m.name, &body, 19, STREAM_WINDOW).unwrap();
            assert_eq!(stream_window(m.name, &w), Some((19, STREAM_WINDOW)), "{}", m.name);
        }
        let cap = cl::DownloadCapRequest::decode(
            with_stream_window("cloud.blob.download_cap", &cl::DownloadCapRequest { file_id: "f".into(), capability: vec![7; 32], ..Default::default() }.encode_to_vec(), 5, 2).unwrap().as_slice(),
        )
        .unwrap();
        assert_eq!((cap.file_id.as_str(), cap.capability.len(), cap.first_chunk, cap.chunk_count), ("f", 32, 5, 2));
        assert!(STREAM_WINDOW <= 16 && SESSION_STREAM_CREDITS >= STREAM_WINDOW as usize);
    }
}

mod out_writer {
    use super::super::outq::out_queue;
    use std::time::Duration;

    /// Писатель держит только закрыватель: когда сессия отпускает очередь, канал закрывается и писатель
    /// заканчивает сам (раньше копия очереди у писателя держала канал открытым до принудительной отмены).
    #[tokio::test]
    async fn writer_ends_when_session_drops_queue() {
        let (q, mut rx) = out_queue(8, 1 << 20, Duration::from_secs(1));
        let closer = q.closer();
        let writer = tokio::spawn(async move {
            while let Some(f) = rx.recv().await {
                drop(f.permit);
            }
            closer.close();
        });
        assert!(q.send(vec![1, 2, 3]).await);
        drop(q);
        tokio::time::timeout(Duration::from_secs(2), writer).await.expect("писатель закончил сам").unwrap();
    }
}

// ── PV-010: входящий бюджет сессии в байтах ─────────────────────────────────

mod in_budget {
    use super::super::check_group_typing_signature;
    use super::super::inq::{global_budget, InBudget, InFrame, PRE_AUTH_MAX_FRAME};
    use parvane_protocol::pb::parvane::core::v2::Ref;
    use parvane_protocol::pb::parvane::msg::v2::EphemeralGroupTypingRequest;
    use std::time::Duration;
    use tokio::sync::mpsc;

    const FRAME: usize = 4 * 1024 * 1024;
    const SESSION: usize = 8 * 1024 * 1024;

    fn budget(session: usize, global: usize, auth_wait: Duration) -> InBudget {
        InBudget::new(session, global_budget(global), global, auth_wait)
    }

    /// Цикл `serve` стоит, клиент шлёт 100 кадров по 4 МиБ: в очереди не больше бюджета сессии, читатель стоит
    /// (раньше очередь принимала 512 кадров — до 2 ГиБ на соединение).
    #[tokio::test]
    async fn stalled_session_holds_at_most_budget() {
        let b = budget(SESSION, 1 << 30, Duration::from_secs(1));
        b.open();
        let (tx, mut rx) = mpsc::channel::<InFrame>(64);
        let reader_budget = b.clone();
        let reader = tokio::spawn(async move {
            let mut sent = 0usize;
            for _ in 0..100 {
                let Some(permit) = reader_budget.admit(FRAME).await else { break };
                if tx.send(InFrame { bytes: vec![0u8; FRAME], permit }).await.is_err() {
                    break;
                }
                sent += 1;
            }
            sent
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(b.used() <= SESSION, "занято {} байт при бюджете {SESSION}", b.used());
        assert!(!reader.is_finished(), "читатель ждёт места, а не принимает дальше");
        // Цикл ожил: кадры разбираются и отпускаются — читатель продолжает
        let mut got = 0;
        while got < 100 {
            let f = rx.recv().await.expect("кадр");
            drop(f);
            got += 1;
        }
        assert_eq!(reader.await.unwrap(), 100);
        assert_eq!(b.used(), 0);
    }

    /// Запрос в полёте держит своё место до ответа (потолок байтов запросов в полёте на сессию).
    #[tokio::test]
    async fn in_flight_requests_count_until_answered() {
        let b = budget(SESSION, 1 << 30, Duration::from_secs(1));
        b.open();
        let p1 = b.admit(FRAME).await.unwrap();
        let p2 = b.admit(FRAME).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200), b.admit(1)).await.is_err(), "третий запрос ждёт ответа одного из первых");
        drop(p1);
        assert!(tokio::time::timeout(Duration::from_millis(200), b.admit(1024)).await.is_ok());
        drop(p2);
    }

    /// До входа: крупный кадр без последующего входа — сессия закрывается; кадр, присланный сразу за Auth,
    /// дожидается входа; малые кадры — не больше `PRE_AUTH_BUDGET`.
    #[tokio::test]
    async fn pre_auth_frames_are_small() {
        let b = budget(SESSION, 1 << 30, Duration::from_millis(200));
        assert!(b.admit(1024 * 1024).await.is_none(), "1 МиБ до входа — закрыть");
        let held: Vec<_> = futures::future::join_all((0..4).map(|_| b.admit(PRE_AUTH_MAX_FRAME))).await;
        assert!(held.iter().all(Option::is_some));
        assert!(tokio::time::timeout(Duration::from_millis(200), b.admit(PRE_AUTH_MAX_FRAME)).await.is_err(), "пятый кадр до входа ждёт");
        drop(held);
        let b2 = budget(SESSION, 1 << 30, Duration::from_secs(2));
        let waiter = { let b2 = b2.clone(); tokio::spawn(async move { b2.admit(FRAME).await.is_some() }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        b2.open();
        assert!(waiter.await.unwrap(), "кадр за Auth принят после входа");
    }

    /// Общий бюджет процесса делят все сессии.
    #[tokio::test]
    async fn global_budget_is_shared() {
        let g = global_budget(6 * 1024 * 1024);
        let a = InBudget::new(SESSION, g.clone(), 6 * 1024 * 1024, Duration::from_secs(1));
        let c = InBudget::new(SESSION, g, 6 * 1024 * 1024, Duration::from_secs(1));
        a.open();
        c.open();
        let pa = a.admit(FRAME).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(200), c.admit(FRAME)).await.is_err(), "процессу места нет");
        drop(pa);
        assert!(tokio::time::timeout(Duration::from_millis(200), c.admit(FRAME)).await.is_ok());
    }

    /// Закрытие сессии будит ждущего читателя отказом.
    #[tokio::test]
    async fn close_wakes_reader() {
        let b = budget(SESSION, 1 << 30, Duration::from_secs(1));
        b.open();
        let _p = b.admit(SESSION).await.unwrap();
        let w = { let b = b.clone(); tokio::spawn(async move { b.admit(1).await.is_none() }) };
        tokio::time::sleep(Duration::from_millis(50)).await;
        b.close();
        assert!(w.await.unwrap());
    }

    /// Решение 8 ноя 2026: подпись «печатает» группы без channel_id больше не принимается.
    #[test]
    fn legacy_group_typing_signature_is_refused() {
        use ed25519_dalek::Signer;
        let sk = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let g = Ref { domain: "local".into(), id: vec![1; 16] };
        let mut r = EphemeralGroupTypingRequest { group: Some(g.clone()), epoch: 3, nonce: vec![4; 16], channel_id: vec![5; 16], payload: b"pl".to_vec(), ..Default::default() };
        r.epoch_signature = parvane_protocol::group::sign_group_typing(&sk, &g, 3, &r.channel_id, &r.nonce, &r.payload);
        assert!(check_group_typing_signature(&pk, &g, &r).is_ok());
        // Прежний вид: контекст GROUP_TYPING, без канала
        let mut aad = g.domain.as_bytes().to_vec();
        aad.push(0);
        aad.extend_from_slice(&g.id);
        aad.extend_from_slice(&3u64.to_be_bytes());
        aad.extend_from_slice(&r.nonce);
        aad.extend_from_slice(&r.payload);
        let mut msg = parvane_protocol::sign::ctx::GROUP_TYPING.to_vec();
        msg.extend_from_slice(&aad);
        r.epoch_signature = sk.sign(&msg).to_bytes().to_vec();
        assert!(parvane_protocol::group::verify_group_typing_legacy(&pk, &g, 3, &r.nonce, &r.payload, &r.epoch_signature).is_ok(), "подпись собрана прежним способом");
        assert!(check_group_typing_signature(&pk, &g, &r).is_err());
    }
}
