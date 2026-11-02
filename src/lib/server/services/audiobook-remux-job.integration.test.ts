// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The audiobook remux job row, against a real Postgres.
 *
 * This is the half of "visible in the admin transcode surfaces" that no unit test
 * can establish, because what stands between the service and visibility is the
 * TABLE, and `active_transcode_jobs` is unusually opinionated:
 *
 *  - `CHECK (mode = 'full')` — the column admits exactly one value, so a job kind
 *    of `'audiobook_remux'` would be rejected at write time and the row would
 *    simply never appear. The kind therefore lives in `config.type`, and this
 *    test is what proves the constraint is satisfied rather than assumed.
 *  - `CHECK (status IN ('starting','running','ready','stopping','stopped','error'))`.
 *  - `play_session_id uuid REFERENCES play_sessions(id)` plus `UNIQUE`, so the row
 *    can only exist for a real session and a restart-on-seek series collapses onto
 *    one row per session by design.
 *  - `user_id uuid REFERENCES users(id)`.
 *
 * A mocked `sql` would accept every one of those mistakes silently.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { TranscodeJobPersistenceService } from './transcode-job-persistence.service.js';
import { getAllActiveJobs } from '../database/queries/transcode-jobs.queries.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// Fixed ids, so teardown is exact and a crashed run leaves nothing behind for the
// next file to trip over (the audiobook suites that leak media_items rows are why
// the browse suite has an order-dependent failure).
const USER_ID = 'aabbccdd-0000-4000-8000-000000000001';
const MEDIA_ID = 'aabbccdd-0000-4000-8000-000000000002';
const SESSION_ID = 'aabbccdd-0000-4000-8000-000000000003';
const OTHER_SESSION_ID = 'aabbccdd-0000-4000-8000-000000000004';

describe.skipIf(SKIP)('audiobook remux job persistence', () => {
    let sql: postgres.Sql;
    let service: TranscodeJobPersistenceService;

    async function cleanup(): Promise<void> {
        await sql`DELETE FROM active_transcode_jobs WHERE play_session_id = ANY(${[
            SESSION_ID,
            OTHER_SESSION_ID,
        ]}::uuid[])`;
        await sql`DELETE FROM play_sessions WHERE id = ANY(${[SESSION_ID, OTHER_SESSION_ID]}::uuid[])`;
        await sql`DELETE FROM external_ids WHERE media_id = ${MEDIA_ID}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${MEDIA_ID}::uuid`;
        await sql`DELETE FROM users WHERE id = ${USER_ID}::uuid`;
    }

    beforeAll(() => {
        sql = getTestDb();
        service = new TranscodeJobPersistenceService(sql);
    });

    afterAll(async () => {
        await cleanup();
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanup();
        await sql`INSERT INTO users (id, username) VALUES (${USER_ID}::uuid, 'remux_listener')`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, is_dismissed)
            VALUES (${MEDIA_ID}::uuid, 'Hall of Lanterns', 'audiobook', 'active', true, false)
        `;
        for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
            await sql`
                INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address,
                                           play_method, source, source_session_id, status)
                VALUES (${id}::uuid, ${MEDIA_ID}::uuid, ${USER_ID}::uuid, 'lumastra-web',
                        '10.0.0.1'::inet, 'direct', 'audiobookshelf', ${'abs-' + id.slice(-4)},
                        'ACTIVE')
            `;
        }
    });

    const record = (overrides: Record<string, unknown> = {}): Promise<void> =>
        service.recordAudiobookRemuxJob({
            playSessionId: SESSION_ID,
            mediaId: MEDIA_ID,
            userId: USER_ID,
            deviceId: 'lumastra-web',
            ino: '9001',
            absItemId: 'abs-item-1',
            sourceCodec: 'eac3',
            startSeconds: 0,
            ffmpegPid: 4242,
            ...overrides,
        } as Parameters<TranscodeJobPersistenceService['recordAudiobookRemuxJob']>[0]);

    it('writes a row the shared admin read returns', async () => {
        await record();

        // getAllActiveJobs is exactly what /api/admin/ffmpeg-jobs and the active
        // play-sessions panel read; asserting through it (rather than re-stating
        // the SELECT) is what makes this a visibility test.
        const jobs = await getAllActiveJobs(sql);
        const mine = jobs.find((j) => j.play_session_id === SESSION_ID);
        expect(mine).toBeDefined();
        expect(mine?.status).toBe('running');
        expect(mine?.ffmpeg_pid).toBe(4242);
        expect(mine?.job_id).toBe('audiobook-remux-9001-t0');
        expect(mine?.item_id).toBe(MEDIA_ID);
    });

    it('satisfies the mode CHECK constraint while keeping the kind in config', async () => {
        await record();
        const [row] = await sql<{ mode: string; config: Record<string, unknown> }[]>`
            SELECT mode, config FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        // The column admits only 'full'. The KIND — which is what the admin
        // surface labels from — is in the jsonb.
        expect(row.mode).toBe('full');
        expect(row.config.type).toBe('audiobook');
        expect(row.config.transcode_mode).toBe('remux_live');
        expect(row.config.source_codec).toBe('eac3');
        expect(row.config.target_codec).toBe('aac');
        expect(row.config.ino).toBe('9001');
    });

    it('leaves transcode_decision null rather than inventing a video action', async () => {
        await record();
        const [row] = await sql<{ transcode_decision: unknown; can_restore: boolean }[]>`
            SELECT transcode_decision, can_restore FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        // `videoAction: 'copy'` on a file with no video stream is an impossible
        // row, and the admin surface would read plausibly off it.
        expect(row.transcode_decision).toBeNull();
        // Nothing to restore: the process holds the client's socket.
        expect(row.can_restore).toBe(false);
    });

    it('writes a sentinel output_dir that the expired-job sweep will not rm -rf', async () => {
        await record();
        const [row] = await sql<{ output_dir: string }[]>`
            SELECT output_dir FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.output_dir).toBe('(pipe)');
    });

    it('collapses a restart-on-seek series onto the one row per session', async () => {
        // UNIQUE(play_session_id) is the constraint; the ON CONFLICT path is what
        // keeps a listener dragging the scrubber from failing every write after
        // the first. The LATEST offset is what an admin should see.
        await record({ startSeconds: 0 });
        await record({ startSeconds: 1800 });

        const rows = await sql<{ job_id: string }[]>`
            SELECT job_id FROM active_transcode_jobs WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].job_id).toBe('audiobook-remux-9001-t1800');
    });

    it('reopens a finalized row when the same session streams again', async () => {
        await record();
        await service.finalizeAudiobookRemuxJob(SESSION_ID, { ok: true });
        await record({ startSeconds: 60 });

        const [row] = await sql<
            { status: string; stopped_at: Date | null; error_message: string | null }[]
        >`
            SELECT status, stopped_at, error_message FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('running');
        expect(row.stopped_at).toBeNull();
        expect(row.error_message).toBeNull();
    });

    it('refuses to finalize a row a later seek has already taken over', async () => {
        // THE RESTART-ON-SEEK RACE. The client drops the old `<audio>` src and
        // requests a new offset; the new request writes the row while the old
        // ffmpeg is still dying. Its terminal update then arrives LAST. Unguarded,
        // it marks the live stream `stopped` and the admin surface contradicts the
        // audio the listener is hearing.
        await record({ startSeconds: 0 });
        await record({ startSeconds: 1800 });

        await service.finalizeAudiobookRemuxJob(SESSION_ID, {
            ok: true,
            jobId: 'audiobook-remux-9001-t0',
        });

        const [row] = await sql<{ status: string; job_id: string; ffmpeg_pid: number | null }[]>`
            SELECT status, job_id, ffmpeg_pid FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.job_id).toBe('audiobook-remux-9001-t1800');
        expect(row.status).toBe('running');
        expect(row.ffmpeg_pid).toBe(4242);
    });

    it('finalizes the row when the job id DOES match', async () => {
        // The control: the guard must not make finalization impossible.
        await record({ startSeconds: 1800 });
        await service.finalizeAudiobookRemuxJob(SESSION_ID, {
            ok: true,
            jobId: 'audiobook-remux-9001-t1800',
        });

        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('stopped');
    });

    it('marks a killed encode stopped, not errored', async () => {
        // ffmpeg exits 255 when WE SIGTERM it, which is what a pause, a seek or a
        // closed tab produces. Recording that as an error would paint the admin
        // surface red on the most ordinary event in the player's life.
        await record();
        await service.finalizeAudiobookRemuxJob(SESSION_ID, { ok: true });

        const [row] = await sql<
            { status: string; error_message: string | null; ffmpeg_pid: number | null }[]
        >`
            SELECT status, error_message, ffmpeg_pid FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('stopped');
        expect(row.error_message).toBeNull();
        expect(row.ffmpeg_pid).toBeNull();
    });

    it('records a real failure as an error row with its message', async () => {
        await record();
        await service.finalizeAudiobookRemuxJob(SESSION_ID, {
            ok: false,
            error: 'Invalid data found when processing input',
        });

        const [row] = await sql<{ status: string; error_message: string | null }[]>`
            SELECT status, error_message FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('error');
        expect(row.error_message).toContain('Invalid data');
    });

    it('drops out of the active read once finalized', async () => {
        await record();
        await service.finalizeAudiobookRemuxJob(SESSION_ID, { ok: true });

        const jobs = await getAllActiveJobs(sql);
        expect(jobs.find((j) => j.play_session_id === SESSION_ID)).toBeUndefined();
    });

    it('keeps two concurrent sessions on separate rows', async () => {
        await record();
        await record({ playSessionId: OTHER_SESSION_ID, ino: '9002' });

        const jobs = await getAllActiveJobs(sql);
        const mine = jobs.filter((j) => [SESSION_ID, OTHER_SESSION_ID].includes(j.play_session_id));
        expect(mine).toHaveLength(2);
    });

    it('does not throw when the play session is already gone', async () => {
        // The listener closes the tab between the byte request and this write.
        // Losing admin visibility for one stream must never cost the listener
        // their audio. (Since mig 16.282.0 no FK ties the row to play_sessions,
        // so the row is simply written; finalize ends it as usual.)
        await sql`DELETE FROM play_sessions WHERE id = ${SESSION_ID}::uuid`;
        await expect(record()).resolves.toBeUndefined();
    });

    it('skips a play session id that is not a UUID instead of erroring', async () => {
        // Preview sessions use `preview-{uuid}-{ts}`; the column is uuid.
        await expect(record({ playSessionId: 'preview-abc-123' })).resolves.toBeUndefined();
        await expect(
            service.finalizeAudiobookRemuxJob('preview-abc-123', { ok: true }),
        ).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Why the ROUTE has to hold an early exit
    //
    // `handleAudiobookRemux` spawns first and inserts two awaits later, so a spawn
    // failure or a fast upstream refusal can finalize before the row exists. These
    // two cases show, against the real table, what each ordering leaves behind —
    // the consequence the route's ordering test is protecting.
    // -----------------------------------------------------------------------

    const JOB_ID = 'audiobook-remux-9001-t0';

    it('an exit finalized BEFORE the insert leaves the row permanently running', async () => {
        // The pre-fix ordering, reproduced deliberately. `updateTranscodeJobStatus`
        // is an UPDATE: with no row to match it changes nothing and its row count
        // is discarded, so the INSERT afterwards writes a live-looking job for a
        // process that is already dead.
        await service.finalizeAudiobookRemuxJob(SESSION_ID, {
            ok: false,
            error: 'spawn ENOENT',
            jobId: JOB_ID,
        });
        await record();

        const [row] = await sql<{ status: string; ffmpeg_pid: number | null }[]>`
            SELECT status, ffmpeg_pid FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('running');
        expect(row.ffmpeg_pid).toBe(4242);
        // ...and it is still in the admin surface, which is the visible symptom.
        const jobs = await getAllActiveJobs(sql);
        expect(jobs.find((j) => j.play_session_id === SESSION_ID)).toBeDefined();
    });

    it('the same exit applied AFTER the insert ends the row as error', async () => {
        await record();
        await service.finalizeAudiobookRemuxJob(SESSION_ID, {
            ok: false,
            error: 'spawn ENOENT',
            jobId: JOB_ID,
        });

        const [row] = await sql<
            { status: string; ffmpeg_pid: number | null; error_message: string | null }[]
        >`
            SELECT status, ffmpeg_pid, error_message FROM active_transcode_jobs
            WHERE play_session_id = ${SESSION_ID}::uuid
        `;
        expect(row.status).toBe('error');
        expect(row.ffmpeg_pid).toBeNull();
        expect(row.error_message).toBe('spawn ENOENT');
        expect(
            (await getAllActiveJobs(sql)).find((j) => j.play_session_id === SESSION_ID),
        ).toBeUndefined();
    });
});
