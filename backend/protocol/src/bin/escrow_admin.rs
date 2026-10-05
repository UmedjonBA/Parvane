//! Ключ администратора для копий корня (страховка: пользователь потерял и все
//! устройства, и ключ восстановления). Закрытый ключ живёт ТОЛЬКО у
//! администратора, вне сервера; серверу отдаётся открытый
//! (`PARVANE_ESCROW_PUBLIC_KEY`).
//!
//!   escrow_admin keygen <файл>                — новая пара; закрытый ключ в файл (0600), открытый на stdout
//!   escrow_admin pubkey <файл>                — открытый ключ по файлу
//!   escrow_admin recover <файл> <адрес> <hex> — по копии из таблицы `root_escrow` (hex) выписать
//!                                               новый ключ восстановления и новую `root_backup`
//!
//! `recover` печатает две строки: `recovery_key=…` (передать пользователю) и
//! `backup=<hex>` (записать в `root_backup` шарда identity). Обёртка для
//! сервера — `scripts/admin_recover_user.sh`.

use std::process::ExitCode;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use parvane_protocol::recovery;
use zeroize::Zeroizing;

fn read_secret(path: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let text = Zeroizing::new(std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?);
    let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(text.trim()).map_err(|e| format!("{path}: не base64url ({e})"))?);
    let mut key = Zeroizing::new([0u8; 32]);
    if bytes.len() != 32 {
        return Err(format!("{path}: нужен ключ в 32 байта"));
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn keygen(path: &str) -> Result<(), String> {
    use std::io::Write as _;
    let (secret, public) = recovery::generate_escrow_keypair();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    // create_new: существующий ключ не затирается — без него прежние копии не открыть
    let mut file = options.open(path).map_err(|e| format!("{path}: {e}"))?;
    let text = Zeroizing::new(URL_SAFE_NO_PAD.encode(secret.as_ref()));
    writeln!(file, "{}", text.as_str()).map_err(|e| format!("{path}: {e}"))?;
    println!("{}", URL_SAFE_NO_PAD.encode(public));
    Ok(())
}

fn pubkey(path: &str) -> Result<(), String> {
    let secret = read_secret(path)?;
    let public = recovery::escrow_public_key(&secret).map_err(|e| e.to_string())?;
    println!("{}", URL_SAFE_NO_PAD.encode(public));
    Ok(())
}

fn recover(path: &str, user: &str, escrow_hex: &str) -> Result<(), String> {
    let secret = read_secret(path)?;
    let escrow = hex::decode(escrow_hex.trim()).map_err(|e| format!("копия: не hex ({e})"))?;
    let root = recovery::open_root_escrow(&escrow, user, &secret)
        .map_err(|e| format!("копия не открылась (чужой ключ администратора, другой адрес или порча): {e}"))?;
    let key = recovery::RecoveryKey::generate();
    let backup = recovery::export_root_backup(&root, user, &key).map_err(|e| e.to_string())?;
    println!("recovery_key={}", key.to_display().as_str());
    println!("backup={}", hex::encode(backup));
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = match args.as_slice() {
        ["keygen", path] => keygen(path),
        ["pubkey", path] => pubkey(path),
        ["recover", path, user, escrow] => recover(path, user, escrow),
        _ => Err("использование: escrow_admin keygen <файл> | pubkey <файл> | recover <файл> <адрес> <hex копии>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("escrow_admin: {e}");
            ExitCode::FAILURE
        }
    }
}
