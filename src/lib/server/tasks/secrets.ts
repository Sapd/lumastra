// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// AES-GCM secret store for per-plugin and per-user credentials.
//
// Encryption: AES-256-GCM. Format: iv(12) | tag(16) | ciphertext(N).
// The master key is derived from LUMASTRA_MASTER_KEY (64-char hex → raw 32 bytes,
// or arbitrary passphrase → SHA-256). The key is NEVER persisted or mirrored.
//
// Rotation increments encryption_version; old rows (version N) are decrypted
// with the old key, re-encrypted with the new key, and written back as version N+1.
//
// First-boot seeding: when plugin_secrets is empty and a master key is set,
// known env vars are written as plugin secrets so operators don't have to
// configure them again via the admin UI.
//
// get() / getUser() record a fire-and-forget audit row (auditGet) to
// plugin_secret_access_log. NOTE: getUserRaw() — backing
// ctx.userCredentials.get() — is intentionally NOT audited: it runs in tight
// per-cycle plugin loops where a per-read audit write would generate excessive
// volume. There is no blocking/fail-closed audit path (the earlier
// auditGetBlocking helper was unused and has been removed).

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import {
    deriveMasterKey,
    encrypt,
    decrypt,
    sealSecret,
    openSecret,
    isSealed,
    isAadBound,
    isAadBoundBlob,
} from '$lib/server/crypto/secret-box.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { taskPendingWritePoisonedTotal } from './metrics.js';

const log = Logger.for('PluginSecrets');

// ── Crypto helpers ────────────────────────────────────────────────────────────
//
// The AES-256-GCM primitives (deriveMasterKey / encrypt / decrypt) live in
// $lib/server/crypto/secret-box.js so the config service can share them without
// pulling in this module's postgres/metrics/logger dependencies. Re-exported
// here for existing callers (webhook-outbox, mal-credentials.queries).
export { deriveMasterKey, encrypt, decrypt };

// ── Row-binding contexts (security review 2026-09-13, C19) ────────────────────
//
// Every value this module seals is bound to the row it lives in with AES-GCM
// additional authenticated data, so a blob copied from one row into another
// fails its auth tag instead of opening in the wrong context. The string must
// be STABLE for the whole life of the row — it is recomputed on every read, and
// a context that does not reproduce exactly is indistinguishable from tampering.
//
// Every context starts with its STORE NAME, which is part of the contract (see
// crypto/secret-box.ts). Without it these two were ambiguous with each other:
// `key` is free-form text, so a plugin secret keyed `<uuid>/access_token`
// produced exactly the context of that user's credential for the same plugin.
//
// `userId` is lower-cased because the uuid column stores lower-case while a
// caller may hand us the same id in any case (iOS sends upper-case UUIDs); a
// write and a later read of the same row must agree on the byte string.

/** AAD context for a `plugin_secrets` row. */
export function pluginSecretContext(pluginId: string, key: string): string {
    return `plugin_secrets:${pluginId}/${key}`;
}

/** AAD context for a `plugin_user_credentials` row. */
export function pluginUserCredentialContext(pluginId: string, userId: string, key: string): string {
    return `plugin_user_credentials:${pluginId}/${userId.toLowerCase()}/${key}`;
}

/** AAD context for a `jellyfin_client_passwords` row. */
export function jellyfinClientPasswordContext(userId: string): string {
    return `jellyfin_client_passwords:${userId.toLowerCase()}`;
}

// ── Module-level master key cache ─────────────────────────────────────────────

/**
 * Process-singleton derived master key. The key is stable for the process
 * lifetime UNLESS a rotation happens (see `rotate()` below), so deriving it
 * once avoids repeated Buffer.from(hex) or SHA-256 work on every
 * get() / getUser() / set() / setUser() call.
 *
 * Lazily initialised on first use so test harnesses that never set
 * LUMASTRA_MASTER_KEY don't blow up at import time.
 */
let _cachedMasterKey: Buffer | null = null;

function getCachedMasterKey(): Buffer {
    if (_cachedMasterKey) return _cachedMasterKey;
    _cachedMasterKey = deriveMasterKey(resolveMasterKey());
    return _cachedMasterKey;
}

/**
 * Overwrite the process-singleton master key cache. Called by `rotate()` on
 * successful completion so that THIS process (the one that served the
 * rotate request) immediately decrypts with the new key instead of holding
 * a stale derived key until restart.
 *
 * NOTE: this cannot update `process.env.LUMASTRA_MASTER_KEY` — `rotate()`
 * only receives the already-derived 32-byte key `Buffer`, never the raw
 * source string (hex or passphrase), and re-serializing the Buffer back to
 * an env value would not round-trip a passphrase-derived key (SHA-256 is
 * one-way). The operator MUST still update the env/secret store out of
 * band; see the `rotate()` doc comment for the full contract.
 */
function setCachedMasterKey(key: Buffer): void {
    _cachedMasterKey = key;
}

/**
 * Test-only escape hatch: force the module cache back to "uninitialised" so
 * a test that rotates the key (which mutates this process-wide singleton)
 * cannot leak that state into unrelated tests in the same file/module
 * instance. Not used by production code paths.
 */
export function __resetMasterKeyCacheForTests(): void {
    _cachedMasterKey = null;
}

// ── PluginSecrets ─────────────────────────────────────────────────────────────

export class PluginSecrets {
    constructor(private readonly sql: postgres.Sql) {}

    /**
     * Decrypt a stored blob, converting a bare GCM auth-tag failure into a
     * descriptive error instead of letting it bubble up uncaught.
     *
     * The single most common cause of a decrypt failure in production is a
     * master-key rotation that re-encrypted the row with a new key while
     * this process is still holding the old cached key — which happens on
     * every replica EXCEPT the one that served the rotate request (see
     * `rotate()` for the operational contract). Fail loudly and say so,
     * rather than surfacing an opaque "Unsupported state or unable to
     * authenticate data" from node:crypto.
     */
    private decryptOrThrow(encrypted: Buffer, masterKey: Buffer, context: string): string {
        try {
            // `context` is BOTH the error label and the AAD the row was sealed
            // under — one string, so the two can never drift apart.
            return decrypt(encrypted, masterKey, context);
        } catch (err) {
            throw new Error(
                `Secret decrypt failed (${context}): ` +
                    `${err instanceof Error ? err.message : String(err)}. ` +
                    `If the master key was recently rotated, this replica needs a restart ` +
                    `with the new LUMASTRA_MASTER_KEY.`,
                { cause: err },
            );
        }
    }

    // -- Global per-plugin secrets -------------------------------------------

    /**
     * Read a global plugin secret. Throws if not found or master key missing.
     * Audit-logged.
     */
    async get(pluginId: string, key: string, runId?: string): Promise<string> {
        const masterKey = getCachedMasterKey();

        const rows = await this.sql<{ value_encrypted: Buffer; encryption_version: number }[]>`
            SELECT value_encrypted, encryption_version
            FROM plugin_secrets
            WHERE plugin_id = ${pluginId} AND key = ${key}
        `;
        if (rows.length === 0) {
            throw new Error(`Plugin secret not found: ${pluginId}/${key}`);
        }

        const row = rows[0];
        const value = this.decryptOrThrow(
            row.value_encrypted,
            masterKey,
            pluginSecretContext(pluginId, key),
        );

        void this.auditGet(pluginId, key, undefined, runId);

        return value;
    }

    /**
     * Read a global plugin secret WITHOUT throwing when the row is absent.
     * Returns the decrypted value, or null when no secret row exists for
     * (pluginId, key). Use for OPTIONAL credentials — get() throws on a
     * missing row, so `(await ctx.secrets.get(key)) ?? ''` is dead code.
     */
    async getOptional(pluginId: string, key: string, runId?: string): Promise<string | null> {
        // Query the row FIRST and short-circuit on absence — an absent secret
        // needs no decryption, so this path must not require LUMASTRA_MASTER_KEY.
        // (A fresh install commonly runs with no master key set; deriving it
        // up-front would throw "LUMASTRA_MASTER_KEY not set" and defeat the
        // whole point of a non-throwing optional read.) Only derive the key
        // when a row actually exists and must be decrypted.
        const rows = await this.sql<{ value_encrypted: Buffer; encryption_version: number }[]>`
            SELECT value_encrypted, encryption_version
            FROM plugin_secrets
            WHERE plugin_id = ${pluginId} AND key = ${key}
        `;
        if (rows.length === 0) return null;

        const masterKey = getCachedMasterKey();
        const row = rows[0];
        const value = this.decryptOrThrow(
            row.value_encrypted,
            masterKey,
            pluginSecretContext(pluginId, key),
        );

        void this.auditGet(pluginId, key, undefined, runId);

        return value;
    }

    /**
     * Read a per-user OAuth credential. Throws if not found.
     * Audit-logged.
     */
    async getUser(pluginId: string, userId: string, key: string, runId?: string): Promise<string> {
        const masterKey = getCachedMasterKey();

        const rows = await this.sql<
            {
                value_encrypted: Buffer;
                expires_at: Date | null;
            }[]
        >`
            SELECT value_encrypted, expires_at
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid AND key = ${key}
        `;
        if (rows.length === 0) {
            throw new Error(`User credential not found: ${pluginId}/${userId}/${key}`);
        }

        const row = rows[0];
        if (row.expires_at && row.expires_at <= new Date()) {
            throw new Error(`User credential expired: ${pluginId}/${userId}/${key}`);
        }

        const value = this.decryptOrThrow(
            row.value_encrypted,
            masterKey,
            pluginUserCredentialContext(pluginId, userId, key),
        );

        void this.auditGet(pluginId, key, userId, runId);

        return value;
    }

    /**
     * Write / update a global plugin secret. Encrypts with the current master key.
     */
    async set(pluginId: string, key: string, value: string): Promise<void> {
        const masterKey = getCachedMasterKey();
        const blob = encrypt(value, masterKey, pluginSecretContext(pluginId, key));
        const version = await this.getCurrentMaxVersion();

        await this.sql`
            INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
            VALUES (${pluginId}, ${key}, ${blob}, ${version})
            ON CONFLICT (plugin_id, key) DO UPDATE
                SET value_encrypted    = EXCLUDED.value_encrypted,
                    encryption_version = EXCLUDED.encryption_version
        `;
    }

    /**
     * Write / update a per-user OAuth credential.
     */
    async setUser(
        pluginId: string,
        userId: string,
        key: string,
        value: string,
        expiresAt?: Date,
        ifKeyExists?: string,
    ): Promise<void> {
        if (ifKeyExists !== undefined) {
            await this.sql.begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                const rows = await tx`
                    SELECT key FROM plugin_user_credentials
                    WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid
                      AND key = ${ifKeyExists}
                    FOR UPDATE
                `;
                if (rows.length === 0) return;
                await new PluginSecrets(tx).setUser(pluginId, userId, key, value, expiresAt);
            });
            return;
        }
        const masterKey = getCachedMasterKey();
        const blob = encrypt(value, masterKey, pluginUserCredentialContext(pluginId, userId, key));
        const version = await this.getCurrentMaxVersion();

        await this.sql`
            INSERT INTO plugin_user_credentials
                (plugin_id, user_id, key, value_encrypted, encryption_version, expires_at)
            VALUES (${pluginId}, ${userId}::uuid, ${key}, ${blob}, ${version}, ${expiresAt ?? null})
            ON CONFLICT (plugin_id, user_id, key) DO UPDATE
                SET value_encrypted    = EXCLUDED.value_encrypted,
                    encryption_version = EXCLUDED.encryption_version,
                    expires_at         = EXCLUDED.expires_at
        `;
    }

    /**
     * Bulk-read all user bindings for a given plugin_id + key, ordered by
     * last_accessed_at DESC NULLS LAST (most-recently-used first).
     *
     * Expired rows are skipped. Rows that fail to decrypt are logged and
     * skipped. Each successfully decrypted row is audit-logged via the
     * standard fire-and-forget path.
     *
     * Intended for borrower-auth patterns where a task needs to iterate
     * candidate users to find a working OAuth token.
     */
    async listUserBindings(
        pluginId: string,
        key: string,
        limit = 10,
    ): Promise<Array<{ userId: string; value: string; expiresAt: Date | null }>> {
        const masterKey = getCachedMasterKey();

        const rows = await this.sql<
            {
                user_id: string;
                value_encrypted: Buffer;
                expires_at: Date | null;
            }[]
        >`
            SELECT user_id, value_encrypted, expires_at
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND key = ${key}
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY last_accessed_at DESC NULLS LAST
            LIMIT ${limit}
        `;

        const results: Array<{
            userId: string;
            value: string;
            expiresAt: Date | null;
        }> = [];
        for (const row of rows) {
            let value: string;
            try {
                value = decrypt(
                    row.value_encrypted,
                    masterKey,
                    pluginUserCredentialContext(pluginId, row.user_id, key),
                );
            } catch (err) {
                log.warn('listUserBindings: failed to decrypt row, skipping', {
                    pluginId,
                    key,
                    userId: row.user_id,
                    err: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            void this.auditGet(pluginId, key, row.user_id, undefined);
            results.push({
                userId: row.user_id,
                value,
                expiresAt: row.expires_at,
            });
        }
        return results;
    }

    /**
     * Delete a global plugin secret.
     */
    async delete(pluginId: string, key: string): Promise<void> {
        await this.sql`
            DELETE FROM plugin_secrets WHERE plugin_id = ${pluginId} AND key = ${key}
        `;
    }

    /**
     * Delete a per-user OAuth credential. No-op if the row does not exist.
     */
    async deleteUser(pluginId: string, userId: string, key: string): Promise<void> {
        await this.sql`
            DELETE FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid AND key = ${key}
        `;
    }

    /**
     * Read a per-user OAuth credential WITHOUT throwing on expiry.
     *
     * Returns the decrypted value when the row exists, regardless of
     * `expires_at`. Returns null when the row is absent.
     *
     * Use this when the caller wants to inspect a possibly-expired token
     * (e.g. to refresh it). Use `getUser()` when the caller needs a guaranteed
     * fresh credential.
     *
     * No audit log is written — this is a lookup primitive for the generic
     * `ctx.userCredentials.get` surface, where every read would otherwise burn
     * an audit row on a per-cycle loop over all linked users.
     */
    async getUserRaw(pluginId: string, userId: string, key: string): Promise<string | null> {
        const masterKey = getCachedMasterKey();

        const rows = await this.sql<{ value_encrypted: Buffer }[]>`
            SELECT value_encrypted
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid AND key = ${key}
            LIMIT 1
        `;
        if (rows.length === 0) return null;

        try {
            return decrypt(
                rows[0].value_encrypted,
                masterKey,
                pluginUserCredentialContext(pluginId, userId, key),
            );
        } catch (err) {
            log.warn('getUserRaw: failed to decrypt row', {
                pluginId,
                userId,
                key,
                err: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }

    /**
     * List credential keys present for a specific (plugin_id, user_id).
     * Returns key names only — never decrypts values.
     */
    async listUserKeys(pluginId: string, userId: string): Promise<string[]> {
        const rows = await this.sql<{ key: string }[]>`
            SELECT DISTINCT key
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid
            ORDER BY key
        `;
        return rows.map((r) => r.key);
    }

    /**
     * List userIds that have at least one credential for the given plugin.
     * Useful for cron tasks iterating every linked user.
     */
    async listLinkedUserIds(pluginId: string): Promise<string[]> {
        const rows = await this.sql<{ user_id: string }[]>`
            SELECT DISTINCT user_id
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId}
            ORDER BY user_id
        `;
        return rows.map((r) => r.user_id);
    }

    /**
     * List userIds that have a specific credential key for the given plugin.
     */
    async listUserIdsWithKey(pluginId: string, key: string): Promise<string[]> {
        const rows = await this.sql<{ user_id: string }[]>`
            SELECT DISTINCT user_id
            FROM plugin_user_credentials
            WHERE plugin_id = ${pluginId} AND key = ${key}
            ORDER BY user_id
        `;
        return rows.map((r) => r.user_id);
    }

    // -- Key rotation --------------------------------------------------------

    /**
     * Re-encrypt all plugin_secrets and plugin_user_credentials rows with a
     * new master key, incrementing the encryption_version.
     *
     * Both keys must be supplied explicitly — deriving the "current" key from
     * LUMASTRA_MASTER_KEY would crash the rotation if the operator already
     * promoted the new key into the env. Caller responsibilities:
     *
     *   - oldMasterKey: 32-byte master key currently used to encrypt existing
     *     rows (the value previously in LUMASTRA_MASTER_KEY).
     *   - newMasterKey: the rotation target.
     *   - newVersion: monotonically increasing version label.
     *
     * Rotation is idempotent and resumable: rows that already carry
     * encryption_version >= newVersion are skipped, so re-running after a
     * crash continues where it left off. Per-row UPDATEs avoid long-held
     * locks on large tables.
     *
     * Concurrency: the caller (rotate endpoint) must hold the Valkey lock
     * `lock:secrets:rotate` before calling this method. The lock is managed
     * by the HTTP handler, not here, so this method stays testable without
     * a Valkey dependency.
     *
     * ── OPERATIONAL CONTRACT (read before calling in production) ──────────
     * On success this method updates ONLY the in-process module-level master
     * key cache for the replica that served the request (via
     * `setCachedMasterKey`) — it CANNOT reach other replicas, and it cannot
     * update `LUMASTRA_MASTER_KEY` in this process's own env or any secret
     * store (it only ever holds the derived key `Buffer`, never the raw
     * source string). Every OTHER replica keeps decrypting with the OLD key
     * until it is restarted with the new `LUMASTRA_MASTER_KEY`, at which
     * point every `get()` / `getUser()` call on that replica throws a
     * descriptive "secret decrypt failed" error (not a silent null) until
     * restarted.
     *
     * Required rollout sequence for the operator, in order:
     *   1. Call this rotate flow (re-encrypts all rows; the serving replica
     *      self-heals immediately).
     *   2. Update `LUMASTRA_MASTER_KEY` in the env / secret store for EVERY
     *      replica to the new key.
     *   3. Rolling-restart every OTHER replica so it picks up the new key.
     * Skipping steps 2-3 leaves every non-serving replica permanently unable
     * to decrypt secrets until restarted.
     */
    async rotate(
        oldMasterKey: Buffer,
        newMasterKey: Buffer,
        newVersion: number,
    ): Promise<{
        rotated: number;
        skipped: number;
        legacyUpgraded: number;
        failedRows: Array<{ pluginId: string; key: string }>;
    }> {
        let rotated = 0;
        let skipped = 0;
        let legacyUpgraded = 0;
        const failedRows: Array<{ pluginId: string; key: string }> = [];

        /**
         * The row's value under the new key. A row that already opens under the
         * NEW key was moved by an earlier, partly failed run: the handler asks
         * for a fresh `newVersion` (MAX + 1) on every run, so that row is below
         * it again and the old key cannot open it. Treating it as unreadable
         * made every re-run fail on the rows the first run had already done.
         */
        const reseal = (blob: Buffer, context: string): { newBlob: Buffer; wasLegacy: boolean } => {
            // Read the flag BEFORE the decrypt, credit it only AFTER the write:
            // a row that opens under neither key lands in `failedRows`, and must
            // not also be reported as upgraded.
            const wasLegacy = !isAadBoundBlob(blob);
            try {
                return {
                    newBlob: encrypt(decrypt(blob, oldMasterKey, context), newMasterKey, context),
                    wasLegacy,
                };
            } catch (oldKeyErr) {
                let plain: string;
                try {
                    plain = decrypt(blob, newMasterKey, context);
                } catch {
                    throw oldKeyErr;
                }
                // Already bound under the new key: keep it, only bump the version.
                return wasLegacy
                    ? { newBlob: encrypt(plain, newMasterKey, context), wasLegacy }
                    : { newBlob: blob, wasLegacy: false };
            }
        };

        const secretRows = await this.sql<
            {
                plugin_id: string;
                key: string;
                value_encrypted: Buffer;
                encryption_version: number;
            }[]
        >`
            SELECT plugin_id, key, value_encrypted, encryption_version
            FROM plugin_secrets
            WHERE encryption_version < ${newVersion}
        `;

        for (const row of secretRows) {
            try {
                const context = pluginSecretContext(row.plugin_id, row.key);
                const { newBlob, wasLegacy } = reseal(row.value_encrypted, context);
                await this.sql`
                    UPDATE plugin_secrets
                    SET value_encrypted    = ${newBlob},
                        encryption_version = ${newVersion}
                    WHERE plugin_id = ${row.plugin_id} AND key = ${row.key}
                `;
                rotated++;
                if (wasLegacy) legacyUpgraded++;
            } catch (err) {
                skipped++;
                failedRows.push({ pluginId: row.plugin_id, key: row.key });
                log.warn('rotate: skipping unreadable plugin_secret', {
                    pluginId: row.plugin_id,
                    key: row.key,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        const credRows = await this.sql<
            {
                plugin_id: string;
                user_id: string;
                key: string;
                value_encrypted: Buffer;
                encryption_version: number;
            }[]
        >`
            SELECT plugin_id, user_id, key, value_encrypted, encryption_version
            FROM plugin_user_credentials
            WHERE encryption_version < ${newVersion}
        `;

        for (const row of credRows) {
            try {
                const context = pluginUserCredentialContext(row.plugin_id, row.user_id, row.key);
                // Credited only once the row is actually written.
                const { newBlob, wasLegacy } = reseal(row.value_encrypted, context);
                await this.sql`
                    UPDATE plugin_user_credentials
                    SET value_encrypted    = ${newBlob},
                        encryption_version = ${newVersion}
                    WHERE plugin_id = ${row.plugin_id}
                      AND user_id   = ${row.user_id}::uuid
                      AND key       = ${row.key}
                `;
                rotated++;
                if (wasLegacy) legacyUpgraded++;
            } catch (err) {
                skipped++;
                failedRows.push({ pluginId: row.plugin_id, key: row.key });
                log.warn('rotate: skipping unreadable plugin_user_credential', {
                    pluginId: row.plugin_id,
                    userId: row.user_id,
                    key: row.key,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Post-rotation assertion: verify NO row in plugin_secrets OR
        // plugin_user_credentials remains at the old encryption version.
        // (plugin_user_credentials was previously skipped — operator could
        // promote the new key into env believing rotation succeeded, then
        // discover user creds were never re-encrypted.)
        if (skipped > 0) {
            const remainingSecretsRows = await this.sql<{ count: string }[]>`
                SELECT COUNT(*) AS count FROM plugin_secrets
                WHERE encryption_version < ${newVersion}
            `;
            const remainingUserCredsRows = await this.sql<{ count: string }[]>`
                SELECT COUNT(*) AS count FROM plugin_user_credentials
                WHERE encryption_version < ${newVersion}
            `;
            const remainingSecrets = Number(remainingSecretsRows[0]?.count ?? 0);
            const remainingUserCreds = Number(remainingUserCredsRows[0]?.count ?? 0);
            const remaining = remainingSecrets + remainingUserCreds;
            if (remaining > 0) {
                const err = new Error(
                    `Key rotation incomplete: ${remainingSecrets} plugin_secret row(s) and ` +
                        `${remainingUserCreds} plugin_user_credentials row(s) could not be re-encrypted. ` +
                        `Failed rows: ${failedRows.map((r) => `${r.pluginId}/${r.key}`).join(', ')}`,
                );
                log.warn('key rotation assertion failed', {
                    remainingSecrets,
                    remainingUserCreds,
                    failedRows,
                });
                // Rows this run moved now open only under the new key; without
                // this the serving replica failed every read of them until the
                // re-run (or a restart) completed.
                if (rotated > 0) setCachedMasterKey(newMasterKey);
                throw Object.assign(err, { rotated, skipped, legacyUpgraded, failedRows });
            }
        }

        // Self-heal THIS process immediately: every row this replica just
        // re-encrypted now decrypts with newMasterKey, not the stale cached
        // key. Without this, the replica that served the rotate request
        // would throw a "secret decrypt failed" error on its own very next
        // get()/getUser() call until restarted — see the doc comment above.
        setCachedMasterKey(newMasterKey);

        log.info('key rotation complete', { rotated, skipped, newVersion });
        log.warn(
            'key rotation only updated THIS replica — every other replica still holds the ' +
                'old master key and will fail to decrypt secrets until the operator updates ' +
                'LUMASTRA_MASTER_KEY in the env/secret store and rolling-restarts all other ' +
                'replicas',
            { newVersion },
        );
        return { rotated, skipped, legacyUpgraded, failedRows };
    }

    // -- First-boot env→secrets seeding (§13.5) ------------------------------

    /**
     * Seed known env vars into plugin_secrets on first boot (when the table is
     * empty). The caller supplies the mapping; this module does not hard-code
     * plugin IDs or env var names.
     *
     * Skips silently when:
     * - The table already has rows (idempotent across restarts).
     * - LUMASTRA_MASTER_KEY is not set.
     */
    async seedFromEnv(
        envMappings: Record<string, { pluginId: string; key: string }>,
    ): Promise<{ seeded: number }> {
        if (!resolveMasterKey()) {
            log.warn('LUMASTRA_MASTER_KEY not set — skipping env→secrets seeding');
            return { seeded: 0 };
        }

        const countRows = await this.sql<{ n: string }[]>`
            SELECT COUNT(*) as n FROM plugin_secrets
        `;
        const isEmpty = countRows[0]?.n === '0';
        if (!isEmpty) return { seeded: 0 };

        let seeded = 0;
        for (const [envName, { pluginId, key }] of Object.entries(envMappings)) {
            const value = process.env[envName];
            if (value) {
                await this.set(pluginId, key, value);
                seeded++;
            }
        }
        log.info('env→secrets seeding complete', { seeded });
        return { seeded };
    }

    // -- Version helpers -----------------------------------------------------

    /**
     * Read the current maximum encryption_version from BOTH plugin_secrets
     * and plugin_user_credentials, then return max(both) + 1.
     * Returns 1 when both tables are empty (first write).
     *
     * Reading only plugin_secrets was a silent data-loss vector: a setUser()
     * during/after a rotation that only touched plugin_secrets would write a
     * cred labelled version=1 even though the latest creds were already at
     * version=N. The next rotation would then "skip" the row (it sees
     * encryption_version < newVersion) and the row ends up encrypted with
     * an old key but tagged with a new version.
     */
    async getCurrentMaxVersion(): Promise<number> {
        const rows = await this.sql<{ max_version: number | null }[]>`
            SELECT GREATEST(
                COALESCE((SELECT MAX(encryption_version) FROM plugin_secrets), 0),
                COALESCE((SELECT MAX(encryption_version) FROM plugin_user_credentials), 0)
            ) AS max_version
        `;
        return (rows[0]?.max_version ?? 0) + 1;
    }

    // -- Audit helpers -------------------------------------------------------

    /**
     * Fire-and-forget audit write. Swallows errors but increments the
     * Prometheus counter so dashboards can alert on persistent failures.
     */
    private async auditGet(
        pluginId: string,
        key: string,
        userId: string | undefined,
        runId: string | undefined,
    ): Promise<void> {
        try {
            await this.sql`
                INSERT INTO plugin_secret_access_log (plugin_id, key, user_id, run_id, accessed_at)
                VALUES (${pluginId}, ${key}, ${userId ?? null}::uuid, ${runId ?? null}, NOW())
            `;
            if (userId) {
                await this.sql`
                    UPDATE plugin_user_credentials
                    SET last_accessed_at = NOW()
                    WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid AND key = ${key}
                `;
            } else {
                await this.sql`
                    UPDATE plugin_secrets
                    SET last_accessed_at = NOW()
                    WHERE plugin_id = ${pluginId} AND key = ${key}
                `;
            }
        } catch (err) {
            log.warn('secret audit write failed', {
                pluginId,
                key,
                err: err instanceof Error ? err.message : String(err),
            });
            // Increment the Prometheus counter so dashboards can alert.
            try {
                taskPendingWritePoisonedTotal.inc({ kind: 'insert' });
            } catch {
                // metrics not initialised in tests — ignore
            }
        }
    }
}

// ── Cross-store master-key rotation ───────────────────────────────────────────
//
// security review 2026-09-12, C9: "Rotate Master Key" used to re-seal ONLY
// plugin_secrets and plugin_user_credentials. Every other sealed store — the
// sensitive values in settings.json, Subsonic client tokens, both webhook
// secret columns, Jellyfin client passwords — stayed under the retired key, so
// an admin who rotated and then swapped LUMASTRA_MASTER_KEY silently lost or
// broke them while the old ciphertext still opened with the key they believed
// they had retired.
//
// Every store now exposes a small rotation function next to its own sealing
// code, all returning this shape, all invoked by handleSecretsRotate() under
// the same Valkey lock.

/** Outcome of re-sealing one store from the old master key to the new one. */
export interface StoreRotationResult {
    /** Values now sealed under the new key (including ones already there). */
    rotated: number;
    /** Values that opened under NEITHER key and were left untouched. */
    skipped: number;
    /** Human-readable reasons for the skipped values, for the API response. */
    reasons: string[];
    /**
     * How many of the rotated values were UPGRADED from the old unbound
     * `enc:v1:` form to the row-bound `enc:v2:` one (security review
     * 2026-09-13, C19).
     *
     * Reported rather than merely counted because the upgrade binds a value to
     * whatever row it is sitting in AT THAT MOMENT. If one of those rows was
     * holding a transplanted value, the rotation makes the transplant
     * permanent — so a non-zero count is the operator's cue to have run the
     * security self-check BEFORE rotating, not after. See
     * docs/security/master-key-rotation.md.
     */
    legacyUpgraded: number;
}

/**
 * Re-seal `jellyfin_client_passwords.password_sealed` from `oldMasterKey` to
 * `newMasterKey` (security review 2026-09-12, C9).
 *
 * WHY THIS LIVES IN THE AGPL TREE, not next to its sealing code in
 * `jellyfin-compat/auth.ts`: the rotation handler is core and does
 * not import the /j tree. The TABLE is core schema
 * (base-schema-sql.ts), only the /j auth logic on top of it lives there, so
 * the sweep belongs here. `rotateSealedClientPasswords()` in that module is a
 * pure delegation to this function, kept so the store's own file still names
 * its rotation entry point.
 *
 * Per-row and idempotent: a value that already opens under the NEW key AND is
 * already bound to its row is counted as rotated and left alone, so a re-run
 * after a partial failure completes the job instead of corrupting the rows that
 * did succeed. No transaction is needed for the same reason — there is no
 * half-rotated state a re-run cannot finish.
 *
 * Rotation is also the ENVELOPE upgrade path (security review 2026-09-13, C19):
 * a `v1` envelope — unbound, and therefore transplantable into another user's
 * row — is re-sealed as `v2` bound to this user even when it already opens
 * under the new key.
 */
export async function rotateJellyfinClientPasswords(
    sql: postgres.Sql,
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<StoreRotationResult> {
    const rows = await sql<{ user_id: string; password_sealed: string | null }[]>`
        SELECT user_id::text, password_sealed
        FROM jellyfin_client_passwords
        WHERE password_sealed IS NOT NULL
    `;

    let rotated = 0;
    let skipped = 0;
    let legacyUpgraded = 0;
    const reasons: string[] = [];

    for (const row of rows) {
        const sealed = row.password_sealed;
        // A row with nothing sealed (legacy, pre-16.170.0) has no ciphertext to
        // move — not a failure, nothing to do.
        if (!sealed || !isSealed(sealed)) continue;

        const context = jellyfinClientPasswordContext(row.user_id);

        // Already under the new key AND already bound to this row: a re-run of
        // a partially-failed rotation has nothing left to do here.
        let plain: string | null = null;
        try {
            plain = openSecret(sealed, newMasterKey, context);
            if (isAadBound(sealed)) {
                rotated++;
                continue;
            }
        } catch {
            // Not yet under the new key — fall through to the old-key path.
        }

        try {
            plain ??= openSecret(sealed, oldMasterKey, context);
            await sql`
                UPDATE jellyfin_client_passwords
                SET password_sealed = ${sealSecret(plain, newMasterKey, context)}
                WHERE user_id = ${row.user_id}::uuid
            `;
            if (!isAadBound(sealed)) legacyUpgraded++;
            rotated++;
        } catch (err) {
            skipped++;
            reasons.push(
                `jellyfin_client_passwords user_id=${row.user_id}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            log.warn('rotate: skipping unreadable jellyfin client password', {
                userId: row.user_id,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return { rotated, skipped, reasons, legacyUpgraded };
}
