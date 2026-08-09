use std::collections::BTreeSet;

use parvane_types::{topic_contract::*, topics::*};

const DEV_NATS: &str = include_str!("../../../infra/nats/server.conf");
const PROD_NATS: &str = include_str!("../../../infra/nats/server.prod.conf");
const GATEWAY_SOURCE: &str = include_str!("../../../shards/gateway/src/main.rs");

struct RoleContract {
    name: &'static str,
    subscribe: &'static [&'static str],
    publish: &'static [&'static str],
}

struct ShardContract {
    name: &'static str,
    source: &'static str,
    bindings: &'static [(&'static str, &'static str)],
    nats_subscribe: &'static [&'static str],
}

const IDENTITY_BINDINGS: &[(&str, &str)] = &[
    ("IDENTITY_ISSUE", IDENTITY_ISSUE),
    ("IDENTITY_REGISTER", IDENTITY_REGISTER),
    ("IDENTITY_VERIFY", IDENTITY_VERIFY),
    ("IDENTITY_SEARCH", IDENTITY_SEARCH),
    ("IDENTITY_SETNAME", IDENTITY_SETNAME),
    ("IDENTITY_SETAVATAR", IDENTITY_SETAVATAR),
    ("IDENTITY_SETKEY", IDENTITY_SETKEY),
    ("IDENTITY_RESOLVE", IDENTITY_RESOLVE),
    ("IDENTITY_PREKEYS_PUBLISH", IDENTITY_PREKEYS_PUBLISH),
    ("IDENTITY_PREKEYS_FETCH", IDENTITY_PREKEYS_FETCH),
];

const MESSENGER_BINDINGS: &[(&str, &str)] = &[
    ("MSG_SEND", MSG_SEND),
    ("MSG_ACK", MSG_ACK),
    ("MSG_READ", MSG_READ),
    ("MSG_EDIT", MSG_EDIT),
    ("MSG_DELETE", MSG_DELETE),
    ("MSG_REACT", MSG_REACT),
    ("MSG_PIN", MSG_PIN),
    ("GROUP_CREATE", GROUP_CREATE),
    ("GROUP_ADD_MEMBER", GROUP_ADD_MEMBER),
    ("GROUP_REMOVE_MEMBER", GROUP_REMOVE_MEMBER),
    ("GROUP_SET_ROLE", GROUP_SET_ROLE),
    ("GROUP_BAN", GROUP_BAN),
    ("GROUP_UNBAN", GROUP_UNBAN),
    ("GROUP_MUTE", GROUP_MUTE),
    ("GROUP_RENAME", GROUP_RENAME),
    ("GROUP_DELETE", GROUP_DELETE),
    ("GROUP_INVITE_CREATE", GROUP_INVITE_CREATE),
    ("GROUP_JOIN", GROUP_JOIN),
    ("GROUP_LIST", GROUP_LIST),
    ("GROUP_INFO", GROUP_INFO),
    ("MSG_SYNC_REQUEST", MSG_SYNC_REQUEST),
];

const CLOUD_BINDINGS: &[(&str, &str)] = &[
    ("FILE_UPLOAD_CHUNK", FILE_UPLOAD_CHUNK),
    ("FILE_UPLOAD_COMPLETE", FILE_UPLOAD_COMPLETE),
    ("FILE_DOWNLOAD_REQUEST", FILE_DOWNLOAD_REQUEST),
    ("FILE_LIST_REQUEST", FILE_LIST_REQUEST),
];

const CALL_BINDINGS: &[(&str, &str)] = &[
    ("CALL_SIGNAL", CALL_SIGNAL),
    ("CALL_HISTORY_REQUEST", CALL_HISTORY_REQUEST),
    ("CALL_ICE_REQUEST", CALL_ICE_REQUEST),
];

const NOTES_BINDINGS: &[(&str, &str)] = &[
    ("NOTE_CREATE", NOTE_CREATE),
    ("NOTE_UPDATE", NOTE_UPDATE),
    ("NOTE_DELETE", NOTE_DELETE),
    ("NOTE_SYNC_REQUEST", NOTE_SYNC_REQUEST),
];

const CALENDAR_BINDINGS: &[(&str, &str)] = &[
    ("CAL_CREATE", CAL_CREATE),
    ("CAL_UPDATE", CAL_UPDATE),
    ("CAL_DELETE", CAL_DELETE),
    ("CAL_SYNC_REQUEST", CAL_SYNC_REQUEST),
];

const PREVIEW_BINDINGS: &[(&str, &str)] = &[("PREVIEW_FETCH", PREVIEW_FETCH)];

const PUSH_BINDINGS: &[(&str, &str)] = &[
    ("PUSH_VAPID_GET", PUSH_VAPID_GET),
    ("PUSH_REGISTER", PUSH_REGISTER),
    ("PUSH_UNREGISTER", PUSH_UNREGISTER),
    ("MSG_USER_WILDCARD", MSG_USER_WILDCARD),
];

fn role_contracts() -> [RoleContract; 9] {
    [
        RoleContract {
            name: "identity",
            subscribe: IDENTITY_NATS_SUBSCRIBE,
            publish: IDENTITY_NATS_PUBLISH,
        },
        RoleContract {
            name: "messenger",
            subscribe: MESSENGER_NATS_SUBSCRIBE,
            publish: MESSENGER_NATS_PUBLISH,
        },
        RoleContract {
            name: "cloud",
            subscribe: CLOUD_NATS_SUBSCRIBE,
            publish: CLOUD_NATS_PUBLISH,
        },
        RoleContract {
            name: "notes",
            subscribe: NOTES_NATS_SUBSCRIBE,
            publish: NOTES_NATS_PUBLISH,
        },
        RoleContract {
            name: "calendar",
            subscribe: CALENDAR_NATS_SUBSCRIBE,
            publish: CALENDAR_NATS_PUBLISH,
        },
        RoleContract {
            name: "call",
            subscribe: CALL_NATS_SUBSCRIBE,
            publish: CALL_NATS_PUBLISH,
        },
        RoleContract {
            name: "preview",
            subscribe: PREVIEW_NATS_SUBSCRIBE,
            publish: PREVIEW_NATS_PUBLISH,
        },
        RoleContract {
            name: "push",
            subscribe: PUSH_NATS_SUBSCRIBE,
            publish: PUSH_NATS_PUBLISH,
        },
        RoleContract {
            name: "gateway",
            subscribe: GATEWAY_NATS_SUBSCRIBE,
            publish: GATEWAY_NATS_PUBLISH,
        },
    ]
}

fn shard_contracts() -> [ShardContract; 8] {
    [
        ShardContract {
            name: "identity",
            source: include_str!("../../../shards/identity/src/main.rs"),
            bindings: IDENTITY_BINDINGS,
            nats_subscribe: IDENTITY_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "messenger",
            source: include_str!("../../../shards/messenger/src/main.rs"),
            bindings: MESSENGER_BINDINGS,
            nats_subscribe: MESSENGER_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "cloud",
            source: include_str!("../../../shards/cloud/src/main.rs"),
            bindings: CLOUD_BINDINGS,
            nats_subscribe: CLOUD_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "notes",
            source: include_str!("../../../shards/notes/src/main.rs"),
            bindings: NOTES_BINDINGS,
            nats_subscribe: NOTES_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "calendar",
            source: include_str!("../../../shards/calendar/src/main.rs"),
            bindings: CALENDAR_BINDINGS,
            nats_subscribe: CALENDAR_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "call",
            source: include_str!("../../../shards/call/src/main.rs"),
            bindings: CALL_BINDINGS,
            nats_subscribe: CALL_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "preview",
            source: include_str!("../../../shards/preview/src/main.rs"),
            bindings: PREVIEW_BINDINGS,
            nats_subscribe: PREVIEW_NATS_SUBSCRIBE,
        },
        ShardContract {
            name: "push",
            source: include_str!("../../../shards/push/src/main.rs"),
            bindings: PUSH_BINDINGS,
            nats_subscribe: PUSH_NATS_SUBSCRIBE,
        },
    ]
}

fn user_block<'a>(config: &'a str, user: &str) -> Option<&'a str> {
    let marker = format!("user: {user}\n");
    let user_pos = config.find(&marker)?;
    let start = config[..user_pos].rfind('{')?;
    let mut depth = 0_u32;
    for (offset, byte) in config.as_bytes()[start..].iter().enumerate() {
        match byte {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&config[start..=start + offset]);
                }
            }
            _ => {}
        }
    }
    None
}

fn permission_set(block: &str, permission: &str) -> BTreeSet<String> {
    let marker = format!("{permission}:");
    let tail = &block[block
        .find(&marker)
        .unwrap_or_else(|| panic!("permission {permission} отсутствует в блоке:\n{block}"))
        + marker.len()..];
    let array = &tail[tail.find('[').expect("начало массива ACL") + 1..];
    let array = &array[..array.find(']').expect("конец массива ACL")];

    let mut values = BTreeSet::new();
    let mut rest = array;
    while let Some(start) = rest.find('"') {
        rest = &rest[start + 1..];
        let end = rest.find('"').expect("закрывающая кавычка subject");
        values.insert(rest[..end].to_string());
        rest = &rest[end + 1..];
    }
    values
}

fn string_set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn assert_acl(config_name: &str, config: &str, role: &RoleContract) {
    let block = user_block(config, role.name)
        .unwrap_or_else(|| panic!("{config_name}: отсутствует NATS-роль {}", role.name));
    assert_eq!(
        permission_set(block, "subscribe"),
        string_set(role.subscribe),
        "{config_name}: subscribe ACL роли {} расходится с контрактом",
        role.name
    );
    assert_eq!(
        permission_set(block, "publish"),
        string_set(role.publish),
        "{config_name}: publish ACL роли {} расходится с контрактом",
        role.name
    );
}

fn subscription_arguments(source: &str) -> BTreeSet<String> {
    let mut arguments = BTreeSet::new();
    let mut rest = source;
    while let Some(position) = rest.find(".subscribe(") {
        rest = &rest[position + ".subscribe(".len()..];
        let end = rest.find(')').expect("закрывающая скобка subscribe");
        let argument: String = rest[..end].chars().filter(|c| !c.is_whitespace()).collect();
        arguments.insert(argument);
        rest = &rest[end + 1..];
    }
    arguments
}

fn acl_covers(permissions: &[&str], subject: &str) -> bool {
    permissions.iter().any(|permission| {
        let mut permission_tokens = permission.split('.');
        let mut subject_tokens = subject.split('.');
        loop {
            match (permission_tokens.next(), subject_tokens.next()) {
                (Some(">"), _) => return true,
                (Some("*"), Some(_)) => {}
                (Some(expected), Some(actual)) if expected == actual => {}
                (None, None) => return true,
                _ => return false,
            }
        }
    })
}

#[test]
fn shard_subscriptions_match_the_contract() {
    for shard in shard_contracts() {
        let actual = subscription_arguments(shard.source);
        let expected_names: BTreeSet<String> = shard
            .bindings
            .iter()
            .map(|(name, _)| (*name).to_string())
            .collect();
        assert_eq!(
            actual, expected_names,
            "{}: фактические nc.subscribe(...) расходятся с контрактом",
            shard.name
        );

        let handled_subjects: BTreeSet<String> = shard
            .bindings
            .iter()
            .map(|(_, subject)| (*subject).to_string())
            .collect();
        let acl_subjects: BTreeSet<String> = shard
            .nats_subscribe
            .iter()
            .filter(|subject| **subject != REQUEST_INBOX)
            .map(|subject| (*subject).to_string())
            .collect();
        assert_eq!(
            handled_subjects, acl_subjects,
            "{}: список подписок роли содержит пропуск или лишний subject",
            shard.name
        );
    }
}

#[test]
fn dev_and_production_acl_match_the_contract() {
    for role in role_contracts() {
        assert_acl("server.conf", DEV_NATS, &role);
        assert_acl("server.prod.conf", PROD_NATS, &role);
    }

    // Прямой client существует только в dev и должен иметь тот же bus-периметр,
    // что gateway. Изоляция пользователей всё равно выполняется gateway.
    let client = RoleContract {
        name: "client",
        subscribe: GATEWAY_NATS_SUBSCRIBE,
        publish: GATEWAY_NATS_PUBLISH,
    };
    assert_acl("server.conf", DEV_NATS, &client);
    assert!(user_block(PROD_NATS, "client").is_none());
    assert!(user_block(PROD_NATS, "dev").is_none());
}

#[test]
fn gateway_runtime_allowlist_is_covered_by_its_nats_acl() {
    for subject in GATEWAY_ALLOWED_PUBLISH
        .iter()
        .chain(GATEWAY_ALLOWED_REQUEST.iter())
    {
        assert!(
            acl_covers(GATEWAY_NATS_PUBLISH, subject),
            "gateway разрешает {subject}, но NATS publish ACL его блокирует"
        );
    }
    for subject in ["msg.typing.42", "presence.42"] {
        assert!(acl_covers(GATEWAY_NATS_PUBLISH, subject));
    }
    for subject in [
        "msg.user.alice@local",
        "call.user.alice@local",
        "msg.typing.42",
        "presence.*",
        "_INBOX.random",
    ] {
        assert!(
            acl_covers(GATEWAY_NATS_SUBSCRIBE, subject),
            "gateway подписывается на {subject}, но NATS subscribe ACL его блокирует"
        );
    }

    for subject in GATEWAY_EVENT_SUBJECTS {
        assert!(
            GATEWAY_ALLOWED_PUBLISH.contains(subject) || GATEWAY_ALLOWED_REQUEST.contains(subject),
            "actor-binding содержит недоступный клиенту subject {subject}"
        );
    }
    for subject in GATEWAY_TOKEN_REQUEST_SUBJECTS {
        assert!(GATEWAY_ALLOWED_REQUEST.contains(subject));
    }

    // Gateway должен использовать центральные списки, а не локальные копии.
    for name in [
        "GATEWAY_ALLOWED_PUBLISH",
        "GATEWAY_ALLOWED_REQUEST",
        "GATEWAY_EVENT_SUBJECTS",
        "GATEWAY_TOKEN_REQUEST_SUBJECTS",
    ] {
        assert!(
            GATEWAY_SOURCE.contains(name),
            "gateway не использует {name}"
        );
    }
}
