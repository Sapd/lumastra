// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    createTestWatchStateEntry,
    insertTestWatchStateEntry,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    setManualFileEpisodes,
    revalidateManualLinksAfterContentChange,
    clearManualFileEpisodes,
    clearReviewedManualFileEpisodes,
} from '$lib/server/services/manual-file-links.service.js';
import { deleteStaleMediaFile } from './media-files.queries.js';
import { getFileEpisodeEditorData } from './manual-file-links.queries.js';
let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});
afterAll(async () => {
    await closeTestDb();
});
it('names the target series and preserves reversed cross-season playback order', async () => {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 2,
        episodesPerSeason: 2,
    });
    await sql`UPDATE media_items SET title='Lantern Shore' WHERE id=${seriesId}`;
    const episodes = await sql<{ id: string }[]>`
        SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id
        WHERE season.parent_id=${seriesId} AND ep.media_type='episode'
        ORDER BY season.season_number,ep.episode_number
    `;
    const episodeIds = episodes.map((episode) => episode.id);
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files (id,file_path,duration_seconds) VALUES (${fileId},'/fictional/shared.mkv',60)`;
    await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default,start_offset_ms,end_offset_ms,offset_source)
        VALUES (${fileId},${episodeIds[3]},true,0,24000,'manual'), (${fileId},${episodeIds[0]},true,24000,60000,'manual')`;
    const result = await getFileEpisodeEditorData(sql, fileId, seriesId);
    expect(result?.series).toEqual({ id: seriesId, title: 'Lantern Shore' });
    expect(result?.links.map((link) => link.mediaItemId)).toEqual([episodeIds[3], episodeIds[0]]);
    expect(result?.links.map((link) => link.startMs)).toEqual([0, 24000]);
    expect(result?.episodes).toHaveLength(4);
});

it('retains estimate evidence after save, read and content revalidation, separately from manual protection', async () => {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 2,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT e.id FROM media_items e JOIN media_items s ON s.id=e.parent_id WHERE s.parent_id=${seriesId} AND e.media_type='episode' ORDER BY e.episode_number`;
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_hash_head,file_size_bytes) VALUES (${fileId},'/fictional/provenance.mp4',60,'hash-origin',123)`;
    const applied = await setManualFileEpisodes(
        sql,
        fileId,
        episodes.map((e) => e.id),
        [
            { startMs: 0, endMs: 30000, boundaryOrigin: 'unknown' },
            { startMs: 30000, endMs: 60000, boundaryOrigin: 'even-split' },
        ],
        { seriesId },
    );
    expect(applied.ok).toBe(true);
    let data = await getFileEpisodeEditorData(sql, fileId, seriesId);
    expect(data?.links.map((l) => l.offsetSource)).toEqual(['manual', 'manual']);
    expect(data?.links[1].boundaryOrigin).toBe('even-split');
    await revalidateManualLinksAfterContentChange(sql, fileId, 60000);
    const [remembered] =
        await sql`SELECT entries FROM manual_file_link_sets WHERE file_id=${fileId}`;
    expect(remembered.entries[1].boundaryOrigin).toBe('even-split');
    data = await getFileEpisodeEditorData(sql, fileId, seriesId);
    expect(data?.links[1].boundaryOrigin).toBe('even-split');
    await clearManualFileEpisodes(sql, fileId);
    expect(
        (await sql`SELECT boundary_origin FROM media_file_items WHERE file_id=${fileId}`).every(
            (r) => r.boundary_origin === null,
        ),
    ).toBe(true);
});

async function reviewedFixture(): Promise<{
    fileId: string;
    seriesId: string;
    episodeIds: string[];
}> {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 2,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id
        WHERE season.parent_id=${seriesId} AND ep.media_type='episode' ORDER BY ep.episode_number`;
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_hash_head,file_size_bytes)
        VALUES(${fileId},${`/fictional/${fileId}.mkv`},60,'review-head',100)`;
    await setManualFileEpisodes(sql, fileId, [episodes[0].id], null, { seriesId });
    return { fileId, seriesId, episodeIds: episodes.map((ep) => ep.id) };
}

it.each(['duration', 'link', 'target-status', 'target-parent', 'file-path'])(
    'rejects stale Save and reset without mutation or audit after %s changes',
    async (change) => {
        const { fileId, seriesId, episodeIds } = await reviewedFixture();
        const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
        if (change === 'duration')
            await sql`UPDATE media_files SET duration_seconds=70 WHERE id=${fileId}`;
        if (change === 'file-path')
            await sql`UPDATE media_files SET file_path='/fictional/moved.mkv' WHERE id=${fileId}`;
        if (change === 'link')
            await sql`UPDATE media_file_items SET sort_order=7 WHERE file_id=${fileId}`;
        if (change === 'target-status')
            await sql`UPDATE media_items SET status='deleted' WHERE id=${episodeIds[1]}`;
        if (change === 'target-parent')
            await sql`UPDATE media_items SET parent_id=NULL WHERE id=${episodeIds[1]}`;
        const before =
            await sql`SELECT * FROM media_file_items WHERE file_id=${fileId} ORDER BY media_item_id`;
        const auditBefore = await sql`SELECT id FROM audit_log WHERE target=${fileId}`;
        const options = {
            seriesId,
            revision: reviewed.revision,
            actor: { username: 'review-test' },
        };
        expect(await setManualFileEpisodes(sql, fileId, [episodeIds[0]], null, options)).toEqual({
            ok: false,
            reason: 'conflict',
        });
        expect(await clearReviewedManualFileEpisodes(sql, fileId, options)).toEqual({
            ok: false,
            reason: 'conflict',
        });
        expect(
            await sql`SELECT * FROM media_file_items WHERE file_id=${fileId} ORDER BY media_item_id`,
        ).toEqual(before);
        expect(await sql`SELECT id FROM audit_log WHERE target=${fileId}`).toEqual(auditBefore);
    },
);

it('uses fresh review to preserve reversed windows, versions and provenance, clear only mapping warnings and audit the actor', async () => {
    const { fileId, seriesId, episodeIds } = await reviewedFixture();
    const versionId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path) VALUES(${versionId},'/fictional/alternate.mkv')`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES(${versionId},${episodeIds[1]},true)`;
    await sql`UPDATE media_files SET health_issues=${sql.json([
        { type: 'episode_number_unparsed', detected_at: '2026-10-20', detail: 'descending range' },
        { type: 'range_superseded', detected_at: '2026-10-20', superseded_by: [] },
        { type: 'video_decode_gaps', detected_at: '2026-10-20', detail: 'retain decoder evidence' },
    ])} WHERE id=${fileId}`;
    const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
    // Routine non-mapping timestamps are deliberately outside the review token.
    const userId = crypto.randomUUID();
    await insertTestWatchStateEntry(sql, createTestWatchStateEntry(userId, episodeIds[0]));
    const watchBefore =
        await sql`SELECT * FROM user_media_state WHERE user_id=${userId} AND media_id=${episodeIds[0]}`;
    await sql`UPDATE media_items SET updated_at=now() WHERE id=ANY(${episodeIds}::uuid[])`;
    await sql`UPDATE media_files SET updated_at=now() WHERE id=${fileId}`;
    const result = await setManualFileEpisodes(
        sql,
        fileId,
        [...episodeIds].reverse(),
        [
            { startMs: 0, endMs: 25000, boundaryOrigin: 'unknown' },
            { startMs: 25000, endMs: 60000, boundaryOrigin: 'chapter' },
        ],
        {
            seriesId,
            revision: reviewed.revision,
            actor: { username: 'review-test', kind: 'session' },
        },
    );
    expect(result.ok).toBe(true);
    const saved = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
    expect(saved.links.map((l) => l.mediaItemId)).toEqual([...episodeIds].reverse());
    expect(saved.links.map((l) => l.startMs)).toEqual([0, 25000]);
    expect(saved.links[1].boundaryOrigin).toBe('chapter');
    expect(
        await sql`SELECT * FROM user_media_state WHERE user_id=${userId} AND media_id=${episodeIds[0]}`,
    ).toEqual(watchBefore);
    expect(await sql`SELECT file_id FROM media_file_items WHERE file_id=${versionId}`).toHaveLength(
        1,
    );
    const [file] = await sql`SELECT health_issues FROM media_files WHERE id=${fileId}`;
    expect(file.health_issues.map((i: { type: string }) => i.type)).toEqual(['video_decode_gaps']);
    const [audit] = await sql`SELECT actor,action,detail FROM audit_log WHERE target=${fileId}`;
    expect(audit.actor).toBe('review-test');
    expect(audit.action).toBe('media.file-episodes.set');
    expect(audit.detail.clearedIssues).toHaveLength(2);
    expect(
        await clearReviewedManualFileEpisodes(sql, fileId, {
            seriesId,
            revision: saved.revision,
            actor: { username: 'review-test' },
        }),
    ).toMatchObject({ ok: true });
    expect(await sql`SELECT id FROM audit_log WHERE target=${fileId}`).toHaveLength(2);
});

it('serializes competing reviewed saves on independent PostgreSQL connections', async () => {
    const { fileId, seriesId, episodeIds } = await reviewedFixture();
    const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
    const clients = [
        postgres(getTestDatabaseUrl(), { max: 1 }),
        postgres(getTestDatabaseUrl(), { max: 1 }),
    ];
    try {
        const results = await Promise.all(
            clients.map((client, i) =>
                setManualFileEpisodes(
                    client,
                    fileId,
                    i === 0 ? episodeIds : [...episodeIds].reverse(),
                    [
                        { startMs: 0, endMs: 30000 },
                        { startMs: 30000, endMs: 60000 },
                    ],
                    {
                        seriesId,
                        revision: reviewed.revision,
                        actor: { username: 'concurrent-review' },
                    },
                ),
            ),
        );
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok && result.reason === 'conflict')).toHaveLength(
            1,
        );
        expect(await sql`SELECT id FROM audit_log WHERE target=${fileId}`).toHaveLength(1);
        const saved = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
        expect(saved.links).toHaveLength(2);
        expect(saved.links.map((link) => link.startMs)).toEqual([0, 30000]);
    } finally {
        await Promise.all(clients.map((client) => client.end()));
    }
});

it.each(['status', 'dismissal'])(
    'revalidates target %s after waiting on an independent writer lock',
    async (change) => {
        const { fileId, seriesId, episodeIds } = await reviewedFixture();
        const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const saver = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: 'manual-review-lock-test' },
        });
        let unlock: () => void = () => {};
        let locked: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            unlock = resolve;
        });
        const ready = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const mutation = writer.begin(async (tx) => {
            if (change === 'status')
                await tx`UPDATE media_items SET status='deleted' WHERE id=${episodeIds[1]}`;
            else
                await tx`UPDATE media_items SET is_dismissed=true,dismissed_at=now() WHERE id=${episodeIds[1]}`;
            locked();
            await gate;
        });
        let saving: ReturnType<typeof setManualFileEpisodes> | undefined;
        try {
            await ready;
            saving = setManualFileEpisodes(
                saver,
                fileId,
                episodeIds,
                [
                    { startMs: 0, endMs: 30000 },
                    { startMs: 30000, endMs: 60000 },
                ],
                { seriesId, revision: reviewed.revision, actor: { username: 'locked-review' } },
            );
            await expect
                .poll(async () => {
                    const rows =
                        await sql`SELECT pid FROM pg_stat_activity WHERE application_name='manual-review-lock-test' AND wait_event_type='Lock'`;
                    return rows.length;
                })
                .toBe(1);
            unlock();
            await mutation;
            expect(await saving).toEqual({ ok: false, reason: 'conflict' });
            expect(await sql`SELECT id FROM audit_log WHERE target=${fileId}`).toHaveLength(0);
            expect(
                (await getFileEpisodeEditorData(sql, fileId, seriesId))?.links.map(
                    (l) => l.mediaItemId,
                ),
            ).toEqual([episodeIds[0]]);
        } finally {
            unlock();
            await mutation;
            if (saving) await saving;
            await Promise.all([writer.end(), saver.end()]);
        }
    },
);

it.each(['save', 'reset'])(
    'uses deletion-compatible lock ordering for reviewed %s on independent connections',
    async (operation) => {
        const f = await reviewedFixture();
        const reviewed = (await getFileEpisodeEditorData(sql, f.fileId, f.seriesId))!;
        const deleting = postgres(getTestDatabaseUrl(), { max: 1 });
        const editing = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: 'mapping-delete-race' },
        });
        let release: () => void = () => {};
        let ready: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const locked = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const deletion = deleting.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${f.episodeIds[0]}))`;
            ready();
            await gate;
            return deleteStaleMediaFile(tx as unknown as postgres.Sql, reviewed.file.filePath);
        });
        let edit: ReturnType<typeof setManualFileEpisodes> | undefined;
        try {
            await locked;
            const options = {
                seriesId: f.seriesId,
                revision: reviewed.revision,
                actor: { username: 'deletion-race' },
            };
            edit =
                operation === 'save'
                    ? setManualFileEpisodes(
                          editing,
                          f.fileId,
                          f.episodeIds,
                          [
                              { startMs: 0, endMs: 30000 },
                              { startMs: 30000, endMs: 60000 },
                          ],
                          options,
                      )
                    : clearReviewedManualFileEpisodes(editing, f.fileId, options);
            await expect
                .poll(
                    async () =>
                        (
                            await sql`SELECT pid FROM pg_stat_activity WHERE application_name='mapping-delete-race' AND wait_event_type='Lock'`
                        ).length,
                )
                .toBe(1);
            release();
            expect((await deletion).deleted).toBe(true);
            expect(await edit).toEqual({ ok: false, reason: 'file_not_found' });
            expect(await sql`SELECT id FROM audit_log WHERE target=${f.fileId}`).toHaveLength(0);
        } finally {
            release();
            await deletion;
            if (edit) await edit;
            await Promise.all([deleting.end(), editing.end()]);
        }
    },
);

it.each(['absent', 'other-episode'])(
    'rejects dismissed selections with %s consent before any mutation or audit',
    async (consent) => {
        const { fileId, seriesId, episodeIds } = await reviewedFixture();
        await sql`UPDATE media_items SET is_dismissed=true,dismissed_at=now() WHERE id=${episodeIds[1]}`;
        const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
        const beforeLinks =
            await sql`SELECT * FROM media_file_items ORDER BY file_id,media_item_id`;
        const beforeFile = await sql`SELECT * FROM media_files WHERE id=${fileId}`;
        const beforeSet = await sql`SELECT * FROM manual_file_link_sets WHERE file_id=${fileId}`;
        const beforeItems = await sql`SELECT * FROM media_items ORDER BY id`;
        const beforeAudit = await sql`SELECT * FROM audit_log WHERE target=${fileId}`;
        expect(
            await setManualFileEpisodes(sql, fileId, [episodeIds[1]], null, {
                seriesId,
                revision: reviewed.revision,
                actor: { username: 'consent-test' },
                restoreDismissedEpisodeIds:
                    consent === 'other-episode' ? [episodeIds[0]] : undefined,
            }),
        ).toMatchObject({ ok: false, reason: 'invalid' });
        expect(await sql`SELECT * FROM media_file_items ORDER BY file_id,media_item_id`).toEqual(
            beforeLinks,
        );
        expect(await sql`SELECT * FROM media_files WHERE id=${fileId}`).toEqual(beforeFile);
        expect(await sql`SELECT * FROM manual_file_link_sets WHERE file_id=${fileId}`).toEqual(
            beforeSet,
        );
        expect(await sql`SELECT * FROM media_items ORDER BY id`).toEqual(beforeItems);
        expect(await sql`SELECT * FROM audit_log WHERE target=${fileId}`).toEqual(beforeAudit);
    },
);

it('restores and audits only explicitly selected dismissed episodes with fresh review', async () => {
    const { fileId, seriesId, episodeIds } = await reviewedFixture();
    await sql`UPDATE media_items SET is_dismissed=true,dismissed_at=now() WHERE id=ANY(${episodeIds}::uuid[])`;
    const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
    expect(reviewed.episodes.every((ep) => ep.isDismissed && ep.dismissedAt !== null)).toBe(true);
    expect(reviewed.links[0]).toMatchObject({ isDismissed: true, dismissedAt: expect.any(String) });
    expect(
        await setManualFileEpisodes(sql, fileId, [episodeIds[1]], null, {
            seriesId,
            revision: reviewed.revision,
            restoreDismissedEpisodeIds: [episodeIds[1]],
            actor: { username: 'consent-test', kind: 'session' },
        }),
    ).toMatchObject({ ok: true });
    const items =
        await sql`SELECT id,is_dismissed,dismissed_at FROM media_items WHERE id=ANY(${episodeIds}::uuid[]) ORDER BY id`;
    expect(items.find((ep) => ep.id === episodeIds[1])).toMatchObject({
        is_dismissed: false,
        dismissed_at: null,
    });
    expect(items.find((ep) => ep.id === episodeIds[0])).toMatchObject({
        is_dismissed: true,
        dismissed_at: expect.any(Date),
    });
    const [audit] =
        await sql`SELECT actor,detail FROM audit_log WHERE target=${fileId} AND actor='consent-test'`;
    expect(audit.actor).toBe('consent-test');
    expect(audit.detail.restoredDismissedEpisodeIds).toEqual([episodeIds[1]]);
});

it.each(['flag', 'timestamp'])(
    'invalidates the review when dismissal %s changes',
    async (change) => {
        const { fileId, seriesId, episodeIds } = await reviewedFixture();
        await sql`UPDATE media_items SET is_dismissed=true,dismissed_at='2026-10-01' WHERE id=${episodeIds[1]}`;
        const reviewed = (await getFileEpisodeEditorData(sql, fileId, seriesId))!;
        if (change === 'flag')
            await sql`UPDATE media_items SET is_dismissed=false WHERE id=${episodeIds[1]}`;
        else await sql`UPDATE media_items SET dismissed_at='2026-10-02' WHERE id=${episodeIds[1]}`;
        expect(
            await setManualFileEpisodes(sql, fileId, [episodeIds[1]], null, {
                seriesId,
                revision: reviewed.revision,
                restoreDismissedEpisodeIds: [episodeIds[1]],
            }),
        ).toEqual({ ok: false, reason: 'conflict' });
    },
);
