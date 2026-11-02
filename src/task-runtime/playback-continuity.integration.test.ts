// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real Linux lab boundary: existing playback HTTP continues while an actual
 * compiled dedicated worker exits, is absent longer than the session TTL, and
 * boots afresh. No auth, keepalive, proxy, store or media implementation is mocked.
 * SvelteKit hooks/routing, player rendering, VOD and release images remain outside.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';

const runFile = promisify(execFile);
import {
    availablePort,
    groupMembers,
    track,
    waitUntil,
    awaitExit,
    cleanupChild,
    bundleHttpHost,
    startSdkWorker,
    settleSdkWorkerHistory,
    delay,
    type ManagedChild,
} from './__fixtures__/playback-qualification.js';

import { isolateQualificationTaskStore } from './__fixtures__/qualification-task-store.js';
let disposeTaskStore: (() => Promise<void>) | undefined;
beforeAll(async () => {
    disposeTaskStore = await isolateQualificationTaskStore();
});
afterAll(async () => {
    await disposeTaskStore?.();
});

interface Snapshot {
    hostPid: number;
    proxyPort: number;
    ingestPid: number;
    session: { sessionId: string; viewerKey: string; feedId: string; state: string };
    pointer: string;
    viewer: { viewerKey: string; channelId: string; sourceId: string };
    members: string[];
    ttlMs: number[];
    proxyViewers: number;
}
interface PlaybackReady {
    type: 'ready';
    ownerToken: string;
    foreignToken: string;
    revokedToken: string;
    sessionId: string;
    viewerKey: string;
    state: Snapshot;
}
it('keeps actual Live TV media, authorization and reservations through dedicated worker absence and restart', async () => {
    // Fail inside the test body while its finally block still has two minutes
    // of the outer 330-second Vitest budget to reap owned processes and stores.
    const mainBudgetMs = 210_000;
    const mainDeadline = Date.now() + mainBudgetMs;
    assert.equal(
        platform(),
        'linux',
        'Explicit qualification requires Linux process-group evidence',
    );
    await access('build/task-runtime.js');
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
    const taskCacheUrl = process.env.TEST_TASK_CACHE_URL ?? process.env.TASK_CACHE_URL ?? cacheUrl;
    assert(
        databaseUrl && cacheUrl && taskCacheUrl,
        'Sanctioned isolated SQL and Valkey URLs are required',
    );
    const databaseName = new URL(databaseUrl).pathname.slice(1);
    assert(
        databaseName.startsWith('lumastra_t_') || databaseName === 'lumastra_tests',
        'Refusing non-test SQL',
    );
    for (const url of [cacheUrl, taskCacheUrl])
        assert(Number(new URL(url).pathname.slice(1)) >= 1, 'Refusing non-test Valkey DB');
    const ffmpeg = process.env.FFMPEG_PATH;
    assert(ffmpeg, 'Pinned runner FFmpeg is required');
    await runFile(ffmpeg, ['-hide_banner', '-version'], { timeout: 5000 });
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const channelId = randomUUID();
    const sourceId = randomUUID();
    const directory = await mkdtemp(path.join(tmpdir(), 'playback-continuity-'));
    // Within the app tree so external production npm modules resolve normally.
    const bundleDirectory = await mkdtemp(path.resolve('src/task-runtime/.playback-continuity-'));
    const sql = postgres(databaseUrl, {
        max: 2,
        connect_timeout: 5,
        connection: { statement_timeout: 5000 },
    });
    const children: Array<{ managed: ManagedChild; fixture: boolean }> = [];
    const taskIds: string[] = [];
    // Use values accepted by the real config schema; invalid env values fall
    // back to schema defaults, which can silently lengthen the reservation TTL.
    const viewerTimeoutSeconds = 10;
    const gracePeriodSeconds = 1;
    const expectedReservationTtlMs = (viewerTimeoutSeconds + gracePeriodSeconds + 60) * 1000;
    const artifact: {
        status: string;
        scope: string;
        id: string;
        startedAt: string;
        sourceHashes: Record<string, string>;
        observations: object[];
        phases: Record<string, number>;
        decodedSegments: number;
        expectedReservationTtlMs: number;
        mainBudgetMs: number;
        initialReservationTtlMs?: number[];
        requiredAbsenceMs?: number;
        failure?: string;
        cleanupErrors?: string[];
    } = {
        status: 'failed',
        scope: 'Linux existing Live TV session only; no full Svelte routing, VOD, client rendering, image or soak qualification',
        id,
        startedAt: new Date().toISOString(),
        sourceHashes: {},
        observations: [],
        phases: {},
        decodedSegments: 0,
        expectedReservationTtlMs,
        mainBudgetMs,
    };
    let stopMonitor = false;
    let monitorError: unknown;
    let monitoring: Promise<void> | undefined;
    let phase = 'before';
    let lastDecodedPts = -Infinity;
    let lastDecodedSegment = -1;
    let lastNewMediaAt = Date.now();
    const framesPerPhase = new Map<string, number>();
    const guard = (): void => {
        if (monitorError) throw monitorError;
        assert(Date.now() < mainDeadline, 'Playback qualification main deadline exceeded');
    };
    const environment = {
        ...process.env,
        NODE_ENV: 'production',
        VITEST: undefined,
        DATABASE_URL: databaseUrl,
        CACHE_URL: cacheUrl,
        TASK_CACHE_URL: taskCacheUrl,
        CONFIG_PATH: path.join(directory, 'web-config/settings.json'),
        BASE_PATH: directory,
        JWT_SECRET: randomUUID() + randomUUID(),
        FEATURE_DEVICE_AUTH: 'true',
        FEATURE_LIVETV: 'true',
        LIVETV_SOURCE: 'standalone',
        LIVETV_ALLOW_PRIVATE_URLS: 'true',
        LIVETV_VIEWER_TIMEOUT_SECONDS: String(viewerTimeoutSeconds),
        LIVETV_GRACE_PERIOD_SECONDS: String(gracePeriodSeconds),
        LIVETV_ORPHAN_CHECK_INTERVAL_SECONDS: '1',
        LOG_LEVEL: 'error',
        LOG_LEVEL_CONSOLE: 'error',
        LICENSE_SERVER_CONTACT_ENABLED: 'false',
        FEATURE_JELLYFIN_SYNC: 'false',
        APP_VERSION: '0.1.0',
        PLUGINS_REQUIRE_REGISTRY: 'false',
    };
    try {
        guard();
        const hostBundle = path.join(bundleDirectory, 'host.mjs');
        await bundleHttpHost(hostBundle);
        guard();
        for (const file of [
            'src/task-runtime/playback-continuity.integration.test.ts',
            'src/task-runtime/__fixtures__/playback-http-host.ts',
            'build/task-runtime.js',
        ])
            artifact.sourceHashes[file] = createHash('sha256')
                .update(await readFile(file))
                .digest('hex');
        const port = await availablePort();
        const proxyPort = await availablePort();
        const host = track(
            fork(hostBundle, [JSON.stringify({ id, channelId, sourceId, port, proxyPort })], {
                detached: true,
                execArgv: [],
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                env: {
                    ...environment,
                    WORKER_MODE: 'disabled',
                    DEDICATED_WORKER: 'false',
                    STREAM_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
                    STREAM_PROXY_SECRET: randomUUID(),
                },
            }),
            'independent playback HTTP host',
        );
        children.push({ managed: host, fixture: true });
        let ready: PlaybackReady | undefined;
        let fixtureFailure: string | undefined;
        const snapshots = new Map<string, Snapshot>();
        host.child.on('message', (message: unknown) => {
            if (!message || typeof message !== 'object' || !('type' in message)) return;
            if (message.type === 'ready') ready = message as PlaybackReady;
            if (message.type === 'failure')
                fixtureFailure =
                    'message' in message && typeof message.message === 'string'
                        ? message.message
                        : 'Fixture failed';
            if (
                message.type === 'snapshot' &&
                'id' in message &&
                typeof message.id === 'string' &&
                'state' in message
            )
                snapshots.set(message.id, message.state as Snapshot);
        });
        const hostGuard = (): void => {
            guard();
            assert(
                !fixtureFailure && host.child.exitCode === null && host.child.signalCode === null,
                `Playback host failed: ${fixtureFailure ?? host.logs()}`,
            );
        };
        await waitUntil(
            async () => ready !== undefined,
            60_000,
            'actual playback fixture ready',
            hostGuard,
        );
        assert(ready);
        // Copy credentials into a local closure only. They are never in artifacts/logs.
        const credentials = ready;
        const base = `http://127.0.0.1:${port}`;
        const keepalivePath = `/api/v1/livetv/playback-sessions/${credentials.sessionId}/keepalive`;
        const mediaBase = `/api/v1/livetv/channels/${channelId}/stream/`;
        async function request(
            route: string,
            token: string | undefined,
            status: number,
            method = 'GET',
        ): Promise<Response> {
            guard();
            const response = await fetch(base + route, {
                method,
                headers: token ? { authorization: `Bearer ${token}` } : {},
                signal: AbortSignal.timeout(6000),
            });
            assert.equal(response.status, status, `${method} ${route} status mismatch in ${phase}`);
            if (status !== 200) await response.arrayBuffer();
            return response;
        }
        async function readSnapshot(): Promise<Snapshot> {
            hostGuard();
            const requestId = randomUUID();
            host.child.send({ operation: 'snapshot', id: requestId });
            await waitUntil(
                async () => snapshots.has(requestId),
                6000,
                'real coordination snapshot',
                hostGuard,
            );
            const state = snapshots.get(requestId)!;
            snapshots.delete(requestId);
            return state;
        }
        function assertState(state: Snapshot): void {
            assert.equal(state.hostPid, credentials.state.hostPid, 'Playback host restarted');
            assert.equal(state.proxyPort, proxyPort);
            assert.equal(state.ingestPid, credentials.state.ingestPid, 'Ingest restarted');
            assert(state.ingestPid > 0);
            assert.equal(state.session?.sessionId, credentials.sessionId);
            assert.equal(state.session?.state, 'active');
            assert.equal(state.pointer, credentials.sessionId, 'Current-session pointer changed');
            assert.equal(state.viewer?.viewerKey, credentials.viewerKey);
            assert.equal(state.viewer?.channelId, channelId);
            assert.equal(state.viewer?.sourceId, sourceId);
            assert.deepEqual(state.members, [credentials.viewerKey]);
            assert.equal(state.proxyViewers, 1, 'Proxy reservation changed');
            assert(
                state.ttlMs.length === 3 &&
                    state.ttlMs.every(
                        (ttl) =>
                            Number.isFinite(ttl) && ttl > 55_000 && ttl <= expectedReservationTtlMs,
                    ),
                'Real keepalive did not renew every reservation TTL',
            );
        }
        assertState(credentials.state);
        assert(
            credentials.state.ttlMs.every((ttl) => ttl > expectedReservationTtlMs - 6000),
            'Initial reservation TTL does not match the intended 71-second configuration',
        );
        const requiredAbsenceMs = Math.max(
            75_000,
            Math.ceil(Math.max(...credentials.state.ttlMs)) + 5000,
        );
        assert(requiredAbsenceMs <= 100_000, 'Observed reservation TTL exceeds qualification cap');
        artifact.initialReservationTtlMs = [...credentials.state.ttlMs];
        artifact.requiredAbsenceMs = requiredAbsenceMs;
        // Revoke a distinct device of the same owner through the real logout def.
        // Its JWT must fail while the original device keeps the same playback alive.
        await request('/api/v1/auth/logout', credentials.revokedToken, 204, 'POST');
        const denialPhases = new Set<string>();
        monitoring = (async () => {
            let iteration = 0;
            while (!stopMonitor) {
                hostGuard();
                await request(keepalivePath, credentials.ownerToken, 204, 'POST');
                const playlist = await (
                    await request(mediaBase + 'playlist.m3u8', credentials.ownerToken, 200)
                ).text();
                const matches = [
                    ...playlist.matchAll(/(?:^|\/)segment-(\d+)\.ts(?:\?[^\r\n]*)?$/gm),
                ];
                assert(matches.length, 'Real proxy returned no complete MPEG-TS segments');
                const index = Math.max(...matches.map((match) => Number(match[1])));
                if (index > lastDecodedSegment) {
                    const bytes = Buffer.from(
                        await (
                            await request(
                                mediaBase + `segment-${index}.ts`,
                                credentials.ownerToken,
                                200,
                            )
                        ).arrayBuffer(),
                    );
                    assert(bytes.length > 188, 'Empty media segment');
                    const mediaFile = path.join(directory, 'decode.ts');
                    await writeFile(mediaFile, bytes);
                    const decoded = await runFile(
                        ffmpeg,
                        [
                            '-hide_banner',
                            '-loglevel',
                            'error',
                            '-err_detect',
                            'explode',
                            '-copyts',
                            '-i',
                            mediaFile,
                            '-map',
                            '0:v:0',
                            '-an',
                            '-threads',
                            '1',
                            '-f',
                            'framecrc',
                            '-',
                        ],
                        { timeout: 7000, maxBuffer: 512 * 1024 },
                    );
                    const timebase = /^#tb 0: (\d+)\/(\d+)$/m.exec(decoded.stdout);
                    assert(timebase, 'Decoder did not produce a video timebase');
                    const pts = decoded.stdout
                        .split('\n')
                        .filter((line) => /^0,/.test(line))
                        .map(
                            (line) =>
                                (Number(line.split(',')[2]) * Number(timebase[1])) /
                                Number(timebase[2]),
                        );
                    assert(
                        pts.length > 0 && pts.every(Number.isFinite),
                        'Actual media decode produced no frames',
                    );
                    for (let i = 1; i < pts.length; i++)
                        assert(pts[i] > pts[i - 1], 'Decoded timestamps reversed inside a segment');
                    assert(
                        pts[0] > lastDecodedPts,
                        'Decoded media repeated or went backwards across worker lifecycle',
                    );
                    lastDecodedPts = pts.at(-1)!;
                    lastDecodedSegment = index;
                    lastNewMediaAt = Date.now();
                    artifact.decodedSegments++;
                    framesPerPhase.set(phase, (framesPerPhase.get(phase) ?? 0) + pts.length);
                }
                assert(
                    Date.now() - lastNewMediaAt < 8000,
                    'Actual decoded media stopped progressing while requests continued',
                );
                if (iteration++ % 3 === 0) {
                    const checkDenials =
                        ['before', 'absent', 'after'].includes(phase) && !denialPhases.has(phase);
                    if (checkDenials) {
                        await request(keepalivePath, undefined, 401, 'POST');
                        await request(keepalivePath, credentials.foreignToken, 404, 'POST');
                        await request(keepalivePath, credentials.revokedToken, 401, 'POST');
                        denialPhases.add(phase);
                    }
                    const state = await readSnapshot();
                    assertState(state);
                    assert(
                        artifact.observations.length < 300,
                        'Unbounded qualification observation buffer',
                    );
                    artifact.observations.push({
                        phase,
                        at: Date.now(),
                        ingestPid: state.ingestPid,
                        ttlMs: state.ttlMs,
                        lastDecodedPts,
                        lastDecodedSegment,
                        auth: checkDenials
                            ? { valid: 204, absent: 401, foreign: 404, revoked: 401 }
                            : { valid: 204 },
                    });
                    artifact.phases[phase] = (artifact.phases[phase] ?? 0) + 1;
                }
                await delay(600);
            }
        })().catch((error: unknown) => {
            monitorError = error;
        });

        const startWorker = (boot: number): Promise<{ managed: ManagedChild; port: number }> =>
            startSdkWorker({
                boot,
                id,
                directory,
                environment,
                sql,
                guard: hostGuard,
                taskIds,
                register: (managed) => children.push({ managed, fixture: false }),
            });

        const original = await startWorker(1);
        await waitUntil(
            async () =>
                (framesPerPhase.get('before') ?? 0) > 0 && (artifact.phases.before ?? 0) > 0,
            15_000,
            'baseline decoded media and auth',
            hostGuard,
        );
        phase = 'draining';
        original.managed.child.kill('SIGTERM');
        await awaitExit(original.managed, 30_000, hostGuard);
        assert.equal(
            await fetch(`http://127.0.0.1:${original.port}/api/health/ready`, {
                signal: AbortSignal.timeout(1500),
            }).then(
                () => false,
                () => true,
            ),
            true,
            'Old worker listener survived',
        );
        phase = 'absent';
        const absenceStarted = Date.now();
        // Outlive the INITIAL observed TTLs plus a margin, without rejoining
        // the proxy or minting a session. Observations above also pin the real
        // TTL to the schema-valid 10 + 1 + 60 = 71-second configuration.
        await waitUntil(
            async () => Date.now() - absenceStarted >= requiredAbsenceMs,
            requiredAbsenceMs + 5000,
            'full reservation expiry interval with worker absent',
            hostGuard,
        );
        assert((framesPerPhase.get('absent') ?? 0) > 0 && (artifact.phases.absent ?? 0) > 0);
        assert.equal((await groupMembers(original.managed.child.pid!)).length, 0);
        const absentState = await readSnapshot();
        assertState(absentState);
        artifact.observations.push({
            phase: 'absence-complete',
            durationMs: Date.now() - absenceStarted,
            state: absentState,
        });
        phase = 'restarting';
        const replacement = await startWorker(2);
        phase = 'after';
        await waitUntil(
            async () => (framesPerPhase.get('after') ?? 0) > 0 && (artifact.phases.after ?? 0) > 0,
            15_000,
            'decoded media and authorization after fresh worker ready',
            hostGuard,
        );
        guard();
        expect(replacement.managed.child.pid).not.toBe(original.managed.child.pid);
        stopMonitor = true;
        await monitoring;
        guard();
        expect([...denialPhases].sort()).toEqual(['absent', 'after', 'before']);
        await request(
            `/api/v1/livetv/playback-sessions/${credentials.sessionId}/leave`,
            credentials.ownerToken,
            204,
            'POST',
        );
        artifact.status = 'passed';
    } catch (error) {
        artifact.failure = error instanceof Error ? error.message : 'Qualification failed';
        throw error;
    } finally {
        stopMonitor = true;
        await monitoring;
        const errors: string[] = [];
        for (const { managed, fixture } of [...children].reverse()) {
            try {
                await cleanupChild(managed, fixture);
            } catch (error) {
                errors.push(
                    error instanceof Error ? error.message : 'Owned process cleanup failed',
                );
            }
        }
        try {
            const connection = getQueueConnectionOptions();
            assert(connection, 'Queue cleanup connection unavailable');
            const expectedQueue = new URL(taskCacheUrl);
            assert(
                connection.db === Number(expectedQueue.pathname.slice(1)) &&
                    connection.host === expectedQueue.hostname &&
                    connection.port === Number(expectedQueue.port || '6379'),
                'Queue cleanup must use the exact isolated coordination endpoint',
            );
            for (const taskId of taskIds) {
                const queue = new Queue(taskId, {
                    connection: {
                        ...connection,
                        connectTimeout: 5000,
                        commandTimeout: 5000,
                        maxRetriesPerRequest: 1,
                        retryStrategy: () => null,
                    },
                    prefix: PER_TASK_QUEUE_PREFIX,
                });
                try {
                    await queue.obliterate({ force: true });
                } finally {
                    await queue.close();
                }
            }
            // Built-in jobs can retain accepted work in other queues; their
            // history is settled, not deleted (see settleSdkWorkerHistory).
            for (const taskId of taskIds)
                await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
            await settleSdkWorkerHistory(sql, id);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Owned task state cleanup failed');
        }
        try {
            await sql.end({ timeout: 5 });
        } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Owned SQL client cleanup failed');
        }
        await rm(directory, { recursive: true, force: true });
        await rm(bundleDirectory, { recursive: true, force: true });
        if (errors.length) {
            artifact.status = 'failed';
            artifact.cleanupErrors = errors;
        }
        await mkdir('build/native-validation', { recursive: true });
        await writeFile(
            'build/native-validation/playback-continuity.json',
            JSON.stringify(artifact, null, 2) + '\n',
        );
        assert.deepEqual(errors, [], 'Actual playback qualification cleanup failed');
    }
}, 330_000);
