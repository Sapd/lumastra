// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveAlbumArtist, VARIOUS_ARTISTS_MBID, albumFileCredit } from './album-artist-rule.js';
import { VARIOUS_ARTISTS_ALIASES } from '$lib/shared/various-artists.js';

describe('album artist precedence', () => {
    it('keeps Velvet Observatory under Cobalt Finch despite 170 different track artists and compilation/MB flags', () => {
        const files = Array.from({ length: 170 }, (_, i) => ({
            albumArtist: 'Cobalt Finch',
            primaryArtist: `Performer ${i}`,
            compilation: true,
            releaseArtistIds: [VARIOUS_ARTISTS_MBID],
        }));
        expect(resolveAlbumArtist(files)).toMatchObject({
            artist: 'Cobalt Finch',
            various: false,
            source: 'album-tag',
        });
    });
    it.each(['VA', 'Various', 'Various Artists', 'V.A.', 'V/A', ...VARIOUS_ARTISTS_ALIASES])(
        'recognizes alias %s',
        (albumArtist) => {
            expect(resolveAlbumArtist([{ albumArtist }])).toMatchObject({
                artist: 'Various Artists',
                various: true,
            });
        },
    );
    it('uses compilation without ALBUMARTIST', () => {
        expect(resolveAlbumArtist([{ compilation: true, primaryArtist: 'One' }])).toMatchObject({
            various: true,
            source: 'compilation',
        });
    });
    it('uses MB release artist credit before compilation and track artists', () => {
        expect(
            resolveAlbumArtist([
                {
                    releaseArtist: 'Release Artist',
                    releaseArtistIds: ['artist-id'],
                    compilation: true,
                },
            ]),
        ).toMatchObject({ artist: 'Release Artist', source: 'musicbrainz' });
        expect(resolveAlbumArtist([{ releaseArtistIds: [VARIOUS_ARTISTS_MBID] }])).toMatchObject({
            various: true,
            source: 'musicbrainz',
        });
    });
    it('requires three normalized performers with no performer covering half the tracks', () => {
        expect(
            resolveAlbumArtist(['A', 'B', 'C'].map((primaryArtist) => ({ primaryArtist }))),
        ).toMatchObject({ various: true });
        expect(
            resolveAlbumArtist(['A', 'A', 'B', 'C'].map((primaryArtist) => ({ primaryArtist }))),
        ).toMatchObject({ artist: 'A', various: false });
        expect(
            resolveAlbumArtist(
                ['A', 'A', 'A', 'B', 'C'].map((primaryArtist) => ({ primaryArtist })),
            ),
        ).toMatchObject({ artist: 'A', various: false });
    });
    it('does not infer a compilation across conflicting release IDs', () => {
        expect(
            resolveAlbumArtist([
                { primaryArtist: 'Cobalt Finch', releaseMbid: 'release-a' },
                { primaryArtist: 'Amber Current', releaseMbid: 'release-b' },
                { primaryArtist: 'Vesper Loom', releaseMbid: 'release-b' },
            ]).various,
        ).toBe(false);
        expect(
            resolveAlbumArtist([
                { primaryArtist: 'Cobalt Finch' },
                { primaryArtist: 'Amber Current' },
            ]).various,
        ).toBe(false);
    });
    it('preserves a locked manual parent before every other signal', () => {
        expect(
            resolveAlbumArtist([{ albumArtist: 'Cobalt Finch', compilation: true }], {
                locked: true,
                currentArtist: 'Manual Parent',
            }),
        ).toMatchObject({ artist: 'Manual Parent', locked: true, source: 'lock' });
    });
    it('falls through inconsistent and partially missing ALBUMARTIST tags', () => {
        expect(
            resolveAlbumArtist([
                { albumArtist: 'A', compilation: true },
                { albumArtist: 'B', compilation: true },
            ]),
        ).toMatchObject({ various: true, inconsistentAlbumArtists: true, source: 'compilation' });
        expect(
            resolveAlbumArtist([{ albumArtist: 'A', primaryArtist: 'X' }, { primaryArtist: 'X' }]),
        ).toMatchObject({ artist: 'X', inconsistentAlbumArtists: true });
    });
    it('normalizes tag spelling and never counts a track comma list as album evidence', () => {
        expect(
            resolveAlbumArtist([
                { albumArtist: ' Cobalt Finch ', primaryArtist: 'A, B, C, D, E, F' },
                { albumArtist: 'COBALT FINCH' },
            ]),
        ).toMatchObject({ artist: 'Cobalt Finch', various: false });
    });
    it('uses the strict album-tag majority with 30% untagged other performers', () => {
        const files = Array.from({ length: 10 }, (_, i) => ({
            albumArtist: i < 7 ? 'Cobalt Finch' : undefined,
            primaryArtist: `Guest ${i}`,
            compilation: true,
        }));
        expect(resolveAlbumArtist(files)).toMatchObject({
            artist: 'Cobalt Finch',
            various: false,
            source: 'album-tag',
        });
        expect(
            resolveAlbumArtist([
                { albumArtist: 'Cobalt Finch' },
                { albumArtist: 'Cobalt Finch' },
                { albumArtist: 'Amber Current' },
            ]),
        ).toMatchObject({ artist: 'Cobalt Finch', source: 'album-tag' });
        expect(resolveAlbumArtist([{ albumArtist: 'Cobalt Finch' }, {}]).source).toBe('fallback');
    });
    it.each([
        'Cobalt Finch & Band',
        'The Cobalt Finch',
        'Cobalt Finch (Live)',
        'Cobalt Finch [Acoustic]',
        'Cobalt Finch feat. Amber Current',
        'Cobalt Finch Ensemble',
    ])('keeps spelling/guest variation %s under the artist', (variant) => {
        expect(
            resolveAlbumArtist(
                ['Cobalt Finch', variant].map((primaryArtist) => ({ primaryArtist })),
            ),
        ).toMatchObject({ various: false, artist: 'Cobalt Finch' });
        expect(
            resolveAlbumArtist(
                ['Cobalt Finch', variant, 'Amber Current'].map((primaryArtist) => ({
                    primaryArtist,
                })),
            ),
        ).toMatchObject({ various: false, artist: 'Cobalt Finch' });
    });
    it('keeps an 80-performer, 100-track lounge-style compilation Various Artists', () => {
        const files = Array.from({ length: 100 }, (_, i) => ({
            primaryArtist: `Invented Performer ${i % 80}`,
        }));
        expect(resolveAlbumArtist(files)).toMatchObject({ various: true, source: 'track-artists' });
    });
    it.each(['artist', 'artists'])('rejects self-titled %s tags as performer evidence', (field) => {
        const titles = [
            'Glass Orchard',
            'Midnight Loom [feat. Amber Current]',
            'Paper Comet feat. Vesper Loom',
            'Silver Harbour (Acoustic)',
            'Cafe\u0301   Lantern',
            'Copper, Glass',
            'Dusk x Dawn',
        ];
        const files = titles.map((title) =>
            albumFileCredit({
                title,
                [field]: field === 'artists' ? [title.toUpperCase()] : title.toUpperCase(),
            }),
        );
        expect(resolveAlbumArtist(files, { currentArtist: 'Cobalt Finch' })).toMatchObject({
            artist: 'Cobalt Finch',
            various: false,
            source: 'fallback',
        });
        // A majority of broken tags invalidates the folder's performer evidence,
        // even when three remaining tags would otherwise look like a compilation.
        expect(
            resolveAlbumArtist(
                [
                    ...files,
                    ...['Amber Current', 'Vesper Loom', 'Copper Reed'].map((primaryArtist) => ({
                        primaryArtist,
                    })),
                ],
                { fallbackArtist: 'Cobalt Finch' },
            ),
        ).toMatchObject({ artist: 'Cobalt Finch', various: false, source: 'fallback' });
        expect(resolveAlbumArtist(files.map((f) => ({ ...f, compilation: true })))).toMatchObject({
            various: true,
            source: 'compilation',
        });
    });
    it('excludes individual self-title credits without discarding valid performers', () => {
        expect(
            resolveAlbumArtist([
                albumFileCredit({ title: 'Glass Orchard', artist: 'Glass Orchard [Live]' }),
                { primaryArtist: 'Amber Current' },
                { primaryArtist: 'Vesper Loom' },
            ]).various,
        ).toBe(false);
        expect(
            resolveAlbumArtist([
                albumFileCredit({ title: 'Glass Orchard (Live)', artist: 'Glass Orchard' }),
                { primaryArtist: 'Amber Current' },
                { primaryArtist: 'Vesper Loom' },
                { primaryArtist: 'Copper Reed' },
            ]),
        ).toMatchObject({ various: true, source: 'track-artists' });
    });
    it('splits persisted feat. credits just like the scanner', () => {
        expect(albumFileCredit({ artist: 'Cobalt Finch feat. Amber Current' }).primaryArtist).toBe(
            'Cobalt Finch',
        );
    });
    it('requires a strict majority of compilation flags', () => {
        expect(
            resolveAlbumArtist([
                { primaryArtist: 'Solo', compilation: true },
                { primaryArtist: 'Solo' },
                { primaryArtist: 'Solo' },
            ]),
        ).toMatchObject({ artist: 'Solo', source: 'track-artists' });
        expect(resolveAlbumArtist([{ compilation: true }, {}]).source).toBe('fallback');
        expect(resolveAlbumArtist([{ compilation: true }, { compilation: true }, {}]).source).toBe(
            'compilation',
        );
    });
    it('resolves collaborative ALBUMARTIST using the existing credit evidence', () => {
        expect(
            resolveAlbumArtist([{ albumArtist: 'A & B' }], {
                creditEvidence: { isIndependent: () => true, isKnownAct: () => false },
            }),
        ).toMatchObject({ artist: 'A', source: 'album-tag' });
        expect(resolveAlbumArtist([{ albumArtist: 'Copper, Mist & Lantern' }])).toMatchObject({
            artist: 'Copper, Mist & Lantern',
        });
    });
    it('reads persisted compilation and release artist fields', () => {
        expect(
            albumFileCredit({
                compilation: '1',
                musicbrainz_album_artist_ids: [VARIOUS_ARTISTS_MBID],
                artists: ['First', 'Guest'],
            }),
        ).toMatchObject({
            compilation: true,
            releaseArtistIds: [VARIOUS_ARTISTS_MBID],
            primaryArtist: 'First',
        });
    });
});
