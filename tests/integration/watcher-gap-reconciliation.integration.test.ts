// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Opt-in Linux qualification, not a synthetic filesystem/queue test. Run through
 * with-isolated-valkey.mjs with LUMASTRA_WATCHER_GAP_QUALIFICATION=1 and the actual
 * Rust binary. Admission is forwarded to one owned REAL orchestrator; BullMQ, runner, scanner and SQL stay real.
 */
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
    access,
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ulid } from 'ulid';
import type postgres from 'postgres';
import { getTestDb } from './setup/test-database.js';
import { config } from '$lib/server/config.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import {
    orchestrator,
    TaskOrchestrator,
    type StartRunResult,
} from '$lib/server/tasks/orchestrator.js';
import { TaskRunner } from '$lib/server/tasks/runner.js';
import { stateMachine } from '$lib/server/tasks/state-machine.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { fileLibraryScanTask } from '$lib/server/tasks/builtin/native/file-library-scan.js';
import { ingestSingleFile } from '$lib/server/tasks/builtin/native/media-sources/file-scanner.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { hashFileHead } from '$lib/server/utils/file-hash.js';
import { WatcherLeader } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher.js';
import { createProcessFileForWatcher } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-process-file.js';
import { NativeWatcherProcess } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-host.js';
import type { PluginContext } from '$lib/server/plugins/types/base-plugin.js';

interface FileSnapshot {
    id: string;
    path: string;
    size: string;
    hash: string | null;
    itemIds: string[];
}
interface RunSnapshot {
    id: string;
    state: string;
    input: { libraryPathId?: string };
    result: unknown;
    error: unknown;
    parentRunId: string | null;
    trigger: unknown;
}
interface ChildSnapshot {
    pid: number;
    implementation: 'rust';
    environmentKeys: string[];
    exitCode?: number | null;
    signalCode?: string | null;
    closed?: boolean;
}
interface Artifact {
    schemaVersion: number;
    status: 'failed' | 'passed';
    startedAt: string;
    finishedAt?: string;
    scope: string;
    platform: { node: string; kernel: string; arch: string };
    hashes: Record<string, string>;
    binaryVersion?: string;
    admissions: Array<{ taskId: string; input: unknown; result: StartRunResult; source?: string }>;
    runs: RunSnapshot[];
    phases: Array<{ phase: string; files: FileSnapshot[] }>;
    children: ChildSnapshot[];
    inaccessibleScan?: {
        id: string;
        errors: number;
        errorSamples: string[];
        totalFiles: number;
        completedAt: Date | null;
    };
    cleanup: {
        leadersStopped: boolean;
        runnerStopped: boolean;
        orchestratorStopped: boolean;
        childrenReaped: boolean;
    };
    failure?: string[];
}

it.runIf(process.env.LUMASTRA_WATCHER_GAP_QUALIFICATION === '1')(
    'repairs native restart gaps through real task execution and DB ingestion',
    async () => {
        const output = resolve(
            process.env.LUMASTRA_WATCHER_GAP_OUTPUT ??
                'build/native-validation/watcher-gap-reconciliation.json',
        );
        const binary = resolve(process.env.LUMASTRA_WATCHER_BINARY ?? 'build/lumastra-watcher');
        const artifact: Artifact = {
            schemaVersion: 1,
            status: 'failed',
            startedAt: new Date().toISOString(),
            scope: 'Linux actual native and filtered TS watchers → real WatcherLeader → real admission/BullMQ/TaskRunner → file-library-scan/scanner → PostgreSQL. No container/ARM64/soak claim.',
            platform: { node: process.version, kernel: release(), arch: arch() },
            hashes: {},
            admissions: [],
            runs: [],
            phases: [],
            children: [],
            cleanup: {
                leadersStopped: false,
                runnerStopped: false,
                orchestratorStopped: false,
                childrenReaped: false,
            },
        };
        const failures: unknown[] = [];
        const leaders: WatcherLeader[] = [];
        const children: ChildProcessWithoutNullStreams[] = [];
        const itemIds = new Set<string>();
        let sql: postgres.Sql | undefined;
        let base: string | undefined;
        let root = '';
        let groupId: string | undefined;
        let libraryPathId: string | undefined;
        let detachedRoot: string | undefined;
        let orch: TaskOrchestrator | undefined;
        let runner: TaskRunner | undefined;
        let completed = false;
        let holdNextScan = false;
        let releaseScan: (() => void) | undefined;
        let heldScanId: string | undefined;
        const ownedRunIds = new Set<string>();
        const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
        const snapshot = async (): Promise<FileSnapshot[]> => {
            assert(sql);
            const files = await sql<FileSnapshot[]>`
                SELECT mf.id, mf.file_path AS path, mf.file_size_bytes::text AS size,
                       mf.file_hash_head AS hash,
                       ARRAY(SELECT mfi.media_item_id::text FROM media_file_items mfi
                             WHERE mfi.file_id = mf.id ORDER BY mfi.media_item_id) AS "itemIds"
                FROM media_files mf WHERE mf.file_path LIKE ${root + '/%'} ORDER BY mf.file_path
            `;
            for (const file of files) for (const id of file.itemIds) itemIds.add(id);
            return files;
        };
        const capture = async (phase: string): Promise<FileSnapshot[]> => {
            const files = await snapshot();
            artifact.phases.push({ phase, files });
            return files;
        };
        const waitFor = async (
            predicate: () => Promise<boolean>,
            label: string,
            ms = 20_000,
        ): Promise<void> => {
            const deadline = performance.now() + ms;
            while (!(await predicate())) {
                assert(performance.now() < deadline, `Timed out: ${label}`);
                await delay(50);
            }
        };
        const settledRun = async (runId: string): Promise<RunSnapshot> => {
            let found: RunSnapshot | undefined;
            await waitFor(async () => {
                assert(sql);
                const [row] = await sql<RunSnapshot[]>`
                    SELECT id, state, input, result, error, parent_run_id AS "parentRunId", trigger
                    FROM task_history WHERE id = ${runId}
                `;
                found = row;
                return (
                    row !== undefined && ['completed', 'failed', 'cancelled'].includes(row.state)
                );
            }, `terminal run ${runId}`);
            assert(found);
            artifact.runs.push(found);
            return found;
        };
        const recoveryAfter = async (before: number): Promise<void> => {
            await waitFor(
                async () =>
                    artifact.admissions
                        .slice(before)
                        .some(
                            (entry) =>
                                entry.source === 'file-scanner.native-watcher-reconciliation' &&
                                !entry.result.deduped,
                        ),
                'watcher accepted reconciliation',
                45_000,
            );
            const admission = artifact.admissions
                .slice(before)
                .find(
                    (entry) =>
                        entry.source === 'file-scanner.native-watcher-reconciliation' &&
                        !entry.result.deduped,
                )!;
            expect(admission.input).toEqual({ libraryPathId });
            const scoped = await settledRun(admission.result.runId);
            expect(scoped.state).toBe('completed');
            expect(scoped.parentRunId).toBeNull();
        };
        const startLeader = async (): Promise<WatcherLeader> => {
            assert(sql && libraryPathId);
            const leader = new WatcherLeader(
                createProcessFileForWatcher({ getEnabledLibraryPaths, ingestSingleFile }),
            );
            leaders.push(leader);
            const context = buildPluginContext('file-library-scan', { sql, registry });
            const before = artifact.admissions.length;
            // Same full SDK-to-legacy context bridge as the production
            // fileScannerMediaSource.startWatching entry point; no object stub.
            expect(await leader.start(context as unknown as PluginContext, [root])).toBe(true);
            await recoveryAfter(before);
            return leader;
        };
        const registry = new TaskRegistry();
        // Keep the real execute/input/exclusivity/queue behavior. Disable the
        // scheduler and use one attempt so the outage has a bounded terminal failure.
        assert(fileLibraryScanTask.retry);
        registry.registerTask({
            ...fileLibraryScanTask,
            schedule: undefined,
            retry: { ...fileLibraryScanTask.retry, attempts: 1 },
            // Hold only AFTER the real scanner passed the files and wrote its
            // result, while the real queued attempt still owns exclusivity.
            async execute(ctx) {
                const result = await fileLibraryScanTask.execute(ctx);
                if (holdNextScan && ctx.input.libraryPathId === libraryPathId) {
                    holdNextScan = false;
                    heldScanId = ctx.runId;
                    await new Promise<void>((done) => {
                        releaseScan = done;
                    });
                }
                return result;
            },
        });
        const writeMedia = async (path: string, marker: string): Promise<void> => {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, Buffer.concat([fixture, Buffer.from(marker)]));
        };
        const fixture = await readFile('tests/fixtures/test-video.mp4');
        try {
            assert.equal(platform(), 'linux', 'Watcher gap qualification requires Linux');
            assert(
                process.env.TEST_DATABASE_URL && process.env.TEST_CACHE_URL,
                'Use the isolated integration harness',
            );
            await access(binary, constants.X_OK);
            vi.stubEnv('LUMASTRA_WATCHER_BINARY', binary);
            vi.spyOn(config, 'DISABLE_FILE_LIBRARY_SCAN', 'get').mockReturnValue(false);
            vi.spyOn(config, 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION', 'get').mockReturnValue(false);
            artifact.binaryVersion = execFileSync(binary, ['--version'], {
                encoding: 'utf8',
                timeout: 5000,
            }).trim();
            for (const path of [
                binary,
                'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher.ts',
                'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-host.ts',
                'src/lib/server/tasks/builtin/native/file-library-scan.ts',
                'tests/integration/watcher-gap-reconciliation.integration.test.ts',
            ])
                artifact.hashes[path] = createHash('sha256')
                    .update(await readFile(path))
                    .digest('hex');
            sql = getTestDb();
            await connectValkey();
            base = await mkdtemp(join(tmpdir(), 'lumastra-watcher-gap-'));
            root = join(base, '@configured-root');
            await mkdir(root);
            const [group] = await sql<
                { id: string }[]
            >`INSERT INTO library_groups (name) VALUES (${`Watcher gap ${ulid()}`}) RETURNING id`;
            groupId = group.id;
            const [lp] = await sql<{ id: string }[]>`
                INSERT INTO library_paths (path, media_type, library_group_id, enabled, scan_chapters)
                VALUES (${root}, 'home_video', ${groupId}, true, false) RETURNING id
            `;
            libraryPathId = lp.id;
            const initialPaths = [
                join(root, 'Keep.mp4'),
                join(root, 'Change.mp4'),
                join(root, 'Remove.mp4'),
            ];
            for (const path of initialPaths) await writeMedia(path, path);
            orch = await TaskOrchestrator.start(['io'], {
                registry,
                stateMachine,
                getSql: () => sql!,
                getClient: requireClient,
                perTaskQueues: true,
            });
            // Forward every facade call into the owned real orchestrator. This
            // selects isolation, not the behavior/outcome under test.
            vi.spyOn(orchestrator, 'startRun').mockImplementation(async (taskId, input, opts) => {
                const result = await orch!.startRun(taskId, input, opts);
                ownedRunIds.add(result.runId);
                artifact.admissions.push({
                    taskId,
                    input,
                    result,
                    source: opts?.trigger?.sourceRoute,
                });
                return result;
            });
            runner = await TaskRunner.start(['io'], {
                registry,
                stateMachine,
                getSql: () => sql!,
                getClient: requireClient,
                instanceId: `watcher-gap-${ulid()}`,
                bootId: ulid(),
                heartbeatIntervalMs: 1000,
                perTaskQueues: true,
            });
            const originalStart = NativeWatcherProcess.prototype.start;
            vi.spyOn(NativeWatcherProcess.prototype, 'start').mockImplementation(function (
                this: NativeWatcherProcess,
            ) {
                originalStart.call(this);
                const child = (this as unknown as { child: ChildProcessWithoutNullStreams | null })
                    .child;
                assert(child?.pid, 'Actual native child was not created');
                children.push(child);
                const entry: ChildSnapshot = {
                    pid: child.pid,
                    implementation: 'rust',
                    environmentKeys: [],
                };
                artifact.children.push(entry);
                child.once('close', (code, signal) =>
                    Object.assign(entry, { closed: true, exitCode: code, signalCode: signal }),
                );
            });
            const native = await startLeader();
            const initial = await capture('initial-native-reconciliation');
            expect(initial.map((file) => file.path).sort()).toEqual([...initialPaths].sort());
            expect(initial.every((file) => file.itemIds.length === 1 && file.hash !== null)).toBe(
                true,
            );
            for (const entry of artifact.children) {
                entry.environmentKeys = (await readFile(`/proc/${entry.pid}/environ`, 'utf8'))
                    .split('\0')
                    .filter(Boolean)
                    .map((value) => value.split('=', 1)[0])
                    .sort();
                expect(entry.environmentKeys).toEqual(['LANG', 'PATH']);
            }
            await native.stop();
            expect(artifact.children.every((child) => child.closed)).toBe(true);
            holdNextScan = true;
            const oldScan = await orchestrator.startRun(
                'file-library-scan',
                { libraryPathId },
                {
                    trigger: { kind: 'in-process', sourceRoute: 'watcher-gap.active-scan-control' },
                },
            );
            expect(oldScan.deduped).not.toBe(true);
            await waitFor(
                async () => releaseScan !== undefined,
                'real scan passed files before observation gap',
            );
            expect(heldScanId).toBe(oldScan.runId);
            expect(await capture('active-scan-already-passed-files')).toEqual(initial);
            const hidden = join(root, '.legitimate-title', 'Recovered.mp4');
            await appendFile(initialPaths[1], 'changed during native shutdown');
            await rm(initialPaths[2]);
            await writeMedia(hidden, 'new hidden media while stopped');
            await writeMedia(join(root, '@eaDir', 'Ignored.mp4'), 'vendor junk');
            await writeMedia(join(root, '._Ignored.mp4'), 'AppleDouble junk');
            const beforeRestart = artifact.admissions.length;
            const restartPending = startLeader();
            await waitFor(
                async () =>
                    artifact.admissions
                        .slice(beforeRestart)
                        .some(
                            (entry) =>
                                entry.source === 'file-scanner.native-watcher-reconciliation' &&
                                entry.result.deduped &&
                                entry.result.runId === oldScan.runId,
                        ),
                'watcher repair deduped to actual active scoped scan',
            );
            // The old real scan has already passed these files; completing it
            // cannot repair any of the offline mutations. Only a fresh admitted
            // reconciliation after the retained 30s cooldown can make DB truth.
            releaseScan!();
            releaseScan = undefined;
            expect((await settledRun(oldScan.runId)).state).toBe('completed');
            const restarted = await restartPending;
            const recovered = await capture('native-stop-change-restart');
            expect(recovered.map((file) => file.path).sort()).toEqual(
                [initialPaths[0], initialPaths[1], hidden].sort(),
            );
            const changed = recovered.find((file) => file.path === initialPaths[1])!;
            expect(changed.hash).toBe(await hashFileHead(initialPaths[1]));
            expect(changed.hash).not.toBe(
                initial.find((file) => file.path === initialPaths[1])!.hash,
            );
            expect(changed.itemIds).toEqual(
                initial.find((file) => file.path === initialPaths[1])!.itemIds,
            );
            const beforeLive = artifact.admissions.length;
            const nativeLive = join(root, 'Native live.mp4');
            await writeMedia(nativeLive, 'actual native immediate stable event');
            await waitFor(
                async () =>
                    (await snapshot()).some(
                        (file) => file.path === nativeLive && file.itemIds.length === 1,
                    ),
                'native live event DB ingestion',
                10_000,
            );
            expect(artifact.admissions.length).toBe(beforeLive);
            await capture('native-live-immediate');
            await restarted.stop();
            expect(artifact.children.every((child) => child.closed)).toBe(true);
            await appendFile(initialPaths[1], 'changed during restart shutdown');
            await rm(hidden);
            const restartGap = join(root, '.legitimate-title', 'Restart gap.mp4');
            await writeMedia(restartGap, 'new hidden media before the native watcher restarts');
            const restart = await startLeader();
            const afterRestart = await capture('second-native-stop-change-restart');
            expect(afterRestart.map((file) => file.path).sort()).toEqual(
                [initialPaths[0], initialPaths[1], nativeLive, restartGap].sort(),
            );
            expect(afterRestart.find((file) => file.path === initialPaths[1])!.hash).toBe(
                await hashFileHead(initialPaths[1]),
            );
            expect(afterRestart.find((file) => file.path === initialPaths[1])!.hash).not.toBe(
                changed.hash,
            );
            const beforeRestartLive = artifact.admissions.length;
            const restartedLive = join(root, 'Restarted native live.mp4');
            await writeMedia(restartedLive, 'actual native immediate stable event');
            await waitFor(
                async () =>
                    (await snapshot()).some(
                        (file) => file.path === restartedLive && file.itemIds.length === 1,
                    ),
                'restarted native live event DB ingestion',
                10_000,
            );
            expect(artifact.admissions.length).toBe(beforeRestartLive);
            const accessible = await capture('native-restarted-live-immediate');
            await restart.stop();
            detachedRoot = join(base, 'detached-root');
            await rename(root, detachedRoot);
            const absent = await orchestrator.startRun(
                'file-library-scan',
                { libraryPathId },
                { trigger: { kind: 'in-process', sourceRoute: 'watcher-gap.inaccessible-root' } },
            );
            expect(absent.deduped).not.toBe(true);
            const inaccessibleRun = await settledRun(absent.runId);
            // A complete I/O outage throws from the real scanner before the
            // task can return a result. Keep the actual transient failure
            // contract and its persisted scanner error count, not a fake
            // successful terminal state with a soft-error result.
            expect(inaccessibleRun.state).toBe('failed');
            expect(inaccessibleRun.result).toBeNull();
            expect(inaccessibleRun.error).toMatchObject({
                kind: 'transient',
                message: expect.stringContaining('no successful outcomes with 1 error(s)'),
            });
            const [failedScan] = await sql<NonNullable<Artifact['inaccessibleScan']>[]>`
                SELECT id, errors, error_samples AS "errorSamples",
                       total_files AS "totalFiles", completed_at AS "completedAt"
                FROM file_scanner_runs WHERE library_path_id = ${libraryPathId}
                ORDER BY started_at DESC LIMIT 1
            `;
            assert(failedScan, 'The inaccessible-root scan did not persist its telemetry');
            artifact.inaccessibleScan = failedScan;
            expect(failedScan.errors).toBe(1);
            expect(failedScan.totalFiles).toBe(0);
            expect(failedScan.completedAt).not.toBeNull();
            expect(failedScan.errorSamples.some((sample) => sample.includes(root))).toBe(true);
            expect(await capture('inaccessible-root-retains-files-and-links')).toEqual(accessible);
            await rename(detachedRoot, root);
            detachedRoot = undefined;
            expect(artifact.children).toHaveLength(3);
            completed = true;
        } catch (error) {
            failures.push(error);
        } finally {
            releaseScan?.();
            for (const leader of leaders) {
                try {
                    await leader.stop();
                } catch (error) {
                    failures.push(error);
                }
            }
            artifact.cleanup.leadersStopped = leaders.every((leader) => !leader.isActive());
            try {
                await runner?.stop({ strict: true });
                artifact.cleanup.runnerStopped = true;
            } catch (error) {
                failures.push(error);
            }
            try {
                await orch?.stop({ strict: true });
                artifact.cleanup.orchestratorStopped = true;
            } catch (error) {
                failures.push(error);
            }
            artifact.cleanup.childrenReaped =
                children.every((child) => child.exitCode !== null || child.signalCode !== null) &&
                artifact.children.every((child) => child.closed);
            if (!artifact.cleanup.childrenReaped)
                failures.push(new Error('Owned native child not reaped'));
            try {
                if (sql && libraryPathId)
                    await sql`DELETE FROM file_scanner_runs WHERE library_path_id = ${libraryPathId}`;
                if (sql && root)
                    await sql`DELETE FROM media_files WHERE file_path LIKE ${root + '/%'}`;
                if (sql && itemIds.size)
                    await sql`DELETE FROM media_items WHERE id = ANY(${sql.array([...itemIds])}::uuid[])`;
                if (sql && libraryPathId)
                    await sql`DELETE FROM library_paths WHERE id = ${libraryPathId}`;
                if (sql && groupId) await sql`DELETE FROM library_groups WHERE id = ${groupId}`;
                if (sql && ownedRunIds.size)
                    await sql`DELETE FROM task_history WHERE id = ANY(${sql.array([...ownedRunIds])}::text[])`;
                if (base) await rm(base, { recursive: true, force: true });
            } catch (error) {
                failures.push(error);
            }
            try {
                await disconnectValkey();
            } catch (error) {
                failures.push(error);
            }
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            artifact.finishedAt = new Date().toISOString();
            artifact.status = completed && failures.length === 0 ? 'passed' : 'failed';
            if (failures.length)
                artifact.failure = failures.map((error) =>
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, JSON.stringify(artifact, null, 2) + '\n');
        }
        if (failures.length)
            throw new AggregateError(
                failures,
                `Watcher gap reconciliation failed; artifact: ${output}`,
            );
    },
    120_000,
);
