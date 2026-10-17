// Смена ника (spec 026): включается в `client.rs` через `include!` — та же область видимости.
//
// Личность — корневой ключ; адрес — её имя. Смена ника: запись `Rename` (подпись корня) закрывает журнал
// прежнего адреса и указывает на генезис журнала нового (тот же корень, `renamed_from`). Своё прежнее имя
// клиент помнит (`former_own`): конверты, запечатанные на него, открываются; свои подписи под ним — свои.
// Собеседник, увидев `Rename`, переносит всё о человеке на новый адрес без предупреждения о смене ключа.

/// Подготовленная смена ника: запись в свой журнал и журнал нового адреса (`identity.account.rename`).
pub struct RenamePlan {
    pub new_address: String,
    pub rename: SignedOp,
    pub new_log: Vec<SignedOp>,
}

/// Что известно о смене ника собеседником (после проверки обоих журналов).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRename {
    pub old: String,
    pub new: String,
}

impl Client {
    /// Свои прежние адреса (spec 026), от раннего к позднему.
    pub fn former_addresses(&self) -> Vec<String> {
        self.former_own.iter().map(|(_, log)| log.user.clone()).collect()
    }

    /// Прочие адреса личности `user` (смена ника): для своей — прежние и текущий, для собеседника — цепочка
    /// проверенных журналов (`Rename` в старом ведёт на генезис нового с тем же корнем).
    pub fn aliases_of(&self, user: &str) -> Vec<String> {
        if self.is_own_address(user) {
            return std::iter::once(self.user.clone()).chain(self.former_addresses()).filter(|a| a != user).collect();
        }
        let linked = |old: &str, new: &str| {
            let (Some(o), Some(n)) = (self.peer_log(old), self.peer_log(new)) else { return false };
            o.renamed_to.as_deref() == Some(new) && n.renamed_from.as_deref() == Some(old) && o.root_key == n.root_key
        };
        let mut out = vec![];
        let mut cur = user.to_string();
        while let Some(next) = self.peer_log(&cur).and_then(|l| l.renamed_to.clone()) {
            if next == user || out.contains(&next) || !linked(&cur, &next) {
                break;
            }
            out.push(next.clone());
            cur = next;
        }
        let mut cur = user.to_string();
        while let Some(prev) = self.peer_log(&cur).and_then(|l| l.renamed_from.clone()) {
            if prev == user || out.contains(&prev) || !linked(&prev, &cur) {
                break;
            }
            out.push(prev.clone());
            cur = prev;
        }
        out
    }

    /// Нынешний адрес собеседника: прежний ник с проверенным переносом (оба журнала известны и связаны) ведёт на
    /// новый — отправка, начатая до того, как хост узнал о смене ника, уходит по новому адресу.
    pub fn current_address(&self, user: &str) -> String {
        let mut cur = user.to_string();
        for _ in 0..16 {
            let Some(next) = self.peer_log(&cur).and_then(|l| l.renamed_to.clone()) else { break };
            let linked = self.peer_log(&next).is_some_and(|n| {
                n.renamed_from.as_deref() == Some(cur.as_str()) && self.peer_log(&cur).is_some_and(|o| o.root_key == n.root_key)
            });
            if !linked || next == user {
                break;
            }
            cur = next;
        }
        cur
    }

    /// `user` и его прочие адреса.
    pub fn identity_names(&self, user: &str) -> Vec<String> {
        std::iter::once(user.to_string()).chain(self.aliases_of(user)).collect()
    }

    /// Под каким своим адресом я значусь в доступе контейнера (владелец либо получатель гранта); иначе — текущий.
    fn my_name_in(&self, access: &crate::domain::ContainerAccess) -> String {
        self.identity_names(&self.user)
            .into_iter()
            .find(|u| access.owner == *u || access.grants.contains_key(&crate::domain::Grantee::User(u.clone())))
            .unwrap_or_else(|| self.user.clone())
    }

    /// Свой адрес — текущий либо прежний.
    pub fn is_own_address(&self, address: &str) -> bool {
        address == self.user || self.former_own.iter().any(|(_, log)| log.user == address)
    }

    /// Подготовить смену ника: нужен корень (хост берёт его из копии под ключом восстановления и сразу
    /// стирает) и SSK на этом устройстве (его же получат прочие свои устройства). Состояние не меняется до
    /// `rename_apply` — после ответа сервера.
    pub fn rename_prepare(&mut self, root_secret: &[u8; 32], new_address: &str) -> Result<RenamePlan> {
        if !crate::address::is_valid_address(new_address)
            || new_address == self.user
            || crate::address::address_domain(new_address) != crate::address::address_domain(&self.user)
        {
            return Err(ProtoError::BadAddress);
        }
        let root = SigningKey::from_bytes(root_secret);
        let root_pub = root.verifying_key().to_bytes();
        if root_pub != self.own_log.root_key || self.own_log.renamed_to.is_some() {
            return Err(ProtoError::RootMismatch);
        }
        let ssk = self.ssk.clone().ok_or(ProtoError::Forbidden)?;
        let ssk_pub = ssk.verifying_key().to_bytes();
        // Генезис нового журнала: тот же корень, тот же SSK (его держат и прочие свои устройства)
        let root_sig = identity::sign_self_signing(&root, new_address, &ssk_pub)?;
        let mut genesis = identity::device_log_entry(
            new_address,
            1,
            [0u8; 32],
            DevChange::RotateSelfSigningKey(crate::pb::parvane::core::v2::RotateSelfSigning {
                self_signing_key: ssk_pub.to_vec(),
                root_signature: root_sig.clone(),
            }),
            Some(root_pub),
        );
        genesis.renamed_from = self.user.clone();
        let genesis_op = identity::sign_device_log_entry(&root, &genesis)?;
        let genesis_hash = identity::device_log_hash(&genesis_op);
        // Сертификат этого устройства под новым адресом (доказательство владения ключами — заново)
        let mut cert = self.my_certificate_body();
        cert.user = Some(UserRef { address: new_address.to_string() });
        identity::prove_possession(&self.acc, &mut cert, &root_pub)?;
        let signed = identity::sign_certificate(&ssk, &root_pub, root_sig, &cert);
        let add = identity::device_log_entry(new_address, 2, genesis_hash, DevChange::AddDevice(signed), None);
        let add_op = identity::sign_device_log_entry(&ssk, &add)?;
        // Запись `Rename` в свой журнал
        let rename = identity::device_log_entry(
            &self.user,
            self.own_log.version + 1,
            self.own_log.head_hash,
            DevChange::Rename(crate::pb::parvane::core::v2::Rename {
                new_address: new_address.to_string(),
                new_genesis_hash: genesis_hash.to_vec(),
            }),
            None,
        );
        let rename_op = identity::sign_device_log_entry(&root, &rename)?;
        // Проверка тем же кодом, что у собеседников и сервера
        let mut old = self.own_log.clone();
        old.apply(&rename_op)?;
        let mut new = DeviceLog::new(new_address)?;
        new.apply(&genesis_op)?;
        new.apply(&add_op)?;
        Ok(RenamePlan { new_address: new_address.to_string(), rename: rename_op, new_log: vec![genesis_op, add_op] })
    }

    /// Сервер принял смену ника: устройство живёт под новым адресом, прежний — в `former_own`. Записи
    /// `RenameMember` групп — `rename_groups_pending` уже сессией нового адреса (запись группы применяется
    /// локально при построении: построенная и не отправленная разошлась бы с сервером).
    pub fn rename_apply(&mut self, plan: &RenamePlan) -> Result<()> {
        let mut old_log = self.own_log.clone();
        old_log.apply(&plan.rename)?;
        let mut new_log = DeviceLog::new(&plan.new_address)?;
        for op in &plan.new_log {
            new_log.apply(op)?;
        }
        let new_cert = new_log.active(&self.device_id).map(|d| d.cert.clone()).ok_or(ProtoError::BadCertificate)?;
        let signed_cert = plan
            .new_log
            .iter()
            .filter_map(|op| {
                let body = crate::pb::parvane::core::v2::OpBody::decode(op.body.as_slice()).ok()?;
                let e = crate::pb::parvane::core::v2::UserDeviceLogEntry::decode(body.payload.as_slice()).ok()?;
                match e.change {
                    Some(DevChange::AddDevice(c)) => Some(c),
                    _ => None,
                }
            })
            .find(|c| identity::verify_certificate(c, Some(&plan.new_address)).is_ok_and(|v| v.cert == new_cert))
            .ok_or(ProtoError::BadCertificate)?;
        let old = self.user.clone();
        let mut old_entries = std::mem::take(&mut self.own_entries);
        old_entries.push(plan.rename.clone());
        self.former_own.push((old_entries, old_log));
        self.user = plan.new_address.clone();
        self.own_log = new_log;
        self.own_entries = plan.new_log.clone();
        self.my_cert = Some(signed_cert);
        // Сессии Megolm несут сертификат прежнего адреса — новые раздаются уже под новым
        self.megolm_out.clear();
        self.megolm_shared.clear();
        self.move_peer_keys(&old, &plan.new_address);
        Ok(())
    }

    /// Своё другое устройство сменило ник (журнал своего адреса закрыт `Rename`): войти в журнал нового адреса
    /// своим сертификатом (SSK у этого устройства есть) и перейти на новый адрес. `new_log` — записи журнала
    /// нового адреса с сервера. Запросы — только сертификат под новым адресом (если его ещё нет).
    pub fn rename_follow(&mut self, new_log_entries: Vec<SignedOp>) -> Result<Vec<OutRequest>> {
        let new_address = self.own_log.renamed_to.clone().ok_or(ProtoError::NotFound)?;
        let expected = self.own_log.rename_genesis.ok_or(ProtoError::NotFound)?;
        if new_log_entries.first().map(identity::device_log_hash) != Some(expected) {
            return Err(ProtoError::BrokenChain);
        }
        let mut new_log = DeviceLog::new(&new_address)?;
        for op in &new_log_entries {
            new_log.apply(op)?;
        }
        if new_log.root_key != self.own_log.root_key || new_log.renamed_from.as_deref() != Some(self.user.as_str()) {
            return Err(ProtoError::RootMismatch);
        }
        let old = self.user.clone();
        let old_log = self.own_log.clone();
        let old_entries = std::mem::take(&mut self.own_entries);
        self.former_own.push((old_entries, old_log));
        self.user = new_address.clone();
        self.own_log = new_log;
        self.own_entries = new_log_entries;
        // Журнал нового адреса мог быть прочитан как чужой (запись группы под новым адресом пришла раньше)
        self.peers.remove(&new_address);
        self.megolm_out.clear();
        self.megolm_shared.clear();
        self.move_peer_keys(&old, &new_address);
        // Себя — в новый журнал (если ещё не там): сертификат под новым адресом подписью SSK
        let mut out = vec![];
        if self.own_log.active(&self.device_id).is_none() {
            out.extend(self.certify_self_requests(0, None)?.into_iter().filter(|r| r.method == "identity.device.publish_certificate"));
        } else {
            self.refresh_own_after_log();
        }
        // `RenameMember` в группы шлёт сменившее ник устройство; запасной путь — `rename_groups_pending` после
        // догона журналов групп (здесь журналы групп могут быть устаревшими — запись не прошла бы)
        let _ = old;
        Ok(out)
    }

    /// Группы, где участником всё ещё значится свой прежний адрес, — `RenameMember` (хост зовёт после догона
    /// журналов групп: сменившее ник устройство могло не успеть).
    pub fn rename_groups_pending(&mut self) -> Result<Vec<OutRequest>> {
        let mut out = vec![];
        for old in self.former_addresses() {
            out.extend(self.rename_member_requests(&old)?);
        }
        Ok(out)
    }

    /// Свой журнал закрыт сменой ника на другом своём устройстве — новый адрес (хост дочитывает его журнал и
    /// зовёт `rename_follow`).
    pub fn own_renamed_to(&self) -> Option<String> {
        self.own_log.renamed_to.clone()
    }

    /// Собеседник сменил ник: адрес журнала закрыт `Rename` — куда он ведёт.
    pub fn peer_renamed_to(&self, user: &str) -> Option<String> {
        self.peer_log(user).and_then(|l| l.renamed_to.clone())
    }

    /// Журнал `new` — продолжение `old` (тот же корень, `Rename` в старом указывает на генезис нового):
    /// перенести всё о собеседнике на новый адрес. `None` — журналы не связаны (смены ника нет).
    fn link_peer_rename(&mut self, new: &str) -> Option<PeerRename> {
        let new_log = self.peers.get(new)?.log.as_ref()?;
        let old = new_log.renamed_from.clone()?;
        let genesis = identity::device_log_hash(self.peers.get(new)?.entries.first()?);
        let old_log = self.peers.get(&old)?.log.as_ref()?;
        if old_log.renamed_to.as_deref() != Some(new) || old_log.rename_genesis != Some(genesis) || old_log.root_key != new_log.root_key {
            return None;
        }
        self.move_peer_keys(&old, new);
        let p = self.peers.get_mut(new)?;
        if std::mem::replace(&mut p.rename_linked, true) {
            return None;
        }
        Some(PeerRename { old, new: new.to_string() })
    }

    /// Сессии, ключ доступа, «липкость», режим L2, учёт раздачи ключей — со старого адреса на новый.
    fn move_peer_keys(&mut self, old: &str, new: &str) {
        let moved: Vec<(String, String)> = self.sessions.keys().filter(|(u, _)| u == old).cloned().collect();
        for key in moved {
            if let Some(s) = self.sessions.remove(&key) {
                self.sessions.entry((new.to_string(), key.1.clone())).or_insert(s);
            }
        }
        let moved: Vec<(String, String)> = self.old_sessions.keys().filter(|(u, _)| u == old).cloned().collect();
        for key in moved {
            if let Some(list) = self.old_sessions.remove(&key) {
                self.old_sessions.entry((new.to_string(), key.1.clone())).or_default().extend(list);
            }
        }
        let dk = self.peers.get(old).and_then(|p| p.delivery_key.clone());
        if let Some(p) = self.peers.get_mut(new) {
            if p.delivery_key.is_none() {
                p.delivery_key = dk;
            }
        }
        if let Some(root) = self.trust.get(old).copied() {
            self.trust.accept(new, &root);
        }
        if self.sticky.users().any(|u| u == old) {
            self.sticky.mark(new);
        }
        if let Some(l2) = self.l2_direct.remove(old) {
            self.l2_direct.entry(new.to_string()).or_insert(l2);
        }
        if self.dk.shared().contains_key(old) && !self.dk.needs_share(old) {
            self.dk.mark_shared(new);
        }
        let shared: Vec<(Vec<u8>, u64, String)> = self.megolm_shared.iter().filter(|(_, _, u)| u == old).cloned().collect();
        for (g, e, _) in shared {
            self.megolm_shared.insert((g, e, new.to_string()));
        }
    }

    /// `RenameMember` во все группы, где прежний адрес — участник.
    fn rename_member_requests(&mut self, old: &str) -> Result<Vec<OutRequest>> {
        let proof = self
            .former_own
            .iter()
            .find(|(_, log)| log.user == old)
            .and_then(|(_, log)| log.rename_op.clone())
            .ok_or(ProtoError::NotFound)?;
        let groups: Vec<Vec<u8>> = self
            .groups
            .iter()
            .filter(|(_, g)| g.state.as_ref().is_some_and(|s| s.members.contains_key(old)))
            .map(|(id, _)| id.clone())
            .collect();
        let mut out = vec![];
        for id in groups {
            let change = Change::RenameMember(gpb::RenameMember { rename: Some(proof.clone()) });
            out.push(self.group_change(&id, change)?);
        }
        Ok(out)
    }
}
