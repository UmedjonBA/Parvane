//! Пробуждение v2 (spec 007 US6, T102, R13): в канал уходит только сигнал
//! «есть новое» — без id чата, отправителя и содержимого; поток записей
//! инбокса схлопывается до ≤ 1 пробуждения на устройство за окно 30 с.

use std::time::{Duration, Instant};

use p256::pkcs8::{EncodePrivateKey, LineEnding};
use parvane_protocol::pb::parvane::push::v1::{WakeKind, WakeRegistration};
use parvane_protocol::registry_gen::inbox_subject;
use push::vapid::{vapid_from_pem, VapidKeys};
use push::wake::{self, Collapser, StoredWake, COLLAPSE_WINDOW, WAKE_BODY};
use web_push_native::Auth;

const CHAT_ID: &str = "chat-7f3a9c";
const SENDER: &str = "alice@parvane.example";
const RECIPIENT: &str = "bob@parvane.example";
const TEXT: &str = "секретный текст";

fn vapid() -> VapidKeys {
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    vapid_from_pem(&secret.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap()
}

/// Регистрация web push от «браузера» с известным секретом (для расшифровки).
fn web_registration() -> (p256::SecretKey, [u8; 16], StoredWake) {
    let ua = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let auth = [9u8; 16];
    let reg = wake::check_registration(&WakeRegistration {
        kind: WakeKind::WebPush as i32,
        endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
        p256dh: ua.public_key().to_sec1_bytes().to_vec(),
        auth: auth.to_vec(),
    })
    .unwrap();
    (ua, auth, reg)
}

/// Записи журнала, как их публикует messenger: subject устройства + байты,
/// в которых есть всё, что не должно утечь.
fn inbox_records(n: usize) -> Vec<(String, Vec<u8>)> {
    let subject = inbox_subject(RECIPIENT, "phone").unwrap();
    (0..n).map(|i| (subject.clone(), format!("{CHAT_ID}|{SENDER}|{TEXT}|{i}").into_bytes())).collect()
}

fn assert_no_leak(bytes: &[u8], what: &str) {
    for needle in [CHAT_ID, SENDER, RECIPIENT, TEXT, "alice", "bob", "phone"] {
        assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()), "{what} содержит {needle:?}");
    }
}

fn assert_request_clean(req: &http::Request<Vec<u8>>) {
    assert_no_leak(req.body(), "тело");
    assert_no_leak(req.uri().to_string().as_bytes(), "URI");
    for (name, value) in req.headers() {
        assert_no_leak(value.as_bytes(), name.as_str());
    }
}

#[test]
fn web_push_wake_is_fixed_and_carries_no_data() {
    let v = vapid();
    let (ua, auth, reg) = web_registration();
    let mut lens = Vec::new();
    for _ in 0..3 {
        let req = wake::build_wake_request(&v, &reg, 1_790_000_000).unwrap();
        assert_eq!(req.method(), http::Method::POST);
        assert_eq!(req.headers().get("content-encoding").unwrap(), "aes128gcm");
        assert!(req.headers().get("authorization").unwrap().to_str().unwrap().starts_with("vapid t="));
        assert_eq!(req.headers().get("topic").unwrap(), wake::WAKE_TOPIC);
        assert_request_clean(&req);
        // Расшифровка ключом подписки: внутри — постоянное тело, и только оно.
        let plain = web_push_native::decrypt(req.body().clone(), &ua, &Auth::clone_from_slice(&auth)).unwrap();
        assert_eq!(plain, WAKE_BODY);
        lens.push(req.body().len());
    }
    // Длина тела постоянна: по размеру не отличить одно пробуждение от другого.
    assert!(lens.windows(2).all(|w| w[0] == w[1]), "{lens:?}");
    // aes128gcm: salt(16) + rs(4) + idlen(1) + keyid(65) + тело + разделитель(1) + тег(16).
    assert_eq!(lens[0], 86 + WAKE_BODY.len() + 17);
}

#[test]
fn unified_push_wake_has_empty_body() {
    let v = vapid();
    let reg = wake::check_registration(&WakeRegistration {
        kind: WakeKind::UnifiedPush as i32,
        endpoint: "https://ntfy.sh/upAbCdEf".into(),
        p256dh: vec![],
        auth: vec![],
    })
    .unwrap();
    let req = wake::build_wake_request(&v, &reg, 1_790_000_000).unwrap();
    assert_eq!(req.method(), http::Method::POST);
    assert!(req.body().is_empty(), "UnifiedPush: пустое тело");
    assert_eq!(req.headers().get("content-length").unwrap(), "0");
    assert!(req.headers().get("content-encoding").is_none());
    assert_request_clean(&req);
}

#[test]
fn fifty_inbox_records_give_at_most_one_wake_per_window() {
    let v = vapid();
    let (_, _, reg) = web_registration();
    let mut c = Collapser::default();
    let t0 = Instant::now();
    let mut wakes = Vec::new();
    // 50 записей подряд в течение 25 с — одно окно.
    // Push видит запись только как subject + байты; из байтов ничего не берёт.
    for (i, (subject, _payload)) in inbox_records(50).iter().enumerate() {
        let token = wake::inbox_token(subject).expect("subject журнала устройства");
        if c.admit(token, t0 + Duration::from_millis(500 * i as u64)) {
            wakes.push(wake::build_wake_request(&v, &reg, 1_790_000_000).unwrap());
        }
    }
    assert_eq!(wakes.len(), 1, "50 записей → ≤ 1 пробуждения за окно");
    for w in &wakes {
        assert_request_clean(w);
    }
    // После окна — снова одно (устройство могло не проснуться).
    let (subject, _) = &inbox_records(1)[0];
    let token = wake::inbox_token(subject).unwrap();
    assert!(!c.admit(token, t0 + COLLAPSE_WINDOW - Duration::from_millis(1)));
    assert!(c.admit(token, t0 + COLLAPSE_WINDOW));
    // Другое устройство того же пользователя схлопывается независимо.
    let other = inbox_subject(RECIPIENT, "laptop").unwrap();
    assert!(c.admit(wake::inbox_token(&other).unwrap(), t0 + Duration::from_secs(1)));
}

#[test]
fn concurrent_records_collapse_atomically() {
    use std::sync::{Arc, Mutex};
    let c = Arc::new(Mutex::new(Collapser::default()));
    let (subject, _) = inbox_records(1).remove(0);
    let now = Instant::now();
    let admitted: usize = (0..50)
        .map(|_| {
            let (c, s) = (c.clone(), subject.clone());
            std::thread::spawn(move || c.lock().unwrap().admit(wake::inbox_token(&s).unwrap(), now) as usize)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .sum();
    assert_eq!(admitted, 1);
}
