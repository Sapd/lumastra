// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { ensureSchema, __resetSchemaGuardForTests } from './lib/schema.js';
import {
    insertMessage,
    insertUserMessageRateLimited,
    listRecent,
    getById,
    softDelete,
    softDeleteOwn,
    countRecentByUser,
    reserveAiInvocation,
    pruneAiInvocations,
    AI_INVOCATION_RETENTION_SECONDS,
} from './lib/queries.js';
import { randomUUID } from 'node:crypto';
import { getTestDatabaseUrl } from '../../tests/integration/setup/test-database.js';

const url = getTestDatabaseUrl();
let sql: postgres.Sql;

/**
 * `shoutbox_messages.user_id` carries an FK to `users(id)` with ON DELETE
 * CASCADE, so a message can only reference a user row that really exists.
 * Tests therefore mint real users rather than inventing UUIDs.
 */
const createdUserIds: string[] = [];
async function makeUser(name: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO users (id, username) VALUES (${id}::uuid, ${name})`;
    createdUserIds.push(id);
    return id;
}

beforeAll(async () => {
    sql = postgres(url);
    __resetSchemaGuardForTests();
    await ensureSchema(sql);
    await sql`TRUNCATE shoutbox_messages`;
});
afterAll(async () => {
    // Messages cascade away with their authors.
    if (createdUserIds.length > 0) {
        await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
    }
    await sql.end();
});

describe('shoutbox queries', () => {
    it('inserts and lists recent newest-last', async () => {
        await insertMessage(sql, {
            userId: null,
            username: 'alice',
            userGroup: 'users',
            body: 'first',
            authorKind: 'user',
            replyTo: null,
        });
        await insertMessage(sql, {
            userId: null,
            username: 'bob',
            userGroup: 'users',
            body: 'second',
            authorKind: 'user',
            replyTo: null,
        });
        const rows = await listRecent(sql, 10);
        expect(rows.map((r) => r.body)).toEqual(['first', 'second']);
    });

    it('getById returns one row; soft-delete hides it', async () => {
        const [m] = await insertMessage(sql, {
            userId: null,
            username: 'alice',
            userGroup: null,
            body: 'todelete',
            authorKind: 'user',
            replyTo: null,
        });
        expect((await getById(sql, m.id))?.body).toBe('todelete');
        await softDelete(sql, m.id);
        expect(await getById(sql, m.id)).toBeNull();
        expect((await listRecent(sql, 50)).find((r) => r.id === m.id)).toBeUndefined();
    });

    it('listRecent clamps bad limits instead of throwing', async () => {
        await sql`TRUNCATE shoutbox_messages`;
        await insertMessage(sql, {
            userId: null,
            username: 'carol',
            userGroup: null,
            body: 'x',
            authorKind: 'user',
            replyTo: null,
        });
        // Negative would raise "LIMIT must not be negative"; null/undefined -> unbounded.
        // @ts-expect-error testing runtime coercion of an invalid limit
        expect(await listRecent(sql, -1)).toHaveLength(1);
        // @ts-expect-error testing runtime coercion of an undefined limit
        expect(await listRecent(sql, undefined)).toHaveLength(1);
    });

    it('countRecentByUser counts within window and survives a numeric seconds arg', async () => {
        await sql`TRUNCATE shoutbox_messages`;
        const daveId = await makeUser(`dave_${randomUUID().slice(0, 8)}`);
        const otherId = await makeUser(`other_${randomUUID().slice(0, 8)}`);
        for (const body of ['a', 'b']) {
            await insertMessage(sql, {
                userId: daveId,
                username: 'dave',
                userGroup: null,
                body,
                authorKind: 'user',
                replyTo: null,
            });
        }
        // Passing a JS number (60) must not raise `operator does not exist: integer || unknown`.
        expect(await countRecentByUser(sql, daveId, 60)).toBe(2);
        expect(await countRecentByUser(sql, otherId, 60)).toBe(0);
        // A 0/negative window is floored to 1s rather than silently disabling the limiter.
        expect(await countRecentByUser(sql, daveId, 0)).toBe(2);
    });

    // ── Ownership is user_id, not username ────────────────────────────────
    //
    // The whole point of the rekey: a username is mutable and reusable, so
    // matching on it let the next holder of a name delete the previous
    // holder's messages.

    describe('softDeleteOwn', () => {
        it('lets the owning user_id delete, and nobody else', async () => {
            await sql`TRUNCATE shoutbox_messages`;
            const ownerId = await makeUser(`owner_${randomUUID().slice(0, 8)}`);
            const strangerId = await makeUser(`stranger_${randomUUID().slice(0, 8)}`);
            const [m] = await insertMessage(sql, {
                userId: ownerId,
                username: 'owner',
                userGroup: null,
                body: 'mine',
                authorKind: 'user',
                replyTo: null,
            });

            expect(await softDeleteOwn(sql, m.id, strangerId)).toBe(false);
            expect(await softDeleteOwn(sql, m.id, ownerId)).toBe(true);
            // Idempotent: already-deleted is indistinguishable from not-yours.
            expect(await softDeleteOwn(sql, m.id, ownerId)).toBe(false);
        });

        it('does NOT let a username-match delete when the user_id differs', async () => {
            // The reassigned-handle scenario, made concrete: two accounts, same
            // display name, different ids. Before the rekey the second could
            // delete the first's message.
            await sql`TRUNCATE shoutbox_messages`;
            const firstId = await makeUser(`recycled_a_${randomUUID().slice(0, 8)}`);
            const secondId = await makeUser(`recycled_b_${randomUUID().slice(0, 8)}`);
            const [m] = await insertMessage(sql, {
                userId: firstId,
                username: 'recycled',
                userGroup: null,
                body: 'written by the first holder',
                authorKind: 'user',
                replyTo: null,
            });
            expect(await softDeleteOwn(sql, m.id, secondId)).toBe(false);
            expect((await getById(sql, m.id))?.body).toBe('written by the first holder');
        });

        it('never matches an unattributable row, and never an AI row', async () => {
            await sql`TRUNCATE shoutbox_messages`;
            const someoneId = await makeUser(`someone_${randomUUID().slice(0, 8)}`);

            // A historical row the backfill could not resolve.
            const [orphan] = await insertMessage(sql, {
                userId: null,
                username: 'ghost',
                userGroup: null,
                body: 'orphan',
                authorKind: 'user',
                replyTo: null,
            });
            expect(await softDeleteOwn(sql, orphan.id, someoneId)).toBe(false);

            // An AI row carries a display name but no owner.
            const [bot] = await insertMessage(sql, {
                userId: null,
                username: 'assistant',
                userGroup: 'ai',
                body: 'bot says hi',
                authorKind: 'ai',
                replyTo: null,
            });
            expect(await softDeleteOwn(sql, bot.id, someoneId)).toBe(false);

            // Moderators can still remove both.
            await softDelete(sql, orphan.id);
            await softDelete(sql, bot.id);
            expect(await getById(sql, orphan.id)).toBeNull();
            expect(await getById(sql, bot.id)).toBeNull();
        });

        it('an empty userId is refused before touching the database', async () => {
            expect(await softDeleteOwn(sql, randomUUID(), '')).toBe(false);
        });
    });

    // ── The backfill ──────────────────────────────────────────────────────
    //
    // Feature plugins have no migration mechanism, so ensureSchema carries the
    // upgrade and re-runs on every process start. These assert it converts
    // legacy username-only rows exactly once and refuses to guess.

    it('backfills user_id from username, and leaves ambiguous names alone', async () => {
        await sql`TRUNCATE shoutbox_messages`;
        const handle = `backfill_${randomUUID().slice(0, 8)}`;
        const resolvedId = await makeUser(handle);

        // Two accounts whose handles fold to the same string — the case the
        // backfill must refuse rather than pick a winner for.
        const ambiguous = `ambig_${randomUUID().slice(0, 8)}`;
        await makeUser(ambiguous.toLowerCase());
        await makeUser(ambiguous.toUpperCase());

        // Legacy rows: written before user_id existed.
        const [resolvable] = await sql`
            INSERT INTO shoutbox_messages (username, author_kind, body)
            VALUES (${handle}, 'user', 'legacy resolvable') RETURNING id`;
        const [ambiguousRow] = await sql`
            INSERT INTO shoutbox_messages (username, author_kind, body)
            VALUES (${ambiguous}, 'user', 'legacy ambiguous') RETURNING id`;
        const [unknownRow] = await sql`
            INSERT INTO shoutbox_messages (username, author_kind, body)
            VALUES (${'gone_' + randomUUID().slice(0, 8)}, 'user', 'legacy vanished') RETURNING id`;

        __resetSchemaGuardForTests();
        await ensureSchema(sql);

        const byId = async (id: string) =>
            (await sql`SELECT user_id FROM shoutbox_messages WHERE id = ${id}`)[0]?.user_id ?? null;

        expect(await byId(resolvable.id)).toBe(resolvedId);
        // Two candidates → left NULL. Guessing would hand one account delete
        // rights over the other's messages, which is the bug being closed.
        expect(await byId(ambiguousRow.id)).toBeNull();
        // No candidate → left NULL, and so permanently moderator-only.
        expect(await byId(unknownRow.id)).toBeNull();
    });

    it('backfill does not re-attribute a row that already has an owner', async () => {
        await sql`TRUNCATE shoutbox_messages`;
        const realOwnerId = await makeUser(`real_${randomUUID().slice(0, 8)}`);
        const impostorHandle = `impostor_${randomUUID().slice(0, 8)}`;
        await makeUser(impostorHandle);

        // user_id already set, but the display name matches a DIFFERENT account.
        // The NULL guard is what stops the backfill overwriting the true owner.
        const [m] = await insertMessage(sql, {
            userId: realOwnerId,
            username: impostorHandle,
            userGroup: null,
            body: 'owner must not change',
            authorKind: 'user',
            replyTo: null,
        });

        __resetSchemaGuardForTests();
        await ensureSchema(sql);

        const [row] = await sql`SELECT user_id FROM shoutbox_messages WHERE id = ${m.id}`;
        expect(row.user_id).toBe(realOwnerId);
    });

    it('erasing a user cascades their messages away', async () => {
        await sql`TRUNCATE shoutbox_messages`;
        const doomedId = await makeUser(`doomed_${randomUUID().slice(0, 8)}`);
        const [m] = await insertMessage(sql, {
            userId: doomedId,
            username: 'doomed',
            userGroup: null,
            body: 'delete me with my account',
            authorKind: 'user',
            replyTo: null,
        });
        expect((await getById(sql, m.id))?.body).toBe('delete me with my account');

        // The FK is what makes GDPR erasure correct for a plugin table the
        // host's erasure registry does not cover.
        await sql`DELETE FROM users WHERE id = ${doomedId}::uuid`;
        expect(await getById(sql, m.id)).toBeNull();
    });
});

// ── Retention for shoutbox_ai_invocations ────────────────────────────────────
// The table exists only to answer "how many times did this user invoke the AI
// inside the last hour". Nothing pruned it, so every row outlived the window it
// was written for and stayed for the life of the account — turning a rate-limit
// counter into a permanent, exactly-timestamped log of when a named person
// talked to the bot. `reserveAiInvocation` now prunes as it reserves (a
// data-modifying CTE in the same statement, so no extra round trip on a path
// that is about to spend an AI call), and `pruneAiInvocations` is callable on
// its own for installs where nobody invokes the bot any more.
//
// The load-bearing property in every test below: pruning MUST NOT change any
// caller's verdict. The prune only removes rows OUTSIDE the window, and the cap
// only counts rows INSIDE it, so the two sets are disjoint — a pruned row could
// never have been counted.
describe('ai invocation retention', () => {
    /** Seed a row at an exact age, bypassing the created_at DEFAULT. */
    async function seedInvocation(userId: string, ageSeconds: number) {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO shoutbox_ai_invocations (user_id, created_at)
            VALUES (${userId}::uuid, now() - make_interval(secs => ${ageSeconds}))
            RETURNING id
        `;
        return row.id;
    }

    const countFor = async (userId: string) => {
        const [row] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid
        `;
        return Number(row.n);
    };

    const STALE = AI_INVOCATION_RETENTION_SECONDS + 600;

    beforeEach(async () => {
        await sql`TRUNCATE shoutbox_ai_invocations`;
    });

    it('reserving prunes rows past the retention window and keeps rows inside it', async () => {
        const userId = await makeUser(`prune_${randomUUID().slice(0, 8)}`);
        const stale = await seedInvocation(userId, STALE);
        const fresh = await seedInvocation(userId, 60);

        expect(await reserveAiInvocation(sql, { userId, limit: 20, windowSeconds: 3600 })).toBe(
            true,
        );

        const ids = (
            await sql<{ id: string }[]>`SELECT id FROM shoutbox_ai_invocations ORDER BY created_at`
        ).map((r) => r.id);
        expect(ids).not.toContain(stale);
        expect(ids).toContain(fresh);
        // fresh + the row just reserved.
        expect(ids.length).toBe(2);
    });

    it('prunes even when the caller is AT the cap and no row is inserted', async () => {
        const userId = await makeUser(`prune_cap_${randomUUID().slice(0, 8)}`);
        await seedInvocation(userId, STALE);
        await seedInvocation(userId, STALE);
        await seedInvocation(userId, 30);
        await seedInvocation(userId, 60);

        // Two rows inside the window, cap of 2 → refused, exactly as before the
        // prune existed. The two stale rows were never counted, so removing
        // them cannot hand the caller extra budget.
        expect(await reserveAiInvocation(sql, { userId, limit: 2, windowSeconds: 3600 })).toBe(
            false,
        );
        expect(await countFor(userId)).toBe(2);
    });

    it('stale rows do not buy budget back: a capped user stays capped after a prune', async () => {
        const userId = await makeUser(`prune_budget_${randomUUID().slice(0, 8)}`);
        await seedInvocation(userId, 10);
        await seedInvocation(userId, 20);
        for (let i = 0; i < 5; i++) await seedInvocation(userId, STALE + i);

        expect(await reserveAiInvocation(sql, { userId, limit: 2, windowSeconds: 3600 })).toBe(
            false,
        );
        expect(await reserveAiInvocation(sql, { userId, limit: 2, windowSeconds: 3600 })).toBe(
            false,
        );
        // Still the two in-window rows and nothing else.
        expect(await countFor(userId)).toBe(2);
    });

    it('prunes globally, so a user who never invokes again does not keep rows forever', async () => {
        const active = await makeUser(`prune_active_${randomUUID().slice(0, 8)}`);
        const dormant = await makeUser(`prune_dormant_${randomUUID().slice(0, 8)}`);
        await seedInvocation(dormant, STALE);
        await seedInvocation(dormant, STALE + 99);

        // A per-user prune would leave the dormant account's rows untouched
        // forever — which is the whole retention problem, not a fix for it.
        expect(
            await reserveAiInvocation(sql, { userId: active, limit: 20, windowSeconds: 3600 }),
        ).toBe(true);
        expect(await countFor(dormant)).toBe(0);
    });

    it('a longer caller window is respected: retention never cuts inside it', async () => {
        const userId = await makeUser(`prune_window_${randomUUID().slice(0, 8)}`);
        // Older than the default retention floor, but still inside a window
        // twice as long as the floor.
        const inLongWindow = await seedInvocation(userId, AI_INVOCATION_RETENTION_SECONDS + 300);

        expect(
            await reserveAiInvocation(sql, {
                userId,
                limit: 20,
                windowSeconds: AI_INVOCATION_RETENTION_SECONDS * 2,
            }),
        ).toBe(true);

        const ids = (await sql<{ id: string }[]>`SELECT id FROM shoutbox_ai_invocations`).map(
            (r) => r.id,
        );
        expect(ids).toContain(inLongWindow);
    });

    it('pruneAiInvocations deletes only rows past retention and reports the count', async () => {
        const userId = await makeUser(`prune_standalone_${randomUUID().slice(0, 8)}`);
        await seedInvocation(userId, STALE);
        await seedInvocation(userId, STALE + 1);
        const fresh = await seedInvocation(userId, 120);

        expect(await pruneAiInvocations(sql)).toBe(2);
        const ids = (await sql<{ id: string }[]>`SELECT id FROM shoutbox_ai_invocations`).map(
            (r) => r.id,
        );
        expect(ids).toEqual([fresh]);

        // Idempotent: a second run has nothing left to do.
        expect(await pruneAiInvocations(sql)).toBe(0);
    });

    // This one runs through ONE pooled `sql`, which serialises the calls — so it
    // says nothing about whether the cap survives concurrency, and passed just as
    // happily back when it did not. What it does check is the interaction the
    // concurrent tests cannot isolate: 40 stale rows are pruned on the way past
    // without ever having bought the caller extra budget. The cap under genuinely
    // concurrent connections is asserted in 'rate limiters under real
    // concurrency' at the bottom of this file.
    it('repeated reserves through one pool prune as they go and stop at the cap', async () => {
        const userId = await makeUser(`prune_repeat_${randomUUID().slice(0, 8)}`);
        for (let i = 0; i < 40; i++) await seedInvocation(userId, STALE + i);

        const LIMIT = 3;
        const results: boolean[] = [];
        for (let i = 0; i < 6; i++) {
            results.push(
                await reserveAiInvocation(sql, { userId, limit: LIMIT, windowSeconds: 3600 }),
            );
        }

        // First three granted, the rest refused — and the 40 stale rows are gone
        // without ever having bought the caller extra budget.
        expect(results).toEqual([true, true, true, false, false, false]);
        expect(await countFor(userId)).toBe(LIMIT);
    });

    it('pruneAiInvocations clamps a too-short retention up to the floor', async () => {
        const userId = await makeUser(`prune_clamp_${randomUUID().slice(0, 8)}`);
        const fresh = await seedInvocation(userId, 60);

        // A caller asking for 1-second retention would otherwise delete rows the
        // live one-hour cap still has to count. The floor makes that impossible.
        expect(await pruneAiInvocations(sql, 1)).toBe(0);
        expect(await countFor(userId)).toBe(1);
        const [row] = await sql<{ id: string }[]>`SELECT id FROM shoutbox_ai_invocations`;
        expect(row.id).toBe(fresh);
    });
});

// ── The caps under REAL concurrency ──────────────────────────────────────────
// Both limiters were documented as closing the check-then-act race because the
// count was re-evaluated "inside the same statement". It is — against that
// statement's own snapshot, taken at statement start. Under READ COMMITTED N
// reserves arriving on N separate connections therefore each see the same
// pre-insert count and all N insert. Measured on PG18 at a cap of 3 with 12
// dedicated connections: the conditional INSERT granted 12/12, exactly as a
// naive `SELECT count(*)` then `INSERT` does.
//
// WHY THIS NEEDS DEDICATED CONNECTIONS: one `postgres(url)` instance is a pool,
// and `Promise.all` of N calls through it is N *sequential* statements. Such a
// test grants exactly the cap against the broken implementation too — a false
// green with no discriminating power. Every worker below therefore gets its own
// `max: 1` client, pre-warmed so the handshake is off the hot path, and all N
// are released from one barrier.
describe('rate limiters under real concurrency', () => {
    const WORKERS = 12;
    const CAP = 3;

    /**
     * Run `work` on `WORKERS` dedicated connections released together, so the
     * statements genuinely overlap on the server.
     */
    async function race<T>(
        work: (client: postgres.Sql, index: number) => Promise<T>,
    ): Promise<T[]> {
        const clients = Array.from({ length: WORKERS }, () => postgres(url, { max: 1 }));
        try {
            // Connect + authenticate now: a cold handshake is far longer than
            // the window the race lives in, and would stagger the workers.
            await Promise.all(clients.map((c) => c`SELECT 1`));
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            const runs = clients.map(async (c, i) => {
                await gate;
                return work(c, i);
            });
            release();
            return await Promise.all(runs);
        } finally {
            await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
        }
    }

    const countInvocations = async (userId: string) => {
        const [row] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid
        `;
        return Number(row.n);
    };

    it('reserveAiInvocation grants exactly the cap, never more', async () => {
        const userId = await makeUser(`ai_race_${randomUUID().slice(0, 8)}`);

        const verdicts = await race((client) =>
            reserveAiInvocation(client, { userId, limit: CAP, windowSeconds: 3600 }),
        );

        // Both halves matter. The verdict count is what the caller acts on —
        // every `true` is an AI call that gets spent. The row count is the
        // ledger the next window reads; a reservation that granted but did not
        // land would hand the user free budget next time round.
        expect(verdicts.filter(Boolean)).toHaveLength(CAP);
        expect(await countInvocations(userId)).toBe(CAP);
    });

    it('reserveAiInvocation still grants the FULL cap under contention', async () => {
        // The mirror-image failure of the one above: a limiter that refuses on
        // lock contention instead of blocking would cap at 1, not 3, and look
        // "safe" while silently costing every user their budget.
        const userId = await makeUser(`ai_race_full_${randomUUID().slice(0, 8)}`);
        const verdicts = await race((client) =>
            reserveAiInvocation(client, { userId, limit: CAP, windowSeconds: 3600 }),
        );
        expect(verdicts.filter((v) => v === false)).toHaveLength(WORKERS - CAP);
    });

    it('reserveAiInvocation caps each user separately, so one racer cannot starve another', async () => {
        const a = await makeUser(`ai_race_a_${randomUUID().slice(0, 8)}`);
        const b = await makeUser(`ai_race_b_${randomUUID().slice(0, 8)}`);

        // Interleaved on purpose: the lock is keyed per user, so these two must
        // not serialise against each other, and must not share a budget.
        const verdicts = await race((client, i) =>
            reserveAiInvocation(client, {
                userId: i % 2 === 0 ? a : b,
                limit: CAP,
                windowSeconds: 3600,
            }),
        );

        expect(verdicts.filter(Boolean)).toHaveLength(CAP * 2);
        expect(await countInvocations(a)).toBe(CAP);
        expect(await countInvocations(b)).toBe(CAP);
    });

    it('reserveAiInvocation keeps pruning as it reserves when racing', async () => {
        const userId = await makeUser(`ai_race_prune_${randomUUID().slice(0, 8)}`);
        for (let i = 0; i < 5; i++) {
            await sql`
                INSERT INTO shoutbox_ai_invocations (user_id, created_at)
                VALUES (${userId}::uuid, now() - make_interval(secs => ${AI_INVOCATION_RETENTION_SECONDS + 600 + i}))
            `;
        }

        const verdicts = await race((client) =>
            reserveAiInvocation(client, { userId, limit: CAP, windowSeconds: 3600 }),
        );

        // Retention is not a casualty of the fix: the stale rows are gone, and
        // they never bought the racers extra budget on the way out.
        expect(verdicts.filter(Boolean)).toHaveLength(CAP);
        expect(await countInvocations(userId)).toBe(CAP);
    });

    it('insertUserMessageRateLimited inserts exactly the cap, never more', async () => {
        const username = `post_race_${randomUUID().slice(0, 8)}`;
        const userId = await makeUser(username);

        const rows = await race((client, i) =>
            insertUserMessageRateLimited(client, {
                userId,
                username,
                userGroup: null,
                body: `race ${i}`,
                replyTo: null,
                limit: CAP,
                windowSeconds: 60,
            }),
        );

        expect(rows.filter(Boolean)).toHaveLength(CAP);
        expect(await countRecentByUser(sql, userId, 60)).toBe(CAP);
    });
});
