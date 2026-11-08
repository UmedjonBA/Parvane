//! spec 035 T014 (FR-046): `<шард> --engine-info` печатает `engineInfo()` движка, с которым собран шард,
//! и выходит ДО подключения к NATS (адрес NATS — заведомо недоступный порт: шард, который пытается
//! подключиться, не выйдет за отведённое время). Совпадает с `parvane_protocol::engine_info_json()` той же
//! сборки, кроме `target`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

fn target_dir() -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => PathBuf::from(dir).join("debug"),
        None => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug"),
    }
}

#[test]
fn shards_print_engine_info_without_nats() {
    let shards = ["messenger", "identity", "gateway", "federation", "domains", "cloud", "call", "push", "preview"];
    let mut args = vec!["build"];
    for s in shards {
        args.extend(["-p", s]);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert!(Command::new(env!("CARGO")).args(&args).current_dir(&root).status().unwrap().success());
    let want: Value = serde_json::from_str(&parvane_protocol::engine_info_json()).unwrap();
    for s in shards {
        let t0 = Instant::now();
        let mut child = Command::new(target_dir().join(s))
            .arg("--engine-info")
            .env("PARVANE_NATS_URL", "nats://127.0.0.1:1")
            .env("PARVANE_LOG_LEVEL", "error")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("{s}: {e}"));
        let status = loop {
            if let Some(st) = child.try_wait().unwrap() {
                break st;
            }
            if t0.elapsed() > Duration::from_secs(10) {
                let _ = child.kill();
                let out = child.wait_with_output().unwrap();
                panic!("{s}: --engine-info не вышел за 10 с (ждёт NATS?): {}", String::from_utf8_lossy(&out.stderr));
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let out = child.wait_with_output().unwrap();
        assert!(status.success(), "{s}: код {:?}: {}", status.code(), String::from_utf8_lossy(&out.stderr));
        let got: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{s}: не JSON ({e}): {}", String::from_utf8_lossy(&out.stdout)));
        assert_eq!(got, want, "{s}: engineInfo шарда ≠ движка этой сборки");
    }
}
