// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../tests/integration/setup/test-database.js';
import { placeInLibraryGroup } from '../../../../tests/integration/fixtures/library-access.fixtures.js';
import { previewAlbumMerge, applyAlbumMerge, AlbumMergeError } from './album-merge.service.js';
import { listSplitAlbumHealth } from '../database/queries/album-split-health.queries.js';
import { findExistingFolderAlbum } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/album-folder-resolver.js';
import { withTx } from '../database/with-tx.js';
import { searchAdminQuickNav } from '../database/queries/search.queries.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';
import { INVARIANTS } from './health-invariants/invariants.js';

vi.mock('./media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterDeleted: vi.fn().mockResolvedValue(undefined),
        afterMetadataChanged: vi.fn().mockResolvedValue(undefined),
    },
}));

const { cleared, published, imageInvalidated } = vi.hoisted(() => ({
    cleared: vi.fn(),
    published: vi.fn(),
    imageInvalidated: vi.fn(),
}));
vi.mock('../cache/index.js', async () => {
    const { CACHE_NAMESPACES } = await import('../cache/namespaces.js');
    return {
        CACHE_NAMESPACES,
        cacheManager: {
            for: (c: { name: string }) => ({
                clear: async () => {
                    cleared(c.name);
                },
            }),
        },
    };
});
vi.mock('../cache/namespace-clear-bus.js', () => ({ publishNamespaceClear: published }));
vi.mock('./image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateCatalogImage: imageInvalidated }),
}));

let sql: postgres.Sql;
let group: string, artist: string, guest: string, older: string, newer: string, user: string;
let tracks: string[], files: string[], ids: string[];
let playlist: number;
const uuid = (): string => crypto.randomUUID();
async function media(type: string, title: string, parent: string | null = null): Promise<string> {
    const id = uuid();
    ids.push(id);
    await sql`INSERT INTO media_items (id,media_type,title,parent_id,library_group_id) VALUES (${id},${type},${title},${parent},${group})`;
    return id;
}
async function track(
    album: string,
    title: string,
    number: number,
    folder: string,
    tag = 'Amber Meridian',
    credit = 'Vesper Loom',
): Promise<string> {
    const id = await media('track', title, album);
    await sql`UPDATE media_items SET custom_metadata=${sql.json({ album: tag, album_artist: credit, artist: 'Guest performer', disc_number: 1, track_number: number })} WHERE id=${id}`;
    const { fileId } = await placeInLibraryGroup(sql, {
        mediaItemId: id,
        mediaType: 'track',
        libraryGroupId: group,
    });
    files.push(fileId);
    tracks.push(id);
    await sql`UPDATE media_files SET file_path=${`/albummerge/${group}/${folder}/${id}.flac`},is_missing=false WHERE id=${fileId}`;
    return id;
}
function options() {
    return { keepId: newer, mergeId: older };
}

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    ids = [];
    files = [];
    tracks = [];
    cleared.mockClear();
    published.mockClear();
    imageInvalidated.mockClear();
    const [g] = await sql<
        { id: string }[]
    >`INSERT INTO library_groups (name) VALUES (${uuid()}) RETURNING id`;
    group = g.id;
    user = uuid();
    await sql`INSERT INTO users (id,username) VALUES (${user},${user})`;
    await sql`INSERT INTO user_profiles (user_id) VALUES (${user})`;
    artist = await media('artist', `Vesper Loom ${group}`);
    guest = await media('artist', `Guest ${group}`);
    older = await media('album', 'Amber Meridian', artist);
    newer = await media('album', 'Amber Meridian', guest);
    // The exact persisted credit is the current artist, independent of the two album parents.
    await sql`UPDATE media_items SET created_at=now()-interval '2 days' WHERE id=${older}`;
    await track(older, 'Song', 1, 'Amber Meridian/CD1', 'Amber Meridian', `Vesper Loom ${group}`);
    await track(
        newer,
        'Song',
        1,
        'Amber Meridian/Disc 2',
        'Amber Meridian',
        `Vesper Loom ${group}`,
    );
    await track(newer, 'Other', 2, 'Amber Meridian', 'Amber Meridian', `Vesper Loom ${group}`);
    const [p] = await sql<
        { id: number }[]
    >`INSERT INTO playlists (user_id,name) VALUES (${user},'Mix') RETURNING id`;
    playlist = p.id;
});
afterEach(async () => {
    await sql`DELETE FROM album_merge_receipts WHERE pair_ids && ${ids}::uuid[]`;
    await sql`DELETE FROM audit_log WHERE target=ANY(${ids}::text[])`;
    await sql`DELETE FROM media_items WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id=ANY(${files}::uuid[])`;
    await sql`DELETE FROM users WHERE id=${user}`;
    await sql`DELETE FROM library_groups WHERE id=${group}`;
});

describe('file-backed album merge', () => {
    it('previews and applies a title without locking metadata and keeps old scan aliases', async () => {
        await sql`UPDATE media_items SET title='Moonlit Routes CD1',custom_metadata=${sql.json({ scan_aliases: ['Moonlit Archive'] })} WHERE id=${older}`;
        await sql`UPDATE media_items SET title='Moonlit Routes - CD 2',custom_metadata=${sql.json({ scan_aliases: ['Moonlit Edition'] })} WHERE id=${newer}`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ album: 'Moonlit Routes CD1' })} WHERE parent_id=${older}`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ album: 'Moonlit Routes - CD 2', disc_number: 2 })} WHERE parent_id=${newer}`;
        const before =
            await sql`SELECT id,custom_metadata FROM media_items WHERE id=ANY(${tracks}::uuid[]) ORDER BY id`;
        const filesBefore =
            await sql`SELECT * FROM media_files WHERE id=ANY(${files}::uuid[]) ORDER BY id`;
        const original = await previewAlbumMerge(sql, options());
        const input = { ...options(), title: '  Moonlit Collection  ' };
        const { preview } = await previewAlbumMerge(sql, input);
        expect(preview.resultingTitle).toBe('Moonlit Collection');
        expect(preview.previewToken).not.toBe(original.preview.previewToken);
        await expect(
            applyAlbumMerge(
                sql,
                { ...input, title: 'Other Horizon', previewToken: preview.previewToken },
                'curator',
            ),
        ).rejects.toThrow(/changed/);
        const applied = await applyAlbumMerge(
            sql,
            { ...input, previewToken: preview.previewToken },
            'curator',
        );
        expect(await sql`SELECT title,metadata_locked FROM media_items WHERE id=${older}`).toEqual([
            { title: 'Moonlit Collection', metadata_locked: false },
        ]);
        const [row] = await sql<
            { aliases: string[] }[]
        >`SELECT custom_metadata->'scan_aliases' AS aliases FROM media_items WHERE id=${older}`;
        expect(row.aliases.sort()).toEqual(
            [
                'Moonlit Archive',
                'Moonlit Edition',
                'Moonlit Routes CD1',
                'Moonlit Routes - CD 2',
            ].sort(),
        );
        expect(
            await sql`SELECT id,custom_metadata FROM media_items WHERE id=ANY(${tracks}::uuid[]) ORDER BY id`,
        ).toEqual(before);
        expect(
            await sql`SELECT * FROM media_files WHERE id=ANY(${files}::uuid[]) ORDER BY id`,
        ).toEqual(filesBefore);
        // An arbitrary display rename also matches unchanged disc tags through aliases.
        expect(
            await findExistingFolderAlbum(
                sql,
                `/albummerge/${group}/Amber Meridian`,
                'Moonlit Routes',
                { album: 'Moonlit Routes CD1', albumArtist: `Vesper Loom ${group}` },
                group,
            ),
        ).toBe(older);
        expect(
            await applyAlbumMerge(sql, { ...input, previewToken: preview.previewToken }, 'curator'),
        ).toEqual(applied);
        await expect(
            applyAlbumMerge(
                sql,
                { ...input, title: 'Other Horizon', previewToken: preview.previewToken },
                'curator',
            ),
        ).rejects.toThrow(/Replay options/);
    });

    it('replays a legacy receipt without resultingTitle and still validates replay options', async () => {
        const { preview } = await previewAlbumMerge(sql, options());
        const input = { ...options(), previewToken: preview.previewToken };
        const applied = await applyAlbumMerge(sql, input, 'curator');
        await sql`UPDATE album_merge_receipts SET result=result #- '{preview,resultingTitle}'
            WHERE token=${preview.previewToken}`;
        expect(await applyAlbumMerge(sql, input, 'curator')).toEqual(applied);
        await expect(
            applyAlbumMerge(sql, { ...input, title: 'Amber Compass' }, 'curator'),
        ).rejects.toThrow(/Replay options/);
    });

    it('adds only the removed title when the survivor title is unchanged', async () => {
        await sql`UPDATE media_items SET title='Copper Sundial' WHERE id=${older}`;
        await sql`UPDATE media_items SET title='Copper Sundial CD2' WHERE id=${newer}`;
        const { preview } = await previewAlbumMerge(sql, options());
        await applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'curator');
        const [row] = await sql<{ aliases: string[] }[]>`
            SELECT custom_metadata->'scan_aliases' AS aliases FROM media_items WHERE id=${older}`;
        expect(row.aliases).toEqual(['Copper Sundial CD2']);
    });

    it('refuses a third album under the resulting title and rolls back', async () => {
        const input = { ...options(), title: 'Silver Transit' };
        const { preview } = await previewAlbumMerge(sql, input);
        await media('album', 'Silver Transit', artist);
        await expect(previewAlbumMerge(sql, input)).rejects.toThrow(/another album/);
        await expect(
            applyAlbumMerge(sql, { ...input, previewToken: preview.previewToken }, 'curator'),
        ).rejects.toThrow(/another album/);
        expect(await sql`SELECT id FROM media_items WHERE id IN (${older},${newer})`).toHaveLength(
            2,
        );
    });

    it('uses identical previews and applies across timezones with mixed credits, artwork and enrichment', async () => {
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ album_artist: `Guest ${group}`, artist: `Guest ${group}` })} WHERE id=${tracks[0]}`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || ${sql.json({ artist: `Vesper Loom ${group}` })} WHERE id=ANY(${tracks.slice(1)}::uuid[])`;
        const input = { ...options(), survivorId: newer };
        await sql`UPDATE media_items SET custom_poster_url=${'/api/image/custom/' + newer + '/poster'} WHERE id=${newer}`;
        await sql`INSERT INTO media_item_stage_state (media_item_id,stage_id,processing_version,status) VALUES (${newer},'album-enrichment',1,'completed'),(${older},'album-enrichment',1,'completed')`;
        await sql`UPDATE media_items SET metadata_locked_at='2026-08-19T22:10:02.123456Z' WHERE id=${newer}`;
        const viewer = postgres(getTestDatabaseUrl(), { max: 1, connection: { TimeZone: 'UTC' } });
        const writer = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { TimeZone: 'Europe/Berlin' },
        });
        try {
            const first = await previewAlbumMerge(viewer, input);
            expect(await previewAlbumMerge(viewer, input)).toEqual(first);
            expect(await previewAlbumMerge(writer, input)).toEqual(first);
            expect(first.preview.parentArtist).toMatchObject({
                title: `Vesper Loom ${group}`,
                various: false,
                source: 'album-tag',
            });
            expect(
                await applyAlbumMerge(
                    writer,
                    { ...input, previewToken: first.preview.previewToken },
                    'Denis',
                ),
            ).toEqual({ applied: true, preview: first.preview });
            expect(await writer`SHOW TimeZone`).toEqual([{ TimeZone: 'Europe/Berlin' }]);
        } finally {
            await Promise.all([viewer.end(), writer.end()]);
        }
    });
    it('preserves the survivor artist when track artist tags repeat their own titles', async () => {
        for (const [i, title] of ['Glass Orchard', 'Paper Comet', 'Silver Harbour'].entries()) {
            await sql`UPDATE media_items SET title=${title},custom_metadata=
                (custom_metadata-'album_artist'-'album_artists'-'title') ||
                ${sql.json({ artist: title })} WHERE id=${tracks[i]}`;
        }
        const input = { ...options(), survivorId: newer };
        const { preview } = await previewAlbumMerge(sql, input);
        expect(preview.parentArtist).toMatchObject({
            title: `Guest ${group}`,
            various: false,
            source: 'fallback',
        });
        expect(
            await applyAlbumMerge(
                sql,
                { ...input, previewToken: preview.previewToken },
                'Fixture Admin',
            ),
        ).toMatchObject({ applied: true });
        const [album] = await sql<{ parent_id: string; is_various_artists: boolean }[]>`
            SELECT parent_id,is_various_artists FROM media_items WHERE id=${newer}
        `;
        expect(album).toMatchObject({ parent_id: guest, is_various_artists: false });
    });
    it('rejects a concurrent reference update after waiting for its lock, even when counts stay the same', async () => {
        await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${newer},${user},3)`;
        const { preview } = await previewAlbumMerge(sql, options());
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const applier = postgres(getTestDatabaseUrl(), { max: 1 });
        let applying: Promise<unknown> | undefined;
        try {
            const [{ pid: writerPid }] = await writer<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const [{ pid: applierPid }] = await applier<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const reserved = await writer.reserve();
            try {
                await reserved`BEGIN`;
                await reserved`UPDATE user_ratings SET rating=4 WHERE media_id=${newer} AND user_id=${user}`;
                applying = applyAlbumMerge(
                    applier,
                    { ...options(), previewToken: preview.previewToken },
                    'Denis',
                ).catch((error: unknown) => error);
                await vi.waitFor(async () => {
                    const [{ blocked }] = await sql<
                        { blocked: boolean }[]
                    >`SELECT ${writerPid}::int=ANY(pg_blocking_pids(${applierPid}::int)) AS blocked`;
                    expect(blocked).toBe(true);
                });
                await reserved`COMMIT`;
                const error = await applying;
                expect(error).toBeInstanceOf(AlbumMergeError);
                expect(error).toMatchObject({
                    reason: 'conflict',
                    message: 'The albums changed. Preview the merge again',
                });
            } finally {
                await reserved`ROLLBACK`;
                reserved.release();
                await applying;
            }
            expect(
                await sql`SELECT rating FROM user_ratings WHERE media_id=${newer} AND user_id=${user}`,
            ).toEqual([{ rating: 4 }]);
            expect(
                await sql`SELECT id FROM media_items WHERE id IN (${older},${newer})`,
            ).toHaveLength(2);
            expect(await sql`SELECT id FROM media_items WHERE parent_id=${newer}`).toHaveLength(2);
            expect(
                await sql`SELECT 1 FROM album_merge_receipts WHERE pair_ids && ${ids}::uuid[]`,
            ).toHaveLength(0);
            expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(0);
        } finally {
            await Promise.all([writer.end(), applier.end()]);
        }
    });
    it.each(['album', 'reference'] as const)(
        'invalidates a preview for a one-microsecond %s timestamp change',
        async (target) => {
            await sql`UPDATE media_items SET metadata_locked_at='2026-08-19T22:10:02.123456Z' WHERE id=${newer}`;
            await sql`INSERT INTO media_item_stage_state (media_item_id,stage_id,processing_version,status,updated_at)
            VALUES (${newer},'album-enrichment',1,'completed','2026-08-19T22:10:02.123456Z')`;
            const { preview } = await previewAlbumMerge(sql, options());
            if (target === 'album') {
                await sql`UPDATE media_items SET metadata_locked_at=metadata_locked_at+interval '1 microsecond' WHERE id=${newer}`;
            } else {
                await sql`UPDATE media_item_stage_state SET updated_at=updated_at+interval '1 microsecond' WHERE media_item_id=${newer} AND stage_id='album-enrichment'`;
            }
            const refreshed = await previewAlbumMerge(sql, options());
            // Visible plans/counts stay identical; the hidden row snapshots must detect the change.
            expect({ ...refreshed.preview, previewToken: '' }).toEqual({
                ...preview,
                previewToken: '',
            });
            expect(refreshed.preview.previewToken).not.toBe(preview.previewToken);
            await expect(
                applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis'),
            ).rejects.toMatchObject({
                reason: 'conflict',
                message: 'The albums changed. Preview the merge again',
            });
        },
    );
    it('searches only album targets before applying the result limit', async () => {
        const results = await searchAdminQuickNav(
            sql,
            'Amber Meridian',
            unrestrictedAccess(),
            2,
            'album',
        );
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.media_type === 'album')).toBe(true);
        expect(results.map((r) => r.id).sort()).toEqual([older, newer].sort());
    });
    it('previews without writes, then applies exactly that plan with stable track/file IDs and preserved album data', async () => {
        await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${newer},${user},5)`;
        await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite,is_watched,watch_count) VALUES (${newer},${user},true,true,7),(${older},${user},false,false,2)`;
        await sql`INSERT INTO playlist_items (playlist_id,media_id,position,title) VALUES (${playlist},${newer},0,'Album')`;
        await sql`INSERT INTO media_artwork (media_item_id,artwork_type,file_path) VALUES (${newer},'poster','/old.jpg'),(${older},'poster','/keep.jpg')`;
        await sql`UPDATE media_items SET custom_poster_url=${'/api/image/custom/' + newer + '/poster'},custom_metadata='{"curator":"Denis","shared":"source"}'::jsonb WHERE id=${newer}`;
        await sql`UPDATE media_items SET custom_metadata='{"shared":"keep"}'::jsonb WHERE id=${older}`;
        await sql`INSERT INTO provider_metadata (media_id,provider,metadata) VALUES (${newer},'musicbrainz','{"title":"Source"}'::jsonb)`;
        await sql`INSERT INTO media_item_stage_state (media_item_id,stage_id,processing_version,status) VALUES (${newer},'album-enrichment',1,'completed'),(${older},'album-enrichment',1,'completed')`;
        const artworkBefore =
            await sql`SELECT id,file_path FROM image_candidates WHERE media_item_id IN (${older},${newer}) ORDER BY id`;
        const before =
            await sql`SELECT id,xmin::text FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id`;
        const result = await previewAlbumMerge(sql, options());
        expect(result.applied).toBe(false);
        const p = result.preview;
        expect(p.keepId).toBe(older);
        expect(p.trackCount).toBe(2);
        expect(p.resultingTrackCount).toBe(3);
        expect(p.tracksToMove.map((t) => t.id).sort()).toEqual(tracks.slice(1).sort());
        expect(p.duplicateCandidates).toHaveLength(1);
        expect(p.parentArtist).toMatchObject({
            id: artist,
            title: `Vesper Loom ${group}`,
            source: 'album-tag',
            various: false,
        });
        expect(p.albumData.find((d) => d.table === 'user_ratings')).toMatchObject({
            sourceCount: 1,
            policy: 'survivor-wins',
        });
        expect(
            await sql`SELECT id,xmin::text FROM media_items WHERE id=ANY(${ids}::uuid[]) ORDER BY id`,
        ).toEqual(before);
        expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(0);
        const applied = await applyAlbumMerge(
            sql,
            { ...options(), previewToken: p.previewToken },
            'Denis',
        );
        expect(applied).toEqual({ applied: true, preview: p });
        expect(cleared).toHaveBeenCalledWith('search-results-page-v5');
        expect(imageInvalidated).toHaveBeenCalledWith(older);
        expect(imageInvalidated).toHaveBeenCalledWith(newer);
        expect(published).toHaveBeenCalledWith(expect.arrayContaining(['music-similar-albums-v1']));
        expect(await sql`SELECT id FROM media_items WHERE id=${newer}`).toHaveLength(0);
        expect(
            (
                await sql<
                    { id: string; parent_id: string }[]
                >`SELECT id,parent_id FROM media_items WHERE id=ANY(${tracks}::uuid[])`
            ).every((t) => t.parent_id === older),
        ).toBe(true);
        expect(await sql`SELECT id FROM media_files WHERE id=ANY(${files}::uuid[])`).toHaveLength(
            3,
        );
        expect(
            await sql`SELECT media_item_id FROM media_file_items WHERE file_id=ANY(${files}::uuid[]) ORDER BY media_item_id`,
        ).toEqual(tracks.toSorted().map((id) => ({ media_item_id: id })));
        expect(await sql`SELECT rating FROM user_ratings WHERE media_id=${older}`).toEqual([
            { rating: 5 },
        ]);
        expect(
            await sql`SELECT is_favorite,is_watched,watch_count FROM user_media_state WHERE media_id=${older}`,
        ).toEqual([{ is_favorite: true, is_watched: true, watch_count: 7 }]);
        expect(
            await sql`SELECT media_id FROM playlist_items WHERE playlist_id=${playlist}`,
        ).toEqual([{ media_id: older }]);
        const [row] = await sql<
            {
                custom_metadata: Record<string, unknown>;
                custom_poster_url: string;
                has_files: boolean;
                parent_id: string;
            }[]
        >`SELECT custom_metadata,custom_poster_url,has_files,parent_id FROM media_items WHERE id=${older}`;
        expect(row).toMatchObject({
            has_files: true,
            parent_id: artist,
            custom_poster_url: '/api/image/custom/' + older + '/poster',
        });
        expect(row.custom_metadata).toMatchObject({
            curator: 'Denis',
            shared: 'keep',
            track_count: 3,
        });
        expect(
            await sql`SELECT file_path FROM image_candidates WHERE media_item_id=${older} AND artwork_type='poster' ORDER BY file_path`,
        ).toEqual([{ file_path: '/keep.jpg' }, { file_path: '/old.jpg' }]);
        expect(
            await sql`SELECT id,file_path FROM image_candidates WHERE media_item_id=${older} ORDER BY id`,
        ).toEqual(artworkBefore);
        expect(
            await sql`SELECT file_path FROM image_candidates WHERE media_item_id=${older} AND selected`,
        ).toEqual([{ file_path: '/keep.jpg' }]);
        expect(
            await sql`SELECT file_path FROM media_artwork WHERE media_item_id=${older} AND artwork_type='poster'`,
        ).toEqual([{ file_path: '/keep.jpg' }]);
        expect(row.custom_metadata.merged_albums).toEqual([
            expect.objectContaining({
                providerMetadata: [expect.objectContaining({ provider: 'musicbrainz' })],
                stageState: [expect.objectContaining({ status: 'completed' })],
            }),
        ]);
        expect(
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${older} AND stage_id='album-enrichment'`,
        ).toEqual([{ status: 'pending' }]);
        expect(
            await sql`SELECT actor,detail->>'oldId' AS old,detail->>'newId' AS new,detail->>'trackCount' AS tracks FROM audit_log WHERE target=${newer} AND source='admin'`,
        ).toEqual([{ actor: 'Denis', old: newer, new: older, tracks: '2' }]);
        expect(
            await applyAlbumMerge(sql, { ...options(), previewToken: p.previewToken }, 'Denis'),
        ).toEqual(applied);
        expect(imageInvalidated).toHaveBeenCalledTimes(2);
        expect(published).toHaveBeenCalledTimes(1);
        expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(1);
    });
    it('moves original candidate IDs before URL capture, merges normalized keys and preserves manual selection and suppressions', async () => {
        await sql`UPDATE media_items SET custom_poster_url='https://i.discogs.com/source.jpg' WHERE id=${newer}`;
        const [poster] = await sql<
            { id: string }[]
        >`SELECT id FROM image_candidates WHERE media_item_id=${newer} AND artwork_type='poster'`;
        const keptLogo = uuid();
        const duplicateLogo = uuid();
        const alternativeLogo = uuid();
        await sql`INSERT INTO image_candidates (id,media_item_id,artwork_type,source,provider,provider_ref,language,chosen_by,locked)
            VALUES (${keptLogo},${older},'logo','remote','tmdb','/same.png',NULL,'admin',true),
                (${duplicateLogo},${newer},'logo','remote','tmdb','/same.png','','user',true),
                (${alternativeLogo},${newer},'logo','remote','tmdb','/other.png','','user',true)`;
        await sql`INSERT INTO image_provider_suppressions (owner,provider,role) VALUES
            (${newer},'tvdb','poster'),(${newer},'deezer','*'),(${older},'deezer','*')`;
        await sql`INSERT INTO media_artwork_suppressions (media_item_id,artwork_type,file_path) VALUES
            (${newer},'poster','/hidden.jpg'),(${older},'poster','/hidden.jpg')`;
        const { preview } = await previewAlbumMerge(sql, options());
        expect(
            preview.albumData.find((d) => d.table === 'image_provider_suppressions'),
        ).toMatchObject({
            sourceCount: 2,
            survivorCount: 1,
        });
        await applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis');
        expect(
            await sql`SELECT id FROM image_candidates WHERE media_item_id=${older} ORDER BY id`,
        ).toEqual([poster.id, keptLogo, alternativeLogo].sort().map((id) => ({ id })));
        expect(
            await sql`SELECT id,locked FROM image_candidates WHERE media_item_id=${older} AND artwork_type='logo' AND selected`,
        ).toEqual([{ id: keptLogo, locked: true }]);
        expect(
            await sql`SELECT id FROM image_candidates WHERE media_item_id=${older} AND artwork_type='poster' AND selected`,
        ).toEqual([{ id: poster.id }]);
        expect(
            await sql`SELECT provider,role FROM image_provider_suppressions WHERE owner=${older} ORDER BY provider`,
        ).toEqual([
            { provider: 'deezer', role: '*' },
            { provider: 'tvdb', role: 'poster' },
        ]);
        expect(
            await sql`SELECT file_path FROM media_artwork_suppressions WHERE media_item_id=${older}`,
        ).toEqual([{ file_path: '/hidden.jpg' }]);
        expect(
            await sql`SELECT 1 FROM image_provider_suppressions WHERE owner=${newer}`,
        ).toHaveLength(0);
        await sql`SELECT register_image_candidate(${older},'poster','tvdb','/hidden-provider.jpg')`;
        expect(
            await sql`SELECT 1 FROM image_candidates WHERE media_item_id=${older} AND provider='tvdb'`,
        ).toHaveLength(0);
    });
    it('refuses a preview when provider suppressions change', async () => {
        const { preview } = await previewAlbumMerge(sql, options());
        await sql`INSERT INTO image_provider_suppressions (owner,provider,role) VALUES (${newer},'tmdb','*')`;
        await expect(
            applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis'),
        ).rejects.toThrow(/changed/);
        expect(await sql`SELECT id FROM media_items WHERE id IN (${older},${newer})`).toHaveLength(
            2,
        );
        expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(0);
    });
    it('lets the admin choose the survivor and derives the combined parent using the VA rule', async () => {
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album_artist":"Various Artists"}'::jsonb WHERE id=ANY(${tracks}::uuid[])`;
        const input = { ...options(), survivorId: newer };
        const { preview } = await previewAlbumMerge(sql, input);
        expect(preview.keepId).toBe(newer);
        expect(preview.parentArtist).toMatchObject({
            title: 'Various Artists',
            various: true,
            source: 'album-tag',
        });
        await applyAlbumMerge(sql, { ...input, previewToken: preview.previewToken }, 'Denis');
        const [row] = await sql<
            { id: string; parent_id: string }[]
        >`SELECT id,parent_id FROM media_items WHERE id=${newer}`;
        // The canonical VA artist may already exist in the integration database.
        const [parent] = await sql<
            { title: string }[]
        >`SELECT title FROM media_items WHERE id=${row.parent_id}`;
        expect(parent.title).toBe('Various Artists');
    });
    it('refuses locked albums unless preview and apply both explicitly override; preserves the lock', async () => {
        await sql`UPDATE media_items SET metadata_locked=true,metadata_locked_by='Denis' WHERE id=${newer}`;
        const { preview } = await previewAlbumMerge(sql, options());
        expect(preview.locks.requiresOverride).toBe(true);
        await expect(
            applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis'),
        ).rejects.toThrow(/locked/);
        const input = { ...options(), overrideLocks: true };
        const approved = await previewAlbumMerge(sql, input);
        await applyAlbumMerge(
            sql,
            { ...input, previewToken: approved.preview.previewToken },
            'Denis',
        );
        expect(
            await sql`SELECT metadata_locked,metadata_locked_by FROM media_items WHERE id=${older}`,
        ).toEqual([{ metadata_locked: true, metadata_locked_by: 'Denis' }]);
    });
    it('refuses a stale preview and rolls back all changes', async () => {
        const { preview } = await previewAlbumMerge(sql, options());
        await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${newer},${user},3)`;
        await expect(
            applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis'),
        ).rejects.toThrow(/changed/);
        expect(await sql`SELECT id FROM media_items WHERE id IN (${older},${newer})`).toHaveLength(
            2,
        );
        expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(0);
    });
    it('keeps overlapping merges atomic when different pairs compete for one album', async () => {
        const third = await media('album', 'Third album', guest);
        await track(third, 'Third song', 1, 'Third', 'Third album', `Vesper Loom ${group}`);
        const left = options();
        const right = { keepId: newer, mergeId: third, survivorId: third };
        const a = await previewAlbumMerge(sql, left);
        const b = await previewAlbumMerge(sql, right);
        const clients = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        try {
            const results = await Promise.allSettled([
                applyAlbumMerge(
                    clients[0],
                    { ...left, previewToken: a.preview.previewToken },
                    'Denis',
                ),
                applyAlbumMerge(
                    clients[1],
                    { ...right, previewToken: b.preview.previewToken },
                    'Denis',
                ),
            ]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
            expect(
                await sql`SELECT t.id FROM media_items t JOIN media_items a ON a.id=t.parent_id AND a.media_type='album' WHERE t.id=ANY(${tracks}::uuid[])`,
            ).toHaveLength(4);
            expect(
                await sql`SELECT id FROM media_files WHERE id=ANY(${files}::uuid[])`,
            ).toHaveLength(4);
        } finally {
            await Promise.all(clients.map((c) => c.end()));
        }
    });
    it('serializes concurrent applies on separate physical connections and audits once', async () => {
        const { preview } = await previewAlbumMerge(sql, options());
        const clients = [
            postgres(getTestDatabaseUrl(), { max: 1 }),
            postgres(getTestDatabaseUrl(), { max: 1 }),
        ];
        try {
            const results = await Promise.all(
                clients.map((c) =>
                    applyAlbumMerge(
                        c,
                        { ...options(), previewToken: preview.previewToken },
                        'Denis',
                    ),
                ),
            );
            expect(results[0]).toEqual(results[1]);
            expect(await sql`SELECT id FROM media_items WHERE parent_id=${older}`).toHaveLength(3);
            expect(await sql`SELECT 1 FROM audit_log WHERE target=${newer}`).toHaveLength(1);
        } finally {
            await Promise.all(clients.map((c) => c.end()));
        }
    });
});

describe('possible split album health check', () => {
    it('finds a shared folder/tag/credit pair across disc folders; ignores distinct album tags and credits', async () => {
        const other = await media('album', 'Different release', artist);
        await track(
            other,
            'Different',
            1,
            'Amber Meridian',
            'Different release',
            `Vesper Loom ${group}`,
        );
        const another = await media('album', 'Different credit', artist);
        await track(
            another,
            'Different artist',
            1,
            'Amber Meridian',
            'Amber Meridian',
            'Other credit',
        );
        const differentLibrary = await media('album', 'Other library', guest);
        const differentTrack = await track(
            differentLibrary,
            'Library peer',
            1,
            'Amber Meridian',
            'Amber Meridian',
            `Vesper Loom ${group}`,
        );
        await sql`UPDATE media_files SET library_group_id=NULL WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id=${differentTrack})`;
        await sql`UPDATE album_split_health_cursor SET after_id=NULL WHERE singleton`;
        const invariant = INVARIANTS.find((i) => i.id === 'possible-split-albums')!;
        expect(invariant.label).toBe('Possible split albums');
        expect(await withTx(sql, invariant.query)).toBeGreaterThan(0);
        expect(await invariant.details!(sql)).toContainEqual(
            expect.objectContaining({
                href: `/admin/library/media/${[older, newer].sort()[0]}?mergeWith=${[older, newer].sort()[1]}`,
            }),
        );
        const pairs = (await listSplitAlbumHealth(sql)).filter(
            (p) => ids.includes(p.album_a) || ids.includes(p.album_b),
        );
        expect(pairs).toEqual([
            expect.objectContaining({
                album_a: [older, newer].sort()[0],
                album_b: [older, newer].sort()[1],
            }),
        ]);
        const { preview } = await previewAlbumMerge(sql, options());
        await applyAlbumMerge(sql, { ...options(), previewToken: preview.previewToken }, 'Denis');
        expect(
            (await listSplitAlbumHealth(sql)).filter(
                (p) => ids.includes(p.album_a) || ids.includes(p.album_b),
            ),
        ).toEqual([]);
    });
});
