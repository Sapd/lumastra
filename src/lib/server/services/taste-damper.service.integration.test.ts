// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for TasteDamperService ("show less like this").
 *
 * Uses the real `lumastra_tests` PostgreSQL database via `getTestDb()`. Exercises
 * the service end-to-end (record → context → list → remove → clear) plus the
 * algorithm properties the multi-agent review called for:
 *   - per-damper MAX-pool (not a single centroid): a multi-modal / opposing
 *     damper set steers away from BOTH neighborhoods independently, instead of
 *     canceling to a meaningless midpoint (the old centroid bug)
 *   - mean-centering: a global content mean is produced and applied
 *   - membership-based cache hash (stable across re-derivation)
 *   - pool cap (MAX_POOL_DAMPERS), no-embedding no-op, expiry exclusion,
 *     re-arm idempotency, remove/clear
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    insertTestEmbedding,
} from '../../../../tests/integration/fixtures/media.fixtures.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import {
    TasteDamperService,
    MAX_POOL_DAMPERS,
    type DamperContext,
} from './taste-damper.service.js';

const DIM = 1024; // matches the test DB's vector(N) column (fixtures default)

let sql: postgres.Sql;
let service: TasteDamperService;

beforeAll(() => {
    sql = getTestDb();
    service = new TasteDamperService(sql);
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    // Truncating media_items CASCADEs to user_taste_dampers (FK media_id).
    await truncateTables(sql, TEST_TABLES.media);
    // The global content-mean is cached process-wide; clear it so each test's
    // mean is derived from its own freshly-seeded embeddings.
    await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');
});

// --- helpers ---------------------------------------------------------------

/** Unit vector along a single axis (orthogonal to other axes). */
function axis(i: number): number[] {
    const v = new Array<number>(DIM).fill(0);
    v[i] = 1;
    return v;
}

function negate(v: number[]): number[] {
    return v.map((c) => -c);
}

function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        ma += a[i] * a[i];
        mb += b[i] * b[i];
    }
    if (ma === 0 || mb === 0) return 0;
    return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

/** Mirror the service's ranking-time max-pool so we can assert its effect. */
function poolPenalty(ctx: DamperContext, itemEmb: number[]): number {
    const centered = ctx.mean ? itemEmb.map((c, i) => c - (ctx.mean as number[])[i]) : itemEmb;
    let pen = 0;
    for (const d of ctx.dampers) {
        const p = d.weight * Math.max(0, cosine(centered, d.vec));
        if (p > pen) pen = p;
    }
    return pen;
}

async function seedItem(embedding: number[], title: string): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(
        sql,
        createTestMediaItem({ id, media_type: 'movie', title, has_files: true }),
    );
    await insertTestEmbedding(sql, {
        media_id: id,
        embedding,
        source: EMBEDDING_SOURCE.LIBRARY,
    });
    return id;
}

/** Seed diverse background embeddings so the global mean is well-separated from
 *  any single damped item (avoids the tiny-library "damper == mean" degeneracy). */
async function seedBackground(): Promise<void> {
    for (let i = 10; i < 16; i++) await seedItem(axis(i), `bg-${i}`);
}

async function freshUser(): Promise<string> {
    const userId = randomUUID();
    await ensureTestUser(sql, userId);
    return userId;
}

// --- tests -----------------------------------------------------------------

describe('TasteDamperService', () => {
    it('single damper → context with one mean-centered damper; list shows it', async () => {
        await seedBackground();
        const userId = await freshUser();
        const mediaId = await seedItem(axis(0), 'Damped Movie');

        await service.recordDamper(userId, mediaId, 'movie');

        const ctx = (await service.getDamperContext(userId)) as DamperContext;
        expect(ctx).not.toBeNull();
        expect(ctx.dampers).toHaveLength(1);
        expect(ctx.dampers[0].weight).toBeGreaterThan(0);
        expect(ctx.dampers[0].weight).toBeLessThanOrEqual(1);
        expect(ctx.dampers[0].vec).toHaveLength(DIM);
        expect(ctx.dampers[0].vec.every(Number.isFinite)).toBe(true);
        expect(ctx.mean).not.toBeNull(); // mean-centering active
        expect(ctx.mean).toHaveLength(DIM);

        // An item identical to the damped one is strongly penalized (self-similar
        // → invariant for any mean); an unrelated one strictly less so.
        expect(poolPenalty(ctx, axis(0))).toBeGreaterThan(0.7);
        expect(poolPenalty(ctx, axis(2))).toBeLessThan(poolPenalty(ctx, axis(0)));

        const list = await service.listActiveDampers(userId);
        expect(list).toHaveLength(1);
        expect(list[0].mediaId).toBe(mediaId);
        expect(list[0].title).toBe('Damped Movie');
    });

    it('opposing dampers do NOT cancel — max-pool penalizes BOTH directions', async () => {
        await seedBackground();
        const userId = await freshUser();
        const a = axis(0);
        const b = negate(a); // exact opposite — the old centroid canceled to ~0
        const idA = await seedItem(a, 'A');
        const idB = await seedItem(b, 'B');

        await service.recordDamper(userId, idA, 'movie');
        await service.recordDamper(userId, idB, 'movie');

        const ctx = (await service.getDamperContext(userId)) as DamperContext;
        // The fix: a non-null context with BOTH dampers (centroid would null).
        expect(ctx).not.toBeNull();
        expect(ctx.dampers).toHaveLength(2);

        // Both opposing neighborhoods are penalized (self-similar → invariant);
        // an orthogonal item is strictly less penalized than either.
        const penA = poolPenalty(ctx, a);
        const penB = poolPenalty(ctx, b);
        const penC = poolPenalty(ctx, axis(2));
        expect(penA).toBeGreaterThan(0.7);
        expect(penB).toBeGreaterThan(0.7);
        expect(penC).toBeLessThan(penA);
        expect(penC).toBeLessThan(penB);
    });

    it('cache hash is membership-based: same active set → same hash regardless of churn', async () => {
        await seedBackground();
        const userId = await freshUser();
        const id1 = await seedItem(axis(0), 'One');
        const id2 = await seedItem(axis(1), 'Two');
        const id3 = await seedItem(axis(2), 'Three');

        await service.recordDamper(userId, id1, 'movie');
        await service.recordDamper(userId, id2, 'movie');
        const hashAB = (await service.getDamperContext(userId))?.hash;

        await service.recordDamper(userId, id3, 'movie');
        const hashABC = (await service.getDamperContext(userId))?.hash;
        await service.removeDamper(userId, id3);
        const hashAB2 = (await service.getDamperContext(userId))?.hash;

        expect(hashAB).toBeTruthy();
        expect(hashABC).not.toBe(hashAB); // membership changed
        expect(hashAB2).toBe(hashAB); // identical set → identical hash
    });

    it('caps the per-candidate pool at MAX_POOL_DAMPERS', async () => {
        await seedBackground();
        const userId = await freshUser();
        const total = MAX_POOL_DAMPERS + 2;
        for (let i = 0; i < total; i++) {
            const id = await seedItem(axis(20 + i), `Item ${i}`);
            await service.recordDamper(userId, id, 'movie');
        }
        const ctx = await service.getDamperContext(userId);
        expect(ctx).not.toBeNull();
        expect(ctx?.dampers.length).toBe(MAX_POOL_DAMPERS);

        // All are still stored (cap applies only to the pool).
        const stored = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM user_taste_dampers WHERE user_id = ${userId}
        `;
        expect(stored[0].n).toBe(total);
    });

    it('no-op for an item without an embedding', async () => {
        await seedBackground();
        const userId = await freshUser();
        const id = randomUUID();
        await insertTestMediaItem(
            sql,
            createTestMediaItem({
                id,
                media_type: 'movie',
                title: 'No Embedding',
                has_files: true,
            }),
        );

        await service.recordDamper(userId, id, 'movie'); // logs + skips, no throw
        expect(await service.getDamperContext(userId)).toBeNull();
        expect(await service.listActiveDampers(userId)).toHaveLength(0);
    });

    it('excludes expired dampers', async () => {
        await seedBackground();
        const userId = await freshUser();
        const id = await seedItem(axis(0), 'Expired');
        const vecLiteral = `[${axis(0).join(',')}]`;
        await sql`
            INSERT INTO user_taste_dampers (user_id, media_id, media_type, embedding, expires_at)
            VALUES (${userId}, ${id}, 'movie', ${vecLiteral}::vector, NOW() - INTERVAL '1 day')
        `;

        expect(await service.getDamperContext(userId)).toBeNull();
        expect(await service.listActiveDampers(userId)).toHaveLength(0);
    });

    it('re-arming the same title keeps a single row', async () => {
        await seedBackground();
        const userId = await freshUser();
        const id = await seedItem(axis(0), 'Rearm');

        await service.recordDamper(userId, id, 'movie');
        await service.recordDamper(userId, id, 'movie');

        expect(await service.listActiveDampers(userId)).toHaveLength(1);
    });

    it('removeDamper and clearAll work', async () => {
        await seedBackground();
        const userId = await freshUser();
        const id1 = await seedItem(axis(0), 'X');
        const id2 = await seedItem(axis(1), 'Y');
        await service.recordDamper(userId, id1, 'movie');
        await service.recordDamper(userId, id2, 'movie');

        expect(await service.removeDamper(userId, id1)).toBe(1); // removed
        expect(await service.removeDamper(userId, randomUUID())).toBe(0); // not a damper → 0
        expect(await service.listActiveDampers(userId)).toHaveLength(1);

        const cleared = await service.clearAll(userId);
        expect(cleared).toBe(1);
        expect(await service.getDamperContext(userId)).toBeNull();
    });
});
