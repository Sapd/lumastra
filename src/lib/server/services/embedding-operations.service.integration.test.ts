// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for EmbeddingOperationsService.
 *
 * Uses the real `lumastra_tests` PostgreSQL database via `getTestDb()`.
 * External providers and lifecycle hooks are mocked so the tests
 * focus on the transactional multi-table write behaviour.
 *
 * Covered:
 *   upsertMediaEmbedding:
 *     - creates media_items + external_ids + provider_metadata in one transaction
 *     - is idempotent (second upsert updates, no duplicate rows)
 *     - throws for invalid (empty) title and leaves NO partial DB state
 *     - throws for zero/negative TMDB ID
 *     - stores IMDB and Jellyseerr external IDs when provided
 *     - stores embedding vector when provided
 *     - omits embedding gracefully when not provided
 *
 *   buildMediaEmbeddingFromUuid:
 *     - returns null for an unknown UUID
 *     - returns a fully assembled MediaEmbedding for a seeded item
 *
 *   batchBuildMediaEmbeddingsFromUuids:
 *     - returns an empty Map for an empty input array
 *     - returns entries for all existing UUIDs
 *     - silently omits UUIDs that do not exist
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import type { EmbeddingOperationsService } from './embedding-operations.service.js';
import { createEmbeddingOperationsService } from './embedding-operations.service.js';

// ---------------------------------------------------------------------------
// Mock MediaLifecycleService to prevent orchestrator/outbox side effects.
//
// ALL static methods must be listed — any missing method falls through to the
// real implementation, which imports and starts the orchestrator (TaskOrchestrator
// + PipelineEventDispatcher).  An active dispatcher drains event_outbox rows
// inserted by the DB trigger on media_items INSERT and writes to
// media_item_stage_state.  That races with the beforeEach TRUNCATE (which
// acquires AccessExclusiveLocks on media_items and its CASCADE children including
// media_item_stage_state), producing a deadlock between the two transactions.
//
// The vi.mock alias path is also insufficient to intercept the *relative* import
// of the same module in catalog.service.ts ('$lib/...' vs './media-lifecycle.service.js').
// The orchestrator and stage-state service are therefore mocked separately as the
// last-resort firewall: even if afterCreated runs for real, those mocks prevent
// the PipelineEventDispatcher from starting and prevent seedRowsForCreate from
// writing to media_item_stage_state.
// ---------------------------------------------------------------------------
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterCreated: vi.fn().mockResolvedValue(undefined),
        afterExternalIdChanged: vi.fn().mockResolvedValue(undefined),
        afterMatched: vi.fn().mockResolvedValue(undefined),
        afterContentChanged: vi.fn().mockResolvedValue(undefined),
        afterReclaimed: vi.fn().mockResolvedValue(undefined),
        onFileContentChanged: vi.fn().mockResolvedValue({ invalidatedMediaItemIds: [] }),
    },
}));

// Prevent the orchestrator (and its PipelineEventDispatcher) from starting.
// afterCreated() lazily imports orchestrator.js to get the startRun function;
// mocking it here means no dispatcher is ever created, no LISTEN connection is
// opened, and no event_outbox rows are processed concurrently with the test.
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: vi.fn().mockResolvedValue(undefined),
        isAnyLeader: vi.fn().mockReturnValue(false),
    },
}));

// Prevent seedRowsForCreate from writing to media_item_stage_state.
// media_item_stage_state has a CASCADE FK to media_items; the beforeEach
// TRUNCATE acquires AccessExclusiveLocks on both tables.  If seedRowsForCreate
// runs concurrently on a different connection it holds a RowExclusiveLock on
// media_item_stage_state while doing a FK-check RowShareLock on media_items —
// causing a deadlock with the TRUNCATE transaction.
vi.mock('$lib/server/services/stage-state.service.js', () => ({
    StageStateService: vi.fn().mockImplementation(() => ({
        seedRowsForCreate: vi.fn().mockResolvedValue(undefined),
        seedRowsForCreateBatch: vi.fn().mockResolvedValue(undefined),
        invalidateByEvent: vi.fn().mockResolvedValue(undefined),
        seedForDeletedItems: vi.fn().mockResolvedValue(undefined),
    })),
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));

// Mock plugin-context provider calls used by CatalogService so no real TMDB
// network requests fire during the advisory-lock / metadata-prefetch path.
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: vi.fn().mockReturnValue([]),
    invokeProviderDetail: vi.fn().mockResolvedValue(null),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
    invokeProviderSearch: vi.fn().mockResolvedValue([]),
}));

// Mock field-authority loader to avoid DB queries for plugin_settings.
vi.mock('$lib/server/plugins/runtime/field-authority-loader.js', () => ({
    buildFieldAuthorityConfigFromDefinitions: vi.fn().mockReturnValue({}),
    loadProviderSettingsCached: vi.fn().mockResolvedValue({}),
}));

// Discovery gate: upsertMediaEmbedding only creates a media_items row when
// isDiscoveryCatalogEnabled() is true. Default ON so the creation tests below
// exercise the write path; the gate test flips it off.
const discoveryGate = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    isDiscoveryCatalogEnabled: () => discoveryGate.enabled,
}));

// ---------------------------------------------------------------------------
// Tables cleaned between tests
// ---------------------------------------------------------------------------

const CLEANUP_TABLES = [
    'media_embeddings',
    'provider_metadata',
    'external_ids',
    'media_items',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { MediaEmbedding } from '$lib/server/database/connection.js';

/**
 * Generate a mock embedding vector of the dimension used by this database.
 * The test DB is configured at 1024 dimensions (voyage-3-large).
 */
function mockEmbedding(dims = 1024): number[] {
    return Array.from({ length: dims }, (_, i) => (i % 100) / 100);
}

/**
 * Extract the internal_id from a MediaEmbedding result, asserting it is set.
 * `upsertMediaEmbedding` always sets internal_id to the resolved UUID.
 */
function internalId(result: MediaEmbedding): string {
    if (!result.internal_id) throw new Error('upsertMediaEmbedding returned no internal_id');
    return result.internal_id;
}

/**
 * Build a minimal valid media object for upsertMediaEmbedding.
 * Merges overrides onto required-field defaults.
 */
function mediaInput(
    overrides: Partial<Omit<MediaEmbedding, 'id' | 'created_at' | 'updated_at' | 'media_type'>>,
): Omit<MediaEmbedding, 'id' | 'created_at' | 'updated_at' | 'media_type'> & {
    media_type?: 'movie' | 'tv';
} {
    return {
        tmdb_id: 0,
        title: 'Placeholder',
        genres: [],
        // MediaEmbedding.created_at and updated_at are excluded from Omit,
        // but they are required at runtime; the service ignores them in the
        // input so providing them as placeholders satisfies the type.
        ...overrides,
    } as Omit<MediaEmbedding, 'id' | 'created_at' | 'updated_at' | 'media_type'> & {
        media_type?: 'movie' | 'tv';
    };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('EmbeddingOperationsService (integration)', () => {
    let sql: postgres.Sql;
    let svc: EmbeddingOperationsService;

    beforeAll(() => {
        sql = getTestDb();
        svc = createEmbeddingOperationsService(sql);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, CLEANUP_TABLES);
    });

    // -----------------------------------------------------------------------
    // upsertMediaEmbedding — success path
    // -----------------------------------------------------------------------

    describe('upsertMediaEmbedding – discovery gate', () => {
        it('creates no media_items row when the discovery catalog is disabled', async () => {
            discoveryGate.enabled = false;
            try {
                await expect(
                    svc.upsertMediaEmbedding(
                        mediaInput({ tmdb_id: 90050, title: 'Gate Movie' }),
                        'movie',
                    ),
                ).rejects.toThrow(/Discovery catalog disabled/);
            } finally {
                discoveryGate.enabled = true;
            }
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE title = 'Gate Movie'
            `;
            expect(rows).toHaveLength(0);
        });

        it('still attaches the embedding to an existing row when disabled', async () => {
            const created = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: 90051, title: 'Gate Existing' }),
                'movie',
            );
            discoveryGate.enabled = false;
            try {
                const again = await svc.upsertMediaEmbedding(
                    mediaInput({ tmdb_id: 90051, title: 'Gate Existing' }),
                    'movie',
                );
                expect(again.internal_id).toBe(created.internal_id);
            } finally {
                discoveryGate.enabled = true;
            }
        });
    });

    describe('upsertMediaEmbedding – success', () => {
        it('creates a media_items row on first upsert', async () => {
            const tmdbId = 90001;
            await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Test Movie Alpha' }),
                'movie',
            );

            const rows = await sql<{ title: string }[]>`
                SELECT mi.title
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id
                WHERE ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
                  AND ei.media_type = 'movie'
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].title).toBe('Test Movie Alpha');
        });

        it('creates external_ids row for TMDB', async () => {
            const tmdbId = 90002;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Test Movie Beta' }),
                'movie',
            );

            const ids = await sql<{ provider: string; external_id: string }[]>`
                SELECT provider, external_id
                FROM external_ids
                WHERE media_id = ${internalId(result)}::uuid
            `;
            const tmdbRow = ids.find(
                (r: { provider: string; external_id: string }) => r.provider === 'tmdb',
            );
            expect(tmdbRow).toBeDefined();
            expect(tmdbRow?.external_id).toBe(String(tmdbId));
        });

        it('also stores IMDB external_id when imdb_id is supplied', async () => {
            const tmdbId = 90003;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Test Movie Gamma',
                    imdb_id: 'tt9999001',
                }),
                'movie',
            );

            const ids = await sql<{ provider: string; external_id: string }[]>`
                SELECT provider, external_id
                FROM external_ids
                WHERE media_id = ${internalId(result)}::uuid
            `;
            const imdbRow = ids.find(
                (r: { provider: string; external_id: string }) => r.provider === 'imdb',
            );
            expect(imdbRow).toBeDefined();
            expect(imdbRow?.external_id).toBe('tt9999001');
        });

        it('stores jellyseerr external_id when jellyseerr_id is supplied', async () => {
            const tmdbId = 90004;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Test Movie Delta',
                    jellyseerr_id: 777,
                }),
                'movie',
            );

            const ids = await sql<{ provider: string; external_id: string }[]>`
                SELECT provider, external_id
                FROM external_ids
                WHERE media_id = ${internalId(result)}::uuid
            `;
            const jsRow = ids.find(
                (r: { provider: string; external_id: string }) => r.provider === 'jellyseerr',
            );
            expect(jsRow).toBeDefined();
            expect(jsRow?.external_id).toBe('777');
        });

        it('stores provider_metadata when metadata fields are provided', async () => {
            const tmdbId = 90005;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Test Movie Epsilon',
                    overview: 'A great movie overview',
                    genres: [28, 12],
                    vote_average: 7.8,
                }),
                'movie',
            );

            const meta = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${internalId(result)}::uuid
            `;
            expect(meta.length).toBeGreaterThanOrEqual(1);
            expect(meta[0].metadata.overview).toBe('A great movie overview');
        });

        it('stores an embedding vector when embedding array is supplied', async () => {
            const tmdbId = 90006;
            // Use the correct dimension for this database (1024 for voyage-3-large).
            const embedding = mockEmbedding();
            const result = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Test Movie Zeta',
                    embedding,
                }),
                'movie',
            );

            const rows = await sql<{ source: string }[]>`
                SELECT source FROM media_embeddings
                WHERE media_id = ${internalId(result)}::uuid
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].source).toBe('library'); // default source
        });

        it('succeeds without embedding vector (embedding omitted)', async () => {
            const tmdbId = 90007;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Test Movie Eta' }),
                'movie',
            );

            const id = internalId(result);
            expect(id).toBeTruthy();
            expect(result.title).toBe('Test Movie Eta');

            // No embedding row should exist.
            const rows = await sql`
                SELECT id FROM media_embeddings WHERE media_id = ${id}::uuid
            `;
            expect(rows).toHaveLength(0);
        });

        it('returns a MediaEmbedding with correct title and tmdb_id', async () => {
            const tmdbId = 90008;
            const result = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Test Movie Theta' }),
                'movie',
            );

            expect(result.tmdb_id).toBe(tmdbId);
            expect(result.title).toBe('Test Movie Theta');
            expect(result.media_type).toBe('movie');
        });
    });

    // -----------------------------------------------------------------------
    // upsertMediaEmbedding — idempotency
    // -----------------------------------------------------------------------

    describe('upsertMediaEmbedding – idempotency', () => {
        it('is idempotent: second call updates the title without creating a duplicate row', async () => {
            const tmdbId = 91001;
            await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Original Title' }),
                'movie',
            );
            await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Updated Title' }),
                'movie',
            );

            const rows = await sql<{ title: string }[]>`
                SELECT mi.title
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id
                WHERE ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
                  AND ei.media_type = 'movie'
            `;
            // Exactly one row — no duplicate.
            expect(rows).toHaveLength(1);
            expect(rows[0].title).toBe('Updated Title');
        });

        it('second call with same embedding overwrites existing embedding (no duplicate)', async () => {
            const tmdbId = 91002;
            await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Embed Idempotent',
                    embedding: mockEmbedding(),
                }),
                'movie',
            );
            await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Embed Idempotent',
                    embedding: mockEmbedding(),
                }),
                'movie',
            );

            const rows = await sql<{ media_id: string }[]>`
                SELECT me.media_id FROM media_embeddings me
                JOIN external_ids ei ON ei.media_id = me.media_id
                WHERE ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
            `;
            // Exactly one embedding row.
            expect(rows).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------------
    // upsertMediaEmbedding — error paths (no partial DB state)
    // -----------------------------------------------------------------------

    describe('upsertMediaEmbedding – error paths', () => {
        it('throws for an empty title and leaves NO media_items row', async () => {
            const tmdbId = 92001;
            await expect(
                svc.upsertMediaEmbedding(mediaInput({ tmdb_id: tmdbId, title: '' }), 'movie'),
            ).rejects.toThrow(/invalid title/i);

            // No media_item row should have been created.
            const rows = await sql`
                SELECT mi.id FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id
                WHERE ei.provider = 'tmdb' AND ei.external_id = ${String(tmdbId)}
            `;
            expect(rows).toHaveLength(0);
        });

        it('throws for a whitespace-only title', async () => {
            await expect(
                svc.upsertMediaEmbedding(mediaInput({ tmdb_id: 92002, title: '   ' }), 'movie'),
            ).rejects.toThrow();
        });

        it('throws for the literal string "undefined" as title', async () => {
            await expect(
                svc.upsertMediaEmbedding(
                    mediaInput({ tmdb_id: 92003, title: 'undefined' }),
                    'movie',
                ),
            ).rejects.toThrow();
        });

        it('throws for a zero TMDB ID (invalid)', async () => {
            await expect(
                svc.upsertMediaEmbedding(
                    mediaInput({ tmdb_id: 0, title: 'Zero ID Film' }),
                    'movie',
                ),
            ).rejects.toThrow(/missing valid tmdb id/i);
        });

        it('throws for a negative TMDB ID (invalid)', async () => {
            await expect(
                svc.upsertMediaEmbedding(
                    mediaInput({ tmdb_id: -1, title: 'Negative ID Film' }),
                    'movie',
                ),
            ).rejects.toThrow(/missing valid tmdb id/i);
        });
    });

    // -----------------------------------------------------------------------
    // buildMediaEmbeddingFromUuid
    // -----------------------------------------------------------------------

    describe('buildMediaEmbeddingFromUuid', () => {
        it('returns null for a UUID that does not exist', async () => {
            const result = await svc.buildMediaEmbeddingFromUuid(crypto.randomUUID());
            expect(result).toBeNull();
        });

        it('returns null for the nil UUID', async () => {
            const result = await svc.buildMediaEmbeddingFromUuid(
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });

        it('returns a MediaEmbedding for an existing media item', async () => {
            // Seed directly to control exact state.
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status)
                VALUES (${mediaId}::uuid, 'Build Test Film', 'movie', 2020, 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${mediaId}::uuid, 'tmdb', '99881', 'movie')
            `;

            const result = await svc.buildMediaEmbeddingFromUuid(mediaId);

            expect(result).not.toBeNull();
            expect(result?.title).toBe('Build Test Film');
            expect(result?.media_type).toBe('movie');
            expect(result?.tmdb_id).toBe(99881);
            expect(result?.release_year).toBe(2020);
        });

        it('populates embedding fields when an embedding row exists', async () => {
            const tmdbId = 93001;
            const embedding = mockEmbedding();
            const upserted = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: tmdbId,
                    title: 'Embed Build Film',
                    embedding,
                }),
                'movie',
            );

            const result = await svc.buildMediaEmbeddingFromUuid(internalId(upserted));
            expect(result?.library_embedding).toBeDefined();
            expect(Array.isArray(result?.library_embedding)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // batchBuildMediaEmbeddingsFromUuids
    // -----------------------------------------------------------------------

    describe('batchBuildMediaEmbeddingsFromUuids', () => {
        it('returns an empty Map for an empty input', async () => {
            const result = await svc.batchBuildMediaEmbeddingsFromUuids([]);
            expect(result.size).toBe(0);
        });

        it('returns entries for existing UUIDs', async () => {
            const tmdbId1 = 94001;
            const tmdbId2 = 94002;
            const r1 = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId1, title: 'Batch Film 1' }),
                'movie',
            );
            const r2 = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId2, title: 'Batch Film 2' }),
                'tv',
            );

            const id1 = internalId(r1);
            const id2 = internalId(r2);
            const batchResult = await svc.batchBuildMediaEmbeddingsFromUuids([id1, id2]);

            expect(batchResult.size).toBe(2);
            expect(batchResult.get(id1)?.title).toBe('Batch Film 1');
            expect(batchResult.get(id2)?.title).toBe('Batch Film 2');
        });

        it('silently omits UUIDs that do not exist', async () => {
            const tmdbId = 94003;
            const existing = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Existing Batch Film' }),
                'movie',
            );
            const existingId = internalId(existing);
            const missingId = crypto.randomUUID();

            const batchResult = await svc.batchBuildMediaEmbeddingsFromUuids([
                existingId,
                missingId,
            ]);

            expect(batchResult.size).toBe(1);
            expect(batchResult.has(existingId)).toBe(true);
            expect(batchResult.has(missingId)).toBe(false);
        });

        it('deduplicates duplicate UUIDs in input', async () => {
            const tmdbId = 94004;
            const r = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: tmdbId, title: 'Dedup Batch Film' }),
                'movie',
            );
            const rid = internalId(r);
            // Pass the same UUID three times.
            const batchResult = await svc.batchBuildMediaEmbeddingsFromUuids([rid, rid, rid]);

            expect(batchResult.size).toBe(1);
        });

        it('drops falsy ids without throwing (empty string would crash the uuid[] cast)', async () => {
            const r = await svc.upsertMediaEmbedding(
                mediaInput({ tmdb_id: 94005, title: 'Falsy Filter Film' }),
                'movie',
            );
            const rid = internalId(r);
            // '' would throw `invalid input syntax for type uuid` on the
            // `ANY($1::uuid[])` cast; null/undefined silently never match. The
            // choke-point filter must drop all three and still resolve the valid id.
            const batchResult = await svc.batchBuildMediaEmbeddingsFromUuids([
                rid,
                '',
                null as unknown as string,
                undefined as unknown as string,
            ]);

            expect(batchResult.size).toBe(1);
            expect(batchResult.has(rid)).toBe(true);
        });

        it('returns an empty map for an all-falsy input (no DB round-trip needed)', async () => {
            const batchResult = await svc.batchBuildMediaEmbeddingsFromUuids([
                '',
                null as unknown as string,
            ]);
            expect(batchResult.size).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Builder parity: batch MUST be field-identical to single.
    //
    // The recommendations N+1 fix swaps per-item buildMediaEmbeddingFromUuid()
    // for batchBuildMediaEmbeddingsFromUuids(). For that swap to be a pure perf
    // change with zero output drift, the two builders must produce byte-equal
    // MediaEmbedding objects for the same UUID across every shape of seeded
    // state. These tests lock that contract in (esp. the internal_id field,
    // which the batch builder historically omitted).
    // -----------------------------------------------------------------------

    describe('builder parity (single vs batch)', () => {
        /** Single and batch must agree exactly for one UUID. */
        async function expectParity(mediaId: string): Promise<void> {
            const single = await svc.buildMediaEmbeddingFromUuid(mediaId);
            const batchMap = await svc.batchBuildMediaEmbeddingsFromUuids([mediaId]);
            const batch = batchMap.get(mediaId) ?? null;
            expect(batch).toEqual(single);
        }

        it('agree for a fully-populated movie (metadata + embedding + imdb + jellyseerr)', async () => {
            const upserted = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: 95001,
                    title: 'Parity Full Movie',
                    imdb_id: 'tt9500001',
                    jellyseerr_id: 5001,
                    overview: 'Full overview for parity',
                    genres: [28, 12, 878],
                    vote_average: 8.1,
                    vote_count: 1234,
                    runtime_minutes: 142,
                    actors: ['Actor A', 'Actor B'],
                    directors: ['Dir A'],
                    keywords: ['heist', 'twist'],
                    certification: 'PG-13',
                    poster_path: '/poster.jpg',
                    backdrop_path: '/backdrop.jpg',
                    imdb_rating: 8.0,
                    rt_rating: 91,
                    embedding: mockEmbedding(),
                }),
                'movie',
            );
            const id = internalId(upserted);

            const single = await svc.buildMediaEmbeddingFromUuid(id);
            const batch = (await svc.batchBuildMediaEmbeddingsFromUuids([id])).get(id) ?? null;

            // internal_id must be set and equal on BOTH (the historical gap).
            expect(single?.internal_id).toBe(id);
            expect(batch?.internal_id).toBe(id);
            // And the whole object must be identical.
            expect(batch).toEqual(single);
        });

        it('agree for a minimal active movie (no metadata, no embedding, tmdb only)', async () => {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, year, status)
                VALUES (${mediaId}::uuid, 'Parity Minimal', 'movie', 1999, 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${mediaId}::uuid, 'tmdb', '95002', 'movie')
            `;
            await expectParity(mediaId);
        });

        it('agree for a tv item with provider metadata', async () => {
            const upserted = await svc.upsertMediaEmbedding(
                mediaInput({
                    tmdb_id: 95003,
                    title: 'Parity TV Show',
                    overview: 'TV overview',
                    genres: [18, 10765],
                    networks: ['Lanternbox'],
                }),
                'tv',
            );
            await expectParity(internalId(upserted));
        });

        it('agree for an item with NO external ids (tmdb_id/imdb null)', async () => {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, 'Parity No External', 'movie', 'active')
            `;
            const single = await svc.buildMediaEmbeddingFromUuid(mediaId);
            const batch =
                (await svc.batchBuildMediaEmbeddingsFromUuids([mediaId])).get(mediaId) ?? null;
            expect(single?.tmdb_id).toBeNull();
            expect(batch).toEqual(single);
        });

        it('agree (both empty) for a non-active (deleted) item: single null AND batch absent', async () => {
            const mediaId = crypto.randomUUID();
            // 'deleted' is excluded by the status='active' filter both builders apply.
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, 'Parity Deleted', 'movie', 'deleted')
            `;
            const single = await svc.buildMediaEmbeddingFromUuid(mediaId);
            const batchMap = await svc.batchBuildMediaEmbeddingsFromUuids([mediaId]);
            expect(single).toBeNull();
            expect(batchMap.has(mediaId)).toBe(false);
        });

        it('agree across a MIXED batch (full, minimal, missing) — each entry matches its single build', async () => {
            const full = internalId(
                await svc.upsertMediaEmbedding(
                    mediaInput({
                        tmdb_id: 95004,
                        title: 'Mixed Full',
                        overview: 'mixed',
                        genres: [35],
                        embedding: mockEmbedding(),
                    }),
                    'movie',
                ),
            );
            const minimal = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${minimal}::uuid, 'Mixed Minimal', 'tv', 'active')
            `;
            const missing = crypto.randomUUID();

            const batchMap = await svc.batchBuildMediaEmbeddingsFromUuids([full, minimal, missing]);

            expect(batchMap.get(full)).toEqual(await svc.buildMediaEmbeddingFromUuid(full));
            expect(batchMap.get(minimal)).toEqual(await svc.buildMediaEmbeddingFromUuid(minimal));
            expect(batchMap.has(missing)).toBe(false);
            expect(await svc.buildMediaEmbeddingFromUuid(missing)).toBeNull();
        });
    });
});
