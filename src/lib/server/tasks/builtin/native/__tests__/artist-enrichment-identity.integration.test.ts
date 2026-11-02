// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { Logger } from '../../../../utils/logger.js';
import { CatalogService } from '../../../../services/catalog.service.js';
import { buildAdminContextStub } from '../../../plugin-context.js';
import { upsertTaskSettings } from '../../../../database/queries/task-settings.queries.js';
import {
    recordFailure,
    markFailureEventsResolved,
} from '../../../../database/queries/plugin-failure-events.queries.js';
import * as artistSources from '../../../../services/artist-enrichment-sources.js';
import * as artistQueries from '../../../../database/queries/artist-enrichment.queries.js';
import {
    ArtistEnrichmentIncompleteError,
    EnrichmentSourceUnavailableError,
} from '../../../../services/artist-enrichment.types.js';
import type { ArtistEnrichmentResult } from '../../../../services/artist-enrichment.types.js';
import { artistEnrichmentTask, enrichOneArtist } from '../artist-enrichment.js';

// Only provider HTTP is mocked. Identity reads/locks, catalogue writes, metadata,
// provenance, stage markers and failure history run against PostgreSQL.
const { audioDb, deezer } = vi.hoisted(() => ({ audioDb: vi.fn(), deezer: vi.fn() }));
vi.mock('../../../../services/theaudiodb-api.js', () => ({ searchArtist: audioDb }));
vi.mock('../../../../services/deezer-api.js', () => ({ searchArtistDeezer: deezer }));

const KNOWN = '10000000-0000-4000-8000-000000000001';
const RIVAL = '10000000-0000-4000-8000-000000000002';
const IMAGE = 'https://images.example.test/correct.jpg';
interface SavedArtist {
    title: string;
    custom_poster_url: string | null;
    custom_backdrop_url: string | null;
    custom_metadata: {
        artist_enrichment?: { biography?: string; provenance?: unknown };
    };
    processing_state: Record<string, { status?: string }>;
    identities: unknown[] | null;
    stages: Array<{ status: string }> | null;
}
interface SavedIdentity {
    external_id: string;
    source: string;
    confidence: number;
}

function result(overrides: Partial<ArtistEnrichmentResult> = {}): ArtistEnrichmentResult {
    return {
        thumbUrl: IMAGE,
        fanartUrl: null,
        bannerUrl: null,
        musicBrainzId: null,
        biography: 'Correct artist biography',
        genre: 'Jazz',
        countryCode: 'DE',
        ...overrides,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('artist enrichment preserves established identity (PostgreSQL)', () => {
    let sql: postgres.Sql;
    let writer: postgres.Sql;
    let reader: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
        // A distinct connection proves corrections commit during the HTTP wait.
        writer = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
        reader = postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    });
    afterAll(async () => {
        await writer.end();
        await reader.end();
        await closeTestDb();
    });
    beforeEach(async () => {
        vi.restoreAllMocks();
        audioDb.mockReset().mockResolvedValue(null);
        deezer.mockReset().mockResolvedValue(null);
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'plugin_failure_events',
            'plugin_settings',
        ]);
    });

    async function seed(identity: string | null = KNOWN): Promise<{ id: string; title: string }> {
        const artist = createTestArtist({ title: 'Synthetic Identity Artist' });
        await insertTestArtist(sql, artist);
        if (identity)
            await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(
                artist.id,
                {
                    provider: 'musicbrainz',
                    id: identity,
                    mediaType: 'artist',
                    source: 'acoustid-fingerprint',
                    confidence: 0.93,
                },
            );
        return artist;
    }
    async function state(id: string): Promise<SavedArtist | undefined> {
        const [row] = await sql<SavedArtist[]>`
            SELECT mi.title, mi.custom_poster_url, mi.custom_backdrop_url, mi.custom_metadata,
                   mi.processing_state,
                   (SELECT jsonb_agg(to_jsonb(e)) FROM external_ids e WHERE e.media_id = mi.id) AS identities,
                   (SELECT jsonb_agg(to_jsonb(s)) FROM media_item_stage_state s
                    WHERE s.media_item_id = mi.id AND s.stage_id = 'artist-enrichment') AS stages
            FROM media_items mi WHERE mi.id = ${id}::uuid
        `;
        return row;
    }
    async function run(artist: {
        id: string;
        title: string;
    }): Promise<Awaited<ReturnType<typeof enrichOneArtist>>> {
        return enrichOneArtist(
            sql,
            Logger.for('ArtistEnrichmentIdentityTest'),
            artist,
            ['theaudiodb', 'deezer'],
            '',
        );
    }
    async function identity(id: string): Promise<SavedIdentity | undefined> {
        const [row] = await sql<
            SavedIdentity[]
        >`SELECT * FROM external_ids WHERE media_id = ${id}::uuid AND provider = 'musicbrainz' AND media_type = 'artist'`;
        return row;
    }

    it('rejects a rival payload, uses valid fallback, and keeps both artists and identity provenance', async () => {
        const artist = await seed();
        const other = createTestArtist({ title: 'Synthetic Rival Artist' });
        await insertTestArtist(sql, other);
        await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(other.id, {
            provider: 'musicbrainz',
            id: RIVAL,
            mediaType: 'artist',
        });
        const originalIdentity = await identity(artist.id);
        const otherBefore = await state(other.id);
        audioDb.mockResolvedValue(
            result({
                musicBrainzId: RIVAL,
                thumbUrl: 'https://wrong.example.test/rival.jpg',
                biography: 'Rival biography',
            }),
        );
        deezer.mockResolvedValue(result());
        expect(await run(artist)).toEqual({ status: 'enriched', advanced: true });
        expect(await identity(artist.id)).toEqual(originalIdentity);
        expect(await state(other.id)).toEqual(otherBefore);
        const saved = await state(artist.id);
        expect(saved?.custom_poster_url).toBe(IMAGE);
        expect(saved?.custom_metadata.artist_enrichment).toMatchObject({
            biography: 'Correct artist biography',
            provenance: { poster: { provider: 'deezer', value: IMAGE } },
        });
        expect(await sql`SELECT id FROM media_items WHERE media_type = 'artist'`).toHaveLength(2);
    });

    it('does not rewrite fingerprint identity source, confidence, or row when a source confirms it', async () => {
        const artist = await seed();
        const before = await identity(artist.id);
        audioDb.mockResolvedValue(result({ musicBrainzId: KNOWN }));
        expect((await run(artist)).status).toBe('enriched');
        expect(await identity(artist.id)).toEqual(before);
    });

    it('still discovers a new identity and stores metadata atomically', async () => {
        const artist = await seed(null);
        const writeIdentity = vi.spyOn(CatalogService.prototype, 'upsertExternalIdDetailed');
        audioDb.mockResolvedValue(result({ musicBrainzId: KNOWN }));
        expect((await run(artist)).status).toBe('enriched');
        expect(writeIdentity).toHaveBeenCalledWith(
            artist.id,
            expect.objectContaining({ id: KNOWN }),
            false,
            { preserveExisting: true },
        );
        expect(await identity(artist.id)).toMatchObject({ external_id: KNOWN, source: 'api' });
        expect((await state(artist.id))?.custom_poster_url).toBe(IMAGE);
    });

    it.each([KNOWN, null])(
        'discards stale fetched metadata after a concurrent correction (initial=%s)',
        async (initial) => {
            const artist = await seed(initial);
            const entered = deferred<void>();
            const reply = deferred<ArtistEnrichmentResult>();
            audioDb.mockImplementation(async () => {
                entered.resolve();
                return reply.promise;
            });
            const pending = run(artist);
            await entered.promise;
            await new CatalogService(writer, { skipLifecycleHooks: true }).upsertExternalId(
                artist.id,
                {
                    provider: 'musicbrainz',
                    id: RIVAL,
                    mediaType: 'artist',
                    source: 'manual',
                },
            );
            const corrected = await state(artist.id);
            reply.resolve(result({ musicBrainzId: KNOWN }));
            expect(await pending).toMatchObject({
                status: 'deferred',
                advanced: false,
                detail: expect.stringContaining('identity changed'),
            });
            expect(await state(artist.id)).toEqual(corrected);
            expect(
                await sql`SELECT id FROM plugin_failure_events WHERE item_id = ${artist.id}`,
            ).toHaveLength(0);
            // A subsequent run can complete using the corrected identity.
            audioDb.mockResolvedValue(result({ musicBrainzId: RIVAL }));
            expect((await run(artist)).status).toBe('enriched');
            expect(await identity(artist.id)).toMatchObject({
                external_id: RIVAL,
                source: 'manual',
            });
        },
    );

    it('does not tombstone a newly corrected identity after an in-flight no-match', async () => {
        const artist = await seed();
        const entered = deferred<void>();
        const reply = deferred<null>();
        audioDb.mockImplementation(async () => {
            entered.resolve();
            return reply.promise;
        });
        const pending = run(artist);
        await entered.promise;
        await new CatalogService(writer, { skipLifecycleHooks: true }).upsertExternalId(artist.id, {
            provider: 'musicbrainz',
            id: RIVAL,
            mediaType: 'artist',
            source: 'manual',
        });
        const corrected = await state(artist.id);
        reply.resolve(null);
        expect(await pending).toMatchObject({ status: 'deferred', advanced: false });
        expect(await state(artist.id)).toEqual(corrected);
    });

    it('rolls back discovery and artwork when the success marker cannot be written', async () => {
        const artist = await seed(null);
        audioDb.mockResolvedValue(result({ musicBrainzId: KNOWN }));
        vi.spyOn(artistQueries, 'markArtistProcessed').mockResolvedValueOnce(false);
        expect((await run(artist)).status).toBe('error');
        expect(await identity(artist.id)).toBeUndefined();
        const saved = await state(artist.id);
        expect(saved?.custom_poster_url).toBeNull();
        expect(saved?.custom_metadata.artist_enrichment).toBeUndefined();
        expect(saved?.processing_state['artist-enrichment'].status).toBe('failed');
    });

    it('does not reassign an identity already owned by another artist or leave partial metadata', async () => {
        const artist = await seed(null);
        const other = createTestArtist({ title: 'Synthetic Existing Owner' });
        await insertTestArtist(sql, other);
        await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(other.id, {
            provider: 'musicbrainz',
            id: KNOWN,
            mediaType: 'artist',
        });
        const ownerBefore = await state(other.id);
        audioDb.mockResolvedValue(result({ musicBrainzId: KNOWN }));
        expect((await run(artist)).status).toBe('error');
        expect(await identity(artist.id)).toBeUndefined();
        expect((await state(artist.id))?.custom_poster_url).toBeNull();
        expect((await state(artist.id))?.custom_metadata.artist_enrichment).toBeUndefined();
        expect(await state(other.id)).toEqual(ownerBefore);
    });

    it.each(['fallback', 'no-match'])(
        'admin retry reaches truthful %s and old failure history remains resolvable',
        async (mode) => {
            const artist = await seed();
            const originalIdentity = await identity(artist.id);
            await artistQueries.markArtistProcessed(
                sql,
                artist.id,
                5,
                'failed',
                'Old enrichment failure',
            );
            await recordFailure(
                sql,
                'artist-enrichment',
                artist.id,
                'Old enrichment failure',
                null,
            );
            await upsertTaskSettings(sql, 'artist-enrichment', {
                primary_source: 'theaudiodb',
                fallback_source: 'none',
                tertiary_source: 'deezer',
            });
            audioDb.mockResolvedValue(result({ musicBrainzId: RIVAL }));
            if (mode === 'fallback') deezer.mockResolvedValue(result());
            const ctx = { ...buildAdminContextStub('artist-enrichment', { sql }), input: {} };
            await expect(
                artistEnrichmentTask.failures!.retry!(ctx, artist.id),
            ).resolves.toBeUndefined();
            // This is the existing admin retry endpoint's success-resolution step.
            expect(await markFailureEventsResolved(sql, 'artist-enrichment', artist.id)).toBe(1);
            expect(await identity(artist.id)).toEqual(originalIdentity);
            const [event] =
                await sql`SELECT reason, resolved_at FROM plugin_failure_events WHERE item_id = ${artist.id}`;
            expect(event?.reason).toBe('Old enrichment failure');
            expect(event?.resolved_at).not.toBeNull();
            const saved = await state(artist.id);
            expect(saved?.stages?.[0]?.status).toBe(
                mode === 'fallback' ? 'completed' : 'skipped_permanent',
            );
            if (mode === 'no-match') {
                expect(saved?.custom_poster_url).toBeNull();
                expect(saved?.processing_state['artist-enrichment'].status).toBe('no-match');
            }
        },
    );

    it.each(['replace', 'remove', 'insert'] as const)(
        'serializes actual %s contention without aborting the operator and holds locks until commit',
        async (mode) => {
            const artist = await seed(mode === 'insert' ? null : KNOWN);
            const [{ pid: writerPid }] = await writer<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const [{ pid: readerPid }] = await reader<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const mutationHeld = deferred<void>();
            const finishMutation = deferred<void>();
            const identityRead = deferred<string | null>();
            const finishRead = deferred<void>();
            const mutation = writer
                .begin(async (tx) => {
                    await tx`SET LOCAL statement_timeout = '5s'`;
                    const catalog = new CatalogService(tx, { skipLifecycleHooks: true });
                    if (mode === 'insert') {
                        await catalog.upsertExternalId(artist.id, {
                            provider: 'musicbrainz',
                            id: RIVAL,
                            mediaType: 'artist',
                            source: 'manual',
                        });
                    } else {
                        // The sanctioned delete plus replacement use the same lock
                        // order as upsertExternalIdDetailed's stale mapping path.
                        await catalog.deleteExternalId(artist.id, 'musicbrainz', 'artist');
                    }
                    mutationHeld.resolve();
                    await finishMutation.promise;
                    if (mode === 'replace')
                        await catalog.upsertExternalId(artist.id, {
                            provider: 'musicbrainz',
                            id: RIVAL,
                            mediaType: 'artist',
                            source: 'manual',
                        });
                })
                .then(
                    () => ({ ok: true }),
                    (error: unknown) => ({ error }),
                );
            await mutationHeld.promise;
            const reading = reader
                .begin(async (tx) => {
                    await tx`SET LOCAL statement_timeout = '5s'`;
                    const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                    const value = await artistQueries.getArtistMusicBrainzId(
                        txSql,
                        artist.id,
                        true,
                    );
                    identityRead.resolve(value);
                    await finishRead.promise;
                    return value;
                })
                .then(
                    (value) => ({ value }),
                    (error: unknown) => ({ error }),
                );
            let nextMutation: Promise<boolean> | undefined;
            try {
                // Observe a real PostgreSQL waiter before allowing the writer
                // to request its replacement's parent FK lock.
                await vi.waitFor(
                    async () => {
                        const [row] = await sql<
                            { blocking: number[] }[]
                        >`SELECT pg_blocking_pids(${readerPid}::int) AS blocking`;
                        expect(row?.blocking).toContain(writerPid);
                    },
                    { timeout: 2000, interval: 10 },
                );
                finishMutation.resolve();
                expect(await mutation).toEqual({ ok: true });
                const readResult = await Promise.race([
                    identityRead.promise,
                    reading.then((outcome) => {
                        if ('error' in outcome) throw outcome.error;
                        return outcome.value;
                    }),
                ]);
                expect(readResult).toBe(mode === 'remove' ? null : RIVAL);

                // Even an initially empty mapping is protected by the parent
                // lock: a new operator write waits until this transaction ends.
                nextMutation = new CatalogService(writer, {
                    skipLifecycleHooks: true,
                }).upsertExternalId(artist.id, {
                    provider: 'musicbrainz',
                    id: KNOWN,
                    mediaType: 'artist',
                    source: 'manual',
                });
                await vi.waitFor(
                    async () => {
                        const [row] = await sql<
                            { blocking: number[] }[]
                        >`SELECT pg_blocking_pids(${writerPid}::int) AS blocking`;
                        expect(row?.blocking).toContain(readerPid);
                    },
                    { timeout: 2000, interval: 10 },
                );
                finishRead.resolve();
                expect(await nextMutation).toBe(true);
                expect(await reading).toEqual({ value: readResult });
                expect(await identity(artist.id)).toMatchObject({
                    external_id: KNOWN,
                    source: 'manual',
                });
            } finally {
                finishMutation.resolve();
                finishRead.resolve();
                await Promise.allSettled([mutation, reading, nextMutation]);
            }
        },
    );

    it.each(['success', 'no-match'] as const)(
        'discards %s after concurrent identity removal',
        async (mode) => {
            const artist = await seed();
            const entered = deferred<void>();
            const reply = deferred<ArtistEnrichmentResult | null>();
            audioDb.mockImplementation(async () => {
                entered.resolve();
                return reply.promise;
            });
            const pending = run(artist);
            await entered.promise;
            await new CatalogService(writer, { skipLifecycleHooks: true }).deleteExternalId(
                artist.id,
                'musicbrainz',
                'artist',
            );
            const corrected = await state(artist.id);
            reply.resolve(mode === 'success' ? result({ musicBrainzId: KNOWN }) : null);
            expect(await pending).toMatchObject({ status: 'deferred', advanced: false });
            expect(await state(artist.id)).toEqual(corrected);
        },
    );

    it.each(['outage', 'error'] as const)(
        'does not replace fresh invalidation with a stale %s',
        async (mode) => {
            const artist = await seed();
            await artistQueries.markArtistProcessed(
                sql,
                artist.id,
                5,
                'failed',
                'Previous failure',
            );
            const entered = deferred<void>();
            const release = deferred<void>();
            if (mode === 'outage') {
                audioDb.mockImplementation(async () => {
                    entered.resolve();
                    await release.promise;
                    throw new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 503');
                });
            } else {
                // Fault injection at the chain boundary reaches the task's outer
                // catch; ordinary provider exceptions are classified as outages.
                vi.spyOn(artistSources, 'enrichArtistFromChain').mockImplementationOnce(
                    async () => {
                        entered.resolve();
                        await release.promise;
                        throw new Error('Synthetic enrichment chain failure');
                    },
                );
            }
            const pending = run(artist);
            await entered.promise;
            await writer.begin(async (tx) => {
                await new CatalogService(tx, { skipLifecycleHooks: true }).upsertExternalId(
                    artist.id,
                    {
                        provider: 'musicbrainz',
                        id: RIVAL,
                        mediaType: 'artist',
                        source: 'manual',
                    },
                );
                await tx`UPDATE media_items SET processing_state = processing_state - 'artist-enrichment' WHERE id = ${artist.id}::uuid`;
                await tx`INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version, invalidated_at)
                VALUES (${artist.id}::uuid, 'artist-enrichment', 'pending', 5, now())
                ON CONFLICT (media_item_id, stage_id) DO UPDATE SET status = 'pending', invalidated_at = now()`;
            });
            const corrected = await state(artist.id);
            release.resolve();
            expect(await pending).toMatchObject({
                status: 'deferred',
                advanced: false,
                detail: expect.stringContaining('identity changed'),
            });
            expect(await state(artist.id)).toEqual(corrected);
            expect(
                await sql`SELECT id FROM plugin_failure_events WHERE item_id = ${artist.id}`,
            ).toHaveLength(0);
        },
    );

    it.each(['success', 'no-match', 'error'] as const)(
        'survives a real SQL coverage-write failure for %s using a savepoint',
        async (mode) => {
            const artist = await seed();
            if (mode === 'success') audioDb.mockResolvedValue(result({ musicBrainzId: KNOWN }));
            if (mode === 'error')
                vi.spyOn(artistSources, 'enrichArtistFromChain').mockRejectedValueOnce(
                    new Error('Synthetic enrichment failure'),
                );
            await sql`ALTER TABLE media_item_stage_state ADD CONSTRAINT artist_identity_test_reject_coverage
            CHECK (stage_id <> 'artist-enrichment') NOT VALID`;
            try {
                expect(await run(artist)).toEqual({
                    status: mode === 'success' ? 'enriched' : mode,
                    advanced: true,
                });
                const saved = await state(artist.id);
                expect(saved?.processing_state['artist-enrichment'].status).toBe(
                    mode === 'success' ? undefined : mode === 'error' ? 'failed' : 'no-match',
                );
                expect(saved?.custom_poster_url).toBe(mode === 'success' ? IMAGE : null);
                expect(
                    await sql`SELECT id FROM plugin_failure_events WHERE item_id = ${artist.id}`,
                ).toHaveLength(mode === 'error' ? 1 : 0);
                expect(saved?.stages).toBeNull();
                expect(await identity(artist.id)).toMatchObject({
                    external_id: KNOWN,
                    source: 'acoustid-fingerprint',
                });
            } finally {
                await sql`ALTER TABLE media_item_stage_state DROP CONSTRAINT artist_identity_test_reject_coverage`;
            }
        },
    );

    it('keeps source outages deferred and aborts non-terminal', async () => {
        const artist = await seed();
        audioDb.mockRejectedValue(new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 503'));
        const before = await state(artist.id);
        expect((await run(artist)).status).toBe('deferred');
        expect((await state(artist.id))?.processing_state).toEqual(before?.processing_state);
        const signal = new AbortController();
        signal.abort();
        expect(
            await enrichOneArtist(
                sql,
                Logger.for('ArtistEnrichmentIdentityTest'),
                artist,
                ['theaudiodb'],
                '',
                signal.signal,
            ),
        ).toMatchObject({
            status: 'deferred',
            advanced: false,
            detail: new ArtistEnrichmentIncompleteError('aborted', []).message,
        });
    });
});
