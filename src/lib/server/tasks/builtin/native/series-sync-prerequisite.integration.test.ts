// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import type { SeriesSyncResult } from '$lib/server/services/metadata-sync-single.service.js';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';

const sync = vi.hoisted(() => vi.fn<() => Promise<SeriesSyncResult>>());
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => ({
    syncSeriesWithChildren: sync,
    SeriesSyncAbortedError: class SeriesSyncAbortedError extends Error {},
    SeriesSyncProviderUnavailableError: class SeriesSyncProviderUnavailableError extends Error {},
}));
vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/tasks/registry.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/tasks/registry.js')>()),
    registry: { registerTask: vi.fn() },
}));

import { seriesSyncTask, seriesSyncIsFresh } from './media-item-tasks.js';
import { wrapExecute } from '../../run-wrapper.js';
import { classifyError } from '../../runner.js';
import { SeriesSyncProviderUnavailableError } from '$lib/server/services/metadata-sync-single.service.js';
import { StageStateService } from '$lib/server/services/stage-state.service.js';
import { TaskRegistry } from '../../registry.js';
import { publishStageStateChange } from '$lib/server/cache/pipeline-pubsub.js';
import {
    AuthorityStore,
    type AuthorityToken,
} from '../../../../../task-runtime/authority/store.js';

const missing: SeriesSyncResult = {
    updated: false,
    fieldsChanged: [],
    seasonsSynced: 0,
    episodesSynced: 0,
    episodesAttachFailed: 0,
    prerequisiteMissing: 'provider-identity',
};
const success: SeriesSyncResult = {
    updated: true,
    fieldsChanged: [],
    seasonsSynced: 1,
    episodesSynced: 1,
    episodesAttachFailed: 0,
};

describe('series-sync prerequisite disposition (real stage lifecycle)', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let stages: StageStateService;

    beforeAll(() => {
        sql = getTestDb();
        const registry = new TaskRegistry();
        registry.registerTask(seriesSyncTask);
        stages = new StageStateService(
            sql,
            registry,
            vi.fn().mockResolvedValue({ runId: 'queued' }),
            vi.fn().mockResolvedValue({}),
        );
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        await truncateTables(sql, [
            'media_item_stage_state',
            'provider_metadata',
            'media_file_items',
            'media_files',
            'media_items',
        ]);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, metadata_locked)
            VALUES ('Unidentified series', 'tv', true) RETURNING id
        `;
        seriesId = row.id;
        sync.mockResolvedValue(missing);
    });

    async function run(
        force = false,
        controller = new AbortController(),
        authority?: AuthorityToken,
        runSql = sql,
    ): Promise<unknown> {
        const runId = crypto.randomUUID();
        const signal = controller.signal;
        const ctx = mockContext({
            sql: runSql,
            runId,
            signal,
            input: { mediaItemId: seriesId, force },
        });
        return wrapExecute({
            sql: runSql,
            authority,
            signal,
            stageId: 'series-sync',
            pluginId: 'series-sync',
            mediaItemId: seriesId,
            runId,
            processingVersion: 1,
            currentAttempt: 1,
            inner: () => seriesSyncTask.execute(ctx),
        });
    }

    async function stage(): Promise<Record<string, unknown>> {
        const [row] = await sql`
            SELECT * FROM media_item_stage_state
             WHERE media_item_id = ${seriesId}::uuid AND stage_id = 'series-sync'
        `;
        return row;
    }

    it.each([false, true])(
        'records prerequisite skip without completion (force=%s)',
        async (force) => {
            expect(await run(force)).toMatchObject({
                success: false,
                stopReason: 'skipped',
                result: missing,
            });
            expect(await stage()).toMatchObject({
                status: 'skipped_permanent',
                completed_at: null,
                last_error: null,
                last_run_id: null,
                next_eligible_at: null,
                declines: 0,
            });
            expect((await stage()).skipped_reason).toMatch(/provider identity.*Use Identify/);
            expect(await seriesSyncIsFresh(sql, seriesId)).toBe(false);
            const [item] =
                await sql`SELECT metadata_locked FROM media_items WHERE id = ${seriesId}::uuid`;
            expect(item.metadata_locked).toBe(true);
        },
    );

    it('normal retry replaces the prior false permanent TMDB failure', async () => {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, last_error, completed_at)
            VALUES (${seriesId}::uuid, 'series-sync', 1, 'failed_permanent',
                    '{"message":"TMDB returned no seasons or episodes"}'::jsonb, now())
        `;
        await run();
        expect(await stage()).toMatchObject({
            status: 'skipped_permanent',
            completed_at: null,
            last_error: null,
        });
    });

    it.each(['identity.assigned', 'identity.changed'] as const)(
        '%s restores eligibility and a successful retry performs work',
        async (event) => {
            await run();
            await stages.invalidateByEvent(seriesId, event);
            expect(await stage()).toMatchObject({ status: 'pending', skipped_reason: null });
            sync.mockResolvedValue(success);
            expect(await run()).toMatchObject({ success: true });
            expect(await stage()).toMatchObject({ status: 'completed' });
            expect((await stage()).completed_at).not.toBeNull();
            expect(sync).toHaveBeenCalledTimes(2);
        },
    );

    it('does not lose an identity change dispatched during the missing-identity run', async () => {
        sync.mockImplementationOnce(async () => {
            await stages.invalidateByEvent(seriesId, 'identity.assigned');
            return missing;
        });
        await run();
        expect(await stage()).toMatchObject({ status: 'pending', completed_at: null });
        sync.mockResolvedValue(success);
        await run();
        expect(await stage()).toMatchObject({ status: 'completed' });
    });

    it('does not overwrite a different running owner', async () => {
        const owner = crypto.randomUUID();
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, last_run_id, started_at)
            VALUES (${seriesId}::uuid, 'series-sync', 1, 'running', ${owner}, now())
        `;
        await run();
        expect(await stage()).toMatchObject({ status: 'running', last_run_id: owner });
    });

    it('does not overwrite an operator skip', async () => {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason)
            VALUES (${seriesId}::uuid, 'series-sync', 1, 'skipped_permanent', 'operator-gave-up')
        `;
        await run();
        expect(await stage()).toMatchObject({
            status: 'skipped_permanent',
            skipped_reason: 'operator-gave-up',
        });
    });

    it('retains abort semantics even when the service returns the missing prerequisite', async () => {
        const controller = new AbortController();
        sync.mockImplementationOnce(async () => {
            controller.abort();
            return missing;
        });
        expect(await run(false, controller)).toMatchObject({
            success: false,
            stopReason: 'aborted',
        });
        expect(await stage()).toMatchObject({
            status: 'pending',
            completed_at: null,
            skipped_reason: null,
        });
    });

    it('retains wrong-media-type validation before calling the service', async () => {
        await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${seriesId}::uuid`;
        await expect(run()).rejects.toThrow('series-sync requires a series item');
        expect(sync).not.toHaveBeenCalled();
        expect(await stage()).toMatchObject({ status: 'failed_permanent', completed_at: null });
    });

    it('retains vanished-item behavior', async () => {
        await sql`DELETE FROM media_items WHERE id = ${seriesId}::uuid`;
        await expect(run()).rejects.toThrow('media_item_deleted_before_run');
        expect(sync).not.toHaveBeenCalled();
    });

    it('preserves existing children, file links, and manual metadata locks', async () => {
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, metadata_locked)
            VALUES ('Manual season', 'season', ${seriesId}::uuid, true) RETURNING id
        `;
        const [episode] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, metadata_locked)
            VALUES ('Manual episode', 'episode', ${season.id}::uuid, true) RETURNING id
        `;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/test/manual-episode.mkv') RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${episode.id}::uuid)`;
        await run();
        expect(
            await sql`SELECT title, metadata_locked FROM media_items WHERE id = ${episode.id}::uuid`,
        ).toMatchObject([{ title: 'Manual episode', metadata_locked: true }]);
        expect(
            await sql`SELECT file_id FROM media_file_items WHERE media_item_id = ${episode.id}::uuid`,
        ).toMatchObject([{ file_id: file.id }]);
    });

    it('publishes the actual skip and never a fictitious pending transition', async () => {
        await run();
        const statuses = vi
            .mocked(publishStageStateChange)
            .mock.calls.map(([event]) => event.newStatus);
        expect(statuses).toContain('skipped_permanent');
        expect(statuses).not.toContain('pending');
    });

    it.each(['pending', 'failed_transient', 'skipped_transient', 'obsolete'])(
        'does not tombstone a %s reset performed while provider work is in flight',
        async (status) => {
            sync.mockImplementationOnce(async () => {
                await sql`UPDATE media_item_stage_state
                    SET status = ${status}, last_run_id = NULL, invalidated_at = now()
                    WHERE media_item_id = ${seriesId}::uuid AND stage_id = 'series-sync'`;
                return missing;
            });
            await run();
            expect(await stage()).toMatchObject({
                status,
                completed_at: null,
                skipped_reason: null,
            });
        },
    );

    it('does not recreate a stage row removed while provider work is in flight', async () => {
        sync.mockImplementationOnce(async () => {
            await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ${seriesId}::uuid AND stage_id = 'series-sync'`;
            return missing;
        });
        await run();
        expect(
            await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id = ${seriesId}::uuid`,
        ).toHaveLength(0);
        expect(
            vi.mocked(publishStageStateChange).mock.calls.map(([event]) => event.newStatus),
        ).not.toContain('skipped_permanent');
    });

    it('commits a prerequisite skip under valid captured authority', async () => {
        const owner = crypto.randomUUID();
        const authority = await new AuthorityStore(sql).initialize('tasks', owner, 'typescript');
        try {
            await run(false, new AbortController(), authority);
            expect(await stage()).toMatchObject({
                status: 'skipped_permanent',
                completed_at: null,
            });
        } finally {
            await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${owner}::uuid`;
        }
    });

    it('does not tombstone a new running owner elected during provider work', async () => {
        const newOwner = crypto.randomUUID();
        sync.mockImplementationOnce(async () => {
            await sql`UPDATE media_item_stage_state SET last_run_id = ${newOwner}
                WHERE media_item_id = ${seriesId}::uuid AND stage_id = 'series-sync'`;
            return missing;
        });
        await run();
        expect(await stage()).toMatchObject({
            status: 'running',
            last_run_id: newOwner,
            skipped_reason: null,
        });
    });

    it('cannot persist a prerequisite skip after its captured authority expires', async () => {
        const owner = crypto.randomUUID();
        const authority = await new AuthorityStore(sql).initialize('tasks', owner, 'typescript');
        try {
            sync.mockImplementationOnce(async () => {
                await sql`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second'
                    WHERE partition = 'tasks' AND owner_id = ${owner}::uuid`;
                return missing;
            });
            await expect(run(false, new AbortController(), authority)).rejects.toMatchObject({
                code: 'stale_authority',
            });
            expect(await stage()).toMatchObject({
                status: 'running',
                skipped_reason: null,
                completed_at: null,
            });
        } finally {
            await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${owner}::uuid`;
        }
    });

    it('rolls back the skip if cancellation occurs while its stage-row lock is blocked', async () => {
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        const locker = postgres(getTestDatabaseUrl(), { max: 1 });
        const [{ pid }] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const controller = new AbortController();
        let release!: () => void;
        let locked!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
            locked = resolve;
        });
        let lock: Promise<unknown> | undefined;
        sync.mockImplementationOnce(async () => {
            lock = locker.begin(async (tx) => {
                await tx`SELECT 1 FROM media_item_stage_state WHERE media_item_id = ${seriesId}::uuid FOR UPDATE`;
                locked();
                await released;
            });
            await acquired;
            return missing;
        });
        const running = run(false, controller, undefined, writer);
        // Attach the rejection handler before cancelling, to avoid an unhandled rejection.
        const outcome = running.then(
            () => null,
            (error: unknown) => error,
        );
        try {
            await expect
                .poll(async () => {
                    const [row] = await sql<
                        { waiting: boolean }[]
                    >`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`;
                    return row?.waiting;
                })
                .toBe(true);
            controller.abort();
            release();
            await lock;
            expect(await outcome).toMatchObject({ name: 'AbortError' });
            expect(await stage()).toMatchObject({
                status: 'running',
                skipped_reason: null,
                completed_at: null,
            });
        } finally {
            release();
            await outcome;
            await writer.end();
            await locker.end();
        }
    });

    it('the real runner classifier keeps unavailable providers operational and retryable', async () => {
        sync.mockRejectedValueOnce(new SeriesSyncProviderUnavailableError('Provider unavailable'));
        const ctx = mockContext({
            sql,
            runId: crypto.randomUUID(),
            input: { mediaItemId: seriesId },
        });
        await expect(
            wrapExecute({
                sql,
                stageId: 'series-sync',
                pluginId: 'series-sync',
                mediaItemId: seriesId,
                runId: ctx.runId,
                processingVersion: 1,
                currentAttempt: 1,
                classify: (error) => classifyError(error, seriesSyncTask),
                inner: () => seriesSyncTask.execute(ctx),
            }),
        ).rejects.toThrow('Provider unavailable');
        expect(await stage()).toMatchObject({ status: 'failed_transient', completed_at: null });
        expect((await stage()).last_error).toMatchObject({
            remediation: 'operational',
            retryable: true,
        });
        sync.mockResolvedValueOnce(success);
        await run();
        expect(await stage()).toMatchObject({ status: 'completed' });
    });

    it('retains genuine empty-provider permanent failure', async () => {
        sync.mockResolvedValue({ ...missing, prerequisiteMissing: undefined });
        await run();
        expect(await stage()).toMatchObject({ status: 'failed_permanent', completed_at: null });
        expect((await stage()).last_error).toMatchObject({
            message: expect.stringMatching(/TMDB returned no seasons/),
        });
    });

    it('retains partial-run eligibility without completed coverage', async () => {
        sync.mockResolvedValue({ ...success, episodesSynced: 0 });
        await run();
        expect(await stage()).toMatchObject({ status: 'pending', completed_at: null });
    });

    it('retains provider outage retry behavior', async () => {
        sync.mockRejectedValue(new Error('Provider unavailable'));
        await expect(run()).rejects.toThrow('Provider unavailable');
        expect(await stage()).toMatchObject({ status: 'failed_transient', completed_at: null });
    });

    it('retains fileless phantom-series completion', async () => {
        sync.mockResolvedValue({
            ...missing,
            prerequisiteMissing: undefined,
            phantomSkipped: true,
            childrenSkipped: 'not-owned',
        });
        await run();
        expect(await stage()).toMatchObject({ status: 'completed' });
    });
});
