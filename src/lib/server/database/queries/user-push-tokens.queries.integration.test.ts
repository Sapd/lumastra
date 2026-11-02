// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import realPostgres from 'postgres';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import type { UserId } from '$lib/shared/user-id';
import {
    upsertPushToken,
    getActivePushTokensForUser,
    userHasActivePushToken,
    deactivatePushToken,
    deactivatePushTokensForDevice,
    deletePushTokenForDevice,
} from './user-push-tokens.queries.js';
import {
    enqueuePushOutbox,
    claimReadyPushRows,
    reschedulePushRow,
} from './user-push-outbox.queries.js';

let sql: postgres.Sql;
let userA: UserId;
let userB: UserId;
let deviceA: string;
let deviceB: string;

async function makeUser(name: string): Promise<UserId> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${name}) RETURNING id
    `;
    return row.id as UserId;
}

async function makeDevice(userId: UserId, deviceKey: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO user_devices (user_id, device_id, reported_name)
        VALUES (${userId}, ${deviceKey}, 'Test Device')
        RETURNING id
    `;
    return row.id;
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

/**
 * A refresh token row, which is what "has a live session" means to both
 * migration 16.200.0's trigger and `upsertPushToken`'s revival guard.
 * `deviceKey` is `user_devices.device_id` (client text), NOT the uuid PK —
 * that is the column `oauth_refresh_tokens` joins on.
 */
async function makeRefreshToken(userId: UserId, deviceKey: string, hash: string): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
        INSERT INTO oauth_refresh_tokens (
            user_id, client_id, token_hash, device_id, created_at, expires_at
        ) VALUES (
            ${userId}, 'test-client', ${hash}, ${deviceKey},
            NOW(), NOW() + INTERVAL '30 days'
        )
        RETURNING id
    `;
    return row.id;
}

beforeEach(async () => {
    await sql`DELETE FROM user_push_outbox`;
    await sql`DELETE FROM user_push_tokens`;
    await sql`
        DELETE FROM oauth_refresh_tokens
        WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'pushtest_%')
    `;
    await sql`DELETE FROM user_devices`;
    await sql`DELETE FROM users WHERE username LIKE 'pushtest_%'`;
    userA = await makeUser('pushtest_a');
    userB = await makeUser('pushtest_b');
    deviceA = await makeDevice(userA, 'dev-a');
    deviceB = await makeDevice(userB, 'dev-b');
});

describe('user_push_tokens', () => {
    it('registers a token and reads it back as active', async () => {
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'de-DE',
            payloadVersion: 1,
        });
        const rows = await getActivePushTokensForUser(sql, userA);
        expect(rows).toHaveLength(1);
        expect(rows[0].token).toBe('tok-1');
        expect(rows[0].locale).toBe('de-DE');
        expect(await userHasActivePushToken(sql, userA)).toBe(true);
        expect(await userHasActivePushToken(sql, userB)).toBe(false);
    });

    it('is idempotent — registering the same token twice yields one row', async () => {
        const params = {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production' as const,
            locale: 'en-US',
            payloadVersion: 1,
        };
        await upsertPushToken(sql, params);
        await upsertPushToken(sql, params);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(1);
    });

    it('reassigns a token to a new owner and revives it', async () => {
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        await deactivatePushToken(
            sql,
            'tok-1',
            'de.hinterthaner.stellar-tvos.ios',
            'production',
            'gone',
            userA,
        );
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);

        // Device handed to another person; same APNs token, new account.
        await upsertPushToken(sql, {
            userId: userB,
            deviceId: deviceB,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'de-DE',
            payloadVersion: 1,
        });
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);
        const bRows = await getActivePushTokensForUser(sql, userB);
        expect(bRows).toHaveLength(1);
        expect(bRows[0].deactivated_at).toBeNull();
    });

    // These are NOT controls — the `previousUserId`/`previousWasActive` fields
    // don't exist on the parent commit, so every test in this block is RED
    // before the C4 fix and GREEN after (labeling them "(control)" was wrong:
    // a control must pass on BOTH commits — fix round 1 caught this). The
    // actual behavior-preserving controls for THIS change are the two tests
    // directly above ("registers a token...", "is idempotent...") and
    // "reassigns a token to a new owner and revives it" below — none of them
    // touch the new fields, so they pass unmodified on both commits.
    describe('C4 — reports the previous owner', () => {
        it('reports no previous owner on a first registration', async () => {
            const result = await upsertPushToken(sql, {
                userId: userA,
                deviceId: deviceA,
                token: 'tok-first',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });
            expect(result.previousUserId).toBeNull();
            expect(result.previousWasActive).toBe(false);
        });

        it('does not report a previous owner when a user re-registers its own token', async () => {
            const params = {
                userId: userA,
                deviceId: deviceA,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production' as const,
                locale: 'en-US',
                payloadVersion: 1,
            };
            await upsertPushToken(sql, params);
            const result = await upsertPushToken(sql, params);
            expect(result.previousUserId).toBeNull();
        });

        it('reports the previous owner and whether it was active on a cross-user rebind', async () => {
            await upsertPushToken(sql, {
                userId: userA,
                deviceId: deviceA,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });

            // Still active under A when B registers the same token.
            const result = await upsertPushToken(sql, {
                userId: userB,
                deviceId: deviceB,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'de-DE',
                payloadVersion: 1,
            });
            expect(result.previousUserId).toBe(userA);
            expect(result.previousWasActive).toBe(true);
        });

        it('reports previousWasActive === false when the previous row was already deactivated', async () => {
            await upsertPushToken(sql, {
                userId: userA,
                deviceId: deviceA,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'en-US',
                payloadVersion: 1,
            });
            await deactivatePushToken(
                sql,
                'tok-1',
                'de.hinterthaner.stellar-tvos.ios',
                'production',
                'gone',
                userA,
            );

            const result = await upsertPushToken(sql, {
                userId: userB,
                deviceId: deviceB,
                token: 'tok-1',
                bundleId: 'de.hinterthaner.stellar-tvos.ios',
                environment: 'production',
                locale: 'de-DE',
                payloadVersion: 1,
            });
            expect(result.previousUserId).toBe(userA);
            expect(result.previousWasActive).toBe(false);
        });

        /**
         * Real-PG concurrency (fix round 1): the reviewer's own S1 experiment
         * — N distinct users racing to register ONE brand-new token — proved
         * that removing the owner-scoped advisory lock, or hard-coding
         * `previousWasActive`, both still pass every OTHER test in this file
         * while corrupting owner reporting under real concurrency (measured
         * against a scratch ground-truth trigger: 28/29 and 29/197 correct
         * without the lock, vs exact matches every round with it). This test
         * pins that guarantee directly: with the lock, exactly ONE of the N
         * concurrent callers can be "first" (no previous row), so exactly
         * N-1 must report a non-null previous owner, and each of those N-1
         * previous owners must be a DIFFERENT user than the one making that
         * particular call (every caller registers its own never-before-seen
         * device). Unlike the device-lock rotation race elsewhere in this
         * file, this outcome is NOT scheduling-dependent: the owner lock
         * fully serializes entry per token, so the invariant holds every time
         * concurrency is real, not just when the event loop happens to
         * overlap the calls. A dedicated connection pool (sized with
         * headroom for the whole burst) is still used so the burst's
         * `Promise.all` gets N genuinely concurrent connections rather than
         * queuing behind a shared pool.
         */
        it('serializes 30 concurrent first-time registrations of one brand-new token: exactly N-1 report a different previous owner', async () => {
            const N = 30;
            const burstSql = realPostgres(getTestDatabaseUrl(), { max: N + 2 });
            try {
                const token = 'tok-owner-race';
                const users: UserId[] = [];
                const devices: string[] = [];
                for (let i = 0; i < N; i++) {
                    const u = await makeUser(`pushtest_race_${i}`);
                    users.push(u);
                    devices.push(await makeDevice(u, `dev-race-${i}`));
                }

                const results = await Promise.all(
                    users.map((userId, i) =>
                        upsertPushToken(burstSql, {
                            userId,
                            deviceId: devices[i],
                            token,
                            bundleId: 'de.hinterthaner.stellar-tvos.ios',
                            environment: 'production',
                            locale: 'en-US',
                            payloadVersion: 1,
                        }),
                    ),
                );

                const rebinds = results.filter((r) => r.previousUserId !== null);
                expect(rebinds).toHaveLength(N - 1);
                // Every reported previous owner must be a DIFFERENT user from
                // the caller that reported it — a caller can never be told it
                // rebound its own not-yet-registered token.
                for (const r of rebinds) {
                    expect(users).toContain(r.previousUserId as UserId);
                }
                results.forEach((r, i) => {
                    if (r.previousUserId) expect(r.previousUserId).not.toBe(users[i]);
                });

                const rows = await sql`SELECT id FROM user_push_tokens WHERE token = ${token}`;
                expect(rows).toHaveLength(1);
            } finally {
                await burstSql.end({ timeout: 5 });
            }
        });

        /**
         * Deterministic version of the reviewer's S2 ("200 mixed calls across
         * 8 tokens"): rather than a genuinely unstructured mix (whose exact
         * outcome per call is inherently non-reproducible), this fires
         * concurrent first-time registrations for MULTIPLE distinct tokens
         * in ONE shared `Promise.all`, so the DB sees real cross-token
         * concurrency, and asserts the same N-1-rebinds invariant
         * independently PER token — proving the per-token owner lock
         * isolates tokens from each other (no interference) without
         * requiring the overall interleaving to be predictable. Scaled down
         * from the reviewer's 200/8 to 8 tokens x 8 users (64 calls) to stay
         * well under this DB's `max_connections` (100) once the fixed test
         * pool and other suites are accounted for.
         */
        it('isolates concurrent owner-reporting across multiple tokens (scaled S2)', async () => {
            const TOKENS = 8;
            const USERS_PER_TOKEN = 8;
            const total = TOKENS * USERS_PER_TOKEN;
            const burstSql = realPostgres(getTestDatabaseUrl(), { max: total + 2 });
            try {
                const tokens = Array.from({ length: TOKENS }, (_, t) => `tok-s2-${t}`);
                const calls: { token: string; userId: UserId; deviceId: string }[] = [];
                for (let t = 0; t < TOKENS; t++) {
                    for (let u = 0; u < USERS_PER_TOKEN; u++) {
                        const userId = await makeUser(`pushtest_s2_${t}_${u}`);
                        const deviceId = await makeDevice(userId, `dev-s2-${t}-${u}`);
                        calls.push({ token: tokens[t], userId, deviceId });
                    }
                }

                const results = await Promise.all(
                    calls.map(({ token, userId, deviceId }) =>
                        upsertPushToken(burstSql, {
                            userId,
                            deviceId,
                            token,
                            bundleId: 'de.hinterthaner.stellar-tvos.ios',
                            environment: 'production',
                            locale: 'en-US',
                            payloadVersion: 1,
                        }).then((result) => ({ token, userId, result })),
                    ),
                );

                for (const token of tokens) {
                    const forToken = results.filter((r) => r.token === token);
                    expect(forToken).toHaveLength(USERS_PER_TOKEN);
                    const rebinds = forToken.filter((r) => r.result.previousUserId !== null);
                    expect(rebinds).toHaveLength(USERS_PER_TOKEN - 1);
                    for (const r of forToken) {
                        if (r.result.previousUserId)
                            expect(r.result.previousUserId).not.toBe(r.userId);
                    }
                    const rows = await sql`SELECT id FROM user_push_tokens WHERE token = ${token}`;
                    expect(rows).toHaveLength(1);
                }
            } finally {
                await burstSql.end({ timeout: 5 });
            }
        });
    });

    it('refuses to deactivate a token that belongs to a different user', async () => {
        // The unique triple (token, bundle_id, environment) spans the WHOLE
        // table, so an unscoped UPDATE here retires any row in the system given
        // only a token string — and the one caller feeds it strings that came
        // back over the network from the relay.
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });

        await deactivatePushToken(
            sql,
            'tok-1',
            'de.hinterthaner.stellar-tvos.ios',
            'production',
            'gone',
            userB,
        );
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(1);

        // The rightful owner still can, so the scope is a filter and not a wall.
        await deactivatePushToken(
            sql,
            'tok-1',
            'de.hinterthaner.stellar-tvos.ios',
            'production',
            'gone',
            userA,
        );
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);
    });

    it('does not revive a session-revoked token while the device has no live session', async () => {
        // iOS re-registers on every launch and an access token outlives the
        // revocation of its session by up to an hour, so a PUT arriving after a
        // sign-out is routine, not exotic. An unconditional
        // `deactivated_at = NULL` makes that PUT permanently undo migration
        // 16.200.0's revocation: nothing fires the trigger a second time.
        const tokenId = await makeRefreshToken(userA, 'dev-a', 'hash-live-1');
        const params = {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production' as const,
            locale: 'en-US',
            payloadVersion: 1,
        };
        await upsertPushToken(sql, params);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(1);

        // Sign out. The real revocation path, so 16.200.0's trigger does the
        // deactivation rather than the test faking it.
        await sql`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE id = ${tokenId}`;
        const [revoked] = await sql<{ deactivation_reason: string | null }[]>`
            SELECT deactivation_reason FROM user_push_tokens WHERE token = 'tok-1'
        `;
        expect(revoked.deactivation_reason).toBe('session_revoked');

        // The racing re-registration.
        await upsertPushToken(sql, params);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);

        // Signing back in gives the device a live session again, and THEN the
        // same call must revive — otherwise the device is bricked for push.
        await makeRefreshToken(userA, 'dev-a', 'hash-live-2');
        await upsertPushToken(sql, params);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(1);
    });

    it('still revives a token deactivated for any reason other than revocation', async () => {
        // The handed-over-device path (spec A2): a token that 410'd under a
        // previous owner MUST come back for the new one. Only 'session_revoked'
        // is conditional; nothing else may regress.
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        await deactivatePushToken(
            sql,
            'tok-1',
            'de.hinterthaner.stellar-tvos.ios',
            'production',
            'gone',
            userA,
        );

        // No refresh token anywhere for userB's device — the revival still happens.
        await upsertPushToken(sql, {
            userId: userB,
            deviceId: deviceB,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'de-DE',
            payloadVersion: 1,
        });
        expect(await getActivePushTokensForUser(sql, userB)).toHaveLength(1);
    });

    it('deactivates the sibling row when a device rotates its token', async () => {
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-old',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-new',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        const rows = await getActivePushTokensForUser(sql, userA);
        expect(rows).toHaveLength(1);
        expect(rows[0].token).toBe('tok-new');
    });

    it('cascades when the device row is deleted', async () => {
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        await sql`DELETE FROM user_devices WHERE id = ${deviceA}`;
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);
    });

    it('deregisters via DELETE and deactivates all of a device on revocation', async () => {
        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-1',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        expect(await deactivatePushTokensForDevice(sql, userA, deviceA, 'session_revoked')).toBe(1);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);

        await upsertPushToken(sql, {
            userId: userA,
            deviceId: deviceA,
            token: 'tok-2',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });
        // deletePushTokenForDevice hard-deletes EVERY token row for the device,
        // including the deactivated 'tok-1' row left behind as an audit trail by
        // deactivatePushTokensForDevice above — so this removes both tok-1 and tok-2.
        expect(await deletePushTokenForDevice(sql, userA, deviceA)).toBe(2);
        expect(await getActivePushTokensForUser(sql, userA)).toHaveLength(0);
    });

    it('serializes concurrent registrations for the same device so only one active token survives', async () => {
        // Real concurrency, not sequential calls: fire N distinct-token upserts
        // for the SAME device/bundle/environment at once, exactly the pattern
        // used by task-quota.queries.integration.test.ts for its "no overshoot
        // under concurrent acquires" case. Without the transaction-scoped
        // advisory lock in upsertPushToken, two of these can both INSERT before
        // either commits — neither's sibling-deactivation UPDATE would see the
        // other, leaving more than one active row.
        //
        // ## Why a dedicated connection pool, and why 5 repeated bursts
        //
        // A single burst against the SHARED test pool measured 100% sensitive
        // in isolation locally, but was reported at only ~67% (roughly 1-in-3
        // false negatives — the buggy code passing by accident) once. The
        // credible mechanism: `Promise.all(tokens.map(...))` only *requests*
        // concurrent execution — actual overlap of the SELECT-then-INSERT
        // window inside each transaction depends on the JS event loop
        // dispatching all N `sql.begin()` calls before the fastest one's round
        // trip completes. That is a scheduling race, not a guarantee, and it
        // degrades under exactly the conditions a CI runner adds: CPU
        // contention / event-loop lag that spaces the dispatch of the 8 calls
        // out enough for early transactions to commit before later ones start,
        // making the (buggy) code look correct by accident.
        //
        // Two independent hardenings, neither of which touches the function
        // under test:
        //  1. A dedicated connection pool sized with headroom for the whole
        //     burst, so this test's transactions are never queued behind
        //     unrelated connection demand.
        //  2. The burst repeated across 5 independent fresh devices, each
        //     asserted separately. If a single burst's true miss probability
        //     under load were really ~33% (matching the ~67% figure), 5
        //     independent bursts drop the whole-test miss probability to
        //     0.33^5 ≈ 0.4% — turning a coin-flip-adjacent false negative into
        //     a vanishingly rare one, without any change to production code or
        //     any synchronization hook into `upsertPushToken` itself.
        const attempts = 8;
        const bursts = 5;
        const burstSql = realPostgres(getTestDatabaseUrl(), { max: attempts + 2 });
        try {
            for (let b = 0; b < bursts; b++) {
                const burstDevice = await makeDevice(userA, `dev-a-burst-${b}`);
                const tokens = Array.from(
                    { length: attempts },
                    (_, i) => `tok-concurrent-${b}-${i}`,
                );
                await Promise.all(
                    tokens.map((token) =>
                        upsertPushToken(burstSql, {
                            userId: userA,
                            deviceId: burstDevice,
                            token,
                            bundleId: 'de.hinterthaner.stellar-tvos.ios',
                            environment: 'production',
                            locale: 'en-US',
                            payloadVersion: 1,
                        }),
                    ),
                );
                const active = await getActivePushTokensForUser(sql, userA);
                const activeForDevice = active.filter((r) => r.device_id === burstDevice);
                expect(activeForDevice).toHaveLength(1);
                expect(tokens).toContain(activeForDevice[0].token);
            }
        } finally {
            await burstSql.end({ timeout: 5 });
        }
    });
});

describe('user_push_outbox', () => {
    async function makeNotification(userId: UserId, kind: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO user_notifications (user_id, kind, payload, expires_at)
            VALUES (${userId}, ${kind}, '{}'::jsonb, NOW() + INTERVAL '30 days')
            RETURNING id
        `;
        return row.id;
    }

    it('enqueues once per notification and rejects a duplicate', async () => {
        const nid = await makeNotification(userA, 'library.new_episode');
        expect(
            await enqueuePushOutbox(sql, {
                userId: userA,
                notificationId: nid,
                kind: 'library.new_episode',
            }),
        ).toBe(true);
        expect(
            await enqueuePushOutbox(sql, {
                userId: userA,
                notificationId: nid,
                kind: 'library.new_episode',
            }),
        ).toBe(false);
        const claimed = await claimReadyPushRows(sql, 10, 300);
        expect(claimed).toHaveLength(1);
    });

    it('cascades when the notification row is pruned', async () => {
        const nid = await makeNotification(userA, 'library.new_episode');
        await enqueuePushOutbox(sql, {
            userId: userA,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        await sql`DELETE FROM user_notifications WHERE id = ${nid}`;
        expect(await claimReadyPushRows(sql, 10, 300)).toHaveLength(0);
    });

    it('claiming pushes next_attempt_at forward so a concurrent pass skips the row', async () => {
        const nid = await makeNotification(userA, 'library.new_episode');
        await enqueuePushOutbox(sql, {
            userId: userA,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        expect(await claimReadyPushRows(sql, 10, 300)).toHaveLength(1);
        expect(await claimReadyPushRows(sql, 10, 300)).toHaveLength(0);
    });

    describe('reschedulePushRow CAS', () => {
        /**
         * Unlike `upsertPushToken`'s multi-statement race (Gap 1 above), this
         * one is a single `UPDATE ... WHERE attempts = $expected` — Postgres's
         * own row-level locking serializes concurrent UPDATEs against the same
         * row, so the second writer always re-evaluates the WHERE clause
         * against the first writer's committed result. That makes this test
         * deterministic by construction, not by scheduling luck: no dedicated
         * pool or repeated-burst hardening needed (contrast Gap 1).
         */
        it('CAS makes exactly one winner when two reschedulers race the same row with consumesAttempt=true', async () => {
            const nid = await makeNotification(userA, 'library.new_episode');
            await enqueuePushOutbox(sql, {
                userId: userA,
                notificationId: nid,
                kind: 'library.new_episode',
            });
            const [row] = await sql<{ id: string; attempts: number }[]>`
                SELECT id, attempts FROM user_push_outbox WHERE notification_id = ${nid}
            `;
            expect(row.attempts).toBe(0);

            // Two concurrent ladder-rung reschedules, both holding the SAME
            // (correct, at-the-time) expectedAttempts=0 — exactly the shape of
            // two replicas' delivery passes racing a claim-TTL-expired row.
            const results = await Promise.all([
                reschedulePushRow(sql, row.id, 0, 30, ['tok-a'], true),
                reschedulePushRow(sql, row.id, 0, 60, ['tok-b'], true),
            ]);
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(results).toContain(true);
            expect(results).toContain(false);

            const [after] = await sql<{ attempts: number; delivered_tokens: string[] }[]>`
                SELECT attempts, delivered_tokens FROM user_push_outbox WHERE id = ${row.id}
            `;
            // Exactly one rung spent — two racers both incrementing would
            // silently halve the ladder budget, the exact bug this CAS exists
            // to prevent (see the function's doc comment).
            expect(after.attempts).toBe(1);
            // delivered_tokens reflects whichever call actually won the race —
            // it must be exactly one call's payload, never a merge of both and
            // never neither.
            expect(
                (after.delivered_tokens.length === 1 && after.delivered_tokens[0] === 'tok-a') ||
                    (after.delivered_tokens.length === 1 && after.delivered_tokens[0] === 'tok-b'),
            ).toBe(true);
        });

        it('a stale expectedAttempts always loses the CAS, even concurrently', async () => {
            const nid = await makeNotification(userA, 'library.new_episode');
            await enqueuePushOutbox(sql, {
                userId: userA,
                notificationId: nid,
                kind: 'library.new_episode',
            });
            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM user_push_outbox WHERE notification_id = ${nid}
            `;

            // A genuine ladder rung advances attempts 0 -> 1 first.
            expect(await reschedulePushRow(sql, row.id, 0, 10, [], true)).toBe(true);

            // Two late callers still holding the now-stale expectedAttempts=0
            // race each other — both must lose, not just "the loser of the two".
            const results = await Promise.all([
                reschedulePushRow(sql, row.id, 0, 20, ['x'], true),
                reschedulePushRow(sql, row.id, 0, 30, ['y'], true),
            ]);
            expect(results).toEqual([false, false]);

            const [after] = await sql<{ attempts: number; delivered_tokens: string[] }[]>`
                SELECT attempts, delivered_tokens FROM user_push_outbox WHERE id = ${row.id}
            `;
            expect(after.attempts).toBe(1);
            expect(after.delivered_tokens).toEqual([]);
        });
    });
});
