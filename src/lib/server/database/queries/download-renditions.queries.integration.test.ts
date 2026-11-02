// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the two `download_renditions` reads the smart-download
 * pool depends on. Both are aggregate queries over a BIGINT column read as
 * text, which is precisely the shape a mocked unit test gets wrong.
 *
 * Requires PG 17+ — see the plan's Global Constraints for the tunnel recipe.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    getRendition,
    markEncoding,
    markReady,
    markFailed,
    reclaimStaleEncode,
    updateProgress,
    readySizesForFiles,
    prepareQueueDepth,
    electOrGetRendition,
} from './download-renditions.queries.js';

/** Matches `config.DOWNLOAD_RENDITION_STALE_SECONDS`'s default (180s). */
const STALE_AFTER_SECONDS = 180;

let sql: postgres.Sql;

beforeAll(async () => {
    sql = await getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.all);
});

/** A media_files row plus the episode it backs — both FK targets are required. */
async function seedFile(): Promise<{ fileId: string; mediaItemId: string }> {
    const mediaItemId = randomUUID();
    const fileId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status)
        VALUES (${mediaItemId}::uuid, 'Ep', 'episode', 'active')
    `;
    await sql`
        INSERT INTO media_files (id, file_path, created_at, updated_at)
        VALUES (${fileId}::uuid, ${`/data/${fileId}.mkv`}, NOW(), NOW())
    `;
    return { fileId, mediaItemId };
}

async function seedRendition(opts: {
    fileId: string;
    mediaItemId: string;
    rungId: string;
    audioIndex: number | null;
    status: 'queued' | 'encoding' | 'ready' | 'failed';
    /**
     * String allowed alongside number because a BIGINT-precision test needs to
     * insert a value above 2^53 — as a JS `number` literal that value has
     * already lost precision at parse time, before it ever reaches SQL.
     */
    sizeBytes?: number | string | null;
    /**
     * Minutes ago the row last heartbeated. Omitted means "now" for a
     * queued/encoding row — matching what `electOrGetRendition`/`markEncoding`
     * actually stamp — and NULL for a terminal row, matching `markReady`/
     * `markFailed`. Pass a large value to simulate an abandoned row nothing
     * on the server will ever advance.
     */
    heartbeatMinutesAgo?: number | null;
}): Promise<void> {
    const heartbeatAt =
        opts.heartbeatMinutesAgo === undefined
            ? opts.status === 'queued' || opts.status === 'encoding'
                ? sql`NOW()`
                : null
            : opts.heartbeatMinutesAgo === null
              ? null
              : sql`NOW() - (${opts.heartbeatMinutesAgo}::text || ' minutes')::interval`;
    await sql`
        INSERT INTO download_renditions
            (file_id, media_item_id, rung_id, audio_index, status, size_bytes, heartbeat_at)
        VALUES (
            ${opts.fileId}::uuid, ${opts.mediaItemId}::uuid, ${opts.rungId},
            ${opts.audioIndex}, ${opts.status}, ${opts.sizeBytes ?? null}, ${heartbeatAt}
        )
    `;
}

describe('readySizesForFiles', () => {
    it('returns the exact size of a finished artifact', async () => {
        const { fileId, mediaItemId } = await seedFile();
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 1,
            status: 'ready',
            sizeBytes: 1_234_567_890,
        });

        const rows = await readySizesForFiles(sql, [fileId], '720p');

        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.size_bytes)).toBe(1_234_567_890);
        expect(rows[0]!.ready_count).toBe(1);
    });

    it('reads size_bytes as text, so a value above 2^53 survives', async () => {
        // BIGINT. Reading it as a JS number in SQL would silently round. The
        // seeded value is passed as a STRING: as a JS number literal it would
        // already round to ...992 at parse time, before ever reaching SQL.
        const { fileId, mediaItemId } = await seedFile();
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '1080p',
            audioIndex: 1,
            status: 'ready',
            sizeBytes: '9007199254740993',
        });

        const rows = await readySizesForFiles(sql, [fileId], '1080p');

        expect(rows[0]!.size_bytes).toBe('9007199254740993');
    });

    it('takes the LARGEST when several audio tracks are ready for one rung', async () => {
        // The candidate row carries no audioIndex — resolving one server-side
        // from the DB is not safe (the absolute-vs-per-type stream_index
        // question is unresolved), so the client POSTs without one and the
        // renditions endpoint resolves the source default itself. Several ready
        // rows can therefore match one (file, rung); the largest is the
        // pessimistic choice, and ready_count > 1 is what makes the caller
        // report the number as NOT exact.
        const { fileId, mediaItemId } = await seedFile();
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 1,
            status: 'ready',
            sizeBytes: 100,
        });
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 2,
            status: 'ready',
            sizeBytes: 300,
        });

        const rows = await readySizesForFiles(sql, [fileId], '720p');

        expect(Number(rows[0]!.size_bytes)).toBe(300);
        expect(rows[0]!.ready_count).toBe(2);
    });

    it('ignores rows that are not ready, and ready rows with no size yet', async () => {
        const { fileId, mediaItemId } = await seedFile();
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 1,
            status: 'encoding',
            sizeBytes: 999,
        });
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 2,
            status: 'ready',
            sizeBytes: null,
        });

        expect(await readySizesForFiles(sql, [fileId], '720p')).toEqual([]);
    });

    it('ignores a different rung', async () => {
        const { fileId, mediaItemId } = await seedFile();
        await seedRendition({
            fileId,
            mediaItemId,
            rungId: '540p',
            audioIndex: 1,
            status: 'ready',
            sizeBytes: 500,
        });

        expect(await readySizesForFiles(sql, [fileId], '720p')).toEqual([]);
    });

    it('returns an empty array for an empty file list rather than throwing', async () => {
        expect(await readySizesForFiles(sql, [], '720p')).toEqual([]);
    });
});

describe('prepareQueueDepth', () => {
    it('counts queued and encoding rows, server-wide', async () => {
        const a = await seedFile();
        const b = await seedFile();
        await seedRendition({ ...a, rungId: '720p', audioIndex: 1, status: 'queued' });
        await seedRendition({ ...a, rungId: '540p', audioIndex: 1, status: 'encoding' });
        await seedRendition({ ...b, rungId: '720p', audioIndex: 1, status: 'ready', sizeBytes: 1 });
        await seedRendition({ ...b, rungId: '540p', audioIndex: 1, status: 'failed' });

        expect(await prepareQueueDepth(sql, STALE_AFTER_SECONDS)).toBe(2);
    });

    it('is 0 on an idle server', async () => {
        expect(await prepareQueueDepth(sql, STALE_AFTER_SECONDS)).toBe(0);
    });

    it('EXCLUDES a queued row whose heartbeat has gone stale', async () => {
        // Nothing on the server advances a `queued` row except a client
        // re-POST of that exact rendition. An app killed mid-flight, a pool
        // turned off, or a pod that dies mid-encode all leave the row exactly
        // here forever — `reapToCap` only ever touches `ready` rows. If this
        // stale row counted, the backpressure ceiling (default 8) would be
        // reached by abandoned rows alone and every pool on the box would
        // 503 permanently with no recovery path.
        const a = await seedFile();
        const b = await seedFile();
        await seedRendition({
            ...a,
            rungId: '720p',
            audioIndex: 1,
            status: 'queued',
            heartbeatMinutesAgo: 60,
        });
        await seedRendition({ ...b, rungId: '720p', audioIndex: 1, status: 'encoding' });

        expect(await prepareQueueDepth(sql, STALE_AFTER_SECONDS)).toBe(1);
    });

    it('excludes a queued/encoding row with no heartbeat at all', async () => {
        // Should never happen from any live writer (both `electOrGetRendition`
        // and `markEncoding` stamp one), but a row without a heartbeat is a
        // row we cannot prove is alive — count only what we can prove.
        const a = await seedFile();
        await seedRendition({
            ...a,
            rungId: '720p',
            audioIndex: 1,
            status: 'queued',
            heartbeatMinutesAgo: null,
        });

        expect(await prepareQueueDepth(sql, STALE_AFTER_SECONDS)).toBe(0);
    });
});

describe('electOrGetRendition with a video-only source', () => {
    it('elects exactly one encoder for a null audio index', async () => {
        const { fileId, mediaItemId } = await seedFile();

        const first = await electOrGetRendition(sql, {
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: null,
            podId: 'pod-a',
        });
        const second = await electOrGetRendition(sql, {
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: null,
            podId: 'pod-b',
        });

        // One test, two mechanisms. `elected: false` proves the INSERT actually
        // conflicted, which only happens with NULLS NOT DISTINCT — Postgres
        // treats NULLs as distinct by default, so without that clause BOTH
        // callers insert and both spawn a multi-GB encode. The matching row id
        // proves the follow-up SELECT found it, which only happens with
        // IS NOT DISTINCT FROM: a plain `=` returns no row and the call throws
        // "lost the election race" after exhausting its attempts.
        expect(first.elected).toBe(true);
        expect(second.elected).toBe(false);
        expect(second.row.id).toBe(first.row.id);
        expect(second.row.audio_index).toBeNull();

        const rows = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM download_renditions WHERE file_id = ${fileId}::uuid
        `;
        expect(rows[0].n).toBe(1);
    });

    it('keeps a video-only rendition distinct from a track-0 one', async () => {
        const { fileId, mediaItemId } = await seedFile();

        const silent = await electOrGetRendition(sql, {
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: null,
            podId: 'pod-a',
        });
        const withAudio = await electOrGetRendition(sql, {
            fileId,
            mediaItemId,
            rungId: '720p',
            audioIndex: 0,
            podId: 'pod-a',
        });

        expect(withAudio.elected).toBe(true);
        expect(withAudio.row.id).not.toBe(silent.row.id);
        expect(withAudio.row.audio_index).toBe(0);
    });
});

describe('encode attempt fencing', () => {
    it('rejects late progress, failure and completion from a superseded attempt, including on the same pod', async () => {
        const file = await seedFile();
        const first = await electOrGetRendition(sql, {
            ...file,
            rungId: '720p',
            audioIndex: null,
            podId: 'pod-a:attempt-1',
        });
        const id = first.row.id;
        await markEncoding(sql, id, 'pod-a:attempt-1');
        await sql`UPDATE download_renditions SET heartbeat_at = NOW() - INTERVAL '10 minutes' WHERE id = ${id}`;
        expect(await reclaimStaleEncode(sql, id, 'pod-a:attempt-2', 180)).toBe(true);
        await markEncoding(sql, id, 'pod-a:attempt-2');
        expect(await updateProgress(sql, id, 99, 'pod-a:attempt-1')).toBe(false);
        expect(await updateProgress(sql, id, 1, 'pod-a:attempt-2')).toBe(true);
        await markReady(sql, id, 'old.mp4', 123, 'pod-a:attempt-1');
        await markFailed(sql, id, 'old_failure', 'pod-a:attempt-1');
        expect(await getRendition(sql, id)).toMatchObject({
            status: 'encoding',
            progress_pct: 1,
            owner_pod: 'pod-a:attempt-2',
        });
        await markReady(sql, id, 'winner.mp4', 456, 'pod-a:attempt-2');
        await markFailed(sql, id, 'late_failure', 'pod-a:attempt-2');
        await markEncoding(sql, id, 'pod-a:attempt-2');
        expect(await getRendition(sql, id)).toMatchObject({
            status: 'ready',
            artifact_name: 'winner.mp4',
            size_bytes: '456',
        });
    });
});
