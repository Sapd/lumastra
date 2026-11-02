// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def as fileEpisodesDef } from '$lib/server/api/defs/admin/media/[id]/files/[fileId]/episodes.js';
import { afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    saveCuratedOutput,
    undoCuratedOutput,
    captureCuratedOutput,
} from './curated-output.service.js';
import {
    setManualFileEpisodes,
    clearReviewedManualFileEpisodes,
    undoManualFileEpisodes,
} from './manual-file-links.service.js';
import { getFileEpisodeReviewRevision } from '$lib/server/database/queries/manual-file-links.queries.js';
import { captureFileMappingChoice } from '$lib/server/database/queries/file-mapping-choice.queries.js';
import { withSegmentChoice, undoSegmentChoice } from './segment-choice.service.js';
import { captureSegmentChoice } from '$lib/server/database/queries/segment-choice.queries.js';
import { applyManualSegmentOverride } from './media-segment-override.service.js';
import { upsertChaptersForFile } from '$lib/server/database/queries/episode-chapters.queries.js';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => getTestDb(),
}));
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { afterContentChanged: vi.fn().mockResolvedValue(undefined) },
}));

const sql = getTestDb();
const ids: string[] = [];
const files: string[] = [];
afterEach(async () => {
    await sql`DELETE FROM audit_log WHERE target=ANY(${ids}::text[]) OR target=ANY(${files}::text[])`;
    await sql`DELETE FROM media_items WHERE id=ANY(${ids}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id=ANY(${files}::uuid[])`;
    ids.length = 0;
    files.length = 0;
});
afterAll(closeTestDb);
async function item(type = 'movie', parent?: string, episode?: number): Promise<string> {
    const id = randomUUID();
    ids.push(id);
    await sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,episode_number)
        VALUES (${id},'Lanterns Above the Basin',${type},${parent ?? null},1,${episode ?? null})`;
    return id;
}
async function file(owner: string, isDefault = true): Promise<string> {
    const id = randomUUID();
    files.push(id);
    await sql`INSERT INTO media_files (id,file_path,duration_seconds,file_size_bytes,file_hash_head,probed_at)
        VALUES (${id},${`/library/${id}.mkv`},600,1000,${id},NOW())`;
    await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${id},${owner},${isDefault})`;
    return id;
}

describe('complete curated output recovery', () => {
    it.each(['chapters', 'lyrics'] as const)(
        'restores all %s timing, order and provenance while retaining unrelated edits',
        async (key) => {
            const id = await item();
            const original =
                key === 'chapters'
                    ? [
                          {
                              title: 'The Ascent',
                              artist: 'Glass Harbour',
                              start_ms: 0,
                              end_ms: 30123,
                              source: 'manual',
                          },
                          {
                              title: 'The Signal',
                              artist: 'Glass Harbour',
                              start_ms: 30123,
                              end_ms: 60000,
                              source: 'manual',
                          },
                      ]
                    : {
                          plain: 'A lantern at the quay',
                          synced: '[00:01.23]A lantern at the quay',
                          source: 'embedded',
                          fetchedAt: '2026-10-27T01:02:03Z',
                          language: 'de',
                      };
            await sql`UPDATE media_items SET custom_metadata=jsonb_build_object(${key}::text,${sql.json(original)}) WHERE id=${id}`;
            await sql`UPDATE media_items SET updated_at='2001-01-01' WHERE id=${id}`;
            const before = await captureCuratedOutput(sql, id, key);
            const receipt = await saveCuratedOutput(
                sql,
                id,
                key,
                key === 'chapters' ? [] : { plain: 'Edited text', synced: null, source: 'user' },
                'admin',
            );
            expect(
                (
                    await sql`SELECT updated_at FROM media_items WHERE id=${id}`
                )[0].updated_at.getFullYear(),
            ).toBeGreaterThan(2001);
            await sql`UPDATE media_items SET updated_at='2002-01-01' WHERE id=${id}`;
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"note":"Keep this later note"}' WHERE id=${id}`;
            await undoCuratedOutput(sql, id, key, receipt);
            expect(
                (
                    await sql`SELECT updated_at FROM media_items WHERE id=${id}`
                )[0].updated_at.getFullYear(),
            ).toBeGreaterThan(2002);
            expect(await captureCuratedOutput(sql, id, key)).toEqual(before);
            expect(
                (
                    await sql`SELECT custom_metadata->>'note' AS note FROM media_items WHERE id=${id}`
                )[0].note,
            ).toBe('Keep this later note');
            await undoCuratedOutput(sql, id, key, receipt);
            expect(
                (
                    await sql`SELECT updated_at FROM media_items WHERE id=${id}`
                )[0].updated_at.getFullYear(),
            ).toBeGreaterThan(2002);
            expect(await captureCuratedOutput(sql, id, key)).toEqual(before);
        },
    );
    it('restores an absent key and rejects a stale output receipt or a stale lyric lookup', async () => {
        const id = await item();
        const absent = await captureCuratedOutput(sql, id, 'lyrics');
        const receipt = await saveCuratedOutput(
            sql,
            id,
            'lyrics',
            { plain: 'First', source: 'user' },
            'admin',
        );
        await expect(
            saveCuratedOutput(sql, id, 'lyrics', { plain: 'Fetched' }, 'admin', absent),
        ).rejects.toThrow('changed during');
        const later = await saveCuratedOutput(sql, id, 'lyrics', { plain: 'Later' }, 'admin');
        await expect(undoCuratedOutput(sql, id, 'lyrics', receipt)).rejects.toThrow(
            'changed since',
        );
        await undoCuratedOutput(sql, id, 'lyrics', later);
        await undoCuratedOutput(sql, id, 'lyrics', receipt);
        expect(await captureCuratedOutput(sql, id, 'lyrics')).toEqual(absent);
    });
    it('routine embedded/provider chapter reads preserve uploaded chapter names and exact times', async () => {
        const id = await item();
        const fileId = await file(id);
        const curated = [
            {
                chapterIndex: 0,
                chapterName: 'Hand-timed opening',
                startTicks: '123450000',
                endTicks: '6000000000',
                source: 'upload',
            },
        ];
        await upsertChaptersForFile(sql, fileId, curated);
        const before = await sql`SELECT * FROM episode_chapters WHERE file_id=${fileId}`;
        await upsertChaptersForFile(sql, fileId, [
            { ...curated[0], chapterName: 'Detected name', startTicks: '0', source: 'file' },
        ]);
        await upsertChaptersForFile(sql, fileId, []);
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${fileId}`).toEqual(before);
    });
});

describe('file mapping recovery', () => {
    it('restores mappings, displaced release defaults, manual persistence and hidden episode state', async () => {
        const series = await item('tv');
        const season = await item('season', series);
        const first = await item('episode', season, 1);
        const second = await item('episode', season, 2);
        const main = await file(first);
        await file(first, false);
        await file(second);
        await sql`UPDATE media_items SET is_dismissed=true,dismissed_at='2026-10-27T00:00:00Z' WHERE id=${second}`;
        const touched = [first, second].sort();
        const before = await captureFileMappingChoice(sql, main, touched);
        const saved = await setManualFileEpisodes(sql, main, [second], null, {
            seriesId: series,
            revision: await getFileEpisodeReviewRevision(sql, main, series),
            restoreDismissedEpisodeIds: [second],
            actor: { username: 'admin' },
        });
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;
        expect(saved.undoId).toBeTruthy();
        const reset = await clearReviewedManualFileEpisodes(sql, main, {
            seriesId: series,
            revision: await getFileEpisodeReviewRevision(sql, main, series),
            actor: { username: 'admin' },
        });
        expect(reset.ok).toBe(true);
        if (!reset.ok) return;
        expect(await undoManualFileEpisodes(sql, main, series, reset.undoId!)).toMatchObject({
            ok: true,
        });
        expect(await undoManualFileEpisodes(sql, main, series, saved.undoId!)).toMatchObject({
            ok: true,
        });
        expect(await captureFileMappingChoice(sql, main, touched)).toEqual(before);
        expect(await undoManualFileEpisodes(sql, main, series, saved.undoId!)).toMatchObject({
            ok: true,
        });
    });
    it('accepts the UI receipt-only Undo payload through request validation and restores the real saved mapping', async () => {
        const series = await item('tv');
        const season = await item('season', series);
        const first = await item('episode', season, 1);
        const second = await item('episode', season, 2);
        const fileId = await file(first);
        const participants = [first, second].sort();
        const before = await captureFileMappingChoice(sql, fileId, participants);
        const saved = await setManualFileEpisodes(sql, fileId, [second], null, {
            seriesId: series,
            revision: await getFileEpisodeReviewRevision(sql, fileId, series),
            actor: { username: 'admin' },
        });
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;
        const url = new URL(`http://localhost/api/admin/media/${series}/files/${fileId}/episodes`);
        const event = {
            params: { id: series, fileId },
            url,
            request: new Request(url, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ undoReceiptId: saved.undoId }),
            }),
            locals: { user: { username: 'admin' } },
            setHeaders: () => {},
            getClientAddress: () => '127.0.0.1',
        } as unknown as RequestEvent;
        // Auth has independent coverage; keep the actual mount parser, endpoint and SQL recovery.
        const response = await mount(
            { ...fileEpisodesDef, auth: { kind: 'public' } },
            { surface: 'internal' },
        ).PUT!(event);
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.links).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    mediaItemId: first,
                    isDefault: true,
                    isDismissed: false,
                }),
            ]),
        );
        expect(await captureFileMappingChoice(sql, fileId, participants)).toEqual(before);
    });

    it('refuses stale Undo after a later mapping edit', async () => {
        const series = await item('tv');
        const season = await item('season', series);
        const episode = await item('episode', season, 1);
        const fileId = await file(episode);
        const saved = await setManualFileEpisodes(sql, fileId, [episode], null, {
            seriesId: series,
            revision: await getFileEpisodeReviewRevision(sql, fileId, series),
            actor: { username: 'admin' },
        });
        expect(saved.ok).toBe(true);
        if (!saved.ok) return;
        await sql`UPDATE media_file_items SET sort_order=9 WHERE file_id=${fileId}`;
        expect(await undoManualFileEpisodes(sql, fileId, series, saved.undoId!)).toEqual({
            ok: false,
            reason: 'conflict',
        });
        expect(
            (await sql`SELECT sort_order FROM media_file_items WHERE file_id=${fileId}`)[0]
                .sort_order,
        ).toBe(9);
    });
});

describe('manual and removed intro/credit marker recovery', () => {
    it('restores the complete prior provider and manual evidence after one save', async () => {
        const id = await item();
        await file(id);
        expect(
            await applyManualSegmentOverride(sql, {
                mediaId: id,
                type: 'Intro',
                startTime: 10,
                endTime: 40,
                setBy: 'previous-admin',
            }),
        ).toMatchObject({ ok: true });
        const before = await captureSegmentChoice(sql, [id]);
        const changed = await withSegmentChoice(sql, id, [id], undefined, 'admin', (tx) =>
            applyManualSegmentOverride(tx, {
                mediaId: id,
                type: 'Intro',
                startTime: 20,
                endTime: 50,
                setBy: 'admin',
            }),
        );
        expect(changed.value).toMatchObject({ ok: true });
        await undoSegmentChoice(sql, id, changed.undoId!);
        const current = (await captureSegmentChoice(sql, [id])) as {
            segments: unknown;
            candidates: unknown;
        };
        expect(current).toMatchObject({
            segments: (before as typeof current).segments,
            candidates: (before as typeof current).candidates,
        });
    });
    it('restores only removed Outros, keeps a later Intro edit, and rejects a changed source', async () => {
        const id = await item();
        const fileId = await file(id);
        await sql`INSERT INTO media_segments (media_id,type,start_time,end_time,source) VALUES (${id},'Outro',550,590,'curated-provider'),(${id},'Intro',5,35,'curated-provider')`;
        const before =
            await sql`SELECT * FROM media_segments WHERE media_id=${id} AND type='Outro'`;
        const removed = await withSegmentChoice(sql, id, [id], 'Outro', 'admin', async (tx) => {
            await tx`DELETE FROM media_segments WHERE media_id=${id} AND type='Outro'`;
        });
        await sql`UPDATE media_segments SET start_time=8 WHERE media_id=${id} AND type='Intro'`;
        await undoSegmentChoice(sql, id, removed.undoId!);
        expect(
            await sql`SELECT * FROM media_segments WHERE media_id=${id} AND type='Outro'`,
        ).toEqual(before);
        expect(
            (
                await sql`SELECT start_time FROM media_segments WHERE media_id=${id} AND type='Intro'`
            )[0].start_time,
        ).toBe(8);
        await undoSegmentChoice(sql, id, removed.undoId!);
        const later = await withSegmentChoice(sql, id, [id], 'Outro', 'admin', async (tx) => {
            await tx`DELETE FROM media_segments WHERE media_id=${id} AND type='Outro'`;
        });
        await sql`UPDATE media_files SET duration_seconds=601 WHERE id=${fileId}`;
        await expect(undoSegmentChoice(sql, id, later.undoId!)).rejects.toThrow(
            'files or markers changed',
        );
    });
});
