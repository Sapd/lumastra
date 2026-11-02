// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the "show less like this" RANKING SQL.
 *
 * Exercises the real `buildDamperPenalty()` fragment (the per-candidate
 * mean-centered MAX-pool `unnest(float8[], text[])` + pgvector `<=>` shape used
 * inside the anime + short-movies scoring queries) against a real PostgreSQL +
 * pgvector instance. This locks the hand-written SQL — validated manually
 * against preprod's real data — against future regressions in CI.
 *
 * (The keyword path computes the same penalty in TypeScript and is covered by
 * the max-pool assertions in taste-damper.service.integration.test.ts.)
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
import { TasteDamperService } from './taste-damper.service.js';
import { buildDamperPenalty } from '../database/queries/builders/damper-penalty.builder.js';

const DIM = 1024;

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
    await truncateTables(sql, TEST_TABLES.media);
    await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');
});

function axis(i: number): number[] {
    const v = new Array<number>(DIM).fill(0);
    v[i] = 1;
    return v;
}

async function seedItem(embedding: number[], title: string): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(
        sql,
        createTestMediaItem({ id, media_type: 'movie', title, has_files: true }),
    );
    await insertTestEmbedding(sql, { media_id: id, embedding, source: EMBEDDING_SOURCE.LIBRARY });
    return id;
}

/** Run the real ranking penalty over a set of candidates. */
async function rankByPenalty(
    candidateIds: string[],
    ctx: Parameters<typeof buildDamperPenalty>[2],
): Promise<Array<{ title: string; pen: number }>> {
    const rows = await sql<{ title: string; pen: string }[]>`
        SELECT mi.title,
               ${buildDamperPenalty(sql, sql`me.embedding`, ctx)} AS pen
        FROM media_items mi
        JOIN media_embeddings me ON me.media_id = mi.id
        WHERE mi.id = ANY(${candidateIds}::uuid[])
        ORDER BY pen DESC
    `;
    return rows.map((r) => ({ title: r.title, pen: Number(r.pen) }));
}

describe('buildDamperPenalty (ranking SQL)', () => {
    it('penalizes BOTH damped neighborhoods (max-pool) and spares unrelated items', async () => {
        // Background so the global mean is well-separated from any single item.
        for (let i = 10; i < 16; i++) await seedItem(axis(i), `bg-${i}`);

        const userId = randomUUID();
        await ensureTestUser(sql, userId);

        const idA = await seedItem(axis(0), 'A'); // damper 1 neighborhood
        const idB = await seedItem(axis(1), 'B'); // damper 2 neighborhood (distinct)
        const idC = await seedItem(axis(2), 'C'); // unrelated candidate

        await service.recordDamper(userId, idA, 'movie');
        await service.recordDamper(userId, idB, 'movie');
        const ctx = await service.getDamperContext(userId);
        expect(ctx).not.toBeNull();

        const ranked = await rankByPenalty([idA, idB, idC], ctx);
        const pen = (t: string) => ranked.find((r) => r.title === t)!.pen;

        // Both damped items score ~1 (self-similar after centering) — invariant
        // for any global mean. The unrelated item is strictly less penalized than
        // either damped one (relative assertion → independent of the mean).
        expect(pen('A')).toBeGreaterThan(0.7);
        expect(pen('B')).toBeGreaterThan(0.7);
        expect(pen('C')).toBeLessThan(pen('A'));
        expect(pen('C')).toBeLessThan(pen('B'));
        // No NaN/garbage leaked through the pgvector ops.
        for (const r of ranked) expect(Number.isFinite(r.pen)).toBe(true);
    });

    it('returns 0 penalty for everything when there are no dampers', async () => {
        const idA = await seedItem(axis(0), 'A');
        const ranked = await rankByPenalty([idA], null);
        expect(ranked[0].pen).toBe(0);
    });
});
