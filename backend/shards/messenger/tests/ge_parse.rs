use parvane_types::{MessageContent, SendPayload};
#[test]
fn group_encrypted_parses() {
    let j = r#"{"to":"g@local","content":{"kind":"group_encrypted","ciphertext":"AAAA","group":"g@local","sender_identity":"IDID"}}"#;
    let p: SendPayload = serde_json::from_str(j).expect("parse SendPayload");
    match p.content {
        MessageContent::GroupEncrypted { group, .. } => assert_eq!(group, "g@local"),
        other => panic!("wrong variant: {:?}", other),
    }
}
