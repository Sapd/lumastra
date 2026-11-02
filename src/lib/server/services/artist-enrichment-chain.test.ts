// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the enrichment chain executor, focused on the
 * compound-credit fallback ("Ferry Corsten presents Gouryella").
 *
 * The load-bearing assertion is the NEGATIVE one: the fallback pass may
 * contribute images and nothing else. Adopting the lead artist's MusicBrainz
 * ID would silently merge two distinct catalogue entities, and adopting the
 * biography would describe a different act entirely.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtistEnrichmentResult } from './artist-enrichment.types.js';

const mockTheAudioDB = vi.fn();
const mockDiscogs = vi.fn();
const mockDeezer = vi.fn();

vi.mock('./theaudiodb-api.js', () => ({ searchArtist: (n: string) => mockTheAudioDB(n) }));
vi.mock('./discogs-api.js', () => ({ searchArtistDiscogs: (n: string) => mockDiscogs(n) }));
vi.mock('./deezer-api.js', () => ({ searchArtistDeezer: (n: string) => mockDeezer(n) }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

import {
    enrichArtistFromChain,
    ALL_SOURCES,
    ArtistEnrichmentIncompleteError,
} from './artist-enrichment-sources.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';
import { EnrichmentSourceBreaker } from './enrichment-source-breaker.js';

function result(over: Partial<ArtistEnrichmentResult> = {}): ArtistEnrichmentResult {
    return {
        thumbUrl: null,
        fanartUrl: null,
        bannerUrl: null,
        musicBrainzId: null,
        biography: null,
        genre: null,
        countryCode: null,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockTheAudioDB.mockResolvedValue(null);
    mockDiscogs.mockResolvedValue(null);
    mockDeezer.mockResolvedValue(null);
});

describe('source registry', () => {
    it('offers deezer as a selectable, keyless source', () => {
        const deezer = ALL_SOURCES.find((s) => s.value === 'deezer');
        expect(deezer).toBeDefined();
        expect(deezer?.label).toMatch(/no key/i);
    });
});

describe('enrichArtistFromChain', () => {
    it('records every discovered picture, backdrop and banner with the actual provider', async () => {
        const onArtwork = vi.fn().mockResolvedValue(undefined);
        mockTheAudioDB.mockResolvedValue(
            result({
                thumbUrl: 'https://theaudiodb.com/p.jpg',
                fanartUrl: 'https://theaudiodb.com/b.jpg',
                bannerUrl: 'https://theaudiodb.com/banner.jpg',
            }),
        );
        await enrichArtistFromChain('An artist', ['theaudiodb'], { onArtwork });
        expect(onArtwork.mock.calls).toEqual([
            ['poster', 'https://theaudiodb.com/p.jpg', 'theaudiodb'],
            ['backdrop', 'https://theaudiodb.com/b.jpg', 'theaudiodb'],
            ['banner', 'https://theaudiodb.com/banner.jpg', 'theaudiodb'],
        ]);
    });

    it('merges across sources, first non-null winning per field', async () => {
        mockTheAudioDB.mockResolvedValue(result({ biography: 'a bio' }));
        mockDeezer.mockResolvedValue(result({ thumbUrl: 'https://img/deezer.jpg' }));

        const res = await enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {});

        expect(res?.biography).toBe('a bio');
        expect(res?.thumbUrl).toBe('https://img/deezer.jpg');
    });

    it('returns null when no source has anything', async () => {
        expect(await enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {})).toBeNull();
    });

    it.each(['Makry, Jts', 'Makry & JTS', 'Makry & JTS feat. Guest'])(
        'does not search an individual member of %s',
        async (name) => {
            expect(await enrichArtistFromChain(name, ['discogs', 'deezer'], {})).toBeNull();
            expect(mockDiscogs).toHaveBeenCalledExactlyOnceWith(name);
            expect(mockDeezer).toHaveBeenCalledExactlyOnceWith(name);
        },
    );

    it('does not retry a plain name that simply missed', async () => {
        await enrichArtistFromChain('Wavetraxx', ['deezer'], {});

        expect(mockDeezer).toHaveBeenCalledTimes(1);
        expect(mockDeezer).toHaveBeenCalledWith('Wavetraxx');
    });

    it('retries a compound credit against the lead artist when no image was found', async () => {
        mockDeezer.mockImplementation(async (name: string) =>
            name === 'Ferry Corsten' ? result({ thumbUrl: 'https://img/ferry.jpg' }) : null,
        );

        const res = await enrichArtistFromChain('Ferry Corsten presents Gouryella', ['deezer'], {});

        expect(mockDeezer).toHaveBeenNthCalledWith(1, 'Ferry Corsten presents Gouryella');
        expect(mockDeezer).toHaveBeenNthCalledWith(2, 'Ferry Corsten');
        expect(res?.thumbUrl).toBe('https://img/ferry.jpg');
    });

    it('adopts ONLY images from the lead-artist pass, never identity fields', async () => {
        mockDeezer.mockImplementation(async (name: string) =>
            name === 'Ferry Corsten'
                ? result({
                      thumbUrl: 'https://img/ferry.jpg',
                      fanartUrl: 'https://img/ferry-fan.jpg',
                      musicBrainzId: 'mbid-of-ferry-corsten',
                      biography: 'Ferry Corsten is a Dutch DJ...',
                      genre: 'Trance',
                      countryCode: 'NL',
                  })
                : null,
        );

        const res = await enrichArtistFromChain('Ferry Corsten presents Gouryella', ['deezer'], {});

        expect(res?.thumbUrl).toBe('https://img/ferry.jpg');
        expect(res?.fanartUrl).toBe('https://img/ferry-fan.jpg');
        // These would corrupt the Gouryella entity.
        expect(res?.musicBrainzId).toBeNull();
        expect(res?.biography).toBeNull();
        expect(res?.genre).toBeNull();
        expect(res?.countryCode).toBeNull();
    });

    it('keeps the compound name’s own metadata when only its image was missing', async () => {
        mockTheAudioDB.mockImplementation(async (name: string) =>
            name === 'Ferry Corsten presents Gouryella'
                ? result({ biography: 'Gouryella is an alias project...', musicBrainzId: 'mbid-g' })
                : null,
        );
        mockDeezer.mockImplementation(async (name: string) =>
            name === 'Ferry Corsten' ? result({ thumbUrl: 'https://img/ferry.jpg' }) : null,
        );

        const res = await enrichArtistFromChain(
            'Ferry Corsten presents Gouryella',
            ['theaudiodb', 'deezer'],
            {},
        );

        expect(res?.biography).toBe('Gouryella is an alias project...');
        expect(res?.musicBrainzId).toBe('mbid-g');
        expect(res?.thumbUrl).toBe('https://img/ferry.jpg');
    });

    it('does not retry the lead when the full name already yielded an image', async () => {
        mockDeezer.mockResolvedValue(result({ thumbUrl: 'https://img/direct.jpg' }));

        await enrichArtistFromChain('Ferry Corsten presents Gouryella', ['deezer'], {});

        expect(mockDeezer).toHaveBeenCalledTimes(1);
    });

    it('returns null when neither the compound name nor its lead resolves', async () => {
        const res = await enrichArtistFromChain('Nobody presents Noone', ['deezer'], {});

        expect(res).toBeNull();
        expect(mockDeezer).toHaveBeenCalledTimes(2);
    });

    it('skips the lead-artist retry once aborted', async () => {
        const controller = new AbortController();
        mockDeezer.mockImplementation(async () => {
            controller.abort();
            return null;
        });

        // Stopped before the lead was asked, so this is NOT a no-match.
        await expect(
            enrichArtistFromChain('Ferry Corsten presents Gouryella', ['deezer'], {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ reason: 'aborted' });

        expect(mockDeezer).toHaveBeenCalledTimes(1);
    });
});

// The seam that decides between "no match" (tombstoned for good) and "try
// again". Before it, a failing provider returned null like a miss, so every
// artist checked while TheAudioDB rejected its retired key — or on a day
// Deezer lookups failed — was marked no-match permanently.
describe('incomplete chains', () => {
    const down = (source: 'theaudiodb' | 'discogs' | 'deezer') =>
        new EnrichmentSourceUnavailableError(source, 'HTTP 503');

    it('throws instead of returning null when a source failed and none had an image', async () => {
        mockDeezer.mockRejectedValue(down('deezer'));

        const err = await enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {}).catch(
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(ArtistEnrichmentIncompleteError);
        expect(err).toMatchObject({ reason: 'source-unavailable', unavailableSources: ['deezer'] });
    });

    it('still asks the remaining sources after one fails', async () => {
        mockTheAudioDB.mockRejectedValue(down('theaudiodb'));
        mockDeezer.mockResolvedValue(result({ thumbUrl: 'https://img/deezer.jpg' }));

        const res = await enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {});

        // An image from a working source is a real result; no retry needed.
        expect(res?.thumbUrl).toBe('https://img/deezer.jpg');
    });

    it('counts a failure on the lead-artist pass too', async () => {
        mockDeezer.mockImplementation(async (name: string) => {
            if (name === 'Ferry Corsten') throw down('deezer');
            return null;
        });

        await expect(
            enrichArtistFromChain('Ferry Corsten presents Gouryella', ['deezer'], {}),
        ).rejects.toMatchObject({ reason: 'source-unavailable', unavailableSources: ['deezer'] });
    });

    it('treats an unexpected throw from a source as unavailable, not as a miss', async () => {
        mockTheAudioDB.mockRejectedValue(new TypeError('boom'));

        await expect(
            enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {}),
        ).rejects.toMatchObject({ unavailableSources: ['theaudiodb'] });
        expect(mockDeezer).toHaveBeenCalledTimes(1);
    });

    it('reports an abort that surfaces as a source error as aborted', async () => {
        const controller = new AbortController();
        mockTheAudioDB.mockImplementation(async () => {
            controller.abort();
            throw new Error('The operation was aborted');
        });

        await expect(
            enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], {
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ reason: 'aborted' });
        expect(mockDeezer).not.toHaveBeenCalled();
    });
});

describe('known MusicBrainz identity', () => {
    const knownMusicBrainzId = '10000000-0000-4000-8000-000000000001';
    const rivalMusicBrainzId = '10000000-0000-4000-8000-000000000002';

    it('rejects every field and credit from a contradictory source before valid fallback', async () => {
        mockTheAudioDB.mockResolvedValue(
            result({
                musicBrainzId: rivalMusicBrainzId,
                thumbUrl: 'https://wrong.example/poster.jpg',
                fanartUrl: 'https://wrong.example/backdrop.jpg',
                bannerUrl: 'https://wrong.example/banner.jpg',
                biography: 'Wrong artist biography',
                genre: 'Wrong genre',
                countryCode: 'XX',
                provenance: { thumbUrl: { provider: 'theaudiodb' } },
            }),
        );
        mockDeezer.mockResolvedValue(
            result({
                thumbUrl: 'https://valid.example/poster.jpg',
                biography: 'Correct biography',
            }),
        );
        const res = await enrichArtistFromChain('Synthetic Artist', ['theaudiodb', 'deezer'], {
            knownMusicBrainzId,
        });
        expect(mockDeezer).toHaveBeenCalledOnce();
        expect(res).toEqual(
            result({
                thumbUrl: 'https://valid.example/poster.jpg',
                biography: 'Correct biography',
                provenance: { thumbUrl: { provider: 'deezer' }, biography: { provider: 'deezer' } },
            }),
        );
    });

    it('accepts a matching source identity', async () => {
        mockTheAudioDB.mockResolvedValue(
            result({
                musicBrainzId: knownMusicBrainzId,
                thumbUrl: 'https://valid.example/poster.jpg',
            }),
        );
        expect(
            await enrichArtistFromChain('Synthetic Artist', ['theaudiodb'], {
                knownMusicBrainzId,
            }),
        ).toMatchObject({ musicBrainzId: knownMusicBrainzId });
    });

    it('counts contradictory-only answers as a genuine no-match', async () => {
        mockTheAudioDB.mockResolvedValue(
            result({
                musicBrainzId: rivalMusicBrainzId,
                thumbUrl: 'https://wrong.example/poster.jpg',
            }),
        );
        expect(
            await enrichArtistFromChain('Synthetic Artist', ['theaudiodb'], {
                knownMusicBrainzId,
            }),
        ).toBeNull();
    });

    it('still defers when a contradictory answer is followed by an outage', async () => {
        mockTheAudioDB.mockResolvedValue(result({ musicBrainzId: rivalMusicBrainzId }));
        mockDeezer.mockRejectedValue(new EnrichmentSourceUnavailableError('deezer', 'HTTP 503'));
        await expect(
            enrichArtistFromChain('Synthetic Artist', ['theaudiodb', 'deezer'], {
                knownMusicBrainzId,
            }),
        ).rejects.toMatchObject({ reason: 'source-unavailable' });
    });

    it('applies the constraint to compound-credit image fallback too', async () => {
        mockTheAudioDB.mockImplementation(async (name: string) =>
            name === 'Lead Artist'
                ? result({
                      musicBrainzId: rivalMusicBrainzId,
                      thumbUrl: 'https://wrong.example/lead.jpg',
                  })
                : null,
        );
        expect(
            await enrichArtistFromChain('Lead Artist presents Project', ['theaudiodb'], {
                knownMusicBrainzId,
            }),
        ).toBeNull();
    });
});

describe('field provenance', () => {
    it('retains only the source of the winning value', async () => {
        mockTheAudioDB.mockResolvedValue(result({ biography: 'AudioDB bio' }));
        const source = { provider: 'discogs' as const, url: 'https://www.discogs.com/artist/42' };
        mockDiscogs.mockResolvedValue(
            result({
                thumbUrl: 'https://cdn.example/photo.jpg',
                biography: 'Discogs bio',
                provenance: { thumbUrl: source, biography: source },
            }),
        );
        const enriched = await enrichArtistFromChain('Artist', ['theaudiodb', 'discogs'], {});
        expect(enriched?.provenance?.biography).toEqual({ provider: 'theaudiodb' });
        expect(enriched?.provenance?.thumbUrl).toEqual(source);
    });
    it('adopts image credit only from the compound fallback', async () => {
        const source = { provider: 'discogs' as const, url: 'https://www.discogs.com/artist/42' };
        mockDiscogs.mockImplementation(async (name: string) =>
            name === 'Ferry Corsten'
                ? result({
                      thumbUrl: 'https://cdn.example/photo.jpg',
                      biography: 'Lead bio',
                      provenance: { thumbUrl: source, biography: source },
                  })
                : null,
        );
        const enriched = await enrichArtistFromChain(
            'Ferry Corsten presents Gouryella',
            ['discogs'],
            {},
        );
        expect(enriched?.provenance?.thumbUrl).toEqual(source);
        expect(enriched?.provenance?.biography).toBeUndefined();
    });
});

describe('per-run circuit breaker', () => {
    it('skips an open source on both passes and counts it unavailable', async () => {
        const breaker = new EnrichmentSourceBreaker<'theaudiodb' | 'discogs' | 'deezer'>({
            threshold: 1,
        });
        mockTheAudioDB.mockRejectedValue(
            new EnrichmentSourceUnavailableError('theaudiodb', 'HTTP 404'),
        );

        // Opens TheAudioDB.
        await expect(
            enrichArtistFromChain('Plain Name', ['theaudiodb', 'deezer'], { breaker }),
        ).rejects.toMatchObject({ reason: 'source-unavailable' });
        expect(mockTheAudioDB).toHaveBeenCalledTimes(1);

        // A name with a lead-artist fallback: TheAudioDB is skipped on both
        // passes, Deezer is still asked, and the artist is not a no-match.
        await expect(
            enrichArtistFromChain('Ferry Corsten presents Gouryella', ['theaudiodb', 'deezer'], {
                breaker,
            }),
        ).rejects.toMatchObject({ unavailableSources: ['theaudiodb'] });
        expect(mockTheAudioDB).toHaveBeenCalledTimes(1);
        expect(mockDeezer).toHaveBeenCalledTimes(3);
    });

    it('closes again once the source answers', async () => {
        const breaker = new EnrichmentSourceBreaker<'theaudiodb' | 'discogs' | 'deezer'>({
            threshold: 2,
        });
        mockDeezer.mockRejectedValueOnce(
            new EnrichmentSourceUnavailableError('deezer', 'HTTP 503'),
        );
        await enrichArtistFromChain('Plain Name', ['deezer'], { breaker }).catch(() => undefined);
        mockDeezer.mockResolvedValueOnce(null);
        expect(await enrichArtistFromChain('Plain Name', ['deezer'], { breaker })).toBeNull();
        expect(breaker.openSources()).toEqual([]);
    });
});
