// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    getTestDatabaseUrl,
    getTestDb,
} from '../../../../../tests/integration/setup/test-database.js';
import { placeInLibraryGroup } from '../../../../../tests/integration/fixtures/library-access.fixtures.js';
import { TEST_TABLES, truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { getAlbumWithTracks, getTrackDetail } from '../../database/queries/music.queries.js';
import {
    findOrCreateMusicArtist,
    updateAndLockMediaItem,
} from '../../database/queries/media-items.queries.js';
import { musicImagesFixture } from './__tests__/image-fixtures.js';
import { toMusicTrack } from './track-projection.js';
import { reconcileTrackArtistCredits } from './artist-credit-ingestion.js';
import { repairTrackArtistCreditsFrozen as repairExistingTrackArtistCredits } from '../../database/migrations/_frozen/16.394.0-track-artist-credit-repair.js';

/** Real catalog writes followed by real album/detail reads; no SQL or resolver mocks. */
describe('canonical artist ingestion and existing-track repair', () => {
    let sql: postgres.Sql;
    let libraryGroupId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES (${`Artist ingestion ${randomUUID()}`}) RETURNING id
        `;
        libraryGroupId = group.id;
        return async () => {
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_groups WHERE id = ${group.id}::uuid`;
        };
    });

    async function artist(title: string, metadata: Record<string, unknown> = {}): Promise<string> {
        const id = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, custom_metadata)
            VALUES (${id}::uuid, ${title}, 'artist', 'active', ${sql.json(metadata as never)})
        `;
        return id;
    }

    async function track(metadata: Record<string, unknown>, ownerId?: string) {
        const albumArtistId = ownerId ?? (await artist('Collection Curator'));
        const albumId = randomUUID();
        const trackId = randomUUID();
        await sql`
            INSERT INTO media_items (id, parent_id, title, media_type, status)
            VALUES (${albumId}::uuid, ${albumArtistId}::uuid, ${`Evening Collection ${albumId}`}, 'album', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, parent_id, title, media_type, status, custom_metadata)
            VALUES (${trackId}::uuid, ${albumId}::uuid, 'Evening Song', 'track', 'active',
                    ${sql.json(metadata as never)})
        `;
        const { fileId } = await placeInLibraryGroup(sql, {
            mediaItemId: trackId,
            mediaType: 'track',
            libraryGroupId,
        });
        // The general placement helper uses a video extension. Music reads
        // require an actual playable audio file relation, as a scan produces.
        await sql`
            UPDATE media_files SET file_path = ${`/test/artist-ingestion/${trackId}.mp3`},
                is_missing = false WHERE id = ${fileId}::uuid
        `;
        return { trackId, albumId, albumArtistId };
    }

    async function snapshot(trackId: string) {
        const [row] = await sql<
            {
                custom_metadata: Record<string, unknown>;
                version: string;
                parent_id: string;
            }[]
        >`
            SELECT custom_metadata, xmin::text AS version, parent_id
            FROM media_items WHERE id = ${trackId}::uuid
        `;
        return row;
    }

    async function expectPairedReads(
        trackId: string,
        albumId: string,
        expected: Array<{ id: string | null; title: string }>,
    ) {
        const detail = await getTrackDetail(sql, trackId);
        const album = await getAlbumWithTracks(sql, albumId);
        const albumTrack = album?.tracks.find((item) => item.id === trackId);
        expect(detail).not.toBeNull();
        expect(albumTrack).toBeDefined();
        if (!detail || !albumTrack) throw new Error('Fixture missing from real music reads');
        expect(detail.track_artists).toEqual(expected);
        expect(albumTrack.track_artists).toEqual(expected);
        const images = musicImagesFixture(trackId, 'internal');
        expect(toMusicTrack(detail, images).artists).toEqual(expected);
        expect(toMusicTrack(albumTrack, images).artists).toEqual(expected);
        expect(toMusicTrack(detail, images).album?.id).toBe(albumId);
    }

    it('repairs lowercase stored tags into canonical paired identities without renaming or losing evidence', async () => {
        const performer = await artist('Silver Meadow');
        const fixture = await track({
            artist: 'silver meadow',
            album_artist: 'Collection Curator',
            local_artwork: { poster: 'retained-cover.jpg' },
            operator_note: 'Keep this annotation',
        });
        const result = await repairExistingTrackArtistCredits(sql);
        expect(result).toMatchObject({ scanned: 1, updated: 1, failed: 0, errors: [] });
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata).toMatchObject({
            artist: 'silver meadow',
            raw_artist_tags: { source: 'stored_metadata', artist: 'silver meadow' },
            track_artist_credits: [{ id: performer, credited_name: 'silver meadow' }],
            local_artwork: { poster: 'retained-cover.jpg' },
            operator_note: 'Keep this annotation',
        });
        expect(after.parent_id).toBe(fixture.albumId);
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: performer, title: 'Silver Meadow' },
        ]);
        const [canonical] = await sql<
            { title: string }[]
        >`SELECT title FROM media_items WHERE id = ${performer}::uuid`;
        expect(canonical.title).toBe('Silver Meadow');
    });

    it('performs no track write on an identical second backfill', async () => {
        await artist('Amber Harbor');
        const fixture = await track({ artist: 'amber harbor' });
        await repairExistingTrackArtistCredits(sql);
        const first = await snapshot(fixture.trackId);
        const secondRun = await repairExistingTrackArtistCredits(sql);
        const second = await snapshot(fixture.trackId);
        // A repaired track carries artist_credit_source, so a rerun skips it.
        expect(secondRun).toMatchObject({ scanned: 0, updated: 0, failed: 0, errors: [] });
        expect(second.custom_metadata).toEqual(first.custom_metadata);
        expect(second.version).toBe(first.version);
    });

    it('keeps ordered performer credits separate from the compilation owner', async () => {
        const first = await artist('North Lantern');
        const second = await artist('Amber Harbor');
        const fixture = await track({
            artist: 'north lantern feat. amber harbor',
            artists: ['north lantern', 'amber harbor'],
            album_artist: 'Collection Curator',
            raw_artist_tags: {
                source: 'file',
                artist: 'north lantern feat. amber harbor',
                artists: ['north lantern', 'amber harbor'],
                album_artist: 'Collection Curator',
            },
        });
        expect(await reconcileTrackArtistCredits(sql, fixture.trackId)).toBe(true);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.track_artist_credits).toEqual([
            { id: first, credited_name: 'north lantern' },
            { id: second, credited_name: 'amber harbor' },
        ]);
        expect(after.custom_metadata.raw_artist_tags).toMatchObject({
            source: 'file',
            artist: 'north lantern feat. amber harbor',
        });
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: first, title: 'North Lantern' },
            { id: second, title: 'Amber Harbor' },
        ]);
    });

    it('replaces stale file membership while preserving remixer, album and independent memberships', async () => {
        const stale = await artist('Old Performer');
        const current = await artist('New Performer');
        const remixer = await artist('Night Remixer');
        const independent = await artist('Guest Curator');
        const owner = await artist('Album Owner');
        const fixture = await track(
            {
                artist: 'new performer',
                album_artist: 'Album Owner',
                track_artist_credits: [{ id: stale, credited_name: 'Old Performer' }],
                file_artist_ids: [stale],
                album_artist_ids: [owner],
                remixer_artist_ids: [remixer],
                additional_artist_ids: [stale, remixer, owner, independent],
                operator_note: 'Do not replace',
            },
            owner,
        );
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.track_artist_credits).toEqual([
            { id: current, credited_name: 'new performer' },
        ]);
        expect(after.custom_metadata.file_artist_ids).toEqual([current]);
        expect(after.custom_metadata.additional_artist_ids).toEqual(
            expect.arrayContaining([current, remixer, owner, independent]),
        );
        expect(after.custom_metadata.additional_artist_ids).not.toContain(stale);
        expect(after.custom_metadata.remixer_artist_ids).toEqual([remixer]);
        expect(after.custom_metadata.operator_note).toBe('Do not replace');
        expect(after.parent_id).toBe(fixture.albumId);
    });

    it('clears a removed performer tag without erasing an independent remixer relationship', async () => {
        const removed = await artist('Removed Performer');
        const remixer = await artist('Persistent Remixer');
        const fixture = await track({
            track_artist_credits: [{ id: removed, credited_name: 'Removed Performer' }],
            file_artist_ids: [removed],
            remixer_artist_ids: [remixer],
            additional_artist_ids: [removed, remixer],
            raw_artist_tags: { source: 'file' },
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.track_artist_credits).toEqual([]);
        expect(after.custom_metadata.file_artist_ids).toEqual([]);
        expect(after.custom_metadata.additional_artist_ids).toEqual([remixer]);
        expect(after.custom_metadata.remixer_artist_ids).toEqual([remixer]);
    });

    it('retains an old file performer when that identity independently remains the remixer', async () => {
        const former = await artist('Dual Role Artist');
        const current = await artist('Current Artist');
        const fixture = await track({
            artist: 'current artist',
            track_artist_credits: [{ id: former, credited_name: 'Dual Role Artist' }],
            file_artist_ids: [former],
            remixer_artist_ids: [former],
            additional_artist_ids: [former],
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.file_artist_ids).toEqual([current]);
        expect(after.custom_metadata.additional_artist_ids).toEqual(
            expect.arrayContaining([current, former]),
        );
        expect(after.custom_metadata.remixer_artist_ids).toEqual([former]);
    });

    it('does not overwrite newer source tags when a repair uses an older snapshot', async () => {
        await artist('Earlier Artist');
        const newer = await artist('Later Artist');
        const fixture = await track({ artist: 'earlier artist' });
        const stale = await snapshot(fixture.trackId);
        await sql`
            UPDATE media_items SET custom_metadata = ${sql.json({ artist: 'later artist', operator_note: 'newer' })}
            WHERE id = ${fixture.trackId}::uuid
        `;
        const current = await snapshot(fixture.trackId);
        expect(
            await reconcileTrackArtistCredits(sql, fixture.trackId, {
                expectedMetadata: stale.custom_metadata,
            }),
        ).toBe(false);
        expect(await snapshot(fixture.trackId)).toEqual(current);
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        expect((await snapshot(fixture.trackId)).custom_metadata.track_artist_credits).toEqual([
            { id: newer, credited_name: 'later artist' },
        ]);
    });

    it('prefers a known validated provider identity to a disagreeing tag spelling', async () => {
        const mbid = randomUUID();
        const canonical = await artist('Known Catalog Name', { musicbrainz_artist_id: mbid });
        const fixture = await track({ artist: 'Old Tagged Alias', musicbrainz_artist_ids: [mbid] });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        expect((await snapshot(fixture.trackId)).custom_metadata.track_artist_credits).toEqual([
            { id: canonical, credited_name: 'Old Tagged Alias' },
        ]);
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: canonical, title: 'Known Catalog Name' },
        ]);
    });

    it('leaves a conflicting provider claim unlinked rather than assigning the same-name artist', async () => {
        const canonical = await artist('Shared Artist Name', {
            musicbrainz_artist_id: randomUUID(),
        });
        const fixture = await track({
            artist: 'shared artist name',
            musicbrainz_artist_ids: [randomUUID()],
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.track_artist_credits).toEqual([
            { id: null, credited_name: 'shared artist name' },
        ]);
        expect(after.custom_metadata.file_artist_ids).not.toContain(canonical);
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: null, title: 'shared artist name' },
        ]);
    });

    it('refuses an ambiguous known provider identity claimed by two catalog rows', async () => {
        const sharedMbid = randomUUID();
        const first = await artist('Ambiguous First Artist', { musicbrainz_artist_id: sharedMbid });
        const second = await artist('Ambiguous Second Artist', {
            musicbrainz_artist_id: sharedMbid,
        });
        const fixture = await track({
            artist: 'unverified credit',
            musicbrainz_artist_ids: [sharedMbid],
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        expect(after.custom_metadata.track_artist_credits).toEqual([
            { id: null, credited_name: 'unverified credit' },
        ]);
        expect(after.custom_metadata.file_artist_ids).not.toContain(first);
        expect(after.custom_metadata.file_artist_ids).not.toContain(second);
    });

    it('never positionally assigns multiple provider IDs to one composite credit', async () => {
        const firstMbid = randomUUID();
        const secondMbid = randomUUID();
        const first = await artist('One Provider Artist', { musicbrainz_artist_id: firstMbid });
        const second = await artist('Another Provider Artist', {
            musicbrainz_artist_id: secondMbid,
        });
        const fixture = await track({
            artist: 'Unsplit Ensemble',
            musicbrainz_artist_ids: [firstMbid, secondMbid],
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const after = await snapshot(fixture.trackId);
        const ids = (
            after.custom_metadata.track_artist_credits as Array<{ id: string | null }>
        ).map((credit) => credit.id);
        expect(ids).not.toContain(first);
        expect(ids).not.toContain(second);
    });

    it('preserves intentional lowercase catalog spelling and dynamic canonical renames', async () => {
        const canonical = await artist('little lantern');
        const fixture = await track({ artist: 'LITTLE LANTERN' });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: canonical, title: 'little lantern' },
        ]);
        await sql`UPDATE media_items SET title = 'Lantern Ensemble' WHERE id = ${canonical}::uuid`;
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: canonical, title: 'Lantern Ensemble' },
        ]);
        expect((await snapshot(fixture.trackId)).custom_metadata.artist).toBe('LITTLE LANTERN');
    });

    it('uses complete library evidence when repairing an ambiguous collaboration credit', async () => {
        const north = await artist('North Lantern');
        const amber = await artist('Amber Harbor');
        const owner = await artist('Evidence Collection Curator');
        for (const credit of [
            'North Lantern',
            'North Lantern feat. Third Voice',
            'Amber Harbor',
            'Amber Harbor feat. Fourth Voice',
        ]) {
            await track({ artist: credit }, owner);
        }
        const collaboration = await track({ artist: 'north lantern & amber harbor' }, owner);
        await repairExistingTrackArtistCredits(sql);
        expect(
            (await snapshot(collaboration.trackId)).custom_metadata.track_artist_credits,
        ).toEqual([
            { id: north, credited_name: 'north lantern' },
            { id: amber, credited_name: 'amber harbor' },
        ]);
        await expectPairedReads(collaboration.trackId, collaboration.albumId, [
            { id: north, title: 'North Lantern' },
            { id: amber, title: 'Amber Harbor' },
        ]);
        expect(await repairExistingTrackArtistCredits(sql)).toMatchObject({
            scanned: 0,
            updated: 0,
            failed: 0,
            errors: [],
        });
    });

    it('keeps the canonical ID when an artist is renamed and the track is reconciled again', async () => {
        const canonical = await artist('Former Catalog Spelling');
        const fixture = await track({ artist: 'former catalog spelling' });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        await updateAndLockMediaItem(sql, canonical, 'admin', {
            title: 'Preferred Catalog Spelling',
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        expect((await snapshot(fixture.trackId)).custom_metadata.track_artist_credits).toEqual([
            { id: canonical, credited_name: 'former catalog spelling' },
        ]);
        await expectPairedReads(fixture.trackId, fixture.albumId, [
            { id: canonical, title: 'Preferred Catalog Spelling' },
        ]);
        const [count] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_items
            WHERE media_type = 'artist' AND status = 'active'
              AND lower(title) = 'former catalog spelling'
        `;
        expect(count.n).toBe(0);
    });

    it('does not collapse distinct non-Latin or punctuation-bearing catalog identities', async () => {
        const names = [
            'Север',
            'Вечер',
            'Αυγή',
            'Νύχτα',
            'Blue/Harbor',
            'Blue.Harbor',
            'BlueHarbor',
        ];
        const ids: string[] = [];
        for (const name of names) ids.push(await findOrCreateMusicArtist(sql, { name }));
        expect(new Set(ids).size).toBe(names.length);
        for (const [index, name] of names.entries()) {
            expect(await findOrCreateMusicArtist(sql, { name: `  ${name}  ` })).toBe(ids[index]);
        }
    });

    it('converges concurrent scan workers using independent database connections onto one artist', async () => {
        const owner = await artist('Concurrent Collection Curator');
        const fixtures = await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
                track({ artist: index % 2 ? 'racing lanterns' : 'Racing Lanterns' }, owner),
            ),
        );
        const clients = fixtures.map(() =>
            postgres(getTestDatabaseUrl(), { max: 1, onnotice: () => {} }),
        );
        try {
            const backends = await Promise.all(
                clients.map((client) => client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`),
            );
            expect(new Set(backends.map((rows) => rows[0].pid)).size).toBe(clients.length);
            await Promise.all(
                clients.map((client, index) =>
                    reconcileTrackArtistCredits(client, fixtures[index].trackId),
                ),
            );
            const results = await Promise.all(fixtures.map((fixture) => snapshot(fixture.trackId)));
            const ids = results.map(
                (row) => (row.custom_metadata.track_artist_credits as Array<{ id: string }>)[0].id,
            );
            expect(new Set(ids).size).toBe(1);
            expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/i);
            const [count] = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM media_items
                WHERE media_type = 'artist' AND status = 'active' AND lower(trim(title)) = 'racing lanterns'
            `;
            expect(count.count).toBe(1);
        } finally {
            await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
        }
    });

    it('creates the same new artists from concurrent reconciles in opposite orders without deadlock', async () => {
        const owner = await artist('Concurrency Curator');
        const pairs: string[] = [];
        for (let i = 0; i < 6; i++) {
            pairs.push(
                (await track({ artists: ['Brand New Alpha', 'Brand New Beta'] }, owner)).trackId,
            );
            pairs.push(
                (await track({ artists: ['Brand New Beta', 'Brand New Alpha'] }, owner)).trackId,
            );
        }
        await Promise.all(pairs.map((id) => reconcileTrackArtistCredits(sql, id)));
        const artists = await sql<{ title: string }[]>`
            SELECT title FROM media_items
            WHERE media_type = 'artist' AND title IN ('Brand New Alpha', 'Brand New Beta')
        `;
        expect(artists.map((a) => a.title).sort()).toEqual(['Brand New Alpha', 'Brand New Beta']);
    });

    it('stores an unresolved name once when the tags repeat it in another case or Unicode form', async () => {
        const fixture = await track({
            artists: ['Zoë Unknown', 'ZOË UNKNOWN', 'Zoe\u0308 Unknown', 'Other'],
        });
        await reconcileTrackArtistCredits(sql, fixture.trackId);
        const credits = (await snapshot(fixture.trackId)).custom_metadata.track_artist_credits as {
            credited_name: string;
        }[];
        expect(credits.map((c) => c.credited_name)).toEqual(['Zoë Unknown', 'Other']);
    });
});
