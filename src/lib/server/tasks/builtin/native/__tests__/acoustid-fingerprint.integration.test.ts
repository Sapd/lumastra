// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * acoustid-fingerprint stage bookkeeping against a real database.
 *
 * Every predicate here lives in SQL, so it is exercised with real rows in each
 * real state — a mocked `sql` could not tell a wrong predicate from a right one.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
} from '../../../../../../../tests/integration/fixtures/index.js';

const fpcalc = vi.hoisted(() => ({ available: true }));
vi.mock('$lib/server/providers/implementations/musicbrainz/acoustid.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/providers/implementations/musicbrainz/acoustid.js')
        >();
    return { ...actual, isFpcalcAvailable: () => fpcalc.available };
});

import {
    ACOUSTID_STAGE_ID,
    applyAcoustIdMatch,
    clearOwnAcoustIdMatch,
    findAcoustIdBacklog,
    getStoredAlbumMbids,
    insertExternalIdIfAbsent,
    loadAlbumMatchEvidence,
    markAcoustIdMatched,
    markAcoustIdSkipped,
    markAcoustIdTransientFailure,
    reopenAlbumEnrichmentForPoster,
    type StoredAcoustIdMatch,
} from '../../../../database/queries/acoustid-fingerprint.queries.js';
import { runStageDisposition } from '../../../stage-disposition-runner.js';
import { acoustIdFingerprintTask, decideAlbumArtistMbids } from '../acoustid-fingerprint.js';

const TEST_TABLES = [
    'media_item_stage_state',
    'media_streams',
    'media_file_items',
    'media_files',
    'media_artwork',
    'external_ids',
    'plugin_secrets',
    'media_items',
] as const;

const REC_A = '11111111-1111-4111-8111-111111111111';
const REC_TAG = '22222222-2222-4222-8222-222222222222';
const RG = '33333333-3333-4333-8333-333333333333';
const ARTIST_MBID = '44444444-4444-4444-8444-444444444444';

function stubLogger() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function match(over: Partial<StoredAcoustIdMatch> = {}): StoredAcoustIdMatch {
    return {
        recording_mbid: REC_A,
        acoustid_id: 'aaaa',
        score: 0.97,
        recording_title: 'Song',
        artist_mbids: [ARTIST_MBID],
        artist_names: ['The Band'],
        release_groups: [{ id: RG, title: 'The Album' }],
        matched_at: new Date().toISOString(),
        ...over,
    };
}

describe('acoustid-fingerprint stage (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        fpcalc.available = true;
        delete process.env.ACOUSTID_API_KEY;
        await truncateTables(sql, TEST_TABLES);
    });

    async function seedAlbum(title = 'The Album', artistTitle = 'The Band') {
        const artist = createTestArtist({ title: artistTitle });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title });
        await insertTestAlbum(sql, album);
        return { artist, album };
    }

    async function seedTrack(
        albumId: string,
        n: number,
        opts: { meta?: Record<string, unknown>; file?: boolean; missing?: boolean } = {},
    ) {
        const track = createTestTrack(albumId, n, {
            title: `Track ${n}`,
            custom_metadata: opts.meta ?? {},
        });
        // insertTestTrack links one default file; shape it for the case at hand.
        await insertTestTrack(sql, track);
        const [f] = await sql<{ id: string }[]>`
            SELECT file_id AS id FROM media_file_items WHERE media_item_id = ${track.id}::uuid`;
        if (opts.file === false) {
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${track.id}::uuid`;
            await sql`DELETE FROM media_files WHERE id = ${f.id}::uuid`;
        } else {
            if (opts.missing)
                await sql`UPDATE media_files SET is_missing = true WHERE id = ${f.id}::uuid`;
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${f.id}, 'audio', 0, 'mp3')`;
        }
        return track;
    }

    async function setRow(id: string, status: string, extra: { attempt?: number } = {}) {
        await sql`
            INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, attempt)
            VALUES (${id}::uuid, ${ACOUSTID_STAGE_ID}, 1, ${status}, ${extra.attempt ?? 0})
            ON CONFLICT (media_item_id, stage_id) DO UPDATE
               SET status = EXCLUDED.status, attempt = EXCLUDED.attempt
        `;
    }

    async function row(id: string) {
        const [r] = await sql<
            {
                status: string;
                skipped_reason: string | null;
                attempt: number;
                next_eligible_at: Date | null;
            }[]
        >`
            SELECT status, skipped_reason, attempt, next_eligible_at
              FROM media_item_stage_state
             WHERE media_item_id = ${id}::uuid AND stage_id = ${ACOUSTID_STAGE_ID}
        `;
        return r;
    }

    async function meta(id: string): Promise<Record<string, unknown>> {
        const [r] = await sql<{ m: Record<string, unknown> }[]>`
            SELECT custom_metadata AS m FROM media_items WHERE id = ${id}::uuid`;
        return r.m;
    }

    async function addKeySecret() {
        await sql`
            INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
            VALUES ('musicbrainz-metadata-provider', 'ACOUSTID_API_KEY', ${Buffer.from('x')}, 1)
        `;
    }

    async function dispose() {
        await runStageDisposition(sql, acoustIdFingerprintTask.coversStages![0], {
            sql,
            logger: stubLogger() as never,
        });
    }

    // ── Selection ────────────────────────────────────────────────────────────

    describe('backlog selection', () => {
        it('returns due pending / failed_transient / obsolete rows with a present file only', async () => {
            const { album } = await seedAlbum();
            const pending = await seedTrack(album.id, 1);
            const transientDue = await seedTrack(album.id, 2);
            const obsolete = await seedTrack(album.id, 3);
            const done = await seedTrack(album.id, 4);
            const skipped = await seedTrack(album.id, 5);
            const missingFile = await seedTrack(album.id, 6, { missing: true });
            const noFile = await seedTrack(album.id, 7, { file: false });
            const notDue = await seedTrack(album.id, 8);
            await setRow(pending.id, 'pending');
            await setRow(transientDue.id, 'failed_transient');
            await setRow(obsolete.id, 'obsolete');
            await setRow(done.id, 'completed');
            await setRow(skipped.id, 'skipped_permanent');
            await setRow(missingFile.id, 'pending');
            await setRow(noFile.id, 'pending');
            await setRow(notDue.id, 'failed_transient');
            await sql`UPDATE media_item_stage_state SET next_eligible_at = now() + interval '1 hour'
                       WHERE media_item_id = ${notDue.id}::uuid`;

            const rows = await findAcoustIdBacklog(sql, 50);
            expect(rows.map((r) => r.id).sort()).toEqual(
                [pending.id, transientDue.id, obsolete.id].sort(),
            );
            const first = rows.find((r) => r.id === pending.id)!;
            expect(first.album_title).toBe('The Album');
            expect(first.file_path).toBe(`/test/music/${pending.id}.mp3`);
            expect(first.has_tag_mbid).toBe(false);
        });

        it('flags a tag-supplied MBID but not one written by an earlier match', async () => {
            const { album } = await seedAlbum();
            const tagged = await seedTrack(album.id, 1, { meta: { recording_mbid: REC_TAG } });
            const ours = await seedTrack(album.id, 2, {
                meta: { recording_mbid: REC_A, acoustid: { recording_mbid: REC_A } },
            });
            await setRow(tagged.id, 'pending');
            await setRow(ours.id, 'pending');
            const rows = await findAcoustIdBacklog(sql, 50);
            expect(rows.find((r) => r.id === tagged.id)!.has_tag_mbid).toBe(true);
            expect(rows.find((r) => r.id === ours.id)!.has_tag_mbid).toBe(false);
        });
    });

    // ── Stage disposition (the declared SQL, run for real) ───────────────────

    describe('stage disposition', () => {
        it('tombstones every row with no-acoustid-key when no key is configured', async () => {
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1);
            await setRow(t.id, 'pending');
            await dispose();
            expect(await row(t.id)).toMatchObject({
                status: 'skipped_permanent',
                skipped_reason: 'no-acoustid-key',
            });
        });

        it('treats the env var as a configured key', async () => {
            process.env.ACOUSTID_API_KEY = 'env-key';
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1);
            await setRow(t.id, 'pending');
            await dispose();
            expect((await row(t.id)).status).toBe('pending');
        });

        it('tombstones with fpcalc-unavailable when the binary is missing', async () => {
            await addKeySecret();
            fpcalc.available = false;
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1);
            await setRow(t.id, 'pending');
            await dispose();
            expect(await row(t.id)).toMatchObject({
                status: 'skipped_permanent',
                skipped_reason: 'fpcalc-unavailable',
            });
        });

        it('skips tracks whose tags carry a recording MBID, keeps the rest pending', async () => {
            await addKeySecret();
            const { album } = await seedAlbum();
            const tagged = await seedTrack(album.id, 1, { meta: { recording_mbid: REC_TAG } });
            const plain = await seedTrack(album.id, 2);
            await setRow(tagged.id, 'pending');
            await setRow(plain.id, 'pending');
            await dispose();
            expect(await row(tagged.id)).toMatchObject({
                status: 'skipped_permanent',
                skipped_reason: 'recording-mbid-from-tags',
            });
            expect((await row(plain.id)).status).toBe('pending');
        });

        it('never demotes a completed (matched) row', async () => {
            await addKeySecret();
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1, {
                meta: { recording_mbid: REC_A, acoustid: { recording_mbid: REC_A } },
            });
            await setRow(t.id, 'completed');
            await dispose();
            expect((await row(t.id)).status).toBe('completed');
        });
    });

    // ── Storing a match ──────────────────────────────────────────────────────

    describe('applyAcoustIdMatch', () => {
        it('fills an empty recording_mbid and keeps other metadata', async () => {
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1, { meta: { genre: ['Rock'] } });
            const r = await applyAcoustIdMatch(sql, t.id, match());
            expect(r.recordingMbidSet).toBe(true);
            const m = await meta(t.id);
            expect(m.recording_mbid).toBe(REC_A);
            expect(m.genre).toEqual(['Rock']);
            expect((m.acoustid as { score: number }).score).toBe(0.97);
        });

        it('never overwrites a tag-supplied recording_mbid', async () => {
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1, { meta: { recording_mbid: REC_TAG } });
            const r = await applyAcoustIdMatch(sql, t.id, match());
            expect(r.recordingMbidSet).toBe(false);
            const m = await meta(t.id);
            expect(m.recording_mbid).toBe(REC_TAG);
            expect((m.acoustid as { recording_mbid: string }).recording_mbid).toBe(REC_A);
        });

        it('replaces its own earlier answer', async () => {
            const { album } = await seedAlbum();
            const t = await seedTrack(album.id, 1);
            await applyAcoustIdMatch(sql, t.id, match());
            const NEW = '55555555-5555-4555-8555-555555555555';
            const r = await applyAcoustIdMatch(sql, t.id, match({ recording_mbid: NEW }));
            expect(r.recordingMbidSet).toBe(true);
            expect((await meta(t.id)).recording_mbid).toBe(NEW);
        });
    });

    // ── Terminal outcomes ────────────────────────────────────────────────────

    describe('per-item outcomes', () => {
        it('matched → completed; no-match → skipped_permanent; both leave the backlog', async () => {
            const { album } = await seedAlbum();
            const a = await seedTrack(album.id, 1);
            const b = await seedTrack(album.id, 2);
            await setRow(a.id, 'pending');
            await setRow(b.id, 'obsolete');
            await markAcoustIdMatched(sql, a.id, 1);
            await markAcoustIdSkipped(sql, [b.id], 'acoustid-no-match', 1);
            expect((await row(a.id)).status).toBe('completed');
            expect(await row(b.id)).toMatchObject({
                status: 'skipped_permanent',
                skipped_reason: 'acoustid-no-match',
            });
            expect(await findAcoustIdBacklog(sql, 50)).toEqual([]);
        });

        it('a skip never downgrades a completed row', async () => {
            const { album } = await seedAlbum();
            const a = await seedTrack(album.id, 1);
            await setRow(a.id, 'completed');
            await markAcoustIdSkipped(sql, [a.id], 'acoustid-no-match', 1);
            expect((await row(a.id)).status).toBe('completed');
        });

        it('transient failure backs off, then becomes failed_permanent at the attempt cap', async () => {
            const { album } = await seedAlbum();
            const a = await seedTrack(album.id, 1);
            const b = await seedTrack(album.id, 2);
            await setRow(a.id, 'obsolete');
            await setRow(b.id, 'failed_transient', { attempt: 4 });
            await markAcoustIdTransientFailure(
                sql,
                [a.id, b.id],
                { message: 'down', code: 'acoustid_unavailable' },
                3_600_000,
                5,
            );
            const ra = await row(a.id);
            expect(ra.status).toBe('failed_transient');
            expect(ra.attempt).toBe(1);
            expect(ra.next_eligible_at!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
            expect(await row(b.id)).toMatchObject({ status: 'failed_permanent', attempt: 5 });
            // Neither is due, so a drain loop cannot spin on them.
            expect(await findAcoustIdBacklog(sql, 50)).toEqual([]);
        });
    });

    describe('review follow-ups', () => {
        it('an outage backs off without spending attempts', async () => {
            const { album } = await seedAlbum();
            const a = await seedTrack(album.id, 1);
            await setRow(a.id, 'failed_transient', { attempt: 4 });
            await markAcoustIdTransientFailure(
                sql,
                [a.id],
                { message: '503', code: 'acoustid_unavailable' },
                3_600_000,
                5,
                { countAttempt: false },
            );
            const r = await row(a.id);
            expect(r).toMatchObject({ status: 'failed_transient', attempt: 4 });
            expect(r.next_eligible_at!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
        });

        it('clearing a stale match drops our MBID but keeps a tag MBID', async () => {
            const { album } = await seedAlbum();
            const ours = await seedTrack(album.id, 1, { meta: { genre: ['Jazz'] } });
            const tagged = await seedTrack(album.id, 2, { meta: { recording_mbid: REC_TAG } });
            await applyAcoustIdMatch(sql, ours.id, match());
            await applyAcoustIdMatch(sql, tagged.id, match());
            await clearOwnAcoustIdMatch(sql, [ours.id, tagged.id]);
            expect(await meta(ours.id)).toEqual({ genre: ['Jazz'] });
            expect(await meta(tagged.id)).toEqual({ recording_mbid: REC_TAG });
        });
    });

    // ── Album / artist propagation ───────────────────────────────────────────

    describe('album and artist ids', () => {
        it('derives release group + artist from agreeing tracks and only fills gaps', async () => {
            const { artist, album } = await seedAlbum();
            const t1 = await seedTrack(album.id, 1);
            const t2 = await seedTrack(album.id, 2);
            await seedTrack(album.id, 3);
            await applyAcoustIdMatch(sql, t1.id, match());
            await applyAcoustIdMatch(
                sql,
                t2.id,
                match({ recording_mbid: '66666666-6666-4666-8666-666666666666' }),
            );

            const [ev] = await loadAlbumMatchEvidence(sql, [album.id]);
            expect(ev.track_count).toBe(3);
            expect(ev.matches).toHaveLength(2);
            const d = decideAlbumArtistMbids(ev);
            expect(d.releaseGroupMbid).toBe(RG);
            expect(d.artistMbid).toBe(ARTIST_MBID);

            expect(
                await insertExternalIdIfAbsent(sql, {
                    mediaId: album.id,
                    provider: 'musicbrainz_releasegroup',
                    externalId: RG,
                    mediaType: 'album',
                    confidence: d.confidence,
                }),
            ).toBe(true);
            expect(await getStoredAlbumMbids(sql, album.id)).toEqual({
                releaseMbid: null,
                releaseGroupMbid: RG,
            });

            // An existing artist id is never replaced.
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, source)
                VALUES (${artist.id}, 'musicbrainz', '77777777-7777-4777-8777-777777777777', 'artist', 'artist-enrichment')
            `;
            expect(
                await insertExternalIdIfAbsent(sql, {
                    mediaId: artist.id,
                    provider: 'musicbrainz',
                    externalId: ARTIST_MBID,
                    mediaType: 'artist',
                    confidence: 1,
                }),
            ).toBe(false);
            const [a] = await sql<{ external_id: string }[]>`
                SELECT external_id FROM external_ids WHERE media_id = ${artist.id} AND provider = 'musicbrainz'`;
            expect(a.external_id).toBe('77777777-7777-4777-8777-777777777777');
        });

        it('an MBID already owned by another album is a silent no-op', async () => {
            const { album: a1 } = await seedAlbum('The Album', 'The Band');
            const { album: a2 } = await seedAlbum('The Album', 'The Band Copy');
            const write = (id: string) =>
                insertExternalIdIfAbsent(sql, {
                    mediaId: id,
                    provider: 'musicbrainz_releasegroup',
                    externalId: RG,
                    mediaType: 'album',
                    confidence: 1,
                });
            expect(await write(a1.id)).toBe(true);
            expect(await write(a2.id)).toBe(false);
        });

        it('re-opens album-enrichment for an album without a poster, not one with', async () => {
            const { album: bare } = await seedAlbum('Bare');
            const { album: covered } = await seedAlbum('Covered', 'Other');
            for (const id of [bare.id, covered.id]) {
                await sql`
                    INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, skipped_reason)
                    VALUES (${id}::uuid, 'album-enrichment', 1, 'skipped_permanent', 'no-match-upstream')`;
                await sql`UPDATE media_items SET processing_state = '{"album-enrichment": {"v": 1}}'::jsonb WHERE id = ${id}::uuid`;
            }
            await sql`INSERT INTO media_artwork (media_item_id, artwork_type, file_path) VALUES (${covered.id}, 'poster', '/x.jpg')`;

            await reopenAlbumEnrichmentForPoster(sql, bare.id);
            await reopenAlbumEnrichmentForPoster(sql, covered.id);

            const rows = await sql<{ media_item_id: string; status: string }[]>`
                SELECT media_item_id, status FROM media_item_stage_state WHERE stage_id = 'album-enrichment'`;
            const byId = Object.fromEntries(rows.map((r) => [r.media_item_id, r.status]));
            expect(byId[bare.id]).toBe('pending');
            expect(byId[covered.id]).toBe('skipped_permanent');
            const [m] = await sql<{ has: boolean }[]>`
                SELECT processing_state ? 'album-enrichment' AS has FROM media_items WHERE id = ${bare.id}::uuid`;
            expect(m.has).toBe(false);
        });
    });
});
