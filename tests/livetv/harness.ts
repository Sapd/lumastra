// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { baseURL, identityHeaders, stateFile } from './env';
import type { Identity } from './env';
import {
    PlaybackSessionStartResponseSchema,
    type PlaybackSessionStartResponse,
} from '../../src/lib/schemas/livetv-playback-sessions';

export interface Station {
    id: string;
    feedId: string;
    name: string;
    sourceId?: string;
}
export interface Feed {
    id: string;
    name: string;
    qualityTier?: string;
    isDefault: boolean;
}
export type Session = PlaybackSessionStartResponse;

export interface SourceReady {
    baseUrl: string;
    m3uUrl: string;
    xmltvUrl: string;
}
export interface FixtureState {
    provider: SourceReady;
    sourceId: string;
    stations: Station[];
}
export interface ProviderStatus {
    connections: number;
    maxConnections: number;
    active: { id: string }[];
    events: { sequence: number; event: string; id: string }[];
}
export const api = '/api/v1/livetv';
const runFile = promisify(execFile);
const sessions = new WeakMap<APIRequestContext, Set<Session>>();

export function fixtureState(): FixtureState {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as FixtureState;
}

export async function expectStatus(response: APIResponse, status: number): Promise<void> {
    expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status);
}

export async function json<T>(response: APIResponse, status = 200): Promise<T> {
    await expectStatus(response, status);
    return (await response.json()) as T;
}

export async function providerStatus(): Promise<ProviderStatus> {
    const response = await fetch(`${fixtureState().provider.baseUrl}/__status`, {
        signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ProviderStatus;
}

export async function waitForSlots(count: number, timeout = 25_000): Promise<void> {
    await expect
        .poll(async (): Promise<number> => (await providerStatus()).connections, {
            timeout,
            intervals: [250, 500, 1000],
            message: `provider should hold ${count} connections`,
        })
        .toBe(count);
}

export interface Actor {
    request: APIRequestContext;
    close: () => Promise<void>;
}

// Every test gets a new PAT: viewer keys include its fingerprint. This avoids
// inheriting the previous test's 120-second eviction guard, without clearing Valkey.
export async function createActor(identity: Identity): Promise<Actor> {
    const browserAuth = await request.newContext({
        baseURL,
        extraHTTPHeaders: identityHeaders(identity),
    });
    const minted = await json<{ id: number; token: string }>(
        await browserAuth.post('/api/me/pats', {
            data: {
                name: `livetv-e2e-${Date.now()}`,
                scopes: identity === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
            },
        }),
        201,
    );
    const bearer = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Authorization: `Bearer ${minted.token}`, Origin: baseURL },
        timeout: 60_000,
    });
    sessions.set(bearer, new Set<Session>());
    return {
        request: bearer,
        close: async (): Promise<void> => {
            try {
                for (const session of sessions.get(bearer) ?? []) await leave(bearer, session);
            } finally {
                try {
                    await expectStatus(await browserAuth.delete(`/api/me/pats/${minted.id}`), 204);
                } finally {
                    await bearer.dispose();
                    await browserAuth.dispose();
                }
            }
        },
    };
}

export async function start(
    client: APIRequestContext,
    station: Station,
    options: { feedId?: string; purpose?: 'preview' } = {},
): Promise<Session> {
    const session = PlaybackSessionStartResponseSchema.parse(
        await json<unknown>(
            await client.post(`${api}/playback-sessions`, {
                data: { stationId: station.id, quality: 'original', ...options },
            }),
            201,
        ),
    );
    sessions.get(client)?.add(session);
    return session;
}

export async function leave(client: APIRequestContext, session: Session): Promise<void> {
    await expectStatus(
        await client.delete(`${api}/playback-sessions/${session.playbackSessionId}`),
        204,
    );
    sessions.get(client)?.delete(session);
}

export async function keepalive(client: APIRequestContext, session: Session): Promise<APIResponse> {
    return client.post(session.reporting.href);
}

export async function state(
    client: APIRequestContext,
    session: Session,
): Promise<{ state: string; endReason?: string }> {
    return json(await client.get(`${api}/playback-sessions/${session.playbackSessionId}`));
}

function appStreamUrl(href: string, parent = baseURL): string {
    const url = new URL(href, parent);
    expect(url.origin, 'stream traffic must traverse the app').toBe(baseURL);
    expect(url.pathname).toMatch(/^\/api\/v1\/livetv\/channels\//);
    return url.href;
}

export interface MediaSample {
    playlistUrl: string;
    segmentUrls: string[];
    bytes: Buffer;
}

// Follow the real returned master, not a guessed proxy URL. Poll until two
// segments exist; support both MPEG-TS and EXT-X-MAP/fMP4 outputs.
export async function sample(client: APIRequestContext, streamUrl: string): Promise<MediaSample> {
    let result: MediaSample | undefined;
    await expect
        .poll(
            async (): Promise<boolean> => {
                let url = appStreamUrl(streamUrl);
                for (let depth = 0; depth < 4; depth++) {
                    const response = await client.get(url);
                    if (response.status() === 503 || response.status() === 404) return false;
                    await expectStatus(response, 200);
                    const body = await response.text();
                    expect(body).toContain('#EXTM3U');
                    const entries = body
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter((line) => line && !line.startsWith('#'));
                    if (body.includes('#EXT-X-STREAM-INF:')) {
                        expect(entries.length).toBeGreaterThan(0);
                        url = appStreamUrl(entries[0], url);
                        continue;
                    }
                    if (entries.length < 2) return false;
                    const segmentUrls = entries.slice(-2).map((entry) => appStreamUrl(entry, url));
                    const chunks: Buffer[] = [];
                    const init = /#EXT-X-MAP:.*URI="([^"]+)"/.exec(body)?.[1];
                    if (init) {
                        const initResponse = await client.get(appStreamUrl(init, url));
                        await expectStatus(initResponse, 200);
                        chunks.push(await initResponse.body());
                    }
                    for (const segment of segmentUrls) {
                        const media = await client.get(segment);
                        await expectStatus(media, 200);
                        const bytes = await media.body();
                        expect(bytes.length).toBeGreaterThan(1024);
                        chunks.push(bytes);
                    }
                    result = { playlistUrl: url, segmentUrls, bytes: Buffer.concat(chunks) };
                    return true;
                }
                throw new Error('HLS nesting exceeds four playlists');
            },
            {
                timeout: 45_000,
                intervals: [500, 1000],
                message: 'two real HLS segments through the app',
            },
        )
        .toBe(true);
    if (!result) throw new Error('No HLS sample');
    return result;
}

export async function decode(media: MediaSample): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'livetv-decode-'));
    try {
        const file = join(dir, 'sample.bin');
        await writeFile(file, media.bytes);
        const probe = await runFile(
            process.env.FFPROBE_PATH || 'ffprobe',
            [
                '-v',
                'error',
                '-count_frames',
                '-show_entries',
                'stream=codec_type,nb_read_frames',
                '-of',
                'json',
                file,
            ],
            { timeout: 15_000 },
        );
        const streams = (
            JSON.parse(probe.stdout) as {
                streams: { codec_type: string; nb_read_frames?: string }[];
            }
        ).streams;
        for (const kind of ['video', 'audio']) {
            expect(
                streams.some(
                    (stream) => stream.codec_type === kind && Number(stream.nb_read_frames) > 0,
                ),
                `decoded ${kind} frames`,
            ).toBe(true);
        }
        await runFile(
            process.env.FFMPEG_PATH || 'ffmpeg',
            ['-v', 'error', '-xerror', '-i', file, '-t', '1', '-f', 'null', '-'],
            { timeout: 15_000 },
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export type SourceMode = 'ok' | 'stall' | 'end' | `status:${number}`;

// Switch one provider feed (or '*' for all) into a failure mode; see scripts/livetv-testsource/README.md.
export async function control(body: {
    feed?: string;
    mode: SourceMode;
    body?: string;
    maxConnections?: number;
}): Promise<void> {
    const response = await fetch(`${fixtureState().provider.baseUrl}/__control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
    });
    expect(response.status, `POST /__control ${JSON.stringify(body)}`).toBe(200);
    await response.body?.cancel();
}

export interface FeedTried {
    feedId: string;
    feedName?: string;
    reason: string;
    upstreamStatus?: number;
}
export interface FailureProblem {
    code: string;
    /** Seconds; also the Retry-After header. */
    retryAfter?: number;
    reason?: string;
    failure?: { retryable: boolean; feedsTried?: FeedTried[] };
}

// POST a playback session expecting a typed failure; returns status, parsed body and raw text.
export async function startFailing(
    client: APIRequestContext,
    station: Station,
    options: { feedId?: string } = {},
): Promise<{ status: number; body: FailureProblem; text: string }> {
    const response = await client.post(`${api}/playback-sessions`, {
        data: { stationId: station.id, quality: 'original', ...options },
    });
    const text = await response.text();
    expect(response.status(), `expected a failure, got: ${text}`).toBeGreaterThanOrEqual(400);
    return { status: response.status(), body: JSON.parse(text) as FailureProblem, text };
}

// Feed IDs (not station IDs) of a station, in the order the API lists them.
export async function feedIds(client: APIRequestContext, station: Station): Promise<string[]> {
    const { feeds } = await json<{ feeds: Feed[] }>(
        await client.get(`${api}/stations/${station.id}/feeds`),
    );
    return feeds.map((feed) => feed.id);
}
