// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for migration 16.51.0 — the provider_metadata →
 * metadata.changed trigger (cold-start audit M3).
 *
 * The aggregated provider_metadata row is the source the embedding text is built
 * from. Before 16.51.0, refreshing genres/keywords/overview into it emitted no
 * pipeline event, so library/discovery/music embeddings never invalidated their
 * stale vectors. 16.51.0 adds an AFTER INSERT/UPDATE trigger that emits
 * metadata.changed — but ONLY when an embedding-input field actually changes, so
 * a bulk re-aggregation (which re-upserts the same values, plus a fresh
 * fetched_at/updated_at) does NOT cause a library-wide re-embed storm.
 *
 * These tests assert that storm-prevention property directly:
 *   (a) genres change                     → exactly one metadata.changed event
 *   (b) keywords / overview change        → event emitted
 *   (c) re-upsert with IDENTICAL embedding fields (only fetched_at/updated_at
 *       differ)                            → NO event  (the storm-prevention proof)
 *   (d) non-embedding field change only (a display-only rating)
 *                                          → NO event
 *   (e) INSERT of a new aggregated row     → event emitted
 *   (+) non-'aggregated' provider rows are ignored, and the emit respects the
 *       event_outbox feature flag.
 *
 * Citations: migrations/16.51.0_provider_metadata_metadata_changed_event.ts,
 *            queries/metadata-aggregation.queries.ts (the aggregated upsert),
 *            ai/embedding-only-generator.ts (createEmbeddingText field set).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

/**
 * Read every metadata.changed event the trigger emitted for an item.
 */
async function changedEvents(
    sql: postgres.Sql,
    mediaId: string,
): Promise<{ event_name: string; payload: { changedFields?: string[] } }[]> {
    return sql<{ event_name: string; payload: { changedFields?: string[] } }[]>`
        SELECT event_name, payload
        FROM event_outbox
        WHERE media_item_id = ${mediaId}::uuid
          AND event_name = 'metadata.changed'
        ORDER BY id ASC
    `;
}

describe.runIf(RUN)('16.51.0 — provider_metadata aggregated row emits metadata.changed', () => {
    let sql: postgres.Sql;
    let cleanupIds: string[] = [];
    let priorFlag: string | null = null;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
            await sql`SELECT 1 FROM provider_metadata LIMIT 0`;
            await sql`SELECT 1 FROM event_outbox LIMIT 0`;
            await sql`SELECT 1 FROM feature_flags LIMIT 0`;
        } catch {
            throw new Error('Required tables missing — run db:test:migrate first');
        }
        // The trigger is gated by emit_pipeline_event → the event_outbox feature
        // flag. Force it on for the suite; restore the prior value afterward.
        const rows = await sql<{ value: string }[]>`
            SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'
        `;
        priorFlag = rows[0]?.value ?? null;
        await sql`
            INSERT INTO feature_flags (key, value)
            VALUES ('event_outbox_enabled', 'on')
            ON CONFLICT (key) DO UPDATE SET value = 'on'
        `;
    });

    afterAll(async () => {
        if (priorFlag === null) {
            await sql`DELETE FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        } else {
            await sql`
                UPDATE feature_flags SET value = ${priorFlag}
                WHERE key = 'event_outbox_enabled'
            `;
        }
        await closeTestDb();
    });

    beforeEach(async () => {
        if (cleanupIds.length > 0) {
            await sql`DELETE FROM event_outbox WHERE media_item_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${cleanupIds}::uuid[])`;
            cleanupIds = [];
        }
    });

    /** Insert a parent media_items row so provider_metadata.media_id is valid. */
    async function newItem(): Promise<string> {
        const id = crypto.randomUUID();
        cleanupIds.push(id);
        await sql`
            INSERT INTO media_items (id, media_type, title)
            VALUES (${id}::uuid, 'movie', 'M3 Trigger Test')
        `;
        return id;
    }

    /**
     * Upsert the aggregated provider_metadata row (mirrors the ON CONFLICT
     * upsert in metadata-aggregation.queries.ts). Always bumps fetched_at /
     * updated_at to NOW(), exactly as the real upsert does — so the only thing a
     * caller varies is the embedding-input content.
     */
    async function upsertAggregated(
        mediaId: string,
        metadata: Record<string, unknown>,
        fieldSources: Record<string, string> = {},
    ): Promise<void> {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, field_sources, fetched_at, updated_at)
            VALUES (
                ${mediaId}::uuid,
                'aggregated',
                ${sql.json(metadata as Record<string, never>)},
                ${sql.json(fieldSources as Record<string, never>)},
                NOW(),
                NOW()
            )
            ON CONFLICT (media_id, provider) DO UPDATE SET
                metadata = EXCLUDED.metadata,
                field_sources = EXCLUDED.field_sources,
                updated_at = NOW()
        `;
    }

    // ---- (e) INSERT of a new aggregated row → event emitted -----------------
    it('(e) INSERT of a new aggregated row emits one metadata.changed', async () => {
        const id = await newItem();
        await upsertAggregated(id, {
            overview: 'A heist goes wrong.',
            genres: [{ id: 80, name: 'Crime' }],
        });

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(1);
        expect(events[0].payload.changedFields).toEqual(['aggregated']);
    });

    // ---- (a) genres change → exactly one event ------------------------------
    it('(a) a genres change emits exactly one metadata.changed', async () => {
        const id = await newItem();
        await upsertAggregated(id, { genres: [{ id: 80, name: 'Crime' }] });
        // Clear the INSERT event so we measure only the UPDATE.
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        await upsertAggregated(id, {
            genres: [
                { id: 80, name: 'Crime' },
                { id: 9648, name: 'Mystery' },
            ],
        });

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(1);
        expect(events[0].payload.changedFields).toEqual(['genres']);
    });

    // ---- (b) keywords/overview change → event emitted -----------------------
    it('(b) keywords and overview changes emit metadata.changed', async () => {
        const id = await newItem();
        await upsertAggregated(id, {
            overview: 'Original overview.',
            keywords: ['heist'],
        });
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        await upsertAggregated(id, {
            overview: 'A revised, richer overview.',
            keywords: ['heist', 'double-cross'],
        });

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(1);
        // Both embedding-input fields changed; both reported (order = trigger order).
        expect(events[0].payload.changedFields).toEqual(['overview', 'keywords']);
    });

    // ---- (c) identical embedding fields, only fetched_at/updated_at differ ---
    //          → NO event  (the storm-prevention proof)
    it('(c) re-upsert with IDENTICAL embedding fields emits NO event', async () => {
        const id = await newItem();
        const content = {
            overview: 'A heist goes wrong.',
            genres: [{ id: 80, name: 'Crime' }],
            keywords: ['heist', 'double-cross'],
            mdblist_keywords: ['caper'],
            runtime_minutes: 124,
            actors: ['Alice', 'Bob'],
        };
        await upsertAggregated(id, content);
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        // Re-run aggregation: same content, but NOW() bumps fetched_at/updated_at.
        // Object key order is also shuffled to prove jsonb canonicalization makes
        // it a no-op (the real aggregator passes values through unchanged).
        await upsertAggregated(id, {
            genres: [{ name: 'Crime', id: 80 }],
            keywords: ['heist', 'double-cross'],
            overview: 'A heist goes wrong.',
            actors: ['Alice', 'Bob'],
            runtime_minutes: 124,
            mdblist_keywords: ['caper'],
        });

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(0);
    });

    // ---- (d) non-embedding field change only → NO event ---------------------
    it('(d) a display-only rating change (no embedding field) emits NO event', async () => {
        const id = await newItem();
        await upsertAggregated(id, {
            overview: 'A heist goes wrong.',
            genres: [{ id: 80, name: 'Crime' }],
            imdb_rating: 7.1,
            mdblist_score: 70,
        });
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        // Only the display/scoring fields move; embedding inputs are untouched.
        await upsertAggregated(
            id,
            {
                overview: 'A heist goes wrong.',
                genres: [{ id: 80, name: 'Crime' }],
                imdb_rating: 8.4,
                mdblist_score: 84,
            },
            // field_sources churn must also NOT trigger.
            { imdb_rating: 'tmdb', mdblist_score: 'mdblist' },
        );

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(0);
    });

    // ---- (+) non-aggregated provider rows are ignored ------------------------
    it('does NOT emit for a non-aggregated provider row (e.g. raw tmdb)', async () => {
        const id = await newItem();
        // Raw provider rows feed the aggregator, not the embedding directly.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${id}::uuid, 'tmdb', ${sql.json({ genres: [{ id: 80, name: 'Crime' }] })}, NOW(), NOW())
        `;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${id}::uuid, 'tmdb', ${sql.json({ genres: [{ id: 18, name: 'Drama' }] })}, NOW(), NOW())
            ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()
        `;

        const events = await changedEvents(sql, id);
        expect(events.length).toBe(0);
    });

    // ---- (+) flag gate: emission suppressed when outbox flag is off ----------
    it('emission is suppressed when the event_outbox flag is off', async () => {
        await sql`UPDATE feature_flags SET value = 'off' WHERE key = 'event_outbox_enabled'`;
        try {
            const id = await newItem();
            await upsertAggregated(id, { genres: [{ id: 80, name: 'Crime' }] });
            const events = await changedEvents(sql, id);
            expect(events.length).toBe(0);
        } finally {
            await sql`UPDATE feature_flags SET value = 'on' WHERE key = 'event_outbox_enabled'`;
        }
    });
});
