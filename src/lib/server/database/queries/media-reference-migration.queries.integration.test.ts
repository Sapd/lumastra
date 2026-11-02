// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    moveMediaReferences,
    MOVED_MEDIA_REFERENCE_COLUMNS,
    MOVED_POLYMORPHIC_REFERENCE_TABLES,
} from './media-reference-migration.queries.js';
import { mediaReferenceGuard } from './media-retention.queries.js';
import { deleteEmptyAlbum, reparentAlbumToArtist } from './artist-merge.queries.js';
import { withTx } from '../with-tx.js';
import { withArtworkChoice, undoArtworkChoice } from '../../services/artwork-choice.service.js';

const rollback = new Error('rollback test fixtures');
let db: postgres.Sql;

interface Fx {
    sql: postgres.Sql;
    user: string;
    other: string;
    dup: string;
    keep: string;
    playlist: number;
}

async function inFixture(fn: (fx: Fx) => Promise<void>): Promise<void> {
    try {
        await db.begin(async (raw) => {
            const sql = raw as unknown as postgres.Sql;
            const user = crypto.randomUUID(),
                other = crypto.randomUUID();
            for (const id of [user, other]) {
                await sql`INSERT INTO users (id, username) VALUES (${id}, ${id})`;
                await sql`INSERT INTO user_profiles (user_id) VALUES (${id})`;
            }
            const artist = await mediaRow(sql, 'artist', null);
            const keep = await mediaRow(sql, 'album', artist);
            const dup = await mediaRow(sql, 'album', artist);
            const [{ id: playlist }] = await sql<{ id: number }[]>`
                INSERT INTO playlists (user_id, name) VALUES (${user}, 'mix') RETURNING id
            `;
            await fn({ sql, user, other, dup, keep, playlist });
            throw rollback;
        });
    } catch (error) {
        if (error !== rollback) throw error;
    }
}

async function mediaRow(sql: postgres.Sql, type: string, parent: string | null): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO media_items (id, title, media_type, parent_id) VALUES (${id}, ${`${type} ${id}`}, ${type}, ${parent})`;
    return id;
}

/** Every (table, column) the migration covers, with the media id stored as a uuid. */
const UUID_REFERENCES: ReadonlyArray<[string, string]> = [
    ['admin_media_change_receipts', 'media_item_id'],
    ['media_artwork', 'media_item_id'],
    ['user_ratings', 'media_id'],
    ['user_suggestions', 'media_id'],
    ['user_media_state', 'media_id'],
    ['user_rate_skips', 'media_id'],
    ['user_taste_dampers', 'media_id'],
    ['user_media_share_opt_out', 'media_id'],
    ['watch_state_sync_log', 'media_id'],
    ['library_availability', 'media_id'],
    ['series_episode_ordering', 'media_id'],
    ['media_artwork_suppressions', 'media_item_id'],
    ['cached_list_items', 'media_id'],
    ['user_music_state', 'track_id'],
    ['watchlist_activities', 'media_id'],
    ['play_sessions', 'media_id'],
    ['watch_history', 'media_id'],
    ['user_media_events_archive', 'media_id'],
    ['watch_state_pending_resolution', 'internal_media_id'],
    ['training_assignments', 'media_id'],
    ['course_modules', 'media_item_id'],
    ['courses', 'cover_media_id'],
    ['upload_sessions', 'media_item_id'],
    ['playback_incident_events', 'media_id'],
    ['transcode_failure_events', 'media_id'],
    ['hls_playback_tokens', 'media_item_id'],
    ['user_media_events', 'media_id'],
    ['music_listen_events', 'track_id'],
    ['playlist_items', 'media_id'],
    ['media_annotations', 'media_id'],
    ['personal_media_dispositions', 'media_id'],
    ['watch_sync_activity', 'media_id'],
    ['external_ids', 'media_id'],
];

/** One reference row per covered table, all pointing at `id` for `user`. */
async function seedEveryReference(fx: Fx, id: string, legacyId: string): Promise<void> {
    const { sql, user, playlist } = fx;
    await sql`INSERT INTO admin_media_change_receipts (media_item_id,owner,kind,before_state,after_state,actor) VALUES (${id},${id},'file-mapping:test','{}','{}','admin')`;
    const listId = `list-${crypto.randomUUID()}`;
    await sql`INSERT INTO cached_lists (list_id, name, list_path) VALUES (${listId}, 'list', '/list')`;
    const [group] = await sql<{ id: string }[]>`
        INSERT INTO library_groups (name) VALUES (${crypto.randomUUID()}) RETURNING id
    `;
    const [libraryPath] = await sql<{ id: string }[]>`
        INSERT INTO library_paths (path, media_type, provider, library_group_id)
        VALUES (${'/lib/' + crypto.randomUUID()}, 'music', 'musicbrainz', ${group.id})
        RETURNING id
    `;

    await sql`INSERT INTO media_artwork (media_item_id,artwork_type,file_path) VALUES (${id},'poster','/art/album.jpg')`;
    await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${id}, 4)`;
    await sql`INSERT INTO user_suggestions (user_id, media_id) VALUES (${user}, ${id})`;
    await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite) VALUES (${user}, ${id}, true)`;
    await sql`INSERT INTO user_rate_skips (user_id, media_id) VALUES (${user}, ${id})`;
    await sql`INSERT INTO user_taste_dampers (user_id, media_id, media_type, expires_at)
        VALUES (${user}, ${id}, 'movie', NOW() + INTERVAL '1 day')`;
    await sql`INSERT INTO user_media_share_opt_out (user_id, media_id) VALUES (${user}, ${id})`;
    await sql`INSERT INTO watch_state_sync_log (user_id, media_id, provider) VALUES (${user}, ${id}, 'trakt')`;
    await sql`INSERT INTO library_availability (media_id, library, library_item_id) VALUES (${id}, 'jellyfin', 'x')`;
    await sql`INSERT INTO series_episode_ordering (media_id) VALUES (${id})`;
    await sql`INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
        VALUES (${id}, 'poster', '/art/poster.jpg')`;
    await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${listId}, ${id}, 1)`;
    await sql`INSERT INTO user_music_state (user_id, track_id) VALUES (${user}, ${id})`;
    await sql`INSERT INTO watchlist_activities (user_id, activity_type, tmdb_id, media_type, title, media_id)
        VALUES (${user}, 'add', 1, 'movie', 'x', ${id})`;
    await sql`INSERT INTO play_sessions (media_id, user_id, device_id, ip_address, play_method)
        VALUES (${id}, ${user}, 'device', '127.0.0.1', 'direct')`;
    await sql`INSERT INTO watch_history (user_id, media_type, session_start_time, media_id)
        VALUES (${user}, 'album', NOW(), ${id})`;
    await sql`INSERT INTO user_media_events_archive (id, user_id, media_id, event_type, source, occurred_at, recorded_at)
        VALUES (gen_random_uuid(), ${user}, ${id}, 'progress', 'lumastra', NOW(), NOW())`;
    await sql`INSERT INTO watch_state_pending_resolution (user_id, provider, media_type, provider_id, internal_media_id)
        VALUES (${user}, 'trakt', 'movie', ${crypto.randomUUID()}, ${id})`;
    await sql`INSERT INTO training_assignments (title, item_kind, target_kind, assigned_by, media_id, target_user_id)
        VALUES ('watch', 'media', 'user', ${user}, ${id}, ${user})`;
    const [course] = await sql<{ id: string }[]>`
        INSERT INTO courses (title, slug, created_by, cover_media_id)
        VALUES ('course', ${'c-' + crypto.randomUUID()}, ${user}, ${id}) RETURNING id
    `;
    await sql`INSERT INTO course_modules (course_id, kind, title, media_item_id)
        VALUES (${course.id}, 'video', 'module', ${id})`;
    await sql`INSERT INTO upload_sessions (library_path_id, uploader_user, filename, mime_type, total_size, total_chunks, staging_dir, media_item_id)
        VALUES (${libraryPath.id}, 'u', 'f.flac', 'audio/flac', 1, 1, '/tmp/x', ${id})`;
    await sql`INSERT INTO playback_incident_events (attempt_id, play_session_id, incident_at, trigger_type, media_id)
        VALUES ('a', 'p', NOW(), 'stall', ${id})`;
    await sql`INSERT INTO transcode_failure_events (job_id, play_session_id, outcome, category, media_id)
        VALUES ('j', 'p', 'failed', 'other', ${id})`;
    await sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, media_item_id)
        VALUES (${crypto.randomUUID()}, 'u', ${user}, '127.0.0.1', NOW() + INTERVAL '1 hour', ${id})`;
    await sql`INSERT INTO user_media_events (user_id, media_id, event_type, source, occurred_at, source_event_id)
        VALUES (${user}, ${id}, 'progress', 'lumastra-player', NOW(), ${crypto.randomUUID()})`;
    await sql`INSERT INTO music_listen_events (user_id, track_id, event_id)
        VALUES (${user}, ${id}, ${crypto.randomUUID()})`;
    await sql`INSERT INTO playlist_items (playlist_id, title, position, media_id)
        VALUES (${playlist}, 'item', 1, ${id})`;
    await sql`INSERT INTO media_annotations (media_id, user_id, type, content)
        VALUES (${id}, ${user}, 'review', 'great')`;
    await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by, created_at)
        VALUES (${id}, 'kept', ${user}, '2026-09-03T12:34:56Z')`;
    await sql`INSERT INTO watch_sync_activity (user_id, provider, direction, outcome, media_id)
        VALUES (${user}, 'trakt', 'push', 'skipped', ${id})`;
    await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
        VALUES (${id}, 'musicbrainz', ${crypto.randomUUID()}, 'album')`;
    await sql`INSERT INTO interactions (target_type, target_id, user_id, body)
        VALUES ('media', ${legacyId}, ${user}, 'nice')`;
    await sql`INSERT INTO interaction_reactions (target_type, target_id, user_id, emoji)
        VALUES ('media', ${legacyId}, ${user}, '+1')`;
    await sql`INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
        VALUES (${user}, ${legacyId}, 'album', 'dismissed_cw')`;
}

async function countRefs(sql: postgres.Sql, id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const [table, column] of UUID_REFERENCES) {
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(column)} = ${id}
        `;
        counts[table] = n;
    }
    for (const table of ['interactions', 'interaction_reactions', 'user_media_flags']) {
        const [{ n }] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE target_id = ${id}
        `;
        counts[table] = n;
    }
    return counts;
}

async function passesGuard(sql: postgres.Sql, id: string): Promise<boolean> {
    const rows =
        await sql`SELECT 1 FROM media_items mi WHERE mi.id = ${id} AND ${mediaReferenceGuard(sql, 'mi')}`;
    return rows.length === 1;
}

describe('album merge audit and album-level data', () => {
    beforeAll(() => {
        db = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    it('transfers state, ratings, playlists, images and custom metadata before deleting the old id', async () => {
        await inFixture(async (fx) => {
            const { sql, dup, keep, user, playlist } = fx;
            await sql`INSERT INTO user_media_state (media_id,user_id,is_watched,watch_count) VALUES (${dup},${user},true,7)`;
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${dup},${user},5)`;
            await sql`INSERT INTO playlist_items (playlist_id,media_id,position,title) VALUES (${playlist},${dup},0,'Album')`;
            await sql`INSERT INTO media_artwork (media_item_id,artwork_type,file_path) VALUES (${dup},'poster','/art/old.jpg')`;
            await sql`UPDATE media_items SET custom_metadata='{"curator":"Michael","shared":"old"}'::jsonb, poster_blurhash='blur', overview='Album description' WHERE id=${dup}`;
            await sql`UPDATE media_items SET custom_metadata='{"shared":"survivor"}'::jsonb WHERE id=${keep}`;
            expect(await deleteEmptyAlbum(sql, dup, keep, 'album-tag')).toBe(true);
            expect(await sql`SELECT 1 FROM media_items WHERE id=${dup}`).toHaveLength(0);
            expect(
                await sql`SELECT watch_count,is_watched FROM user_media_state WHERE media_id=${keep} AND user_id=${user}`,
            ).toEqual([{ watch_count: 7, is_watched: true }]);
            expect(
                await sql`SELECT rating FROM user_ratings WHERE media_id=${keep} AND user_id=${user}`,
            ).toEqual([{ rating: 5 }]);
            expect(
                await sql`SELECT media_id FROM playlist_items WHERE playlist_id=${playlist}`,
            ).toEqual([{ media_id: keep }]);
            expect(
                await sql`SELECT file_path FROM media_artwork WHERE media_item_id=${keep}`,
            ).toEqual([{ file_path: '/art/old.jpg' }]);
            expect(
                await sql`SELECT custom_metadata,poster_blurhash,overview FROM media_items WHERE id=${keep}`,
            ).toEqual([
                {
                    custom_metadata: { curator: 'Michael', shared: 'survivor' },
                    poster_blurhash: 'blur',
                    overview: 'Album description',
                },
            ]);
            const [audit] = await sql<
                { actor: string; detail: Record<string, unknown> }[]
            >`SELECT actor,detail FROM audit_log WHERE target=${dup} AND action='music.album.merge'`;
            expect(audit.actor).toBe('system task');
            expect(audit.detail).toMatchObject({
                albumId: dup,
                survivorAlbumId: keep,
                ruleSource: 'album-tag',
            });
            expect(audit.detail.oldParent).toBe(audit.detail.newParent);
        });
    });
    it('preserves conflicting artwork alternatives and rewrites built-in image URLs', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            await sql`INSERT INTO media_artwork (media_item_id,artwork_type,file_path) VALUES (${dup},'poster','/old.jpg'), (${keep},'poster','/keep.jpg')`;
            await sql`UPDATE media_items SET custom_poster_url=${'/api/image/custom/' + dup + '/poster'} WHERE id=${dup}`;
            await deleteEmptyAlbum(sql, dup, keep, 'album-tag');
            const [row] = await sql<
                { custom_poster_url: string; custom_metadata: Record<string, unknown> }[]
            >`SELECT custom_poster_url,custom_metadata FROM media_items WHERE id=${keep}`;
            expect(row.custom_poster_url).toBe('/api/image/custom/' + keep + '/poster');
            expect(row.custom_metadata.merged_album_artwork).toEqual([
                expect.objectContaining({ file_path: '/old.jpg' }),
            ]);
            expect(
                await sql`SELECT file_path FROM media_artwork WHERE media_item_id=${keep}`,
            ).toEqual([{ file_path: '/keep.jpg' }]);
        });
    });

    it('audits re-parenting atomically and does not audit a no-op or lock', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            const target = await mediaRow(sql, 'artist', null);
            await reparentAlbumToArtist(sql, dup, target, {
                respectMetadataLock: true,
                ruleSource: 'track-artists',
            });
            await reparentAlbumToArtist(sql, dup, target, {
                respectMetadataLock: true,
                ruleSource: 'track-artists',
            });
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${keep}`;
            await reparentAlbumToArtist(sql, keep, target, {
                respectMetadataLock: true,
                ruleSource: 'compilation',
            });
            const audit = await sql<
                { detail: Record<string, unknown> }[]
            >`SELECT detail FROM audit_log WHERE target=${dup} AND action='music.album.reparent'`;
            expect(audit).toHaveLength(1);
            expect(audit[0].detail).toMatchObject({
                albumId: dup,
                newParent: target,
                ruleSource: 'track-artists',
            });
            expect(await sql`SELECT 1 FROM audit_log WHERE target=${keep}`).toHaveLength(0);
        });
    });
});

describe('moveMediaReferences', () => {
    beforeAll(() => {
        db = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('does not lock unrelated receipts whose user content mentions the merged id', async () => {
        const dup = await mediaRow(db, 'album', null);
        const keep = await mediaRow(db, 'album', null);
        const unrelated = await mediaRow(db, 'movie', null);
        const state = { bytes: Buffer.alloc(65536, 'x').toString('base64'), note: dup };
        const [receipt] = await db`INSERT INTO admin_media_change_receipts
            (owner,media_item_id,kind,before_state,after_state,actor)
            VALUES (${unrelated},${unrelated},'file-chapters:unrelated',${db.json(state)},${db.json(state)},'admin') RETURNING id`;
        const locker = await db.reserve();
        try {
            await locker`BEGIN`;
            await locker`SELECT id FROM admin_media_change_receipts WHERE id=${receipt.id} FOR UPDATE`;
            await withTx(db, async (tx) => {
                await tx`SET LOCAL lock_timeout='200ms'`;
                await moveMediaReferences(tx, dup, keep);
            });
            const [untouched] =
                await locker`SELECT before_state,after_state FROM admin_media_change_receipts WHERE id=${receipt.id}`;
            expect(untouched.before_state).toEqual(state);
            expect(untouched.after_state).toEqual(state);
        } finally {
            await locker`ROLLBACK`;
            locker.release();
            await db`DELETE FROM media_items WHERE id=ANY(${[dup, keep, unrelated]}::uuid[])`;
        }
    });
    it.each([
        {
            kind: 'file-mapping:parents',
            before: { items: [{ id: 'other', parent_id: 'source' }] },
            after: {},
        },
        { kind: 'file-mapping:after', before: {}, after: { ids: ['source'] } },
        {
            kind: 'file-mapping:displaced',
            before: { sets: [{ entries: [{ mediaItemId: 'source' }] }] },
            after: {},
        },
        { kind: 'segments', before: { inputs: [{ id: 'other', parent_id: 'source' }] }, after: {} },
        {
            kind: 'file-chapters:shared',
            before: { database: { links: [{ media_item_id: 'source' }] }, bytes: 'opaque' },
            after: {},
        },
        {
            kind: 'episode-exchange',
            before: {},
            after: { secondId: 'source', guard: { owners: [['source']] } },
        },
    ])('finds cross-owner structural references in $kind', async ({ kind, before, after }) => {
        await inFixture(async ({ sql, dup, keep }) => {
            const originalBefore = JSON.parse(JSON.stringify(before).replaceAll('source', dup));
            const originalAfter = JSON.parse(JSON.stringify(after).replaceAll('source', dup));
            const [receipt] = await sql`INSERT INTO admin_media_change_receipts
                (owner,media_item_id,kind,before_state,after_state,actor)
                VALUES (${keep},${keep},${kind},${sql.json(originalBefore)},${sql.json(originalAfter)},'admin') RETURNING id`;
            await moveMediaReferences(sql, dup, keep);
            const [moved] =
                await sql`SELECT before_state,after_state FROM admin_media_change_receipts WHERE id=${receipt.id}`;
            expect(moved.before_state).toEqual(
                JSON.parse(JSON.stringify(originalBefore).replaceAll(dup, keep)),
            );
            expect(moved.after_state).toEqual(
                JSON.parse(JSON.stringify(originalAfter).replaceAll(dup, keep)),
            );
        });
    });
    it('installs a partial GIN index for shared receipt media references', async () => {
        const [index] = await db`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema()
            AND indexname='admin_media_change_shared_references'`;
        expect(index?.indexdef).toContain('USING gin');
        expect(index.indexdef).toContain('admin_media_change_reference_ids(before_state)');
        expect(index.indexdef).toContain('admin_media_change_reference_ids(after_state)');
        expect(index.indexdef).toContain('undone_at IS NULL');
    });
    it('retains recovery receipts when the merged source is deleted', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            const [receipt] =
                await sql`INSERT INTO admin_media_change_receipts (media_item_id,owner,kind,before_state,after_state,actor) VALUES (${dup},${dup},'file-mapping:test','{}','{}','admin') RETURNING id`;
            await moveMediaReferences(sql, dup, keep);
            await sql`DELETE FROM media_items WHERE id=${dup}`;
            expect(
                await sql`SELECT media_item_id FROM admin_media_change_receipts WHERE id=${receipt.id}`,
            ).toEqual([{ media_item_id: keep }]);
        });
    });
    it('re-keys receipt owners and media references so Undo works after source deletion', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            await sql`INSERT INTO media_artwork_suppressions(media_item_id,artwork_type,file_path)
                VALUES (${dup},'poster','/invented/old-hidden.jpg')`;
            const saved = await withArtworkChoice(sql, dup, 'admin', async (tx) => {
                await tx`INSERT INTO media_artwork_suppressions(media_item_id,artwork_type,file_path)
                    VALUES (${dup},'poster','/invented/new-hidden.jpg')`;
                return true;
            });
            await moveMediaReferences(sql, dup, keep);
            await sql`DELETE FROM media_items WHERE id=${dup}`;
            const [receipt] =
                await sql`SELECT owner,media_item_id,before_state,after_state FROM admin_media_change_receipts WHERE id=${saved.undoId!}`;
            expect(receipt.owner).toBe(keep);
            expect(receipt.media_item_id).toBe(keep);
            expect(receipt.before_state.paths).toEqual([
                expect.objectContaining({ media_item_id: keep }),
            ]);
            expect(receipt.after_state.paths).toHaveLength(2);
            expect(
                receipt.after_state.paths.every(
                    (p: { media_item_id: string }) => p.media_item_id === keep,
                ),
            ).toBe(true);
            await undoArtworkChoice(sql, keep, saved.undoId!);
            expect(
                await sql`SELECT media_item_id,file_path FROM media_artwork_suppressions WHERE media_item_id=${keep}`,
            ).toEqual([{ media_item_id: keep, file_path: '/invented/old-hidden.jpg' }]);
        });
    });
    it('re-keys media ids in cross-owner snapshots while preserving file ids and user content', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            const state = {
                ids: [dup],
                items: [{ id: dup, parent_id: dup }],
                links: [{ media_item_id: dup, file_id: dup }],
                files: [{ id: dup, file_path: dup }],
                sets: [{ file_id: dup, entries: [{ mediaItemId: dup, title: dup }] }],
            };
            const [receipt] =
                await sql`INSERT INTO admin_media_change_receipts(owner,media_item_id,kind,before_state,after_state,actor)
                VALUES (${keep},${keep},'file-mapping:invented',${sql.json(state)},${sql.json(state)},'admin') RETURNING id`;
            const output = {
                value: { media_item_id: dup, id: dup, text: dup },
                input: { files: [{ link: { media_item_id: dup, file_id: dup } }] },
            };
            const [curated] =
                await sql`INSERT INTO admin_media_change_receipts(owner,media_item_id,kind,before_state,after_state,actor)
                VALUES (${dup},${dup},'output:chapters',${sql.json(output)},${sql.json(output)},'admin') RETURNING id`;
            await moveMediaReferences(sql, dup, keep);
            await sql`DELETE FROM media_items WHERE id=${dup}`;
            const [moved] =
                await sql`SELECT owner,before_state,after_state FROM admin_media_change_receipts WHERE id=${receipt.id}`;
            const expected = {
                ids: [keep],
                items: [{ id: keep, parent_id: keep }],
                links: [{ media_item_id: keep, file_id: dup }],
                files: [{ id: dup, file_path: dup }],
                sets: [{ file_id: dup, entries: [{ mediaItemId: keep, title: dup }] }],
            };
            expect(moved.owner).toBe(keep);
            expect(moved.before_state).toEqual(expected);
            expect(moved.after_state).toEqual(expected);
            const [content] =
                await sql`SELECT owner,after_state FROM admin_media_change_receipts WHERE id=${curated.id}`;
            expect(content.owner).toBe(keep);
            expect(content.after_state.value).toEqual(output.value);
            expect(content.after_state.input.files[0].link).toEqual({
                media_item_id: keep,
                file_id: dup,
            });
        });
    });
    it('moves a reference from every covered table and leaves the duplicate unreferenced', async () => {
        await inFixture(async (fx) => {
            const { sql, dup, keep, user } = fx;
            // Polymorphic targets stored in a legacy spelling: dashless and upper case.
            await seedEveryReference(fx, dup, dup.replace(/-/g, '').toUpperCase());
            expect(await passesGuard(sql, dup)).toBe(false);

            const outcome = await moveMediaReferences(sql, dup, keep);

            expect(outcome.dropped).toBe(0);
            expect(outcome.moved).toBe(UUID_REFERENCES.length + 3);
            expect(Object.values(await countRefs(sql, dup)).every((n) => n === 0)).toBe(true);
            const onKeep = await countRefs(sql, keep);
            for (const [table, n] of Object.entries(onKeep)) expect([table, n]).toEqual([table, 1]);
            expect(
                await sql`SELECT decided_by, created_at FROM personal_media_dispositions WHERE media_id = ${keep}`,
            ).toEqual([{ decided_by: user, created_at: new Date('2026-09-03T12:34:56Z') }]);
            expect(await passesGuard(sql, dup)).toBe(true);
        });
    });

    it('keeps the survivor row on a unique-key conflict and moves everything else', async () => {
        await inFixture(async ({ sql, user, other, dup, keep, playlist }) => {
            // Same user rated, favorited, playlisted, reviewed, flagged and reacted to both.
            for (const [id, rating] of [
                [keep, 5],
                [dup, 1],
            ] as const) {
                await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${id}, ${rating})`;
                await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite) VALUES (${user}, ${id}, ${id === keep})`;
                await sql`INSERT INTO playlist_items (playlist_id, title, position, media_id)
                    VALUES (${playlist}, ${id}, ${rating}, ${id})`;
                await sql`INSERT INTO media_annotations (media_id, user_id, type, content)
                    VALUES (${id}, ${user}, 'review', ${id})`;
                await sql`INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                    VALUES (${user}, ${id}, 'album', 'dismissed_cw')`;
                await sql`INSERT INTO interaction_reactions (target_type, target_id, user_id, emoji)
                    VALUES ('media', ${id}, ${user}, '+1')`;
                await sql`INSERT INTO user_media_events (user_id, media_id, event_type, source, occurred_at, source_event_id)
                    VALUES (${user}, ${id}, 'progress', 'jellyfin-sync', NOW(), 'evt-1')`;
                await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                    VALUES (${id}, 'musicbrainz', ${crypto.randomUUID()}, 'album', ${id === keep})`;
            }
            await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by, created_at)
                VALUES (${keep}, 'kept', 'survivor-decision', '2026-09-04T12:00:00Z'),
                       (${dup}, 'kept', 'duplicate-decision', '2026-09-05T12:00:00Z')`;
            // Not conflicting: another user's rating, a chat note, an event without a source id,
            // and a primary id of another media type.
            await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${other}, ${dup}, 3)`;
            await sql`INSERT INTO media_annotations (media_id, user_id, type, content)
                VALUES (${dup}, ${user}, 'chat', 'hello')`;
            await sql`INSERT INTO user_media_events (user_id, media_id, event_type, source, occurred_at)
                VALUES (${user}, ${dup}, 'progress', 'jellyfin-sync', NOW())`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${dup}, 'musicbrainz', ${crypto.randomUUID()}, 'release-group', true)`;

            const outcome = await moveMediaReferences(sql, dup, keep);
            expect(outcome.dropped).toBe(9);

            expect(Object.values(await countRefs(sql, dup)).every((n) => n === 0)).toBe(true);
            expect(
                await sql`SELECT user_id::text AS user_id, rating::int AS rating FROM user_ratings
                    WHERE media_id = ${keep} ORDER BY rating`,
            ).toEqual([
                { user_id: other, rating: 3 },
                { user_id: user, rating: 5 },
            ]);
            expect(
                await sql`SELECT is_favorite FROM user_media_state WHERE media_id = ${keep}`,
            ).toEqual([{ is_favorite: true }]);
            expect(
                await sql`SELECT title FROM playlist_items WHERE playlist_id = ${playlist}`,
            ).toEqual([{ title: keep }]);
            expect(
                await sql`SELECT type, content FROM media_annotations WHERE media_id = ${keep} ORDER BY type`,
            ).toEqual([
                { type: 'chat', content: 'hello' },
                { type: 'review', content: keep },
            ]);
            expect(
                await sql`SELECT COUNT(*)::int AS n FROM user_media_events WHERE media_id = ${keep}`,
            ).toEqual([{ n: 2 }]);
            expect(
                await sql`SELECT media_type, is_primary FROM external_ids WHERE media_id = ${keep} ORDER BY media_type`,
            ).toEqual([
                { media_type: 'album', is_primary: true },
                { media_type: 'release-group', is_primary: false },
            ]);
            expect(
                await sql`SELECT decided_by, created_at FROM personal_media_dispositions WHERE media_id = ${keep}`,
            ).toEqual([
                { decided_by: 'survivor-decision', created_at: new Date('2026-09-04T12:00:00Z') },
            ]);
            expect(await passesGuard(sql, dup)).toBe(true);
        });
    });

    it('drops only true conflicts in every keyed table and moves the rest', async () => {
        await inFixture(async ({ sql, user, other, dup, keep }) => {
            const lists = [`list-${crypto.randomUUID()}`, `list-${crypto.randomUUID()}`];
            for (const list of lists)
                await sql`INSERT INTO cached_lists (list_id, name, list_path) VALUES (${list}, 'l', '/l')`;
            const sameEvent = crypto.randomUUID();
            // Survivor rows, then the duplicate's conflicting twin of each.
            for (const id of [keep, dup]) {
                const mark = id === keep ? 'keep' : 'dup';
                await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${id}, ${id === keep ? 5 : 1})`;
                await sql`INSERT INTO user_suggestions (user_id, media_id, cache_context) VALUES (${user}, ${id}, 'general')`;
                await sql`INSERT INTO user_media_state (user_id, media_id) VALUES (${user}, ${id})`;
                await sql`INSERT INTO user_rate_skips (user_id, media_id) VALUES (${user}, ${id})`;
                await sql`INSERT INTO user_taste_dampers (user_id, media_id, media_type, expires_at)
                    VALUES (${user}, ${id}, 'movie', NOW() + INTERVAL '1 day')`;
                await sql`INSERT INTO user_media_share_opt_out (user_id, media_id) VALUES (${user}, ${id})`;
                await sql`INSERT INTO watch_state_sync_log (user_id, media_id, provider, direction)
                    VALUES (${user}, ${id}, 'trakt', 'outbound')`;
                await sql`INSERT INTO library_availability (media_id, library, library_item_id)
                    VALUES (${id}, 'jellyfin', ${mark})`;
                await sql`INSERT INTO series_episode_ordering (media_id) VALUES (${id})`;
                await sql`INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
                    VALUES (${id}, 'poster', '/a')`;
                await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${lists[0]}, ${id}, 1)`;
                await sql`INSERT INTO user_music_state (user_id, track_id) VALUES (${user}, ${id})`;
                await sql`INSERT INTO music_listen_events (user_id, track_id, event_id) VALUES (${user}, ${id}, ${sameEvent})`;
                await sql`INSERT INTO watch_sync_activity (user_id, provider, direction, outcome, media_id)
                    VALUES (${user}, 'trakt', 'push', 'skipped', ${id})`;
            }
            // One non-conflicting duplicate row per table (series_episode_ordering
            // is unique on the media id alone, so it can have none).
            await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${other}, ${dup}, 3)`;
            await sql`INSERT INTO user_suggestions (user_id, media_id, cache_context) VALUES (${user}, ${dup}, 'other')`;
            await sql`INSERT INTO user_media_state (user_id, media_id) VALUES (${other}, ${dup})`;
            await sql`INSERT INTO user_rate_skips (user_id, media_id) VALUES (${other}, ${dup})`;
            await sql`INSERT INTO user_taste_dampers (user_id, media_id, media_type, expires_at)
                VALUES (${other}, ${dup}, 'movie', NOW() + INTERVAL '1 day')`;
            await sql`INSERT INTO user_media_share_opt_out (user_id, media_id) VALUES (${other}, ${dup})`;
            await sql`INSERT INTO watch_state_sync_log (user_id, media_id, provider, direction)
                VALUES (${user}, ${dup}, 'trakt', 'inbound')`;
            await sql`INSERT INTO library_availability (media_id, library, library_item_id) VALUES (${dup}, 'plex', 'dup')`;
            await sql`INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
                VALUES (${dup}, 'poster', '/b')`;
            await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${lists[1]}, ${dup}, 1)`;
            await sql`INSERT INTO user_music_state (user_id, track_id) VALUES (${other}, ${dup})`;
            await sql`INSERT INTO music_listen_events (user_id, track_id, event_id)
                VALUES (${user}, ${dup}, ${crypto.randomUUID()})`;
            await sql`INSERT INTO watch_sync_activity (user_id, provider, direction, outcome, media_id)
                VALUES (${other}, 'trakt', 'push', 'skipped', ${dup})`;

            const outcome = await moveMediaReferences(sql, dup, keep);

            expect(outcome).toEqual({ moved: 13, dropped: 14 });
            expect(Object.values(await countRefs(sql, dup)).every((n) => n === 0)).toBe(true);
            const onKeep = await countRefs(sql, keep);
            for (const table of [
                'user_ratings',
                'user_suggestions',
                'user_media_state',
                'user_rate_skips',
                'user_taste_dampers',
                'user_media_share_opt_out',
                'watch_state_sync_log',
                'library_availability',
                'media_artwork_suppressions',
                'cached_list_items',
                'user_music_state',
                'music_listen_events',
                'watch_sync_activity',
            ])
                expect([table, onKeep[table]]).toEqual([table, 2]);
            expect(onKeep.series_episode_ordering).toBe(1);
            expect(
                await sql`SELECT user_id::text AS user_id, rating::int AS rating FROM user_ratings
                    WHERE media_id = ${keep} ORDER BY rating`,
            ).toEqual([
                { user_id: other, rating: 3 },
                { user_id: user, rating: 5 },
            ]);
            expect(
                await sql`SELECT library, library_item_id FROM library_availability
                    WHERE media_id = ${keep} ORDER BY library`,
            ).toEqual([
                { library: 'jellyfin', library_item_id: 'keep' },
                { library: 'plex', library_item_id: 'dup' },
            ]);
        });
    });

    it('preserves provider tombstones after merging and deleting the source owner', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            await sql`INSERT INTO image_provider_suppressions (owner,provider,role) VALUES
                (${dup},'discogs','poster'), (${dup},'tmdb','*'), (${dup},'tvdb','*'),
                (${keep},'tmdb','*'), (${keep},'deezer','poster')`;
            // Capture during the merge must already see the transferred tombstone.
            await sql`UPDATE media_items SET custom_poster_url='https://i.discogs.com/deleted.jpg' WHERE id=${dup}`;
            await moveMediaReferences(sql, dup, keep);
            await sql`DELETE FROM media_items WHERE id=${dup}`;
            expect(
                await sql`SELECT provider,role FROM image_provider_suppressions WHERE owner=${keep} ORDER BY provider,role`,
            ).toEqual([
                { provider: 'deezer', role: 'poster' },
                { provider: 'discogs', role: 'poster' },
                { provider: 'tmdb', role: '*' },
                { provider: 'tvdb', role: '*' },
            ]);
            expect(
                await sql`SELECT 1 FROM image_provider_suppressions WHERE owner=${dup}`,
            ).toHaveLength(0);
            await sql`UPDATE media_items SET custom_poster_url='https://i.discogs.com/rediscovered.jpg' WHERE id=${keep}`;
            await sql`SELECT register_image_candidate(${keep},'logo','tmdb','/Deleted.jpg')`;
            await sql`SELECT register_image_candidate(${keep},'logo','tvdb','/Deleted.jpg')`;
            expect(
                await sql`SELECT 1 FROM image_candidates WHERE media_item_id=${keep} AND provider IN ('discogs','tmdb','tvdb')`,
            ).toHaveLength(0);
        });
    });

    it("merges per-user state into the survivor instead of dropping the duplicate's", async () => {
        await inFixture(async ({ sql, user, dup, keep }) => {
            await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite, is_watched, watch_count,
                    first_watched_at, last_watched_at, last_event_at, resume_position_ms, runtime_ms,
                    last_event_source, highest_session_elapsed_ms)
                VALUES (${user}, ${keep}, NULL, false, 1, '2020-01-01', '2021-01-01', '2021-01-01',
                    100, 1000, 'keep', 10)`;
            await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite, is_watched, watch_count,
                    first_watched_at, last_watched_at, last_event_at, resume_position_ms, runtime_ms,
                    last_event_source, highest_session_elapsed_ms)
                VALUES (${user}, ${dup}, true, true, 3, '2019-01-01', '2022-01-01', '2022-01-01',
                    500, 9000, 'dup', 50)`;
            await sql`INSERT INTO user_music_state (user_id, track_id, play_count, skip_count, complete_count,
                    total_listen_ms, first_played_at, last_played_at)
                VALUES (${user}, ${keep}, 2, 1, 1, 1000, '2020-01-01', '2020-06-01'),
                       (${user}, ${dup}, 3, 0, 2, 5000, '2019-01-01', '2021-01-01')`;

            await moveMediaReferences(sql, dup, keep);

            expect(
                await sql`SELECT is_favorite, is_watched, watch_count,
                        first_watched_at::date::text AS first_watched, last_watched_at::date::text AS last_watched,
                        last_event_at::date::text AS last_event, resume_position_ms::int AS resume,
                        runtime_ms::int AS runtime, last_event_source, highest_session_elapsed_ms
                    FROM user_media_state WHERE user_id = ${user}`,
            ).toEqual([
                {
                    is_favorite: true,
                    is_watched: true,
                    watch_count: 3,
                    first_watched: '2019-01-01',
                    last_watched: '2022-01-01',
                    last_event: '2022-01-01',
                    resume: 500,
                    runtime: 9000,
                    last_event_source: 'dup',
                    highest_session_elapsed_ms: 50,
                },
            ]);
            expect(
                await sql`SELECT track_id::text AS track_id, play_count, skip_count, complete_count,
                        total_listen_ms::int AS total, first_played_at::date::text AS first_played,
                        last_played_at::date::text AS last_played
                    FROM user_music_state WHERE user_id = ${user}`,
            ).toEqual([
                {
                    track_id: keep,
                    play_count: 5,
                    skip_count: 1,
                    complete_count: 3,
                    total: 6000,
                    first_played: '2019-01-01',
                    last_played: '2021-01-01',
                },
            ]);
        });
    });

    it('re-points inbound aliases and never makes the survivor alias itself', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            const alias = await mediaRow(sql, 'album', null);
            await sql`UPDATE media_items SET canonical_id = ${dup} WHERE id IN (${alias}, ${keep})`;

            await moveMediaReferences(sql, dup, keep);

            expect(
                await sql`SELECT id::text AS id, canonical_id::text AS canonical_id FROM media_items
                    WHERE id IN (${alias}, ${keep}) ORDER BY id = ${keep}`,
            ).toEqual([
                { id: alias, canonical_id: keep },
                { id: keep, canonical_id: null },
            ]);
        });
    });

    it('normalizes legacy spellings and keeps one row per key among them', async () => {
        await inFixture(async ({ sql, user, dup, keep }) => {
            const spellings = [dup.toUpperCase(), dup.replace(/-/g, '')];
            for (const spelling of spellings) {
                await sql`INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                    VALUES (${user}, ${spelling}, 'album', 'dismissed_cw')`;
                await sql`INSERT INTO interaction_reactions (target_type, target_id, user_id, emoji)
                    VALUES ('media', ${spelling}, ${user}, '+1')`;
                await sql`INSERT INTO interactions (target_type, target_id, user_id, body)
                    VALUES ('media', ${spelling}, ${user}, ${spelling})`;
            }
            // Not a media reference: a non-media flag type and a playlist comment.
            await sql`INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type)
                VALUES (${user}, ${dup}, 'request', 'request_dismissed')`;
            await sql`INSERT INTO interactions (target_type, target_id, user_id, body)
                VALUES ('playlist', ${dup}, ${user}, 'playlist note')`;

            await moveMediaReferences(sql, dup, keep);

            expect(
                await sql`SELECT target_id FROM user_media_flags WHERE user_id = ${user} AND target_type = 'album'`,
            ).toEqual([{ target_id: keep }]);
            expect(
                await sql`SELECT target_id FROM interaction_reactions WHERE user_id = ${user}`,
            ).toEqual([{ target_id: keep }]);
            expect(
                await sql`SELECT target_id FROM interactions WHERE target_type = 'media' AND user_id = ${user}`,
            ).toEqual([{ target_id: keep }, { target_id: keep }]);
            expect(
                await sql`SELECT target_id FROM user_media_flags WHERE target_type = 'request' AND user_id = ${user}`,
            ).toEqual([{ target_id: dup }]);
            expect(
                await sql`SELECT target_id FROM interactions WHERE target_type = 'playlist' AND user_id = ${user}`,
            ).toEqual([{ target_id: dup }]);
        });
    });

    it('refuses self-merges, missing survivors, different types and non-albums', async () => {
        await inFixture(async ({ sql, user, dup, keep }) => {
            await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${dup}, 4)`;
            const movie = await mediaRow(sql, 'movie', null);
            const otherMovie = await mediaRow(sql, 'movie', null);
            for (const [from, target, error] of [
                [dup, dup.toUpperCase(), /into itself/],
                [dup, crypto.randomUUID(), /does not exist/],
                [dup, movie, /only albums are merged/],
                [movie, keep, /is a movie/],
                [otherMovie, movie, /only albums are merged/],
            ] as const) {
                await expect(
                    withTx(sql, (tx) => moveMediaReferences(tx, from, target)),
                ).rejects.toThrow(error);
            }
            expect(
                await sql`SELECT media_id::text AS media_id FROM user_ratings WHERE user_id = ${user}`,
            ).toEqual([{ media_id: dup }]);
            expect(await moveMediaReferences(sql, crypto.randomUUID(), keep)).toEqual({
                moved: 0,
                dropped: 0,
            });
        });
    });

    /**
     * Foreign keys to media_items(id) that may cascade or null on delete:
     * catalog structure and data derived from the row or its files, which the
     * pipeline rebuilds for the survivor. Everything else must be moved.
     */
    const EXEMPT_FK_COLUMNS: ReadonlyArray<string> = [
        // A music edit restores exact original identities. Explicit removal expires it; never remap recovery authority.
        'music_edit_receipts.target_id',
        // Hierarchy: the caller moves or refuses children before a merge.
        'media_items.parent_id',
        // File links and file-derived data.
        'media_file_items.media_item_id',
        'download_renditions.media_item_id',
        'trickplay_params.media_item_id',
        'media_segments.media_id',
        'media_segment_candidates.media_id',
        'media_segment_fingerprints.media_id',
        // Proof binds the old owner/file/input; moving it could certify the
        // survivor's different input. Its FK cascades with the merged-away row.
        'media_segment_analysis_passes.media_id',
        'media_item_quality.media_item_id',
        'media_item_languages.media_item_id',
        // Embeddings, audio analysis and ranking.
        'media_embeddings.media_id',
        'media_lyrics_embeddings.media_id',
        'media_lyrics_embedding_state.media_id',
        'media_audio_embeddings.media_id',
        'media_audio_embedding_state.media_id',
        'media_audio_clusters.media_id',
        'media_audio_map_coords.media_id',
        'media_popularity.media_id',
        'music_popularity_rank.media_id',
        'media_scalars.media_id',
        // Provider metadata and its projections.
        'provider_metadata.media_id',
        'media_titles.media_id',
        'media_item_translations.media_id',
        'media_genres.media_id',
        'media_keywords.media_id',
        'media_people.media_id',
        'media_credits.media_id',
        'media_external_groupings.media_id',
        // Derived split-album findings describe a pair that no longer exists after a merge.
        'album_split_health_pairs.album_a',
        'album_split_health_pairs.album_b',
        // Pipeline and series bookkeeping.
        'media_item_stage_state.media_item_id',
        'media_added_pending.media_item_id',
        'episode_orderings.series_media_id',
        'episode_orderings.episode_media_id',
        'series_grouping_state.series_id',
        'series_health_reports.series_media_id',
        'sync_quarantine.expected_series_id',
        // Undo record of a reconciliation move (16.298.0). It describes where
        // THAT episode row sat; on the survivor an undo would move the wrong
        // row, so it goes with the merged-away episode (ON DELETE CASCADE).
        'episode_reconciliation_moves.episode_id',
        // A live TV channel row shares its media_items id; never an album.
        'livetv_channels.id',
        // STORED generated column derived from hls_playback_tokens.media_item_id
        // (16.396.0), which IS moved; the column follows that update by itself.
        'hls_playback_tokens.catalog_media_item_id',
        // Audiobook catalog links (16.400.0): audiobooks are never merged into
        // one another; the link rows follow the book (ON DELETE CASCADE).
        'audiobook_book_contributors.media_id',
        'audiobook_book_series.media_id',
    ];

    it('never reattributes input-bound analyzer proof to a merge survivor', async () => {
        await inFixture(async ({ sql, dup, keep }) => {
            await sql`INSERT INTO media_segment_analysis_passes
                (media_id, file_id, input_identity, stage_id, segment_types, segments_count, processing_version, coverage_complete)
                VALUES (${dup}, ${crypto.randomUUID()}, 'duplicate-owner-input', 'intro', ARRAY['intro'], 0, 1, true)`;
            await moveMediaReferences(sql, dup, keep);
            expect(
                await sql`SELECT media_id, input_identity FROM media_segment_analysis_passes WHERE media_id=${dup}`,
            ).toEqual([{ media_id: dup, input_identity: 'duplicate-owner-input' }]);
            expect(
                await sql`SELECT 1 FROM media_segment_analysis_passes WHERE media_id=${keep}`,
            ).toHaveLength(0);
            await sql`DELETE FROM media_items WHERE id=${dup}`;
            expect(
                await sql`SELECT 1 FROM media_segment_analysis_passes WHERE media_id=${dup}`,
            ).toHaveLength(0);
        });
    });

    it('moves every foreign-key reference except the documented structural ones', async () => {
        const fks = await db<{ ref: string }[]>`
            SELECT c.conrelid::regclass::text || '.' || a.attname AS ref
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.contype = 'f' AND c.confrelid = 'media_items'::regclass
            ORDER BY 1
        `;
        const moved = new Set(MOVED_MEDIA_REFERENCE_COLUMNS.map((r) => `${r.table}.${r.column}`));
        const exempt = new Set(EXEMPT_FK_COLUMNS);
        const unaccounted = fks
            .map((r) => r.ref)
            .filter((ref) => !moved.has(ref) && !exempt.has(ref));
        expect(unaccounted).toEqual([]);
        // An exemption for a column that no longer exists is stale.
        const fkSet = new Set(fks.map((r) => r.ref));
        expect(EXEMPT_FK_COLUMNS.filter((ref) => !fkSet.has(ref))).toEqual([]);
    });

    it('moves every table the reference guard checks', () => {
        const guard = mediaReferenceGuard(db, 'm') as unknown as { strings: readonly string[] };
        const checked = [
            ...guard.strings.join('').matchAll(/FROM (\w+) r WHERE (?:lower\(replace\()?r\.(\w+)/g),
        ].map(([, table, column]) => ({ table, column }));
        expect(checked.length).toBeGreaterThan(25);
        const moved = new Set(MOVED_MEDIA_REFERENCE_COLUMNS.map((r) => `${r.table}.${r.column}`));
        const polymorphic = new Set<string>(MOVED_POLYMORPHIC_REFERENCE_TABLES);
        const missing = checked.filter(
            ({ table, column }) =>
                // Receipts preserve original IDs; a merge must never reattribute recovery authority.
                table !== 'music_edit_receipts' &&
                !moved.has(`${table}.${column}`) &&
                !(polymorphic.has(table) && (column === 'target_type' || column === 'target_id')),
        );
        expect(missing).toEqual([]);
    });

    it('relies on the real unique key of series_episode_ordering', async () => {
        const rows = await db`
            SELECT 1 FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = 'series_episode_ordering'::regclass AND i.indisunique
              AND i.indnatts = 1 AND a.attname = 'media_id'
        `;
        expect(rows.length).toBeGreaterThan(0);
    });
});
