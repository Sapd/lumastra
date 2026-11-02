// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * secrets-rotate.handler.ts — shared request handler for master-key rotation.
 *
 * Mounted at two surfaces:
 *   POST /api/v1/admin/secrets/rotate  (token surface, v1)
 *   POST /api/admin/secrets/rotate     (internal cookie/forward-auth surface)
 *
 * authenticate() validates a Bearer token (PAT/svc) on the v1 surface and, on
 * the internal /api/* surface, falls back to the logged-in admin's
 * cookie/forward-auth identity (internalAdminAuth) — so this shared handler
 * works correctly on both surfaces without additional wrapping.
 *
 * COVERAGE (security review 2026-09-12, C9): this endpoint re-seals EVERY
 * store keyed by LUMASTRA_MASTER_KEY, under one Valkey lock, in one request:
 *
 *   plugin_secrets + plugin_user_credentials   PluginSecrets.rotate()
 *   settings.json sensitive values             rotateConfigSecrets()
 *   subsonic_client_passwords (+ blind index)  rotateSubsonicTokens()
 *   task_webhook_hooks.secret_encrypted        rotateWebhookSecrets()
 *   user_notification_webhooks.secret_encrypted  ”
 *   jellyfin_client_passwords.password_sealed  rotateJellyfinClientPasswords()
 *   livetv_sources xtream username/password    rotateLiveTvCredentials()
 *
 * It previously rotated only the two plugin tables while the UI promised "all
 * secrets", so an operator who rotated and then swapped LUMASTRA_MASTER_KEY
 * silently dropped their config secrets, locked every Subsonic user out and
 * broke every webhook delivery — while the old ciphertext still opened with
 * the key they believed they had retired.
 *
 * Every store rotation is per-row and idempotent (a value already under the
 * new key AND already bound to its row is left alone), so a store that fails
 * half-way is finished by re-running this endpoint rather than left in a state
 * only a restore can fix. Anything that could NOT be moved comes back in
 * `notRotated`.
 *
 * Rotation is also the upgrade path for the row-bound `enc:v2:` envelope
 * (security review 2026-09-13, C19), and the response reports what it upgraded
 * per store in `legacyUpgraded` — because that upgrade binds each value to
 * whatever row it is sitting in at that moment.
 *
 * NOT rotated, by nature: two values are DERIVED from the master key and never
 * stored, so there is no ciphertext to move — JWT_SECRET (when unset:
 * `deriveSubSecret(masterKey, 'lumastra-jwt-secret-v1')`) and the Jellyfin
 * server id. Both simply CHANGE when the key does, invalidating issued JWTs and
 * forcing paired /j clients to re-pair. See
 * docs/security/master-key-rotation.md for the operator consequences.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { problem } from '$lib/server/api/problem.js';
import { authenticate, requireScope } from '$lib/server/tasks/api-auth.js';
import { getDb } from '$lib/server/database/connection.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { PluginSecrets, deriveMasterKey } from '$lib/server/tasks/secrets.js';
import type { StoreRotationResult } from '$lib/server/tasks/secrets.js';
import { RotateSecretsSchema } from '$lib/schemas/api-v1.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor, type AuditActor } from '$lib/server/utils/audit-log.js';

const log = Logger.for('api.admin.secrets.rotate');

const ROTATE_LOCK_KEY = 'lock:secrets:rotate';
const ROTATE_LOCK_TTL_S = 600;

/** Store label for the two plugin tables, which rotate together. */
const PLUGIN_STORE = 'plugin_secrets + plugin_user_credentials';

export async function handleSecretsRotate(event: RequestEvent): Promise<Response> {
    const auth = await authenticate(event);
    requireScope(auth, 'tasks:admin');

    let body: unknown;
    try {
        body = await readBoundedJson(event.request);
    } catch {
        return problem('validation_failed', { error: 'Invalid JSON body' });
    }

    const parsed = RotateSecretsSchema.safeParse(body);
    if (!parsed.success) {
        return problem('validation_failed', {
            error: `Invalid request body: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        });
    }

    const { oldMasterKey, newMasterKey } = parsed.data;

    let oldKeyBuffer: Buffer;
    let newKeyBuffer: Buffer;
    try {
        oldKeyBuffer = deriveMasterKey(oldMasterKey);
    } catch (err) {
        return problem('validation_failed', {
            error: `Invalid oldMasterKey: ${err instanceof Error ? err.message : String(err)}`,
        });
    }
    try {
        newKeyBuffer = deriveMasterKey(newMasterKey);
    } catch (err) {
        return problem('validation_failed', {
            error: `Invalid newMasterKey: ${err instanceof Error ? err.message : String(err)}`,
        });
    }

    const sql = getDb();
    if (!sql) {
        return problem('dependency_unavailable', { error: 'database unavailable' });
    }

    // Acquire Valkey rotation lock — prevents concurrent rotation races.
    // If Valkey is unreachable we MUST refuse: previously we fell through
    // to "lockAcquired=true" which allowed two simultaneous rotations with
    // different new keys to split-brain the ciphertext space.
    const valkeyClient = getCoordinationClient();
    if (!valkeyClient) {
        return problem('dependency_unavailable', {
            error: 'Rotation lock unavailable: Valkey not configured. Rotation refused for safety.',
        });
    }
    // A token of our own, not the user id: release must only ever delete THIS
    // run's lock. A run that outlived the TTL used to delete the lock a second
    // rotation had since taken.
    const lockToken = `${auth.userId}:${randomUUID()}`;
    const releaseLock = async (): Promise<void> => {
        try {
            await valkeyClient.customCommand([
                'EVAL',
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                '1',
                ROTATE_LOCK_KEY,
                lockToken,
            ]);
        } catch (err) {
            log.warn('rotate: failed to release Valkey lock', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
    };
    let lockAcquired: boolean;
    try {
        const result = await valkeyClient.customCommand([
            'SET',
            ROTATE_LOCK_KEY,
            lockToken,
            'NX',
            'EX',
            String(ROTATE_LOCK_TTL_S),
        ]);
        lockAcquired = result === 'OK';
    } catch (err) {
        log.warn('rotate: failed to acquire Valkey lock — refusing for safety', {
            err: err instanceof Error ? err.message : String(err),
        });
        return problem('dependency_unavailable', {
            error: 'Rotation lock acquisition failed. Rotation refused for safety.',
        });
    }
    if (!lockAcquired) {
        return problem('conflict', {
            error: 'Another rotation is already in progress. Try again in a few minutes.',
        });
    }

    // Determine the new encryption version. MUST go through
    // getCurrentMaxVersion(), which reads BOTH plugin_secrets AND
    // plugin_user_credentials. Deriving it from plugin_secrets alone lets a
    // user credential written at a higher version sit at exactly
    // MAX(plugin_secrets)+1, which then equals newVersion and is excluded by
    // both the re-encrypt sweep AND the post-rotation assertion.
    const pluginSecrets = new PluginSecrets(sql);
    let newVersion: number;
    try {
        newVersion = await pluginSecrets.getCurrentMaxVersion();
    } catch (err) {
        // Before the main try below: release here, or a DB blip held the lock
        // for the full TTL.
        await releaseLock();
        throw err;
    }

    log.warn('master key rotation initiated', {
        initiatedBy: auth.userId,
        tokenKind: auth.tokenKind,
        newVersion,
    });

    let rotated = 0;
    let skipped = 0;
    let failedRows: Array<{ pluginId: string; key: string }>;
    // Stores that could not be moved (wholly, or row-by-row), with the reason.
    const notRotated: Array<{ store: string; reason: string }> = [];
    /**
     * Per store, how many values this run UPGRADED from the old unbound
     * `enc:v1:` envelope to the row-bound `enc:v2:` one (security review
     * 2026-09-13, C19).
     *
     * The operator has to see this, because the upgrade binds each value to
     * whatever row it is sitting in AT THAT MOMENT: if a row was holding a
     * value transplanted from another row, this run just made that transplant
     * permanent and legitimate-looking. A non-zero count means the security
     * self-check should have been clean BEFORE the rotation ran — see
     * docs/security/master-key-rotation.md.
     */
    const legacyUpgraded: Record<string, number> = {};

    /** Run one store's rotation, folding its counts and reasons into the total. */
    const runStore = async (
        store: string,
        fn: () => Promise<StoreRotationResult>,
    ): Promise<void> => {
        try {
            const result = await fn();
            rotated += result.rotated;
            skipped += result.skipped;
            if (result.legacyUpgraded > 0) legacyUpgraded[store] = result.legacyUpgraded;
            for (const reason of result.reasons) notRotated.push({ store, reason });
        } catch (err) {
            notRotated.push({
                store,
                reason: err instanceof Error ? err.message : String(err),
            });
            log.warn('rotate: store rotation failed', {
                store,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    };

    try {
        // 1. Plugin tables — the original scope. rotate() THROWS (with the
        //    counts attached) when its post-rotation assertion finds rows still
        //    at the old version; keep those numbers instead of losing them.
        try {
            const result = await pluginSecrets.rotate(oldKeyBuffer, newKeyBuffer, newVersion);
            rotated += result.rotated;
            skipped += result.skipped;
            if (result.legacyUpgraded > 0) legacyUpgraded[PLUGIN_STORE] = result.legacyUpgraded;
            failedRows = result.failedRows;
        } catch (err) {
            const partial = err as Partial<{
                rotated: number;
                skipped: number;
                legacyUpgraded: number;
                failedRows: Array<{ pluginId: string; key: string }>;
            }>;
            rotated += partial.rotated ?? 0;
            skipped += partial.skipped ?? 0;
            if (partial.legacyUpgraded) legacyUpgraded[PLUGIN_STORE] = partial.legacyUpgraded;
            failedRows = partial.failedRows ?? [];
            notRotated.push({
                store: PLUGIN_STORE,
                reason: err instanceof Error ? err.message : String(err),
            });
        }

        // 2. Every other store keyed by the master key.
        //
        // Imported LAZILY, on purpose. Rotation is a once-a-year admin action,
        // and the sealing modules drag in the Subsonic auth graph, the webhook
        // delivery worker and the config service — none of which this handler
        // needs to be reachable. Loading them here also means a store whose
        // MODULE fails to load is reported in `notRotated` like any other
        // failure, instead of taking the whole rotation down with it.
        await runStore('settings.json', async () => {
            const { rotateConfigSecrets } = await import('$lib/server/config/config.service.js');
            return rotateConfigSecrets(oldKeyBuffer, newKeyBuffer);
        });
        await runStore('subsonic_client_passwords', async () => {
            const { rotateSubsonicTokens } = await import('$lib/server/subsonic-compat/auth.js');
            return rotateSubsonicTokens(sql, oldKeyBuffer, newKeyBuffer);
        });
        await runStore('task_webhook_hooks + user_notification_webhooks', async () => {
            const { rotateWebhookSecrets } = await import('$lib/server/tasks/webhook-outbox.js');
            return rotateWebhookSecrets(sql, oldKeyBuffer, newKeyBuffer);
        });
        await runStore('jellyfin_client_passwords', async () => {
            const { rotateJellyfinClientPasswords } = await import('$lib/server/tasks/secrets.js');
            return rotateJellyfinClientPasswords(sql, oldKeyBuffer, newKeyBuffer);
        });
        await runStore('livetv_sources', async () => {
            const { rotateLiveTvCredentials } =
                await import('$lib/server/database/queries/livetv-sources.queries.js');
            return rotateLiveTvCredentials(sql, oldKeyBuffer, newKeyBuffer);
        });
    } finally {
        // Always release the rotation lock.
        await releaseLock();
    }

    const legacyUpgradedTotal = Object.values(legacyUpgraded).reduce((a, b) => a + b, 0);

    log.warn('master key rotation complete', {
        initiatedBy: auth.userId,
        rotated,
        skipped,
        newVersion,
        failedRows: failedRows.length,
        notRotated: notRotated.length,
        legacyUpgraded: legacyUpgradedTotal,
    });
    // Prefer the request's resolved Principal (mount.ts's outer gate / forward-
    // auth materialize `event.locals.principal` on both the v1 Bearer surface
    // and the internal cookie surface — see auditActor()'s doc). Fall back to
    // building the actor from `auth` only when no Principal exists: `auth.userId`
    // is the username for a PAT, but for a service token `authenticate()` sets
    // it to `validated.actAsUser ?? 'service:' + validated.id` (a raw UUID or a
    // synthetic string) — group A's `auth.identity.username` resolves the real
    // one, so prefer it (security review 2026-09-13, R5).
    const eventActor = auditActor(event);
    const actor: AuditActor =
        eventActor.username !== null
            ? eventActor
            : {
                  username: auth.identity?.username ?? auth.userId,
                  kind: auth.tokenKind === 'svc' ? 'service_token' : 'pat',
                  credentialId: auth.tokenId,
              };
    auditLog('secret.rotate', '*', actor, {
        rotated,
        skipped,
        newVersion,
        notRotated: notRotated.map((n) => n.store),
        legacyUpgraded,
    });

    // A value that could not be re-sealed is the one thing an operator MUST see
    // before swapping LUMASTRA_MASTER_KEY, so say so in the body rather than
    // only in the logs. The 207 threshold stays `skipped > 0` (unchanged
    // semantics: rows that exist and could not be re-encrypted); a store that
    // reported nothing to move still lists its reason in `notRotated`.
    const warning =
        skipped > 0
            ? `${skipped} value(s) could not be re-encrypted and were skipped. Manual intervention required.`
            : notRotated.length > 0
              ? `${notRotated.length} store(s) were not rotated. Do NOT swap LUMASTRA_MASTER_KEY until they are.`
              : undefined;

    return json(
        {
            rotated,
            skipped,
            newVersion,
            failedRows: skipped > 0 ? failedRows : [],
            notRotated,
            legacyUpgraded,
            ...(warning ? { warning } : {}),
        },
        { status: skipped > 0 ? 207 : 200 },
    );
}
