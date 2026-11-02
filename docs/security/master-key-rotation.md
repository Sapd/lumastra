<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Master key rotation

> **Scope.** Contributor/ops reference for `LUMASTRA_MASTER_KEY` rotation — what the
> rotation endpoint covers, what it cannot cover, and the exact order an operator must
> follow. The operator-facing version of this page belongs on the website
> (https://lumastra.org), per `docs/CLAUDE.md`; keep the two in sync.

`LUMASTRA_MASTER_KEY` is the single key every secret in Lumastra is encrypted with. It is
resolved by `resolveMasterKey()` — the env var if set, otherwise an auto-generated
`<config>/master.key` — and never stored in the database. A database dump is therefore
useless on its own; that is the entire point of the design.

Rotating it means re-encrypting every stored secret under a new key **before** the new key
is put into service. `POST /api/admin/secrets/rotate` (admin UI: **Admin → Secrets →
Rotate Master Key**) does that and covers every store rather than just the plugin tables.

## What rotation covers

| Store                                                         | Where it is sealed                           | Rotation                        |
| ------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| `plugin_secrets`, `plugin_user_credentials`                   | `tasks/secrets.ts`                           | `PluginSecrets.rotate`          |
| `settings.json` values marked `uiHints.sensitive`             | `config/config.service.ts`                   | `rotateConfigSecrets`           |
| `subsonic_client_passwords.token_sealed` **+ `token_lookup`** | `subsonic-compat/auth.ts`                    | `rotateSubsonicTokens`          |
| `task_webhook_hooks.secret_encrypted`                         | `api/defs/webhooks/*`                        | `rotateWebhookSecrets`          |
| `user_notification_webhooks.secret_encrypted`                 | `api/defs/user/notification-webhook.ts`      | `rotateWebhookSecrets`          |
| `jellyfin_client_passwords.password_sealed`                   | `proprietary/jellyfin-compat/auth.ts`        | `rotateJellyfinClientPasswords` |
| `livetv_sources.xtream_username` / `.xtream_password`         | `database/queries/livetv-sources.queries.ts` | `rotateLiveTvCredentials`       |

The Subsonic row is the one with a second moving part: `token_lookup` is an
HMAC-SHA256 **under the same master key**, used as a blind index for the
`apiKeyAuthentication` reverse lookup. Re-sealing the envelope without recomputing that
digest leaves a token that exists and can never authenticate.

`src/lib/server/admin/secrets-rotate-coverage.test.ts` enumerates every module that seals
a value with the master key and fails if one is not covered here. **If you add a sealed
store, write its rotation next to its own sealing code and wire it into
`handleSecretsRotate`** — the test will tell you when you have not.

## Rotation also upgrades the envelope to `enc:v2:`

A sealed value is **bound to the row it lives in**: the row's identity (the user id, hook id, source id, plugin id + key, setting
key) is passed to AES-GCM as additional authenticated data, so a ciphertext copied from
one row into another fails its auth tag instead of decrypting. Bound values are tagged
`enc:v2:` (raw BYTEA blobs carry the same seven bytes as a prefix); the older, unbound
form is `enc:v1:`.

Values written **before** that change are still `enc:v1:` and are still accepted on
read — refusing them would lock every existing install out of its own credentials. The
rotation is how they are upgraded: **every store re-seals as `enc:v2:`, including values
that already open under the new key**, so one rotation converts the whole install. The
response reports what it upgraded, per store, in `legacyUpgraded`, and the admin UI shows
the same list.

### Check the self-check BEFORE you rotate

**The upgrade binds each value to whatever row it is sitting in at that moment.** An
`enc:v1:` value carries no statement about where it came from, so if one had been moved
into the wrong row — by a partial restore, a hand-edited dump, or an attacker with
database write access — the rotation re-seals it as a valid, row-bound secret **for that
row, permanently**. Rotation does not detect the transplant; it blesses it.

So: run **Admin → System Health → Security Self-Check** first and read
`inventory.legacy-secret-envelopes`. It counts, per store, the values that are still
unbound — plus any Subsonic token still held as pre-encryption plaintext in
`subsonic_client_passwords.token`, and any `settings.json` value still on the old
envelope. If the count is non-zero (which it will be on any install that predates
2026-09-13), that is expected — but it is also the moment to satisfy yourself that those
rows hold what they should, rather than discovering later that one of them does not.
Rotate the affected credentials by hand (issue a new Subsonic token, reset a `/j` client
password, re-enter an API key) if you have any reason to doubt a row.

### Rotation does not retire ciphertext captured under the old key

Upgrading the envelope changes nothing about copies of the OLD ciphertext that already
exist — in backups, replicas or WAL archives — and a rotation to the **same** key leaves
every one of them decryptable with the key you still hold. Only a rotation to a **new**
master key makes previously captured ciphertext useless, and even then only for data
written afterwards (see [Backups](#backups-and-old-ciphertext)). Do not treat "clear the
legacy-envelope warning" as a reason to rotate to the same key: it silences a report
without retiring anything.

## What rotation cannot cover: values derived from the key

Two values are computed _from_ the master key and never stored, so there is no ciphertext
to move. They simply become different the moment the key changes:

- **`JWT_SECRET`, when it is not set explicitly.** `src/lib/server/config.ts` falls back to
  `deriveSubSecret(masterKey, 'lumastra-jwt-secret-v1')`. Rotating the master key
  invalidates every issued access and refresh token: **all users are signed out** and every
  native/TV client must log in again.
  _Avoid this_ by setting an explicit `JWT_SECRET` (any long random string) **before** you
  rotate. Once set, it is independent of the master key and rotation does not touch
  sessions.
- **The Jellyfin (`/j`) server id.** `JELLYFIN_SERVER_ID` is
  `sha256('jellyfin-server-id:' + masterKey)`. Rotating changes the id, so already-paired
  `/j` clients (Jellyfin Media Player, Tizen, WebOS, Moonfin…) see a "new" server and
  re-pair once. There is no way to preserve it other than not rotating; plan for one round
  of client re-pairing.

A third derived value, the master-key **fingerprint** shown in the admin UI and the cluster
heartbeat, is non-secret and recomputed on read — it simply reports the new key afterwards,
which is how you verify every replica agrees.

A fourth, the key for the short **tags that replace ids in a GitHub report draft** (Admin →
Users → Client diagnostics), is also derived and not stored. After a rotation the same id
gets a different tag, so tags in reports drafted before and after it cannot be matched.
Nothing else changes.

## Operator sequence

Do these in order. The single most common mistake is swapping the env var first: the
rotation endpoint then has nothing it can read, and the old ciphertext is orphaned.

1. **Back up first.** Take a database dump _and_ a copy of the config volume
   (`settings.json`, `master.key`). Keep the **old key** with them — see
   [Backups](#backups-and-old-ciphertext).
1. **Run the security self-check** and read `inventory.legacy-secret-envelopes`. Rotation
   binds every un-upgraded value to the row it is currently in — see
   [Check the self-check BEFORE you rotate](#check-the-self-check-before-you-rotate).
1. **Set `JWT_SECRET` explicitly** if you would rather not sign everyone out, and restart.
   (Optional, but do it before rotating, not after.)
1. **Generate the new key**: `openssl rand -hex 32`. A 64-char hex value is the preferred
   form; a passphrase is accepted but must be ≥ 24 characters with two character classes,
   and is run through scrypt with `LUMASTRA_KDF_SALT`. **Do not change
   `LUMASTRA_KDF_SALT` at the same time** — it re-derives a different key from the same
   passphrase and orphans everything.
1. **Run the rotation while the OLD key is still live.** The environment must still hold
   the current key; the request carries both.

    ```bash
    curl -sS -X POST https://<host>/api/v1/admin/secrets/rotate \
      -H 'Authorization: Bearer <PAT with tasks:admin>' \
      -H 'Content-Type: application/json' \
      -d '{"oldMasterKey":"<current>","newMasterKey":"<new>",
           "confirmation":"I_UNDERSTAND_THIS_RE_ENCRYPTS_ALL_SECRETS"}'
    ```

    Rotation takes a Valkey lock (`lock:secrets:rotate`); a second concurrent rotation is
    refused with `409` rather than being allowed to split the ciphertext space. If Valkey is
    unavailable the endpoint refuses outright (`503`) — that is deliberate.

1. **Read the response before doing anything else.**
    - `rotated` / `skipped` — values moved, and values that opened under _neither_ key.
    - `legacyUpgraded: {store: n}` — values moved off the old unbound envelope onto the
      row-bound one, per store. Each is now valid only in the row it was in when this ran.
    - `notRotated: [{store, reason}]` — **stop here if this is non-empty.** Everything
      listed is still sealed with the old key. Fix the cause and re-run: every store
      rotation is per-row and idempotent, so a re-run finishes the job rather than
      double-encrypting what already moved.
    - HTTP `207` means rows existed that could not be re-encrypted.
1. **Only when the response is clean:** set the new value of `LUMASTRA_MASTER_KEY`
   (or replace `<config>/master.key`) for **every** replica and worker.
1. **Rolling-restart every replica.** The replica that served the rotation self-heals its
   in-process key cache immediately; every other one keeps the old key until restarted and
   will throw `Secret decrypt failed …` on each secret read in the meantime.
1. **Verify.** Compare the master-key fingerprint across replicas (admin → cluster), start
   a Subsonic client, fire a webhook test delivery, open a Live TV source, and confirm the
   startup log has no `[ConfigService] … could not be decrypted` line. Re-run the security
   self-check: `inventory.legacy-secret-envelopes` should now pass.

## If something was missed

The signal that a value did not move is `[ConfigService] N sensitive setting(s) could not be
decrypted and are NOT in effect` at **error** level on boot, naming each key. The affected
settings are not in effect — the app runs on their defaults, so an API key you can still see
configured in the admin UI is not being sent.

The remedy is to put the **old** key back (env or `master.key`), restart, and run the
rotation again. That is why the old key must be retained until verification passes; without
it those values can only be re-entered by hand.

The same failure in other stores is quieter by design: a Subsonic token that cannot be
opened fails authentication closed, an unopenable webhook secret makes deliveries error, and
a Live TV source stops refreshing.

## Backups and old ciphertext

- **A backup is only readable with the key that was live when it was taken.** Store the key
  alongside the backup (in your secret manager, not in the same bucket), and label which key
  each backup needs. A pre-rotation dump restored onto a post-rotation deployment cannot be
  decrypted.
- **Rotation does not shred the old ciphertext.** Previous backups, replicas, and WAL
  archives still contain values that open with the retired key. If the reason for rotating
  was a _leak of the old key_, the rotation protects new data only — you must also expire
  the leaked credentials themselves (issue new Subsonic tokens, new webhook secrets, new
  Xtream credentials, new provider API keys) and destroy or re-encrypt the old backups.
- `settings.json` is rewritten in place by the rotation. The config volume backup from
  step 1 is your rollback.

## Related

- `src/lib/server/admin/secrets-rotate.handler.ts` — the endpoint and its store list.
- `src/lib/server/crypto/secret-box.ts` — key derivation and the `enc:v1:` / `enc:v2:`
  envelopes (`aad` = the row context).
- `src/lib/server/services/security-self-check/inventory-checks.ts` —
  `inventory.legacy-secret-envelopes`, the rule that counts un-upgraded values.
- `src/lib/server/admin/secrets-rotate-coverage.test.ts` — the gate that keeps this list
  honest.
