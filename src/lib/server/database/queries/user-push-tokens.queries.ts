// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * APNs device-token queries.
 *
 * Every read is user-scoped. `getActivePushTokensForUser` is the only resolver
 * the delivery pass uses, and it filters `deactivated_at IS NULL`, so a token
 * reassigned to another user between claim and send is naturally excluded.
 *
 * `user_push_tokens` rows are also mutated from OUTSIDE this module: migration
 * 16.200.0 adds a deferred `AFTER UPDATE` constraint trigger on
 * `oauth_refresh_tokens` (`oauth_refresh_tokens_deactivate_push`) that sets
 * `deactivated_at` / `deactivation_reason = 'session_revoked'` directly,
 * whenever a device's last live session is revoked. If a row here shows
 * `deactivation_reason = 'session_revoked'` with no corresponding call to
 * `deactivatePushTokensForDevice` in the logs, that trigger is why — check
 * `pg_trigger` / the migration file, not this file, for that behavior.
 *
 * @module queries/user-push-tokens
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

/**
 * Advisory-lock namespaces for the two-argument `pg_advisory_xact_lock(int,
 * int)` form. That key space is shared PROCESS-WIDE across every advisory
 * lock in the codebase — the single-argument `hashtext(text)` form used
 * elsewhere hashes the whole key into that same shared space, and a
 * client-controlled key (this module's `token`/`bundleId` are both
 * client-supplied) can be crafted to collide with an unrelated lock site in
 * well under a second, which would make two logically-unrelated locks
 * exclude each other. The two-argument form partitions the space by a fixed
 * namespace int chosen to collide with no other `pg_advisory*` call in this
 * repo (checked by grepping every `pg_advisory` site in `src/` and
 * `plugins/` — the namespaces already in use are `migration-system.ts`'s
 * `4242`, `media-segment-resolution-lock.ts`'s `0x5e66`/`0x5e67`,
 * `metadata-sync-single.service.ts`'s `0x53455253`, and
 * `plugins/shoutbox/lib/rate-limit-lock.js`'s `823_417_001`/`823_417_002` —
 * none of which these two collide with), following
 * `plugins/shoutbox/lib/rate-limit-lock.js:~100`. Only `hashtext()`'s output
 * (still client-influenced) shares a namespace with a peer registration for
 * the SAME real key, which is the intended exclusion.
 */
const PUSH_TOKEN_DEVICE_LOCK_NS = 741_902_101;
const PUSH_TOKEN_OWNER_LOCK_NS = 741_902_102;

export type PushEnvironment = 'sandbox' | 'production';

export interface UserPushTokenRow {
    id: string;
    user_id: string;
    device_id: string;
    token: string;
    bundle_id: string;
    environment: PushEnvironment;
    locale: string | null;
    payload_version: number;
    created_at: Date;
    last_seen_at: Date;
    deactivated_at: Date | null;
    deactivation_reason: string | null;
}

export interface UpsertPushTokenParams {
    userId: UserId;
    /** `user_devices.id`, already resolved from the device session. */
    deviceId: string;
    token: string;
    bundleId: string;
    environment: PushEnvironment;
    /** Client app effective locale (BCP-47). Null when the client sends none. */
    locale: string | null;
    payloadVersion: number;
}

export interface UpsertPushTokenResult extends UserPushTokenRow {
    /**
     * The `user_id` that held this token's row before this call, or `null`
     * when no row existed yet for the `(token, bundle_id, environment)`
     * triple (a genuine first registration). `null` also when the row was
     * already owned by `params.userId` — the caller re-registered its own
     * token, which is not a rebind.
     */
    previousUserId: string | null;
    /**
     * Whether that previous row was still active (`deactivated_at IS NULL`)
     * at the moment of the read. `false` when there was no previous row.
     */
    previousWasActive: boolean;
}

/**
 * Register or refresh a token.
 *
 * On conflict of the unique triple this reassigns ownership AND revives the row
 * — but only when the caller's device still has a live session (see below): a
 * token that 410'd under a previous owner must come back to life for the new
 * one, or a handed-over device stays permanently silent.
 *
 * ## Why the revival is conditional
 *
 * Migration 16.200.0 deactivates a device's push tokens the moment its last
 * live refresh token is revoked. An access token outlives that revocation by up
 * to `JWT_ACCESS_TOKEN_TTL_SECONDS` (an hour by default), and iOS re-registers
 * its APNs token on every launch — so a `PUT /push-token` racing a sign-out or
 * an admin revoke arrives holding a still-valid bearer for a session that no
 * longer exists. An unconditional `deactivated_at = NULL` would then PERMANENTLY
 * undo the revocation: nothing fires the trigger a second time, so the token
 * stays active and the signed-out account keeps receiving banners and badge
 * counts forever.
 *
 * The live-session check runs inside the same transaction and behind the same
 * advisory lock as the insert, so it cannot interleave with a concurrent
 * registration for this device. It cannot exclude a revocation committing in
 * the instant after it reads — but that ordering is the harmless one: the
 * revocation's own trigger fires at ITS commit, after ours, and deactivates the
 * row we just wrote.
 *
 * Sibling rows for the same device+bundle+environment are deactivated as
 * `'rotated'`, because APNs rotates tokens on restore and reinstall and the
 * stale row would otherwise stay active until Apple eventually 410s it —
 * double-pushing every notification in the meantime.
 *
 * Concurrent-safe: takes `pg_advisory_xact_lock(<namespace>, hashtext(...))`
 * keyed on `(device_id, bundle_id, environment)` before the INSERT — a
 * two-argument, namespaced form (see `PUSH_TOKEN_DEVICE_LOCK_NS` above),
 * following the same pattern as `attachFileToItem` in media-files.queries.ts
 * for the lock-before-INSERT shape and `plugins/shoutbox/lib/
 * rate-limit-lock.js` for the namespacing. Without this lock, two concurrent
 * registrations for the same device with two DIFFERENT new token strings
 * don't conflict on the unique triple — each INSERTs its own row, and each
 * sibling-deactivation UPDATE only sees rows already committed. If both
 * INSERTs land before either commits, neither deactivates the other and the
 * device ends up with two active tokens — exactly the double-push the
 * rotation logic exists to prevent, just via the concurrent-registration path
 * instead of the reassignment path.
 *
 * ## Reporting the previous owner (security review 6, C4)
 *
 * `RETURNING *` on an `ON CONFLICT DO UPDATE` only ever exposes the NEW row —
 * `EXCLUDED`/post-update values — so the prior owner cannot be read off that
 * one statement on PostgreSQL 17 (this project's floor, per the README). PG18
 * adds `RETURNING old.user_id`/`old.deactivated_at`, which DOES expose the
 * pre-update row atomically from the same statement and could replace this
 * whole second lock once the floor rises — worth revisiting then.
 *
 * Until then: a SECOND advisory lock, keyed on the unique triple `(token,
 * bundle_id, environment)` itself (its own namespace,
 * `PUSH_TOKEN_OWNER_LOCK_NS`, distinct from the device-scoped lock above), is
 * taken before a plain `SELECT` of the current row. Holding that lock for the
 * rest of the transaction fully serializes every registration of this SAME
 * token — including a first-time INSERT racing another first-time INSERT of
 * the identical brand-new token — so by the time this call's `SELECT` runs,
 * any earlier committed writer for this token is already visible. A
 * `SELECT ... FOR UPDATE` alone would NOT be enough: for a token with no
 * existing row, there is nothing to lock, so two concurrent first
 * registrations could both read "no previous row" and then race the
 * `INSERT ... ON CONFLICT`, whose internal retry re-evaluates the UPDATE
 * against the now-committed row WITHOUT re-running a sibling read. The
 * advisory lock closes that gap by serializing entry into the whole function,
 * not just the row. Measured directly against a scratch trigger recording
 * every real owner change: with the lock, 30 concurrent registrations of one
 * brand-new token and a mixed 8-token/200-call burst both matched the
 * trigger's ground truth exactly, every round; deleting the lock dropped
 * accuracy to ~28/29 and ~29/197 respectively (security review 6, C4 fix
 * round 1) — see the `serializes ... owner reporting` tests below.
 *
 * The two advisory locks use DIFFERENT namespaces (`PUSH_TOKEN_DEVICE_LOCK_NS`
 * / `PUSH_TOKEN_OWNER_LOCK_NS`) and are always acquired in the same order
 * (device-scoped first, then token-scoped) by every call, so — bar a
 * `hashtext()` collision between two keys that already share one call's
 * namespace, an accepted, tiny risk the namespacing does nothing to change —
 * they cannot deadlock against each other or against an unrelated lock site.
 */
export async function upsertPushToken(
    sql: postgres.Sql,
    params: UpsertPushTokenParams,
): Promise<UpsertPushTokenResult> {
    return await sql.begin(async (tx) => {
        const lockKey = `push-token:${params.deviceId}:${params.bundleId}:${params.environment}`;
        await tx`SELECT pg_advisory_xact_lock(${PUSH_TOKEN_DEVICE_LOCK_NS}::int, hashtext(${lockKey})::int)`;

        const ownerLockKey = `push-token-owner:${params.token}:${params.bundleId}:${params.environment}`;
        await tx`SELECT pg_advisory_xact_lock(${PUSH_TOKEN_OWNER_LOCK_NS}::int, hashtext(${ownerLockKey})::int)`;

        const [previous] = await tx<{ user_id: string; deactivated_at: Date | null }[]>`
            SELECT user_id, deactivated_at
            FROM user_push_tokens
            WHERE token       = ${params.token}
              AND bundle_id   = ${params.bundleId}
              AND environment = ${params.environment}
        `;
        const previousUserId =
            previous && previous.user_id !== params.userId ? previous.user_id : null;
        const previousWasActive = previous ? previous.deactivated_at === null : false;

        // Does the registering device still hold a live session? Predicate kept
        // byte-for-byte in step with migration 16.200.0's trigger — if the two
        // ever disagree, one of them is deciding "revoked" differently from the
        // other and a token oscillates between live and dead.
        const [{ live }] = await tx<{ live: boolean }[]>`
            SELECT EXISTS (
                SELECT 1
                FROM user_devices ud
                JOIN oauth_refresh_tokens rt
                  ON rt.user_id = ud.user_id AND rt.device_id = ud.device_id
                WHERE ud.id      = ${params.deviceId}
                  AND ud.user_id = ${params.userId}
                  AND rt.revoked_at IS NULL
                  AND rt.expires_at > NOW()
            ) AS live
        `;

        const [row] = await tx<UserPushTokenRow[]>`
            INSERT INTO user_push_tokens (
                user_id, device_id, token, bundle_id, environment, locale, payload_version
            ) VALUES (
                ${params.userId}, ${params.deviceId}, ${params.token},
                ${params.bundleId}, ${params.environment}, ${params.locale},
                ${params.payloadVersion}
            )
            ON CONFLICT ON CONSTRAINT user_push_tokens_token_uniq DO UPDATE
            SET user_id             = EXCLUDED.user_id,
                device_id           = EXCLUDED.device_id,
                locale              = EXCLUDED.locale,
                payload_version     = EXCLUDED.payload_version,
                last_seen_at        = NOW(),
                -- Revive, EXCEPT when this would undo a session revocation for a
                -- device that still has no live session. Scoped to
                -- 'session_revoked' — the marker only 16.200.0's trigger and
                -- deactivatePushTokensForDevice write — so every other reason
                -- ('gone', 'unregistered', 'rotated', 'user', 'invalid') keeps
                -- reviving unconditionally, which is what makes a handed-over
                -- device work.
                deactivated_at      = CASE
                    WHEN user_push_tokens.deactivation_reason = 'session_revoked'
                     AND NOT ${live}
                    THEN user_push_tokens.deactivated_at
                    ELSE NULL
                END,
                deactivation_reason = CASE
                    WHEN user_push_tokens.deactivation_reason = 'session_revoked'
                     AND NOT ${live}
                    THEN user_push_tokens.deactivation_reason
                    ELSE NULL
                END
            RETURNING *
        `;
        await tx`
            UPDATE user_push_tokens
            SET deactivated_at = NOW(), deactivation_reason = 'rotated'
            WHERE device_id      = ${params.deviceId}
              AND bundle_id      = ${params.bundleId}
              AND environment    = ${params.environment}
              AND id            <> ${row.id}
              AND deactivated_at IS NULL
        `;
        return { ...row, previousUserId, previousWasActive };
    });
}

/** Hard-delete every token for one of the caller's devices. The user's opt-out. */
export async function deletePushTokenForDevice(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
): Promise<number> {
    const rows = await sql`
        DELETE FROM user_push_tokens
        WHERE user_id = ${userId} AND device_id = ${deviceId}
        RETURNING id
    `;
    return rows.length;
}

/** Active tokens for a user, for the delivery pass to fan out over. */
export async function getActivePushTokensForUser(
    sql: postgres.Sql,
    userId: UserId,
): Promise<UserPushTokenRow[]> {
    return await sql<UserPushTokenRow[]>`
        SELECT * FROM user_push_tokens
        WHERE user_id = ${userId} AND deactivated_at IS NULL
        ORDER BY last_seen_at DESC
    `;
}

/** Enqueue-time gate: skip writing a row for a user with nowhere to send it. */
export async function userHasActivePushToken(sql: postgres.Sql, userId: UserId): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM user_push_tokens
        WHERE user_id = ${userId} AND deactivated_at IS NULL
        LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Apple told us this token is dead.
 *
 * `userId` is REQUIRED and is not decoration. The unique triple
 * `(token, bundle_id, environment)` is unique across the whole table, not per
 * user, so an unscoped UPDATE here can retire any row in the system given only
 * a token string. The one caller is the delivery pass, applying results that
 * arrived over the network from the relay — so without this scope a buggy or
 * hostile relay could name a stranger's token in its response and silence that
 * stranger's device. Pass the outbox row's `user_id`, never a value derived
 * from the response.
 *
 * A scoped no-match is not an error: the token may have been reassigned to
 * another user between send and result (the accepted race in spec A7), in
 * which case leaving the new owner's row alone is exactly right.
 */
export async function deactivatePushToken(
    sql: postgres.Sql,
    token: string,
    bundleId: string,
    environment: string,
    reason: string,
    userId: UserId,
): Promise<void> {
    await sql`
        UPDATE user_push_tokens
        SET deactivated_at = NOW(), deactivation_reason = ${reason}
        WHERE token = ${token} AND bundle_id = ${bundleId} AND environment = ${environment}
          AND user_id = ${userId}
          AND deactivated_at IS NULL
    `;
}

/** Session revocation / sign-out. Deactivates rather than deletes, for audit. */
export async function deactivatePushTokensForDevice(
    sql: postgres.Sql,
    userId: UserId,
    deviceId: string,
    reason: string,
): Promise<number> {
    const rows = await sql`
        UPDATE user_push_tokens
        SET deactivated_at = NOW(), deactivation_reason = ${reason}
        WHERE user_id = ${userId} AND device_id = ${deviceId} AND deactivated_at IS NULL
        RETURNING id
    `;
    return rows.length;
}
