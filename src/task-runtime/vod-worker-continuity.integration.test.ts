// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Actual CPU VOD remux/HLS + native progress across independent web processes
 * and an actual dedicated worker stop/absence/fresh boot. No playback/auth/SQL
 * implementation is mocked. Physical player and Svelte hooks remain outside.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import type { env as processEnvironment } from 'node:process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { Queue } from 'bullmq';
import { beforeAll, afterAll, it } from 'vitest';
import type { PlaybackReport } from '$lib/schemas/session-update.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';
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

interface State {
    pid: number;
    pod: string;
    role: 'owner' | 'receiver';
    row: {
        job_id: string;
        pod_name: string;
        status: string;
        last_accessed_at: string;
        last_progress_at: string;
        ffmpeg_pid: number | null;
        segments_ready: number;
    } | null;
    session: {
        id: string;
        media_id: string;
        user_id: string;
        surface: string;
        status: string;
        position_ms: number;
        last_event_seq: number;
        last_heartbeat_at: string;
    } | null;
    durable: {
        event_type: string;
        position_ms: number;
        event_seq: number;
        session_elapsed_ms: number;
        occurred_at: string;
    } | null;
    local: {
        id: string;
        status: string;
        segmentsReady: number;
        segmentDurationSeconds: number;
        ffmpegPid: number | null;
        lastAccessedAt: string;
        lastProgressAt: string;
        lastClientHeartbeatAt: string;
        lastPersistedClientActivityAt: string | null;
    } | null;
    timeouts: { progress: number; inactivity: number; clientGone: number };
}
interface Ready {
    type: 'ready';
    ownerToken: string;
    foreignToken: string;
    revokedToken: string;
    fileId?: string;
    state: State;
}
interface Host {
    managed: ManagedChild;
    port: number;
    ready: Ready;
    session: (sessionId: string) => Promise<void>;
    snapshot: () => Promise<State>;
}
interface Started {
    playbackSessionId: string;
    mediaId: string;
    kind: string;
    delivery: { kind: string; url: string; fileId?: string; playMethod?: string };
    grant: { id: string; token: string; param: string };
}
const runFile = promisify(execFile);

it('keeps decoded native VOD and cross-pod progress leases through actual worker absence, pause and restart', async () => {
    assert.equal(platform(), 'linux', 'Actual owned process-group qualification requires Linux');
    await access('build/task-runtime.js');
    const databaseUrl = process.env.TEST_DATABASE_URL;
    const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
    const taskCacheUrl = process.env.TEST_TASK_CACHE_URL ?? process.env.TASK_CACHE_URL ?? cacheUrl;
    const ffmpeg = process.env.FFMPEG_PATH;
    assert(
        databaseUrl && cacheUrl && taskCacheUrl && ffmpeg,
        'Isolated test SQL, Valkeys and pinned FFmpeg required',
    );
    assert(
        /^lumastra_t_|^lumastra_tests$/.test(new URL(databaseUrl).pathname.slice(1)),
        'Refusing non-test SQL',
    );
    for (const url of [cacheUrl, taskCacheUrl])
        assert(Number(new URL(url).pathname.slice(1)) >= 1, 'Refusing non-test Valkey');
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const mediaId = randomUUID();
    const directory = await mkdtemp(path.join(tmpdir(), 'vod-worker-continuity-'));
    const bundleDirectory = await mkdtemp(path.resolve('src/task-runtime/.vod-worker-continuity-'));
    const sql = postgres(databaseUrl, {
        max: 2,
        connect_timeout: 5,
        connection: { statement_timeout: 5000 },
    });
    const children: Array<{ managed: ManagedChild; fixture: boolean }> = [];
    const taskIds: string[] = [];
    const mainDeadline = Date.now() + 420_000;
    const artifact: {
        status: string;
        scope: string;
        id: string;
        sourceHashes: Record<string, string>;
        observations: object[];
        decodedSegments: number;
        frames: Record<string, number>;
        absenceMs?: number;
        pauseMs?: number;
        negativeControlMs?: number;
        failure?: string;
        cleanupErrors?: string[];
    } = {
        status: 'failed',
        scope: 'Linux CPU native VOD fMP4 remux/HLS + native progress through two real independent web processes; actual dedicated worker; no physical client, full ingress, release images or soak',
        id,
        sourceHashes: {},
        observations: [],
        decodedSegments: 0,
        frames: {},
    };
    let phase = 'before';
    let stopMonitor = false;
    let monitorError: unknown;
    let primaryFailure: unknown;
    const cleanupErrors: string[] = [];
    let fixtureError: string | undefined;
    let monitoring: Promise<void> | undefined;
    let pause = false;
    let eventSeq = 0;
    let positionMs = 60_000;
    let elapsedMs = 60_000;
    let lastPts = -Infinity;
    // This is already-established playback at 60s on the actual two-second grid.
    let nextSegment = 30;
    let leaseTime = 0;
    const guard = (): void => {
        if (monitorError) throw monitorError;
        assert(!fixtureError, fixtureError);
        assert(Date.now() < mainDeadline, 'VOD main qualification deadline exceeded');
    };
    const environment: typeof processEnvironment = {
        ...process.env,
        NODE_ENV: 'production',
        VITEST: undefined,
        DATABASE_URL: databaseUrl,
        CACHE_URL: cacheUrl,
        TASK_CACHE_URL: taskCacheUrl,
        BASE_PATH: directory,
        JWT_SECRET: randomUUID() + randomUUID(),
        FEATURE_DEVICE_AUTH: 'true',
        FEATURE_JELLYFIN_SYNC: 'false',
        LICENSE_SERVER_CONTACT_ENABLED: 'false',
        LOG_LEVEL: 'error',
        LOG_LEVEL_CONSOLE: 'error',
        APP_VERSION: '0.1.0',
        PLUGINS_REQUIRE_REGISTRY: 'false',
        FFMPEG_TRANSCODE_DIR: path.join(directory, 'worker-transcodes'),
        FFMPEG_SEGMENT_DURATION: '6',
        FFMPEG_PROGRESS_TIMEOUT_SECONDS: '30',
        FFMPEG_INACTIVITY_TIMEOUT_SECONDS: '60',
        FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS: '120',
    };
    // A worker starts the native file watcher whenever ANY enabled library path is
    // visible in the shared test database, and other integration files insert such
    // rows concurrently. This test does not watch files, so without a real build
    // the worker would die at boot with "watcher binary does not exist" whenever
    // another file's row happens to be present. Give it a stand-in that passes the
    // `--version` preflight, reports ready and then idles; a real or operator-provided binary wins.
    if (!environment.LUMASTRA_WATCHER_BINARY) {
        const realWatcher = path.resolve('build/lumastra-watcher');
        if (!(await access(realWatcher).then(() => true, () => false))) {
            const standIn = path.join(directory, 'idle-watcher');
            await writeFile(
                standIn,
                '#!/bin/sh\n[ "$1" = "--version" ] && { echo "lumastra-watcher 0.0.0 protocol 2"; exit 0; }\necho \'{"type":"ready","version":2}\'\nexec sleep 100000\n',
                { mode: 0o700 },
            );
            environment.LUMASTRA_WATCHER_BINARY = standIn;
        }
    }
    try {
        const mediaFile = path.join(directory, 'public-domain-synthetic.mp4');
        await runFile(
            ffmpeg,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc2=size=128x72:rate=24',
                '-t',
                '600',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-threads',
                '1',
                '-g',
                '48',
                '-pix_fmt',
                'yuv420p',
                '-an',
                mediaFile,
            ],
            { timeout: 45_000, maxBuffer: 1024 * 1024 },
        );
        guard();
        const hostBundle = path.join(bundleDirectory, 'host.mjs');
        await bundleHttpHost(hostBundle, 'src/task-runtime/__fixtures__/vod-http-host.ts');
        for (const file of [
            'src/task-runtime/vod-worker-continuity.integration.test.ts',
            'src/task-runtime/__fixtures__/vod-http-host.ts',
            'src/task-runtime/__fixtures__/playback-qualification.ts',
            'src/lib/server/services/ffmpeg-transcode.service.ts',
            'build/task-runtime.js',
        ])
            artifact.sourceHashes[file] = createHash('sha256')
                .update(await readFile(file))
                .digest('hex');
        async function startHost(role: 'owner' | 'receiver'): Promise<Host> {
            const port = await availablePort();
            const managed = track(
                fork(hostBundle, [JSON.stringify({ id, role, mediaId, port, mediaFile })], {
                    detached: true,
                    execArgv: [],
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                    env: {
                        ...environment,
                        WORKER_MODE: 'disabled',
                        DEDICATED_WORKER: 'false',
                        HOSTNAME: `vod-${id}-${role}`,
                        CONFIG_PATH: path.join(directory, role, 'settings.json'),
                        // A second web pod must never clean the media owner's local directory.
                        FFMPEG_TRANSCODE_DIR: path.join(directory, `${role}-transcodes`),
                    },
                }),
                `VOD ${role} web host`,
            );
            children.push({ managed, fixture: true });
            let ready: Ready | undefined;
            let sessionSet: string | undefined;
            const snapshots = new Map<string, State>();
            managed.child.on('message', (message: unknown) => {
                if (!message || typeof message !== 'object' || !('type' in message)) return;
                if (message.type === 'ready') ready = message as Ready;
                if (message.type === 'failure') fixtureError = `VOD ${role} fixture failed`;
                if (
                    message.type === 'session' &&
                    'sessionId' in message &&
                    typeof message.sessionId === 'string'
                )
                    sessionSet = message.sessionId;
                if (
                    message.type === 'snapshot' &&
                    'id' in message &&
                    typeof message.id === 'string' &&
                    'state' in message
                )
                    snapshots.set(message.id, message.state as State);
            });
            const hostGuard = (): void => {
                guard();
                assert(
                    managed.child.exitCode === null && managed.child.signalCode === null,
                    `VOD ${role} process exited`,
                );
            };
            await waitUntil(async () => ready !== undefined, 60_000, `${role} ready`, hostGuard);
            assert(ready);
            return {
                managed,
                port,
                ready,
                session: async (sessionId) => {
                    hostGuard();
                    managed.child.send({ operation: 'session', sessionId });
                    await waitUntil(
                        async () => sessionSet === sessionId,
                        6000,
                        `${role} started session id`,
                        hostGuard,
                    );
                },
                snapshot: async () => {
                    hostGuard();
                    const requestId = randomUUID();
                    managed.child.send({ operation: 'snapshot', id: requestId });
                    await waitUntil(
                        async () => snapshots.has(requestId),
                        6000,
                        `${role} real SQL/process snapshot`,
                        hostGuard,
                    );
                    const state = snapshots.get(requestId)!;
                    snapshots.delete(requestId);
                    return state;
                },
            };
        }
        const owner = await startHost('owner');
        const receiver = await startHost('receiver');
        assert.notEqual(owner.ready.state.pid, receiver.ready.state.pid);
        assert.notEqual(owner.ready.state.pod, receiver.ready.state.pod);
        const credentials = owner.ready;
        async function request(
            host: Host,
            route: string,
            token: string | undefined,
            expected: number,
            method = 'GET',
            body?: object,
        ): Promise<Response> {
            guard();
            const response = await fetch(`http://127.0.0.1:${host.port}${route}`, {
                method,
                headers: {
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                    ...(body ? { 'content-type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(10_000),
            }).catch((error: unknown) => {
                throw new Error(
                    `${phase} ${method} ${route.split('?')[0]} transport failed: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                );
            });
            assert.equal(
                response.status,
                expected,
                `${phase} ${method} ${route.split('?')[0]} response mismatch`,
            );
            if (expected >= 400) await response.arrayBuffer();
            return response;
        }
        // The real unified start: playback decision on the linked file, server-chosen
        // session id and a session-bound media grant.
        const startBody = (deviceId: string): object => ({
            mediaId,
            deviceId,
            clientInfo: { client: 'Native VOD continuity' },
            capabilities: {
                containers: ['mp4'],
                videoCodecs: ['h264'],
                audioCodecs: ['aac'],
                subtitleFormats: [],
                hdr: [],
            },
            requestedMethod: 'remux',
        });
        const started = (await (
            await request(
                receiver,
                '/api/v1/play-sessions',
                credentials.ownerToken,
                201,
                'POST',
                startBody(`vod-${id}`),
            )
        ).json()) as Started;
        assert.equal(started.mediaId, mediaId);
        assert.equal(started.kind, 'video');
        assert.equal(started.delivery.kind, 'hls');
        assert.equal(started.delivery.playMethod, 'remux');
        assert.equal(started.delivery.fileId, credentials.fileId);
        assert.equal(started.grant.param, 'grant');
        const sessionId = started.playbackSessionId;
        const deliveryUrl = new URL(started.delivery.url, `http://127.0.0.1:${owner.port}`);
        assert.equal(deliveryUrl.searchParams.get('grant'), started.grant.token);
        assert.equal(deliveryUrl.searchParams.get('PlaySessionId'), sessionId);
        // The foreign user's own valid start grant is bound to the foreign session.
        const foreign = (await (
            await request(
                receiver,
                '/api/v1/play-sessions',
                credentials.foreignToken,
                201,
                'POST',
                startBody(`vod-${id}-foreign`),
            )
        ).json()) as Started;
        assert.notEqual(foreign.playbackSessionId, sessionId);
        await owner.session(sessionId);
        await receiver.session(sessionId);
        await request(receiver, '/api/v1/auth/logout', credentials.revokedToken, 204, 'POST');
        owner.managed.child.send({ operation: 'encode' });
        let initial: State | undefined;
        await waitUntil(
            async () => {
                initial = await owner.snapshot();
                return (
                    initial.local?.status === 'ready' &&
                    initial.local.segmentsReady >= 300 &&
                    initial.row?.status === 'ready'
                );
            },
            60_000,
            'real VOD remux completed through production service',
            guard,
        );
        assert(initial?.row && initial.local);
        assert.deepEqual(initial.timeouts, { progress: 30, inactivity: 60, clientGone: 120 });
        // The first HTTP heartbeat must advance the observed real encode-time
        // lease too; zero would accept that old row before its async write lands.
        leaseTime = Date.parse(initial.row.last_progress_at);
        const jobId = initial.row.job_id;
        const ownerPod = initial.row.pod_name;
        assert.equal(ownerPod, owner.ready.state.pod);
        const mediaBase = `/api/v1/playback/${mediaId}/hls/`;
        // Media authenticates only with the start's grant (no bearer); the grant
        // and PlaySessionId come from the start's delivery URL.
        const suffix = deliveryUrl.search;
        const withQuery = (params: Record<string, string>): string => {
            const query = new URLSearchParams(deliveryUrl.search);
            for (const [key, value] of Object.entries(params)) query.set(key, value);
            return `?${query.toString()}`;
        };
        // Hand-rolled so `grant` is the only credential removed.
        const anonymousQuery = new URLSearchParams(deliveryUrl.search);
        anonymousQuery.delete('grant');
        const tampered =
            started.grant.token.slice(0, -1) + (started.grant.token.endsWith('A') ? 'B' : 'A');
        // Production HLS manifest chooses segment names; no fixture media reader.
        const playlist = await (
            await request(owner, mediaBase + 'index.m3u8' + suffix, undefined, 200)
        ).text();
        const segments = playlist
            .split('\n')
            .filter((line) => line.trim() && !line.startsWith('#'))
            .map((line) => new URL(line, `http://127.0.0.1:${owner.port}${mediaBase}`));
        assert(segments.length >= 300, 'Production VOD playlist lacks the complete segment grid');
        for (const url of segments)
            assert.equal(
                url.origin,
                `http://127.0.0.1:${owner.port}`,
                'Media URL escaped owned HTTP host',
            );
        const initializationUri = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
        assert(initializationUri, 'Production fMP4 VOD playlist lacks its initialization segment');
        const initializationUrl = new URL(
            initializationUri,
            `http://127.0.0.1:${owner.port}${mediaBase}`,
        );
        assert.equal(initializationUrl.origin, `http://127.0.0.1:${owner.port}`);
        assert(
            segments.every((segment) => segment.pathname.endsWith('.m4s')),
            'Actual fMP4 job and advertised production segment grid must agree',
        );
        for (const url of [initializationUrl, ...segments]) {
            assert.equal(
                url.searchParams.get('grant'),
                started.grant.token,
                'Playlist media URI lacks the start grant',
            );
            assert.equal(
                url.searchParams.get('PlaySessionId'),
                sessionId,
                'Playlist media URI lacks the started session',
            );
        }
        const initializationBytes = Buffer.from(
            await (
                await request(
                    owner,
                    initializationUrl.pathname + initializationUrl.search,
                    undefined,
                    200,
                )
            ).arrayBuffer(),
        );
        assert(
            initializationBytes.length > 32 && initializationBytes.includes(Buffer.from('ftyp')),
            'Actual native HLS init is not an MP4 initialization segment',
        );
        const denialPhases = new Set<string>();
        const durablePhases = new Set<string>();
        const phaseObservations = new Map<string, number>();
        monitoring = (async () => {
            while (!stopMonitor) {
                guard();
                const thisPhase = phase;
                const body: PlaybackReport = {
                    status: pause ? 'PAUSED' : 'ACTIVE',
                    positionMs,
                    eventSeq: ++eventSeq,
                    sessionElapsedMs: elapsedMs,
                };
                const ack = (await (
                    await request(
                        receiver,
                        `/api/v1/play-sessions/${sessionId}`,
                        credentials.ownerToken,
                        200,
                        'PUT',
                        body,
                    )
                ).json()) as {
                    action?: string;
                    resumeAnchorAt?: string | null;
                    progressSaved?: boolean;
                };
                assert(!ack.action, 'Native progress returned kill/superseded');
                let state: State | undefined;
                await waitUntil(
                    async () => {
                        state = await receiver.snapshot();
                        // recordProgressHeartbeat persists asynchronously. A
                        // segment request from the preceding iteration can
                        // also advance the lease, so “newer than last time”
                        // does not prove THIS authorized heartbeat landed.
                        // Wait for its server-clock timestamp before taking
                        // the baseline used by the denial guards below.
                        return (
                            !!state.row &&
                            !!state.session &&
                            Number(state.session.last_event_seq) === eventSeq &&
                            Date.parse(state.row.last_progress_at) > leaseTime &&
                            Date.parse(state.row.last_progress_at) >=
                                Date.parse(state.session.last_heartbeat_at)
                        );
                    },
                    5000,
                    'real cross-pod lease update',
                    guard,
                );
                assert(state?.row && state.session);
                assert.equal(
                    state.local,
                    null,
                    'Heartbeat receiver unexpectedly owns a local encoder',
                );
                assert.equal(state.row.job_id, jobId);
                assert.equal(state.row.pod_name, ownerPod);
                assert.equal(state.session.id, sessionId);
                assert.equal(state.session.media_id, mediaId);
                assert.equal(state.session.surface, 'native_app');
                assert.equal(Number(state.session.position_ms), positionMs);
                assert.equal(Number(state.session.last_event_seq), eventSeq);
                assert.equal(state.session.status, body.status);
                assert(Date.now() - Date.parse(state.session.last_heartbeat_at) < 10_000);
                if (ack.progressSaved) {
                    durablePhases.add(thisPhase);
                    assert.equal(Number(state.durable?.event_seq), eventSeq);
                    assert.equal(Number(state.durable?.position_ms), positionMs);
                    // The API anchor is a server-clock freshness timestamp,
                    // distinct from the media-relative playhead asserted above.
                    assert.equal(
                        Date.parse(ack.resumeAnchorAt ?? ''),
                        Math.max(
                            Date.parse(state.session.last_heartbeat_at),
                            Date.parse(state.durable!.occurred_at),
                        ),
                        'Heartbeat resume anchor must match actual live/durable freshness',
                    );
                }
                leaseTime = Date.parse(state.row.last_progress_at);
                const ownerState = await owner.snapshot();
                assert.equal(
                    ownerState.local?.id,
                    jobId,
                    'Media owner reaped/replaced VOD despite real cross-pod heartbeat',
                );
                assert.equal(ownerState.pid, owner.ready.state.pid);
                assert.equal(ownerState.row?.pod_name, ownerPod);
                if (
                    ['before', 'absent', 'after'].includes(thisPhase) &&
                    !denialPhases.has(thisPhase)
                ) {
                    const deniedBody = { ...body, eventSeq: eventSeq + 100_000 };
                    await request(
                        receiver,
                        `/api/v1/play-sessions/${sessionId}`,
                        undefined,
                        401,
                        'PUT',
                        deniedBody,
                    );
                    await request(
                        receiver,
                        `/api/v1/play-sessions/${sessionId}`,
                        credentials.foreignToken,
                        404, // Valid foreign credentials must not reveal another user's session.
                        'PUT',
                        deniedBody,
                    );
                    await request(
                        receiver,
                        `/api/v1/play-sessions/${sessionId}`,
                        credentials.revokedToken,
                        401,
                        'PUT',
                        deniedBody,
                    );
                    const denied = await receiver.snapshot();
                    assert.equal(
                        denied.row?.last_progress_at,
                        state.row.last_progress_at,
                        'Denied progress renewed transcode lease',
                    );
                    assert.equal(
                        denied.session?.last_event_seq,
                        state.session.last_event_seq,
                        'Denied progress changed session',
                    );
                    await request(
                        owner,
                        `${mediaBase}index.m3u8?${anonymousQuery.toString()}`,
                        undefined,
                        401,
                    );
                    // Another session's grant on this media: 403 forbidden (reason wrong_scope).
                    await request(
                        owner,
                        mediaBase + 'index.m3u8' + withQuery({ grant: foreign.grant.token }),
                        undefined,
                        403,
                    );
                    await request(
                        owner,
                        mediaBase + 'index.m3u8' + withQuery({ grant: tampered }),
                        undefined,
                        401,
                    );
                    denialPhases.add(thisPhase);
                }
                if (!pause) {
                    const segment = segments[nextSegment++];
                    assert(segment, 'Fixture exhausted bounded VOD segment grid');
                    const bytes = Buffer.from(
                        await (
                            await request(owner, segment.pathname + segment.search, undefined, 200)
                        ).arrayBuffer(),
                    );
                    assert(bytes.length > 188);
                    const decodeFile = path.join(directory, 'decode.mp4');
                    // fMP4 media fragments depend on their advertised init. Both
                    // were fetched through the actual authenticated native route.
                    await writeFile(decodeFile, Buffer.concat([initializationBytes, bytes]));
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
                            decodeFile,
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
                    const tb = /^#tb 0: (\d+)\/(\d+)$/m.exec(decoded.stdout);
                    assert(tb, 'Actual VOD decoder emitted no timebase');
                    const pts = decoded.stdout
                        .split('\n')
                        .filter((line) => /^0,/.test(line))
                        .map(
                            (line) => (Number(line.split(',')[2]) * Number(tb[1])) / Number(tb[2]),
                        );
                    assert(
                        pts.length > 0 && pts.every(Number.isFinite),
                        'Actual VOD decoder produced no frames',
                    );
                    for (let i = 1; i < pts.length; i++)
                        assert(pts[i] > pts[i - 1], 'Decoded VOD frame timestamps reversed');
                    assert(
                        pts[0] > lastPts,
                        'Decoded VOD media repeated or reversed across worker lifecycle',
                    );
                    lastPts = pts.at(-1)!;
                    artifact.frames[thisPhase] = (artifact.frames[thisPhase] ?? 0) + pts.length;
                    artifact.decodedSegments++;
                    positionMs += 2000;
                    elapsedMs += 2000;
                }
                assert(artifact.observations.length < 250, 'Unbounded VOD evidence');
                artifact.observations.push({
                    phase: thisPhase,
                    at: Date.now(),
                    paused: pause,
                    lease: state.row,
                    session: state.session,
                    durable: state.durable,
                    ownerLocal: ownerState.local,
                    lastDecodedPts: Number.isFinite(lastPts) ? lastPts : null,
                    ack,
                });
                phaseObservations.set(thisPhase, (phaseObservations.get(thisPhase) ?? 0) + 1);
                await delay(2000);
            }
        })().catch((error: unknown) => {
            monitorError = error;
        });
        const worker = (boot: number): Promise<{ managed: ManagedChild; port: number }> =>
            startSdkWorker({
                boot,
                id: `vod-${id}`,
                directory,
                environment,
                sql,
                guard,
                taskIds,
                register: (managed) => children.push({ managed, fixture: false }),
            });
        const original = await worker(1);
        await waitUntil(
            async () => (artifact.frames.before ?? 0) > 0,
            15_000,
            'baseline native progress and decoded VOD',
            guard,
        );
        phase = 'draining';
        original.managed.child.kill('SIGTERM');
        await awaitExit(original.managed, 30_000, guard);
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
        const absentAt = Date.now();
        phase = 'absent';
        await waitUntil(
            async () => (artifact.frames.absent ?? 0) > 0,
            15_000,
            'decoded VOD with worker absent',
            guard,
        );
        pause = true;
        await waitUntil(
            async () =>
                artifact.observations.some((entry) => 'paused' in entry && entry.paused === true),
            10_000,
            'paused HTTP heartbeat with media requests stopped',
            guard,
        );
        const pauseAt = Date.now();
        const pausedState = await receiver.snapshot();
        // Outlive schema-valid progress/inactivity thresholds plus TWO normal
        // 30-second owner sweeps. No segment/manifest requests in this interval.
        await waitUntil(
            async () => Date.now() - pauseAt >= 95_000,
            100_000,
            'cross-pod-only paused VOD lease over normal reaper sweeps',
            guard,
        );
        const kept = await receiver.snapshot();
        assert.equal(
            kept.row?.last_accessed_at,
            pausedState.row?.last_accessed_at,
            'Pause was kept alive by hidden segment traffic',
        );
        assert(
            Date.parse(kept.row!.last_progress_at) > Date.parse(pausedState.row!.last_progress_at),
            'Actual paused HTTP progress did not renew lease',
        );
        artifact.pauseMs = Date.now() - pauseAt;
        pause = false;
        await waitUntil(
            async () => Date.now() - absentAt >= 130_000,
            140_000,
            'worker absence beyond schema-valid client-gone timeout',
            guard,
        );
        artifact.absenceMs = Date.now() - absentAt;
        assert.equal((await groupMembers(original.managed.child.pid!)).length, 0);
        assert((artifact.frames.absent ?? 0) > 0);
        phase = 'restarting';
        const replacement = await worker(2);
        assert.notEqual(replacement.managed.child.pid, original.managed.child.pid);
        phase = 'after';
        await waitUntil(
            async () =>
                (artifact.frames.after ?? 0) > 0 && (phaseObservations.get('after') ?? 0) > 0,
            15_000,
            'decoded native VOD/progress after actual worker restart',
            guard,
        );
        stopMonitor = true;
        await monitoring;
        guard();
        assert.deepEqual([...denialPhases].sort(), ['absent', 'after', 'before']);
        assert.deepEqual(
            [...durablePhases]
                .filter((item) => ['before', 'absent', 'after'].includes(item))
                .sort(),
            ['absent', 'after', 'before'],
        );
        // Negative control: when ALL client traffic ends, the same production
        // owner reaper must retire the completed job; never write old timestamps.
        phase = 'client-gone';
        const silentAt = Date.now();
        await waitUntil(
            async () => (await owner.snapshot()).local === null,
            100_000,
            'normal owner reaper after client lease genuinely expires',
            guard,
        );
        const retired = await owner.snapshot();
        assert.equal(retired.pid, owner.ready.state.pid);
        assert.equal(retired.row?.job_id, jobId);
        assert.equal(retired.row?.pod_name, ownerPod);
        assert.equal(
            retired.row?.status,
            'stopped',
            'Real reaper did not retire persisted VOD job',
        );
        artifact.negativeControlMs = Date.now() - silentAt;
        assert(
            artifact.negativeControlMs >= 45_000,
            'Job disappeared before real inactivity window',
        );
        await request(
            receiver,
            `/api/v1/play-sessions/${sessionId}`,
            credentials.ownerToken,
            204,
            'PUT',
            {
                status: 'COMPLETED',
                endReason: 'user',
                positionMs,
                eventSeq: ++eventSeq,
                sessionElapsedMs: elapsedMs,
            },
        );
        const terminal = await receiver.snapshot();
        assert.equal(terminal.session?.status, 'COMPLETED');
        artifact.observations.push({ phase: 'completed', terminal });
        artifact.status = 'passed';
    } catch (error) {
        primaryFailure = error;
        artifact.failure = error instanceof Error ? error.message : 'VOD qualification failed';
        for (const { managed } of children)
            console.error(`VOD diagnostic ${managed.label}: ${managed.logs()}`);
    } finally {
        stopMonitor = true;
        await monitoring;
        const errors = cleanupErrors;
        for (const { managed, fixture } of [...children].reverse()) {
            try {
                await cleanupChild(managed, fixture);
            } catch (error) {
                errors.push(
                    error instanceof Error ? error.message : 'Owned VOD process cleanup failed',
                );
            }
        }
        try {
            const connection = getQueueConnectionOptions();
            assert(connection);
            const expected = new URL(taskCacheUrl);
            assert(
                connection.db === Number(expected.pathname.slice(1)) &&
                    connection.host === expected.hostname &&
                    connection.port === Number(expected.port || '6379'),
                'Queue cleanup must use exact isolated endpoint',
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
                await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
            }
            await settleSdkWorkerHistory(sql, id);
        } catch (error) {
            errors.push(
                error instanceof Error ? error.message : 'Owned VOD task state cleanup failed',
            );
        }
        try {
            await sql.end({ timeout: 5 });
        } catch {
            errors.push('VOD SQL cleanup failed');
        }
        await rm(directory, { recursive: true, force: true });
        await rm(bundleDirectory, { recursive: true, force: true });
        if (errors.length) {
            artifact.status = 'failed';
            artifact.cleanupErrors = errors;
        }
        await mkdir('build/native-validation', { recursive: true });
        await writeFile(
            'build/native-validation/vod-worker-continuity.json',
            JSON.stringify(artifact, null, 2) + '\n',
        );
    }
    if (cleanupErrors.length) {
        throw new AggregateError(
            [
                ...(primaryFailure === undefined ? [] : [primaryFailure]),
                ...cleanupErrors.map((message) => new Error(message)),
            ],
            artifact.failure
                ? `VOD qualification failed: ${artifact.failure}; owned cleanup also failed`
                : 'VOD qualification cleanup failed',
        );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
}, 550_000);
