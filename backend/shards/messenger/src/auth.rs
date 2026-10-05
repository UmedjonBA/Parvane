//! Проверка JWT через identity, подписи send/edit/sync (P-10/P-22/P-40).

use crate::*;

pub(crate) async fn verify_token(nc: &Client, token: &str) -> Result<String> {
    let req = serde_json::to_vec(&VerifyRequest { token: token.to_string() })?;
    let reply = nc
        .request(IDENTITY_VERIFY, req.into())
        .await
        .context("запрос к identity")?;
    let resp: VerifyResponse =
        serde_json::from_slice(&reply.payload).context("ответ identity: неверный JSON")?;
    if resp.ok {
        resp.user.ok_or_else(|| anyhow::anyhow!("identity вернул ok без user"))
    } else {
        anyhow::bail!(resp.error.unwrap_or_else(|| "неизвестная ошибка".into()))
    }
}

// ── доменная логика (тестируемая, без NATS) ───────────────────────────────────

/// Проверка от подмены: subject JWT должен совпадать с заявленным `from`.
pub(crate) fn validate_sender(jwt_sub: &str, claimed_from: &str) -> Result<()> {
    if jwt_sub != claimed_from {
        anyhow::bail!("JWT sub '{}' не совпадает с from '{}'", jwt_sub, claimed_from);
    }
    Ok(())
}

pub(crate) fn encrypted_mutation_metadata(content: &MessageContent) -> Option<(&str, &str)> {
    match content {
        MessageContent::Encrypted { ciphertext, sender_signing_key, .. }
        | MessageContent::GroupEncrypted { ciphertext, sender_signing_key, .. }
            if !sender_signing_key.is_empty() => Some((ciphertext, sender_signing_key)),
        _ => None,
    }
}

pub(crate) fn decode_base64(value: &str) -> Option<Vec<u8>> {
    STANDARD_NO_PAD.decode(value).or_else(|_| STANDARD.decode(value)).ok()
}

pub(crate) fn verify_mutation_signature(signing_key: &str, payload: &str, signature: &str) -> bool {
    let Some(key_bytes) = decode_base64(signing_key).and_then(|bytes| bytes.try_into().ok()) else {
        return false;
    };
    let Some(signature_bytes) = decode_base64(signature) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&signature_bytes) else {
        return false;
    };
    key.verify(payload.as_bytes(), &signature).is_ok()
}

/// P-10 (SEND-1): при отправке владение `sender_signing_key` доказывается
/// подписью `send:<message_id>:<ciphertext>`. Без ключа в content — legacy
/// (никаких привилегий по ключу), но тогда и self-копии с `signing_key`
/// запрещены: их выборка в sync тоже идёт по ключу.
pub(crate) fn authenticate_send(payload: &SendPayload, message_id: &str) -> Result<()> {
    match encrypted_mutation_metadata(&payload.content) {
        Some((ciphertext, signing_key)) => {
            let Some(signature) = payload.signature.as_deref() else {
                anyhow::bail!("P-10: отправка с sender_signing_key без подписи send");
            };
            let statement = format!("send:{message_id}:{ciphertext}");
            if !verify_mutation_signature(signing_key, &statement, signature) {
                anyhow::bail!("P-10: подпись send не соответствует sender_signing_key");
            }
        }
        None => {
            if payload.copies.iter().any(|copy| !copy.signing_key.is_empty()) {
                anyhow::bail!("P-10: self-копии с signing_key без доказанного sender_signing_key");
            }
        }
    }
    Ok(())
}

pub(crate) fn authenticated_sync_signing_key(payload: &SyncRequestPayload) -> Option<&str> {
    let signing_key = payload.sender_signing_key.as_deref()?;
    let signature = payload.signature.as_deref()?;
    let signed_payload = format!("sync:{}:{}", payload.last_seen_id, payload.since_updated);
    verify_mutation_signature(signing_key, &signed_payload, signature).then_some(signing_key)
}

/// Кап дополнительных подписей в sync (анти-DoS: каждая — ed25519 verify).
pub(crate) const MAX_EXTRA_SIGNING: usize = 8;

/// Доказанные signing-ключи ПРЕЖНИХ устройств (авто-линковка): в выдачу sync
/// попадают и их sealed-исходящие. Недоказанные подписи молча отбрасываются.
pub(crate) fn authenticated_extra_signing_keys(payload: &SyncRequestPayload) -> Vec<String> {
    let signed_payload = format!("sync:{}:{}", payload.last_seen_id, payload.since_updated);
    payload
        .extra_signing
        .iter()
        .take(MAX_EXTRA_SIGNING)
        .filter(|extra| verify_mutation_signature(&extra.signing_key, &signed_payload, &extra.signature))
        .map(|extra| extra.signing_key.clone())
        .collect()
}

/// Линковка v2 (P-48): доказанные signing-ключи ПРЕЖНИХ устройств через
/// подписанный ими перенос владения `link-transfer:<user>:<old>:<new>`, где
/// `new` — уже доказанный ключ: sender_signing_key этого запроса либо ключ,
/// доказанный другим переносом из того же запроса (цепочка: устройство A
/// привязало B, B привязало C — C предъявляет A→B и B→C). Без цепочки
/// устройство третьего поколения не получало исходящие первого: так терялись
/// свои сообщения после выхода и повторной привязки. Приватный аккаунт
/// прежнего устройства при этом на новое не переезжает.
pub(crate) fn authenticated_transfer_keys(payload: &SyncRequestPayload, user: &str, new_signing_key: &str) -> Vec<String> {
    if new_signing_key.is_empty() {
        return vec![];
    }
    let candidates: Vec<&parvane_types::SyncTransfer> =
        payload.transfers.iter().take(MAX_EXTRA_SIGNING).filter(|t| !t.old_signing_key.is_empty()).collect();
    let mut proven: Vec<String> = Vec::new();
    // Каждый проход доказывает хотя бы один новый ключ либо завершает цикл
    loop {
        let mut found = None;
        for t in &candidates {
            if t.old_signing_key == new_signing_key || proven.contains(&t.old_signing_key) {
                continue;
            }
            let is_proven = std::iter::once(new_signing_key).chain(proven.iter().map(String::as_str)).any(|target| {
                let statement = format!("link-transfer:{}:{}:{}", user, t.old_signing_key, target);
                verify_mutation_signature(&t.old_signing_key, &statement, &t.signature)
            });
            if is_proven {
                found = Some(t.old_signing_key.clone());
                break;
            }
        }
        match found {
            Some(key) => proven.push(key),
            None => break,
        }
    }
    proven
}
