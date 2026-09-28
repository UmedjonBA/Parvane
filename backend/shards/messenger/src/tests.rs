//! Тесты шарда (вынесены из main.rs, п. 4.7).

use crate::*;
use ed25519_dalek::{Signer, SigningKey};
use parvane_types::{MessageContent, SendPayload};
use sqlx::sqlite::SqlitePoolOptions;

/// Текстовое сообщение.
fn send_event(id: &str, from: &str, to: &str, text: &str) -> ParvaneEvent<SendPayload> {
    send_content(id, from, to, MessageContent::Text { text: text.into(), entities: vec![], webpage: None })
}

/// Сообщение с произвольным контентом (для медиа-тестов).
fn send_content(
    id: &str,
    from: &str,
    to: &str,
    content: MessageContent,
) -> ParvaneEvent<SendPayload> {
    ParvaneEvent {
        id: id.parse().unwrap(),
        from: from.into(),
        ts: 1_000_000,
        token: "tok".into(),
        payload: SendPayload { to: to.into(), content, reply_to: None, copies: vec![], signature: None },
    }
}

/// Достаёт текст из текстового сообщения (для ассертов).
fn text_of(m: &StoredMessage) -> &str {
    match &m.content {
        MessageContent::Text { text, .. } => text,
        other => panic!("ожидался Text, получено {:?}", other),
    }
}

#[tokio::test]
async fn ban_blocks_posting_and_membership() {
    let pool = test_pool().await;
    let g1 = create_group(&pool, "Тест", GroupKind::Group, "owner@l",
        &["bob@l".into()], 0).await.unwrap();
    let g1 = g1.as_str();
    assert!(can_post(&pool, g1, "bob@l").await.unwrap());
    // админ не нужен: owner банит
    assert!(ban_group_member(&pool, g1, "owner@l", "bob@l", true).await.unwrap());
    assert!(!can_post(&pool, g1, "bob@l").await.unwrap());
    assert!(list_groups(&pool, "bob@l").await.unwrap().is_empty());
    assert!(group_info_for_member(&pool, g1, "bob@l").await.unwrap().is_none());
    assert!(group_info_for_member(&pool, g1, "mallory@l").await.unwrap().is_none());
    assert!(group_info_for_member(&pool, g1, "owner@l").await.unwrap().is_some());
    assert!(!resolve_recipients(&pool, g1, "owner@l")
        .await
        .unwrap()
        .contains(&"bob@l".to_string()));
    // банённого нельзя добавить обратно add'ом
    assert!(!add_group_member(&pool, g1, "owner@l", "bob@l").await.unwrap());
    // owner небаним, обычный участник банить не может
    assert!(!ban_group_member(&pool, g1, "bob@l", "owner@l", true).await.unwrap());
    assert!(!ban_group_member(&pool, g1, "owner@l", "owner@l", true).await.unwrap());
    // разбан возвращает возможность добавления
    assert!(ban_group_member(&pool, g1, "owner@l", "bob@l", false).await.unwrap());
    assert!(add_group_member(&pool, g1, "owner@l", "bob@l").await.unwrap());
    assert!(can_post(&pool, g1, "bob@l").await.unwrap());
}

#[tokio::test]
async fn mute_blocks_posting_until_deadline() {
    let pool = test_pool().await;
    let g2 = create_group(&pool, "Тест", GroupKind::Group, "owner@l",
        &["bob@l".into()], 0).await.unwrap();
    let g2 = g2.as_str();
    let future = now_unix() + 3600;
    assert!(mute_group_member(&pool, g2, "owner@l", "bob@l", future).await.unwrap());
    assert!(!can_post(&pool, g2, "bob@l").await.unwrap());
    // снятие мьюта (until=0 в прошлом)
    assert!(mute_group_member(&pool, g2, "owner@l", "bob@l", 0).await.unwrap());
    assert!(can_post(&pool, g2, "bob@l").await.unwrap());
    // owner немьютим
    assert!(!mute_group_member(&pool, g2, "owner@l", "owner@l", future).await.unwrap());
}

#[tokio::test]
async fn invite_join_respects_ban() {
    let pool = test_pool().await;
    let g3 = create_group(&pool, "Тест", GroupKind::Group, "owner@l", &[], 0)
        .await
        .unwrap();
    let g3 = g3.as_str();
    sqlx::query(
        "INSERT INTO group_invites (token, group_id, created_by, created_at)
         VALUES ('inv1', ?, 'owner@l', 0)",
    )
    .bind(g3)
    .execute(&pool)
    .await
    .unwrap();
    // banned не вступит по инвайту (проверка как в handle_group_join)
    assert!(ban_group_member(&pool, g3, "owner@l", "eve@l", true).await.unwrap());
    assert!(matches!(
        member_role(&pool, g3, "eve@l").await.unwrap().as_deref(),
        Some("banned")
    ));
    // обычный юзер вступает: имитируем вставку join'а
    sqlx::query(
        "INSERT OR IGNORE INTO group_members (group_id, member, role)
         VALUES (?, 'carol@l', 'member')",
    )
    .bind(g3)
    .execute(&pool)
    .await
    .unwrap();
    assert!(can_post(&pool, g3, "carol@l").await.unwrap());
}

/// In-memory SQLite с одной живой connection (иначе каждый коннект — своя
/// пустая база) и применёнными миграциями.
async fn test_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

// ── чистая проверка отправителя ──

#[test]
fn validate_sender_accepts_match() {
    assert!(validate_sender("alice@local", "alice@local").is_ok());
}

#[test]
fn validate_sender_rejects_spoof() {
    let err = validate_sender("alice@local", "mallory@evil").unwrap_err();
    assert!(err.to_string().contains("не совпадает"));
}

// ── хранение и выборка сообщений ──

#[tokio::test]
async fn store_and_fetch_message() {
    let pool = test_pool().await;
    let ev = send_event(
        "00000000-0000-7000-8000-000000000001",
        "alice@local",
        "bob@local",
        "привет",
    );
    store_message(&pool, &ev, 1).await.unwrap();

    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed.len(), 1);
    assert_eq!(text_of(&missed[0]), "привет");
    assert_eq!(missed[0].from, "alice@local");
}

#[tokio::test]
async fn fetch_missed_filters_by_recipient() {
    let pool = test_pool().await;
    store_message(
        &pool,
        &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "для боба"),
        1,
    )
    .await
    .unwrap();

    // получатель carol не должен видеть сообщение для bob
    let missed = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(missed.is_empty());
}

#[tokio::test]
async fn fetch_missed_includes_own_sent_messages() {
    // регрессия: после перезахода отправитель должен видеть свои исходящие
    let pool = test_pool().await;
    store_message(
        &pool,
        &send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "моё исходящее"),
        1,
    )
    .await
    .unwrap();

    // alice — отправитель, должна получить своё же сообщение при ресинке
    let missed = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed.len(), 1);
    assert_eq!(text_of(&missed[0]), "моё исходящее");
    assert_eq!(missed[0].from, "alice@local");
    assert_eq!(missed[0].to, "bob@local");
}

#[tokio::test]
async fn fetch_missed_respects_last_seen_id() {
    let pool = test_pool().await;
    let older = "00000000-0000-7000-8000-000000000001";
    let newer = "00000000-0000-7000-8000-000000000002";
    store_message(&pool, &send_event(older, "alice@local", "bob@local", "первое"), 1)
        .await
        .unwrap();
    store_message(&pool, &send_event(newer, "alice@local", "bob@local", "второе"), 2)
        .await
        .unwrap();

    // Клиент, уже видевший older, держит оба курсора: last_seen=older и
    // since_updated=updated_at(older)=1. Тогда отдаётся только newer.
    let missed = fetch_missed(&pool, "bob@local", older, 1).await.unwrap();
    assert_eq!(missed.len(), 1);
    assert_eq!(text_of(&missed[0]), "второе");
}

#[tokio::test]
async fn hidden_messages_are_excluded_only_for_the_hider() {
    // Очистка «для меня»: скрытое не приходит в sync bob'у (ни по курсору
    // id, ни по мутациям), а alice видит переписку как раньше.
    let pool = test_pool().await;
    let first = "00000000-0000-7000-8000-000000000001";
    let second = "00000000-0000-7000-8000-000000000002";
    store_message(&pool, &send_event(first, "alice@local", "bob@local", "первое"), 1)
        .await
        .unwrap();
    store_message(&pool, &send_event(second, "alice@local", "bob@local", "второе"), 2)
        .await
        .unwrap();

    let hidden = hide_messages(&pool, "bob@local", &[first.parse().unwrap()], 5).await.unwrap();
    assert_eq!(hidden.len(), 1);
    // Повтор — идемпотентен (ничего нового не скрыто → уведомления не будет)
    let again = hide_messages(&pool, "bob@local", &[first.parse().unwrap()], 6).await.unwrap();
    assert!(again.is_empty());

    let bob = fetch_missed(&pool, "bob@local", "0", 0).await.unwrap();
    assert_eq!(bob.len(), 1);
    assert_eq!(text_of(&bob[0]), "второе");

    // Мутация скрытого (правка автором) тоже не всплывает у скрывшего
    sqlx::query("UPDATE messages SET edited = 1, updated_at = 50 WHERE id = ?")
        .bind(first)
        .execute(&pool)
        .await
        .unwrap();
    let bob_delta = fetch_missed(&pool, "bob@local", second, 2).await.unwrap();
    assert!(bob_delta.is_empty());

    let alice = fetch_missed(&pool, "alice@local", "0", 0).await.unwrap();
    assert_eq!(alice.len(), 2);
}

#[tokio::test]
async fn hide_messages_caps_batch_size() {
    let pool = test_pool().await;
    let ids: Vec<Uuid> = (0..(parvane_types::CLEAR_MAX_IDS + 10)).map(|_| Uuid::now_v7()).collect();
    let hidden = hide_messages(&pool, "bob@local", &ids, 1).await.unwrap();
    assert_eq!(hidden.len(), parvane_types::CLEAR_MAX_IDS);
}

#[tokio::test]
async fn fetch_missed_picks_up_mutations_past_id_cursor() {
    // Курсор по мутациям ловит правку старого сообщения, даже когда его id
    // ≤ last_seen_id (инкрементальный синк по id такое пропускал).
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-000000000001";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "до правки"), 1)
        .await
        .unwrap();
    // Клиент уже видел это сообщение (id и updated_at=1).
    let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert!(none.is_empty());
    // Автор редактирует — updated_at прыгает на 5.
    assert!(edit_message(&pool, mid, "alice@local", "после правки", 5).await.unwrap());
    let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert_eq!(missed.len(), 1);
    assert_eq!(text_of(&missed[0]), "после правки");
    assert!(missed[0].edited);
}

#[tokio::test]
async fn read_receipt_surfaces_in_sync() {
    // Отправитель видит read=true после receipt получателя (галочка ✓✓).
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000bb";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "прочти меня"), 1)
        .await
        .unwrap();
    // До прочтения — read=false.
    let before = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(before.len(), 1);
    assert!(!before[0].read);
    // Получатель прочитал.
    store_read_receipt(&pool, mid, "bob@local", 7).await.unwrap();
    let after = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(after[0].read, "read-галочка после receipt");
}

#[tokio::test]
async fn read_receipt_rejects_non_participant() {
    // 1-1: посторонний не может ставить read-receipt; собеседники могут.
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000be";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "приват"), 1)
        .await
        .unwrap();
    assert!(is_conversation_participant(&pool, mid, "bob@local").await.unwrap());
    assert!(is_conversation_participant(&pool, mid, "alice@local").await.unwrap());
    assert!(
        !is_conversation_participant(&pool, mid, "mallory@local").await.unwrap(),
        "посторонний — не участник переписки"
    );
    // Несуществующее сообщение — тоже отказ.
    assert!(
        !is_conversation_participant(&pool, "00000000-0000-7000-8000-00000000dead", "bob@local")
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn read_receipt_group_requires_membership() {
    // В группе только участник (не забаненный / не посторонний) ставит receipt.
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    let mid = "00000000-0000-7000-8000-0000000000d9";
    store_message(&pool, &send_event(mid, "alice@local", &gid, "групповое"), 2)
        .await
        .unwrap();
    assert!(is_conversation_participant(&pool, mid, "bob@local").await.unwrap());
    assert!(is_conversation_participant(&pool, mid, "alice@local").await.unwrap());
    assert!(
        !is_conversation_participant(&pool, mid, "carol@local").await.unwrap(),
        "не член группы не ставит receipt"
    );
}

#[tokio::test]
async fn group_read_state_is_per_requester() {
    // В группе read зависит от запрашивающего: получатель считает своё
    // прочтение, автор видит ✓✓ по receipt любого другого участника.
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    let mid = "00000000-0000-7000-8000-0000000000d1";
    store_message(&pool, &send_event(mid, "alice@local", &gid, "групповое"), 2)
        .await
        .unwrap();

    let zero = "00000000-0000-0000-0000-000000000000";
    // Боб ещё не читал: для него unread, для автора — нет ✓✓.
    let bob_before = fetch_missed(&pool, "bob@local", zero, 0).await.unwrap();
    assert!(!bob_before[0].read, "непрочитанное групповое должно быть unread у получателя");
    let alice_before = fetch_missed(&pool, "alice@local", zero, 0).await.unwrap();
    assert!(!alice_before[0].read, "без чужих receipt автор не видит ✓✓");

    // Боб прочитал: у него read=true (переживает перезапуск), у автора ✓✓.
    store_read_receipt(&pool, mid, "bob@local", 7).await.unwrap();
    let bob_after = fetch_missed(&pool, "bob@local", zero, 0).await.unwrap();
    assert!(bob_after[0].read, "своё прочтение группового должно приходить из sync");
    let alice_after = fetch_missed(&pool, "alice@local", zero, 0).await.unwrap();
    assert!(alice_after[0].read, "receipt участника даёт автору ✓✓");
}

#[tokio::test]
async fn delete_message_only_by_author() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000cc";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "секрет"), 1)
        .await
        .unwrap();
    // Чужак не может удалить.
    assert!(!delete_message(&pool, mid, "bob@local", 3).await.unwrap());
    // Автор может.
    assert!(delete_message(&pool, mid, "alice@local", 4).await.unwrap());
    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed.len(), 1);
    assert!(missed[0].deleted);
}

#[tokio::test]
async fn store_message_rejects_duplicate_id() {
    let pool = test_pool().await;
    let ev = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "раз");
    store_message(&pool, &ev, 1).await.unwrap();
    // P-09: повтор того же id (даже с другим текстом) ОТКЛОНЯЕТСЯ ошибкой —
    // раньше INSERT OR IGNORE молча игнорировал, но копии и доставка шли с
    // контентом повтора под легитимным id.
    let dup = send_event("00000000-0000-7000-8000-000000000001", "alice@local", "bob@local", "два");
    assert!(store_message(&pool, &dup, 2).await.is_err(), "повтор id → ошибка");

    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed.len(), 1, "дубликата быть не должно");
    assert_eq!(text_of(&missed[0]), "раз", "первая запись сохраняется");
}

#[tokio::test]
async fn store_message_rejects_oversized_content() {
    let pool = test_pool().await;
    let big = "x".repeat(MAX_CONTENT_BYTES + 1);
    let ev = send_event("00000000-0000-7000-8000-000000000002", "alice@local", "bob@local", &big);
    assert!(store_message(&pool, &ev, 1).await.is_err(), "контент сверх лимита отклонён");
}

// ── медиа-сообщения ──

#[tokio::test]
async fn store_and_fetch_voice_message() {
    let pool = test_pool().await;
    let file_id = uuid::Uuid::now_v7();
    let ev = send_content(
        "00000000-0000-7000-8000-0000000000f1",
        "alice@local",
        "bob@local",
        MessageContent::Voice {
            file_id,
            duration_secs: 5,
            mime: "audio/ogg".into(),
            size_bytes: 4096,
        },
    );
    store_message(&pool, &ev, 1).await.unwrap();

    // kind пишется отдельной колонкой для фильтрации
    let kind: (String,) = sqlx::query_as("SELECT kind FROM messages WHERE id = ?")
        .bind("00000000-0000-7000-8000-0000000000f1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kind.0, "voice");

    // content десериализуется обратно в тот же вариант
    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed.len(), 1);
    match &missed[0].content {
        MessageContent::Voice { file_id: f, duration_secs, size_bytes, .. } => {
            assert_eq!(*f, file_id);
            assert_eq!(*duration_secs, 5);
            assert_eq!(*size_bytes, 4096);
        }
        other => panic!("ожидался Voice, получено {:?}", other),
    }
}

// ── read receipts ──

#[tokio::test]
async fn read_receipt_stored_once() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000aa";
    store_read_receipt(&pool, mid, "bob@local", 5).await.unwrap();
    store_read_receipt(&pool, mid, "bob@local", 6).await.unwrap(); // идемпотентно

    let count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM read_receipts WHERE message_id = ? AND reader = ?")
            .bind(mid)
            .bind("bob@local")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count.0, 1);
}

// ── реакции ──

#[tokio::test]
async fn reaction_surfaces_in_sync_with_mine_flag() {
    // Реакция видна в синке как агрегат; mine=true только для реагировавшего.
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000d1";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "лайкни"), 1)
        .await
        .unwrap();
    set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();

    // Для bob (реагировал) mine=true.
    let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(for_bob[0].reactions.len(), 1);
    assert_eq!(for_bob[0].reactions[0].emoji, "👍");
    assert_eq!(for_bob[0].reactions[0].count, 1);
    assert!(for_bob[0].reactions[0].mine, "bob реагировал → mine");

    // Для alice (не реагировала) mine=false, но count тот же.
    let for_alice = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(for_alice[0].reactions[0].count, 1);
    assert!(!for_alice[0].reactions[0].mine, "alice не реагировала → не mine");
}

#[tokio::test]
async fn reaction_counts_aggregate_across_reactors() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000d2";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "разные реакции"), 1)
        .await
        .unwrap();
    set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
    set_reaction(&pool, mid, "carol@local", "👍", 3).await.unwrap();
    set_reaction(&pool, mid, "dave@local", "❤️", 4).await.unwrap();

    let missed = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    let thumbs = missed[0].reactions.iter().find(|r| r.emoji == "👍").unwrap();
    let heart = missed[0].reactions.iter().find(|r| r.emoji == "❤️").unwrap();
    assert_eq!(thumbs.count, 2, "две реакции 👍");
    assert_eq!(heart.count, 1, "одна ❤️");
}

#[tokio::test]
async fn reaction_upsert_one_per_reactor() {
    // Одна реакция на пользователя: повторная заменяет прежнюю, не плюсует.
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000d3";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "передумал"), 1)
        .await
        .unwrap();
    set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
    set_reaction(&pool, mid, "bob@local", "❤️", 3).await.unwrap();

    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(missed[0].reactions.len(), 1, "у bob ровно одна реакция");
    assert_eq!(missed[0].reactions[0].emoji, "❤️", "последняя побеждает");
}

#[tokio::test]
async fn reaction_empty_emoji_removes() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000d4";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "снять"), 1)
        .await
        .unwrap();
    set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
    set_reaction(&pool, mid, "bob@local", "", 3).await.unwrap(); // снятие

    let missed = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(missed[0].reactions.is_empty(), "реакция снята");
}

#[tokio::test]
async fn reaction_bumps_mutation_cursor() {
    // Реакция на старое сообщение поднимает его в синке по updated_at-курсору.
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000d5";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "старое"), 1)
        .await
        .unwrap();
    // Клиент уже видел это (id и updated_at=1) — синк пуст.
    let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert!(none.is_empty());
    // Реакция бампает updated_at на 9.
    set_reaction(&pool, mid, "bob@local", "🔥", 9).await.unwrap();
    let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert_eq!(missed.len(), 1, "мутация-реакция поднялась по курсору");
    assert_eq!(missed[0].reactions[0].emoji, "🔥");
}

// ── закрепление ──

#[tokio::test]
async fn pin_and_unpin_surfaces_in_sync() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000e1";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "закрепи"), 1)
        .await
        .unwrap();
    // По умолчанию не закреплено.
    let before = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(!before[0].pinned);
    // Закрепляем.
    set_pinned(&pool, mid, true, 2).await.unwrap();
    let pinned = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(pinned[0].pinned, "закреплено");
    // Открепляем.
    set_pinned(&pool, mid, false, 3).await.unwrap();
    let unpinned = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(!unpinned[0].pinned, "откреплено");
}

#[tokio::test]
async fn pin_bumps_mutation_cursor() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000e2";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "старое"), 1)
        .await
        .unwrap();
    let none = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert!(none.is_empty());
    set_pinned(&pool, mid, true, 8).await.unwrap();
    let missed = fetch_missed(&pool, "alice@local", mid, 1).await.unwrap();
    assert_eq!(missed.len(), 1, "закрепление поднялось по курсору");
    assert!(missed[0].pinned);
}

// ── группы и каналы ──

// P-41: GC физически убирает старые tombstone'ы и доставленные строки очереди;
// удаление группы затирает её сообщения
#[tokio::test]
async fn gc_removes_old_tombstones_and_delivered_queue() {
    let pool = test_pool().await;
    let old_id = "00000000-0000-7000-8000-0000000000a1";
    let fresh_id = "00000000-0000-7000-8000-0000000000a2";
    let text = |t: &str| MessageContent::Text { text: t.into(), entities: vec![], webpage: None };
    store_message(&pool, &send_content(old_id, "alice@local", "bob@local", text("old")), 1).await.unwrap();
    store_message(&pool, &send_content(fresh_id, "alice@local", "bob@local", text("fresh")), 2).await.unwrap();
    enqueue(&pool, "bob@local", old_id, 1).await.unwrap();
    enqueue(&pool, "bob@local", fresh_id, 2).await.unwrap();
    assert!(ack_delivered(&pool, "bob@local", fresh_id).await.unwrap());
    assert!(delete_message(&pool, old_id, "alice@local", 10).await.unwrap());
    let now = 10 + TOMBSTONE_TTL_SECS + 1;
    let (removed, queue) = gc_messenger(&pool, now).await.unwrap();
    assert_eq!(removed, 1, "старый tombstone удалён физически");
    assert!(queue >= 1, "доставленные/старые строки очереди вычищены");
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id = ?").bind(old_id).fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
    let fresh_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id = ?").bind(fresh_id).fetch_one(&pool).await.unwrap();
    assert_eq!(fresh_left, 1, "живое сообщение не тронуто");
    // Свежий tombstone (моложе TTL) остаётся для sync
    assert!(delete_message(&pool, fresh_id, "alice@local", now).await.unwrap());
    let (removed2, _) = gc_messenger(&pool, now + 1).await.unwrap();
    assert_eq!(removed2, 0);
}

#[tokio::test]
async fn delete_group_tombstones_its_messages() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "g", GroupKind::Group, "owner@local", &["m@local".into()], 1).await.unwrap();
    let mid = "00000000-0000-7000-8000-0000000000a3";
    let content = MessageContent::GroupEncrypted {
        ciphertext: "c".into(), group: gid.clone(), sender_identity: "i".into(), sender_signing_key: String::new(),
    };
    store_message(&pool, &send_content(mid, "owner@local", &gid, content), 2).await.unwrap();
    assert!(delete_group(&pool, &gid, "owner@local").await.unwrap());
    let (deleted, kind): (i64, String) = sqlx::query_as("SELECT deleted, kind FROM messages WHERE id = ?").bind(mid).fetch_one(&pool).await.unwrap();
    assert_eq!((deleted, kind.as_str()), (1, "text"), "сообщения группы затёрты");
}

// P-34 + spec 003: инвайты — срок, число использований, отзыв (group_mgmt)
#[tokio::test]
async fn invites_expire_are_limited_and_revocable() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "g", GroupKind::Group, "owner@local", &[], 1).await.unwrap();
    let join = |tok: &'static str, user: &'static str, now: i64| {
        let pool = pool.clone();
        async move { group_mgmt::join_by_invite(&pool, tok, user, now).await.unwrap().0.ok }
    };
    sqlx::query("INSERT INTO group_invites (token, group_id, created_by, created_at, expires_at, max_uses, uses) VALUES ('t1', ?, 'owner@local', 1, 100, 2, 0)")
        .bind(&gid).execute(&pool).await.unwrap();
    assert!(join("t1", "a@local", 50).await);
    assert!(join("t1", "b@local", 60).await);
    assert!(!join("t1", "c@local", 70).await, "лимит использований");
    sqlx::query("INSERT INTO group_invites (token, group_id, created_by, created_at, expires_at, max_uses, uses) VALUES ('t2', ?, 'owner@local', 1, 100, 0, 0)")
        .bind(&gid).execute(&pool).await.unwrap();
    assert!(!join("t2", "c@local", 200).await, "истёкшая ссылка");
    assert!(join("t2", "c@local", 90).await);
    assert!(!group_mgmt::revoke_invite(&pool, &gid, "stranger@local", "t2", 91).await.unwrap().ok, "чужой не отзывает");
    assert!(group_mgmt::revoke_invite(&pool, &gid, "owner@local", "t2", 91).await.unwrap().ok);
    assert!(!join("t2", "d@local", 92).await, "отозванная не работает");
    // Legacy-строки (expires_at/max_uses = 0) остаются рабочими
    sqlx::query("INSERT INTO group_invites (token, group_id, created_by, created_at) VALUES ('t3', ?, 'owner@local', 1)")
        .bind(&gid).execute(&pool).await.unwrap();
    assert!(join("t3", "e@local", 1_000_000).await);
}

#[tokio::test]
async fn group_add_respects_consent_and_size_cap() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "g", GroupKind::Group, "owner@local", &["a@local".into()], 1).await.unwrap();
    sqlx::query("INSERT INTO user_settings (user, notify_json, updated_at) VALUES ('shy@local', '{\"group_add\":\"nobody\"}', 1)")
        .execute(&pool).await.unwrap();
    assert!(!allows_group_add(&pool, "shy@local").await.unwrap());
    assert!(allows_group_add(&pool, "a@local").await.unwrap());
    assert!(add_group_member(&pool, &gid, "owner@local", "shy@local").await.is_err(), "без согласия — отказ");
    assert!(add_group_member(&pool, &gid, "owner@local", "b@local").await.unwrap());
    let gid2 = create_group(&pool, "g2", GroupKind::Group, "owner@local", &["shy@local".into(), "c@local".into()], 1).await.unwrap();
    assert!(member_role(&pool, &gid2, "shy@local").await.unwrap().is_none(), "не добавлен при создании");
    assert!(member_role(&pool, &gid2, "c@local").await.unwrap().is_some());
    std::env::set_var("PARVANE_GROUP_MAX_MEMBERS", "3");
    assert!(add_group_member(&pool, &gid, "owner@local", "d@local").await.is_err(), "переполнение (owner,a,b)");
    std::env::remove_var("PARVANE_GROUP_MAX_MEMBERS");
}

#[tokio::test]
async fn create_group_owner_and_members() {
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "Наша группа", GroupKind::Group, "alice@local",
        &["bob@local".into(), "carol@local".into()], 1,
    )
    .await
    .unwrap();
    let info = group_info(&pool, &gid, None).await.unwrap().unwrap();
    assert_eq!(info.name, "Наша группа");
    assert_eq!(info.created_by, "alice@local");
    assert_eq!(info.members.len(), 3, "owner + 2 участника");
    let owner = info.members.iter().find(|m| m.address == "alice@local").unwrap();
    assert_eq!(owner.role, "owner");
}

#[tokio::test]
async fn group_message_fans_out_to_members_only() {
    // Сообщение в группу видят участники, но не посторонние.
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    let mid = "00000000-0000-7000-8000-0000000000a1";
    // сообщение alice → группе (to_user = gid)
    store_message(&pool, &send_event(mid, "alice@local", &gid, "всем привет"), 2)
        .await
        .unwrap();

    // bob (участник) видит
    let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(for_bob.len(), 1);
    assert_eq!(for_bob[0].to, gid);
    assert_eq!(text_of(&for_bob[0]), "всем привет");
    // alice (отправитель+участник) видит своё
    let for_alice = fetch_missed(&pool, "alice@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(for_alice.len(), 1);
    // mallory (не участник) не видит
    let for_mallory = fetch_missed(&pool, "mallory@evil", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(for_mallory.is_empty(), "посторонний не видит групповые сообщения");
}

#[tokio::test]
async fn add_and_remove_members_respect_roles() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "g", GroupKind::Group, "alice@local", &[], 1)
        .await
        .unwrap();
    // owner добавляет bob
    assert!(add_group_member(&pool, &gid, "alice@local", "bob@local").await.unwrap());
    // не-участник добавить не может
    assert!(!add_group_member(&pool, &gid, "mallory@evil", "eve@evil").await.unwrap());
    // обычный участник (bob) добавляет по праву по умолчанию invite_users
    // (spec 003, как в Telegram); после выключения права — не может
    assert!(add_group_member(&pool, &gid, "bob@local", "eve@evil").await.unwrap());
    assert!(remove_group_member(&pool, &gid, "alice@local", "eve@evil").await.unwrap());
    let perms = parvane_types::DefaultPermissions { invite_users: false, ..Default::default() };
    group_mgmt::set_perms(&pool, &gid, "alice@local", &perms).await.unwrap();
    assert!(!add_group_member(&pool, &gid, "bob@local", "eve@evil").await.unwrap());
    // bob сам выходит
    assert!(remove_group_member(&pool, &gid, "bob@local", "bob@local").await.unwrap());
    // owner нельзя удалить
    assert!(!remove_group_member(&pool, &gid, "alice@local", "alice@local").await.unwrap());
    let info = group_info(&pool, &gid, None).await.unwrap().unwrap();
    assert_eq!(info.members.len(), 1, "остался только owner");
}

#[tokio::test]
async fn channel_only_admins_post() {
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "Канал", GroupKind::Channel, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    // owner может писать в канал
    assert!(can_post(&pool, &gid, "alice@local").await.unwrap());
    // обычный подписчик (bob) — не может
    assert!(!can_post(&pool, &gid, "bob@local").await.unwrap());
    // посторонний — не может
    assert!(!can_post(&pool, &gid, "mallory@evil").await.unwrap());
}

#[tokio::test]
async fn group_any_member_posts_1on1_always() {
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    assert!(can_post(&pool, &gid, "bob@local").await.unwrap(), "участник группы пишет");
    assert!(!can_post(&pool, &gid, "mallory@evil").await.unwrap(), "не-участник не пишет");
    // 1-на-1 (to = обычный адрес, не группа) — всегда можно
    assert!(can_post(&pool, "bob@local", "alice@local").await.unwrap());
}

#[tokio::test]
async fn group_message_actions_respect_membership_and_admin_roles() {
    let pool = test_pool().await;
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local", &["bob@local".into()], 1,
    )
    .await
    .unwrap();
    let mid = "00000000-0000-7000-8000-0000000000a4";
    store_message(&pool, &send_event(mid, "alice@local", &gid, "group action"), 1)
        .await
        .unwrap();

    assert!(can_mutate_message(&pool, mid, "bob@local", None, "react", false)
        .await
        .unwrap());
    assert!(!can_mutate_message(&pool, mid, "mallory@evil", None, "react", false)
        .await
        .unwrap());
    assert!(!can_mutate_message(&pool, mid, "bob@local", None, "pin", true)
        .await
        .unwrap());
    assert!(can_mutate_message(&pool, mid, "alice@local", None, "pin", true)
        .await
        .unwrap());
}

#[tokio::test]
async fn list_groups_returns_users_groups() {
    let pool = test_pool().await;
    let g1 = create_group(&pool, "G1", GroupKind::Group, "alice@local", &["bob@local".into()], 1)
        .await
        .unwrap();
    let _g2 = create_group(&pool, "G2", GroupKind::Group, "carol@local", &[], 1)
        .await
        .unwrap();
    // bob состоит только в G1
    let bobs = list_groups(&pool, "bob@local").await.unwrap();
    assert_eq!(bobs.len(), 1);
    assert_eq!(bobs[0].group_id, g1);
    // carol — только в своей G2
    let carols = list_groups(&pool, "carol@local").await.unwrap();
    assert_eq!(carols.len(), 1);
    assert_eq!(carols[0].name, "G2");
}

// ── Фаза 1: доставка, очередь, ack ──

#[tokio::test]
async fn resolve_recipients_direct_and_group() {
    let pool = test_pool().await;
    // 1-на-1 → сам адрес
    let r = resolve_recipients(&pool, "bob@local", "alice@local").await.unwrap();
    assert_eq!(r, vec!["bob@local".to_string()]);
    // группа → участники минус отправитель
    let gid = create_group(
        &pool, "g", GroupKind::Group, "alice@local",
        &["bob@local".into(), "carol@local".into()], 1,
    )
    .await
    .unwrap();
    let mut g = resolve_recipients(&pool, &gid, "alice@local").await.unwrap();
    g.sort();
    assert_eq!(g, vec!["bob@local".to_string(), "carol@local".to_string()]);
}

#[tokio::test]
async fn queue_enqueue_ack_pending() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f7";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "в очередь"), 1)
        .await
        .unwrap();
    enqueue(&pool, "bob@local", mid, 1).await.unwrap();
    enqueue(&pool, "bob@local", mid, 1).await.unwrap(); // идемпотентно
    let pend = pending_for(&pool, "bob@local", 10).await.unwrap();
    assert_eq!(pend.len(), 1);
    assert_eq!(text_of(&pend[0]), "в очередь");
    // ack снимает; повторный ack — no-op
    assert!(ack_delivered(&pool, "bob@local", mid).await.unwrap());
    assert!(!ack_delivered(&pool, "bob@local", mid).await.unwrap());
    assert!(pending_for(&pool, "bob@local", 10).await.unwrap().is_empty());
}

#[tokio::test]
async fn rename_group_requires_owner_or_admin() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "Старое", GroupKind::Group, "owner@l",
        &["bob@l".into(), "adm@l".into()], 0).await.unwrap();
    assert!(set_group_role(&pool, &gid, "owner@l", "adm@l", "admin").await.unwrap());

    // member не может, owner и admin могут; пустое имя отклоняется
    assert!(!rename_group(&pool, &gid, "bob@l", "Взлом").await.unwrap());
    assert!(rename_group(&pool, &gid, "owner@l", "Новое").await.unwrap());
    assert!(rename_group(&pool, &gid, "adm@l", "Ещё новее").await.unwrap());
    assert!(!rename_group(&pool, &gid, "owner@l", "   ").await.unwrap());
    let info = group_info(&pool, &gid, None).await.unwrap().unwrap();
    assert_eq!(info.name, "Ещё новее");
}

#[tokio::test]
async fn delete_group_is_owner_only_and_wipes_membership() {
    let pool = test_pool().await;
    let gid = create_group(&pool, "Тест", GroupKind::Group, "owner@l",
        &["bob@l".into()], 0).await.unwrap();

    assert!(!delete_group(&pool, &gid, "bob@l").await.unwrap());
    assert!(delete_group(&pool, &gid, "owner@l").await.unwrap());
    assert!(group_info(&pool, &gid, None).await.unwrap().is_none());
    assert!(list_groups(&pool, "bob@l").await.unwrap().is_empty());
    // Повторное удаление — no-op
    assert!(!delete_group(&pool, &gid, "owner@l").await.unwrap());
}

#[tokio::test]
async fn sealed_message_hides_sender_but_reaches_recipient() {
    // Sealed sender (Фаза 2): from пустой. Получатель видит сообщение (from=""),
    // посторонний — нет, отправитель по from не находит (скрыт).
    let pool = test_pool().await;
    let ev = send_event("00000000-0000-7000-8000-0000000000e5", "", "bob@local", "sealed-ct");
    store_message(&pool, &ev, 1).await.unwrap();

    // получатель bob видит; from скрыт (пустой)
    let for_bob = fetch_missed(&pool, "bob@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert_eq!(for_bob.len(), 1);
    assert_eq!(for_bob[0].from, "", "отправитель скрыт");
    assert_eq!(for_bob[0].to, "bob@local");

    // посторонний carol не видит
    let for_carol = fetch_missed(&pool, "carol@local", "00000000-0000-0000-0000-000000000000", 0)
        .await
        .unwrap();
    assert!(for_carol.is_empty(), "посторонний не видит sealed-сообщение");

    // resolve_recipients с пустым from → [to]
    let r = resolve_recipients(&pool, "bob@local", "").await.unwrap();
    assert_eq!(r, vec!["bob@local".to_string()]);
}

#[test]
fn link_transfer_proves_old_key_only_with_valid_statement() {
    use ed25519_dalek::{Signer, SigningKey};
    let old = SigningKey::from_bytes(&[11_u8; 32]);
    let new = SigningKey::from_bytes(&[12_u8; 32]);
    let old_key = STANDARD_NO_PAD.encode(old.verifying_key().to_bytes());
    let new_key = STANDARD_NO_PAD.encode(new.verifying_key().to_bytes());
    let statement = format!("link-transfer:alice@local:{old_key}:{new_key}");
    let sig = STANDARD_NO_PAD.encode(old.sign(statement.as_bytes()).to_bytes());
    let payload = |signature: String| SyncRequestPayload {
        last_seen_id: "0".into(), device_id: String::new(), since_updated: 0,
        sender_signing_key: None, signature: None, extra_signing: vec![],
        transfers: vec![parvane_types::SyncTransfer { old_signing_key: old_key.clone(), signature }],
    };
    assert_eq!(authenticated_transfer_keys(&payload(sig.clone()), "alice@local", &new_key), vec![old_key.clone()]);
    // Другой пользователь / другой новый ключ / битая подпись — не доказано.
    assert!(authenticated_transfer_keys(&payload(sig.clone()), "bob@local", &new_key).is_empty());
    assert!(authenticated_transfer_keys(&payload(sig.clone()), "alice@local", &old_key).is_empty());
    assert!(authenticated_transfer_keys(&payload("AAAA".into()), "alice@local", &new_key).is_empty());
    assert!(authenticated_transfer_keys(&payload(sig), "alice@local", "").is_empty(), "без доказанного нового ключа — ничего");
}

#[tokio::test]
async fn linked_extra_signing_reveals_previous_device_outgoing() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000e7";
    let old_signing = SigningKey::from_bytes(&[9_u8; 32]);
    let old_key = STANDARD_NO_PAD.encode(old_signing.verifying_key().to_bytes());
    let content = MessageContent::Encrypted {
        ciphertext: "old-outgoing".into(),
        ctype: 1,
        sender_identity: "old-curve".into(),
        sender_signing_key: old_key.clone(),
    };
    store_message(&pool, &send_content(mid, "", "bob@local", content), 1)
        .await
        .unwrap();

    // Новое устройство alice со СВОИМ ключом старое sealed-исходящее не видит…
    let fresh = fetch_missed_with_keys(&pool, "alice@local", "0", 0, "fresh-key", "dev-new", &[])
        .await
        .unwrap();
    assert!(fresh.is_empty(), "без доказанного старого ключа исходящее скрыто");

    // …а с доказанным старым ключом (авто-линковка) — видит
    let linked = fetch_missed_with_keys(
        &pool,
        "alice@local",
        "0",
        0,
        "fresh-key",
        "dev-new",
        std::slice::from_ref(&old_key),
    )
    .await
    .unwrap();
    assert_eq!(linked.len(), 1, "старое исходящее возвращается по linked-ключу");

    // Доказательство владения: валидная подпись проходит, мусор — нет
    let signed = "sync:0:0";
    let good = STANDARD_NO_PAD.encode(old_signing.sign(signed.as_bytes()).to_bytes());
    let payload = SyncRequestPayload {
        last_seen_id: "0".into(),
        device_id: "dev-new".into(),
        since_updated: 0,
        sender_signing_key: None,
        signature: None,
        extra_signing: vec![
            parvane_types::SyncExtraSigning { signing_key: old_key.clone(), signature: good },
            parvane_types::SyncExtraSigning { signing_key: old_key.clone(), signature: "bad".into() },
        ], transfers: vec![],
    };
    assert_eq!(authenticated_extra_signing_keys(&payload), vec![old_key]);
}

#[tokio::test]
async fn sealed_author_proves_readers_access_by_signature() {
    // «read at» по своему sealed-исходящему: from_user пуст, участие
    // автора доказывает подпись над `readers:<id>`; чужая подпись — отказ
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000e9";
    let signing = SigningKey::from_bytes(&[11_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let content = MessageContent::Encrypted {
        ciphertext: "cipher".into(),
        ctype: 0,
        sender_identity: "curve-key".into(),
        sender_signing_key: signing_key,
    };
    store_message(&pool, &send_content(mid, "", "bob@local", content), 1)
        .await
        .unwrap();
    let payload = format!("readers:{mid}");
    assert!(is_conversation_participant(&pool, mid, "bob@local").await.unwrap());
    assert!(!is_conversation_participant(&pool, mid, "alice@local").await.unwrap());
    assert!(!can_mutate_message(&pool, mid, "alice@local", None, &payload, false).await.unwrap());
    let good = STANDARD_NO_PAD.encode(signing.sign(payload.as_bytes()).to_bytes());
    assert!(can_mutate_message(&pool, mid, "alice@local", Some(&good), &payload, false).await.unwrap());
    let other = SigningKey::from_bytes(&[12_u8; 32]);
    let bad = STANDARD_NO_PAD.encode(other.sign(payload.as_bytes()).to_bytes());
    assert!(!can_mutate_message(&pool, mid, "alice@local", Some(&bad), &payload, false).await.unwrap());
}

// P-10 (SEND-1): владение sender_signing_key доказывается подписью
// `send:<id>:<ciphertext>`; self-копии с signing_key без ключа — отказ.
#[test]
fn authenticate_send_requires_signature_over_send_statement() {
    let mid = "00000000-0000-7000-8000-0000000000f1";
    let signing = SigningKey::from_bytes(&[21_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let content = MessageContent::Encrypted {
        ciphertext: "cipher-1".into(),
        ctype: 0,
        sender_identity: "curve".into(),
        sender_signing_key: signing_key.clone(),
    };
    let mut payload = SendPayload { to: "bob@local".into(), content, reply_to: None, copies: vec![], signature: None };
    assert!(authenticate_send(&payload, mid).is_err(), "без подписи — отказ");
    payload.signature = Some("bad".into());
    assert!(authenticate_send(&payload, mid).is_err(), "мусорная подпись — отказ");
    let other = SigningKey::from_bytes(&[22_u8; 32]);
    payload.signature = Some(STANDARD_NO_PAD.encode(other.sign(format!("send:{mid}:cipher-1").as_bytes()).to_bytes()));
    assert!(authenticate_send(&payload, mid).is_err(), "подпись чужим ключом — отказ (чужой sender_signing_key)");
    payload.signature = Some(STANDARD_NO_PAD.encode(signing.sign(format!("send:{mid}:cipher-2").as_bytes()).to_bytes()));
    assert!(authenticate_send(&payload, mid).is_err(), "подпись другого шифртекста — отказ");
    payload.signature = Some(STANDARD_NO_PAD.encode(signing.sign(format!("send:{mid}:cipher-1").as_bytes()).to_bytes()));
    assert!(authenticate_send(&payload, mid).is_ok(), "верная подпись — ок");
    assert!(authenticate_send(&payload, "00000000-0000-7000-8000-0000000000f2").is_err(), "подпись привязана к id");

    // Legacy без sender_signing_key: подпись не нужна, но self-копии с ключом запрещены
    let legacy = MessageContent::Encrypted {
        ciphertext: "c".into(), ctype: 0, sender_identity: "curve".into(), sender_signing_key: String::new(),
    };
    let mut legacy_payload = SendPayload { to: "bob@local".into(), content: legacy, reply_to: None, copies: vec![], signature: None };
    assert!(authenticate_send(&legacy_payload, mid).is_ok());
    legacy_payload.copies.push(MessageDeviceCopy {
        recipient: String::new(), signing_key: signing_key.clone(), device_id: "d".into(), ciphertext: "x".into(), ctype: 0,
    });
    assert!(authenticate_send(&legacy_payload, mid).is_err(), "self-копия с чужим ключом без доказательства — отказ");
}

// P-10: выборка по signing-ключу в sync — только среди сообщений того же
// владельца (sender_user по токену): чужое сообщение с моим публичным
// ключом в content не попадает в мою ленту.
#[tokio::test]
async fn sync_by_signing_key_requires_same_sender_user() {
    let pool = test_pool().await;
    let signing = SigningKey::from_bytes(&[23_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let content = |c: &str| MessageContent::Encrypted {
        ciphertext: c.into(), ctype: 0, sender_identity: "curve".into(), sender_signing_key: signing_key.clone(),
    };
    let mine = "00000000-0000-7000-8000-0000000000f3";
    let forged = "00000000-0000-7000-8000-0000000000f4";
    store_message_from(&pool, &send_content(mine, "", "bob@local", content("c1")), 1, "alice@local").await.unwrap();
    store_message_from(&pool, &send_content(forged, "", "carol@local", content("c2")), 2, "mallory@evil").await.unwrap();
    let page = fetch_missed_for_signing_key(&pool, "alice@local", "0", 0, &signing_key, "").await.unwrap();
    let ids: Vec<String> = page.iter().map(|m| m.id.to_string()).collect();
    assert!(ids.contains(&mine.to_string()), "своё sealed-исходящее по ключу видно");
    assert!(!ids.contains(&forged.to_string()), "чужое сообщение с моим ключом в content не выбирается");
    // Self-копии по signing_key — то же правило
    let forged_copy = "00000000-0000-7000-8000-0000000000f5";
    let mut ev = send_content(forged_copy, "", "carol@local", MessageContent::Encrypted {
        ciphertext: "c3".into(), ctype: 0, sender_identity: "curve".into(), sender_signing_key: String::new(),
    });
    ev.payload.copies.push(MessageDeviceCopy {
        recipient: String::new(), signing_key: signing_key.clone(), device_id: "dev-a".into(), ciphertext: "x".into(), ctype: 0,
    });
    store_message_from(&pool, &ev, 3, "mallory@evil").await.unwrap();
    let page = fetch_missed_for_signing_key(&pool, "alice@local", "0", 0, &signing_key, "dev-a").await.unwrap();
    assert!(!page.iter().any(|m| m.id.to_string() == forged_copy), "чужая self-копия с моим ключом не выбирается");
}

// P-22: E2E-сообщение нельзя понизить до plaintext правкой (ни legacy
// text-правкой, ни заменой content на Text, ни сменой вида E2E).
#[tokio::test]
async fn edit_cannot_downgrade_encrypted_to_plaintext() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f6";
    let signing = SigningKey::from_bytes(&[24_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let original = MessageContent::GroupEncrypted {
        ciphertext: "g-cipher".into(), group: "grp".into(), sender_identity: "curve".into(),
        sender_signing_key: signing_key.clone(),
    };
    store_message(&pool, &send_content(mid, "alice@local", "grp", original), 1).await.unwrap();
    assert!(!edit_message(&pool, mid, "alice@local", "plain text", 2).await.unwrap(), "legacy text-правка E2E — отказ");
    let plain = MessageContent::Text { text: "plain".into(), entities: vec![], webpage: None };
    assert!(!replace_message_content(&pool, mid, "alice@local", &plain, None, &[], 3).await.unwrap(), "замена на Text — отказ");
    let other_kind = MessageContent::Encrypted {
        ciphertext: "x".into(), ctype: 0, sender_identity: "curve".into(), sender_signing_key: signing_key.clone(),
    };
    let sig = STANDARD_NO_PAD.encode(signing.sign(format!("edit:{mid}:x").as_bytes()).to_bytes());
    assert!(!replace_message_content(&pool, mid, "alice@local", &other_kind, Some(&sig), &[], 4).await.unwrap(), "смена вида E2E — отказ");
    let same_kind = MessageContent::GroupEncrypted {
        ciphertext: "g-cipher-2".into(), group: "grp".into(), sender_identity: "curve".into(),
        sender_signing_key: signing_key.clone(),
    };
    assert!(replace_message_content(&pool, mid, "alice@local", &same_kind, None, &[], 5).await.unwrap(), "тот же вид от автора — ок");
    let kind: String = sqlx::query_scalar("SELECT kind FROM messages WHERE id = ?").bind(mid).fetch_one(&pool).await.unwrap();
    assert_eq!(kind, "group_encrypted");
}

#[tokio::test]
async fn sealed_mutations_require_the_original_signing_key() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000e6";
    let signing = SigningKey::from_bytes(&[7_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let original = MessageContent::Encrypted {
        ciphertext: "cipher-before".into(),
        ctype: 0,
        sender_identity: "curve-key".into(),
        sender_signing_key: signing_key.clone(),
    };
    store_message(&pool, &send_content(mid, "", "bob@local", original), 1)
        .await
        .unwrap();

    let edited = MessageContent::Encrypted {
        ciphertext: "cipher-after".into(),
        ctype: 1,
        sender_identity: "curve-key".into(),
        sender_signing_key: signing_key.clone(),
    };
    assert!(!replace_message_content(&pool, mid, "alice@local", &edited, Some("bad"), &[], 2)
        .await
        .unwrap());
    let edit_payload = format!("edit:{mid}:cipher-after");
    let edit_signature = STANDARD_NO_PAD.encode(signing.sign(edit_payload.as_bytes()).to_bytes());
    assert!(replace_message_content(
        &pool,
        mid,
        "alice@local",
        &edited,
        Some(&edit_signature),
        &[],
        3,
    )
    .await
    .unwrap());

    let changed = fetch_missed(&pool, "bob@local", mid, 1).await.unwrap();
    assert_eq!(changed.len(), 1);
    assert!(matches!(
        &changed[0].content,
        MessageContent::Encrypted { ciphertext, .. } if ciphertext == "cipher-after"
    ));

    let react_payload = format!("react:{mid}:👍");
    let react_signature = STANDARD_NO_PAD.encode(signing.sign(react_payload.as_bytes()).to_bytes());
    assert!(can_mutate_message(&pool, mid, "bob@local", None, &react_payload, false)
        .await
        .unwrap(), "получатель может реагировать");
    assert!(!can_mutate_message(&pool, mid, "mallory@evil", None, &react_payload, false)
        .await
        .unwrap(), "посторонний не может реагировать");
    assert!(can_mutate_message(
        &pool,
        mid,
        "alice@local",
        Some(&react_signature),
        &react_payload,
        false,
    )
    .await
    .unwrap(), "sealed-автор подтверждает действие подписью");
    assert!(!can_mutate_message(
        &pool,
        mid,
        "alice@local",
        Some("bad"),
        &react_payload,
        false,
    )
    .await
    .unwrap(), "неверная подпись отклоняется");

    let sync_payload = SyncRequestPayload {
        last_seen_id: "0".into(),
        device_id: String::new(),
        since_updated: 0,
        sender_signing_key: Some(signing_key.clone()),
        signature: None,
        extra_signing: vec![], transfers: vec![],
    };
    let sync_signed = format!("sync:{}:{}", sync_payload.last_seen_id, sync_payload.since_updated);
    let sync_signature = STANDARD_NO_PAD.encode(signing.sign(sync_signed.as_bytes()).to_bytes());
    let sync_payload = SyncRequestPayload { signature: Some(sync_signature), ..sync_payload };
    let authenticated_key = authenticated_sync_signing_key(&sync_payload).unwrap();
    let for_sender = fetch_missed_for_signing_key(&pool, "alice@local", "0", 0, authenticated_key, "")
        .await
        .unwrap();
    assert_eq!(for_sender.len(), 1, "sealed-автор получает собственное сообщение по подписанному sync");

    let delete_payload = format!("delete:{mid}");
    let delete_signature = STANDARD_NO_PAD.encode(signing.sign(delete_payload.as_bytes()).to_bytes());
    assert!(delete_sealed_message(&pool, mid, Some(&delete_signature), 4)
        .await
        .unwrap());
    let deleted = fetch_missed(&pool, "bob@local", mid, 3).await.unwrap();
    assert_eq!(deleted.len(), 1);
    assert!(deleted[0].deleted);
    assert!(matches!(
        &deleted[0].content,
        MessageContent::Encrypted { ciphertext, sender_signing_key, .. }
            if ciphertext.is_empty() && sender_signing_key == &signing_key
    ), "sealed tombstone сохраняет ключ авторизации sync");
    let deleted_for_sender = fetch_missed_for_signing_key(
        &pool,
        "alice@local",
        mid,
        3,
        &signing_key,
        "",
    )
    .await
    .unwrap();
    assert_eq!(deleted_for_sender.len(), 1);
    assert!(deleted_for_sender[0].deleted, "sealed-автор получает tombstone по sync");
}

// ── мультидевайс: per-device копии ──

fn sealed_send_with_copies(
    id: &str,
    to: &str,
    signing_key: &str,
    copies: Vec<MessageDeviceCopy>,
) -> ParvaneEvent<SendPayload> {
    let mut ev = send_content(id, "", to, MessageContent::Encrypted {
        ciphertext: "cipher-primary".into(),
        ctype: 0,
        sender_identity: "curve-key".into(),
        sender_signing_key: signing_key.into(),
    });
    ev.payload.copies = copies;
    ev
}

#[tokio::test]
async fn sync_substitutes_device_copy_per_requesting_device() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f1";
    let copies = vec![
        MessageDeviceCopy {
            recipient: "bob@local".into(),
            signing_key: String::new(),
            device_id: "dev-b2".into(),
            ciphertext: "cipher-for-b2".into(),
            ctype: 0,
        },
        // Self-копия для ДРУГОГО устройства alice: помечена ключом подписи
        // ЦЕЛЕВОГО устройства (dev-a2), не отправившего (alice-sign)
        MessageDeviceCopy {
            recipient: String::new(),
            signing_key: "alice-dev2-sign".into(),
            device_id: "dev-a2".into(),
            ciphertext: "cipher-for-a2".into(),
            ctype: 1,
        },
    ];
    store_message(&pool, &sealed_send_with_copies(mid, "bob@local", "alice-sign", copies), 1)
        .await
        .unwrap();

    // Primary-устройство bob ('' — desktop/legacy) получает основной шифртекст.
    let primary = fetch_missed(&pool, "bob@local", "0", 0).await.unwrap();
    assert!(matches!(
        &primary[0].content,
        MessageContent::Encrypted { ciphertext, .. } if ciphertext == "cipher-primary"
    ));

    // Второе устройство bob получает свою копию.
    let b2 = fetch_missed_for_signing_key(&pool, "bob@local", "0", 0, "", "dev-b2")
        .await
        .unwrap();
    assert!(matches!(
        &b2[0].content,
        MessageContent::Encrypted { ciphertext, ctype, .. }
            if ciphertext == "cipher-for-b2" && *ctype == 0
    ));

    // Второе устройство alice (self-копия по СВОЕМУ signing_key — сообщение
    // выбирается через EXISTS по копиям, не через sender_signing_key)
    let a2 = fetch_missed_for_signing_key(&pool, "alice@local", "0", 0, "alice-dev2-sign", "dev-a2")
        .await
        .unwrap();
    assert_eq!(a2.len(), 1);
    assert!(matches!(
        &a2[0].content,
        MessageContent::Encrypted { ciphertext, ctype, .. }
            if ciphertext == "cipher-for-a2" && *ctype == 1
    ));

    // Чужое устройство bob без копии — основной шифртекст (fallback).
    let unknown = fetch_missed_for_signing_key(&pool, "bob@local", "0", 0, "", "dev-ghost")
        .await
        .unwrap();
    assert!(matches!(
        &unknown[0].content,
        MessageContent::Encrypted { ciphertext, .. } if ciphertext == "cipher-primary"
    ));

    // Копия bob не выдаётся постороннему устройству под чужим адресом.
    let stranger = fetch_missed_for_signing_key(&pool, "carol@local", "0", 0, "", "dev-b2")
        .await
        .unwrap();
    assert!(stranger.is_empty(), "посторонний не получает sealed вообще");
}

#[tokio::test]
async fn sealed_edit_replaces_device_copies() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f2";
    let signing = SigningKey::from_bytes(&[9_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let copies = vec![MessageDeviceCopy {
        recipient: "bob@local".into(),
        signing_key: String::new(),
        device_id: "dev-b2".into(),
        ciphertext: "old-b2".into(),
        ctype: 0,
    }];
    store_message(&pool, &sealed_send_with_copies(mid, "bob@local", &signing_key, copies), 1)
        .await
        .unwrap();

    let edited = MessageContent::Encrypted {
        ciphertext: "new-primary".into(),
        ctype: 1,
        sender_identity: "curve-key".into(),
        sender_signing_key: signing_key.clone(),
    };
    let edit_payload = format!("edit:{mid}:new-primary");
    let edit_signature = STANDARD_NO_PAD.encode(signing.sign(edit_payload.as_bytes()).to_bytes());
    let new_copies = vec![MessageDeviceCopy {
        recipient: "bob@local".into(),
        signing_key: String::new(),
        device_id: "dev-b2".into(),
        ciphertext: "new-b2".into(),
        ctype: 1,
    }];
    assert!(replace_message_content(
        &pool, mid, "alice@local", &edited, Some(&edit_signature), &new_copies, 2,
    )
    .await
    .unwrap());

    let b2 = fetch_missed_for_signing_key(&pool, "bob@local", mid, 1, "", "dev-b2")
        .await
        .unwrap();
    assert!(matches!(
        &b2[0].content,
        MessageContent::Encrypted { ciphertext, .. } if ciphertext == "new-b2"
    ), "правка заменила копию устройства");
}

#[tokio::test]
async fn sealed_delete_clears_device_copies() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f3";
    let signing = SigningKey::from_bytes(&[11_u8; 32]);
    let signing_key = STANDARD_NO_PAD.encode(signing.verifying_key().to_bytes());
    let copies = vec![MessageDeviceCopy {
        recipient: "bob@local".into(),
        signing_key: String::new(),
        device_id: "dev-b2".into(),
        ciphertext: "b2".into(),
        ctype: 0,
    }];
    store_message(&pool, &sealed_send_with_copies(mid, "bob@local", &signing_key, copies), 1)
        .await
        .unwrap();

    let delete_signature =
        STANDARD_NO_PAD.encode(signing.sign(format!("delete:{mid}").as_bytes()).to_bytes());
    assert!(delete_sealed_message(&pool, mid, Some(&delete_signature), 2).await.unwrap());
    let left: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM message_device_copies WHERE message_id = ?")
            .bind(mid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left.0, 0, "tombstone затирает и per-device копии");
}

#[tokio::test]
async fn fetch_one_message_carries_reactions() {
    let pool = test_pool().await;
    let mid = "00000000-0000-7000-8000-0000000000f8";
    store_message(&pool, &send_event(mid, "alice@local", "bob@local", "с реакцией"), 1)
        .await
        .unwrap();
    set_reaction(&pool, mid, "bob@local", "👍", 2).await.unwrap();
    let m = fetch_one_message(&pool, "bob@local", mid).await.unwrap().unwrap();
    assert_eq!(text_of(&m), "с реакцией");
    assert_eq!(m.reactions.len(), 1);
    assert!(m.reactions[0].mine, "bob реагировал");
    // несуществующее сообщение → None
    assert!(fetch_one_message(&pool, "bob@local", "00000000-0000-7000-8000-000000000fff")
        .await
        .unwrap()
        .is_none());
}

// ── spec 003: права по умолчанию и права админов в существующих мутациях ──

async fn group_with_admin(pool: &SqlitePool) -> String {
    let gid = create_group(pool, "G", GroupKind::Group, "alice@local", &["bob@local".into(), "carol@local".into()], 1)
        .await
        .unwrap();
    // bob — админ только с pin_messages
    sqlx::query("UPDATE group_members SET role = 'admin', admin_rights_json = ?, promoted_by = 'alice@local' WHERE group_id = ? AND member = 'bob@local'")
        .bind(serde_json::to_string(&parvane_types::AdminRights { change_info: false, delete_messages: false, ban_users: false, invite_users: false, pin_messages: true, add_admins: false }).unwrap())
        .bind(&gid)
        .execute(pool)
        .await
        .unwrap();
    gid
}

#[tokio::test]
async fn can_post_respects_send_messages() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    assert!(can_post(&pool, &gid, "carol@local").await.unwrap());
    let perms = parvane_types::DefaultPermissions { send_messages: false, ..Default::default() };
    assert!(group_mgmt::set_perms(&pool, &gid, "alice@local", &perms).await.unwrap().ok);
    assert!(!can_post(&pool, &gid, "carol@local").await.unwrap(), "участник без send_messages");
    assert!(can_post(&pool, &gid, "alice@local").await.unwrap(), "владелец пишет");
    assert!(can_post(&pool, &gid, "bob@local").await.unwrap(), "админ пишет");
    assert!(!can_post(&pool, &gid, "nobody@local").await.unwrap());
    // канал — как раньше
    let ch = create_group(&pool, "C", GroupKind::Channel, "alice@local", &["carol@local".into()], 1).await.unwrap();
    assert!(!can_post(&pool, &ch, "carol@local").await.unwrap());
    assert!(can_post(&pool, &ch, "alice@local").await.unwrap());
}

#[tokio::test]
async fn addmember_respects_invite_users() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    // участник — по умолчанию invite_users включён
    assert!(add_group_member(&pool, &gid, "carol@local", "dave@local").await.unwrap());
    // админ без invite_users — нет
    assert!(!add_group_member(&pool, &gid, "bob@local", "eve@local").await.unwrap());
    let perms = parvane_types::DefaultPermissions { invite_users: false, ..Default::default() };
    group_mgmt::set_perms(&pool, &gid, "alice@local", &perms).await.unwrap();
    assert!(!add_group_member(&pool, &gid, "carol@local", "eve@local").await.unwrap());
    assert!(add_group_member(&pool, &gid, "alice@local", "eve@local").await.unwrap());
}

#[tokio::test]
async fn pin_respects_pin_messages() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    let mid = "00000000-0000-7000-8000-00000000aa01";
    store_message(&pool, &send_event(mid, "alice@local", &gid, "закрепи"), 1).await.unwrap();
    assert!(can_mutate_message(&pool, mid, "bob@local", None, "pin", true).await.unwrap(), "админ с pin_messages");
    assert!(!can_mutate_message(&pool, mid, "carol@local", None, "pin", true).await.unwrap(), "участник без права");
    let perms = parvane_types::DefaultPermissions { pin_messages: true, ..Default::default() };
    group_mgmt::set_perms(&pool, &gid, "alice@local", &perms).await.unwrap();
    assert!(can_mutate_message(&pool, mid, "carol@local", None, "pin", true).await.unwrap(), "участник с default pin");
    // rename: change_info
    assert!(!rename_group(&pool, &gid, "carol@local", "X").await.unwrap());
    assert!(!rename_group(&pool, &gid, "bob@local", "X").await.unwrap());
    assert!(rename_group(&pool, &gid, "alice@local", "X").await.unwrap());
}

#[tokio::test]
async fn ban_requires_ban_users_and_admin_cannot_ban_admin() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    assert!(!ban_group_member(&pool, &gid, "bob@local", "carol@local", true).await.unwrap(), "админ без ban_users");
    assert!(!ban_group_member(&pool, &gid, "carol@local", "bob@local", true).await.unwrap(), "участник");
    assert!(!mute_group_member(&pool, &gid, "bob@local", "carol@local", 999).await.unwrap());
    assert!(!remove_group_member(&pool, &gid, "bob@local", "carol@local").await.unwrap());
    assert!(remove_group_member(&pool, &gid, "carol@local", "carol@local").await.unwrap(), "выход сам");
    // dave — админ с ban_users, но не владелец: банит участников, не админов
    add_group_member(&pool, &gid, "alice@local", "dave@local").await.unwrap();
    add_group_member(&pool, &gid, "alice@local", "erin@local").await.unwrap();
    assert!(group_mgmt::set_admin(&pool, &gid, "alice@local", "dave@local", Some(&parvane_types::AdminRights::default())).await.unwrap().ok);
    assert!(ban_group_member(&pool, &gid, "dave@local", "erin@local", true).await.unwrap());
    assert!(!ban_group_member(&pool, &gid, "dave@local", "bob@local", true).await.unwrap(), "админ не банит админа");
    assert!(!mute_group_member(&pool, &gid, "dave@local", "bob@local", 999).await.unwrap());
    assert!(!remove_group_member(&pool, &gid, "dave@local", "bob@local").await.unwrap());
    assert!(ban_group_member(&pool, &gid, "alice@local", "bob@local", true).await.unwrap(), "владелец банит админа");
    assert!(!ban_group_member(&pool, &gid, "dave@local", "alice@local", true).await.unwrap(), "владельца нельзя");
}

#[tokio::test]
async fn delete_others_message_requires_delete_messages() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    let mid = "00000000-0000-7000-8000-00000000aa02";
    store_message(&pool, &send_event(mid, "carol@local", &gid, "удали меня"), 1).await.unwrap();
    assert!(!delete_message_as_group_admin(&pool, mid, "bob@local", 5).await.unwrap(), "админ без delete_messages");
    assert!(!delete_message_as_group_admin(&pool, mid, "carol@local", 5).await.unwrap(), "участник (свой путь — delete_message)");
    assert!(delete_message_as_group_admin(&pool, mid, "alice@local", 5).await.unwrap(), "владелец");
    let deleted: (i64,) = sqlx::query_as("SELECT deleted FROM messages WHERE id = ?").bind(mid).fetch_one(&pool).await.unwrap();
    assert_eq!(deleted.0, 1);
    assert!(!delete_message_as_group_admin(&pool, mid, "alice@local", 6).await.unwrap(), "повторно — нет");
    // 1-на-1 сообщение этим путём не удаляется
    let pm = "00000000-0000-7000-8000-00000000aa03";
    store_message(&pool, &send_event(pm, "carol@local", "alice@local", "личное"), 1).await.unwrap();
    assert!(!delete_message_as_group_admin(&pool, pm, "alice@local", 7).await.unwrap());
}

#[tokio::test]
async fn legacy_setrole_admin_gets_full_rights_and_ban_drops_request() {
    let pool = test_pool().await;
    let gid = group_with_admin(&pool).await;
    assert!(set_group_role(&pool, &gid, "alice@local", "carol@local", "admin").await.unwrap());
    let info = group_info(&pool, &gid, Some("alice@local")).await.unwrap().unwrap();
    let carol = info.members.iter().find(|m| m.address == "carol@local").unwrap();
    assert_eq!(carol.admin_rights, Some(parvane_types::AdminRights::full()));
    // заявка снимается баном
    sqlx::query("INSERT INTO group_join_requests (group_id, member, invite_token, created_at, status) VALUES (?, 'zed@local', 't', 1, 'pending')")
        .bind(&gid).execute(&pool).await.unwrap();
    assert!(ban_group_member(&pool, &gid, "alice@local", "zed@local", true).await.unwrap());
    assert!(group_mgmt::list_requests(&pool, &gid).await.unwrap().is_empty());
}

#[test]
fn group_action_rate_limiter_caps_per_actor() {
    assert!(group_action_rate_ok("rate-test", "x@local", 2));
    assert!(group_action_rate_ok("rate-test", "x@local", 2));
    assert!(!group_action_rate_ok("rate-test", "x@local", 2), "третье действие за минуту");
    assert!(group_action_rate_ok("rate-test", "y@local", 2), "другой актор не затронут");
}
