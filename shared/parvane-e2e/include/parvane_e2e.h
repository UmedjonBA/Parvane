/* Parvane E2E (Фаза 2): C-ABI обёртки vodozemac (Olm). Линкуется из C++
 * (parvane-core). Все возвращаемые char* — освобождать parvane_e2e_string_free;
 * указатели аккаунта/сессии — соответствующими *_free. NULL = ошибка.
 * Строки ключей/шифртекста/plaintext передаются в base64 БЕЗ padding
 * (unpadded, как у vodozemac): "hi" == "aGk", НЕ "aGk=". C++-сторона обязана
 * кодировать/декодировать unpadded, иначе round-trip не сойдётся. */
#ifndef PARVANE_E2E_H
#define PARVANE_E2E_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ParvaneE2EAccount ParvaneE2EAccount;
typedef struct ParvaneE2ESession ParvaneE2ESession;
typedef struct ParvaneE2EGroupSession ParvaneE2EGroupSession;   /* исходящая (своя) */
typedef struct ParvaneE2EInboundGroup ParvaneE2EInboundGroup;   /* входящая (по SKDM) */

void parvane_e2e_string_free(char *s);

/* Safety number пары identity-ключей (base64) — верификация против MITM. */
char *parvane_e2e_safety_number(const char *identity_a_b64, const char *identity_b_b64);

/* Аккаунт: жизненный цикл + персист (pickle — JSON, хранить 0600). */
ParvaneE2EAccount *parvane_e2e_account_new(void);
void parvane_e2e_account_free(ParvaneE2EAccount *acc);
char *parvane_e2e_account_pickle(const ParvaneE2EAccount *acc);
ParvaneE2EAccount *parvane_e2e_account_from_pickle(const char *pickle_json);

/* Публичный identity-ключ (base64). */
char *parvane_e2e_account_identity(const ParvaneE2EAccount *acc);

/* Сгенерировать n one-time, вернуть JSON [{"key_id":i,"public_key":"b64"},…]. */
char *parvane_e2e_account_gen_otks(ParvaneE2EAccount *acc, uint32_t n,
                                   int64_t start_id);

/* Исходящая сессия по бандлу собеседника (X3DH). */
ParvaneE2ESession *parvane_e2e_outbound(const ParvaneE2EAccount *acc,
                                        const char *identity_b64,
                                        const char *otk_b64);

/* Входящая сессия из pre-key сообщения. *out_plaintext_b64 = расшифрованное
 * первое сообщение (base64; освобождать string_free). */
ParvaneE2ESession *parvane_e2e_inbound(ParvaneE2EAccount *acc,
                                       const char *sender_identity_b64,
                                       uint32_t prekey_type,
                                       const char *prekey_ct_b64,
                                       char **out_plaintext_b64);

void parvane_e2e_session_free(ParvaneE2ESession *sess);

/* Персист сессии (Olm ratchet-состояние) — JSON. Хранить на устройстве 0600. */
char *parvane_e2e_session_pickle(const ParvaneE2ESession *sess);
ParvaneE2ESession *parvane_e2e_session_from_pickle(const char *pickle_json);

/* Шифрует plaintext_b64 → шифртекст (base64); *out_type = тип Olm (0/1). */
char *parvane_e2e_encrypt(ParvaneE2ESession *sess, const char *plaintext_b64,
                          uint32_t *out_type);

/* Расшифровывает → plaintext (base64) или NULL. */
char *parvane_e2e_decrypt(ParvaneE2ESession *sess, uint32_t msg_type,
                          const char *ct_b64);

/* ── Megolm (группы, Фаза 3) ── */
ParvaneE2EGroupSession *parvane_e2e_group_new(void);
void parvane_e2e_group_free(ParvaneE2EGroupSession *g);
char *parvane_e2e_group_session_key(const ParvaneE2EGroupSession *g); /* base64, раздать */
char *parvane_e2e_group_encrypt(ParvaneE2EGroupSession *g, const char *plaintext_b64);
char *parvane_e2e_group_pickle(const ParvaneE2EGroupSession *g);
ParvaneE2EGroupSession *parvane_e2e_group_from_pickle(const char *pickle_json);

ParvaneE2EInboundGroup *parvane_e2e_inbound_group_from_key(const char *session_key_b64);
void parvane_e2e_inbound_group_free(ParvaneE2EInboundGroup *g);
char *parvane_e2e_inbound_group_decrypt(ParvaneE2EInboundGroup *g, const char *ct_b64);
char *parvane_e2e_inbound_group_pickle(const ParvaneE2EInboundGroup *g);
ParvaneE2EInboundGroup *parvane_e2e_inbound_group_from_pickle(const char *pickle_json);

#ifdef __cplusplus
}
#endif

#endif /* PARVANE_E2E_H */
