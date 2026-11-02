// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import type { UserId } from '$lib/shared/user-id';
// `vi.mock` below is hoisted above every import, so the delivery pass binds to
// the mocked `config` even though this import is written first.
import { PushOutbox, pushBackoffSeconds } from './push-outbox.js';
import { FakePushTransport } from '$lib/server/services/push/fake-push-transport.js';
import { PushTransportError } from '$lib/server/services/push/push-transport.js';
import {
    upsertPushToken,
    getActivePushTokensForUser,
} from '$lib/server/database/queries/user-push-tokens.queries.js';
import { enqueuePushOutbox } from '$lib/server/database/queries/user-push-outbox.queries.js';

const pushFlag = { value: true };
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            ...actual.config,
            get FEATURE_PUSH_NOTIFICATIONS() {
                return pushFlag.value;
            },
        },
    };
});

let sql: postgres.Sql;
let user: UserId;
let transport: FakePushTransport;
let outbox: PushOutbox;

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

async function makeNotification(kind = 'library.new_episode'): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO user_notifications (user_id, kind, payload, expires_at)
        VALUES (${user}, ${kind}, '{}'::jsonb, NOW() + INTERVAL '30 days')
        RETURNING id
    `;
    return row.id;
}

/**
 * A notification created long enough ago that `created_at + 4h` is already
 * behind us — what a row looks like after a worker or DB outage.
 */
async function makeStaleNotification(kind = 'library.new_episode'): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO user_notifications (user_id, kind, payload, created_at, expires_at)
        VALUES (${user}, ${kind}, '{}'::jsonb,
                NOW() - INTERVAL '5 hours', NOW() + INTERVAL '30 days')
        RETURNING id
    `;
    return row.id;
}

/**
 * Register one token on a device of its OWN.
 *
 * One device per token, not one shared device, because `upsertPushToken`
 * deactivates a device's previous token as `'rotated'` — APNs reissues tokens on
 * restore and reinstall, so a second active token on one device would mean
 * double-pushing. A user with two live tokens therefore has two devices, which
 * is also the only situation the (bundle, environment, locale) fan-out exists
 * for.
 */
async function addToken(
    token: string,
    locale: string,
    env: 'sandbox' | 'production' = 'production',
): Promise<void> {
    const deviceId = await makeDevice(user, `dev-${token}`);
    await upsertPushToken(sql, {
        userId: user,
        deviceId,
        token,
        bundleId: 'de.hinterthaner.stellar-tvos.ios',
        environment: env,
        locale,
        payloadVersion: 1,
    });
}

/** Make a claimed-and-backed-off row eligible again. */
async function makeReady(): Promise<void> {
    await sql`
        UPDATE user_push_outbox
        SET next_attempt_at = NOW() - INTERVAL '1 second'
        WHERE user_id = ${user}
    `;
}

interface OutboxSnapshot {
    attempts: number;
    dead: boolean;
    dead_reason: string | null;
    delivered_tokens: string[];
    /** Seconds from now until the row is eligible again — i.e. the ladder rung. */
    delay_seconds: number;
}

async function outboxRow(): Promise<OutboxSnapshot | undefined> {
    const [row] = await sql<OutboxSnapshot[]>`
        SELECT attempts, dead, dead_reason, delivered_tokens,
               EXTRACT(EPOCH FROM (next_attempt_at - NOW()))::float8 AS delay_seconds
        FROM user_push_outbox
        WHERE user_id = ${user}
        LIMIT 1
    `;
    return row;
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    pushFlag.value = true;
    transport = new FakePushTransport();
    outbox = new PushOutbox(sql, transport);

    // Scoped to THIS suite's users, children first. An unfiltered
    // `DELETE FROM user_push_tokens` would only be safe because
    // `fileParallelism: false` happens to serialise the three sibling push
    // suites that share these tables — a config setting, not an invariant of
    // this file.
    const stale = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username LIKE 'pushoutbox_%'
    `;
    if (stale.length > 0) {
        const ids = stale.map((r) => r.id);
        await sql`DELETE FROM user_push_outbox WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_push_tokens WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_notifications WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM user_devices WHERE user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
    }
    user = await makeUser('pushoutbox_a');
});

describe('pushBackoffSeconds', () => {
    it('follows the short ladder and clamps at the end', () => {
        expect(pushBackoffSeconds(0)).toBe(1);
        expect(pushBackoffSeconds(1)).toBe(10);
        expect(pushBackoffSeconds(2)).toBe(60);
        expect(pushBackoffSeconds(3)).toBe(300);
        expect(pushBackoffSeconds(4)).toBe(900);
        expect(pushBackoffSeconds(99)).toBe(900);
    });
});

describe('PushOutbox.deliveryPass', () => {
    it('sends one call per (bundle, environment, locale) group', async () => {
        await addToken('tok-en', 'en-US');
        await addToken('tok-de', 'de-DE');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        await outbox.deliveryPass();

        expect(transport.calls).toHaveLength(2);
        const bodies = transport.calls.map((c) => c.payload.aps.alert.body).sort();
        expect(bodies).toEqual(['Neue Folge verfügbar', 'New episode available']);
    });

    it('sets collapseId to the notification id and expiration to created_at + 4h', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        const [{ created_at }] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM user_notifications WHERE id = ${nid}
        `;

        await outbox.deliveryPass();

        expect(transport.calls[0].collapseId).toBe(nid);
        expect(transport.calls[0].expirationEpochSeconds).toBe(
            Math.floor((created_at.getTime() + 4 * 60 * 60 * 1000) / 1000),
        );
    });

    it('deactivates a token the transport reports as gone, and keeps the others', async () => {
        await addToken('tok-good', 'en-US');
        await addToken('tok-dead', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setResults((t) => (t === 'tok-dead' ? 'gone' : 'ok'));

        await outbox.deliveryPass();

        const active = await getActivePushTokensForUser(sql, user);
        expect(active.map((t) => t.token)).toEqual(['tok-good']);
        const [dead] = await sql<{ deactivation_reason: string }[]>`
            SELECT deactivation_reason FROM user_push_tokens WHERE token = 'tok-dead'
        `;
        expect(dead.deactivation_reason).toBe('gone');
    });

    it('removes the row when every token succeeded', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        await outbox.deliveryPass();

        expect(await outboxRow()).toBeUndefined();
    });

    it('retries with the ladder on a transient error and does not re-send a delivered token', async () => {
        await addToken('tok-a', 'en-US');
        await addToken('tok-b', 'de-DE'); // separate group, so one can fail alone
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        // First pass: the de group throws, the en group succeeds.
        transport.setResults(() => 'ok');
        const original = transport.send.bind(transport);
        transport.send = async (req) => {
            if (req.tokens.includes('tok-b')) throw new PushTransportError('down', 'transient');
            return original(req);
        };

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(false);
        expect(row?.attempts).toBe(1);
        expect(row?.delivered_tokens).toEqual(['tok-a']);

        // Second pass: everything works; tok-a must NOT be sent again.
        transport.send = original;
        transport.calls.length = 0;
        await makeReady();
        await outbox.deliveryPass();

        const sent = transport.calls.flatMap((c) => c.tokens);
        expect(sent).toEqual(['tok-b']);
        expect(await outboxRow()).toBeUndefined();
    });

    it('retires a per-token invalid and still retries a sibling transient failure', async () => {
        // Per-token `invalid` is APNs BadDeviceToken — a permanent fact about
        // ONE device (classically a sandbox token registered as production), not
        // about the row. Failing the row on it would strand the sibling token's
        // retryable failure AND leave the bad token active to poison every
        // future notification for this user.
        await addToken('tok-bad', 'en-US');
        await addToken('tok-flaky', 'en-US'); // same group, so one call covers both
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setResults((t) => (t === 'tok-bad' ? 'invalid' : 'failed'));

        await outbox.deliveryPass();

        // The bad token is retired, so the next notification self-heals.
        const [bad] = await sql<{ deactivation_reason: string }[]>`
            SELECT deactivation_reason FROM user_push_tokens WHERE token = 'tok-bad'
        `;
        expect(bad.deactivation_reason).toBe('invalid');
        // The row lives on for the flaky sibling rather than dying.
        const row = await outboxRow();
        expect(row?.dead).toBe(false);
        expect(row?.attempts).toBe(1);
        expect(await getActivePushTokensForUser(sql, user)).toHaveLength(1);
    });

    it('marks the row dead on a whole-call invalid, which is our bug not the device’s', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('bad topic', 'invalid'));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('invalid');
        // The token is blameless here — it must survive.
        expect(await getActivePushTokensForUser(sql, user)).toHaveLength(1);
    });

    it('marks the row dead immediately on not_entitled, without laddering', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('no entitlement', 'not_entitled'));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('not_entitled');
        expect(row?.attempts).toBe(0);
    });

    it('walks every ladder rung and dies only after the last one', async () => {
        // Two-directional on purpose. Asserting ONLY the final `dead === true`
        // cannot tell "died on schedule" from "died a rung early" — a shortened
        // ladder still ends dead, just sooner, and that is exactly how an
        // unreachable last rung shipped once already. So this pins both ends:
        // `dead === false` after each of the first MAX_ATTEMPTS-1 passes (breaks
        // if the row dies early) and `dead === true` after the last (breaks if
        // it dies late), plus the observed wait after each pass (breaks if the
        // rungs themselves shift).
        const RUNGS = [1, 10, 60, 300, 900];

        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('down', 'transient'));

        for (const [i, rung] of RUNGS.entries()) {
            await makeReady();
            await outbox.deliveryPass();

            const row = await outboxRow();
            expect(row?.dead, `still alive after attempt ${i + 1}`).toBe(false);
            expect(row?.attempts, `attempts after attempt ${i + 1}`).toBe(i + 1);
            // The wait is measured from the reschedule's own NOW(), a moment
            // before this read, so the observed delay is the rung minus a little
            // wall-clock. The rungs are orders of magnitude apart, so a few
            // seconds of slack still identifies each one unambiguously.
            expect(row?.delay_seconds, `rung after attempt ${i + 1}`).toBeLessThanOrEqual(rung);
            expect(row?.delay_seconds, `rung after attempt ${i + 1}`).toBeGreaterThan(rung - 3);
        }

        // One more attempt spends the last rung's wait and exhausts the ladder.
        await makeReady();
        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('max_attempts');
        // Five waits, one per rung — 1271s ≈ 21 minutes, matching the documented
        // budget and the throttle cut-off that is summed from the same array.
        expect(RUNGS.reduce((a, b) => a + b, 0)).toBe(1271);
    });

    it('dies rather than silently expiring when Retry-After exceeds the ladder budget', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('slow down', 'throttled', 99_999));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('throttled');
    });

    it('honours a Retry-After reschedule WITHOUT spending a ladder rung', async () => {
        // A relay asking us to slow down is not a failure of ours. Before the
        // fix, `reschedulePushRow` always incremented `attempts`, so a single
        // rate-limited send would burn a permanent-retry-budget rung on
        // nothing but waiting — this pins `attempts` staying at 0 after one
        // Retry-After-driven reschedule, and the wait honouring the relay's
        // requested delay rather than the ladder's own first rung (1s).
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('slow down', 'throttled', 5));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(false);
        expect(row?.attempts).toBe(0);
        expect(row?.delay_seconds).toBeLessThanOrEqual(5);
        expect(row?.delay_seconds).toBeGreaterThan(2);
    });

    it('still bounds a relay that keeps returning Retry-After forever', async () => {
        // Not spending a ladder rung on a Retry-After (previous test) must
        // not turn into an unbounded retry loop for a broken or hostile
        // relay that throttles forever. The bound is cumulative wall-clock
        // time since the row entered the outbox, capped at the same
        // ~21-minute LADDER_BUDGET_SECONDS the ladder itself spends —
        // simulated here by backdating the row's `created_at` past that
        // budget instead of waiting 21 minutes in real time. Even a tiny
        // Retry-After (5s) must die once no budget remains, and — this is
        // the point of the test — it must die WITHOUT ever having consumed
        // an attempt, proving this is the time-based bound and not the
        // pre-existing `max_attempts` ladder exhaustion.
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        await sql`
            UPDATE user_push_outbox
            SET created_at = NOW() - INTERVAL '25 minutes'
            WHERE user_id = ${user}
        `;
        transport.setError(new PushTransportError('slow down', 'throttled', 5));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('throttled');
        expect(row?.attempts).toBe(0);
    });

    it('retires every queued row when the feature flag is off', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        pushFlag.value = false;
        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('feature_disabled');
        expect(transport.calls).toHaveLength(0);
    });

    // ── Relay results are not trusted (security) ──────────────────────────────

    it('ignores a result naming a token that was never sent, and leaves that token alone', async () => {
        // `deactivatePushToken` matches on (token, bundle_id, environment) — a
        // triple that is unique across the WHOLE table, not per user. So a
        // relay result naming a stranger's token used to reach out of this
        // delivery entirely and silence someone else's phone.
        const victim = await makeUser('pushoutbox_victim');
        const victimDevice = await makeDevice(victim, 'dev-victim');
        await upsertPushToken(sql, {
            userId: victim,
            deviceId: victimDevice,
            token: 'tok-victim',
            bundleId: 'de.hinterthaner.stellar-tvos.ios',
            environment: 'production',
            locale: 'en-US',
            payloadVersion: 1,
        });

        await addToken('tok-mine', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        // A relay that answers about a token nobody asked about.
        transport.send = async (req) => {
            transport.calls.push(req);
            return [
                { token: 'tok-mine', status: 'ok' },
                { token: 'tok-victim', status: 'gone' },
            ];
        };

        await outbox.deliveryPass();

        const victimTokens = await getActivePushTokensForUser(sql, victim);
        expect(victimTokens.map((t) => t.token)).toEqual(['tok-victim']);
        expect(victimTokens[0].deactivated_at).toBeNull();

        await sql`DELETE FROM user_push_tokens WHERE user_id = ${victim}`;
        await sql`DELETE FROM user_devices WHERE user_id = ${victim}`;
        await sql`DELETE FROM users WHERE id = ${victim}`;
    });

    it('ignores a result for one of the user’s OWN tokens that this call did not send', async () => {
        // Isolates the sent-token guard from the user scope on
        // `deactivatePushToken`. The cross-user test above is defended twice
        // over, so it stays green even with the guard removed; here both
        // tokens belong to the same user, so ONLY the guard can save the one
        // that was not sent.
        await addToken('tok-en', 'en-US');
        await addToken('tok-de', 'de-DE'); // different group ⇒ a different call
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        transport.send = async (req) => {
            transport.calls.push(req);
            // Every call answers for BOTH tokens, including the one it was not
            // given — and reports the absent one as permanently gone.
            return req.tokens.includes('tok-en')
                ? [
                      { token: 'tok-en', status: 'ok' },
                      { token: 'tok-de', status: 'gone' },
                  ]
                : [{ token: 'tok-de', status: 'ok' }];
        };

        await outbox.deliveryPass();

        const active = (await getActivePushTokensForUser(sql, user)).map((t) => t.token).sort();
        expect(active).toEqual(['tok-de', 'tok-en']);
    });

    it('processes a duplicated relay result for the same sent token only once', async () => {
        // The sent-token guard (tests above) only rejects a token that was
        // NEVER sent. A token that WAS sent but appears twice in one
        // response slips past that guard entirely — unhandled, it would
        // double-append to `delivered_tokens` (harmless-looking, but wrong:
        // the array is meant to be a set of tokens this row has confirmed
        // delivered to).
        await addToken('tok-dup', 'en-US');
        await addToken('tok-other', 'en-US'); // same group -> one call, two tokens
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        transport.send = async (req) => {
            transport.calls.push(req);
            // tok-dup answered twice; tok-other left unanswered so the row
            // stays alive (retried) and delivered_tokens is inspectable.
            return [
                { token: 'tok-dup', status: 'ok' },
                { token: 'tok-dup', status: 'ok' },
            ];
        };

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row).toBeDefined();
        expect(row?.dead).toBe(false);
        expect(row?.delivered_tokens).toEqual(['tok-dup']);
    });

    it('retries a token the relay omitted from its results instead of calling it delivered', async () => {
        // Silence is not success. Treating an omitted token as "not failed"
        // marks the row fully delivered and DELETES it — the push is lost with
        // no trace at all.
        await addToken('tok-answered', 'en-US');
        await addToken('tok-ignored', 'en-US'); // same group ⇒ one call, two tokens
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        transport.send = async (req) => {
            transport.calls.push(req);
            return [{ token: 'tok-answered', status: 'ok' }];
        };

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row).toBeDefined();
        expect(row?.dead).toBe(false);
        expect(row?.attempts).toBe(1);
        expect(row?.delivered_tokens).toEqual(['tok-answered']);
    });

    // ── Structural failures die truthfully rather than riding the ladder ──────

    it('marks the row dead with no_relay_credential rather than spending the ladder', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('no relay credential', 'no_credential'));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        // NOT 'max_attempts'. Six retries over 21 minutes describe a relay
        // outage; this is an unset config key and no retry can change it.
        expect(row?.dead_reason).toBe('no_relay_credential');
        expect(row?.attempts).toBe(0);
    });

    it('marks a row whose expiration has already passed dead, without sending it', async () => {
        // APNs ACCEPTS a past apns-expiration, silently drops the push and
        // returns success — so sending would mark the row delivered, delete it,
        // and lose the notification with nothing anywhere to show for it.
        await addToken('tok-1', 'en-US');
        const nid = await makeStaleNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        await outbox.deliveryPass();

        expect(transport.calls).toHaveLength(0);
        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('expired');
    });

    it('scopes a whole-call invalid to its own group and still delivers the others', async () => {
        // `bundleId` is an unvalidated client string, so an unknown bundle
        // earns a relay 400 for ONE group. Killing the row on it would take
        // every other device down with it.
        await addToken('tok-en', 'en-US');
        await addToken('tok-de', 'de-DE'); // separate group
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        transport.setResults(() => 'ok');
        const original = transport.send.bind(transport);
        transport.send = async (req) => {
            if (req.tokens.includes('tok-de')) {
                throw new PushTransportError('bad topic', 'invalid');
            }
            return original(req);
        };

        await outbox.deliveryPass();

        // The en group succeeded and nothing is retryable, so the row resolves
        // rather than dying — and crucially the en device did get its push.
        expect(transport.calls.map((c) => c.tokens).flat()).toContain('tok-en');
        expect(await outboxRow()).toBeUndefined();
    });

    it('marks the row dead when EVERY group fails permanently', async () => {
        await addToken('tok-en', 'en-US');
        await addToken('tok-de', 'de-DE');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        transport.setError(new PushTransportError('bad topic', 'invalid'));

        await outbox.deliveryPass();

        const row = await outboxRow();
        expect(row?.dead).toBe(true);
        expect(row?.dead_reason).toBe('invalid');
    });

    it('does no periodic work after the first pass with the feature off', async () => {
        // The feature is OFF BY DEFAULT, so an unlatched retire sweep is one
        // UPDATE per second on every replica of every install, forever.
        // Asserted behaviourally: a row that appears AFTER the first
        // disabled-pass must still be untouched by the second, which is only
        // true if the second pass never queried at all.
        pushFlag.value = false;
        await outbox.deliveryPass();

        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });

        await outbox.deliveryPass();
        expect((await outboxRow())?.dead).toBe(false);

        // Flipping the flag back on clears the latch, so the NEXT off
        // transition sweeps again — the kill switch still works.
        pushFlag.value = true;
        await outbox.deliveryPass(); // no tokens: resolves the row
        const nid2 = await makeNotification('request.available');
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid2,
            kind: 'request.available',
        });
        pushFlag.value = false;
        await outbox.deliveryPass();
        expect((await outboxRow())?.dead_reason).toBe('feature_disabled');
    });

    it('drops the row without sending when the user has no active token left', async () => {
        await addToken('tok-1', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        await sql`
            UPDATE user_push_tokens
            SET deactivated_at = NOW(), deactivation_reason = 'user'
            WHERE user_id = ${user}
        `;

        await outbox.deliveryPass();

        expect(transport.calls).toHaveLength(0);
        expect(await outboxRow()).toBeUndefined();
    });
});

describe('PushOutbox.stop', () => {
    it('waits for the delivery pass in flight before resolving, and sends nothing after', async () => {
        await addToken('tok-stop', 'en-US');
        const nid = await makeNotification();
        await enqueuePushOutbox(sql, {
            userId: user,
            notificationId: nid,
            kind: 'library.new_episode',
        });
        let entered!: () => void;
        const sending = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const send = transport.send.bind(transport);
        const sendSpy = vi.spyOn(transport, 'send').mockImplementation(async (req) => {
            entered();
            await released;
            return send(req);
        });
        try {
            outbox.start();
            await sending;

            let settled: boolean | undefined;
            const stopping = outbox.stop().then((value) => {
                settled = value;
            });
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            // Pass still blocked in send: stop has not resolved, row not settled.
            expect(settled).toBeUndefined();
            expect(await outboxRow()).toBeDefined();

            release();
            await stopping;
            expect(settled).toBe(true);
            // The in-flight pass finished its delivery before stop resolved.
            expect(await outboxRow()).toBeUndefined();
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            expect(sendSpy).toHaveBeenCalledOnce();
        } finally {
            release();
            await outbox.stop();
        }
    }, 15_000);
});
