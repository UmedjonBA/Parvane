//! Изоляция сессии: привязка payload к JWT-субъекту, allowed_sub/pub/req, typing/presence по членству (P-01/P-18/P-40).

use crate::*;

/// IP клиента для лимитов identity: X-Forwarded-For (первый адрес) доверяем
/// только если сам пир — loopback/приватная сеть (reverse-proxy), иначе — пир.
pub(crate) fn client_ip_from(peer: Option<IpAddr>, forwarded: Option<&str>) -> String {
    let peer_trusted = match peer {
        Some(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        Some(IpAddr::V6(v6)) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        None => false,
    };
    if peer_trusted {
        if let Some(first) = forwarded
            .and_then(|f| f.split(',').next())
            .map(str::trim)
            .filter(|f| !f.is_empty() && f.parse::<IpAddr>().is_ok())
        {
            return first.to_string();
        }
    }
    peer.map(|p| p.to_string()).unwrap_or_default()
}

pub(crate) fn inject_client_ip(payload: &str, client_ip: &str) -> String {
    if client_ip.is_empty() {
        return payload.to_string();
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(Value::Object(mut map)) => {
            map.insert("client_ip".to_string(), Value::String(client_ip.to_string()));
            Value::Object(map).to_string()
        }
        _ => payload.to_string(),
    }
}

// ── общая логика: auth + pub/req/reqmany/sub с проверкой прав ──────────────────

/// Web использует FNV-1a/32 по UTF-16 code units, затем снимает знаковый бит.
/// Сохраняем этот id на wire, пока Web и desktop не перейдут на адресные topics.
pub(crate) fn web_user_id(user: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for unit in user.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    (hash >> 1).to_string()
}

/// Desktop использует FNV-1a/64 по UTF-8 и оставляет младшие 48 бит.
pub(crate) fn desktop_user_id(user: &str) -> String {
    let mut hash = 1_469_598_103_934_665_603_u64;
    for byte in user.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    let id = hash & ((1_u64 << 48) - 1);
    if id == 0 {
        "1".to_string()
    } else {
        id.to_string()
    }
}

pub(crate) fn is_own_ephemeral_subject(user: &str, prefix: &str, subject: &str) -> bool {
    subject == format!("{prefix}{}", web_user_id(user))
        || subject == format!("{prefix}{}", desktop_user_id(user))
}

pub(crate) fn is_concrete_typing_subject(subject: &str) -> bool {
    subject.strip_prefix(MSG_TYPING_PREFIX).is_some_and(|id| {
        // Групповой typing веб-клиента адресован chat-id вида "-<digits>"
        // (FNV с ведущим минусом); 1-на-1 — просто <digits>.
        let digits = id.strip_prefix('-').unwrap_or(id);
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// Привязывает actor-поля к уже проверенному WebSocket/TCP соединению. Клиент
/// может прислать устаревший или поддельный `from`/`token`, но на NATS попадут
/// только значения текущей авторизованной сессии.
pub(crate) fn bind_client_payload(user: &str, token: &str, subject: &str, payload: &str) -> Result<String> {
    let mut value: Value = serde_json::from_str(payload).context("payload: битый json")?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("payload должен быть JSON-объектом"))?;
    // GW-04: `client_ip` подставляет только gateway. Клиентское поле уходило
    // identity как есть (после auth IP подмешивался не во все bootstrap-запросы)
    // — им выедали лимит настоящего бота или обходили лимит вовсе.
    object.remove("client_ip");

    if GATEWAY_EVENT_SUBJECTS.contains(&subject) {
        // P-22: и отправка, и ПРАВКА принимают только E2E-контент — иначе
        // автор переводил бы E2E-сообщение в открытый текст на сервере правкой.
        if subject == MSG_SEND || subject == MSG_EDIT {
            let kind = object
                .get("payload")
                .and_then(|payload| payload.get("content"))
                .and_then(|content| content.get("kind"))
                .and_then(Value::as_str);
            if !matches!(kind, Some("encrypted" | "group_encrypted")) {
                return Err(anyhow!(
                    "plaintext {subject} запрещён: E2E-сообщение не отправлено"
                ));
            }
        }

        // В sealed 1-на-1 реальный sender находится внутри Olm ciphertext. Пустой
        // `from` сохраняем только для этого wire-варианта; plaintext, group и
        // прочие события получают явного actor из авторизованной сессии.
        let sealed_direct = subject == MSG_SEND
            && object.get("from").and_then(Value::as_str) == Some("")
            && object
                .get("payload")
                .and_then(|payload| payload.get("content"))
                .and_then(|content| content.get("kind"))
                .and_then(Value::as_str)
                == Some("encrypted")
            && object
                .get("payload")
                .and_then(|payload| payload.get("to"))
                .and_then(Value::as_str)
                .is_some_and(|to| to.contains('@'));
        object.insert("token".into(), Value::String(token.to_string()));
        if !sealed_direct {
            object.insert("from".into(), Value::String(user.to_string()));
        }

        // P-01: маршрут доставки (`to`) и список получателей (`recipients`)
        // приходят от клиента и уходят в NATS-subject (`msg.user.<to>`,
        // `call.user.<to>`). Пробел/CRLF/wildcard в них разорвали бы кадр `PUB`
        // и позволили внедрить публикацию в чужой инбокс — отвергаем до шины.
        if let Some(to) = object
            .get("payload")
            .and_then(|payload| payload.get("to"))
            .and_then(Value::as_str)
        {
            if !parvane_types::address::is_valid_route(to) {
                return Err(anyhow!("недопустимый адрес получателя"));
            }
        }
        if let Some(recipients) = object
            .get("payload")
            .and_then(|payload| payload.get("recipients"))
            .and_then(Value::as_array)
        {
            for recipient in recipients {
                let ok = recipient
                    .as_str()
                    .is_some_and(parvane_types::address::is_valid_address);
                if !ok {
                    return Err(anyhow!("недопустимый адрес в recipients"));
                }
            }
        }
    } else if GATEWAY_TOKEN_REQUEST_SUBJECTS.contains(&subject) {
        object.insert("token".into(), Value::String(token.to_string()));
    } else if subject.starts_with(MSG_TYPING_PREFIX) || subject.starts_with(PRESENCE_PREFIX) {
        // GW-01: эфемерный кадр — пара коротких полей. Без потолка «печатает» на
        // 4 МиБ размножался по подпискам и копился у нечитающего клиента.
        if payload.len() > EPHEMERAL_MAX_BYTES {
            return Err(anyhow!("эфемерный кадр слишком большой"));
        }
        object.insert("from".into(), Value::String(user.to_string()));
    }

    serde_json::to_string(&value).context("payload: не удалось сериализовать")
}

/// На что можно ПОДПИСАТЬСЯ: только свои пользовательские инбоксы (включая
/// групповой mesh-инбокс `call.user.gcall:<self>`) и эфемерные typing/presence.
/// NATS reply inbox создаёт и обслуживает только gateway.
/// P-18: статические права подписки. Typing — только СВОЙ 1-на-1 topic
/// (msg.typing.<id(self)>): подписка на чужой раскрывала бы, кто пишет жертве.
/// Групповой typing проверяется по членству (`group_typing_allowed`).
/// Presence — только конкретный presence.<id> (без wildcard'а на всех).
pub(crate) fn allowed_sub(user: &str, subject: &str) -> bool {
    subject == msg_inbox(user)
        || subject == call_inbox(user)
        || subject == call_inbox(&group_call_route(user))
        || is_own_ephemeral_subject(user, MSG_TYPING_PREFIX, subject)
        || is_concrete_presence_subject(subject)
}

pub(crate) fn is_concrete_presence_subject(subject: &str) -> bool {
    subject
        .strip_prefix(PRESENCE_PREFIX)
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Typing-id группы в обеих схемах клиентов: web — `-<fnv32("group:<gid>")>`,
/// desktop/android — fnv64/48(<gid>).
pub(crate) fn group_typing_ids(group_id: &str) -> [String; 2] {
    [
        format!("-{}", web_user_id(&format!("group:{group_id}"))),
        desktop_user_id(group_id),
    ]
}

/// P-18: подписка на msg.typing.<id> группы разрешена только участнику —
/// список групп берём у messenger'а по токену этой же сессии.
pub(crate) async fn group_typing_allowed(nats: &Client, token: &str, subject: &str) -> bool {
    let Some(id) = subject.strip_prefix(MSG_TYPING_PREFIX) else {
        return false;
    };
    if id.is_empty() || !id.trim_start_matches('-').bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let request = serde_json::to_vec(&json!({ "token": token })).unwrap_or_default();
    let reply = match tokio::time::timeout(Duration::from_secs(5), nats.request(GROUP_LIST, request.into())).await {
        Ok(Ok(reply)) => reply,
        _ => return false,
    };
    let Ok(list) = serde_json::from_slice::<GroupListResponse>(&reply.payload) else {
        return false;
    };
    list.groups
        .iter()
        .any(|group| group_typing_ids(&group.group_id).iter().any(|candidate| candidate == id))
}

/// Что можно ПУБЛИКОВАТЬ (fire-and-forget).
pub(crate) fn allowed_pub(user: &str, subject: &str) -> bool {
    GATEWAY_ALLOWED_PUBLISH.contains(&subject)
        || is_concrete_typing_subject(subject)
        || is_own_ephemeral_subject(user, PRESENCE_PREFIX, subject)
}

/// Что можно запросить (request / reqmany).
pub(crate) fn allowed_req(_user: &str, subject: &str) -> bool {
    GATEWAY_ALLOWED_REQUEST.contains(&subject)
}
