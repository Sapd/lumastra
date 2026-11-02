// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { BINARY } from './evaluator.js';

type Reply = {
    status: number;
    contentType: string | null;
    cacheControl: string | null;
    body: unknown;
    elapsedMs: number;
};
interface Recorded {
    fixture: Record<string, unknown>;
    env: Record<string, string | undefined>;
    path: string;
    method: string;
    body: unknown;
    headers: unknown;
    expected: Reply;
}
const key = ({ expected: _expected, ...request }: Recorded): string => JSON.stringify(request);
const records = readFileSync(new URL('./fixtures/http.jsonl', import.meta.url), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Recorded);
const replies = new Map(records.map((record) => [key(record), record.expected]));
async function pair(
    fixture: Record<string, unknown> = {},
    env: Record<string, string | undefined> = {
        NODE_ENV: 'production',
        STREAM_PROXY_SECRET: 'contract-secret',
    },
) {
    const directory = await mkdtemp(join(tmpdir(), 'native-proxy-http-'));
    const fixturePath = join(directory, 'fixture.json');
    await writeFile(
        fixturePath,
        JSON.stringify({
            replies: {
                join: { status: 200, body: { success: true } },
                leave: { status: 200, body: { success: true } },
                heartbeat: { status: 200, body: { success: true } },
                kill: { status: 200, body: { success: true, viewersRemoved: 0 } },
            },
            ...fixture,
        }),
    );
    const child = spawn(BINARY, ['--contract-server', fixturePath], {
        env: { ...process.env, ...env, STREAM_PROXY_SECRET: env.STREAM_PROXY_SECRET ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    let stdout = '';
    const nativePort = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`native HTTP startup timed out: ${stderr}`)),
            5000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.includes('\n')) {
                clearTimeout(timer);
                resolve((JSON.parse(stdout.split('\n')[0]) as { port: number }).port);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`native HTTP exited ${code}: ${stderr}`));
        });
    });
    return {
        nativeUrl: `http://127.0.0.1:${nativePort}`,
        waitEvents: () =>
            stdout
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as { event?: string; active?: number }),
        async compare(path: string, init: RequestInit = {}) {
            const started = Date.now();
            const response = await fetch(`http://127.0.0.1:${nativePort}${path}`, init);
            const bytes = Buffer.from(await response.arrayBuffer());
            expect(Number(response.headers.get('content-length'))).toBe(bytes.length);
            const body: unknown =
                response.headers.get('content-type') === 'application/json'
                    ? JSON.parse(bytes.toString())
                    : bytes.toString('base64');
            if (path === '/status') (body as Record<string, unknown>).uptime = 0;
            const actual = {
                status: response.status,
                contentType: response.headers.get('content-type'),
                cacheControl: response.headers.get('cache-control'),
                body,
                elapsedMs: 0,
            };
            const expected = replies.get(
                key({
                    fixture,
                    env,
                    path,
                    method: init.method ?? 'GET',
                    body: init.body ?? null,
                    headers: init.headers ?? {},
                    expected: actual,
                }),
            );
            expect(expected, `Recorded baseline for ${init.method ?? 'GET'} ${path}`).toBeDefined();
            expect(actual).toEqual(expected);
            return { ...actual, elapsedMs: Date.now() - started };
        },
        async close() {
            child.kill('SIGINT');
            await Promise.race([
                once(child, 'exit'),
                new Promise<void>((resolve) =>
                    setTimeout(() => {
                        child.kill('SIGKILL');
                        resolve();
                    }, 1000),
                ),
            ]);
            await rm(directory, { recursive: true, force: true });
        },
    };
}
const auth = { 'x-proxy-secret': 'contract-secret' };
const valid = {
    viewerId: 'viewer',
    streamUrls: ['https://provider.invalid/live'],
    sourceId: 'source',
    maxStreams: 1,
    channelName: 'Channel',
};

describe('actual loopback HTTP boundary, using fixture managers only', () => {
    test('authentication, unauthenticated health and shutdown precedence match', async () => {
        for (const env of [
            { NODE_ENV: 'production', STREAM_PROXY_SECRET: 'contract-secret' },
            { NODE_ENV: 'production', STREAM_PROXY_SECRET: 'café' },
            { NODE_ENV: 'production' },
            { NODE_ENV: 'development' },
        ]) {
            const servers = await pair({}, env);
            const credentials = { 'x-proxy-secret': env.STREAM_PROXY_SECRET ?? 'contract-secret' };
            try {
                await servers.compare('/status');
                await servers.compare('/status', { headers: credentials });
                await servers.compare('/unknown');
                await servers.compare('/unknown', { headers: credentials });
            } finally {
                await servers.close();
            }
        }
        const servers = await pair({ shuttingDown: true });
        try {
            await servers.compare('/status');
            await servers.compare('/unknown');
            await servers.compare('/streams/bad%20id/join', {
                method: 'POST',
                headers: auth,
                body: '{}',
            });
        } finally {
            await servers.close();
        }
    });
    test('malformed route and container validation match before manager dispatch', async () => {
        const servers = await pair();
        try {
            for (const path of [
                '/streams/bad%20id/playlist.m3u8',
                '/streams/a/segment-no.ts',
                '/streams/a/segment--1.m4s',
                '/streams/a/r//playlist.m3u8',
                '/streams/a/r/bad%20id/playlist.m3u8',
                '/streams/a/r/rung/init.mp4',
                '/streams/a/r/rung/playlist.m3u8',
                '/streams/a/v/fmp4/segment-1.ts',
                '/streams/a/v/h264/init.mp4',
                '/streams/a/v/h264/segment-1.m4s',
                '/streams/a/v/fmp4/init-4.mp4',
                '/streams/a/a/invalid',
                '/streams/a/a/master.m3u8',
                '/unknown',
            ])
                await servers.compare(path, { headers: auth });
            await servers.compare('/streams/a/leave?viewerId=&viewerId=viewer', {
                method: 'DELETE',
                headers: auth,
            });
            await servers.compare('/streams/a/heartbeat', { method: 'POST', headers: auth });
        } finally {
            await servers.close();
        }
    });
    test('JSON body bounds and ordered join validation match across real transport', async () => {
        const servers = await pair();
        const cap = {
            rung: { id: '720p', height: 720, maxBitrate: 2_000_000, codec: 'h264' },
            requestedMaxBitrate: 3_000_000,
            belowLadder: false,
            pinned: false,
            fallback: 'refuse',
        };
        try {
            for (const body of [
                null,
                [],
                {},
                { viewerId: 1 },
                { viewerId: 'v' },
                { ...valid, allowPrivateUrls: 'true' },
                { ...valid, sourceId: '' },
                { ...valid, maxStreams: 0 },
                { ...valid, channelName: '' },
                { ...valid, cap: [] },
                { ...valid, cap: { ...cap, rung: { ...cap.rung, id: '../' } } },
                { ...valid, cap: { ...cap, rung: { ...cap.rung, height: 720.5 } } },
                { ...valid, adaptive: { rungs: [cap.rung] } },
                { ...valid, client: { hevc: 'maybe' } },
                { ...valid, awaitReadyMs: '5000' },
                { ...valid, awaitReadyMs: null },
                { ...valid, feedIds: 'feed' },
                { ...valid, feedIds: ['feed', 7] },
                { ...valid, awaitReadyMs: 'soon', client: { hevc: 'maybe' } },
                { ...valid, awaitReadyMs: 8000.5, feedIds: ['feed-a'] },
                valid,
                { ...valid, cap },
                {
                    ...valid,
                    adaptive: {
                        rungs: [cap.rung, { ...cap.rung, id: 'low' }],
                        includeOriginal: false,
                        fallback: 'source',
                    },
                },
            ])
                await servers.compare('/streams/a/join', {
                    method: 'POST',
                    headers: { ...auth, 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                });
            await servers.compare('/streams/a/join', {
                method: 'POST',
                headers: { ...auth, 'content-type': 'text/plain' },
                body: '{}',
            });
            await servers.compare('/streams/a/join', {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: '{',
            });
            await servers.compare('/streams/a/join', {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: ' '.repeat(64 * 1024 + 1),
            });
        } finally {
            await servers.close();
        }
    });
    test('ready media playlists, binary segments, init generations and cache headers match', async () => {
        const entry = { index: 8, duration: 3.25, data: [0, 1, 2, 255] };
        const init = { 'init.mp4': [3, 4, 5], 'init-8.mp4': [6, 7, 8] };
        const original = {
            segments: [entry],
            init,
            options: { discontinuityAnchors: [8], agedOutDiscontinuities: 2 },
        };
        const fmp4 = {
            segments: [entry],
            init,
            options: { fmp4: true, initUris: [{ fromIndex: 8, uri: 'init-8.mp4' }] },
        };
        const media = {
            ingest: { channel: original },
            egress: {
                'channel::720p': { segments: [entry] },
                'channel::v-fmp4': fmp4,
                'channel::v-h264': { segments: [entry] },
            },
            adaptive: { 'channel::low': { segments: [entry] }, 'channel::original': original },
            variants: {
                channel: {
                    rungs: [
                        { id: 'low', height: 360, maxBitrate: 800000 },
                        { id: 'high', height: 1080, maxBitrate: 8000000 },
                    ],
                    includesOriginal: true,
                },
            },
            probes: {
                channel: {
                    success: true,
                    video: {
                        codec: 'hevc',
                        width: 3840,
                        height: 2160,
                        profile: 'Main 10',
                        level: 153,
                        colorTransfer: 'arib-std-b67',
                    },
                    audio: { codec: 'aac' },
                },
            },
            observed: { channel: 2345678.6 },
        };
        const servers = await pair({ media, egressEnabled: true, adaptiveEnabled: true });
        try {
            for (const path of [
                '/streams/channel/master.m3u8',
                '/streams/channel/playlist.m3u8',
                '/streams/channel/segment-8.ts',
                '/streams/channel/segment-9.ts',
                '/streams/channel/init.mp4',
                '/streams/channel/r/720p/playlist.m3u8',
                '/streams/channel/r/720p/segment-8.ts',
                '/streams/channel/v/fmp4/master.m3u8',
                '/streams/channel/v/fmp4/playlist.m3u8',
                '/streams/channel/v/fmp4/init-8.mp4',
                '/streams/channel/v/fmp4/init-9.mp4',
                '/streams/channel/v/fmp4/segment-8.m4s',
                '/streams/channel/v/h264/master.m3u8',
                '/streams/channel/v/h264/playlist.m3u8',
                '/streams/channel/v/h264/segment-8.ts',
                '/streams/channel/a/master.m3u8',
                '/streams/channel/a/low/playlist.m3u8',
                '/streams/channel/a/low/segment-8.ts',
                '/streams/channel/a/original/playlist.m3u8',
                '/streams/channel/a/low/segment-9.ts',
                '/streams/missing/master.m3u8',
                '/streams/missing/playlist.m3u8',
                '/streams/missing/segment-8.ts',
                '/streams/missing/init.mp4',
                '/streams/channel/r/missing/playlist.m3u8',
                '/streams/channel/a/missing/playlist.m3u8',
                '/streams/missing/v/fmp4/master.m3u8',
                '/streams/missing/a/master.m3u8',
            ])
                await servers.compare(path, { headers: auth });
        } finally {
            await servers.close();
        }
    });
    test('one newly ready entry answers promptly without waiting for four segments', async () => {
        const servers = await pair({
            traceWaiters: true,
            media: {
                ingest: {
                    channel: {
                        segments: [{ index: 1, duration: 3, data: [1] }],
                        playlistReadyAfterMs: 600,
                    },
                },
            },
        });
        try {
            const result = await servers.compare('/streams/channel/playlist.m3u8', {
                headers: auth,
            });
            expect(result.status).toBe(200);
            expect(result.elapsedMs).toBeLessThan(1500);
            expect(servers.waitEvents().some((e) => e.event === 'playlist_wait_start')).toBe(true);
            expect(
                servers.waitEvents().some((e) => e.event === 'playlist_wait_end' && e.active === 0),
            ).toBe(true);
        } finally {
            await servers.close();
        }
    });
    test(
        'cold empty and mid-failover playlists retain their 18 second deadline',
        { timeout: 25000 },
        async () => {
            const servers = await pair({
                media: { ingest: { empty: { segments: [] }, failover: { failingOver: true } } },
            });
            try {
                const results = await Promise.all(
                    ['empty', 'failover'].map((channel) =>
                        servers.compare(`/streams/${channel}/playlist.m3u8`, { headers: auth }),
                    ),
                );
                for (const result of results) {
                    expect(result.status).toBe(404);
                    expect(result.elapsedMs).toBeGreaterThanOrEqual(17900);
                    expect(result.elapsedMs).toBeLessThan(22000);
                }
            } finally {
                await servers.close();
            }
        },
    );
    test('aborting a pending playlist cancels its native waiter', async () => {
        const servers = await pair({
            traceWaiters: true,
            media: { ingest: { channel: { segments: [] } } },
        });
        const nativeAbort = new AbortController();
        try {
            const native = fetch(`${servers.nativeUrl}/streams/channel/playlist.m3u8`, {
                headers: auth,
                signal: nativeAbort.signal,
            }).catch((error: unknown) => error);
            await vi.waitFor(() =>
                expect(servers.waitEvents().some((e) => e.event === 'playlist_wait_start')).toBe(
                    true,
                ),
            );
            nativeAbort.abort();
            await native;
            await vi.waitFor(() =>
                expect(
                    servers
                        .waitEvents()
                        .some((e) => e.event === 'playlist_wait_end' && e.active === 0),
                ).toBe(true),
            );
        } finally {
            nativeAbort.abort();
            await servers.close();
        }
    });
    test('a failed start (502 channel_failed) and a terminal heartbeat (200 failure) pass through', async () => {
        const failed = {
            error: 'channel_failed',
            reason: 'all_feeds_failed',
            retryable: true,
            retryAfterMs: 10_000,
            feedsTried: [
                { index: 0, feedId: 'feed-a', reason: 'provider_auth_failed', upstreamStatus: 401 },
                { index: 1, reason: 'provider_unreachable' },
            ],
        };
        const servers = await pair({
            replies: {
                join: { status: 502, body: failed },
                heartbeat: {
                    status: 200,
                    body: {
                        success: false,
                        message: 'channel_failed',
                        failure: {
                            reason: failed.reason,
                            retryable: failed.retryable,
                            retryAfterMs: failed.retryAfterMs,
                            feedsTried: failed.feedsTried,
                        },
                    },
                },
            },
        });
        try {
            await servers.compare('/streams/channel/join', {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ ...valid, awaitReadyMs: 8000, feedIds: ['feed-a', 'b'] }),
            });
            await servers.compare('/streams/channel/heartbeat?viewerId=viewer', {
                method: 'POST',
                headers: auth,
            });
        } finally {
            await servers.close();
        }
    });
    test('feed ID validation and control reply delegation preserve the HTTP boundary', async () => {
        const servers = await pair();
        try {
            for (const path of [
                '/streams/channel/feed.ts',
                '/streams/channel/feed.ts?feed=short',
                '/streams/channel/feed.ts?feed=unsafe_with_underscores',
            ])
                await servers.compare(path, { headers: auth });
            await servers.compare('/streams/channel/leave?viewerId=viewer', {
                method: 'DELETE',
                headers: auth,
            });
            await servers.compare('/streams/channel/heartbeat?viewerId=viewer', {
                method: 'POST',
                headers: auth,
            });
            await servers.compare('/streams/channel/kill', { method: 'DELETE', headers: auth });
        } finally {
            await servers.close();
        }
    });
});
