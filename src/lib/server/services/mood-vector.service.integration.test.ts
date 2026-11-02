// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for MoodVectorService.queryWithMoodVector.
 *
 * `queryWithMoodVector` applies its access predicates INSIDE the two ANN
 * candidate CTEs (ann_library / ann_discovery), not over the final result set.
 * Both CTEs alias `media_items` as `mi` — and so does the later
 * mood_vector_matches CTE — so a predicate that landed in the wrong scope, or an
 * `access` argument that arrived but was never interpolated, would still compile
 * and still return plausible rows. Only a differential test catches that.
 *
 * The shape of each assertion is therefore: run the SAME fixture twice, once
 * unrestricted and once restricted, and require the restricted result to be a
 * strict subset; plus require deny-all to return nothing at all. The
 * unrestricted run is the positive control that proves the fixture actually
 * matches, so a restricted run returning `[]` cannot pass for the wrong reason.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    insertTestEmbedding,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
    type MediaAccessBoundary,
} from '../database/queries/builders/media-access-boundary.js';
import { MoodVectorService } from './mood-vector.service.js';

const DIM = 1024;
const MOOD_KEY = 'access-boundary-test-mood';

function vec(entries: Record<number, number>): number[] {
    const v = new Array<number>(DIM).fill(0);
    for (const [i, val] of Object.entries(entries)) v[Number(i)] = val;
    return v;
}

let sql: postgres.Sql;
let service: MoodVectorService;

beforeAll(() => {
    sql = getTestDb();
    service = new MoodVectorService(sql);
});

afterAll(async () => {
    await closeTestDb();
});

/** Boundary denying exactly the given library groups; age unrestricted. */
function denyGroups(...ids: string[]): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

/**
 * Seed one movie with a LIBRARY-source embedding. When `libraryGroupId` is given
 * the item gets a media_files row in that group — which is what makes the
 * library-access predicate able to exclude it, since that predicate always
 * admits items with NO media_file_items rows at all.
 */
async function seedMovie(
    tmdbId: number,
    embedding: number[],
    libraryGroupId: string | null,
): Promise<string> {
    const item = createTestMediaItem({ media_type: 'movie' });
    await insertTestMediaItem(sql, item);
    await insertTestExternalIds(
        sql,
        createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
    );
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        VALUES (${item.id}::uuid, 'tmdb',
            ${sql.json({ overview: 'Mood vector access fixture', imdb_rating: 7.0 })}, NOW())
    `;
    if (libraryGroupId) {
        const fileId = randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
            VALUES (${fileId}::uuid, ${`/test/moodvec/${item.id}.mkv`}, ${libraryGroupId}::uuid, NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${item.id}::uuid)
        `;
    }
    await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
    await insertTestEmbedding(sql, {
        media_id: item.id,
        embedding,
        source: EMBEDDING_SOURCE.LIBRARY,
    });
    return item.id;
}

describe('MoodVectorService.queryWithMoodVector — access boundary is honoured (differential)', () => {
    let groupA: string;
    let userId: ReturnType<typeof toUserId>;
    let deniedId: string;
    let allowedId: string;

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            'media_embeddings',
        ]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await sql`DELETE FROM mood_vectors WHERE mood_key = ${MOOD_KEY}`;
        // getMoodVector caches by bare moodKey (access-independent by design —
        // a centroid is not user data), so clear it between runs.
        await cacheManager.for(CACHE_NAMESPACES.moodVectors).delete(MOOD_KEY);

        groupA = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupA}::uuid, 'Denied Mood Vector Group')`;

        userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);

        // Mood centroid on axis 0; both items sit near it so both are genuine
        // ANN candidates and neither is excluded on similarity grounds.
        const moodVector = vec({ 0: 1 });
        await sql`
            INSERT INTO mood_vectors (mood_key, model_id, display_name, description, vector, seed_media_ids, seed_count)
            VALUES (${MOOD_KEY}, 'text', ${MOOD_KEY}, 'fixture', ${`[${moodVector.join(',')}]`}::vector, ${[]}, 0)
        `;

        deniedId = await seedMovie(993001, vec({ 0: 1 }), groupA);
        allowedId = await seedMovie(993002, vec({ 0: 0.99, 1: 0.1 }), null);
    });

    async function run(access: MediaAccessBoundary): Promise<string[]> {
        const rows = await service.queryWithMoodVector(MOOD_KEY, null, {
            limit: 50,
            excludeWatched: false,
            access,
        });
        return rows.map((r) => r.mediaId);
    }

    it('returns a strict subset under a library restriction, and nothing under deny-all', async () => {
        const open = await run(unrestrictedAccess());
        expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);
        expect(open).toContain(deniedId);
        expect(open).toContain(allowedId);

        const narrowed = await run(denyGroups(groupA));
        const openSet = new Set(open);
        expect(narrowed.every((id) => openSet.has(id))).toBe(true);
        expect(narrowed.length).toBeLessThan(open.length);
        expect(narrowed).not.toContain(deniedId);
        expect(narrowed).toContain(allowedId);

        expect(await run(denyAllAccess())).toEqual([]);
    });

    it('honours the age axis independently of the library axis', async () => {
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${deniedId}::uuid`;
        await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${allowedId}::uuid`;

        const open = await run(unrestrictedAccess());
        expect(open).toContain(deniedId);
        expect(open).toContain(allowedId);

        // Library unrestricted, age capped at 12 → only the age-6 item survives.
        const ageCapped = await run(
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
        );
        expect(ageCapped).toContain(allowedId);
        expect(ageCapped).not.toContain(deniedId);
        expect(ageCapped.length).toBeLessThan(open.length);
    });

    it('deny-all short-circuits without needing the mood vector to exist', async () => {
        await sql`DELETE FROM mood_vectors WHERE mood_key = ${MOOD_KEY}`;
        await cacheManager.for(CACHE_NAMESPACES.moodVectors).delete(MOOD_KEY);
        expect(await run(denyAllAccess())).toEqual([]);
    });
});
