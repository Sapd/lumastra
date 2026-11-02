// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment-sources unit tests.
 *
 * Tests for `enrichAlbumFromChain` — the source-chain executor.
 * No database; all external calls are mocked at module-import level.
 *
 * Covers:
 *   1. First non-null field wins per slot (merge semantics).
 *   2. Early stop: when poster + at least one MBID are filled after a source,
 *      the next source is NOT called.
 *   3. Returns null when no source returns any data.
 *   4. Abort signal: when signal.aborted=true between sources, the second
 *      source is not called; a partial result with a poster is returned, and
 *      without one the chain throws AlbumEnrichmentIncompleteError('aborted').
 *   6. A source that throws EnrichmentSourceUnavailableError does not stop the
 *      chain; with no poster at the end the chain throws
 *      AlbumEnrichmentIncompleteError('source-unavailable') instead of
 *      returning null, which the task would record as a permanent no-match.
 *   5. Discogs is skipped (returns null) when token is empty — the chain
 *      calls fetchFromSource which delegates to searchReleaseDiscogs, which
 *      returns null for an empty token. The chain merges zero fields and
 *      returns null overall when that is the only source with data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module-level mocks (hoisted before imports) ─────────────────────────────

const { mockSearchAlbum, mockSearchReleaseDiscogs } = vi.hoisted(() => ({
    mockSearchAlbum: vi.fn(),
    mockSearchReleaseDiscogs: vi.fn(),
}));

vi.mock('../theaudiodb-api.js', () => ({
    searchAlbum: mockSearchAlbum,
}));

vi.mock('../discogs-api.js', () => ({
    searchReleaseDiscogs: mockSearchReleaseDiscogs,
}));

vi.mock('../deezer-api.js', () => ({ searchAlbumDeezer: vi.fn() }));

// ─── Import the subject under test ───────────────────────────────────────────

import { searchAlbumDeezer } from '../deezer-api.js';
import { enrichAlbumFromChain } from '../album-enrichment-sources.js';
import { AlbumEnrichmentIncompleteError } from '../album-enrichment.types.js';
import { EnrichmentSourceUnavailableError } from '../artist-enrichment.types.js';
import { EnrichmentSourceBreaker } from '../enrichment-source-breaker.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ARTIST = 'Milo Fenwick';
const ALBUM = 'Kind of Dawn';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('enrichAlbumFromChain', () => {
    it('records discovered covers as references with source identity', async () => {
        mockSearchAlbum.mockResolvedValue({
            posterUrl: 'https://theaudiodb.com/a.jpg',
            backdropUrl: 'https://theaudiodb.com/b.jpg',
            releaseMbid: 'a-release',
            releaseGroupMbid: null,
        });
        const onArtwork = vi.fn().mockResolvedValue(undefined);
        await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb'], { onArtwork });
        expect(onArtwork.mock.calls).toEqual([
            ['poster', 'https://theaudiodb.com/a.jpg', 'theaudiodb'],
            ['backdrop', 'https://theaudiodb.com/b.jpg', 'theaudiodb'],
        ]);
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── 1. First non-null field wins per slot ─────────────────────────────────

    describe('merge semantics — first non-null wins per slot', () => {
        it('uses posterUrl from primary when primary returns it', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: 'https://tadb.example.com/cover.jpg',
                backdropUrl: null,
                releaseGroupMbid: null,
            });
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result).not.toBeNull();
            expect(result!.posterUrl).toBe('https://tadb.example.com/cover.jpg');
        });

        it('takes posterUrl from fallback when primary returns null for that field', async () => {
            // Primary has MBID but no poster; fallback has poster but no MBID.
            mockSearchAlbum.mockResolvedValue({
                posterUrl: null,
                backdropUrl: null,
                releaseGroupMbid: 'mbid-rg-1',
            });
            mockSearchReleaseDiscogs.mockResolvedValue({
                posterUrl: 'https://discogs.example.com/cover.jpg',
                backdropUrl: null,
                releaseId: null,
            });

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result).not.toBeNull();
            // Primary's MBID wins
            expect(result!.releaseGroupMbid).toBe('mbid-rg-1');
            // Fallback fills the missing poster slot
            expect(result!.posterUrl).toBe('https://discogs.example.com/cover.jpg');
        });

        it('primary posterUrl is not overwritten by fallback', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: 'https://tadb.example.com/primary.jpg',
                backdropUrl: null,
                releaseGroupMbid: null,
            });
            mockSearchReleaseDiscogs.mockResolvedValue({
                posterUrl: 'https://discogs.example.com/fallback.jpg',
                backdropUrl: null,
                releaseId: null,
            });

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result!.posterUrl).toBe('https://tadb.example.com/primary.jpg');
        });

        it('fills backdropUrl from first source that provides it', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: 'https://tadb.example.com/poster.jpg',
                backdropUrl: 'https://tadb.example.com/fanart.jpg',
                releaseGroupMbid: null,
            });
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result!.backdropUrl).toBe('https://tadb.example.com/fanart.jpg');
        });
    });

    // ── 2. Early stop ─────────────────────────────────────────────────────────

    describe('early stop — second source not called when poster + MBID filled', () => {
        it('does not call Discogs when TheAudioDB fills poster + releaseGroupMbid', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: 'https://tadb.example.com/cover.jpg',
                backdropUrl: null,
                releaseGroupMbid: 'mbid-rg-early',
            });
            // Discogs must NOT be called — if it is, the test fails.
            mockSearchReleaseDiscogs.mockRejectedValue(new Error('Should not be called'));

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result).not.toBeNull();
            expect(result!.posterUrl).toBe('https://tadb.example.com/cover.jpg');
            expect(result!.releaseGroupMbid).toBe('mbid-rg-early');
            expect(mockSearchReleaseDiscogs).not.toHaveBeenCalled();
        });

        it('continues to second source when first has poster but no MBID', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: 'https://tadb.example.com/cover.jpg',
                backdropUrl: null,
                releaseGroupMbid: null,
            });
            mockSearchReleaseDiscogs.mockResolvedValue({
                posterUrl: null,
                backdropUrl: null,
                releaseId: null,
            });

            await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            // Fallback was reached because early-stop condition was not met.
            expect(mockSearchReleaseDiscogs).toHaveBeenCalledOnce();
        });
    });

    // ── 3. Returns null when no source returns any data ───────────────────────

    describe('null when all sources return nothing', () => {
        it('returns null when both sources return null', async () => {
            mockSearchAlbum.mockResolvedValue(null);
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });

            expect(result).toBeNull();
        });

        it('returns null when sources list is empty', async () => {
            const result = await enrichAlbumFromChain(ARTIST, ALBUM, [], {});
            expect(result).toBeNull();
        });

        it('returns null when only source is unknown', async () => {
            // 'unknown' is not a valid EnrichmentSourceId — dispatch falls
            // through to the default branch and returns null.
            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['unknown' as never], {});
            expect(result).toBeNull();
        });
    });

    // ── 4. Abort signal ───────────────────────────────────────────────────────

    describe('abort signal', () => {
        it('throws an aborted incomplete result when the signal is aborted before the loop starts', async () => {
            const controller = new AbortController();
            controller.abort();

            // First source check fires immediately since signal is already aborted.
            // Nothing was asked, so this must not read as "no match".
            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ reason: 'aborted', partial: null });
            expect(mockSearchAlbum).not.toHaveBeenCalled();
        });

        it('does not call second source after abort between sources', async () => {
            const controller = new AbortController();

            // First source succeeds with no early-stop fields, then we abort.
            mockSearchAlbum.mockImplementation(async () => {
                // Abort after first source returns so the inter-source abort
                // check fires before Discogs is reached.
                controller.abort();
                return {
                    posterUrl: 'https://tadb.example.com/cover.jpg',
                    backdropUrl: null,
                    releaseGroupMbid: null,
                };
            });
            mockSearchReleaseDiscogs.mockResolvedValue({
                posterUrl: 'https://discogs.example.com/cover.jpg',
                backdropUrl: null,
                releaseId: null,
            });

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
                signal: controller.signal,
            });

            // Discogs was NOT reached — partial result from first source returned.
            expect(mockSearchReleaseDiscogs).not.toHaveBeenCalled();
            // Chain returns the partial merged result (has poster from TADB).
            expect(result).not.toBeNull();
            expect(result!.posterUrl).toBe('https://tadb.example.com/cover.jpg');
        });

        it('throws an aborted incomplete result when the first source found nothing and the signal aborted', async () => {
            const controller = new AbortController();

            mockSearchAlbum.mockImplementation(async () => {
                controller.abort();
                return null; // first source found nothing
            });

            // Discogs was never asked, so this is not a no-match.
            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ reason: 'aborted' });
            expect(mockSearchReleaseDiscogs).not.toHaveBeenCalled();
        });

        it('treats a Discogs null after an abort as stopped, not as a no-match', async () => {
            // searchReleaseDiscogs returns null when the abort lands between
            // its search and detail requests.
            const controller = new AbortController();
            mockSearchAlbum.mockResolvedValue(null);
            mockSearchReleaseDiscogs.mockImplementation(async () => {
                controller.abort();
                return null;
            });

            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ reason: 'aborted' });
        });

        it('treats a fetch that rejects because of the abort as stopped, not as a failed source', async () => {
            const controller = new AbortController();
            mockSearchAlbum.mockImplementation(async () => {
                controller.abort();
                throw new Error('This operation was aborted');
            });

            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ reason: 'aborted', unavailableSources: [] });
        });
    });

    // ── 6. Failed sources ─────────────────────────────────────────────────────

    describe('failed sources', () => {
        it('throws source-unavailable when TheAudioDB fails and Discogs has no match', async () => {
            mockSearchAlbum.mockRejectedValue(
                new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 404'),
            );
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            const err = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            }).catch((e: unknown) => e);

            expect(err).toBeInstanceOf(AlbumEnrichmentIncompleteError);
            expect(err).toMatchObject({
                reason: 'source-unavailable',
                unavailableSources: ['theaudiodb'],
                partial: null,
            });
            // The failure did not stop the chain.
            expect(mockSearchReleaseDiscogs).toHaveBeenCalledTimes(1);
        });

        it('returns the poster from Discogs when TheAudioDB fails', async () => {
            mockSearchAlbum.mockRejectedValue(
                new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 404'),
            );
            mockSearchReleaseDiscogs.mockResolvedValue({
                posterUrl: 'https://discogs.example.com/cover.jpg',
                backdropUrl: null,
                releaseId: '1',
            });

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                discogsToken: 'tok',
            });
            expect(result?.posterUrl).toBe('https://discogs.example.com/cover.jpg');
        });

        it('carries what the answering source returned when there is no poster', async () => {
            mockSearchAlbum.mockResolvedValue({
                posterUrl: null,
                backdropUrl: null,
                releaseGroupMbid: 'rg-1',
            });
            mockSearchReleaseDiscogs.mockRejectedValue(
                new EnrichmentSourceUnavailableError('discogs', 'HTTP 429'),
            );

            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                }),
            ).rejects.toMatchObject({
                reason: 'source-unavailable',
                unavailableSources: ['discogs'],
                partial: { releaseGroupMbid: 'rg-1', posterUrl: null },
            });
        });

        it('counts an unexpected throw from a source as unavailable too', async () => {
            mockSearchAlbum.mockRejectedValue(new TypeError('boom'));

            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb'], {}),
            ).rejects.toMatchObject({
                reason: 'source-unavailable',
                unavailableSources: ['theaudiodb'],
            });
        });
    });

    // ── 7. Per-run circuit breaker ────────────────────────────────────────────

    describe('circuit breaker', () => {
        it('skips an open source, counts it unavailable, and records answers and failures', async () => {
            const breaker = new EnrichmentSourceBreaker<'theaudiodb' | 'discogs'>({
                threshold: 1,
            });
            mockSearchAlbum.mockRejectedValue(
                new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 404'),
            );
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            // First album: TheAudioDB fails once, which opens it.
            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    breaker,
                }),
            ).rejects.toMatchObject({ reason: 'source-unavailable' });
            expect(breaker.openSources()).toEqual(['theaudiodb']);

            // Second album: TheAudioDB is not called, still not a no-match.
            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
                    discogsToken: 'tok',
                    breaker,
                }),
            ).rejects.toMatchObject({
                reason: 'source-unavailable',
                unavailableSources: ['theaudiodb'],
            });
            expect(mockSearchAlbum).toHaveBeenCalledTimes(1);
            expect(mockSearchReleaseDiscogs).toHaveBeenCalledTimes(2);
        });

        it('does not count an abort as a source failure', async () => {
            const breaker = new EnrichmentSourceBreaker<'theaudiodb' | 'discogs'>({
                threshold: 1,
            });
            const controller = new AbortController();
            mockSearchAlbum.mockImplementation(async () => {
                controller.abort();
                throw new Error('This operation was aborted');
            });

            await expect(
                enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb'], {
                    signal: controller.signal,
                    breaker,
                }),
            ).rejects.toMatchObject({ reason: 'aborted' });
            expect(breaker.openSources()).toEqual([]);
        });
    });

    // ── 5. Discogs skipped when token is empty ────────────────────────────────

    describe('Discogs with empty token', () => {
        it('searchReleaseDiscogs is called with empty string and returns null', async () => {
            // The chain always calls the dispatch function regardless of token;
            // it is searchReleaseDiscogs's responsibility to handle an empty
            // token (return null). This test verifies the chain passes the token
            // through and handles null gracefully.
            mockSearchAlbum.mockResolvedValue(null);
            mockSearchReleaseDiscogs.mockResolvedValue(null); // simulates "no token" path

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['discogs'], {
                discogsToken: '', // empty token
            });

            expect(mockSearchReleaseDiscogs).toHaveBeenCalledWith(
                ARTIST,
                ALBUM,
                '',
                expect.any(Object),
            );
            // No data returned → null overall.
            expect(result).toBeNull();
        });

        it('chain returns null overall when discogs-only chain has no token', async () => {
            mockSearchReleaseDiscogs.mockResolvedValue(null);

            const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['discogs'], {
                discogsToken: '',
            });

            expect(result).toBeNull();
        });
    });
});

it('retains selected field provenance across a mixed album chain', async () => {
    mockSearchAlbum.mockResolvedValue({
        posterUrl: 'https://audiodb.example/poster.jpg',
        backdropUrl: null,
        releaseGroupMbid: null,
    });
    const source = { provider: 'discogs', url: 'https://www.discogs.com/release/42' };
    mockSearchReleaseDiscogs.mockResolvedValue({
        posterUrl: 'https://discogs.example/poster.jpg',
        backdropUrl: 'https://discogs.example/backdrop.jpg',
        releaseId: '42',
        provenance: { posterUrl: source, backdropUrl: source },
    });
    const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['theaudiodb', 'discogs'], {
        discogsToken: 'token',
    });
    expect(result?.provenance?.posterUrl).toEqual({ provider: 'theaudiodb' });
    expect(result?.provenance?.backdropUrl).toEqual(source);
});

it('forwards stored release identifiers to Discogs', async () => {
    mockSearchReleaseDiscogs.mockResolvedValue(null);
    await enrichAlbumFromChain('Various Artists', 'Album', ['discogs'], {
        discogsToken: 'token',
        barcode: '194111012158',
        catalogueNumber: 'ZYX 83064-2',
        year: 2020,
    });
    expect(mockSearchReleaseDiscogs).toHaveBeenCalledWith(
        'Various Artists',
        'Album',
        'token',
        expect.objectContaining({
            barcode: '194111012158',
            catalogueNumber: 'ZYX 83064-2',
            year: 2020,
        }),
    );
});

describe('Deezer album source order', () => {
    it('asks Deezer after the configured sources and preserves their MBIDs', async () => {
        mockSearchAlbum.mockResolvedValue({ posterUrl: null, releaseGroupMbid: 'rg' });
        mockSearchReleaseDiscogs.mockResolvedValue(null);
        vi.mocked(searchAlbumDeezer).mockResolvedValue({
            posterUrl: 'https://deezer/cover',
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: null,
        });
        const result = await enrichAlbumFromChain(
            ARTIST,
            ALBUM,
            ['theaudiodb', 'discogs', 'deezer'],
            { discogsToken: 'token' },
        );
        expect(result?.posterUrl).toBe('https://deezer/cover');
        expect(result?.releaseGroupMbid).toBe('rg');
        expect(result?.provenance?.posterUrl).toEqual({ provider: 'deezer' });
        expect(mockSearchAlbum.mock.invocationCallOrder.at(-1)).toBeLessThan(
            mockSearchReleaseDiscogs.mock.invocationCallOrder.at(-1)!,
        );
        expect(mockSearchReleaseDiscogs.mock.invocationCallOrder.at(-1)).toBeLessThan(
            vi.mocked(searchAlbumDeezer).mock.invocationCallOrder.at(-1)!,
        );
    });

    it('preserves a Discogs poster when Deezer also has a cover', async () => {
        mockSearchReleaseDiscogs.mockResolvedValue({ posterUrl: 'https://discogs/cover' });
        vi.mocked(searchAlbumDeezer).mockResolvedValue({
            posterUrl: 'https://deezer/cover',
            backdropUrl: null,
            releaseMbid: null,
            releaseGroupMbid: null,
        });
        const result = await enrichAlbumFromChain(ARTIST, ALBUM, ['discogs', 'deezer'], {});
        expect(result?.posterUrl).toBe('https://discogs/cover');
    });
});
