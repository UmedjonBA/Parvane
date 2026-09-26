#!/usr/bin/env python3
"""Контрактный e2e управления группами (spec 003): фото/описание, права по
умолчанию, права админов, инвайт-ссылки (список/отзыв/срок/лимит/проверка),
заявки на вступление, ревизия `version`. Нужны живые nats + identity +
messenger (nats CLI в ~/.local/bin, как в e2e_smoke.py)."""
import json, subprocess, sys, time, uuid

NATS = "/home/ub/.local/bin/nats"
SUF = uuid.uuid4().hex[:6]  # уникальные ники на прогон — стек может быть общим


def req(topic, payload, timeout="3s"):
    p = subprocess.run([NATS, "req", topic, json.dumps(payload), "--timeout", timeout, "-r"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats req {topic} failed: {p.stderr.strip() or p.stdout.strip()}")
    return json.loads(p.stdout.strip())


def pub(topic, payload):
    p = subprocess.run([NATS, "pub", topic, json.dumps(payload)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"nats pub {topic} failed: {p.stderr.strip()}")


def now():
    return int(time.time())


def newid():
    return str(uuid.uuid4())


fails = 0
total = 0


def check(name, ok, detail=""):
    global fails, total
    total += 1
    print(f"  {'✅' if ok else '❌'} {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails += 1


def login(nick):
    """Регистрация (идемпотентно) + выдача JWT."""
    req("identity.user.register", {"user": f"{nick}@local", "password": "test"})
    r = req("identity.token.issue", {"user": f"{nick}@local", "password": "test"})
    assert r.get("ok") and r.get("token"), f"login {nick}: {r}"
    return r["token"]


def info(token, gid):
    r = req("group.info", {"token": token, "group_id": gid})
    gs = r.get("groups", [])
    return gs[0] if gs else None


def member(inf, addr):
    return next((m for m in inf["members"] if m["address"] == addr), None)


def sync(token, who):
    ev = {"id": newid(), "from": who, "ts": now(), "token": token,
          "payload": {"last_seen_id": "00000000-0000-0000-0000-000000000000", "since_updated": 0}}
    return req("msg.sync.request", ev).get("payload", {}).get("messages", [])


print("=== Parvane e2e: группы (spec 003) ===")
A, B, C, D, E = (f"{n}{SUF}" for n in ("alice", "bob", "carol", "dave", "erin"))
ta, tb, tc, td, te = (login(n) for n in (A, B, C, D, E))
addr = {n: f"{n}@local" for n in (A, B, C, D, E)}

print("[0] group.create")
r = req("group.create", {"token": ta, "name": "Контракт", "kind": "group", "members": [addr[B], addr[C]]})
gid = r.get("group_id")
check("создана", r.get("ok") and gid, gid)
i0 = info(ta, gid)
check("GroupInfo несёт новые поля (about='', version=0, default_permissions, pending_requests владельцу)",
      i0 and i0.get("about") == "" and i0.get("version") == 0
      and i0.get("default_permissions", {}).get("send_messages") is True
      and i0.get("default_permissions", {}).get("pin_messages") is False
      and i0.get("pending_requests") == 0, json.dumps({k: i0.get(k) for k in ("about", "version", "pending_requests")}) if i0 else "нет info")
ib = info(tb, gid)
check("участнику pending_requests не отдаётся", ib and "pending_requests" not in ib)

print("[US1] group.setinfo: описание и фото")
r = req("group.setinfo", {"token": ta, "group_id": gid, "about": "Описание группы"})
check("владелец меняет описание", r.get("ok") and r.get("version") == 1, r)
fid = newid()
r = req("group.setinfo", {"token": ta, "group_id": gid, "avatar_file_id": fid})
check("владелец ставит фото", r.get("ok") and r.get("version") == 2, r)
i1 = info(tb, gid)
check("участник видит about, avatar, version", i1 and i1["about"] == "Описание группы" and i1.get("avatar") == fid and i1["version"] == 2)
r = req("group.setinfo", {"token": tb, "group_id": gid, "about": "взлом"})
check("участник без change_info → forbidden", not r.get("ok") and r.get("error_code") == "forbidden", r.get("error_code"))
r = req("group.setinfo", {"token": ta, "group_id": gid, "about": "я" * 256})
check("256 символов → bad_request", r.get("error_code") == "bad_request")
r = req("group.setinfo", {"token": ta, "group_id": gid, "about": "я" * 255})
check("255 символов принимается", r.get("ok"))
r = req("group.setinfo", {"token": ta, "group_id": gid, "clear_avatar": True})
check("снять фото", r.get("ok") and "avatar" not in info(tb, gid))

print("[US2] group.setperms: права по умолчанию и серверные проверки")
r = req("group.setperms", {"token": tb, "group_id": gid, "default_permissions": {"send_messages": False}})
check("участник не меняет права → forbidden", r.get("error_code") == "forbidden")
r = req("group.setperms", {"token": ta, "group_id": gid,
                            "default_permissions": {"send_messages": False, "invite_users": False, "pin_messages": False}})
check("владелец выключил send_messages/invite_users", r.get("ok"), r)
v_after_perms = r.get("version")
check("участник видит новые права", info(tb, gid)["default_permissions"]["send_messages"] is False)
mid_b = newid()
pub("msg.chat.send", {"id": mid_b, "from": addr[B], "ts": now(), "token": tb,
                      "payload": {"to": gid, "content": {"kind": "text", "text": "запрещено"}}})
mid_a = newid()
pub("msg.chat.send", {"id": mid_a, "from": addr[A], "ts": now(), "token": ta,
                      "payload": {"to": gid, "content": {"kind": "text", "text": "владелец пишет"}}})
time.sleep(0.6)
ids = {m.get("id") for m in sync(tc, addr[C])}
check("сообщение участника без send_messages не доставлено", mid_b not in ids)
check("сообщение владельца доставлено", mid_a in ids)
r = req("group.addmember", {"token": tb, "group_id": gid, "member": addr[D]})
check("участник без invite_users не добавляет → forbidden", not r.get("ok") and r.get("error_code") == "forbidden", r)
r = req("group.setperms", {"token": ta, "group_id": gid, "default_permissions": {"send_messages": True, "invite_users": True}})
check("владелец включил обратно", r.get("ok"))
r = req("group.addmember", {"token": tb, "group_id": gid, "member": addr[D]})
check("участник с invite_users добавляет", r.get("ok"), r)
ch = req("group.create", {"token": ta, "name": "Канал", "kind": "channel", "members": [addr[B]]})
r = req("group.setperms", {"token": ta, "group_id": ch["group_id"], "default_permissions": {}})
check("у канала прав нет → bad_request", r.get("error_code") == "bad_request")

print("[US3] group.setadmin: гранулярные права")
only_pin = {"change_info": False, "delete_messages": False, "ban_users": False, "invite_users": False, "pin_messages": True, "add_admins": False}
r = req("group.setadmin", {"token": ta, "group_id": gid, "member": addr[B], "rights": only_pin})
check("владелец назначил bob админом (только pin)", r.get("ok"), r)
mb = member(info(ta, gid), addr[B])
check("info: bob admin, admin_rights.pin_messages, promoted_by=alice",
      mb and mb["role"] == "admin" and mb["admin_rights"]["pin_messages"] and not mb["admin_rights"]["ban_users"]
      and mb.get("promoted_by") == addr[A], mb)
r = req("group.ban", {"token": tb, "group_id": gid, "member": addr[C]})
check("bob без ban_users не банит → forbidden", not r.get("ok") and r.get("error_code") == "forbidden")
r = req("group.setadmin", {"token": tb, "group_id": gid, "member": addr[C], "rights": only_pin})
check("bob без add_admins не назначает → forbidden", r.get("error_code") == "forbidden")
r = req("group.rename", {"token": tb, "group_id": gid, "name": "Переименовал"})
check("bob без change_info не переименовывает", not r.get("ok"))
r = req("group.setadmin", {"token": ta, "group_id": gid, "member": addr[B], "rights": None})
check("владелец снял админа", r.get("ok") and member(info(ta, gid), addr[B])["role"] == "member")
r = req("group.setrole", {"token": ta, "group_id": gid, "member": addr[B], "role": "admin"})
mb = member(info(ta, gid), addr[B])
check("legacy group.setrole → полный набор прав", r.get("ok") and mb["admin_rights"]["add_admins"] and mb["admin_rights"]["ban_users"], mb.get("admin_rights"))
sub = {"change_info": False, "delete_messages": False, "ban_users": False, "invite_users": True, "pin_messages": False, "add_admins": False}
r = req("group.setadmin", {"token": tb, "group_id": gid, "member": addr[C], "rights": sub})
check("bob (полные права) назначает carol ⊆", r.get("ok"), r)
r = req("group.setadmin", {"token": tc, "group_id": gid, "member": addr[D], "rights": sub})
check("carol без add_admins не назначает", r.get("error_code") == "forbidden")
r = req("group.setadmin", {"token": ta, "group_id": gid, "member": addr[A], "rights": sub})
check("владельца не тронуть", r.get("error_code") == "forbidden")

print("[US4] инвайт-ссылки")
r = req("group.invite.list", {"token": ta, "group_id": gid})
check("список пуст до создания", r.get("ok") and r.get("links") == [])
r = req("group.invite.create", {"token": ta, "group_id": gid})
primary = r.get("invite")
check("основная ссылка создана с полной записью", r.get("ok") and primary and r["link"]["is_primary"] and r["link"]["state"] == "active", r.get("link"))
r = req("group.invite.create", {"token": ta, "group_id": gid, "title": "лимит 1", "max_uses": 1})
limited = r.get("invite")
check("ссылка с лимитом 1", r.get("ok") and r["link"]["max_uses"] == 1 and not r["link"]["is_primary"])
r = req("group.invite.create", {"token": ta, "group_id": gid, "title": "истёкшая", "expires_at": now() - 5})
expired = r.get("invite")
check("ссылка с прошедшим сроком создана", r.get("ok"))
r = req("group.invite.create", {"token": td, "group_id": gid})
check("участник не создаёт → forbidden", r.get("error_code") == "forbidden")
r = req("group.invite.create", {"token": tc, "group_id": gid})
check("carol (invite_users) создаёт", r.get("ok"))
carol_link = r.get("invite")
r = req("group.invite.list", {"token": tc, "group_id": gid})
states = {l["token"]: l["state"] for l in r.get("links", [])}
check("список: 4 ссылки, состояния", len(states) == 4 and states.get(expired) == "expired" and states.get(limited) == "active", states)
check("is_primary ровно у одной", sum(1 for l in r["links"] if l["is_primary"]) == 1)
r = req("group.invite.check", {"token": te, "invite": limited})
check("check: имя/участники/request_needed=false, состава нет",
      r.get("ok") and r.get("name") == "Контракт" and r.get("members_count") == 4 and not r.get("request_needed") and "members" not in r, r)
r = req("group.invite.check", {"token": te, "invite": expired})
check("check истёкшей → expired", r.get("error_code") == "expired")
r = req("group.join", {"token": te, "invite": limited})
check("erin вступила по лимитной", r.get("ok") and not r.get("pending"), r)
f = login(f"frank{SUF}")
r = req("group.join", {"token": f, "invite": limited})
check("вторая попытка → exhausted", r.get("error_code") == "exhausted", r)
r = req("group.join", {"token": f, "invite": expired})
check("по истёкшей → expired", r.get("error_code") == "expired")
r = req("group.join", {"token": f, "invite": "0" * 32})
check("несуществующая → invalid", r.get("error_code") == "invalid")
r = req("group.join", {"token": te, "invite": limited})
check("повторно участником → ok без счётчика", r.get("ok"))
uses = {l["token"]: l["uses"] for l in req("group.invite.list", {"token": ta, "group_id": gid})["links"]}
check("uses лимитной = 1", uses.get(limited) == 1, uses)
r = req("group.invite.revoke", {"token": td, "group_id": gid, "invite": primary})
check("участник не отзывает → forbidden", r.get("error_code") == "forbidden")
r = req("group.invite.revoke", {"token": tc, "group_id": gid, "invite": primary})
check("carol отозвала основную", r.get("ok"))
r = req("group.join", {"token": f, "invite": primary})
check("по отозванной → revoked", r.get("error_code") == "revoked")
r = req("group.invite.list", {"token": ta, "group_id": gid, "revoked": True})
check("отозванные: 1", r.get("ok") and [l["token"] for l in r["links"]] == [primary])
r = req("group.invite.delete", {"token": ta, "group_id": gid, "invite": limited})
check("удалить активную нельзя → bad_request", r.get("error_code") == "bad_request")
r = req("group.invite.delete", {"token": ta, "group_id": gid, "invite": primary})
check("удалить отозванную", r.get("ok") and req("group.invite.list", {"token": ta, "group_id": gid, "revoked": True})["links"] == [])
r = req("group.ban", {"token": ta, "group_id": gid, "member": f"frank{SUF}@local"})
check("бан не-участника", r.get("ok"))
r = req("group.join", {"token": f, "invite": carol_link})
check("забаненный → banned", r.get("error_code") == "banned")

print("[US5] заявки на вступление")
r = req("group.invite.create", {"token": ta, "group_id": gid, "title": "по одобрению", "request_needed": True})
approve_link = r.get("invite")
check("ссылка по одобрению", r.get("ok") and r["link"]["request_needed"])
g = login(f"grace{SUF}")
r = req("group.join", {"token": g, "invite": approve_link})
check("grace: pending", r.get("ok") and r.get("pending") is True, r)
r = req("group.join", {"token": g, "invite": approve_link})
check("повтор — та же заявка", r.get("ok") and r.get("pending"))
check("check показывает pending", req("group.invite.check", {"token": g, "invite": approve_link}).get("pending") is True)
r = req("group.request.list", {"token": td, "group_id": gid})
check("участник не видит заявки → forbidden", r.get("error_code") == "forbidden")
r = req("group.request.list", {"token": tc, "group_id": gid})
check("carol видит заявку grace", r.get("ok") and [x["member"] for x in r["requests"]] == [f"grace{SUF}@local"], r)
check("pending_requests=1 у владельца", info(ta, gid).get("pending_requests") == 1)
r = req("group.request.decide", {"token": td, "group_id": gid, "member": f"grace{SUF}@local", "approve": True})
check("участник не решает → forbidden", r.get("error_code") == "forbidden")
r = req("group.request.decide", {"token": tc, "group_id": gid, "member": f"grace{SUF}@local", "approve": True})
check("carol одобрила", r.get("ok"), r)
check("grace — участник", member(info(ta, gid), f"grace{SUF}@local")["role"] == "member")
uses = {l["token"]: l["uses"] for l in req("group.invite.list", {"token": ta, "group_id": gid})["links"]}
check("uses ссылки по одобрению = 1", uses.get(approve_link) == 1)
h = login(f"heidi{SUF}")
req("group.join", {"token": h, "invite": approve_link})
r = req("group.request.decide", {"token": ta, "group_id": gid, "member": f"heidi{SUF}@local", "approve": False})
check("heidi отклонена", r.get("ok"))
r = req("group.join", {"token": h, "invite": approve_link})
check("повтор после отказа → declined", r.get("error_code") == "declined", r)
check("заявок нет", req("group.request.list", {"token": ta, "group_id": gid})["requests"] == [])

print("[US6] ревизия растёт и удаление")
v1 = info(ta, gid)["version"]
req("group.rename", {"token": ta, "group_id": gid, "name": "Финал"})
v2 = info(ta, gid)["version"]
check("rename повышает version", v2 == v1 + 1, f"{v1}→{v2}")
r = req("group.delete", {"token": ta, "group_id": gid})
check("удалена", r.get("ok") and info(ta, gid) is None)
check("ссылка удалённой группы → invalid", req("group.invite.check", {"token": g, "invite": approve_link}).get("error_code") == "invalid")

print()
if fails:
    print(f"РЕЗУЛЬТАТ: ❌ {fails}/{total} проверок провалено")
    sys.exit(1)
print(f"РЕЗУЛЬТАТ: ✅ OK: {total}/{total}")
