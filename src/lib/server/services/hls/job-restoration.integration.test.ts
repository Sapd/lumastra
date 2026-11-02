// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D-HLS-2 (security runtime pass 2026-09-26, fix (c)): a persisted
 * `active_transcode_jobs` row whose `item_id` disagrees with its own
 * `config.itemId` (D-HLS-1 — a cross-process/case-variant start collision;
 * `upsertJob`'s `ON CONFLICT` half-update, `transcode-jobs.queries.ts:249`,
 * updates `config`/`pod_name` but not `item_id`/`job_id`/`output_dir`) used
 * to pass `restoreHlsJobIfMissing`'s job->item binding check whenever it was
 * gated on the `item_id` spelling — the check only looked at `item_id` — and
 * then took over the row (writing `pod_name`) and respawned FFmpeg from
 * `metadata.config`, i.e. from `config.itemId`, a DIFFERENT item. Only the
 * `post-restore-foreign-item` backstop in `lumastra-segment-handler.ts`
 * (kept, unchanged) refused the resulting bytes — after the wasted takeover
 * and respawn.
 *
 * This exercises the fix against REAL Postgres persistence (real
 * `TranscodeJobPersistenceService`, real `upsertJob`/`getJob` against the
 * test DB), so the row this drives
 * `restoreHlsJobIfMissing` against is genuinely self-inconsistent in the
 * database, not a hand-built fixture object.
 */

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
    resetPeerTakeoverMemoryForTests,
    restoreHlsJobIfMissing,
    settlePrewarmForTests,
} from './job-restoration.js';
import { isOutputMarkerPath } from './output-marker.js';
import { TranscodeJobPersistenceService } from '../transcode-job-persistence.service.js';
import {
    upsertJob,
    getJob as getJobRow,
    type TranscodeJobInsert,
} from '$lib/server/database/queries/transcode-jobs.queries.js';
import type { TranscodeJob } from '../transcoding/types.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../../tests/integration/fixtures/media.fixtures.js';

const sql = getTestDb();

async function makeUser(): Promise<{ userId: string; username: string }> {
    const userId = randomUUID();
    await ensureTestUser(sql, userId);
    return { userId, username: derivedUsername(userId) };
}

async function makeItem(): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(sql, {
        id,
        title: 'D-HLS-2 test item',
        original_title: null,
        media_type: 'movie',
        year: 2020,
        status: 'active',
        parent_id: null,
        has_files: true,
    });
    return id;
}

function buildJobInsert(
    sid: string,
    itemId: string,
    username: string,
    userId: string,
    podName: string,
    overrides: Partial<TranscodeJobInsert> = {},
): TranscodeJobInsert {
    const now = new Date();
    return {
        play_session_id: sid,
        job_id: `job-${itemId}`,
        item_id: itemId,
        user_id: toUserId(userId),
        device_id: 'test-device',
        config: {
            itemId,
            username,
            deviceId: 'test-device',
            playSessionId: sid,
            inputUrl: '/fake/media.mkv',
            audioTracks: [],
        },
        output_dir: `/tmp/d-hls-2-${itemId}`,
        status: 'ready',
        mode: 'full',
        segment_offset: 0,
        segments_ready: 0,
        master_playlist_ready: false,
        pod_name: podName,
        ffmpeg_pid: null,
        created_at: now,
        last_accessed_at: now,
        last_progress_at: now,
        transcode_decision: null,
        can_restore: true,
        ...overrides,
    };
}

const STALE_MS = 20_000; // > OWNER_SERVING_STALE_MS (15s)

function baseRestoreOptions(
    itemId: string,
    sid: string,
    persistence: TranscodeJobPersistenceService,
    restoreJob: (...args: unknown[]) => Promise<TranscodeJob>,
    accessFile: (filePath: string) => Promise<void>,
) {
    return {
        job: undefined,
        itemId,
        internalId: itemId,
        playSessionId: sid,
        segmentPath: 'stream_0/segment_00000.m4s',
        corsHeaders: { 'Access-Control-Allow-Origin': '*' },
        contentTypes: { '.m4s': 'video/mp4' },
        currentPodName: 'pod-web',
        restoreWaitTimeoutMs: 1000,
        restorePollIntervalMs: 0,
        jobPersistence: persistence,
        transcodeService: {
            restoreJob,
            getJobByPlaySession: (): TranscodeJob | undefined => undefined,
        },
        accessFile,
        readFile: async () => Buffer.from('segment'),
        trackHlsSegment: () => undefined,
        sleep: () => Promise.resolve(),
        logInfo: () => undefined,
        logWarn: () => undefined,
        logError: () => undefined,
    };
}

describe('restoreHlsJobIfMissing — D-HLS-2, real Postgres persistence', () => {
    it('refuses a self-inconsistent row (item_id=X, config.itemId=Y) gated on X — no takeover, no restoreJob', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();
        const staleAccessedAt = new Date(Date.now() - STALE_MS);

        // Build the row the way production does: upsert X, then upsert Y
        // under the SAME play_session_id with a different pod. At the
        // current HEAD, upsertJob's ON CONFLICT half-update
        // (transcode-jobs.queries.ts:249) updates status/config/
        // segment_offset/pod_name/ffmpeg_pid/last_accessed_at/
        // last_progress_at but NOT item_id/job_id/output_dir — so item_id
        // stays X while config.itemId becomes Y (D-HLS-1, 1b-split/Q1).
        await upsertJob(
            sql,
            buildJobInsert(sid, itemX, a.username, a.userId, 'pod-wrk', {
                status: 'running',
                last_accessed_at: staleAccessedAt,
            }),
        );
        await upsertJob(
            sql,
            buildJobInsert(sid, itemY, a.username, a.userId, 'pod-wrk', {
                status: 'running',
                last_accessed_at: staleAccessedAt,
            }),
        );

        // Belt-and-suspenders, independent of upsertJob's current ON CONFLICT
        // shape: force the exact mismatched shape directly. Fix (b) (D-HLS-1)
        // is expected to change upsertJob to refuse/replace on an item_id
        // disagreement — if that lands before this test is next run, the
        // double-upsert above may stop producing a mismatch on its own, and
        // this UPDATE keeps building the self-inconsistent row this test
        // exists to catch, so the test can't silently start passing
        // vacuously (never actually exercising the D-HLS-2 check).
        await sql`
            UPDATE active_transcode_jobs
            SET item_id = ${itemX},
                config = jsonb_set(config, '{itemId}', ${sql.json(itemY)}),
                pod_name = 'pod-wrk',
                status = 'running',
                can_restore = true,
                last_accessed_at = ${staleAccessedAt}
            WHERE play_session_id = ${sid}
        `;

        const before = await getJobRow(sql, sid);
        expect(before?.item_id).toBe(itemX);
        expect((before?.config as { itemId?: string }).itemId).toBe(itemY);
        expect(before?.pod_name).toBe('pod-wrk');

        const persistence = new TranscodeJobPersistenceService(sql);
        const restoreJob = vi.fn();

        const resultX = await restoreHlsJobIfMissing(
            baseRestoreOptions(itemX, sid, persistence, restoreJob, async () => {
                throw new Error('ENOENT');
            }),
        );

        expect(resultX.response?.status).toBe(404);
        expect(restoreJob).not.toHaveBeenCalled();

        const afterX = await getJobRow(sql, sid);
        expect(afterX?.pod_name).toBe('pod-wrk'); // no takeover
        expect(afterX?.status).toBe('running'); // claimJobForRestoration never ran (would set 'starting')
        expect(afterX?.last_accessed_at.getTime()).toBe(staleAccessedAt.getTime()); // untouched

        // Gated on Y instead: metadata.item_id (X) is not bound to {Y}, so
        // this is ALSO refused — by the pre-existing C1 check this time, not
        // the new one — but must be equally inert (no takeover/restore).
        restoreJob.mockClear();
        const resultY = await restoreHlsJobIfMissing(
            baseRestoreOptions(itemY, sid, persistence, restoreJob, async () => {
                throw new Error('ENOENT');
            }),
        );

        expect(resultY.response?.status).toBe(404);
        expect(restoreJob).not.toHaveBeenCalled();

        const afterY = await getJobRow(sql, sid);
        expect(afterY?.pod_name).toBe('pod-wrk');
        expect(afterY?.last_accessed_at.getTime()).toBe(staleAccessedAt.getTime());
    });

    it('control: a CONSISTENT stale row for X, gated on X, DOES take over and restore', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        const staleAccessedAt = new Date(Date.now() - STALE_MS);

        await upsertJob(
            sql,
            buildJobInsert(sid, itemX, a.username, a.userId, 'pod-wrk', {
                status: 'running',
                last_accessed_at: staleAccessedAt,
            }),
        );

        const before = await getJobRow(sql, sid);
        expect(before?.item_id).toBe(itemX);
        expect((before?.config as { itemId?: string }).itemId).toBe(itemX);

        const persistence = new TranscodeJobPersistenceService(sql);
        const restoredFakeJob = {
            id: 'restored-job',
            outputDir: '/tmp/restored-dir',
        } as TranscodeJob;
        const restoreJob = vi.fn().mockResolvedValue(restoredFakeJob);

        // The segment is absent under the ORIGINAL output_dir (forcing the
        // claim+restore path instead of a disk-serve), but present under the
        // RESTORED job's outputDir (so waitForRestoredSegment's poll succeeds
        // without needing a real FFmpeg process) — same idiom as the existing
        // "claims the job when the owner pod has gone stale" unit test.
        const result = await restoreHlsJobIfMissing(
            baseRestoreOptions(itemX, sid, persistence, restoreJob, async (filePath: string) => {
                if (filePath.includes('restored-dir')) return;
                throw new Error('ENOENT');
            }),
        );

        expect(result.job).toBe(restoredFakeJob);
        expect(restoreJob).toHaveBeenCalledTimes(1);

        const after = await getJobRow(sql, sid);
        expect(after?.pod_name).toBe('pod-web'); // takeover DID happen — proves the harness observes it
    });
});

describe('restoreHlsJobIfMissing — prewarm on claim, real Postgres ownership', () => {
    async function orphanedRow(podName = 'pod-old') {
        const a = await makeUser();
        const itemId = await makeItem();
        const sid = randomUUID();
        await upsertJob(
            sql,
            buildJobInsert(sid, itemId, a.username, a.userId, podName, {
                status: 'running',
                last_accessed_at: new Date(Date.now() - STALE_MS),
            }),
        );
        return { itemId, sid };
    }

    const stampedDisk = (itemId: string) => async (filePath: string) =>
        isOutputMarkerPath(filePath)
            ? Buffer.from(JSON.stringify({ itemId, podName: 'pod-old', jobId: 'job' }))
            : Buffer.from('segment');

    it('restores in the background after the claim and keeps the peer out (no double ownership)', async () => {
        resetPeerTakeoverMemoryForTests();
        const { itemId, sid } = await orphanedRow();
        const persistence = new TranscodeJobPersistenceService(sql);
        const restoreJob = vi.fn().mockResolvedValue({ id: 'r', outputDir: '/tmp/r' });

        const options = (pod: string) => ({
            ...baseRestoreOptions(itemId, sid, persistence, restoreJob, async () => undefined),
            readFile: stampedDisk(itemId),
            segmentPath: 'segment_00073.m4s',
            currentPodName: pod,
        });

        const first = await restoreHlsJobIfMissing(options('pod-web-1'));
        await settlePrewarmForTests();

        // Served from disk, and the FFmpeg job was restored without waiting for
        // a missing segment, at the segment the client had just asked for.
        expect(first.response?.status).toBe(200);
        expect(restoreJob).toHaveBeenCalledTimes(1);
        expect(restoreJob.mock.calls[0][1]).toMatchObject({
            prewarm: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
        });
        const row = await getJobRow(sql, sid);
        expect(row?.pod_name).toBe('pod-web-1');

        // The peer that receives the next request sees a fresh owner: it neither
        // claims nor restores.
        const second = await restoreHlsJobIfMissing(options('pod-web-2'));
        await settlePrewarmForTests();
        expect(second.response?.status).toBe(503);
        expect(restoreJob).toHaveBeenCalledTimes(1);
        expect((await getJobRow(sql, sid))?.pod_name).toBe('pod-web-1');
    });

    it('lets exactly one of two racing pods claim the orphaned session', async () => {
        const { itemId, sid } = await orphanedRow();
        const persistence = new TranscodeJobPersistenceService(sql);

        const claims = await Promise.all([
            persistence.claimJobForRestoration(sid, 'pod-web-1', itemId),
            persistence.claimJobForRestoration(sid, 'pod-web-2', itemId),
        ]);

        expect(claims.filter(Boolean)).toHaveLength(1);
        const winner = claims[0] ? 'pod-web-1' : 'pod-web-2';
        expect((await getJobRow(sql, sid))?.pod_name).toBe(winner);
    });

    it('claims a gracefully stopped session at once, without the 15 s retry window', async () => {
        const { itemId, sid } = await orphanedRow();
        // The dying pod's shutdown path: stopJob(..., persistForRestart) writes
        // 'stopped' + can_restore, and stamps last_accessed_at = NOW().
        await sql`UPDATE active_transcode_jobs
                  SET status = 'stopped', can_restore = TRUE, last_accessed_at = NOW()
                  WHERE play_session_id = ${sid}`;
        const persistence = new TranscodeJobPersistenceService(sql);
        const restoreJob = vi.fn().mockResolvedValue({ id: 'r', outputDir: '/tmp/r' });

        const result = await restoreHlsJobIfMissing({
            ...baseRestoreOptions(itemId, sid, persistence, restoreJob, async () => undefined),
            readFile: stampedDisk(itemId),
            segmentPath: 'segment_00073.m4s',
            currentPodName: 'pod-web-1',
        });
        await settlePrewarmForTests();

        expect(result.response?.status).toBe(200);
        expect(restoreJob).toHaveBeenCalledTimes(1);
        expect((await getJobRow(sql, sid))?.pod_name).toBe('pod-web-1');
    });
});
