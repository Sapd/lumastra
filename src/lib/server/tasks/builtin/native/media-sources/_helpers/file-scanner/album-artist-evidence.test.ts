// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import { loadReleaseArtistEvidence, albumArtistDecision } from './album-artist-evidence.js';
import {
    resolveAlbumArtist,
    VARIOUS_ARTISTS_MBID,
    type AlbumFileCredit,
} from './album-artist-rule.js';

const { getRelease, getReleaseGroup, getArtist, findAlbumArtistEvidence } = vi.hoisted(() => ({
    getRelease: vi.fn(),
    getReleaseGroup: vi.fn(),
    getArtist: vi.fn(),
    findAlbumArtistEvidence: vi.fn(),
}));
vi.mock('$lib/server/providers/implementations/musicbrainz/api-client.js', () => ({
    getRelease,
    getReleaseGroup,
    getArtist,
}));
vi.mock('$lib/server/database/queries/music-album-folder.queries.js', () => ({
    findAlbumArtistEvidence,
}));
vi.mock('./artist-credit-evidence.js', () => ({
    getArtistCreditEvidence: vi
        .fn()
        .mockResolvedValue({ isIndependent: () => false, isKnownAct: () => false }),
}));
const context = { logger: mockLogger() };

describe('release artist evidence below file album tags', () => {
    beforeEach(() => vi.clearAllMocks());
    it('does not ask MusicBrainz when consistent ALBUMARTIST already wins', async () => {
        const files: AlbumFileCredit[] = [{ albumArtist: 'Michael', releaseMbid: 'skip' }];
        await loadReleaseArtistEvidence(files, context);
        expect(getRelease).not.toHaveBeenCalled();
        expect(resolveAlbumArtist(files).artist).toBe('Michael');
    });
    it('loads and reuses the full release artist credit before compilation', async () => {
        getRelease.mockResolvedValueOnce({
            'artist-credit': [
                { name: 'Release A', artist: { id: 'a', name: 'Release A' }, joinphrase: ' & ' },
                { name: 'Release B', artist: { id: 'b', name: 'Release B' } },
            ],
        });
        const files: AlbumFileCredit[] = Array.from({ length: 5 }, () => ({
            releaseMbid: 'release-one',
            compilation: true,
        }));
        await loadReleaseArtistEvidence(files, context);
        expect(getRelease).toHaveBeenCalledTimes(1);
        expect(resolveAlbumArtist(files)).toMatchObject({
            artist: 'Release A & Release B',
            source: 'musicbrainz',
            various: false,
        });
    });
    it('recognizes the VA release artist MBID independently of its credited label', async () => {
        getRelease.mockResolvedValueOnce({
            'artist-credit': [{ name: 'A compilation', artist: { id: VARIOUS_ARTISTS_MBID } }],
        });
        const files: AlbumFileCredit[] = [{ releaseMbid: 'release-va', primaryArtist: 'One' }];
        await loadReleaseArtistEvidence(files, context);
        expect(resolveAlbumArtist(files)).toMatchObject({
            artist: 'Various Artists',
            source: 'musicbrainz',
        });
    });
    it('supports a release-group ID when no release ID is available', async () => {
        getReleaseGroup.mockResolvedValueOnce({
            'artist-credit': [{ name: 'Group Artist', artist: { id: 'g' } }],
        });
        const files: AlbumFileCredit[] = [{ releaseGroupMbid: 'group-one', compilation: true }];
        await loadReleaseArtistEvidence(files, context);
        expect(resolveAlbumArtist(files).artist).toBe('Group Artist');
    });
    it('resolves an album-artist MBID from a file without using track artist IDs', async () => {
        getArtist.mockResolvedValueOnce({ id: 'album-artist', name: 'Album Artist' });
        const files: AlbumFileCredit[] = [
            { releaseArtistIds: ['album-artist'], compilation: true },
        ];
        await loadReleaseArtistEvidence(files, context);
        expect(resolveAlbumArtist(files).artist).toBe('Album Artist');
    });
    it('falls through an unavailable release once per batch', async () => {
        getRelease.mockRejectedValueOnce(new Error('unavailable'));
        const files: AlbumFileCredit[] = [
            { releaseMbid: 'offline', compilation: true },
            { releaseMbid: 'offline', compilation: true },
        ];
        await loadReleaseArtistEvidence(files, context);
        expect(getRelease).toHaveBeenCalledTimes(1);
        expect(resolveAlbumArtist(files)).toMatchObject({ various: true, source: 'compilation' });
    });
    it('uses stored MusicBrainz evidence without HTTP while deciding a locked row', async () => {
        findAlbumArtistEvidence.mockResolvedValueOnce({
            metadata_locked: false,
            artist_title: 'Old',
            track_metadata: [
                {
                    musicbrainz_album_id: 'remote-id',
                    musicbrainz_album_artist_ids: [VARIOUS_ARTISTS_MBID],
                },
            ],
        });
        const result = await albumArtistDecision({} as postgres.Sql, 'album', context);
        expect(result).toMatchObject({ source: 'musicbrainz', various: true });
        expect(getRelease).not.toHaveBeenCalled();
        expect(getReleaseGroup).not.toHaveBeenCalled();
        expect(getArtist).not.toHaveBeenCalled();
    });
    it('keeps a locked parent without fetching its release', async () => {
        findAlbumArtistEvidence.mockResolvedValueOnce({
            metadata_locked: true,
            artist_title: 'Manual',
            track_metadata: [{ musicbrainz_album_id: 'locked-release', album_artist: 'Michael' }],
        });
        const result = await albumArtistDecision({} as postgres.Sql, 'locked-album', context);
        expect(result).toMatchObject({ artist: 'Manual', source: 'lock', locked: true });
        expect(getRelease).not.toHaveBeenCalled();
    });
});
