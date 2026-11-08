//! spec 035 T071 (OPT-015): `create_identity`/`reset_identity` хост-API без круга serialize→parse; корень —
//! только в `Zeroizing` (тип результата не содержит `String` с корнем; строка границы — `Zeroizing<String>`).

use base64::Engine as _;
use parvane_protocol::host::{HostClient, IdentityCreated};
use zeroize::Zeroizing;

fn root_is_zeroizing(_: &Zeroizing<[u8; 32]>) {}
fn boundary_is_zeroizing(_: &Zeroizing<String>) {}

#[test]
fn create_identity_root_only_in_zeroizing() {
    let mut h = HostClient::new("alice@local", "d1", "local").unwrap();
    let r: IdentityCreated = h.create_identity_typed(3).unwrap();
    root_is_zeroizing(&r.root_secret);
    assert!(!r.requests.is_empty());
    assert_ne!(*r.root_secret, [0u8; 32]);
    // Строка границы собирается без разбора и несёт тот же корень и те же запросы
    let s = r.to_json();
    boundary_is_zeroizing(&s);
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    let secret = base64::engine::general_purpose::STANDARD.decode(v["rootSecret"].as_str().unwrap()).unwrap();
    assert_eq!(secret.as_slice(), r.root_secret.as_slice());
    assert_eq!(v["requests"].as_array().unwrap().len(), r.requests.len());
    assert_eq!(v["requests"][0]["method"].as_str().unwrap(), r.requests[0].method);
}

#[test]
fn reset_identity_boundary_is_zeroizing() {
    let mut h = HostClient::new("bob@local", "d1", "local").unwrap();
    let first = h.create_identity(2).unwrap();
    boundary_is_zeroizing(&first);
    let again: Zeroizing<String> = h.reset_identity(2).unwrap();
    let v: serde_json::Value = serde_json::from_str(&again).unwrap();
    assert_eq!(v["requests"][0]["method"], serde_json::json!("identity.root.rotate"));
    let a: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_ne!(a["rootSecret"], v["rootSecret"], "новый корень");
}
